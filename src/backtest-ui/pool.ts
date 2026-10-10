import { mergeBacktests, type BacktestOptions, type BacktestResult } from '../backtest/backtest';
import type { Dataset } from '../backtest/dataset';
import type { Model } from '../backtest/model';
import type { BacktestRequest } from './backtest.worker';

/**
 * Backtests in web workers: the strategies are split across up to (cores − 1) workers, each runs
 * the baseline with its share, and the shares are merged (identical to one run over all of them).
 * The page stays responsive however long it takes; a newer request supersedes an older one.
 */
let seq = 1;
let cancelLive: (() => void) | null = null;
/** kept warm between runs: no module loading, and the JIT has already seen the engine */
let idle: Worker[] = [];
const spawn = () => new Worker(new URL('./backtest.worker.ts', import.meta.url), { type: 'module' });

export class Superseded extends Error {}

type Reply = { id: number; ok: boolean; result?: BacktestResult; indices?: number[]; errors?: { index: number; message: string }[]; error?: string };

export interface PooledBacktest {
  result: BacktestResult;
  /** strategy index → why it could not run */
  errors: Map<number, string>;
}

export async function backtestInWorkers(model: Model, dataset: Dataset, specs: unknown[], opts: BacktestOptions): Promise<PooledBacktest> {
  cancelLive?.();
  const n = Math.max(1, Math.min(specs.length, (navigator.hardwareConcurrency ?? 4) - 1, 6));
  const shares = Array.from({ length: n }, (_, k) => specs.map((spec, index) => ({ index, spec })).filter((s) => s.index % n === k));
  const workers = shares.map(() => idle.pop() ?? spawn());
  let busy = true;
  let cancel!: () => void;
  const cancelled = new Promise<never>((_, reject) => (cancel = () => reject(new Superseded('a newer backtest replaced this one'))));
  cancelLive = () => {
    // a worker mid-run can't be interrupted: replace it
    if (busy) workers.forEach((w) => w.terminate());
    busy = false;
    cancel();
  };
  try {
    const replies = await Promise.race([cancelled, Promise.all(
      shares.map(
        (strategies, k) =>
          new Promise<Reply>((resolve, reject) => {
            const id = seq++;
            workers[k].onmessage = (e: MessageEvent<Reply>) => (e.data.id === id ? (e.data.ok ? resolve(e.data) : reject(new Error(e.data.error))) : undefined);
            workers[k].onerror = (e) => reject(new Error(e.message || 'the backtest worker failed'));
            workers[k].postMessage({ id, model, dataset, strategies, opts } satisfies BacktestRequest);
          }),
      ),
    )]);
    const errors = new Map<number, string>();
    for (const r of replies) for (const e of r.errors ?? []) errors.set(e.index, e.message);
    // back into the order the strategies were written in
    const order = replies.flatMap((r) => r.indices!.map((index, j) => ({ index, s: r.result!.strategies[j] }))).sort((a, b) => a.index - b.index);
    const merged = mergeBacktests(replies.map((r) => r.result!));
    const strategies = order.map((o) => o.s);
    return { result: { ...merged, strategies, ranking: mergeBacktests([{ ...merged, strategies }]).ranking }, errors };
  } finally {
    if (busy) idle.push(...workers);
    busy = false;
    cancelled.catch(() => undefined);
  }
}
