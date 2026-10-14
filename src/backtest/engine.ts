import type { Num } from './dataset';
import type { Model } from './model';
import { mmcWait } from './queueing';

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
  memory?: { base: number; perReq: number; spike: number; limit: number };
  /** Kubernetes requests per replica (cores, GiB): what it takes of a node */
  requests?: { cpu: number; memoryGb: number };
  /** $ per replica-hour and per request */
  replicaHour: number;
  perRequest: number;
  /** a cache in front of this service answers this share of calls */
  cache?: { hitRate: number; latencyMs: number; costPerHour: number };
  zone?: string;
  region?: string;
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
  tail: number;
  errorRate: number;
  errorSlope?: number;
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

const RHO_MAX = 0.97;

/** effective visits per request with caches in front of services (a hit skips the whole subtree) */
export function effectiveVisits(ep: EndpointPlan, services: Record<string, ServicePlan>): Record<string, number> {
  const ratio = new Map<string, { to: string; r: number }[]>();
  for (const [k, n] of Object.entries(ep.calls)) {
    const [from, to] = k.split('>');
    const v = ep.visits[from] ?? 0;
    if (!v) continue;
    (ratio.get(from) ?? ratio.set(from, []).get(from)!).push({ to, r: n / v });
  }
  const out: Record<string, number> = { [ep.service]: 1 };
  // breadth-first over the call DAG (cycles are cut after a few passes)
  const order: string[] = [ep.service];
  const seen = new Set(order);
  for (let i = 0; i < order.length; i++) for (const { to } of ratio.get(order[i]) ?? []) if (!seen.has(to)) seen.add(to), order.push(to);
  for (const s of order) {
    if (s === ep.service) continue;
    let v = 0;
    for (const [from, kids] of ratio) for (const k of kids) if (k.to === s) v += (out[from] ?? 0) * k.r;
    const hit = services[s]?.cache?.hitRate ?? 0;
    out[s] = v * (1 - hit);
  }
  return out;
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
export function survival(p: { mean: number; p99: number; p50?: number }, x: number): number {
  if (p.p50 && p.p50 > 0 && p.p99 > p.p50 * 1.01 && x > 0) {
    const sigma = (Math.log(p.p99) - Math.log(p.p50)) / 2.3263;
    return normalTail((Math.log(x) - Math.log(p.p50)) / sigma);
  }
  return exceed(p.mean, p.p99, x);
}

/** p-quantile of a traffic-weighted mixture of endpoint latencies */
export function mixtureQuantile(parts: { w: number; mean: number; p99: number; p50?: number }[], tail = 0.01): number {
  const tot = parts.reduce((s, p) => s + p.w, 0);
  if (tot <= 0) return 0;
  const f = (x: number) => parts.reduce((s, p) => s + (p.w / tot) * survival(p, x), 0) - tail;
  let lo = 0;
  let hi = Math.max(1, ...parts.map((p) => (isFinite(p.p99) ? p.p99 : 1e7))) * 2;
  if (f(hi) > 0) return hi;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

const GB = 2 ** 30;

/** $ per GB moved between two services, from their placement */
export function linkPrice(a: ServicePlan | undefined, b: ServicePlan | undefined, tp: Model['transfer']): number {
  if (!a || !b) return 0;
  if (a.region && b.region && a.region !== b.region) return tp.crossRegionGb;
  if (a.zone && b.zone && a.zone !== b.zone) return 2 * tp.crossZoneGb; // billed on both sides
  return 0;
}

/** seconds an OOM-killed container takes to start serving again, on top of the backoff */
const OOM_RESTART_S = 10;

export function runPlan(plan: Plan, traffic: Traffic, opts: { substepS?: number; faults?: Fault[] } = {}): RunResult {
  const { n, stepS } = traffic;
  const sub = Math.max(1, Math.ceil(stepS / (opts.substepS ?? 5)));
  const dt = stepS / sub;
  const svcIds = Object.keys(plan.services);
  const epIds = Object.keys(plan.endpoints).filter((id) => traffic.endpoints[id]);
  const visits = Object.fromEntries(epIds.map((id) => [id, effectiveVisits(plan.endpoints[id], plan.services)]));
  const baseVisits = Object.fromEntries(epIds.map((id) => [id, plan.endpoints[id].visits]));

  const st = Object.fromEntries(
    svcIds.map((id) => {
      const s = plan.services[id];
      const first = s.observedReplicas?.find((x) => x !== null) ?? null;
      const live = s.replicas ?? first ?? 1;
      return [id, { backlog: 0, live: s.autoscale ? Math.max(s.autoscale.min, Math.min(s.autoscale.max, live)) : live, pending: [] as { at: number; n: number }[], lastScale: -Infinity, nextEval: 0, blockedSaid: false, util: 0, collapsed: false, oomUntil: -Infinity, ooms: 0 }];
    }),
  );
  const epFail = Object.fromEntries(epIds.map((id) => [id, 0]));
  const cl = plan.cluster;
  // an autoscaled pool starts at what the first moment needs
  const CS = { nodes: cl ? (cl.autoscaled ? -1 : cl.nodes) : 0, unneededSince: -Infinity, pendingSaid: false };
  const faults = (opts.faults ?? []).filter((f) => plan.services[f.service]);
  const faultOn = new Set<Fault>();
  type Effect = { capacity: number; down: boolean; extraMs: number; errorRate: number; noScaleOut: boolean; warmupFactor: number; lost: number };
  const effect = (id: string): Effect => {
    const e: Effect = { capacity: 1, down: false, extraMs: 0, errorRate: 0, noScaleOut: false, warmupFactor: 1, lost: 0 };
    for (const f of faultOn) {
      if (f.service !== id) continue;
      if (f.capacity !== undefined) e.capacity *= f.capacity;
      if (f.down) e.down = true;
      e.extraMs += f.extraMs ?? 0;
      e.errorRate = 1 - (1 - e.errorRate) * (1 - (f.errorRate ?? 0));
      if (f.noScaleOut) e.noScaleOut = true;
      if (f.warmupFactor) e.warmupFactor *= f.warmupFactor;
      e.lost += f.replicasLost ?? 0;
    }
    return e;
  };

  const z = () => new Array<number>(n).fill(0);
  const out: RunResult = {
    t: Array.from({ length: n }, (_, i) => traffic.start + i * stepS),
    rps: z(),
    errorRate: z(),
    p99Ms: z(),
    costPerHour: z(),
    cost: { compute: z(), requests: z(), transfer: z(), other: z() },
    services: Object.fromEntries(svcIds.map((id) => [id, { rps: z(), util: z(), replicas: z(), waitMs: z(), selfMeanMs: z(), selfP99Ms: z(), backlog: z(), cpuCores: z() }])),
    endpoints: Object.fromEntries(epIds.map((id) => [id, { rps: z(), errorRate: z(), meanMs: z(), p99Ms: z(), p50Ms: z(), cost: z() }])),
    events: [],
    ...(cl ? { cluster: { nodes: z(), requestedCpu: z(), requestedMemoryGb: z() } } : {}),
  };

  // transfer $ per request per endpoint (static)
  const transferPerReq = Object.fromEntries(
    epIds.map((id) => {
      const ep = plan.endpoints[id];
      let dollars = (ep.egressBytes / GB) * plan.transfer.internetGb;
      for (const [k, bytes] of Object.entries(ep.bytes)) {
        const [from, to] = k.split('>');
        const keep = (visits[id][to] ?? 0) / Math.max(1e-9, baseVisits[id][to] ?? 1);
        const host = (x: string) => plan.services[plan.services[x]?.hostedBy ?? x] ?? plan.services[x];
        dollars += ((bytes * keep) / GB) * linkPrice(host(from), host(to), plan.transfer);
      }
      return [id, dollars];
    }),
  );

  // each endpoint's mean latency with no queueing anywhere (anchors the median's shift)
  const zeroMean = Object.fromEntries(
    epIds.map((e) => {
      const ep = plan.endpoints[e];
      let m = ep.overheadMs;
      for (const [s, w] of Object.entries(ep.weights)) {
        const ps = plan.services[s];
        if (!ps) continue;
        const keep = (visits[e][s] ?? 0) / Math.max(1e-9, ep.visits[s] ?? 1);
        m += w * keep * ps.selfMean + (ps.cache ? w * (1 - keep) * ps.cache.latencyMs : 0);
      }
      return [e, m];
    }),
  );

  const liveOf = (id: string): number => {
    const s = plan.services[id];
    if (s.hostedBy && plan.services[s.hostedBy]) return liveOf(s.hostedBy);
    return st[id].live;
  };

  for (let i = 0; i < n; i++) {
    const acc = {
      rps: 0,
      fail: 0,
      parts: [] as { w: number; mean: number; p99: number }[],
      timeout: 0,
      late: 0,
    };
    for (const id of svcIds) {
      const s = plan.services[id];
      if (!s.autoscale && s.replicas === null && s.observedReplicas) {
        const o = s.observedReplicas[i];
        if (o !== null && o !== undefined) st[id].live = Math.max(0, o);
      }
    }
    for (let k = 0; k < sub; k++) {
      const now = i * stepS + k * dt;
      for (const f of faults) {
        const active = now >= f.at && now < (f.until ?? Infinity);
        if (active && !faultOn.has(f)) {
          faultOn.add(f);
          out.events.push({ t: traffic.start + now, what: f.note ?? `${f.service}: fault starts` });
        } else if (!active && faultOn.has(f)) {
          faultOn.delete(f);
          out.events.push({ t: traffic.start + now, what: `${f.service}: ${f.note ? `ends — ${f.note}` : 'fault ends'}` });
        }
      }
      const fx = Object.fromEntries(svcIds.map((id) => [id, effect(id)]));
      // offered load per endpoint, including client retries of last substep's failures
      const lam: Record<string, number> = {};
      for (const id of epIds) {
        const base = traffic.endpoints[id][i] ?? 0;
        const r = plan.endpoints[id].retries;
        const f = epFail[id];
        let amp = 1;
        if (r && r.attempts > 0) {
          let extra = 0;
          for (let a = 1; a <= r.attempts; a++) extra += f ** a;
          amp = 1 + Math.min(extra, r.budget);
        }
        lam[id] = base * amp;
      }
      // per-service demand
      const svcLam: Record<string, number> = {};
      for (const id of svcIds) svcLam[id] = 0;
      for (const e of epIds) for (const [s, v] of Object.entries(visits[e])) if (s in svcLam) svcLam[s] += lam[e] * v;

      // queues
      const lat: Record<string, { mean: number; p99: number; wait: number; err: number }> = {};
      for (const id of svcIds) {
        const s = plan.services[id];
        const S = st[id];
        const f = fx[s.hostedBy && fx[s.hostedBy]?.down ? s.hostedBy : id];
        const live = Math.max(0, liveOf(id) - fx[s.hostedBy ?? id].lost);
        const perRep = live > 0 ? svcLam[id] / live : svcLam[id] > 0 ? Infinity : 0;
        const K = s.perReplicaRps * fx[id].capacity * (s.hostedBy ? fx[s.hostedBy]?.capacity ?? 1 : 1);
        // OOM: every replica carries the same load, so the working set passes the limit on all of them;
        // they are killed and come back after CrashLoopBackOff (10 s, doubling to 5 min) and a start
        if (s.memory && now >= S.oomUntil && live > 0) {
          const ws = s.memory.base + s.memory.perReq * Math.min(perRep, isFinite(K) ? K * 1.5 : perRep) + s.memory.spike;
          if (ws > s.memory.limit) {
            S.ooms++;
            S.oomUntil = now + Math.min(300, 10 * 2 ** (S.ooms - 1)) + OOM_RESTART_S;
            out.events.push({ t: traffic.start + now, what: `${id}: OOM-killed — working set ${Math.round(ws * 1024)} MiB per container at ${Math.round(perRep)} req/s per replica, limit ${Math.round(s.memory.limit * 1024)} MiB` });
          } else if (now >= S.oomUntil + 600) S.ooms = 0; // ten minutes up: the backoff resets
        }
        const down = f.down || now < S.oomUntil;
        let waitMean = 0;
        let waitP99 = 0;
        if (down) {
          // refused at once: nothing queues
          S.backlog = 0;
        } else if (live <= 0 && svcLam[id] > 0) {
          waitMean = waitP99 = Infinity;
        } else if (isFinite(K)) {
          // a metastable service, once more than a second of work is queued, only finishes its
          // overloaded rate until the queue is empty again
          if (s.overloadedRps && S.backlog > K) S.collapsed = true;
          if (S.collapsed && S.backlog <= 0) S.collapsed = false;
          const Keff = S.collapsed && s.overloadedRps ? Math.min(K, s.overloadedRps * fx[id].capacity) : K;
          const served = Math.min(Keff, perRep + S.backlog / dt);
          S.backlog = Math.max(0, S.backlog + (perRep - served) * dt);
          const w = mmcWait(Math.min(perRep, K * RHO_MAX), s.servers, K);
          const drain = (S.backlog / K) * 1000;
          const v = (s.variability ?? 1) * Math.min(1, w.rho) ** ((s.loadExponent ?? 1) - 1);
          waitMean = v * w.meanMs + drain;
          waitP99 = v * w.p99Ms + drain;
        }
        const ex0 = Math.max(0, s.selfP99 - s.selfMean);
        const extra = fx[id].extraMs;
        const mean = s.selfMean + waitMean + extra;
        const p99 = mean + Math.sqrt(ex0 ** 2 + (s.tail * Math.max(0, waitP99 - waitMean)) ** 2);
        lat[id] = { mean, p99, wait: waitMean, err: down ? 1 : fx[id].errorRate };
        const o = out.services[id];
        o.rps[i] += svcLam[id] / sub;
        o.util[i] += (isFinite(K) && live > 0 ? Math.min(1.5, perRep / K) : 0) / sub;
        o.replicas[i] += live / sub;
        o.waitMs[i] += (isFinite(waitMean) ? waitMean : 1e6) / sub;
        o.selfMeanMs[i] += (isFinite(mean) ? mean : 1e6) / sub;
        o.selfP99Ms[i] += (isFinite(p99) ? p99 : 1e6) / sub;
        o.backlog[i] += S.backlog / sub;
        o.cpuCores[i] += (s.cpu ? live * (s.cpu.base + s.cpu.perReq * Math.min(perRep, K)) : 0) / sub;
        if (s.memory) (o.oomDown ??= z())[i] += (now < S.oomUntil ? 1 : 0) / sub;
      }

      // endpoints: latency along the critical path, failures past the deadline
      for (const e of epIds) {
        const ep = plan.endpoints[e];
        let mean = ep.overheadMs;
        let ex2 = 0;
        for (const [s, w] of Object.entries(ep.weights)) {
          const l = lat[s];
          if (!l) continue;
          const keep = (visits[e][s] ?? 0) / Math.max(1e-9, ep.visits[s] ?? 1);
          const ps = plan.services[s];
          mean += w * keep * l.mean + (ps.cache ? w * (1 - keep) * ps.cache.latencyMs : 0);
          const ex0 = Math.max(0, ps.selfP99 - ps.selfMean);
          ex2 += (w * keep * Math.max(0, l.p99 - l.mean - ex0)) ** 2;
        }
        const p99 = mean + Math.sqrt(ep.baseExcessMs ** 2 + ep.tail ** 2 * ex2);
        const late = exceed(mean, p99, ep.timeoutMs);
        // a failed call to any service on the request's path fails the request
        let ok = 1;
        for (const [s, v] of Object.entries(visits[e])) if (lat[s]?.err) ok *= (1 - lat[s].err) ** Math.max(1, v);
        const base0 = Math.min(1, Math.max(0, ep.errorRate + (ep.errorSlope ?? 0) * (traffic.endpoints[e][i] ?? 0)));
        const fail = 1 - (1 - base0) * (1 - late) * ok;
        epFail[e] = fail;
        const base = traffic.endpoints[e][i] ?? 0;
        // what the client sees: answers capped at its deadline
        // fast failures answer quickly; only requests that ran into the deadline sit at the timeout
        const seenP99 = late > 0.01 ? ep.timeoutMs : Math.min(p99, ep.timeoutMs);
        const seenMean = isFinite(mean) ? Math.min(mean, ep.timeoutMs) : ep.timeoutMs;
        const o = out.endpoints[e];
        o.rps[i] += base / sub;
        o.errorRate[i] += fail / sub;
        // the median moves with the mean: everything that waits, waits for everyone
        const p50 = ep.baseP50Ms ? Math.min(ep.timeoutMs, ep.baseP50Ms + Math.max(0, seenMean - zeroMean[e])) : 0;
        o.meanMs[i] += seenMean / sub;
        o.p99Ms[i] += seenP99 / sub;
        o.p50Ms[i] += p50 / sub;
        acc.rps += base / sub;
        acc.fail += (base * fail) / sub;
        acc.late += (base * late) / sub;
        acc.parts.push({ w: base / sub, mean: seenMean, p99: seenP99, ...(p50 > 0 && late <= 0.01 ? { p50 } : {}) });
        acc.timeout = Math.max(acc.timeout, ep.timeoutMs);
      }

      // cost of this substep, $/h
      let compute = 0;
      let requests = 0;
      const lamTot = epIds.reduce((a, e) => a + lam[e], 0);
      // each component's $/h is shared by the endpoints in proportion to the load they put on it
      // (idle or untraced components by traffic share)
      const share = (id: string, e: string) => {
        const host = svcIds.filter((x) => plan.services[x].hostedBy === id || x === id);
        const load = host.reduce((a, x) => a + svcLam[x], 0);
        if (load > 0) return host.reduce((a, x) => a + lam[e] * (visits[e][x] ?? 0), 0) / load;
        return lamTot > 0 ? lam[e] / lamTot : 1 / Math.max(1, epIds.length);
      };
      // on a cluster, the nodes are the bill: as many as the requests need (autoscaled, removed only
      // after they've been unneeded a while) or the fixed pool. The services' share of them is the
      // node spend less what other teams' pods take; it is spread over the services by their requests
      let nodeScale = 1;
      if (cl) {
        let rc = cl.other.cpu;
        let rm = cl.other.memoryGb;
        let allocated = 0;
        for (const id of svcIds) {
          const s = plan.services[id];
          if (s.hostedBy || !s.requests) continue;
          const pods = st[id].live + st[id].pending.reduce((a, p) => a + p.n, 0);
          rc += pods * s.requests.cpu;
          rm += pods * s.requests.memoryGb;
          allocated += pods * s.replicaHour;
        }
        const ideal = Math.max(rc / cl.node.cpu, rm / cl.node.memoryGb);
        if (cl.autoscaled) {
          const want = Math.min(cl.maxNodes, Math.max(cl.minNodes, Math.ceil(ideal * cl.packing - 1e-9)));
          if (CS.nodes < 0) CS.nodes = want;
          else if (want > CS.nodes) {
            out.events.push({ t: traffic.start + now, what: `cluster: ${CS.nodes} → ${want} nodes (pods request ${rc.toFixed(1)} cores, ${rm.toFixed(1)} GiB)` });
            CS.nodes = want;
            CS.unneededSince = -Infinity;
          } else if (want < CS.nodes) {
            if (!isFinite(CS.unneededSince)) CS.unneededSince = now;
            else if (now - CS.unneededSince >= cl.scaleDownS) {
              out.events.push({ t: traffic.start + now, what: `cluster: ${CS.nodes} → ${want} nodes (unneeded for ${Math.round(cl.scaleDownS / 60)} min)` });
              CS.nodes = want;
              CS.unneededSince = -Infinity;
            }
          } else CS.unneededSince = -Infinity;
        }
        if (ideal > CS.nodes && !CS.pendingSaid) {
          out.events.push({ t: traffic.start + now, what: `cluster: pods request ${rc.toFixed(1)} cores and ${rm.toFixed(1)} GiB, more than ${CS.nodes} nodes hold — some would stay Pending` });
          CS.pendingSaid = true;
        }
        const others = cl.node.perHour * Math.max(cl.other.cpu / cl.node.cpu, cl.other.memoryGb / cl.node.memoryGb) * cl.packing;
        const ours = Math.max(0, CS.nodes * cl.node.perHour - others);
        nodeScale = allocated > 0 ? ours / allocated : 0;
        if (!(allocated > 0)) compute += ours;
        const oc = out.cluster!;
        oc.nodes[i] += CS.nodes / sub;
        oc.requestedCpu[i] += rc / sub;
        oc.requestedMemoryGb[i] += rm / sub;
      }
      for (const id of svcIds) {
        const s = plan.services[id];
        const onNodes = !!cl && !!s.requests && !s.hostedBy;
        const own = (s.hostedBy ? 0 : (st[id].live + st[id].pending.reduce((a, p) => a + p.n, 0)) * s.replicaHour * (onNodes ? nodeScale : 1)) + (s.cache ? s.cache.costPerHour : 0);
        const req = svcLam[id] * 3600 * s.perRequest;
        compute += own;
        requests += req;
        if (own + req > 0) for (const e of epIds) out.endpoints[e].cost[i] += ((own * share(id, e) + req * (svcLam[id] > 0 ? (lam[e] * (visits[e][id] ?? 0)) / svcLam[id] : 0)) * dt) / 3600;
      }
      let transfer = 0;
      for (const e of epIds) {
        transfer += lam[e] * 3600 * transferPerReq[e];
        out.endpoints[e].cost[i] += ((lam[e] * 3600 * transferPerReq[e] + (lamTot > 0 ? (plan.unattributedPerHour * lam[e]) / lamTot : 0)) * dt) / 3600;
      }
      out.cost.compute[i] += (compute * dt) / 3600;
      out.cost.requests[i] += (requests * dt) / 3600;
      out.cost.transfer[i] += (transfer * dt) / 3600;
      out.cost.other[i] += (plan.unattributedPerHour * dt) / 3600;

      // autoscalers
      for (const id of svcIds) {
        const s = plan.services[id];
        const a = s.autoscale;
        if (!a) continue;
        const S = st[id];
        const t = now + dt;
        for (const p of S.pending.filter((p) => p.at <= t)) {
          S.live += p.n;
          out.events.push({ t: traffic.start + t, what: `${id}: ${p.n} new replica${p.n > 1 ? 's' : ''} serving (${S.live})` });
        }
        S.pending = S.pending.filter((p) => p.at > t);
        // what the metric shows: utilisation averaged over its window
        const perRepNow = S.live > 0 ? svcLam[id] / S.live : 0;
        const utilNow = s.cpu && s.cpuLimit ? (s.cpu.base + s.cpu.perReq * Math.min(perRepNow, s.perReplicaRps)) / s.cpuLimit : isFinite(s.perReplicaRps) ? Math.min(perRepNow, s.perReplicaRps) / s.perReplicaRps : 0;
        S.util += (utilNow - S.util) * (1 - Math.exp(-dt / Math.max(dt, (a.metricWindowS ?? 30) / 2)));
        if (t + 1e-9 < S.nextEval) continue;
        S.nextEval = t + a.intervalS;
        const util = S.util;
        const booting = S.pending.reduce((x, p) => x + p.n, 0);
        const desired = Math.min(a.max, Math.max(a.min, Math.ceil((S.live * util) / a.target - 1e-9)));
        if (desired > S.live + booting && fx[id].noScaleOut) {
          if (!S.blockedSaid) out.events.push({ t: traffic.start + t, what: `${id}: wants ${desired} replicas but cannot launch any` });
          S.blockedSaid = true;
        } else if (desired > S.live + booting) {
          S.blockedSaid = false;
          const add = desired - S.live - booting;
          S.pending.push({ at: t + a.warmupS * fx[id].warmupFactor, n: add });
          S.lastScale = t;
          out.events.push({ t: traffic.start + t, what: `${id}: scale out ${S.live + booting} → ${desired} (load ${(util * 100).toFixed(0)}% of target ${(a.target * 100).toFixed(0)}%)` });
        } else if (desired < S.live && !booting && t - S.lastScale >= a.cooldownS) {
          out.events.push({ t: traffic.start + t, what: `${id}: scale in ${S.live} → ${desired}` });
          S.live = desired;
          S.lastScale = t;
        }
      }
    }
    out.rps[i] = acc.rps;
    out.errorRate[i] = acc.rps > 0 ? acc.fail / acc.rps : 0;
    // with more than 1% of requests running into the deadline, the 99th percentile is the timeout
    out.p99Ms[i] = acc.rps > 0 && acc.late / acc.rps > 0.01 ? acc.timeout : Math.min(acc.timeout || Infinity, mixtureQuantile(acc.parts));
    const total = out.cost.compute[i] + out.cost.requests[i] + out.cost.transfer[i] + out.cost.other[i];
    out.costPerHour[i] = (total * 3600) / stepS;
  }
  return out;
}

/** a plan that reproduces the model as it was (observed replicas, no changes) */
export function basePlan(model: Model, observed?: Record<string, Num[] | undefined>): Plan {
  const services: Record<string, ServicePlan> = {};
  for (const [id, s] of Object.entries(model.services)) {
    services[id] = {
      id,
      hostedBy: s.hostedBy,
      replicas: observed?.[id] ? null : s.replicas,
      observedReplicas: observed?.[id],
      perReplicaRps: s.capacity.perReplicaRps,
      overloadedRps: s.capacity.overloadedRps,
      servers: s.capacity.servers,
      selfMean: s.self.mean,
      selfP99: s.self.p99,
      tail: s.tail,
      variability: s.variability,
      loadExponent: s.loadExponent,
      cpu: s.cpu ? { base: s.cpu.base, perReq: s.cpu.perReq } : null,
      cpuLimit: s.cpuLimit,
      ...(s.memory?.limit ? { memory: { base: s.memory.base, perReq: s.memory.perReq, spike: s.memory.spike, limit: s.memory.limit } } : {}),
      ...(s.requests ? { requests: { ...s.requests } } : {}),
      replicaHour: s.cost.perReplicaHour,
      perRequest: s.cost.perRequest,
      zone: s.placement?.zone,
      region: s.placement?.region,
    };
  }
  const endpoints: Record<string, EndpointPlan> = {};
  for (const [id, e] of Object.entries(model.endpoints))
    endpoints[id] = { id, service: e.service, visits: e.visits, calls: e.calls, weights: e.weights, overheadMs: e.overheadMs, baseExcessMs: e.baseExcessMs, baseP50Ms: e.baseP50Ms, tail: e.tail, errorRate: e.errorRate, errorSlope: e.errorSlope, bytes: e.bytes, egressBytes: e.egressBytes, timeoutMs: model.timeoutMs, slo: e.slo };
  const c = model.cluster;
  const cluster: ClusterPlan | undefined = c ? { node: { cpu: c.node.cpu, memoryGb: c.node.memoryGb, perHour: c.node.perHour }, nodes: c.nodes, autoscaled: c.autoscaled, minNodes: c.autoscaled ? 1 : c.nodes, maxNodes: c.autoscaled ? Math.max(c.maxNodes * 4, c.maxNodes + 10) : c.nodes, packing: c.packing, other: { ...c.other }, scaleDownS: 600 } : undefined;
  return { services, endpoints, transfer: model.transfer, unattributedPerHour: model.unattributedPerHour, slo: model.slo, ...(cluster ? { cluster } : {}) };
}
