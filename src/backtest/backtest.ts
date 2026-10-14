import { quantile, type Dataset, type Num } from './dataset';
import type { AccuracyRecord, Model } from './model';
import { basePlan, runPlan, type Fault, type Plan, type RunResult, type Traffic } from './engine';
import { observedReplicas, scaleTraffic, trafficOf } from './calibrate';
import { applyStrategy, StrategySpec } from './strategy';

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

const rangeOf = (xs: number[]): Ranged => {
  const s = [...xs].sort((a, b) => a - b);
  return { p50: quantile(s, 0.5), lo: quantile(s, 0.1), hi: quantile(s, 0.9) };
};

function band(runs: number[][]): Band {
  const n = runs[0]?.length ?? 0;
  const p50: number[] = [];
  const lo: number[] = [];
  const hi: number[] = [];
  for (let i = 0; i < n; i++) {
    const col = runs.map((r) => r[i]).sort((a, b) => a - b);
    p50.push(quantile(col, 0.5));
    lo.push(quantile(col, 0.1));
    hi.push(quantile(col, 0.9));
  }
  return { p50, lo, hi };
}

const cumulative = (xs: number[]) => {
  let s = 0;
  return xs.map((x) => (s += x));
};

function summarise(r: RunResult, slo: { p99Ms: number; errorRate: number }, stepS: number): Summary {
  let cost = 0;
  let out = 0;
  let failed = 0;
  let requests = 0;
  for (let i = 0; i < r.t.length; i++) {
    cost += r.cost.compute[i] + r.cost.requests[i] + r.cost.transfer[i] + r.cost.other[i];
    if (r.rps[i] > 0 && (r.p99Ms[i] > slo.p99Ms || r.errorRate[i] > slo.errorRate)) out += stepS / 60;
    failed += r.rps[i] * r.errorRate[i] * stepS;
    requests += r.rps[i] * stepS;
  }
  const hours = (r.t.length * stepS) / 3600;
  return { cost, monthly: hours > 0 ? (cost / hours) * 730 : 0, minutesOutOfSlo: out, failedRequests: failed, requests, errorBudgetUsed: requests > 0 ? failed / (requests * slo.errorRate) : 0, peakP99Ms: Math.max(0, ...r.p99Ms) };
}

/** which service was the problem at bucket i, in words */
export function explainMoment(r: RunResult, plan: Plan, i: number): { why: string; service: string | null } {
  // a service down after an OOM kill explains everything behind it
  const oom = Object.entries(r.services).find(([, s]) => (s.oomDown?.[i] ?? 0) > 0);
  if (oom) {
    const mem = plan.services[oom[0]].memory!;
    const perRep = r.services[oom[0]].rps[i] / Math.max(1, r.services[oom[0]].replicas[i]);
    return { why: `${oom[0]} OOM-killed: working set ${Math.round((mem.base + mem.perReq * perRep + mem.spike) * 1024)} MiB per container against a ${Math.round(mem.limit * 1024)} MiB limit, its pods restarting (CrashLoopBackOff)`, service: oom[0] };
  }
  let worst: { id: string; score: number } | null = null;
  for (const [id, s] of Object.entries(r.services)) {
    const score = s.util[i] + s.backlog[i] / Math.max(1, plan.services[id].perReplicaRps) + s.waitMs[i] / 1000;
    if (!worst || score > worst.score) worst = { id, score };
  }
  if (!worst) return { why: 'no services in the model', service: null };
  const s = r.services[worst.id];
  const p = plan.services[worst.id];
  const util = s.util[i];
  const reps = Math.round(s.replicas[i] * 10) / 10;
  if (util < 0.5 && s.waitMs[i] < 50) return { why: `no component near its limit (busiest: ${worst.id} at ${Math.round(util * 100)}%)`, service: null };
  // capacity actually available at that moment (faults can cut it below the plan's)
  // rate ÷ utilisation only says something when a fault cut capacity below the plan's; past saturation
  // utilisation is capped and the quotient overstates what a replica can do
  const perRep = Math.min(util > 0 && s.replicas[i] > 0 ? s.rps[i] / s.replicas[i] / util : p.perReplicaRps, p.perReplicaRps);
  const cap = isFinite(perRep) ? `${reps} × ${perRep.toFixed(1)} req/s${perRep < p.perReplicaRps * 0.95 ? ` (normally ${p.perReplicaRps.toFixed(1)})` : ''}` : 'unbounded';
  const queue = s.backlog[i] > 0.5 ? `, ${(s.waitMs[i] / 1000).toFixed(1)} s queue` : s.waitMs[i] > 5 ? `, ${Math.round(s.waitMs[i])} ms wait` : '';
  // offered ÷ capacity: utilisation itself is capped once the queue grows
  const load = isFinite(perRep) && s.replicas[i] > 0 ? Math.max(util, s.rps[i] / (s.replicas[i] * perRep)) : util;
  return { why: `${worst.id} at ${Math.round(load * 100)}% of capacity (${s.rps[i].toFixed(1)} req/s on ${cap})${queue}`, service: worst.id };
}

function incidents(r: RunResult, plan: Plan, slo: { p99Ms: number; errorRate: number }, stepS: number): StrategyResult['incidents'] {
  const out: StrategyResult['incidents'] = [];
  let cur: { s: number; e: number; p: number; er: number; worstI: number } | null = null;
  const flush = () => {
    if (!cur) return;
    out.push({ start: r.t[cur.s], end: r.t[cur.e] + stepS, minutes: ((cur.e - cur.s + 1) * stepS) / 60, peakP99Ms: cur.p, peakErrorRate: cur.er, why: explainMoment(r, plan, cur.worstI).why });
    cur = null;
  };
  for (let i = 0; i < r.t.length; i++) {
    const bad = r.rps[i] > 0 && (r.p99Ms[i] > slo.p99Ms || r.errorRate[i] > slo.errorRate);
    if (!bad) {
      flush();
      continue;
    }
    if (!cur) cur = { s: i, e: i, p: 0, er: 0, worstI: i };
    cur.e = i;
    if (r.p99Ms[i] > cur.p) [cur.p, cur.worstI] = [r.p99Ms[i], i];
    cur.er = Math.max(cur.er, r.errorRate[i]);
  }
  flush();
  return out;
}

/** a plan with every capacity drawn from its bootstrap samples (draw 0 = point estimate) */
export function drawPlan(plan: Plan, model: Model, draw: number, rnd: () => number): Plan {
  if (draw === 0) return plan;
  const services = Object.fromEntries(
    Object.entries(plan.services).map(([id, s]) => {
      const samples = model.services[id]?.capacity.samples;
      if (!samples?.length || !isFinite(s.perReplicaRps)) return [id, s];
      const base = model.services[id].capacity.perReplicaRps;
      const k = samples[Math.floor(rnd() * samples.length)] / base; // relative draw keeps strategy changes
      return [id, { ...s, perReplicaRps: s.perReplicaRps * k }];
    }),
  );
  return { ...plan, services };
}

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function measured(d: Dataset, model: Model): BacktestResult['actual'] {
  const ids = Object.keys(model.endpoints).filter((id) => d.endpoints[id]?.rps);
  const rps: Num[] = [];
  const err: Num[] = [];
  const p99: Num[] = [];
  const cost: Num[] = [];
  for (let i = 0; i < d.n; i++) {
    let r = 0;
    let e = 0;
    let p = 0;
    let any = false;
    for (const id of ids) {
      const s = d.endpoints[id];
      const v = s.rps?.[i];
      if (v === null || v === undefined) continue;
      any = true;
      r += v;
      e += v * (s.errorRate?.[i] ?? 0);
      p = Math.max(p, s.p99Ms?.[i] ?? 0);
    }
    rps.push(any ? r : null);
    err.push(any && r > 0 ? e / r : any ? 0 : null);
    p99.push(any ? p : null);
    if (d.bill) {
      let c = 0;
      let has = false;
      for (const comp of Object.values(d.bill.components)) {
        const v = comp.series?.[i];
        if (v !== null && v !== undefined) (c += v), (has = true);
      }
      const unattr = d.bill.unattributed / Math.max(1, (d.bill.end - d.bill.start) / d.stepS);
      cost.push(has ? ((c + unattr) * 3600) / d.stepS : null);
    } else cost.push(null);
  }
  return { rps, errorRate: err, p99Ms: p99, costPerHour: cost };
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
      const verdict =
        ds <= 0.5 && dm < 0 ? `saves $${Math.round(-dm).toLocaleString()}/month with no more time out of SLO` : ds < -0.5 && dm <= 0 ? 'cheaper and more reliable' : ds < -0.5 ? `$${Math.round(dm).toLocaleString()}/month buys ${Math.round(-ds)} fewer minutes out of SLO` : ds > 0.5 && dm < 0 ? `saves $${Math.round(-dm).toLocaleString()}/month but adds ${Math.round(ds)} minutes out of SLO` : ds > 0.5 ? 'worse on both' : `costs $${Math.round(dm).toLocaleString()}/month more for the same reliability`;
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
  const draws = Math.max(1, opts.draws ?? 30);
  let traffic = opts.traffic ?? trafficOf(d, model);
  let load: BacktestResult['load'];
  if (opts.load && (opts.load.scale !== undefined || opts.load.peakRps !== undefined) && !(opts.load.scale === 1 && opts.load.peakRps === undefined)) {
    const scaled = scaleTraffic(traffic, opts.load);
    traffic = scaled.traffic;
    load = { factor: scaled.factor, peakRps: scaled.peakRps };
  }
  const base = basePlan(model, opts.observed === false ? undefined : observedReplicas(d, model));
  const parsed = strategies.map((s) => StrategySpec.parse(s));
  const applied = parsed.map((s) => ({ spec: s, ...applyStrategy(model, base, s) }));
  const slo = model.slo;

  const runAll = (plan: Plan) => {
    const rnd = rng(opts.seed ?? 7);
    const runs: RunResult[] = [];
    for (let k = 0; k < draws; k++) runs.push(runPlan(drawPlan(plan, model, k, rnd), traffic, { faults: opts.faults }));
    return runs;
  };
  const baseRuns = runAll(base);
  const baseSums = baseRuns.map((r) => summarise(r, slo, traffic.stepS));

  const pack = (name: string, description: string | undefined, notes: string[], plan: Plan, runs: RunResult[]): StrategyResult => {
    const sums = runs.map((r) => summarise(r, slo, traffic.stepS));
    const point = runs[0];
    const worstI = point.p99Ms.reduce((b, v, i) => (v + point.errorRate[i] * 1e5 > point.p99Ms[b] + point.errorRate[b] * 1e5 ? i : b), 0);
    const why = explainMoment(point, plan, worstI);
    const budget = (r: RunResult) => {
      let failed = 0;
      let req = 0;
      return r.t.map((_, i) => {
        failed += r.rps[i] * r.errorRate[i] * traffic.stepS;
        req += r.rps[i] * traffic.stepS;
        return req > 0 ? failed / (req * slo.errorRate) : 0;
      });
    };
    const keys = Object.keys(sums[0]) as (keyof Summary)[];
    const endpoints: StrategyResult['endpoints'] = {};
    for (const [id, e] of Object.entries(point.endpoints)) {
      const sl = plan.endpoints[id]?.slo ?? slo;
      let requests = 0;
      let failed = 0;
      let out = 0;
      let cost = 0;
      for (let i = 0; i < e.rps.length; i++) {
        requests += e.rps[i] * traffic.stepS;
        failed += e.rps[i] * e.errorRate[i] * traffic.stepS;
        cost += e.cost[i];
        if (e.rps[i] > 0 && (e.p99Ms[i] > sl.p99Ms || e.errorRate[i] > sl.errorRate)) out += traffic.stepS / 60;
      }
      endpoints[id] = { requests, failedRequests: failed, minutesOutOfSlo: out, peakP99Ms: Math.max(0, ...e.p99Ms), cost, costPerMillion: requests > 0 ? (cost / requests) * 1e6 : 0, slo: sl };
    }
    return {
      name,
      description,
      notes,
      series: {
        p99Ms: band(runs.map((r) => r.p99Ms)),
        errorRate: band(runs.map((r) => r.errorRate)),
        costPerHour: band(runs.map((r) => r.costPerHour)),
        cumulativeCost: band(runs.map((r) => cumulative(r.t.map((_, i) => r.cost.compute[i] + r.cost.requests[i] + r.cost.transfer[i] + r.cost.other[i])))),
        errorBudget: band(runs.map(budget)),
        replicas: Object.fromEntries(Object.entries(point.services).filter(([id]) => !plan.services[id].hostedBy).map(([id, s]) => [id, s.replicas])),
      },
      ...(point.cluster && plan.cluster
        ? {
            cluster: {
              peakNodes: Math.max(...point.cluster.nodes),
              meanNodes: point.cluster.nodes.reduce((a, x) => a + x, 0) / Math.max(1, point.cluster.nodes.length),
              autoscaled: plan.cluster.autoscaled,
              peakRequestedCpu: Math.max(...point.cluster.requestedCpu),
              peakRequestedMemoryGb: Math.max(...point.cluster.requestedMemoryGb),
              nodeCpu: plan.cluster.node.cpu,
              nodeMemoryGb: plan.cluster.node.memoryGb,
              nodeHour: plan.cluster.node.perHour,
            },
          }
        : {}),
      summary: Object.fromEntries(keys.map((k) => [k, rangeOf(sums.map((s) => s[k]))])) as Record<keyof Summary, Ranged>,
      delta: {
        cost: rangeOf(sums.map((s, k) => s.cost - baseSums[k].cost)),
        monthly: rangeOf(sums.map((s, k) => s.monthly - baseSums[k].monthly)),
        minutesOutOfSlo: rangeOf(sums.map((s, k) => s.minutesOutOfSlo - baseSums[k].minutesOutOfSlo)),
        failedRequests: rangeOf(sums.map((s, k) => s.failedRequests - baseSums[k].failedRequests)),
      },
      worst: { t: point.t[worstI], p99Ms: point.p99Ms[worstI], errorRate: point.errorRate[worstI], ...why },
      endpoints,
      incidents: incidents(point, plan, slo, traffic.stepS),
      events: point.events,
      peakUtil: Object.fromEntries(Object.entries(point.services).map(([id, sv]) => [id, Math.max(0, ...sv.util.filter((u) => isFinite(u)))])),
    };
  };

  const baseline = pack('As built', 'the calibrated model with nothing changed', [], base, baseRuns);
  const results = applied.map((a) => pack(a.spec.name, a.spec.description, a.notes, a.plan, runAll(a.plan)));
  const ranking = rankStrategies(results);

  return {
    model: model.name,
    window: { start: traffic.start, end: traffic.start + traffic.n * traffic.stepS, stepS: traffic.stepS, n: traffic.n },
    slo,
    t: baseRuns[0].t,
    actual: measured(d, model),
    baseline,
    strategies: results,
    ranking,
    accuracy: model.accuracy,
    draws,
    ...(load ? { load } : {}),
    peakRps: scaleTraffic(traffic, { scale: 1 }).peakRps,
  };
}
