import { meanOf, quantile, type Dataset, type EndpointSeries, type Num } from './dataset';
import { AWS_TRANSFER, type Capacity, type EndpointModel, type FitStatus, type Model, type ServiceModel } from './model';
import { basePlan, runPlan, type Traffic } from './engine';
import { mmcWait } from './queueing';

/**
 * Fit a model to a dataset.
 *
 *  - topology and per-request work from traces (visits, critical path, payloads)
 *  - per service: CPU per request (regression), capacity per replica — CPU-bound, concurrency-bound
 *    (M/M/c fitted to self time vs load, replaying the history through the queue so overload
 *    transients are fitted too) or unbounded — with bootstrap bands
 *  - per endpoint: network/proxy overhead, latency tail, baseline errors
 *  - cost from the bill: $ per replica-hour, per request, per GB
 *  - fit quality per component; anything the model cannot explain is flagged
 */

export interface CalibrateOptions {
  slo?: { p99Ms: number; errorRate: number };
  /** client deadline, ms (default 5000) */
  timeoutMs?: number;
  /** in-process dependencies: service → host service */
  hostedBy?: Record<string, string>;
  /** bootstrap draws for capacity bands (default 40) */
  bootstrap?: number;
  /** per-service overrides */
  services?: Record<string, { kind?: ServiceModel['kind']; servers?: number; perReplicaRps?: number; arch?: 'x86' | 'arm' }>;
  endpoints?: Record<string, { slo?: { p99Ms: number; errorRate: number } }>;
  seed?: number;
}

const SERVER_GRID = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 128, 256];

const vals = (a: Num[] | undefined, i: number) => (a && a[i] !== null && a[i] !== undefined && isFinite(a[i] as number) ? (a[i] as number) : null);
const median = (xs: number[]) => (xs.length ? quantile([...xs].sort((a, b) => a - b), 0.5) : NaN);

function mape(pred: number[], obs: (number | null)[], floor = 1): number | undefined {
  let s = 0;
  let k = 0;
  for (let i = 0; i < obs.length; i++) {
    const o = obs[i];
    if (o === null || !isFinite(pred[i])) continue;
    s += Math.abs(pred[i] - o) / Math.max(floor, Math.abs(o));
    k++;
  }
  return k ? s / k : undefined;
}

function status(m: number | undefined): FitStatus {
  if (m === undefined) return 'unexplained';
  return m < 0.15 ? 'good' : m < 0.3 ? 'fair' : m < 0.6 ? 'poor' : 'unexplained';
}

/** mulberry32 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** replay per-replica load through one queue; predicted self mean and p99 per bucket */
export function replayQueue(perRep: number[], stepS: number, c: number, K: number, S: number, S99: number, tail: number, v = 1) {
  const sub = Math.max(1, Math.ceil(stepS / 5));
  const dt = stepS / sub;
  let backlog = 0;
  const mean: number[] = [];
  const p99: number[] = [];
  for (const lam of perRep) {
    let m = 0;
    let p = 0;
    for (let k = 0; k < sub; k++) {
      let wm = 0;
      let wp = 0;
      if (isFinite(K)) {
        const served = Math.min(K, lam + backlog / dt);
        backlog = Math.max(0, backlog + (lam - served) * dt);
        const w = mmcWait(Math.min(lam, K * 0.97), c, K);
        wm = v * w.meanMs + (backlog / K) * 1000;
        wp = v * w.p99Ms + (backlog / K) * 1000;
      }
      m += (S + wm) / sub;
      p += (S + wm + Math.sqrt((S99 - S) ** 2 + (tail * (wp - wm)) ** 2)) / sub;
    }
    mean.push(m);
    p99.push(p);
  }
  return { mean, p99 };
}

function logErr(pred: number[], obs: (number | null)[], w?: number[]) {
  let s = 0;
  let k = 0;
  for (let i = 0; i < obs.length; i++) {
    const o = obs[i];
    if (o === null || o <= 0) continue;
    const p = Math.max(1e-3, Math.min(pred[i], 1e7));
    const wi = w ? w[i] : 1;
    s += wi * Math.log(p / o) ** 2;
    k += wi;
  }
  return k ? s / k : Infinity;
}

interface Fitted {
  c: number;
  K: number;
  /** service time used with this fit (the tied model fits it; others use the low-load self time) */
  S: number;
  /** service-time variability: waits are v × the M/M/c wait (Allen–Cunneen, Poisson arrivals: v = (1 + cs²) / 2) */
  v: number;
  err: number;
}

/** v = (1 + cs²)/2: 0.5 deterministic service times, 1 exponential, > 1 heavy-tailed */
const VARIABILITY = [0.3, 0.4, 0.5, 0.65, 0.8, 1, 1.3, 1.7];

/** any number of servers, any capacity (CPU pools, async runtimes…) */
function fitFree(perRep: number[], obs: (number | null)[], stepS: number, S: number, S99: number, maxLam: number, servers?: number[]): Fitted {
  let best: Fitted = { c: 1, K: Infinity, S, v: 1, err: Infinity };
  // overloaded histories run above capacity: search from well below the peak
  const lo = Math.max(1e-3, maxLam * 0.3);
  for (const c of servers ?? SERVER_GRID) {
    for (let j = 0; j <= 48; j++) {
      const K = lo * 200 ** (j / 48);
      for (const v of VARIABILITY) {
        const err = logErr(replayQueue(perRep, stepS, c, K, S, S99, 1, v).mean, obs);
        if (err < best.err - 1e-12) best = { c, K, S, v, err };
      }
    }
  }
  // refine K around the best
  for (let j = -10; j <= 10; j++) {
    const K = best.K * 1.06 ** (j / 2);
    const err = logErr(replayQueue(perRep, stepS, best.c, K, S, S99, 1, best.v).mean, obs);
    if (err < best.err) best = { ...best, K, err };
  }
  return best;
}

/**
 * A lock, a connection pool or a worker pool: c holders, each held for the service time s, so
 * capacity is c / s. The service time is fitted too — the self time measured at low load already
 * contains some waiting.
 */
function fitTied(perRep: number[], obs: (number | null)[], stepS: number, S: number, S99: number, servers?: number[]): Fitted {
  let best: Fitted = { c: 1, K: Infinity, S, v: 1, err: Infinity };
  if (S <= 0.05) return best;
  for (const c of servers ?? SERVER_GRID) {
    for (let j = 0; j <= 14; j++) {
      const s = S * (0.45 + 0.04 * j);
      const K = (c * 1000) / s;
      for (const v of VARIABILITY) {
        const err = logErr(replayQueue(perRep, stepS, c, K, s, S99 - (S - s), 1, v).mean, obs);
        if (err < best.err - 1e-12) best = { c, K, S: s, v, err };
      }
    }
  }
  return best;
}

function regress(x: number[], y: number[]) {
  const n = x.length;
  if (n < 3) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  if (sxx <= 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (y[i] - intercept - slope * x[i]) ** 2;
  const se = n > 2 ? Math.sqrt(sse / (n - 2) / sxx) : Infinity;
  return { slope, intercept, r2, se };
}

/** endpoint ids from different sources ("frontend GET /dispatch" vs "frontend HTTP GET /dispatch") */
export function sameEndpoint(a: string, b: string) {
  const norm = (s: string) => s.toLowerCase().replace(/\bhttp\b/g, '').replace(/\s+/g, ' ').trim();
  if (norm(a) === norm(b)) return true;
  const pa = norm(a).split(' ');
  const pb = norm(b).split(' ');
  return pa[0] === pb[0] && pa[pa.length - 1] === pb[pb.length - 1];
}

export function calibrate(d: Dataset, options: CalibrateOptions = {}): Model {
  const opts: CalibrateOptions = { ...d.hints, ...options, hostedBy: { ...d.hints?.hostedBy, ...options.hostedBy }, services: { ...d.hints?.services, ...options.services }, endpoints: { ...d.hints?.endpoints, ...options.endpoints } };
  const slo = opts.slo ?? { p99Ms: 500, errorRate: 0.01 };
  const timeoutMs = opts.timeoutMs ?? 5000;
  const hostedBy = opts.hostedBy ?? {};
  const topo = d.topology;
  const rand = rng(opts.seed ?? 1);
  const B = opts.bootstrap ?? 40;
  const ids = new Set([...Object.keys(topo?.services ?? {}), ...Object.keys(d.services), ...Object.keys(d.bill?.components ?? {})]);

  const replicasOf = (id: string): Num[] => {
    const host = hostedBy[id];
    if (host && d.services[host]?.replicas) return d.services[host].replicas!;
    return d.services[id]?.replicas ?? new Array(d.n).fill(1);
  };

  const services: Record<string, ServiceModel> = {};
  for (const id of ids) {
    const s = d.services[id] ?? {};
    const shape = topo?.services[id];
    const notes: string[] = [];
    const reps = replicasOf(id);
    const repVals = reps.filter((x): x is number => x !== null && x > 0);
    const replicas = repVals.length ? Math.round(median(repVals)) : 1;
    const limitVals = (d.services[hostedBy[id] ?? id]?.cpuLimitCores ?? []).filter((x): x is number => x !== null && x > 0);
    const cpuLimit = limitVals.length ? median(limitVals) : null;
    const memVals = (d.services[hostedBy[id] ?? id]?.memoryBytes ?? []).filter((x): x is number => x !== null && x > 0);

    const lam: (number | null)[] = Array.from({ length: d.n }, (_, i) => vals(s.rps, i));
    const perRep = lam.map((l, i) => (l === null ? 0 : l / Math.max(1, vals(reps, i) ?? replicas)));
    const selfObs = Array.from({ length: d.n }, (_, i) => vals(s.selfMeanMs, i) ?? (shape ? null : vals(s.meanMs, i)));
    const selfP99Obs = Array.from({ length: d.n }, (_, i) => vals(s.selfP99Ms, i) ?? (shape ? null : vals(s.p99Ms, i)));

    // CPU per request (per replica)
    let cpu: ServiceModel['cpu'] = null;
    let cpuSe = Infinity;
    if (s.cpuCores && !hostedBy[id]) {
      const xs: number[] = [];
      const ys: number[] = [];
      for (let i = 0; i < d.n; i++) {
        const c = vals(s.cpuCores, i);
        const r = vals(reps, i) ?? replicas;
        if (c === null || lam[i] === null || r <= 0) continue;
        xs.push((lam[i] as number) / r);
        ys.push(c / r);
      }
      const fit = regress(xs, ys);
      if (fit) {
        cpu = { base: Math.max(0, fit.intercept), perReq: Math.max(0, fit.slope), r2: fit.r2 };
        cpuSe = fit.se;
        if (fit.r2 < 0.3 && xs.length > 10) notes.push(`CPU barely follows load (R² ${fit.r2.toFixed(2)}) — capacity is not CPU-bound or CPU data is noisy`);
      }
    }

    // low-load self time
    const withData = lam.map((l, i) => ({ i, l: perRep[i], ok: l !== null && selfObs[i] !== null })).filter((x) => x.ok);
    const sortedByLoad = [...withData].sort((a, b) => a.l - b.l);
    const low = sortedByLoad.slice(0, Math.max(3, Math.floor(sortedByLoad.length * 0.3)));
    const S = low.length ? median(low.map((x) => selfObs[x.i] as number)) : shape?.selfMeanMs ?? 0;
    const lowP99 = low.map((x) => selfP99Obs[x.i]).filter((x): x is number => x !== null);
    const S99 = lowP99.length ? median(lowP99) : shape?.selfP99Ms ?? S * 2;
    const maxLam = Math.max(0, ...perRep);

    // capacity: none / CPU / concurrency — replay the history through each and keep what explains it
    let capacity: Capacity = { limit: 'none', servers: 1, perReplicaRps: Infinity };
    let tail = 1;
    let variability = 1;
    let selfMean = S;
    let selfP99 = S99;
    let latencyMape: number | undefined;
    let p99Mape: number | undefined;
    const ov = opts.services?.[id];
    if (withData.length >= 5) {
      const none = logErr(replayQueue(perRep, d.stepS, 1, Infinity, S, S99, 1).mean, selfObs);
      const cpuK = cpu && cpuLimit && cpu.perReq > 0 ? (cpuLimit - cpu.base) / cpu.perReq : Infinity;
      const cpuC = cpuLimit ? Math.max(1, Math.round(cpuLimit)) : 1;
      let cpuFit: Fitted = { c: cpuC, K: cpuK, S, v: 1, err: Infinity };
      if (isFinite(cpuK)) for (const v of VARIABILITY) {
        const err = logErr(replayQueue(perRep, d.stepS, cpuC, cpuK, S, S99, 1, v).mean, selfObs);
        if (err < cpuFit.err) cpuFit = { c: cpuC, K: cpuK, S, v, err };
      }
      const servers = ov?.servers ? [ov.servers] : undefined;
      const free = fitFree(perRep, selfObs, d.stepS, S, S99, maxLam, servers);
      const tied = fitTied(perRep, selfObs, d.stepS, S, S99, servers);
      // the tied model is physically grounded; the free one has to be clearly better to win
      const queue = tied.err <= free.err / 0.85 ? { ...tied, tied: true } : { ...free, tied: false };
      const simple = Math.min(none, cpuFit.err);
      let chosen: Fitted | null = null;
      if (ov?.perReplicaRps) capacity = { limit: 'concurrency', servers: ov.servers ?? 1, perReplicaRps: ov.perReplicaRps };
      else if (queue.err < simple * 0.85 && isFinite(queue.K) && queue.K < maxLam * 40) {
        const limitedByCpu = isFinite(cpuK) && Math.abs(queue.K - cpuK) / cpuK < 0.25;
        capacity = { limit: limitedByCpu ? 'cpu' : 'concurrency', servers: queue.c, perReplicaRps: queue.K };
        chosen = queue;
        if (queue.tied) notes.push(`${queue.c} at a time, each holding it ${queue.S.toFixed(queue.S < 10 ? 1 : 0)} ms (a lock or pool)`);
      } else if (isFinite(cpuFit.err) && cpuFit.err <= none * 1.1) {
        capacity = { limit: 'cpu', servers: cpuC, perReplicaRps: cpuK };
        chosen = cpuFit;
      } else if (isFinite(cpuK)) {
        // load never came close: the CPU limit is the only limit we know of
        capacity = { limit: 'cpu', servers: cpuC, perReplicaRps: cpuK };
        chosen = cpuFit;
        notes.push('load never approached capacity; the CPU limit is extrapolated');
      }
      if (chosen) {
        variability = isFinite(chosen.err) ? chosen.v : 1;
        selfMean = chosen.S;
        selfP99 = Math.max(chosen.S, S99 - (S - chosen.S));
      }
      const tiedK = chosen && 'tied' in chosen && (chosen as Fitted & { tied: boolean }).tied;

      const cpuOnly = capacity.limit === 'cpu' && chosen === cpuFit && cpu && cpuLimit && isFinite(cpuSe);
      if (cpuOnly && B > 0) {
        // the latency history says little about a limit it never reached: the band comes from how
        // well CPU per request is known (slope ± its standard error)
        const draws: number[] = [];
        for (let b = 0; b < B; b++) {
          const z = Math.sqrt(-2 * Math.log(Math.max(1e-12, rand()))) * Math.cos(2 * Math.PI * rand());
          const slope = Math.max(cpu!.perReq * 0.2, cpu!.perReq + z * cpuSe);
          draws.push((cpuLimit! - cpu!.base) / slope);
        }
        draws.sort((a, b) => a - b);
        capacity.band = [quantile(draws, 0.1), quantile(draws, 0.9)];
        capacity.samples = draws;
      } else if (isFinite(capacity.perReplicaRps) && B > 0 && !ov?.perReplicaRps) {
        // bootstrap the capacity (blocks of 6 buckets), server count and variability fixed
        const draws: number[] = [];
        const blocks = Math.ceil(d.n / 6);
        for (let b = 0; b < B; b++) {
          const w = new Array(d.n).fill(0);
          for (let k = 0; k < blocks; k++) {
            const start = Math.floor(rand() * blocks) * 6;
            for (let j = start; j < Math.min(d.n, start + 6); j++) w[j] += 1;
          }
          let bestK = capacity.perReplicaRps;
          let bestE = Infinity;
          // servers and variability are refitted too: with little load near the limit they trade
          // off against capacity, and the band has to show that
          const cs = tiedK ? [...new Set([Math.max(1, capacity.servers - 1), capacity.servers, capacity.servers + 1])] : [capacity.servers];
          for (const c of cs)
            for (const v of VARIABILITY)
              for (let j = -12; j <= 12; j++) {
                const K = capacity.perReplicaRps * 1.04 ** j * (tiedK ? c / capacity.servers : 1);
                // for a lock, more capacity means a shorter hold time
                const sv = tiedK ? (c * 1000) / K : selfMean;
                if (tiedK && (sv < S * 0.4 || sv > S * 1.05)) continue;
                const e = logErr(replayQueue(perRep, d.stepS, c, K, sv, selfP99 + (sv - selfMean), 1, v).mean, selfObs, w);
                if (e < bestE) [bestE, bestK] = [e, K];
              }
          draws.push(bestK);
        }
        draws.sort((a, b) => a - b);
        capacity.band = [quantile(draws, 0.1), quantile(draws, 0.9)];
        capacity.samples = draws;
      }

      // tail multiplier on queueing excess
      let bestTail = { t: 1, e: Infinity };
      for (const t of [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 5, 6]) {
        const e = logErr(replayQueue(perRep, d.stepS, capacity.servers, capacity.perReplicaRps, selfMean, selfP99, t, variability).p99, selfP99Obs);
        if (e < bestTail.e) bestTail = { t, e };
      }
      tail = bestTail.t;
      const r = replayQueue(perRep, d.stepS, capacity.servers, capacity.perReplicaRps, selfMean, selfP99, tail, variability);
      // errors below a few ms don't matter to anyone's p99: floor the denominator
      latencyMape = mape(r.mean, selfObs, 5);
      p99Mape = mape(r.p99, selfP99Obs, 5);
    } else if (shape) notes.push('too little load data to fit capacity; using trace averages');

    let cpuMape: number | undefined;
    if (cpu && s.cpuCores) {
      const pred = lam.map((l, i) => (l === null ? NaN : (vals(reps, i) ?? replicas) * cpu!.base + cpu!.perReq * l));
      cpuMape = mape(pred, s.cpuCores.map((x) => x), 0.01);
    }

    const kind: ServiceModel['kind'] = ov?.kind ?? (shape ? (shape.kind === 'client' ? 'server' : shape.kind) : 'lb');
    const fitNotes = [...notes];
    let st: FitStatus;
    if (!shape && !s.rps) {
      st = 'cost-only';
      fitNotes.push('not seen in traces or request metrics — modelled for cost only');
    } else {
      st = status(latencyMape);
      if (latencyMape === undefined) fitNotes.push('no per-bucket latency to check the model against');
      else fitNotes.push(`replaying the history reproduces its self time within ${(latencyMape * 100).toFixed(0)}% (mean abs. error)`);
    }
    services[id] = {
      id,
      kind,
      ...(shape?.system ? { system: shape.system } : {}),
      ...(hostedBy[id] ? { hostedBy: hostedBy[id] } : {}),
      replicas,
      cpuLimit,
      memoryGb: memVals.length ? median(memVals) / 2 ** 30 : null,
      cpu,
      capacity,
      self: { mean: selfMean, p99: Math.max(selfMean, selfP99) },
      tail,
      variability,
      cost: { perReplicaHour: 0, perRequest: 0, cpuShare: 0.8, arch: opts.services?.[id]?.arch ?? 'x86', source: 'none' },
      ...(d.placement?.[hostedBy[id] ?? id] ? { placement: d.placement[hostedBy[id] ?? id] } : {}),
      fit: { status: st, latencyMape, p99Mape, cpuMape, cpuR2: cpu?.r2, samples: withData.length, notes: fitNotes },
    };
  }

  // ---- cost from the bill ----
  let fixedPerHour = 0;
  const billHours = d.bill ? Math.max(1 / 60, (d.bill.end - d.bill.start) / 3600) : 0;
  if (d.bill) {
    fixedPerHour += d.bill.unattributed / billHours;
    for (const [cid, c] of Object.entries(d.bill.components)) {
      const sm = services[cid];
      if (!sm) continue;
      // replica-hours actually run inside the bill window
      const reps = replicasOf(cid);
      let repHours = 0;
      for (let i = 0; i < d.n; i++) {
        const t = d.start + i * d.stepS;
        if (t < d.bill.start || t >= d.bill.end) continue;
        repHours += ((vals(reps, i) ?? sm.replicas) * d.stepS) / 3600;
      }
      const compute = c.byCategory.compute ?? 0;
      sm.cost.perReplicaHour = repHours > 0 ? compute / repHours : 0;
      const reqs = (meanOf(d.services[cid]?.rps) ?? 0) * billHours * 3600;
      sm.cost.perRequest = reqs > 0 ? (c.byCategory.requests ?? 0) / reqs : 0;
      fixedPerHour += ((c.byCategory.storage ?? 0) + (c.byCategory.other ?? 0) + (reqs > 0 ? 0 : c.byCategory.requests ?? 0)) / billHours;
      sm.cost.source = 'bill';
    }
  }

  // ---- endpoints ----
  const endpoints: Record<string, EndpointModel> = {};
  const series = d.endpoints;
  const shapes = topo?.endpoints ?? {};
  const topoIds = Object.keys(shapes);
  const seriesIds = Object.keys(series).length ? Object.keys(series) : topoIds;
  const totalRps = seriesIds.reduce((s, id) => s + (meanOf(series[id]?.rps) ?? 0), 0);
  for (const id of seriesIds) {
    const sid = topoIds.find((t) => t === id) ?? topoIds.find((t) => sameEndpoint(t, id));
    const shape = sid ? shapes[sid] : undefined;
    const ser: EndpointSeries | undefined = series[id];
    const notes: string[] = [];
    if (!shape) notes.push('no traces for this endpoint — its path through the system is unknown');
    const weights: Record<string, number> = {};
    if (shape)
      for (const [svc, ms] of Object.entries(shape.criticalMs)) {
        const m = topo!.services[svc]?.selfMeanMs ?? 0;
        if (m > 0.01) weights[svc] = ms / m;
      }
    // low-traffic buckets → overhead and baseline excess
    const rps = ser?.rps ?? [];
    const idx = rps.map((v, i) => ({ v: v ?? 0, i })).filter((x) => x.v > 0).sort((a, b) => a.v - b.v);
    const lowIdx = idx.slice(0, Math.max(3, Math.floor(idx.length * 0.3))).map((x) => x.i);
    const lowMean = median(lowIdx.map((i) => vals(ser?.meanMs, i)).filter((x): x is number => x !== null));
    const lowP99 = median(lowIdx.map((i) => vals(ser?.p99Ms, i)).filter((x): x is number => x !== null));
    const pathMean = Object.entries(weights).reduce((a, [svc, w]) => a + w * (services[svc]?.self.mean ?? 0), 0);
    const measuredMean = isFinite(lowMean) ? lowMean : shape?.meanMs ?? pathMean;
    const measuredP99 = isFinite(lowP99) ? lowP99 : shape?.p99Ms ?? measuredMean * 1.5;
    // baseline errors: request-weighted over the low-traffic buckets (a median would read 0 for rare errors)
    let errN = 0;
    let errF = 0;
    for (const i of lowIdx) {
      const e = vals(ser?.errorRate, i);
      const n = vals(ser?.rps, i);
      if (e === null || n === null) continue;
      errN += n;
      errF += n * e;
    }
    const errs = errN > 0 ? [errF / errN] : [];
    const e: EndpointModel = {
      id,
      service: shape?.service ?? ser?.service ?? id.split(' ')[0],
      share: totalRps > 0 ? (meanOf(ser?.rps) ?? 0) / totalRps : 1 / seriesIds.length,
      visits: shape?.visits ?? { [ser?.service ?? id.split(' ')[0]]: 1 },
      calls: shape?.calls ?? {},
      weights: shape ? weights : { [ser?.service ?? id.split(' ')[0]]: 1 },
      overheadMs: Math.max(0, measuredMean - pathMean),
      baseExcessMs: Math.max(0, measuredP99 - measuredMean),
      tail: 1,
      errorRate: errs.length ? Math.min(0.5, errs[0]) : shape?.errorRate ?? 0,
      bytes: shape?.bytes ?? {},
      egressBytes: 0,
      slo: opts.endpoints?.[id]?.slo ?? slo,
      fit: { status: shape ? 'good' : 'poor', samples: rps.filter((x) => x !== null).length, notes },
    };
    endpoints[id] = e;
  }

  // egress bytes per request: from the bill's transfer line when there is one
  if (d.bill) {
    const transfer = Object.values(d.bill.components).reduce((a, c) => a + (c.byCategory.transfer ?? 0), 0);
    const reqs = totalRps * billHours * 3600;
    if (transfer > 0 && reqs > 0) for (const e of Object.values(endpoints)) e.egressBytes = ((transfer / AWS_TRANSFER.internetGb) * 2 ** 30) / reqs;
  }

  const model: Model = {
    version: 1,
    name: d.name,
    timeoutMs,
    slo,
    services,
    endpoints,
    transfer: AWS_TRANSFER,
    unattributedPerHour: fixedPerHour,
    accuracy: [],
    fittedOn: { start: d.start, end: d.start + d.n * d.stepS, stepS: d.stepS, buckets: d.n },
  };

  // ---- endpoint tail + fit quality: replay the whole history through the full model ----
  const traffic = trafficOf(d, model);
  const totals = Array.from({ length: d.n }, (_, i) => Object.values(traffic.endpoints).reduce((a, s) => a + (s[i] ?? 0), 0)).filter((x) => x > 0).sort((a, b) => a - b);
  if (totals.length) model.traffic = { mean: totals.reduce((a, x) => a + x, 0) / totals.length, p90: quantile(totals, 0.9), peak: totals[totals.length - 1] };
  const observed = Object.fromEntries(Object.keys(services).map((id) => [id, replicasOf(id)]));
  if (Object.values(traffic.endpoints).length) {
    for (const [id, e] of Object.entries(endpoints)) {
      const obs = series[id]?.p99Ms;
      if (!obs) continue;
      let best = { t: 1, err: Infinity };
      for (const t of [0.5, 0.7, 0.85, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 5, 6]) {
        e.tail = t;
        const r = runPlan(basePlan(model, observed), traffic);
        const err = logErr(r.endpoints[id].p99Ms, obs.map((x) => x));
        if (err < best.err) best = { t, err };
      }
      e.tail = best.t;
    }
    const r = runPlan(basePlan(model, observed), traffic);
    for (const [id, e] of Object.entries(endpoints)) {
      const ser = series[id];
      if (!ser?.p99Ms) continue;
      const p99m = mape(r.endpoints[id].p99Ms, ser.p99Ms.map((x) => x));
      const meanm = ser.meanMs ? mape(r.endpoints[id].meanMs, ser.meanMs.map((x) => x)) : undefined;
      e.fit.p99Mape = p99m;
      e.fit.latencyMape = meanm;
      e.fit.status = e.fit.status === 'poor' ? 'poor' : status(p99m);
      e.fit.notes.push(`replaying the history reproduces its p99 within ${((p99m ?? 0) * 100).toFixed(0)}% (mean abs. error)`);
    }
  }
  return model;
}

/** endpoint traffic of a dataset, aligned to the model's endpoints */
export function trafficOf(d: Dataset, model: Model): Traffic {
  const endpoints: Record<string, Num[]> = {};
  for (const id of Object.keys(model.endpoints)) {
    const s = d.endpoints[id]?.rps;
    if (s) endpoints[id] = s;
  }
  if (!Object.keys(endpoints).length) {
    // no endpoint series: split the entry services' traffic by the model's shares
    for (const [id, e] of Object.entries(model.endpoints)) {
      const entry = d.services[e.service]?.rps;
      if (entry) endpoints[id] = entry.map((v) => (v === null ? null : v * e.share));
    }
  }
  return { start: d.start, stepS: d.stepS, n: d.n, endpoints };
}

export function observedReplicas(d: Dataset, model: Model): Record<string, Num[] | undefined> {
  return Object.fromEntries(Object.entries(model.services).map(([id, s]) => [id, d.services[s.hostedBy ?? id]?.replicas]));
}
