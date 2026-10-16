import type { Num } from './dataset';
import type { Model } from './model';
import * as wasm from './wasm/hindcast_engine.js';

/**
 * Backtest engine: replays real traffic, bucket by bucket, through a calibrated model.
 *
 * Fluid, deterministic, fast enough for weeks of 1-minute buckets and Monte Carlo bands:
 *   endpoint traffic → visits per service (through caches, retries) → per-replica load →
 *   M/M/c wait + fluid backlog when demand exceeds capacity → latency per service →
 *   end-to-end latency per endpoint along its critical path → failures past the client deadline →
 *   cost per bucket (replica-hours, requests, data transfer). Autoscalers react on their own clock.
 */

export interface AutoscalePolicy {
  min: number;
  max: number;
  /** target CPU utilisation (0..1); without a CPU model, target share of capacity */
  target: number;
  /** launch → serving, s */
  warmupS: number;
  /** after scaling, wait this long before scaling in, s */
  cooldownS: number;
  /** how often the policy evaluates, s */
  intervalS: number;
  /** the metric it reads is averaged over this window, s (Prometheus rate[30s], CloudWatch 60 s) */
  metricWindowS?: number;
}

/** a time-boxed fault on one service, for incident and public-outage replays */
export interface Fault {
  /** seconds from the start of the traffic */
  at: number;
  /** end, seconds from the start (default: to the end) */
  until?: number;
  service: string;
  /** capacity multiplier (0.05 = every request suddenly costs 20× the CPU) */
  capacity?: number;
  /** calls to it fail at once (DNS gone, connection refused) */
  down?: boolean;
  /** extra latency on every call, ms (a primary now across the country) */
  extraMs?: number;
  /** share of calls that fail (packet loss, health-check flaps) */
  errorRate?: number;
  /** the autoscaler cannot launch anything (cloud control plane impaired) */
  noScaleOut?: boolean;
  /** launches take this many times longer (provisioning throttled) */
  warmupFactor?: number;
  /** replicas gone (a node failure took them) until the fault ends */
  replicasLost?: number;
  note?: string;
  /** only this caller's calls to the service fail (`errorRate` of them, all when unset): a client
   *  whose connection to it stays broken; the service and its other callers are untouched */
  caller?: string;
}

export interface ServicePlan {
  id: string;
  hostedBy?: string;
  /** fixed replica count; null = follow the observed series (or the model's typical count) */
  replicas: number | null;
  observedReplicas?: Num[];
  autoscale?: AutoscalePolicy;
  perReplicaRps: number;
  /** throughput per replica while overloaded (metastable services) */
  overloadedRps?: number;
  servers: number;
  selfMean: number;
  selfP99: number;
  tail: number;
  /** waits are this × the M/M/c wait */
  variability?: number;
  /** waits × utilisation^(loadExponent − 1) */
  loadExponent?: number;
  cpu: { base: number; perReq: number } | null;
  cpuLimit: number | null;
  /** peak working set per container = base + perReq × req/s per replica + spike, against limit (GiB):
   *  past it the pods are OOM-killed and restart with CrashLoopBackOff */
  memory?: { base: number; perReq: number; spike: number; limit: number; peak?: number; seenTo?: number };
  /** Kubernetes requests per replica (cores, GiB): what it takes of a node */
  requests?: { cpu: number; memoryGb: number };
  /** $ per replica-hour and per request */
  replicaHour: number;
  perRequest: number;
  /** a cache in front of this service answers this share of calls */
  cache?: { hitRate: number; latencyMs: number; costPerHour: number };
  zone?: string;
  region?: string;
  /** a JIT runtime: pods that start during the replay serve at `cold`× CPU per request until `coreS`
   *  core-seconds of compilation are done, paid from what the requests leave idle (at least `share` of the limit) */
  warmup?: Warmup;
  /** the change replaces the pods (a new pod template): they all start cold with the replay */
  restart?: boolean;
}

export interface Warmup {
  runtime: string;
  cold: number;
  coreS: number;
  share: number;
  source: 'calibrated' | 'assumed';
}

export interface EndpointPlan {
  id: string;
  service: string;
  visits: Record<string, number>;
  calls: Record<string, number>;
  weights: Record<string, number>;
  overheadMs: number;
  baseExcessMs: number;
  /** median at low load, ms (shapes the latency distribution) */
  baseP50Ms?: number;
  baseP90Ms?: number;
  tail: number;
  errorRate: number;
  errorSlope?: number;
  /** throttled services on its path (EndpointModel.stalls) */
  stalls?: { service: string; limit: number }[];
  bytes: Record<string, number>;
  egressBytes: number;
  /** client retries per failed request, capped by a budget (share of extra load) */
  retries?: { attempts: number; budget: number };
  timeoutMs: number;
  slo: { p99Ms: number; errorRate: number };
}

/** the node pool: compute is what its nodes cost, less what other teams' pods take of them */
export interface ClusterPlan {
  node: { cpu: number; memoryGb: number; perHour: number };
  /** fixed pool size, or the autoscaler's bounds */
  nodes: number;
  autoscaled: boolean;
  minNodes: number;
  maxNodes: number;
  packing: number;
  other: { cpu: number; memoryGb: number };
  /** an autoscaler removes a node this long after it stops being needed (cluster-autoscaler's
   *  scale-down-unneeded-time) */
  scaleDownS: number;
  /** a pod that needs a new node waits this long for it (Karpenter ~60 s, cluster-autoscaler 2–3 min) */
  provisionS: number;
}

export interface Plan {
  services: Record<string, ServicePlan>;
  endpoints: Record<string, EndpointPlan>;
  cluster?: ClusterPlan;
  transfer: Model['transfer'];
  unattributedPerHour: number;
  slo: { p99Ms: number; errorRate: number };
}

export interface Traffic {
  start: number;
  stepS: number;
  n: number;
  /** req/s per endpoint per bucket */
  endpoints: Record<string, Num[]>;
}

export interface ServiceTrace {
  rps: number[];
  util: number[];
  replicas: number[];
  waitMs: number[];
  selfMeanMs: number[];
  selfP99Ms: number[];
  backlog: number[];
  cpuCores: number[];
  /** share of the bucket its pods were down after an OOM kill */
  oomDown?: number[];
}

export interface EndpointTrace {
  rps: number[];
  errorRate: number[];
  meanMs: number[];
  p99Ms: number[];
  /** median, when the endpoint's median is known */
  p50Ms: number[];
  /** $ per bucket attributed to this endpoint (by its share of each component's load) */
  cost: number[];
}

export interface RunResult {
  t: number[];
  rps: number[];
  errorRate: number[];
  p99Ms: number[];
  /** $/h per bucket */
  costPerHour: number[];
  /** $ per bucket by category */
  cost: { compute: number[]; requests: number[]; transfer: number[]; other: number[] };
  services: Record<string, ServiceTrace>;
  endpoints: Record<string, EndpointTrace>;
  events: { t: number; what: string }[];
  /** the node pool per bucket: nodes running, and what all pods requested (cores) */
  cluster?: { nodes: number[]; requestedCpu: number[]; requestedMemoryGb: number[] };
}

/** P(latency > t) for a latency summarised by (mean, p99) with an exponential tail */
export function exceed(mean: number, p99: number, t: number): number {
  if (!isFinite(mean)) return 1;
  const ex = Math.max(1e-6, p99 - mean);
  if (t >= mean) return Math.min(1, 0.01 ** ((t - mean) / ex));
  return Math.min(1, 1 - 0.5 * Math.exp(-(mean - t) / ex));
}

/** standard normal upper tail */
function normalTail(z: number): number {
  // Abramowitz–Stegun 7.1.26 via erfc
  const t = 1 / (1 + 0.3275911 * Math.abs(z / Math.SQRT2));
  const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-(z * z) / 2);
  return z >= 0 ? y / 2 : 1 - y / 2;
}

/**
 * P(latency > x) for one endpoint. With a median known the latency is lognormal through (p50, p99) —
 * request latencies are skewed: most fast, a few very slow — otherwise an exponential tail through
 * (mean, p99).
 */
export function survival(p: { mean: number; p99: number; p50?: number; p90?: number }, x: number): number {
  // with a p90 as well, log survival runs straight in log latency between (p50, ½), (p90, 1/10) and
  // (p99, 1/100), and on past p99 at the last slope: a bimodal endpoint (most fast, 1% slow) keeps
  // its slow mode at p99 instead of spreading it over everything above the median
  if (p.p50 && p.p90 && p.p50 > 0 && p.p90 > p.p50 * 1.01 && p.p99 > p.p90 * 1.01 && x > 0) {
    const L = Math.log;
    if (x <= p.p90) {
      const sigma = (L(p.p90) - L(p.p50)) / 1.2816;
      return normalTail((L(x) - L(p.p50)) / sigma);
    }
    const slope = (L(0.01) - L(0.1)) / (L(p.p99) - L(p.p90));
    return Math.min(0.1, Math.exp(L(0.1) + slope * (L(x) - L(p.p90))));
  }
  if (p.p50 && p.p50 > 0 && p.p99 > p.p50 * 1.01 && x > 0) {
    const sigma = (Math.log(p.p99) - Math.log(p.p50)) / 2.3263;
    return normalTail((Math.log(x) - Math.log(p.p50)) / sigma);
  }
  return exceed(p.mean, p.p99, x);
}

/** p-quantile of a traffic-weighted mixture of endpoint latencies */
export function mixtureQuantile(input: { w: number; mean: number; p99: number; p50?: number; p90?: number }[], tail = 0.01): number {
  // identical parts (the substeps of a steady bucket) are one part with their weights summed
  const parts: { w: number; mean: number; p99: number; p50?: number; p90?: number }[] = [];
  for (const p of input) {
    const same = parts.find((q) => q.mean === p.mean && q.p99 === p.p99 && q.p50 === p.p50 && q.p90 === p.p90);
    if (same) same.w += p.w;
    else parts.push({ ...p });
  }
  let tot = 0;
  for (const p of parts) tot += p.w;
  if (tot <= 0) return 0;
  const f = (x: number) => {
    let s = 0;
    for (const p of parts) s += (p.w / tot) * survival(p, x);
    return s - tail;
  };
  let lo = 0;
  let hi = 1;
  for (const p of parts) hi = Math.max(hi, isFinite(p.p99) ? p.p99 : 1e7);
  hi *= 2;
  if (f(hi) > 0) return hi;
  // to a hundredth of a millisecond
  for (let i = 0; i < 50 && hi - lo > 0.01; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export type RunOpts = { substepS?: number; faults?: Fault[] };

/** the replay (engine-rs, WebAssembly): the long series cross as one Float64Array each way */
export function runPlan(plan: Plan, traffic: Traffic, opts: RunOpts = {}): RunResult {
  const n = traffic.n;
  const epIds = Object.keys(plan.endpoints).filter((id) => traffic.endpoints[id]);
  const svcIds = Object.keys(plan.services);
  let size = epIds.length * n;
  const observed: [string, number, number][] = [];
  for (const id of svcIds) {
    const o = plan.services[id].observedReplicas;
    if (o) observed.push([id, size, o.length]), (size += o.length);
  }
  const series = new Float64Array(size);
  epIds.forEach((id, k) => {
    const v = traffic.endpoints[id];
    for (let i = 0; i < n; i++) series[k * n + i] = v[i] ?? 0;
  });
  for (const [id, off, len] of observed) {
    const o = plan.services[id].observedReplicas!;
    for (let i = 0; i < len; i++) series[off + i] = o[i] ?? NaN;
  }
  const services = Object.fromEntries(svcIds.map((id) => [id, plan.services[id].observedReplicas ? { ...plan.services[id], observedReplicas: undefined } : plan.services[id]]));
  const [data, events] = wasm.runPlanPacked({ ...plan, services }, { start: traffic.start, stepS: traffic.stepS, n }, epIds, observed, series, opts) as [Float64Array, RunResult['events']];
  let c = 0;
  const take = () => Array.from(data.subarray(c, (c += n)));
  const out: RunResult = { t: take(), rps: take(), errorRate: take(), p99Ms: take(), costPerHour: take(), cost: { compute: take(), requests: take(), transfer: take(), other: take() }, services: {}, endpoints: {}, events };
  for (const id of svcIds) {
    out.services[id] = { rps: take(), util: take(), replicas: take(), waitMs: take(), selfMeanMs: take(), selfP99Ms: take(), backlog: take(), cpuCores: take() };
    if (plan.services[id].memory && n > 0) out.services[id].oomDown = take();
  }
  for (const id of epIds) out.endpoints[id] = { rps: take(), errorRate: take(), meanMs: take(), p99Ms: take(), p50Ms: take(), cost: take() };
  if (plan.cluster) out.cluster = { nodes: take(), requestedCpu: take(), requestedMemoryGb: take() };
  return out;
}

/** the wait a one-core burst sees once it has spent its CFS quota: the rest of the 100 ms period */
export const cfsStallMs = (limit: number | null) => (limit && limit < 1 ? (1 - limit) * 100 : 0);

/** a plan that reproduces the model as it was (observed replicas, no changes) */
export function basePlan(model: Model, observed?: Record<string, Num[] | undefined>): Plan {
  return wasm.basePlan(model, observed) as Plan;
}
