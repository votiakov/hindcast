import type { AnalysisRequest } from './browser.worker';
import { aggregate, seedsFor, type Analysis, type RunSummary } from './analyze';
import type { OptimizeResult } from '../optimize';
import type { breakingPoint } from '../headless';

/**
 * Promise wrapper around analysis web workers. Monte Carlo seeds are split across up to
 * (cores − 1) workers and the per-run summaries are aggregated here, so results are identical
 * to the sequential and Node runners for the same seeds.
 */
let seq = 1;
const spawn = () => new Worker(new URL('./browser.worker.ts', import.meta.url), { type: 'module' });

type Req = AnalysisRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

function ask<T>(w: Worker, req: Req): Promise<T> {
  const id = seq++;
  return new Promise((resolve, reject) => {
    const onMsg = (e: MessageEvent<{ id: number; ok: boolean; result?: T; error?: string }>) => {
      if (e.data.id !== id) return;
      w.removeEventListener('message', onMsg);
      e.data.ok ? resolve(e.data.result as T) : reject(new Error(e.data.error));
    };
    w.addEventListener('message', onMsg);
    w.postMessage({ ...req, id });
  });
}

export async function analyzeInBrowser(spec: unknown, scenario: unknown, runs = 12): Promise<Analysis> {
  const t0 = performance.now();
  const seeds = seedsFor(runs);
  const n = Math.max(1, Math.min(runs, (navigator.hardwareConcurrency ?? 4) - 1, 6));
  const chunks = Array.from({ length: n }, (_, i) => seeds.filter((_, j) => j % n === i));
  const workers = chunks.map(() => spawn());
  try {
    const parts = await Promise.all(chunks.map((c, i) => ask<RunSummary[]>(workers[i], { type: 'runs', spec, scenario, seeds: c })));
    const all = parts.flat().sort((a, b) => seeds.indexOf(a.seed) - seeds.indexOf(b.seed));
    return aggregate(all, Math.round(performance.now() - t0));
  } finally {
    workers.forEach((w) => w.terminate());
  }
}

export async function optimizeInBrowser(spec: unknown, scenario: Record<string, unknown>, allowRuntimes: boolean) {
  const w = spawn();
  try {
    return await ask<Omit<OptimizeResult, 'spec'>>(w, { type: 'optimize', spec, scenario, allowRuntimes });
  } finally {
    w.terminate();
  }
}

export async function breakingPointInBrowser(spec: unknown, readRatio: number) {
  const w = spawn();
  try {
    return await ask<ReturnType<typeof breakingPoint>>(w, { type: 'breaking', spec, readRatio });
  } finally {
    w.terminate();
  }
}
