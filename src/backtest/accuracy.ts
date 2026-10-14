import type { Dataset } from './dataset';
import { quantile } from './dataset';
import type { AccuracyCheck, AccuracyRecord, Model } from './model';
import { basePlan, mixtureQuantile, runPlan, type Plan } from './engine';
import {  type CalibrateOptions } from './calibrate';
import * as wasm from './wasm/hindcast_engine.js';

/**
 * How good is the model? Every claim is checked against something measured:
 *
 *  - holdout: calibrate on the first part of the history, predict the rest, compare
 *  - reference: predict a run that really happened under a change (a strategy actually applied,
 *    a stress test to the breaking point) and compare with what was recorded
 *
 * The same definitions are used for predicted and measured series, so they compare like for like.
 */

/** where the SLO score (≤ 1 = within SLO) crosses 1, interpolated log-linearly between plateaus */
export function crossing(plateausIn: { rps: number; score: number }[]): number {
  const plateaus = [...plateausIn].sort((a, b) => a.rps - b.rps);
  // the breaking point is where failing *stays*: a lone noisy plateau below it (a few random errors
  // in 30 seconds of traffic) is not a break — the first plateau of the failing tail is
  let first = plateaus.length;
  while (first > 0 && plateaus[first - 1].score > 1) first--;
  if (first === plateaus.length) first = -1;
  if (first < 0) return plateaus.at(-1)?.rps ?? 0;
  if (first === 0) return plateaus[0].rps;
  const a = plateaus[first - 1];
  const b = plateaus[first];
  const la = Math.log(Math.max(1e-6, a.score));
  const lb = Math.log(Math.max(1e-6, b.score));
  const f = lb > la ? (0 - la) / (lb - la) : 0;
  return a.rps + Math.max(0, Math.min(1, f)) * (b.rps - a.rps);
}

/** every request a load generator (or an access log) recorded */
export interface RequestLog {
  t: number[];
  ms: number[];
  failed: boolean[];
}

export function parseRequestLog(csv: string): RequestLog {
  const out: RequestLog = { t: [], ms: [], failed: [] };
  for (const line of csv.split('\n').slice(1)) {
    if (!line) continue;
    const [t, ms, failed] = line.split(',');
    out.t.push(Number(t));
    out.ms.push(Number(ms));
    out.failed.push(failed === '1');
  }
  return out;
}

/** the model's p99 over a span of buckets: the traffic-weighted mixture of every endpoint's latency */
function predictedP99(r: ReturnType<typeof runPlan>, i0: number, i1: number): number {
  const parts: { w: number; mean: number; p99: number; p50?: number }[] = [];
  for (const e of Object.values(r.endpoints)) for (let i = i0; i < i1; i++) if (e.rps[i] > 0) parts.push({ w: e.rps[i], mean: e.meanMs[i], p99: e.p99Ms[i], ...(e.p50Ms[i] > 0 && e.p99Ms[i] < 4000 ? { p50: e.p50Ms[i] } : {}) });
  return mixtureQuantile(parts);
}

function predictedErr(r: ReturnType<typeof runPlan>, i0: number, i1: number): number {
  let n = 0;
  let f = 0;
  for (let i = i0; i < i1; i++) (n += r.rps[i]), (f += r.rps[i] * r.errorRate[i]);
  return n > 0 ? f / n : 0;
}

function measuredIn(log: RequestLog, a: number, b: number) {
  const ms: number[] = [];
  let failed = 0;
  for (let k = 0; k < log.t.length; k++)
    if (log.t[k] >= a && log.t[k] < b) {
      ms.push(log.ms[k]);
      if (log.failed[k]) failed++;
    }
  ms.sort((x, y) => x - y);
  return { n: ms.length, p99: ms.length ? quantile(ms, 0.99) : NaN, err: ms.length ? failed / ms.length : NaN, dur: b - a };
}

/** p99 over every request in each window (pooled, so a window holds hundreds of requests), predicted vs measured */
export function windowP99(r: ReturnType<typeof runPlan>, log: RequestLog, start: number, stepS: number, windowS = 300) {
  const per = Math.max(1, Math.round(windowS / stepS));
  const rows: { t: number; measured: number; predicted: number; n: number; ape: number }[] = [];
  for (let i0 = 0; i0 + per <= r.t.length; i0 += per) {
    const a = start + i0 * stepS;
    const m = measuredIn(log, a, a + per * stepS);
    if (m.n < 200) continue;
    const p = predictedP99(r, i0, i0 + per);
    rows.push({ t: a, measured: m.p99, predicted: p, n: m.n, ape: Math.abs(p - m.p99) / m.p99 });
  }
  const apes = rows.map((x) => x.ape).sort((a, b) => a - b);
  return { rows, median: apes.length ? quantile(apes, 0.5) : NaN, max: apes.length ? apes[apes.length - 1] : NaN };
}

/** plateaus of a step load test (flat stretches of the offered load), scored predicted and measured */
export function plateauBreakingPoint(r: ReturnType<typeof runPlan>, log: RequestLog, start: number, stepS: number, shape: { t: number; rps: number }[], slo: { p99Ms: number; errorRate: number }) {
  const measured: { rps: number; score: number }[] = [];
  const predicted: { rps: number; score: number }[] = [];
  for (let k = 1; k < shape.length; k++) {
    if (shape[k].rps !== shape[k - 1].rps || shape[k].t - shape[k - 1].t < 30) continue;
    // the second half of each plateau, once the queue has settled
    const a = start + (shape[k - 1].t + shape[k].t) / 2;
    const b = start + shape[k].t;
    const m = measuredIn(log, a, b);
    if (!m.n) continue;
    const i0 = Math.max(0, Math.floor((a - start) / stepS));
    const i1 = Math.min(r.t.length, Math.ceil((b - start) / stepS));
    const p99 = predictedP99(r, i0, i1);
    const err = predictedErr(r, i0, i1);
    measured.push({ rps: m.n / m.dur, score: Math.max(m.p99 / slo.p99Ms, m.err / slo.errorRate) });
    predicted.push({ rps: m.n / m.dur, score: Math.max(p99 / slo.p99Ms, err / slo.errorRate) });
  }
  return { measured: crossing(measured), predicted: crossing(predicted), plateaus: measured.map((m, k) => ({ rps: m.rps, measured: m.score, predicted: predicted[k].score })) };
}

/** model-only breaking point: step the traffic up with the endpoint mix until the SLO breaks */
export function modelBreakingPoint(model: Model, plan: Plan = basePlan(model), opts: { maxRps?: number; steps?: number; holdS?: number } = {}): { rps: number; limitedBy: string | null } {
  return wasm.modelBreakingPoint(model, plan, opts);
}

/** calibrate on the first part, predict the rest */
export function holdoutAccuracy(d: Dataset, opts: CalibrateOptions & { holdout?: number; requests?: RequestLog } = {}): AccuracyRecord {
  const { holdout, requests, ...rest } = opts;
  return wasm.holdoutAccuracy(d, rest, holdout, requests) as AccuracyRecord;
}

export interface ReferenceRun {
  label: string;
  dataset: Dataset;
  /** every request the load generator made — pooled p99s instead of noisy per-bucket ones */
  requests?: RequestLog;
  /** step load test: the offered-load keyframes, seconds from `start` */
  shape?: { t: number; rps: number }[];
  /** epoch s the shape's t = 0 refers to */
  start?: number;
  /** the change that was really applied for this run (none = the system as calibrated) */
  strategy?: unknown;
  /** this run is a step load test: check the breaking point */
  stress?: boolean;
}

/** predict recorded runs the model never saw */
export function referenceAccuracy(model: Model, runs: ReferenceRun[], label: string): AccuracyRecord {
  return wasm.referenceAccuracy(model, runs, label) as AccuracyRecord;
}

/** one line per check, for terminals and reports */
export function accuracyLines(rec: AccuracyRecord): string[] {
  const f = (c: AccuracyCheck) => {
    const unit = c.metric === 'cost' ? (x: number) => `$${x.toFixed(x < 10 ? 3 : 0)}` : c.metric === 'breaking-point' ? (x: number) => `${x.toFixed(1)} req/s` : c.metric === 'errors' ? (x: number) => `${Math.round(x)}` : (x: number) => `${Math.round(x)} ms`;
    const verdict = c.metric === 'errors' ? '' : c.pass ? 'PASS' : 'MISS';
    return `${verdict.padEnd(4)} ${c.metric.padEnd(14)} predicted ${unit(c.predicted)} vs measured ${unit(c.measured)} — off by ${(c.error * 100).toFixed(1)}%${typeof c.tolerance === 'number' && isFinite(c.tolerance) ? ` (target ≤ ${c.tolerance * 100}%)` : ''} · ${c.note}`;
  };
  return rec.checks.filter((c) => c.metric !== 'errors').map(f);
}
