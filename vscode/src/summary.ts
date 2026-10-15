import { simulate } from '../../src/sim/headless';
import type { Summary } from './protocol';

/** the status bar's numbers: one headless run, as the CLI's `simulate` (the engine must be loaded) */
export function summary(value: unknown, rps: number | undefined): Summary {
  const r = simulate(value, rps ? { rps } : {});
  const top = r.bottlenecks[0];
  return {
    scenario: r.scenario,
    p99Ms: r.summary.peakP99Ms,
    errorRate: r.summary.meanErrorRate,
    monthly: r.summary.meanCostPerHour * 730,
    sloCompliance: r.summary.sloCompliance,
    slo: r.slo,
    bottleneck: top && top.peakUtil >= 0.8 ? { id: top.id, note: top.note } : null,
  };
}
