import { simulateDes, type DesConfig, type DesResult } from './des';

/**
 * Monte Carlo analysis: the same architecture + scenario under N seeds, aggregated into
 * means with 95% confidence intervals. Pure and sequential — pools (Node / browser) just
 * split the seeds across workers and call `aggregate` on the combined summaries.
 */

export interface Stat {
  mean: number;
  /** half-width of the 95% confidence interval of the mean */
  ci95: number;
  min: number;
  max: number;
}

export interface Analysis {
  runs: number;
  seeds: number[];
  architecture: string;
  scenario: string;
  slo: DesResult['slo'];
  /** share of runs that stayed within SLO ≥ 99% of the time */
  pSloMet: number;
  metrics: {
    errorRate: Stat;
    peakErrorRate: Stat;
    p50Ms: Stat;
    p99Ms: Stat;
    p999Ms: Stat;
    sloCompliance: Stat;
    costPerHour: Stat;
  };
  /** how often each component was the #1 bottleneck */
  bottlenecks: { id: string; share: number; note: string | null }[];
  wallMs: number;
  events: number;
}

/** two-sided 95% Student-t critical value */
function t95(df: number): number {
  const table = [12.71, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086];
  if (df < 1) return 0;
  return df <= table.length ? table[df - 1] : df < 40 ? 2.04 : df < 120 ? 2.0 : 1.96;
}

function stat(xs: number[], digits = 4): Stat {
  const n = xs.length;
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const f = 10 ** digits;
  return { mean: Math.round(mean * f) / f, ci95: Math.round(t95(n - 1) * (sd / Math.sqrt(n)) * f) / f, min: Math.min(...xs), max: Math.max(...xs) };
}

export type RunSummary = Pick<DesResult, 'summary' | 'bottlenecks' | 'architecture' | 'scenario' | 'slo' | 'seed'>;

export const slim = (r: DesResult): RunSummary => ({ summary: r.summary, bottlenecks: r.bottlenecks, architecture: r.architecture, scenario: r.scenario, slo: r.slo, seed: r.seed });

export function aggregate(runs: RunSummary[], wallMs: number): Analysis {
  const s = runs.map((r) => r.summary);
  const top = new Map<string, { n: number; note: string | null }>();
  for (const r of runs) {
    const b = r.bottlenecks[0];
    if (!b) continue;
    const cur = top.get(b.id) ?? { n: 0, note: b.note };
    cur.n++;
    top.set(b.id, cur);
  }
  return {
    runs: runs.length,
    seeds: runs.map((r) => r.seed),
    architecture: runs[0].architecture,
    scenario: runs[0].scenario,
    slo: runs[0].slo,
    pSloMet: Math.round((s.filter((x) => x.sloCompliance >= 0.99).length / runs.length) * 1000) / 1000,
    metrics: {
      errorRate: stat(s.map((x) => x.meanErrorRate)),
      peakErrorRate: stat(s.map((x) => x.peakErrorRate)),
      p50Ms: stat(s.map((x) => x.p50Ms), 1),
      p99Ms: stat(s.map((x) => x.p99Ms), 1),
      p999Ms: stat(s.map((x) => x.p999Ms), 1),
      sloCompliance: stat(s.map((x) => x.sloCompliance)),
      costPerHour: stat(s.map((x) => x.meanCostPerHour), 3),
    },
    bottlenecks: [...top].sort((a, b) => b[1].n - a[1].n).map(([id, v]) => ({ id, share: Math.round((v.n / runs.length) * 100) / 100, note: v.note })),
    wallMs,
    events: s.reduce((sum, x) => sum + x.events, 0),
  };
}

export const seedsFor = (runs: number, seed0 = 1) => Array.from({ length: runs }, (_, i) => seed0 + i * 7919);

/** sequential Monte Carlo (works everywhere) */
let nativeAnalyze: typeof analyzeTs | null = null;
export function setNativeAnalyze(f: typeof analyzeTs | null) {
  nativeAnalyze = f;
}

export function analyze(spec: unknown, scenario: unknown, opts: { runs?: number; seed?: number; des?: Partial<DesConfig> } = {}): Analysis {
  return nativeAnalyze ? nativeAnalyze(spec, scenario, opts) : analyzeTs(spec, scenario, opts);
}

export function analyzeTs(spec: unknown, scenario: unknown, opts: { runs?: number; seed?: number; des?: Partial<DesConfig> } = {}): Analysis {
  const t0 = performance.now();
  const runs = seedsFor(opts.runs ?? 20, opts.seed).map((seed) => slim(simulateDes(spec, scenario, { ...opts.des, seed })));
  return aggregate(runs, Math.round(performance.now() - t0));
}
