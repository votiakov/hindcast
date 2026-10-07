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
}

export interface ServicePlan {
  id: string;
  hostedBy?: string;
  /** fixed replica count; null = follow the observed series (or the model's typical count) */
  replicas: number | null;
  observedReplicas?: Num[];
  autoscale?: AutoscalePolicy;
  perReplicaRps: number;
  servers: number;
  selfMean: number;
  selfP99: number;
  tail: number;
  cpu: { base: number; perReq: number } | null;
  cpuLimit: number | null;
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
  tail: number;
  errorRate: number;
  bytes: Record<string, number>;
  egressBytes: number;
  /** client retries per failed request, capped by a budget (share of extra load) */
  retries?: { attempts: number; budget: number };
  timeoutMs: number;
  slo: { p99Ms: number; errorRate: number };
}

export interface Plan {
  services: Record<string, ServicePlan>;
  endpoints: Record<string, EndpointPlan>;
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
}

export interface EndpointTrace {
  rps: number[];
  errorRate: number[];
  meanMs: number[];
  p99Ms: number[];
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
function exceed(mean: number, p99: number, t: number): number {
  if (!isFinite(mean)) return 1;
  const ex = Math.max(1e-6, p99 - mean);
  if (t >= mean) return Math.min(1, 0.01 ** ((t - mean) / ex));
  return Math.min(1, 1 - 0.5 * Math.exp(-(mean - t) / ex));
}

/** p-quantile of a traffic-weighted mixture of endpoint latencies */
function mixtureQuantile(parts: { w: number; mean: number; p99: number }[], tail = 0.01): number {
  const tot = parts.reduce((s, p) => s + p.w, 0);
  if (tot <= 0) return 0;
  const f = (x: number) => parts.reduce((s, p) => s + (p.w / tot) * exceed(p.mean, p.p99, x), 0) - tail;
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

export function runPlan(plan: Plan, traffic: Traffic, opts: { substepS?: number; observedFrom?: number } = {}): RunResult {
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
      return [id, { backlog: 0, live: s.autoscale ? Math.max(s.autoscale.min, Math.min(s.autoscale.max, live)) : live, pending: [] as { at: number; n: number }[], lastScale: -Infinity, nextEval: 0 }];
    }),
  );
  const epFail = Object.fromEntries(epIds.map((id) => [id, 0]));

  const z = () => new Array<number>(n).fill(0);
  const out: RunResult = {
    t: Array.from({ length: n }, (_, i) => traffic.start + i * stepS),
    rps: z(),
    errorRate: z(),
    p99Ms: z(),
    costPerHour: z(),
    cost: { compute: z(), requests: z(), transfer: z(), other: z() },
    services: Object.fromEntries(svcIds.map((id) => [id, { rps: z(), util: z(), replicas: z(), waitMs: z(), selfMeanMs: z(), selfP99Ms: z(), backlog: z(), cpuCores: z() }])),
    endpoints: Object.fromEntries(epIds.map((id) => [id, { rps: z(), errorRate: z(), meanMs: z(), p99Ms: z() }])),
    events: [],
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
      const lat: Record<string, { mean: number; p99: number; wait: number }> = {};
      for (const id of svcIds) {
        const s = plan.services[id];
        const S = st[id];
        const live = liveOf(id);
        const perRep = live > 0 ? svcLam[id] / live : svcLam[id] > 0 ? Infinity : 0;
        const K = s.perReplicaRps;
        let waitMean = 0;
        let waitP99 = 0;
        if (live <= 0 && svcLam[id] > 0) {
          waitMean = waitP99 = Infinity;
        } else if (isFinite(K)) {
          const served = Math.min(K, perRep + S.backlog / dt);
          S.backlog = Math.max(0, S.backlog + (perRep - served) * dt);
          const w = mmcWait(Math.min(perRep, K * RHO_MAX), s.servers, K);
          const drain = (S.backlog / K) * 1000;
          waitMean = w.meanMs + drain;
          waitP99 = w.p99Ms + drain;
        }
        const ex0 = Math.max(0, s.selfP99 - s.selfMean);
        const mean = s.selfMean + waitMean;
        const p99 = mean + Math.sqrt(ex0 ** 2 + (s.tail * Math.max(0, waitP99 - waitMean)) ** 2);
        lat[id] = { mean, p99, wait: waitMean };
        const o = out.services[id];
        o.rps[i] += svcLam[id] / sub;
        o.util[i] += (isFinite(K) && live > 0 ? Math.min(1.5, perRep / K) : 0) / sub;
        o.replicas[i] += live / sub;
        o.waitMs[i] += (isFinite(waitMean) ? waitMean : 1e6) / sub;
        o.selfMeanMs[i] += (isFinite(mean) ? mean : 1e6) / sub;
        o.selfP99Ms[i] += (isFinite(p99) ? p99 : 1e6) / sub;
        o.backlog[i] += S.backlog / sub;
        o.cpuCores[i] += (s.cpu ? live * (s.cpu.base + s.cpu.perReq * Math.min(perRep, K)) : 0) / sub;
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
        const fail = 1 - (1 - ep.errorRate) * (1 - late);
        epFail[e] = fail;
        const base = traffic.endpoints[e][i] ?? 0;
        // what the client sees: answers capped at its deadline
        const seenP99 = fail > 0.01 ? ep.timeoutMs : Math.min(p99, ep.timeoutMs);
        const seenMean = isFinite(mean) ? Math.min(mean, ep.timeoutMs) : ep.timeoutMs;
        const o = out.endpoints[e];
        o.rps[i] += base / sub;
        o.errorRate[i] += fail / sub;
        o.meanMs[i] += seenMean / sub;
        o.p99Ms[i] += seenP99 / sub;
        acc.rps += base / sub;
        acc.fail += (base * fail) / sub;
        acc.parts.push({ w: base / sub, mean: seenMean, p99: seenP99 });
        acc.timeout = Math.max(acc.timeout, ep.timeoutMs);
      }

      // cost of this substep, $/h
      let compute = 0;
      let requests = 0;
      for (const id of svcIds) {
        const s = plan.services[id];
        if (!s.hostedBy) compute += (st[id].live + st[id].pending.reduce((a, p) => a + p.n, 0)) * s.replicaHour;
        requests += svcLam[id] * 3600 * s.perRequest;
        if (s.cache) compute += s.cache.costPerHour;
      }
      let transfer = 0;
      for (const e of epIds) transfer += lam[e] * 3600 * transferPerReq[e];
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
        if (t + 1e-9 < S.nextEval) continue;
        S.nextEval = t + a.intervalS;
        const perRep = S.live > 0 ? svcLam[id] / S.live : 0;
        const util = s.cpu && s.cpuLimit ? (s.cpu.base + s.cpu.perReq * Math.min(perRep, s.perReplicaRps)) / s.cpuLimit : isFinite(s.perReplicaRps) ? perRep / s.perReplicaRps : 0;
        const booting = S.pending.reduce((x, p) => x + p.n, 0);
        const desired = Math.min(a.max, Math.max(a.min, Math.ceil((S.live * util) / a.target - 1e-9)));
        if (desired > S.live + booting) {
          const add = desired - S.live - booting;
          S.pending.push({ at: t + a.warmupS, n: add });
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
    // with more than 1% of requests failing, the 99th percentile is a timeout
    out.p99Ms[i] = out.errorRate[i] > 0.01 ? acc.timeout : Math.min(acc.timeout || Infinity, mixtureQuantile(acc.parts));
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
      servers: s.capacity.servers,
      selfMean: s.self.mean,
      selfP99: s.self.p99,
      tail: s.tail,
      cpu: s.cpu ? { base: s.cpu.base, perReq: s.cpu.perReq } : null,
      cpuLimit: s.cpuLimit,
      replicaHour: s.cost.perReplicaHour,
      perRequest: s.cost.perRequest,
      zone: s.placement?.zone,
      region: s.placement?.region,
    };
  }
  const endpoints: Record<string, EndpointPlan> = {};
  for (const [id, e] of Object.entries(model.endpoints))
    endpoints[id] = { id, service: e.service, visits: e.visits, calls: e.calls, weights: e.weights, overheadMs: e.overheadMs, baseExcessMs: e.baseExcessMs, tail: e.tail, errorRate: e.errorRate, bytes: e.bytes, egressBytes: e.egressBytes, timeoutMs: model.timeoutMs, slo: e.slo };
  return { services, endpoints, transfer: model.transfer, unattributedPerHour: model.unattributedPerHour, slo: model.slo };
}
