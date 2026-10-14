import { meanOf, quantile, type Dataset, type EndpointSeries, type Num } from './dataset';
import { AWS_TRANSFER, type Capacity, type ClusterModel, type EndpointModel, type FitStatus, type Model, type ServiceModel } from './model';
import { basePlan, cfsStallMs, runPlan, type Traffic } from './engine';
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
  /** price services the bill doesn't cover (or every service, without a bill) at on-demand list
   *  prices from their CPU and memory limits — AWS Fargate us-east-1 unless given */
  listPrices?: boolean | ListPrices;
}

export interface ListPrices {
  perVcpuHour: number;
  perGbHour: number;
  /** Arm (Graviton) prices */
  armPerVcpuHour: number;
  armPerGbHour: number;
  source: string;
}

export const FARGATE_PRICES: ListPrices = {
  perVcpuHour: 0.04048,
  perGbHour: 0.004445,
  armPerVcpuHour: 0.03238,
  armPerGbHour: 0.00356,
  source: 'AWS Fargate on-demand, us-east-1 (aws.amazon.com/fargate/pricing)',
};

const SERVER_GRID = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 128, 256];

const vals = (a: Num[] | undefined, i: number) => (a && a[i] !== null && a[i] !== undefined && isFinite(a[i] as number) ? (a[i] as number) : null);
/** EC2 on-demand, us-east-1, general purpose (m6i/m7i): $0.192/h for 4 vCPU + 16 GiB, split in
 *  Fargate's vCPU : GiB proportion. A node's price when nothing better is known */
export const NODE_PRICES = { perVcpuHour: 0.03334, perGbHour: 0.003664, source: 'EC2 m6i on-demand, us-east-1 ($0.192/h for 4 vCPU + 16 GiB), by allocatable size' };

function requestsOfService(s: Dataset['services'][string] | undefined): { cpu: number; memoryGb: number } | null {
  const cpu = (s?.cpuRequestCores ?? []).filter((x): x is number => x !== null && x > 0);
  const mem = (s?.memoryRequestBytes ?? []).filter((x): x is number => x !== null && x > 0);
  if (!cpu.length && !mem.length) return null;
  return { cpu: cpu.length ? median(cpu) : 0, memoryGb: mem.length ? median(mem) / 2 ** 30 : 0 };
}

/** the node pool, from kube-state-metrics: how big the nodes are, whether their count followed demand,
 *  how tightly requests filled them, and what everyone else's pods asked for */
function clusterOf(d: Dataset, services: Record<string, ServiceModel>, replicasOf: (id: string) => Num[]): ClusterModel | undefined {
  const c = d.cluster;
  const nodesV = (c?.clusterNodes ?? []).filter((x): x is number => x !== null && x > 0);
  const cpuV = (c?.clusterNodeCpu ?? []).filter((x): x is number => x !== null && x > 0);
  const memV = (c?.clusterNodeMemoryBytes ?? []).filter((x): x is number => x !== null && x > 0);
  if (!nodesV.length || !cpuV.length || !memV.length) return undefined;
  const node = { cpu: median(cpuV), memoryGb: median(memV) / 2 ** 30 };
  const hint = d.hints?.cluster;
  const perHour = hint?.nodePriceHour ?? node.cpu * NODE_PRICES.perVcpuHour + node.memoryGb * NODE_PRICES.perGbHour;
  const notes: string[] = [];
  // the modelled services' requests in each bucket, and what's left for everyone else
  const otherCpu: number[] = [];
  const otherMem: number[] = [];
  const packing: number[] = [];
  for (let i = 0; i < d.n; i++) {
    const n = c!.clusterNodes?.[i];
    const rc = c!.clusterRequestedCpu?.[i];
    const rm = c!.clusterRequestedMemoryBytes?.[i];
    if (n == null || rc == null || rm == null) continue;
    let sc = 0;
    let sm = 0;
    for (const [id, s] of Object.entries(services)) {
      if (!s.requests || s.hostedBy) continue;
      const r = replicasOf(id)[i] ?? s.replicas;
      sc += r * s.requests.cpu;
      sm += r * s.requests.memoryGb;
    }
    otherCpu.push(Math.max(0, rc - sc));
    otherMem.push(Math.max(0, rm / 2 ** 30 - sm));
    const ideal = Math.max(rc / node.cpu, rm / 2 ** 30 / node.memoryGb);
    if (ideal > 0) packing.push(n / ideal);
  }
  const nodes = Math.round(median(nodesV));
  const minNodes = Math.min(...nodesV);
  const maxNodes = Math.max(...nodesV);
  // a node replaced once (or a surge during a rollout) isn't autoscaling: the count has to have been
  // away from its typical value for a twentieth of the history
  const away = nodesV.filter((x) => Math.abs(x - median(nodesV)) >= 1).length;
  const autoscaled = hint?.autoscaled ?? (maxNodes > minNodes && away >= 0.05 * nodesV.length);
  const pk = packing.length ? Math.max(1, median(packing)) : 1;
  notes.push(`${nodes} node${nodes === 1 ? '' : 's'} of ${+node.cpu.toFixed(2)} cores + ${node.memoryGb.toFixed(1)} GiB allocatable, $${perHour.toFixed(3)}/node-hour (${hint?.nodePriceHour ? 'given' : NODE_PRICES.source})`);
  notes.push(autoscaled ? `the node count followed demand (${minNodes}–${maxNodes}): requests that need fewer nodes save money, at ${pk.toFixed(2)}× the nodes requests would fill exactly` : `a fixed pool: ${nodes} nodes the whole history. Smaller requests leave room on them but save nothing until the pool shrinks`);
  return { node: { ...node, perHour, source: hint?.nodePriceHour ? 'hint' : 'pricing' }, nodes, minNodes, maxNodes, autoscaled, packing: pk, ...(hint?.provisionS ? { provisionS: hint.provisionS } : {}), ...(d.nodeZones && Object.keys(d.nodeZones).length ? { zones: d.nodeZones } : {}), other: { cpu: otherCpu.length ? median(otherCpu) : 0, memoryGb: otherMem.length ? median(otherMem) : 0 }, notes };
}

/** share of CFS periods throttled at which a service stops keeping up under sustained load: the
 *  threshold of kube-prometheus's CPUThrottlingHigh alert. (The Kubernetes reference's single-threaded
 *  frontend read 44% at the top of a 60-second load-test step, but collapsed under hours of real traffic
 *  15–20% below that load — reference/k8s/README.md) */
const THROTTLE_COLLAPSE = 0.25;
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
  const idleP99 = S + Math.abs(S99 - S);
  for (const lam of perRep) {
    // nothing arriving and nothing queued: the bucket is just the service time (most of a quiet history)
    if (lam <= 0 && backlog <= 0) {
      mean.push(S);
      p99.push(idleP99);
      continue;
    }
    let m = 0;
    let p = 0;
    // the arrival rate is constant within a bucket, so its M/M/c wait is too
    const w = isFinite(K) ? mmcWait(Math.min(lam, K * 0.97), c, K) : null;
    for (let k = 0; k < sub; k++) {
      let wm = 0;
      let wp = 0;
      if (w) {
        const served = Math.min(K, lam + backlog / dt);
        backlog = Math.max(0, backlog + (lam - served) * dt);
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

/** above this many buckets the capacity fits run on a compact copy of the history */
const COMPACT_ABOVE = 1000;

/**
 * A long history, compacted for fitting: the busy episodes (≥ 70% of the service's peak load, or
 * its own time ≥ 2× the quiet one, with the 3 buckets before and 15 after, where a backlog drains),
 * busiest first up to ~750 buckets, and an even sample of 250 of everything else. The limit shows near
 * the peaks; the rest pins the everyday service time. Replaying two weeks of 1-minute buckets
 * 18,000 times is what made long histories slow. Short histories are used whole.
 */
export function compactFit(lam: number[], obs: (number | null)[], p99: (number | null)[], maxLam: number, S: number) {
  const n = lam.length;
  if (n <= COMPACT_ABOVE) return { lam, obs, p99 };
  const near = new Uint8Array(n);
  for (let i = 0; i < n; i++)
    if (lam[i] >= maxLam * 0.7 || (obs[i] ?? 0) >= 2 * S) for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 15); j++) near[j] = 1;
  // busy episodes, the busiest first, until ~750 buckets: a fortnight of similar afternoons
  // repeats what one of them says
  const episodes: { a: number; b: number; peak: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (!near[i]) continue;
    const a = i;
    let peak = 0;
    while (i < n && near[i]) peak = Math.max(peak, lam[i], (obs[i] ?? 0) / Math.max(1e-9, S)), i++;
    episodes.push({ a, b: i, peak });
  }
  const keep = new Uint8Array(n);
  let kept = 0;
  for (const e of [...episodes].sort((x, y) => y.peak - x.peak)) {
    if (kept >= 750) break;
    for (let j = e.a; j < e.b; j++) keep[j] = 1;
    kept += e.b - e.a;
  }
  const every = Math.max(1, Math.ceil((n - kept) / 250));
  let q = 0;
  for (let i = 0; i < n; i++) if (!keep[i] && q++ % every === 0) keep[i] = 1;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) idx.push(i);
  return { lam: idx.map((i) => lam[i]), obs: idx.map((i) => obs[i]), p99: idx.map((i) => p99[i]) };
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

/** fit servers, service time and variability at a capacity that was seen directly */
function fitAtK(perRep: number[], obs: (number | null)[], stepS: number, S: number, S99: number, K: number): Fitted & { tied: boolean } {
  let best: Fitted & { tied: boolean } = { c: 1, K, S, v: 1, err: Infinity, tied: false };
  for (const c of SERVER_GRID) {
    for (const tied of [true, false]) {
      const s = tied ? (c * 1000) / K : S;
      if (tied && (s < S * 0.4 || s > S * 1.1)) continue;
      for (const v of VARIABILITY) {
        const err = logErr(replayQueue(perRep, stepS, c, K, s, S99 - (S - s), 1, v).mean, obs);
        // prefer the physical (tied) reading when it explains the data as well
        if (err < best.err * (tied ? 1.0001 : 0.97)) best = { c, K, S: s, v, err, tied };
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
  // path parameters are spelled {id}, [id] or :id depending on the framework; query strings and
  // trailing slashes don't name a different endpoint
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\bhttp\b/g, '')
      .replace(/\{[^}]*\}|\[[^\]]*\]|:[a-z_]\w*/g, '*')
      .replace(/\?\S*/g, '')
      .replace(/\/(\s|$)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  if (norm(a) === norm(b)) return true;
  const parse = (s: string) => {
    const t = norm(s).split(' ');
    return { svc: t[0], path: t[t.length - 1], method: t.find((x) => /^(get|post|put|patch|delete|head|options)$/.test(x)) };
  };
  const pa = parse(a);
  const pb = parse(b);
  return pa.svc === pb.svc && pa.path === pb.path && (!pa.method || !pb.method || pa.method === pb.method);
}

type Calibrator = (d: Dataset, options: CalibrateOptions) => Model;
/** the compiled calibration (engine-rs) once loaded */
let nativeCalibrate: Calibrator | null = null;
export function setNativeCalibrate(c: Calibrator | null) {
  nativeCalibrate = c;
}

export function calibrate(d: Dataset, options: CalibrateOptions = {}): Model {
  return nativeCalibrate ? nativeCalibrate(d, options) : calibrateTs(d, options);
}

/** calibration in TypeScript: the reference the Rust one is checked against */
export function calibrateTs(d: Dataset, options: CalibrateOptions = {}): Model {
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

  /** buckets where users were timing out: some endpoint failing ≥ 5% with p99 at the deadline — or,
   *  where endpoints carry no latency series (raw-URL span names), an entry service measured at the
   *  edge failing ≥ 3% with p99 at the deadline */
  const entryIds = [...new Set(Object.values(d.endpoints).map((e) => e.service))];
  const overloaded = Array.from(
    { length: d.n },
    (_, i) =>
      Object.values(d.endpoints).some((e) => (vals(e.errorRate, i) ?? 0) >= 0.05 && (vals(e.p99Ms, i) ?? 0) >= timeoutMs * 0.8) ||
      entryIds.some((id) => (vals(d.services[id]?.errorRate, i) ?? 0) >= 0.03 && (vals(d.services[id]?.p99Ms, i) ?? 0) >= timeoutMs * 0.8),
  );
  const services: Record<string, ServiceModel> = {};
  /** services whose queue sits outside their spans (CPU pinned, latency fit blind to it) */
  const hiddenQueue = new Set<string>();
  for (const id of ids) {
    const s = d.services[id] ?? {};
    const shape = topo?.services[id];
    const notes: string[] = [];
    const reps = replicasOf(id);
    const repVals = reps.filter((x): x is number => x !== null && x > 0);
    const replicas = repVals.length ? Math.round(median(repVals)) : 1;
    const limitVals = (d.services[hostedBy[id] ?? id]?.cpuLimitCores ?? []).filter((x): x is number => x !== null && x > 0);
    const cpuLimit = limitVals.length ? median(limitVals) : null;
    const host = d.services[hostedBy[id] ?? id];
    const GiB = 2 ** 30;
    const memLimits = (host?.memoryLimitBytes ?? []).filter((x): x is number => x !== null && x > 0);
    const memLimit = memLimits.length ? median(memLimits) / GiB : null;
    // used per replica: the largest container at its peak where collected, else the average replica
    const memUsed = Array.from({ length: d.n }, (_, i) => {
      const mx = vals(host?.memoryMaxBytes, i);
      if (mx !== null && mx > 0) return mx / GiB;
      const sum = vals(host?.memoryBytes, i);
      const r = vals(reps, i) ?? replicas;
      return sum !== null && sum > 0 && r > 0 ? sum / r / GiB : null;
    }).map((x) => (x !== null && x > 0 ? x : null));
    const memVals = memUsed.filter((x): x is number => x !== null);

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

    // memory against load: an OOM kill comes when one container's working set passes its limit
    let memory: ServiceModel['memory'];
    if (memVals.length >= 5 && !hostedBy[id]) {
      const xs: number[] = [];
      const ys: number[] = [];
      for (let i = 0; i < d.n; i++) {
        const y = memUsed[i];
        if (y === null || lam[i] === null) continue;
        xs.push(perRep[i]);
        ys.push(y);
      }
      const fit = xs.length >= 5 ? regress(xs, ys) : null;
      // memory that doesn't follow load (heaps sized up front, caches) is a flat line at its median
      const follows = !!fit && fit.slope > 0 && fit.r2 >= 0.3;
      const base = follows ? Math.max(0, fit!.intercept) : median(ys);
      const perReq = follows ? fit!.slope : 0;
      const spike = Math.max(0, ...ys.map((y, k) => y - (base + perReq * xs[k])));
      memory = { base, perReq, spike, peak: Math.max(...ys), limit: memLimit, r2: fit?.r2 ?? 0, seenTo: Math.max(...xs) };
      if (memLimit) notes.push(`memory: peaks at ${Math.round(memory.peak * 1024)} MiB per container against a ${Math.round(memLimit * 1024)} MiB limit (${Math.round((memory.peak / memLimit) * 100)}%)${follows ? `, +${(perReq * 1024 * 100).toFixed(1)} MiB per 100 req/s per replica` : ', flat with load'}`);
    }

    // CFS quota throttling: a runtime that runs on one thread (Node, Python) or bursts across several
    // spends its quota early in each 100 ms period and waits out the rest, so it stops keeping up well
    // before its CPU reaches the limit. The share of throttled periods grows roughly exponentially with
    // CPU use; where that curve reaches THROTTLE_COLLAPSE is the share of the limit it can really use.
    let throttle: Capacity['throttle'];
    let throttleBound = false;
    /** capacity capped below loads the history held briefly (load-test steps): the latency fit is
     *  scored on the loads it can sustain */
    let throttleCapped = false;
    if (s.cpuThrottled && cpuLimit && !hostedBy[id]) {
      const us: number[] = [];
      const ls: number[] = [];
      for (let i = 0; i < d.n; i++) {
        const c = vals(s.cpuCores, i);
        const th = vals(s.cpuThrottled, i);
        const r = vals(reps, i) ?? replicas;
        if (c === null || th === null || r <= 0 || th < 0.002 || th >= 0.98) continue;
        us.push(c / (r * cpuLimit));
        ls.push(Math.log(th));
      }
      const fit = us.length >= 12 ? regress(us, ls) : null;
      const maxU = us.length ? Math.max(...us) : 0;
      // a service the history saw throttled that hard while it kept its latency is not held back by
      // its quota (bursty multi-threaded runtimes: throttling costs them milliseconds, not throughput)
      const own = s.selfP99Ms ?? s.p99Ms;
      const p99s = (own ?? []).map((x) => x).filter((x): x is number => x !== null && x > 0).sort((a, b) => a - b);
      const calmP99 = p99s.length ? quantile(p99s, 0.25) : NaN;
      let hard = 0;
      let healthy = 0;
      let broke = 0;
      let topU = 0;
      const brokeAt: number[] = [];
      for (let i = 0; i < d.n; i++) {
        const th = vals(s.cpuThrottled, i);
        if (th === null || th < THROTTLE_COLLAPSE) continue;
        hard++;
        const c = vals(s.cpuCores, i);
        const r = vals(reps, i) ?? replicas;
        const u = c !== null && r > 0 ? c / (r * cpuLimit) : 0;
        topU = Math.max(topU, u);
        const p = vals(own, i);
        const err = vals(s.errorRate, i) ?? 0;
        if (p !== null && isFinite(calmP99) && p <= Math.max(calmP99 * 2, calmP99 + 50) && err < 0.01) healthy++;
        if (err >= 0.01 || (vals(s.p99Ms, i) ?? 0) >= timeoutMs * 0.5) (broke++, brokeAt.push(u));
      }
      // …and one the history saw failing while throttled that hard was held back by it: failing at
      // the top of its throttled range (a collapse), or often enough not to be a stray bucket of
      // errors with another cause
      throttleBound = broke >= Math.max(2, 0.1 * hard) || brokeAt.some((u) => u >= topU * 0.95);
      if (hard >= 3 && healthy >= hard * 0.8) notes.push(`throttled in ${Math.round(THROTTLE_COLLAPSE * 100)}%+ of CPU periods for ${hard} buckets of the history without slowing down: the quota does not limit it`);
      else if (fit && fit.slope > 0 && fit.r2 >= 0.3) {
        const knee = (Math.log(THROTTLE_COLLAPSE) - fit.intercept) / fit.slope;
        if (knee < 0.97) {
          throttle = { knee: Math.max(0.3, knee), atZero: Math.exp(fit.intercept), growth: fit.slope, r2: fit.r2, seenTo: maxU };
          notes.push(
            `CPU quota throttling: ${(Math.exp(fit.intercept + fit.slope * Math.min(maxU, 1)) * 100).toFixed(0)}% of periods throttled at ${Math.round(Math.min(maxU, 1) * 100)}% of the limit, rising ×${Math.exp(fit.slope * 0.1).toFixed(2)} per 10 points (R² ${fit.r2.toFixed(2)}); it reaches ${Math.round(THROTTLE_COLLAPSE * 100)}% at ${Math.round(throttle.knee * 100)}% of the limit, so that is the CPU it can use${knee > maxU + 0.2 ? ' (extrapolated)' : ''}`,
          );
        }
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
      // the fits replay the history many times over; on a long one they run on a compact copy —
      // every busy bucket with what follows it, and a thin sample of the quiet ones (see compactFit)
      const F = compactFit(perRep, selfObs, selfP99Obs, maxLam, S);
      const none = logErr(replayQueue(F.lam, d.stepS, 1, Infinity, S, S99, 1).mean, F.obs);
      const usable = cpuLimit ? cpuLimit * (throttle?.knee ?? 1) : null;
      const cpuK = cpu && usable && cpu.perReq > 0 ? Math.max(0, usable - cpu.base) / cpu.perReq : Infinity;
      const cpuC = cpuLimit ? Math.max(1, Math.round(cpuLimit)) : 1;
      let cpuFit: Fitted = { c: cpuC, K: cpuK, S, v: 1, err: Infinity };
      if (isFinite(cpuK)) for (const v of VARIABILITY) {
        const err = logErr(replayQueue(F.lam, d.stepS, cpuC, cpuK, S, S99, 1, v).mean, F.obs);
        if (err < cpuFit.err) cpuFit = { c: cpuC, K: cpuK, S, v, err };
      }
      const servers = ov?.servers ? [ov.servers] : undefined;
      const free = fitFree(F.lam, F.obs, d.stepS, S, S99, maxLam, servers);
      const tied = fitTied(F.lam, F.obs, d.stepS, S, S99, servers);
      // the tied model is physically grounded; the free one has to be clearly better to win
      let queue = tied.err <= free.err / 0.85 ? { ...tied, tied: true } : { ...free, tied: false };
      // while a service was overloaded, what finished per second *is* its capacity: when the history
      // has such stretches, a model built on that number wins unless it explains the latency worse
      const doneSeries = s.doneRps;
      const saturated = withData.map((x) => x.i).filter((i) => (selfObs[i] ?? 0) > Math.max(4 * S, S + 500));
      if (doneSeries && saturated.length >= 2 && !servers) {
        const ks = saturated.map((i) => (vals(doneSeries, i) ?? NaN) / Math.max(1, vals(reps, i) ?? replicas)).filter((k) => isFinite(k) && k > 0);
        if (ks.length >= 2) {
          const seen = median(ks);
          const atSeen = fitAtK(F.lam, F.obs, d.stepS, S, S99, seen);
          if (atSeen.err <= queue.err * 1.15) {
            queue = atSeen;
            notes.push(`capacity seen directly: ${seen.toFixed(1)} req/s per replica finished while it was overloaded (${saturated.length} buckets)`);
          }
        }
      }
      const simple = Math.min(none, cpuFit.err);
      // CPU that reached its limit in the history is capacity seen directly — even when the waiting
      // happens before a span starts (an event loop too busy to accept), where self time can't see it
      let cpuPeak = 0;
      if (cpu && cpuLimit && s.cpuCores)
        for (let i = 0; i < d.n; i++) {
          const c = vals(s.cpuCores, i);
          const r = vals(reps, i) ?? replicas;
          if (c !== null && r > 0) cpuPeak = Math.max(cpuPeak, c / (r * cpuLimit));
        }
      /** completions per replica in buckets where CPU was pinned (needs completion rates from traces) */
      const pinned = (i: number) => {
        const c = vals(s.cpuCores, i);
        const r = vals(reps, i) ?? replicas;
        return c !== null && r > 0 && !!cpuLimit && c / (r * cpuLimit) >= 0.95;
      };
      const seenAtSaturation = () => {
        let seen = 0;
        if (s.doneRps && cpu && cpuLimit)
          for (let i = 0; i < d.n; i++) {
            const k = vals(s.doneRps, i);
            if (k !== null && pinned(i)) seen = Math.max(seen, k / (vals(reps, i) ?? replicas));
          }
        return seen;
      };
      /** completions in pinned buckets where users were already timing out: then that *is* the capacity
       *  (throughput can even fall under overload — garbage collection, thrashing), not a lower bound */
      const seenWhileOverloaded = () => {
        const ks: number[] = [];
        if (s.doneRps && cpu && cpuLimit)
          for (let i = 0; i < d.n; i++) {
            const k = vals(s.doneRps, i);
            if (k !== null && pinned(i) && overloaded[i]) ks.push(k / (vals(reps, i) ?? replicas));
          }
        return ks.length >= 2 ? median(ks) : 0;
      };
      const cpuSeenK = (fallback: number) => seenAtSaturation() || fallback;
      let chosen: Fitted | null = null;
      let cpuSaturated = false;
      // an overload in the history brackets the limit: the highest rate it finished without users
      // timing out, and the rate at which they started to
      let knee: { healthy: number; broke: number; collapse: number; pinned: boolean } | null = null;
      {
        const done = s.doneRps ?? s.rps;
        // what was offered: for an entry service, its endpoints' request rate (span metrics count
        // requests when they finish, which an overloaded service no longer does)
        const entry = Object.values(d.endpoints).filter((e) => e.service === id && e.rps);
        // a service further in: the entry endpoints' requests × its visits per request (from traces).
        // Its own span rate counts completions, and cancelled calls finish fast and early in an overload
        const via = Object.entries(d.endpoints)
          .map(([eid, e]) => ({ e, v: Object.entries(topo?.endpoints ?? {}).find(([tid]) => tid === eid || sameEndpoint(tid, eid))?.[1].visits[id] ?? 0 }))
          .filter((x) => x.v > 0 && x.e.rps);
        const offered = (i: number) =>
          entry.length
            ? entry.reduce((a, e) => a + (vals(e.rps, i) ?? 0), 0) / Math.max(1, vals(reps, i) ?? replicas)
            : via.length
              ? via.reduce((a, x) => a + (vals(x.e.rps, i) ?? 0) * x.v, 0) / Math.max(1, vals(reps, i) ?? replicas)
              : perRep[i];
        let healthy = 0;
        let broke = Infinity;
        const collapse: number[] = [];
        let collapsePinned = 0;
        // only where this service itself was the queue: users timing out *and* its own time exploding
        const mine = (i: number) => overloaded[i] && (selfObs[i] ?? 0) > Math.max(4 * S, S + 200);
        for (let i = 1; i < d.n; i++) {
          const r = vals(reps, i) ?? replicas;
          const k = vals(done, i);
          const lam0 = offered(i);
          // what it was asked to do and did (completions alone run above arrivals while a backlog drains),
          // and still fine a bucket later: an overload takes time to build (heap, a pool's backlog), so the
          // last bucket before a collapse doesn't show the rate was sustainable
          if (!overloaded[i] && !overloaded[i - 1] && i + 1 < d.n && !overloaded[i + 1] && k !== null) healthy = Math.max(healthy, Math.min(k / r, lam0));
          if (mine(i) && !overloaded[i - 1]) broke = Math.min(broke, Math.max(lam0, offered(i - 1)));
          if (mine(i) && mine(i - 1) && k !== null) {
            collapse.push(k / r);
            if (cpu && cpuLimit && pinned(i)) collapsePinned++;
          }
        }
        if (isFinite(broke) && healthy > 0 && broke >= healthy * 0.9) knee = { healthy, broke: Math.max(broke, healthy), collapse: collapse.length >= 2 ? median(collapse) : 0, pinned: collapse.length >= 2 && collapsePinned >= collapse.length / 2 };
      }
      if (ov?.perReplicaRps) capacity = { limit: 'concurrency', servers: ov.servers ?? 1, perReplicaRps: ov.perReplicaRps };
      else if (knee && !(cpuPeak >= 0.9 && !knee.collapse)) {
        // seen breaking: the limit lies between what it handled and where it broke
        const K = (knee.healthy + knee.broke) / 2;
        // CPU-bound when the CPU read agrees, or when it ran pinned at its limit while collapsed (garbage
        // collection and thrashing: the overload burns CPU, so more cores move the knee)
        const lim = (isFinite(cpuK) && Math.abs(cpuK - K) / K < 0.25) || knee.pinned ? 'cpu' : 'concurrency';
        capacity = { limit: lim, servers: Math.max(1, (queue.err <= cpuFit.err ? queue : cpuFit).c), perReplicaRps: K, band: [knee.healthy, knee.broke] };
        // its queue showed in its own spans (that's how the knee was found): keep the latency fit's shape
        const shape = queue.err <= cpuFit.err ? queue : cpuFit;
        chosen = { ...shape, K, S: shape.S };
        cpuSaturated = true; // the band is set, keep it
        if (knee.collapse && knee.collapse < K * 0.8) {
          capacity.overloadedRps = knee.collapse;
          notes.push(`broke between ${knee.healthy.toFixed(0)} and ${knee.broke.toFixed(0)} req/s per replica, and while overloaded finished only ${knee.collapse.toFixed(0)} req/s — a metastable failure: it stays down until the backlog is gone`);
        } else notes.push(`broke between ${knee.healthy.toFixed(0)} and ${knee.broke.toFixed(0)} req/s per replica in the history`);
      } else if (cpuPeak >= 0.9 && isFinite(cpuK) && cpuSeenK(cpuK) < (isFinite(queue.K) && queue.err < simple * 0.85 ? queue.K / 1.1 : Infinity)) {
        // what finished per second while CPU was pinned is the capacity; CPU per request measured at
        // low load can drift (runtimes get more efficient when busy). Taken when the latency fit claims
        // more than that — the queue then sits where spans can't see it (an event loop too busy to accept)
        // completions while pinned are a lower bound (demand may have been just below capacity); CPU
        // efficiency in the busiest buckets — requests per CPU-second, at the limit — is the other read
        const seen = seenAtSaturation();
        const eff: number[] = [];
        const busy = withData.map((x) => x.i).sort((a, b) => perRep[b] - perRep[a]).slice(0, Math.max(3, Math.floor(withData.length * 0.15)));
        for (const i of busy) {
          const c = vals(s.cpuCores, i);
          const r = vals(reps, i) ?? replicas;
          if (c !== null && c > 0 && r > 0 && cpuLimit) eff.push((perRep[i] * cpuLimit) / (c / r));
        }
        const atLimit = eff.length ? median(eff) : 0;
        const collapsed = seenWhileOverloaded();
        const K = collapsed || Math.max(seen, atLimit) || cpuK;
        capacity = { limit: 'cpu', servers: cpuC, perReplicaRps: K };
        chosen = { ...cpuFit, K, v: Math.max(1, cpuFit.v) };
        cpuSaturated = true;
        hiddenQueue.add(id);
        notes.push(
          collapsed
            ? `CPU reached ${Math.round(cpuPeak * 100)}% of its limit while users were timing out: ${collapsed.toFixed(1)} req/s per replica is what it could still finish (${atLimit.toFixed(1)} would follow from CPU efficiency when it was not overloaded)`
            : `CPU reached ${Math.round(cpuPeak * 100)}% of its limit in the history; capacity ${K.toFixed(1)} req/s per replica (${seen > 0 ? `${seen.toFixed(1)} finished while pinned, ` : ''}${atLimit.toFixed(1)} from CPU efficiency in the busiest buckets)`,
        );
      } else if (queue.err < simple * 0.85 && isFinite(queue.K) && queue.K < maxLam * 40) {
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
      // where the history shows it breaking while throttled, the quota is the ceiling whatever the
      // latency fit says (a ramp step reads a higher limit than the load can sustain)
      if (throttle && throttleBound && isFinite(cpuK) && capacity.perReplicaRps > cpuK * 1.05 && !ov?.perReplicaRps) {
        notes.push(`the latency history reads ${capacity.perReplicaRps.toFixed(0)} req/s per replica, but the CPU quota throttles it at ${cpuK.toFixed(0)}: capped there`);
        capacity = { limit: 'cpu', servers: cpuC, perReplicaRps: cpuK };
        // the CPU fit's variability, refitted on the loads it can sustain (the history replayed whole,
        // scored only there)
        const obs = F.obs.map((x, i) => (F.lam[i] > cpuK ? null : x));
        cpuFit = { c: cpuC, K: cpuK, S, v: 1, err: Infinity };
        for (const v of VARIABILITY) {
          const err = logErr(replayQueue(F.lam, d.stepS, cpuC, cpuK, S, S99, 1, v).mean, obs);
          if (err < cpuFit.err) cpuFit = { c: cpuC, K: cpuK, S, v, err };
        }
        chosen = cpuFit;
        throttleCapped = true;
      }
      if (chosen) {
        variability = isFinite(chosen.err) ? chosen.v : 1;
        selfMean = chosen.S;
        selfP99 = Math.max(chosen.S, S99 - (S - chosen.S));
      }
      const tiedK = chosen && 'tied' in chosen && (chosen as Fitted & { tied: boolean }).tied;

      const cpuOnly = capacity.limit === 'cpu' && (chosen === cpuFit || cpuSaturated) && cpu && cpuLimit && isFinite(cpuSe);
      if (cpuSaturated && B > 0 && knee && capacity.band) {
        const [lo, hi] = capacity.band;
        capacity.samples = Array.from({ length: B }, () => lo + (hi - lo) * rand());
      } else if (cpuSaturated && B > 0) {
        // seen directly at saturation: a narrow band around it, widened by how well CPU per request is known
        const rel = cpu && isFinite(cpuSe) && cpu.perReq > 0 ? Math.min(0.15, cpuSe / cpu.perReq) : 0.05;
        capacity.band = [capacity.perReplicaRps * (1 - 1.28 * rel - 0.03), capacity.perReplicaRps * (1 + 1.28 * rel + 0.03)];
        capacity.samples = Array.from({ length: B }, () => capacity.perReplicaRps * (1 + (rand() * 2 - 1) * (1.28 * rel + 0.03)));
      } else if (cpuOnly && B > 0) {
        // the latency history says little about a limit it never reached: the band comes from how
        // well CPU per request is known (slope ± its standard error)
        const draws: number[] = [];
        for (let b = 0; b < B; b++) {
          const z = Math.sqrt(-2 * Math.log(Math.max(1e-12, rand()))) * Math.cos(2 * Math.PI * rand());
          const slope = Math.max(cpu!.perReq * 0.2, cpu!.perReq + z * cpuSe);
          draws.push(Math.max(0, (usable ?? cpuLimit!) - cpu!.base) / slope);
        }
        draws.sort((a, b) => a - b);
        capacity.band = [quantile(draws, 0.1), quantile(draws, 0.9)];
        capacity.samples = draws;
      } else if (isFinite(capacity.perReplicaRps) && B > 0 && !ov?.perReplicaRps) {
        // bootstrap the capacity (blocks of 6 buckets), server count and variability fixed
        const draws: number[] = [];
        const fn = F.lam.length;
        const blocks = Math.ceil(fn / 6);
        for (let b = 0; b < B; b++) {
          const w = new Array(fn).fill(0);
          for (let k = 0; k < blocks; k++) {
            const start = Math.floor(rand() * blocks) * 6;
            for (let j = start; j < Math.min(fn, start + 6); j++) w[j] += 1;
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
                const e = logErr(replayQueue(F.lam, d.stepS, c, K, sv, selfP99 + (sv - selfMean), 1, v).mean, F.obs, w);
                if (e < bestE) [bestE, bestK] = [e, K];
              }
          draws.push(bestK);
        }
        draws.sort((a, b) => a - b);
        capacity.band = [quantile(draws, 0.1), quantile(draws, 0.9)];
        capacity.samples = draws;
      }

      // a limit the history never came near is an extrapolation: when CPU and latency read it
      // differently, the band has to span both
      if (isFinite(capacity.perReplicaRps) && isFinite(cpuK) && !cpuSaturated && maxLam < capacity.perReplicaRps * 0.85 && Math.abs(cpuK - capacity.perReplicaRps) / capacity.perReplicaRps > 0.1 && B > 0) {
        const lo = Math.min(cpuK, capacity.perReplicaRps, capacity.band?.[0] ?? Infinity);
        const hi = Math.max(cpuK, capacity.perReplicaRps, capacity.band?.[1] ?? 0);
        capacity.samples = Array.from({ length: B }, () => lo * (hi / lo) ** rand());
        capacity.band = [lo * (hi / lo) ** 0.1, lo * (hi / lo) ** 0.9];
        // neither read is more trustworthy so far from the data: the point estimate sits mid-band
        capacity.perReplicaRps = Math.sqrt(lo * hi);
        notes.push(`never loaded past ${Math.round((maxLam / capacity.perReplicaRps) * 100)}% of capacity: CPU (${cpuK.toFixed(0)}) and latency (${capacity.perReplicaRps.toFixed(0)}) read the limit differently, the band spans both`);
      }

      // tail multiplier on queueing excess
      let bestTail = { t: 1, e: Infinity };
      for (const t of [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 5, 6]) {
        const e = logErr(replayQueue(F.lam, d.stepS, capacity.servers, capacity.perReplicaRps, selfMean, selfP99, t, variability).p99, F.p99);
        if (e < bestTail.e) bestTail = { t, e };
      }
      tail = bestTail.t;
      const r = replayQueue(perRep, d.stepS, capacity.servers, capacity.perReplicaRps, selfMean, selfP99, tail, variability);
      // errors below a few ms don't matter to anyone's p99: floor the denominator
      const sustained = (xs: (number | null)[]) => (throttleCapped ? xs.map((x, i) => (perRep[i] > capacity.perReplicaRps ? null : x)) : xs);
      latencyMape = mape(r.mean, sustained(selfObs), 5);
      p99Mape = mape(r.p99, sustained(selfP99Obs), 5);
      if (throttleCapped) notes.push(`latency fit scored on the ${perRep.filter((x, i) => x <= capacity.perReplicaRps && selfObs[i] !== null).length} buckets at or below that capacity: above it the history only held for load-test steps`);
      if (throttle && capacity.limit === 'cpu') capacity.throttle = throttle;
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
      memoryGb: memLimit ?? (memVals.length ? median(memVals) : null),
      ...(memory ? { memory } : {}),
      ...(requestsOfService(host) ? { requests: requestsOfService(host)! } : {}),
      ...(d.podsByNode?.[id] ? { pods: d.podsByNode[id] } : {}),
      ...(d.hpa?.[id] ? { hpa: d.hpa[id] } : {}),
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

  // ---- Kubernetes nodes: on a cluster, compute is what the nodes cost ----
  const cluster = clusterOf(d, services, replicasOf);
  if (cluster)
    for (const sm of Object.values(services)) {
      if (sm.cost.source !== 'none' || sm.hostedBy || !sm.requests) continue;
      const { cpu, memoryGb } = sm.requests;
      // a replica's share of a node is the larger of its CPU and memory shares
      sm.cost.perReplicaHour = cluster.node.perHour * Math.max(cpu / cluster.node.cpu, memoryGb / cluster.node.memoryGb);
      sm.cost.cpuShare = cpu / cluster.node.cpu >= memoryGb / cluster.node.memoryGb ? 1 : 0;
      sm.cost.source = 'nodes';
      sm.fit.notes.push(`requests ${cpu} cores + ${Math.round(memoryGb * 1024)} MiB = ${(Math.max(cpu / cluster.node.cpu, memoryGb / cluster.node.memoryGb) * 100).toFixed(1)}% of a node, $${sm.cost.perReplicaHour.toFixed(4)}/replica-hour`);
    }

  // ---- list prices where the bill says nothing ----
  if (opts.listPrices) {
    const lp = opts.listPrices === true ? FARGATE_PRICES : opts.listPrices;
    for (const sm of Object.values(services)) {
      if (sm.cost.source !== 'none' || sm.hostedBy || sm.kind === 'external') continue;
      if (!sm.cpuLimit) {
        sm.fit.notes.push('no CPU limit in the data, so no list price: its cost reads $0');
        continue;
      }
      const mem = sm.memoryGb ?? sm.cpuLimit * 2;
      const arm = sm.cost.arch === 'arm';
      const cpu$ = sm.cpuLimit * (arm ? lp.armPerVcpuHour : lp.perVcpuHour);
      const mem$ = mem * (arm ? lp.armPerGbHour : lp.perGbHour);
      sm.cost.perReplicaHour = cpu$ + mem$;
      sm.cost.cpuShare = cpu$ / (cpu$ + mem$);
      sm.cost.source = 'pricing';
      sm.fit.notes.push(`priced at list price: ${sm.cpuLimit} vCPU${sm.memoryGb ? ` + ${sm.memoryGb.toFixed(2)} GB` : ` + ${mem} GB (assumed 2 GB per vCPU)`} = $${sm.cost.perReplicaHour.toFixed(4)}/replica-hour (${lp.source}); no bill`);
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
    const lowP50 = median(lowIdx.map((i) => vals(ser?.p50Ms, i)).filter((x): x is number => x !== null));
    const pathMean = Object.entries(weights).reduce((a, [svc, w]) => a + w * (services[svc]?.self.mean ?? 0), 0);
    // the traces' mean covers the whole history, overloads included: a low-load median is closer
    const measuredMean = isFinite(lowMean) ? lowMean : isFinite(lowP50) && lowP50 > 0 ? lowP50 : shape?.lowMeanMs ?? shape?.meanMs ?? pathMean;
    const measuredP99 = isFinite(lowP99) ? lowP99 : shape?.lowP99Ms ?? shape?.p99Ms ?? measuredMean * 1.5;
    // services' self times summed along the critical path can come out above what the endpoint
    // measured (calls that overlap, self means read over the whole history): scale the weights so the
    // quiet history replays the mean it measured
    if (pathMean > measuredMean * 1.1 && measuredMean > 0) {
      const k = measuredMean / pathMean;
      for (const svc of Object.keys(weights)) weights[svc] *= k;
      notes.push(`its services' self times along the path add up to ${pathMean.toFixed(1)} ms, above the ${measuredMean.toFixed(1)} ms it measured at low load: path weights scaled by ${k.toFixed(2)}`);
    }
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
    // errors that grow with traffic (rate limits, timeouts inside, contention): a line through the
    // buckets that were not overloaded
    let errorSlope: number | undefined;
    {
      const xs: number[] = [];
      const ys: number[] = [];
      for (let i = 0; i < rps.length; i++) {
        const e = vals(ser?.errorRate, i);
        const n = vals(ser?.rps, i);
        const p = vals(ser?.p99Ms, i);
        if (e === null || n === null || n <= 0 || e > 0.2 || (p !== null && p >= timeoutMs * 0.5)) continue;
        xs.push(n);
        ys.push(e);
      }
      const fit = regress(xs, ys);
      if (fit && fit.slope > 0 && fit.se < fit.slope / 2 && xs.length >= 10) {
        errorSlope = fit.slope;
        errs[0] = Math.max(0, fit.intercept);
        notes.push(`errors grow with traffic: ${(fit.intercept * 100).toFixed(2)}% + ${(fit.slope * 100).toFixed(3)}% per req/s`);
      }
    }
    // services on the path that ran throttled under a limit below one core: their p99 carries a
    // CFS stall, read out of the baseline so a plan's limit can put it back at its own length
    const stalls: { service: string; limit: number }[] = [];
    for (const svc of Object.keys(shape?.visits ?? { [ser?.service ?? id.split(' ')[0]]: 1 })) {
      const lim = services[svc]?.cpuLimit;
      if (!lim || lim >= 1 || services[svc]?.hostedBy) continue;
      const th = median(lowIdx.map((i) => vals(d.services[svc]?.cpuThrottled, i)).filter((x): x is number => x !== null));
      if (isFinite(th) && th >= 0.01) stalls.push({ service: svc, limit: lim });
    }
    const stallMs = Math.max(0, ...stalls.map((x) => cfsStallMs(x.limit)));
    if (stalls.length) notes.push(`${stalls.map((x) => x.service).join(', ')} ran throttled under a CPU limit below one core: ${Math.round(stallMs)} ms of the p99 is read as a CFS stall, which a higher limit shortens`);
    const e: EndpointModel = {
      id,
      service: shape?.service ?? ser?.service ?? id.split(' ')[0],
      share: totalRps > 0 ? (meanOf(ser?.rps) ?? 0) / totalRps : 1 / seriesIds.length,
      visits: shape?.visits ?? { [ser?.service ?? id.split(' ')[0]]: 1 },
      calls: shape?.calls ?? {},
      weights: shape ? weights : { [ser?.service ?? id.split(' ')[0]]: 1 },
      overheadMs: Math.max(0, measuredMean - Math.min(pathMean, measuredMean)),
      baseExcessMs: Math.max(0, measuredP99 - measuredMean - stallMs),
      ...(isFinite(lowP50) && lowP50 > 0 ? { baseP50Ms: lowP50 } : shape?.lowP50Ms ?? shape?.p50Ms ? { baseP50Ms: shape.lowP50Ms ?? shape.p50Ms } : {}),
      ...(!isFinite(lowP99) && (shape?.lowP90Ms ?? shape?.p90Ms) ? { baseP90Ms: shape!.lowP90Ms ?? shape!.p90Ms } : {}),
      tail: 1,
      errorRate: errs.length ? Math.min(0.5, errs[0]) : shape?.errorRate ?? 0,
      ...(errorSlope ? { errorSlope } : {}),
      ...(stalls.length ? { stalls } : {}),
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
    ...(cluster ? { cluster } : {}),
  };

  // ---- endpoint tail + fit quality: replay the whole history through the full model ----
  const traffic = trafficOf(d, model);
  const totals = Array.from({ length: d.n }, (_, i) => Object.values(traffic.endpoints).reduce((a, s) => a + (s[i] ?? 0), 0)).filter((x) => x > 0).sort((a, b) => a - b);
  if (totals.length) model.traffic = { mean: totals.reduce((a, x) => a + x, 0) / totals.length, p90: quantile(totals, 0.9), peak: totals[totals.length - 1] };
  const observed = Object.fromEntries(Object.keys(services).map((id) => [id, replicasOf(id)]));
  if (Object.values(traffic.endpoints).length) {
    const fitTails = () => {
      let total = 0;
      for (const [id, e] of Object.entries(endpoints)) {
        const obs = series[id]?.p99Ms;
        if (!obs) continue;
        const everyday = obs.map((x) => (x !== null && x <= e.slo.p99Ms ? x : null));
        const use = everyday.filter((x) => x !== null).length >= 10 ? everyday : obs.map((x) => x);
        let best = { t: 1, err: Infinity };
        for (const t of [0.5, 0.7, 0.85, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 5, 6]) {
          e.tail = t;
          const err = logErr(runPlan(basePlan(model, observed), traffic).endpoints[id].p99Ms, use);
          if (err < best.err) best = { t, err };
        }
        e.tail = best.t;
        total += best.err * (e.share || 0.01);
      }
      return total;
    };
    // a queue the spans can't see is read from the endpoints instead: how steeply it rises with load
    if (hiddenQueue.size) {
      let best = { k: 1, err: Infinity, tails: {} as Record<string, number> };
      for (const k of [1, 1.5, 2, 3, 4]) {
        for (const id of hiddenQueue) services[id].loadExponent = k;
        const err = fitTails();
        if (err < best.err) best = { k, err, tails: Object.fromEntries(Object.entries(endpoints).map(([id, e]) => [id, e.tail])) };
      }
      for (const id of hiddenQueue) {
        services[id].loadExponent = best.k;
        if (best.k !== 1) services[id].fit.notes.push(`queueing outside its spans rises steeply with load (exponent ${best.k}, read from end-to-end latency)`);
      }
      for (const [id, t] of Object.entries(best.tails)) endpoints[id].tail = t;
    }
    for (const [id, e] of Object.entries(endpoints)) {
      if (hiddenQueue.size) break;
      const obs = series[id]?.p99Ms;
      if (!obs) continue;
      let best = { t: 1, err: Infinity };
      // everyday latency decides the tail: buckets within the SLO (overloads are capacity's business,
      // and their huge p99s would otherwise drag the multiplier up for every ordinary minute)
      const everyday = obs.map((x) => (x !== null && x <= e.slo.p99Ms ? x : null));
      const use = everyday.filter((x) => x !== null).length >= 10 ? everyday : obs.map((x) => x);
      for (const t of [0.5, 0.7, 0.85, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 5, 6]) {
        e.tail = t;
        const r = runPlan(basePlan(model, observed), traffic);
        const err = logErr(r.endpoints[id].p99Ms, use);
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

/**
 * The history at a different load: every endpoint ×scale, or scaled so the busiest bucket carries
 * peakRps — "would it survive launch day at 2.2× an ordinary day?" The shape (the daily curve, the
 * spikes, the endpoint mix) stays the history's own.
 */
export function scaleTraffic(t: Traffic, o: { scale?: number; peakRps?: number }): { traffic: Traffic; factor: number; peakRps: number } {
  let peak = 0;
  for (let i = 0; i < t.n; i++) {
    let sum = 0;
    for (const s of Object.values(t.endpoints)) sum += s[i] ?? 0;
    peak = Math.max(peak, sum);
  }
  const factor = o.peakRps !== undefined ? (peak > 0 ? o.peakRps / peak : 1) : (o.scale ?? 1);
  if (!(factor > 0) || !isFinite(factor)) throw new Error(`traffic: scale must be above 0 (got ${factor})`);
  const endpoints = Object.fromEntries(Object.entries(t.endpoints).map(([id, s]) => [id, s.map((v) => (v === null ? null : v * factor))]));
  return { traffic: { ...t, endpoints }, factor, peakRps: peak * factor };
}

export function observedReplicas(d: Dataset, model: Model): Record<string, Num[] | undefined> {
  return Object.fromEntries(Object.entries(model.services).map(([id, s]) => [id, d.services[s.hostedBy ?? id]?.replicas]));
}
