/// <reference lib="webworker" />
import { simulateDes } from './des';
import { slim } from './analyze';
import { optimize } from '../optimize';
import { breakingPoint } from '../headless';

/** Off-main-thread analysis for the app: discrete-event runs, breaking point, optimizer. */
export type AnalysisRequest =
  | { id: number; type: 'runs'; spec: unknown; scenario: unknown; seeds: number[] }
  | { id: number; type: 'optimize'; spec: unknown; scenario: Record<string, unknown>; allowRuntimes: boolean }
  | { id: number; type: 'breaking'; spec: unknown; readRatio: number };

self.onmessage = (e: MessageEvent<AnalysisRequest>) => {
  const m = e.data;
  try {
    let result: unknown;
    if (m.type === 'runs') result = m.seeds.map((seed) => slim(simulateDes(m.spec, m.scenario, { seed })));
    else if (m.type === 'optimize') {
      const { spec: _spec, ...r } = optimize(m.spec, m.scenario, { allowRuntimes: m.allowRuntimes, verifyRuns: 6 });
      result = r;
    } else result = breakingPoint(m.spec, { readRatio: m.readRatio });
    self.postMessage({ id: m.id, ok: true, result });
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
