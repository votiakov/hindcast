import {  type Dataset, type Num } from './dataset';
import type { AccuracyRecord, Model } from './model';
import {   type Fault, type Traffic } from './engine';
import * as wasm from './wasm/hindcast_engine.js';

/**
 * Backtest: replay history through the calibrated model as-is (the baseline) and with each strategy
 * applied, many times over with capacities drawn from their bootstrap bands, and summarise what
 * would have happened — with the measured history alongside.
 */

export interface Band {
  p50: number[];
  lo: number[];
  hi: number[];
}

export interface Summary {
  /** $ over the window */
  cost: number;
  /** $ per 730-hour month at the window's average rate */
  monthly: number;
  minutesOutOfSlo: number;
  failedRequests: number;
  requests: number;
  /** share of the error budget (SLO error rate × requests) used */
  errorBudgetUsed: number;
  peakP99Ms: number;
}

export interface Ranged {
  p50: number;
  lo: number;
  hi: number;
}

export interface WorstMoment {
  t: number;
  p99Ms: number;
  errorRate: number;
  why: string;
  /** the service that limited the system at that moment */
  service: string | null;
}

export interface StrategyResult {
  name: string;
  description?: string;
  notes: string[];
  series: { p99Ms: Band; errorRate: Band; costPerHour: Band; cumulativeCost: Band; errorBudget: Band; replicas: Record<string, number[]> };
  summary: Record<keyof Summary, Ranged>;
  /** strategy − baseline, per draw, summarised */
  delta: { cost: Ranged; monthly: Ranged; minutesOutOfSlo: Ranged; failedRequests: Ranged };
  worst: WorstMoment;
  /** per endpoint, against its own SLO (point estimate) */
  endpoints: Record<string, { requests: number; failedRequests: number; minutesOutOfSlo: number; peakP99Ms: number; cost: number; costPerMillion: number; slo: { p99Ms: number; errorRate: number } }>;
  /** contiguous runs of buckets out of SLO */
  incidents: { start: number; end: number; minutes: number; peakP99Ms: number; peakErrorRate: number; why: string }[];
  events: { t: number; what: string }[];
  /** per service: the highest share of capacity it ran at (point estimate), and the plan's req/s per replica */
  peakUtil: Record<string, number>;
  /** the node pool (point estimate): nodes at the busiest moment and on average, and the most every
   *  pod requested against what those nodes hold */
  cluster?: { peakNodes: number; meanNodes: number; autoscaled: boolean; peakRequestedCpu: number; peakRequestedMemoryGb: number; nodeCpu: number; nodeMemoryGb: number; nodeHour: number };
}

export interface BacktestResult {
  model: string;
  window: { start: number; end: number; stepS: number; n: number };
  slo: { p99Ms: number; errorRate: number };
  t: number[];
  actual: { rps: Num[]; errorRate: Num[]; p99Ms: Num[]; costPerHour: Num[] };
  baseline: StrategyResult;
  strategies: StrategyResult[];
  /** strategies ordered best first: meets SLO no worse than baseline, then cheapest */
  ranking: { name: string; monthlyDelta: number; minutesOutOfSloDelta: number; verdict: string }[];
  accuracy: AccuracyRecord[];
  draws: number;
  /** the history was replayed at another load (absent: as recorded) */
  load?: { factor: number; peakRps: number };
  /** the busiest moment of the traffic replayed, req/s (all endpoints) */
  peakRps: number;
}

export interface BacktestOptions {
  draws?: number;
  seed?: number;
  /** use the observed replica counts for the baseline (default true) */
  observed?: boolean;
  traffic?: Traffic;
  /** replay the history at another load: ×scale, or so its busiest moment is peakRps (launch day,
   *  Black Friday). The as-built system and every strategy see the same load. */
  load?: { scale?: number; peakRps?: number };
  /** time-boxed faults (incident and public-outage replays) */
  faults?: Fault[];
}

/** strategies ordered by time out of SLO (when it differs by more than half a minute), then by cost */
export function rankStrategies(results: StrategyResult[]): BacktestResult['ranking'] {
  return results
    .map((r) => {
      const dm = r.delta.monthly.p50;
      const ds = r.delta.minutesOutOfSlo.p50;
      const minutes = (k: number) => `minute${k === 1 ? '' : 's'}`;
      const verdict =
        ds <= 0.5 && dm < 0 ? `saves $${Math.round(-dm).toLocaleString('en-US')}/month with no more time out of SLO` : ds < -0.5 && dm <= 0 ? 'cheaper and more reliable' : ds < -0.5 ? `$${Math.round(dm).toLocaleString('en-US')}/month buys ${Math.round(-ds)} fewer ${minutes(Math.round(-ds))} out of SLO` : ds > 0.5 && dm < 0 ? `saves $${Math.round(-dm).toLocaleString('en-US')}/month but adds ${Math.round(ds)} ${minutes(Math.round(ds))} out of SLO` : ds > 0.5 ? 'worse on both' : `costs $${Math.round(dm).toLocaleString('en-US')}/month more for the same reliability`;
      return { name: r.name, monthlyDelta: dm, minutesOutOfSloDelta: ds, verdict };
    })
    .sort((a, b) => a.minutesOutOfSloDelta - b.minutesOutOfSloDelta > 0.5 || b.minutesOutOfSloDelta - a.minutesOutOfSloDelta > 0.5 ? a.minutesOutOfSloDelta - b.minutesOutOfSloDelta : a.monthlyDelta - b.monthlyDelta);
}

/**
 * Backtests of the same model, dataset and options over different strategies, as one. Each plan
 * draws from its own seeded generator, so a strategy's result does not depend on which others ran
 * with it: the merge equals one backtest over all of them.
 */
export function mergeBacktests(parts: BacktestResult[]): BacktestResult {
  const strategies = parts.flatMap((p) => p.strategies);
  return { ...parts[0], strategies, ranking: rankStrategies(strategies) };
}

export function backtest(model: Model, d: Dataset, strategies: unknown[], opts: BacktestOptions = {}): BacktestResult {
  const r = wasm.backtest(model, d, strategies, opts) as BacktestResult;
  r.accuracy = model.accuracy;
  return r;
}
