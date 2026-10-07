import type { Dataset, Num } from './dataset';
import { quantile, sliceDataset } from './dataset';
import type { AccuracyCheck, AccuracyRecord, Model } from './model';
import { basePlan, mixtureQuantile, runPlan, type Plan, type Traffic } from './engine';
import { calibrate, observedReplicas, trafficOf, type CalibrateOptions } from './calibrate';
import { applyStrategy } from './strategy';

/**
 * How good is the model? Every claim is checked against something measured:
 *
 *  - holdout: calibrate on the first part of the history, predict the rest, compare
 *  - reference: predict a run that really happened under a change (a strategy actually applied,
 *    a stress test to the breaking point) and compare with what was recorded
 *
 * The same definitions are used for predicted and measured series, so they compare like for like.
 */

export const TOLERANCE = { p99: 0.2, breakingPoint: 0.15, cost: 0.1 };

interface Obs {
  rps: Num[];
  p99Ms: Num[];
  errorRate: Num[];
}

/** total measured client series of a dataset (sum of endpoints) */
export function clientSeries(d: Dataset): Obs {
  const ids = Object.keys(d.endpoints);
  const rps: Num[] = [];
  const p99: Num[] = [];
  const err: Num[] = [];
  for (let i = 0; i < d.n; i++) {
    let r = 0;
    let e = 0;
    let p = 0;
    let w = 0;
    let any = false;
    for (const id of ids) {
      const s = d.endpoints[id];
      const v = s.rps?.[i];
      if (v === null || v === undefined) continue;
      any = true;
      r += v;
      e += v * (s.errorRate?.[i] ?? 0);
      // traffic-weighted p99 across endpoints (exact for one endpoint)
      p += v * (s.p99Ms?.[i] ?? 0);
      w += v;
    }
    rps.push(any ? r : null);
    err.push(any ? (r > 0 ? e / r : 0) : null);
    p99.push(any && w > 0 ? p / w : null);
  }
  return { rps, p99Ms: p99, errorRate: err };
}

/** typical per-bucket error: median of |pred − obs| / obs over buckets with traffic */
export function medianApe(pred: number[], obs: Num[], minObs = 1): number {
  const e: number[] = [];
  for (let i = 0; i < obs.length; i++) {
    const o = obs[i];
    if (o === null || o < minObs || !isFinite(pred[i])) continue;
    e.push(Math.abs(pred[i] - o) / o);
  }
  e.sort((a, b) => a - b);
  return e.length ? e[Math.floor(e.length / 2)] : NaN;
}

/** mean of a series over buckets that have data */
const avg = (xs: Num[]) => {
  let s = 0;
  let k = 0;
  for (const x of xs) if (x !== null && isFinite(x)) (s += x), k++;
  return k ? s / k : NaN;
};

/**
 * Breaking point from a step load test: group buckets into plateaus of steady load, score each
 * plateau by how far it is past the SLO (max of p99/SLO and errors/SLO, last half of the plateau),
 * and interpolate where the score crosses 1. Returns req/s.
 */
export function breakingPointOf(s: Obs, slo: { p99Ms: number; errorRate: number }): { rps: number; plateaus: { rps: number; score: number }[] } {
  const plateaus: { rps: number; score: number }[] = [];
  let cur: number[] = [];
  const flush = () => {
    if (cur.length >= 3) {
      const tail = cur.slice(Math.floor(cur.length / 2));
      const rps = avg(tail.map((i) => s.rps[i]));
      const p99 = avg(tail.map((i) => s.p99Ms[i]));
      const err = avg(tail.map((i) => s.errorRate[i]));
      plateaus.push({ rps, score: Math.max(p99 / slo.p99Ms, err / slo.errorRate) });
    }
    cur = [];
  };
  // a new plateau starts when the offered load moves more than 8% from the plateau's start
  for (let i = 0; i < s.rps.length; i++) {
    const r = s.rps[i];
    if (r === null || r <= 0) continue;
    if (cur.length && Math.abs(r - (s.rps[cur[0]] as number)) / (s.rps[cur[0]] as number) > 0.08) {
      // ramp buckets between steps belong to the next plateau
      flush();
    }
    cur.push(i);
  }
  flush();
  return { rps: crossing(plateaus), plateaus };
}

/** where the SLO score (≤ 1 = within SLO) crosses 1, interpolated log-linearly between plateaus */
export function crossing(plateausIn: { rps: number; score: number }[]): number {
  const plateaus = [...plateausIn].sort((a, b) => a.rps - b.rps);
  const first = plateaus.findIndex((p) => p.score > 1);
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
  const parts: { w: number; mean: number; p99: number }[] = [];
  for (const e of Object.values(r.endpoints)) for (let i = i0; i < i1; i++) if (e.rps[i] > 0) parts.push({ w: e.rps[i], mean: e.meanMs[i], p99: e.p99Ms[i] });
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

/** predicted series → Obs */
const asObs = (r: ReturnType<typeof runPlan>): Obs => ({ rps: r.rps, p99Ms: r.p99Ms, errorRate: r.errorRate });

/** model-only breaking point: step the traffic up with the endpoint mix until the SLO breaks */
export function modelBreakingPoint(model: Model, plan: Plan = basePlan(model), opts: { maxRps?: number; steps?: number; holdS?: number } = {}): { rps: number; limitedBy: string | null } {
  const shares = Object.entries(model.endpoints).map(([id, e]) => [id, e.share] as const);
  // capacity guess to size the ramp: the smallest per-service limit given visits
  let guess = Infinity;
  for (const [id, s] of Object.entries(plan.services)) {
    if (!isFinite(s.perReplicaRps)) continue;
    const visits = shares.reduce((a, [ep, sh]) => a + sh * (model.endpoints[ep].visits[id] ?? 0), 0);
    const reps = s.replicas ?? model.services[s.hostedBy ?? id]?.replicas ?? 1;
    if (visits > 0) guess = Math.min(guess, (s.perReplicaRps * reps) / visits);
  }
  const top = opts.maxRps ?? (isFinite(guess) ? guess * 2 : 10_000);
  const steps = opts.steps ?? 40;
  const hold = opts.holdS ?? 60;
  const stepS = 10;
  const per = Math.round(hold / stepS);
  const n = steps * per;
  const rpsAt = (i: number) => (top * (Math.floor(i / per) + 1)) / steps;
  const traffic: Traffic = { start: 0, stepS, n, endpoints: Object.fromEntries(shares.map(([id, sh]) => [id, Array.from({ length: n }, (_, i) => rpsAt(i) * sh)])) };
  const fixed: Plan = { ...plan, services: Object.fromEntries(Object.entries(plan.services).map(([id, s]) => [id, { ...s, observedReplicas: undefined, replicas: s.replicas ?? (s.autoscale ? null : model.services[id]?.replicas ?? 1) }])) };
  const r = runPlan(fixed, traffic);
  const bp = breakingPointOf(asObs(r), model.slo);
  // which service was saturated just past the breaking point
  const i = r.rps.findIndex((x) => x > bp.rps * 1.02);
  let limitedBy: string | null = null;
  if (i >= 0) {
    let best = 0;
    for (const [id, s] of Object.entries(r.services)) if (s.util[i] > best) [best, limitedBy] = [s.util[i], id];
  }
  return { rps: bp.rps, limitedBy };
}

const check = (metric: AccuracyCheck['metric'], predicted: number, measured: number, tolerance: number, note: string): AccuracyCheck => {
  const error = measured !== 0 ? Math.abs(predicted - measured) / Math.abs(measured) : predicted === 0 ? 0 : 1;
  return { metric, predicted, measured, error, tolerance, pass: error <= tolerance, note };
};

/** total $ in a dataset's bill (within the dataset window) */
export function billTotal(d: Dataset): number | null {
  if (!d.bill) return null;
  let total = 0;
  for (const c of Object.values(d.bill.components)) for (const v of c.series ?? []) if (v !== null) total += v;
  return total + d.bill.unattributed;
}

/** calibrate on the first part, predict the rest */
export function holdoutAccuracy(d: Dataset, opts: CalibrateOptions & { holdout?: number; requests?: RequestLog } = {}): AccuracyRecord {
  const cut = Math.floor(d.n * (1 - (opts.holdout ?? 0.3)));
  const train = sliceDataset(d, 0, cut);
  const test = sliceDataset(d, cut, d.n);
  const model = calibrate(train, opts);
  const r = runPlan(basePlan(model, observedReplicas(test, model)), trafficOf(test, model));
  const obs = clientSeries(test);
  const checks: AccuracyCheck[] = [];
  const span = `on the last ${Math.round((test.n * test.stepS) / 60)} min, calibrated on the ${Math.round((train.n * train.stepS) / 60)} min before`;
  const w = opts.requests ? windowP99(r, opts.requests, test.start, test.stepS) : null;
  if (w && w.rows.length) {
    const pm = w.rows.reduce((a, x) => a + x.predicted, 0) / w.rows.length;
    const mm = w.rows.reduce((a, x) => a + x.measured, 0) / w.rows.length;
    checks.push({ metric: 'p99', predicted: pm, measured: mm, error: w.median, tolerance: TOLERANCE.p99, pass: w.median <= TOLERANCE.p99, note: `p99 over every request in each 5-minute window ${span} — typical error ${(w.median * 100).toFixed(0)}%, worst ${(w.max * 100).toFixed(0)}%` });
  } else {
    // per-bucket p99s decide pass/fail
    const ape = medianApe(r.p99Ms, obs.p99Ms);
    if (isFinite(ape)) checks.push({ ...check('p99', avg(r.p99Ms.map((x, i) => (obs.p99Ms[i] === null ? null : x))), avg(obs.p99Ms), TOLERANCE.p99, `typical error per ${test.stepS}s bucket ${(ape * 100).toFixed(0)}% ${span}`), error: ape, pass: ape <= TOLERANCE.p99 });
  }
  const bill = billTotal(test);
  if (bill !== null) {
    const pred = r.cost.compute.reduce((a, x, i) => a + x + r.cost.requests[i] + r.cost.transfer[i] + r.cost.other[i], 0);
    checks.push(check('cost', pred, bill, TOLERANCE.cost, 'model cost vs the bill over the held-out window'));
  }
  return { method: 'holdout', label: `last ${Math.round((opts.holdout ?? 0.3) * 100)}% of the history`, checks, measuredAt: new Date().toISOString() };
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
  const checks: AccuracyCheck[] = [];
  for (const run of runs) {
    const base = basePlan(model);
    const plan = run.strategy ? applyStrategy(model, base, run.strategy).plan : base;
    // fixed replica counts were applied for real: use the counts the run actually had (containers
    // start a few seconds apart); autoscaling is predicted, never copied from the run
    const obsReps = observedReplicas(run.dataset, model);
    for (const [id, s] of Object.entries(plan.services)) if (!s.autoscale && obsReps[id]) {
      s.replicas = null;
      s.observedReplicas = obsReps[id];
    }
    const r = runPlan(plan, trafficOf(run.dataset, model));
    const obs = clientSeries(run.dataset);
    if (run.stress && run.requests && run.shape) {
      const bp = plateauBreakingPoint(r, run.requests, run.start ?? run.dataset.start, run.dataset.stepS, run.shape, model.slo);
      // the shape's t is relative to the recording start, the dataset grid to its first bucket
      checks.push(check('breaking-point', bp.predicted, bp.measured, TOLERANCE.breakingPoint, `${run.label}: step load test, p99 and errors over every request of each plateau (SLO p99 ≤ ${model.slo.p99Ms} ms, errors ≤ ${(model.slo.errorRate * 100).toFixed(0)}%)`));
    } else if (!run.stress && run.requests) {
      const w = windowP99(r, run.requests, run.dataset.start, run.dataset.stepS);
      const pm = w.rows.reduce((a, x) => a + x.predicted, 0) / Math.max(1, w.rows.length);
      const mm = w.rows.reduce((a, x) => a + x.measured, 0) / Math.max(1, w.rows.length);
      checks.push({ metric: 'p99', predicted: pm, measured: mm, error: w.median, tolerance: TOLERANCE.p99, pass: w.median <= TOLERANCE.p99, note: `${run.label}: p99 over every request in each 5-minute window, ${w.rows.length} windows — typical error ${(w.median * 100).toFixed(0)}%, worst ${(w.max * 100).toFixed(0)}%` });
      const failedPred = r.rps.reduce((a, x, i) => a + x * r.errorRate[i] * run.dataset.stepS, 0);
      const failedObs = run.requests.failed.filter(Boolean).length;
      checks.push({ metric: 'errors', predicted: failedPred, measured: failedObs, error: failedObs > 0 ? Math.abs(failedPred - failedObs) / failedObs : failedPred > 0 ? 1 : 0, tolerance: Infinity, pass: true, note: `${run.label}: failed requests (informational)` });
    } else if (run.stress) {
      const m = breakingPointOf(obs, model.slo);
      const p = breakingPointOf(asObs(r), model.slo);
      checks.push(check('breaking-point', p.rps, m.rps, TOLERANCE.breakingPoint, `${run.label}: step load test, SLO p99 ≤ ${model.slo.p99Ms} ms and errors ≤ ${(model.slo.errorRate * 100).toFixed(0)}%`));
    } else {
      const ape = medianApe(r.p99Ms, obs.p99Ms);
      const c = check('p99', avg(r.p99Ms.map((x, i) => (obs.p99Ms[i] === null ? null : x))), avg(obs.p99Ms), TOLERANCE.p99, `${run.label}: typical error per ${run.dataset.stepS}s bucket ${(ape * 100).toFixed(0)}%`);
      checks.push({ ...c, error: ape, pass: ape <= TOLERANCE.p99 });
      const failedPred = r.rps.reduce((a, x, i) => a + x * r.errorRate[i] * run.dataset.stepS, 0);
      const failedObs = obs.rps.reduce<number>((a, x, i) => a + (x ?? 0) * (obs.errorRate[i] ?? 0) * run.dataset.stepS, 0);
      checks.push({ metric: 'errors', predicted: failedPred, measured: failedObs, error: failedObs > 0 ? Math.abs(failedPred - failedObs) / failedObs : failedPred > 0 ? 1 : 0, tolerance: Infinity, pass: true, note: `${run.label}: failed requests (informational)` });
    }
    const bill = billTotal(run.dataset);
    if (bill !== null && !run.stress) {
      const pred = r.cost.compute.reduce((a, x, i) => a + x + r.cost.requests[i] + r.cost.transfer[i] + r.cost.other[i], 0);
      checks.push(check('cost', pred, bill, TOLERANCE.cost, `${run.label}: predicted cost vs the run's bill`));
    }
  }
  return { method: 'reference', label, checks, measuredAt: new Date().toISOString() };
}

/** one line per check, for terminals and reports */
export function accuracyLines(rec: AccuracyRecord): string[] {
  const f = (c: AccuracyCheck) => {
    const unit = c.metric === 'cost' ? (x: number) => `$${x.toFixed(x < 10 ? 3 : 0)}` : c.metric === 'breaking-point' ? (x: number) => `${x.toFixed(1)} req/s` : c.metric === 'errors' ? (x: number) => `${Math.round(x)}` : (x: number) => `${Math.round(x)} ms`;
    const verdict = c.metric === 'errors' ? '' : c.pass ? 'PASS' : 'MISS';
    return `${verdict.padEnd(4)} ${c.metric.padEnd(14)} predicted ${unit(c.predicted)} vs measured ${unit(c.measured)} — off by ${(c.error * 100).toFixed(1)}%${isFinite(c.tolerance) ? ` (target ≤ ${c.tolerance * 100}%)` : ''} · ${c.note}`;
  };
  return rec.checks.map(f);
}
