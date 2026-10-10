/// <reference lib="webworker" />
import { backtest, type BacktestOptions } from '../backtest/backtest';
import type { Dataset } from '../backtest/dataset';
import type { Model } from '../backtest/model';

/**
 * One share of a backtest off the main thread: the baseline and some of the strategies. A strategy
 * the model can't apply (say it names an unknown service) is reported on its own; the rest still run.
 */
export interface BacktestRequest {
  id: number;
  model: Model;
  dataset: Dataset;
  strategies: { index: number; spec: unknown }[];
  opts: BacktestOptions;
}

self.onmessage = (e: MessageEvent<BacktestRequest>) => {
  const { id, model, dataset, strategies, opts } = e.data;
  try {
    const errors: { index: number; message: string }[] = [];
    let good = strategies;
    try {
      return void self.postMessage({ id, ok: true, result: backtest(model, dataset, good.map((s) => s.spec), opts), indices: good.map((s) => s.index), errors });
    } catch {
      good = strategies.filter((s) => {
        try {
          backtest(model, dataset, [s.spec], { ...opts, draws: 1 });
          return true;
        } catch (err) {
          errors.push({ index: s.index, message: err instanceof Error ? err.message : String(err) });
          return false;
        }
      });
    }
    self.postMessage({ id, ok: true, result: backtest(model, dataset, good.map((s) => s.spec), opts), indices: good.map((s) => s.index), errors });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
