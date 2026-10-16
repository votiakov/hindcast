/// <reference lib="webworker" />
import { reviewCapacity } from '../backtest/review';
import type { Dataset } from '../backtest/dataset';
import type { Model } from '../backtest/model';
import { loadEngine } from '../backtest/native';

const ready = loadEngine();

/** The capacity review off the main thread: its phases as they start, then the review. */
export interface ReviewRequest {
  id: number;
  model: Model;
  dataset: Dataset;
  draws: number;
}

self.onmessage = async (e: MessageEvent<ReviewRequest>) => {
  await ready;
  const { id, model, dataset, draws } = e.data;
  try {
    const review = reviewCapacity(model, dataset, { draws }, (label) => self.postMessage({ id, progress: label }));
    self.postMessage({ id, ok: true, review });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
