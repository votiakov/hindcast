import { KINDS, baseLatencyOf, cacheWarmth, costOf, isUp, perInstanceCapacity, requestPrice, type RetryPolicy, type SystemEdge, type SystemNode, type SystemNodeData } from './catalog';
import { billedInstances, effectiveData, newScaler, stepScaler, type ScalerState } from './autoscale';
import { BEHAVIORS, type Route } from './components';

/**
 * Fluid, tick-based queueing simulation.
 *
 * Each tick, request *volume* flows from clients through the graph in topological order
 * (forward pass), then end-to-end success and latency fold back from the leaves (backward pass).
 *
 * The engine is generic. Per-kind behaviour lives in ./components (one Behavior per kind);
 * this file owns everything that applies to any node:
 *   - routing policy across children: split | fanout | failover
 *   - retries (immediate | backoff | budget), driven by last tick's downstream failure rate
 *   - circuit breakers with optional fallback responses
 *   - caller deadlines (responses slower than `timeoutMs` count as failures)
 *   - utilisation, history, alerts, cost and global SLO numbers
 */

/** knobs that change the physics of the simulation (UI-only toggles live in the store) */
export interface EngineConfig {
  /** default bounded-queue length (s); failed requests count as this latency in p99 */
  timeoutS: number;
  /** seconds to elect a replica after the primary dies; null = no automatic failover */
  failoverS: number | null;
  /** extra latency for requests that hit a cold serverless instance; 0 = no cold starts */
  coldStartMs: number;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = { timeoutS: 1, failoverS: 3, coldStartMs: 400 };

const HISTORY_LEN = 90;
const HISTORY_EVERY_S = 0.25;
const BREAKER = { tripFail: 0.5, tripAfterS: 1, openS: 5, probeOpen: 0.02, probeHalf: 0.2, closeFail: 0.1 };
const BACKOFF = { spread: 0.3, delayMs: 200 };
const RETRY_BUDGET = 0.1;

export type BreakerState = 'closed' | 'open' | 'half';

export interface NodeStats {
  inRps: number;
  dropRps: number;
  util: number;
  queue: number;
  /** mean latency for requests entering this node (incl. downstream) */
  latencyMs: number;
  /** probability a request entering this node succeeds end-to-end */
  success: number;
  hitRps: number;
  /** instances actually receiving traffic (servers without a LB only expose one) */
  reachable: number;
  /** queue: seconds of backlog at current drain rate */
  lagS: number;
  /** function: share of requests hitting a cold start */
  coldFrac: number;
  /** db: failover status; replica: 'promoted' when it became the primary */
  failover: 'none' | 'electing' | 'promoted';
  costPerHour: number;
  /** outgoing calls per incoming request (retries) */
  retryAmp: number;
  breaker: BreakerState | null;
  /** share of responses that arrived after this caller's deadline */
  lateFrac: number;
  history: number[];
  /** autoscaled nodes: serving / booting / wanted */
  scaling: { live: number; pending: number; desired: number } | null;
  /** cache / cdn: 0 (cold) … 1 (warm) */
  warmth: number;
}

export interface EdgeStats {
  rps: number;
  errRatio: number;
  util: number;
}

export interface GlobalStats {
  t: number;
  rps: number;
  errorRate: number;
  p99: number;
  cost: number;
  history: { rps: number; err: number; p99: number; cost: number }[];
}

export interface SimEvent {
  kind: 'overload' | 'recovered' | 'failover' | 'breaker-open' | 'breaker-closed' | 'scale-out' | 'scale-in';
  nodeId: string;
  name: string;
  detail?: string;
}

export interface NodeState {
  queue: number;
  inRps: number;
  dropRps: number;
  hitRps: number;
  util: number;
  success: number;
  latencyMs: number;
  dropRatio: number;
  history: number[];
  overloaded: boolean;
  reachable: number;
  drainRps: number;
  warm: number;
  coldFrac: number;
  downFor: number;
  costPerHour: number;
  failover: NodeStats['failover'];
  /** failure rate of one downstream attempt, last tick (drives retries & breaker) */
  attemptFail: number;
  retryAmp: number;
  breaker: BreakerState;
  breakerT: number;
  /** pass-through fraction the breaker allowed this tick */
  breakerPass: number;
  lateFrac: number;
  /** cache: when it went cold (null = warm), and the flush counter last seen */
  coldAt: number | null;
  flushSeen: number;
  warmth: number;
}

interface Local {
  localShare: number;
  routes: Route[];
  /** volume sent per edge */
  flows: Map<string, number>;
  mode: 'split' | 'fanout' | 'failover';
  up: boolean;
}

const ema = (prev: number, next: number, dt: number, tau = 0.6) => prev + (next - prev) * (1 - Math.exp(-dt / tau));
const fresh = (): NodeState => ({
  queue: 0, inRps: 0, dropRps: 0, hitRps: 0, util: 0, success: 1, latencyMs: 0, dropRatio: 0, history: [],
  overloaded: false, reachable: 1, drainRps: 0, warm: 0, coldFrac: 0, downFor: 0, costPerHour: 0, failover: 'none',
  attemptFail: 0, retryAmp: 1, breaker: 'closed', breakerT: 0, breakerPass: 1, lateFrac: 0,
  coldAt: null, flushSeen: 0, warmth: 1,
});

/**
 * Node data with dynamic effects applied: autoscaled instance count, and the throughput lost to
 * injected latency (a pool of workers that each take longer serves fewer requests per second).
 */
export function dynamicData(d: SystemNodeData, scaler: ScalerState | undefined): SystemNodeData {
  let e = effectiveData(d, scaler);
  if (e.faultLatencyMs && d.kind !== 'gateway' && d.kind !== 'llmapi' && d.kind !== 'client' && d.kind !== 'queue') {
    const base = Math.max(0.05, baseLatencyOf(d));
    e = { ...e, degraded: (e.degraded ?? 1) * (base / (base + e.faultLatencyMs)) };
  }
  return e;
}

/** outgoing attempts per original call, given per-attempt failure rate f */
export function retryAmp(f: number, retries: number, policy: RetryPolicy): number {
  let sum = 0;
  for (let k = 0; k <= retries; k++) sum += f ** k;
  if (policy === 'backoff') return 1 + (sum - 1) * BACKOFF.spread; // retries spread out over time
  if (policy === 'budget') return Math.min(sum, 1 + RETRY_BUDGET); // at most +10% extra load
  return sum;
}

/** end-to-end success after retries, given per-attempt success s */
function retrySuccess(s: number, retries: number, policy: RetryPolicy, amp: number): number {
  const f = 1 - s;
  if (policy === 'budget') return s + Math.min(f, amp - 1) * s;
  return 1 - f ** (retries + 1);
}

/**
 * Failover order: live children first, then cheapest-first (pay-per-request services such as LLM
 * APIs and serverless last), otherwise connection order. "Self-hosted first, paid API as overflow."
 */
export function failoverOrder<T extends { up: boolean; data: SystemNodeData }>(targets: T[]): T[] {
  const usage = (d: SystemNodeData) => (KINDS[d.kind].costPerRequest ? 1 : 0);
  return [...targets].sort((a, b) => Number(b.up) - Number(a.up) || usage(a.data) - usage(b.data));
}

/**
 * Expected max of N long-tailed latencies relative to one (extreme-value approximation for the
 * fluid engine; the DES computes it exactly). ≈ 1 + cv·√(2 ln N) with cv ≈ 0.6.
 */
export const fanoutTail = (n: number) => (n <= 1 ? 1 : 1 + 0.6 * Math.sqrt(2 * Math.log(n)));

/** share of responses arriving after a deadline (smooth ramp around it) */
const lateFrac = (latMs: number, deadlineMs: number) => Math.min(1, Math.max(0, (latMs - 0.8 * deadlineMs) / (0.4 * deadlineMs)));

export class Engine {
  t = 0;
  private nodes = new Map<string, NodeState>();
  private edges = new Map<string, { rps: number }>();
  private scalers = new Map<string, ScalerState>();
  private global: GlobalStats = { t: 0, rps: 0, errorRate: 0, p99: 0, cost: 0, history: [] };
  private sinceHistory = 0;

  reset() {
    this.t = 0;
    this.nodes.clear();
    this.edges.clear();
    this.scalers.clear();
    this.global = { t: 0, rps: 0, errorRate: 0, p99: 0, cost: 0, history: [] };
    this.sinceHistory = 0;
  }

  private state(id: string): NodeState {
    let s = this.nodes.get(id);
    if (!s) {
      s = fresh();
      this.nodes.set(id, s);
    }
    return s;
  }

  /** advance the breaker state machine; returns the share of calls allowed through */
  private breakerPass(d: SystemNodeData, st: NodeState, dt: number, events: SimEvent[], id: string): number {
    if (!d.breaker) {
      st.breaker = 'closed';
      return 1;
    }
    const prev = st.breaker;
    st.breakerT += dt;
    if (st.breaker === 'closed') {
      if (st.attemptFail > BREAKER.tripFail) {
        if (st.breakerT >= BREAKER.tripAfterS) [st.breaker, st.breakerT] = ['open', 0];
      } else st.breakerT = 0;
    } else if (st.breaker === 'open') {
      if (st.breakerT >= BREAKER.openS) [st.breaker, st.breakerT] = ['half', 0];
    } else if (st.breakerT >= 1) {
      if (st.attemptFail < BREAKER.closeFail) [st.breaker, st.breakerT] = ['closed', 0];
      else if (st.attemptFail > BREAKER.tripFail) [st.breaker, st.breakerT] = ['open', 0];
    }
    if (prev !== 'open' && st.breaker === 'open') events.push({ kind: 'breaker-open', nodeId: id, name: d.name });
    if (prev !== 'closed' && st.breaker === 'closed') events.push({ kind: 'breaker-closed', nodeId: id, name: d.name });
    return st.breaker === 'open' ? BREAKER.probeOpen : st.breaker === 'half' ? BREAKER.probeHalf : 1;
  }

  /** @param trafficRps total requests/sec sent by all clients  @param readRatio share of reads (0..1) */
  step(nodes: SystemNode[], edges: SystemEdge[], trafficRps: number, readRatio: number, dt: number, cfg: EngineConfig = DEFAULT_ENGINE_CONFIG): SimEvent[] {
    this.t += dt;
    const events: SimEvent[] = [];
    const now = this.t;
    const original = new Map(nodes.map((n) => [n.id, n.data]));
    nodes = nodes.map((n) => {
      if (n.data.autoscale && KINDS[n.data.kind].scalable) {
        if (!this.scalers.has(n.id)) this.scalers.set(n.id, newScaler(n.data));
      } else this.scalers.delete(n.id);
      const e = dynamicData(n.data, this.scalers.get(n.id));
      return e === n.data ? n : { ...n, data: e };
    });
    const edgeLat = new Map<string, number>();
    for (const e of edges) if (e.data?.latencyMs) edgeLat.set(e.id, Number(e.data.latencyMs));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const out = new Map<string, Route[]>();
    const indeg = new Map<string, number>(nodes.map((n) => [n.id, 0]));
    const pooled = new Set<string>(); // nodes whose instances are all reachable
    for (const e of edges) {
      if (!byId.has(e.source) || !byId.has(e.target) || e.source === e.target) continue;
      const sk = byId.get(e.source)!.data.kind;
      // instances are reachable behind a balancer/queue, or when a scatter-gather caller addresses partitions
      if (sk === 'lb' || sk === 'gateway' || sk === 'queue' || (byId.get(e.source)!.data.fanout ?? 1) > 1) pooled.add(e.target);
      const data = byId.get(e.target)!.data;
      if (!out.has(e.source)) out.set(e.source, []);
      out.get(e.source)!.push({ edgeId: e.id, target: e.target, data, up: isUp(data) });
      indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
    }

    // Kahn topological order; nodes in cycles get appended at the end.
    const order: string[] = [];
    const ready = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
    const seen = new Set<string>();
    while (ready.length) {
      const id = ready.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      order.push(id);
      for (const k of out.get(id) ?? []) {
        indeg.set(k.target, indeg.get(k.target)! - 1);
        if (indeg.get(k.target) === 0) ready.push(k.target);
      }
    }
    for (const n of nodes) if (!seen.has(n.id)) order.push(n.id);

    const inflow = new Map<string, number>();
    const edgeFlow = new Map<string, number>();
    const local = new Map<string, Local>();
    const promotedReplicas = new Set<string>();

    const clients = nodes.filter((n) => n.data.kind === 'client' && n.data.alive);
    const perClient = clients.length ? (trafficRps * dt) / clients.length : 0;

    // ---- forward pass ----
    for (const id of order) {
      const d = byId.get(id)!.data;
      const st = this.state(id);
      const spec = KINDS[d.kind];
      const routes = out.get(id) ?? [];
      const arrivals = d.kind === 'client' ? (d.alive ? perClient : 0) : inflow.get(id) ?? 0;
      if (d.kind === 'replica') st.failover = promotedReplicas.has(id) ? 'promoted' : 'none';
      if (d.kind === 'cache' || d.kind === 'cdn') {
        // a dead or flushed cache comes back empty and re-warms from misses
        if (!isUp(d) || (d.flushes ?? 0) !== st.flushSeen) st.coldAt = now;
        st.flushSeen = d.flushes ?? 0;
        st.warmth = cacheWarmth(st.coldAt, now, d.warmupS);
        if (st.warmth > 0.999) st.coldAt = null;
      }

      // a dead node fails everything (databases handle their own failover)
      let r;
      if (!isUp(d) && d.kind !== 'db' && d.kind !== 'client') {
        st.queue = 0;
        r = { processed: 0, failed: arrivals, forward: 0, util: 0, up: false } as const;
      } else r = BEHAVIORS[d.kind].process({ id, d, spec, st, arrivals, dt, cfg, readRatio, routes, pooled: pooled.has(id), emit: arrivals });

      // gray failure: the node answers a share of what it handles with errors, without calling on
      if (d.faultRate && r.up && d.kind !== 'client') {
        const bad = r.processed * d.faultRate;
        r = { ...r, failed: r.failed + bad, forward: r.forward * (1 - d.faultRate), hits: ('hits' in r ? r.hits ?? 0 : 0) * (1 - d.faultRate) };
      }

      if (d.kind === 'db' && st.failover === 'promoted' && r.routes?.length) promotedReplicas.add(r.routes[0].target);

      // generic caller behaviour: breaker first, then retries on whatever passes
      const targets = r.routes ?? routes;
      st.breakerPass = targets.length ? this.breakerPass(d, st, dt, events, id) : 1;
      const retries = d.retries ?? 0;
      st.retryAmp = retries > 0 && targets.length ? retryAmp(st.attemptFail, retries, d.retryPolicy ?? 'immediate') : 1;
      const forward = r.forward * st.breakerPass * st.retryAmp * Math.max(1, d.fanout ?? 1);

      // routing policy
      const flows = new Map<string, number>();
      const mode = r.shares ? 'split' : d.routing ?? 'split';
      if (targets.length && forward > 0) {
        if (r.shares) for (const k of targets) flows.set(k.edgeId, forward * (r.shares.get(k.edgeId) ?? 0));
        else if (mode === 'fanout') for (const k of targets) flows.set(k.edgeId, forward);
        else if (mode === 'failover') {
          // children in order; whatever one failed last tick spills over to the next
          let remaining = forward;
          for (const k of failoverOrder(targets)) {
            flows.set(k.edgeId, remaining);
            remaining *= k.up ? 1 - this.state(k.target).success : 1;
            if (remaining < 1e-9) break;
          }
        } else for (const k of targets) flows.set(k.edgeId, forward / targets.length);
        for (const [eid, v] of flows) {
          const k = targets.find((x) => x.edgeId === eid)!;
          inflow.set(k.target, (inflow.get(k.target) ?? 0) + v);
          edgeFlow.set(eid, (edgeFlow.get(eid) ?? 0) + v);
        }
      }

      st.inRps = ema(st.inRps, arrivals / dt, dt);
      st.dropRps = ema(st.dropRps, r.failed / dt, dt);
      st.hitRps = ema(st.hitRps, ('hits' in r ? r.hits ?? 0 : 0) / dt, dt);
      st.util = ema(st.util, r.util, dt, 0.4);
      const localShare = 'localShare' in r ? r.localShare ?? 1 : 1;
      const own = d.kind === 'db' ? arrivals * localShare : arrivals;
      st.dropRatio = ema(st.dropRatio, own > 0 ? r.failed / own : 0, dt);
      local.set(id, { localShare, routes: targets, flows, mode, up: r.up });
    }

    // ---- backward pass ----
    for (let i = order.length - 1; i >= 0; i--) {
      const id = order[i];
      const d = byId.get(id)!.data;
      const st = this.state(id);
      const spec = KINDS[d.kind];
      const { routes, localShare, flows, mode, up } = local.get(id)!;
      const hasKids = routes.length > 0;

      // aggregate one downstream attempt according to the routing policy
      let succ = 1;
      let lat = 0;
      if (hasKids) {
        const kids = routes.map((k) => {
          const s = this.state(k.target);
          const link = edgeLat.get(k.edgeId) ?? 0;
          return { s: link ? { ...s, latencyMs: s.latencyMs + link } : s, f: flows.get(k.edgeId) ?? 0 };
        });
        if (mode === 'fanout') {
          succ = kids.reduce((p, k) => p * k.s.success, 1);
          lat = Math.max(...kids.map((k) => k.s.latencyMs));
        } else if (mode === 'failover') {
          let miss = 1;
          for (const k of kids.filter((x) => x.f > 0)) {
            lat += miss * k.s.latencyMs;
            miss *= 1 - k.s.success;
          }
          succ = 1 - miss;
        } else {
          let w = 0;
          let s = 0;
          for (const k of kids) {
            const wk = k.f > 0 ? k.f : 1e-9;
            w += wk;
            s += k.s.success * wk;
            lat += k.s.latencyMs * wk;
          }
          succ = s / w;
          lat /= w;
        }
      }

      // scatter-gather: every partition must answer, and the caller waits for the slowest
      const degree = Math.max(1, d.fanout ?? 1);
      if (degree > 1 && hasKids) {
        succ = succ ** degree;
        // waiting for the slowest of N: the body of the distribution stretches, and a rare
        // per-partition stall becomes likely for the whole request (1 − (1 − p)^N)
        const kd = routes[0].data;
        const p = kd.stallRate ?? 0;
        lat = lat * fanoutTail(degree) + (1 - (1 - p) ** degree - p) * (kd.stallMs ?? 0);
      }

      // caller deadline: answers slower than timeoutMs are failures to the caller
      st.lateFrac = d.timeoutMs && hasKids ? lateFrac(lat, d.timeoutMs) : 0;
      const attempt = succ * (1 - st.lateFrac);
      if (d.timeoutMs) lat = Math.min(lat, d.timeoutMs);
      st.attemptFail = hasKids ? 1 - attempt : 0;

      // retries, then breaker (blocked calls fail fast or get the fallback)
      let childSucc = attempt;
      let childLat = lat;
      const retries = d.retries ?? 0;
      if (retries > 0 && hasKids) {
        const policy = d.retryPolicy ?? 'immediate';
        childSucc = retrySuccess(attempt, retries, policy, st.retryAmp);
        childLat = lat * st.retryAmp + (policy === 'backoff' ? (st.retryAmp - 1) * BACKOFF.delayMs * 4 : 0);
      }
      if (st.breakerPass < 1) {
        const p = st.breakerPass;
        childSucc = p * childSucc + (1 - p) * (d.fallback ? 1 : 0);
        childLat = p * childLat + (1 - p) * 2;
      }

      const keep = 1 - st.dropRatio;
      const res = up ? BEHAVIORS[d.kind].fold({ d, spec, st, up, keep, localShare, childSucc, childLat, hasKids, cfg }) : { success: 0, latencyMs: 0 };
      if (up && d.faultLatencyMs) res.latencyMs += d.faultLatencyMs;
      st.success = ema(st.success, res.success, dt, 0.3);
      st.latencyMs = ema(st.latencyMs, res.latencyMs, dt, 0.3);
      const usage = BEHAVIORS[d.kind].usageCostPerHour;
      const scaler = this.scalers.get(id);
      st.costPerHour = costOf(scaler ? { ...d, instances: billedInstances(scaler) } : d) + (usage ? usage(d, st) : st.inRps * 3600 * requestPrice(d));

      const over = up && d.kind !== 'client' && d.kind !== 'queue' && st.dropRps > Math.max(1, st.inRps * 0.02);
      if (over && !st.overloaded) events.push({ kind: 'overload', nodeId: id, name: d.name });
      if (!over && st.overloaded) events.push({ kind: 'recovered', nodeId: id, name: d.name });
      st.overloaded = over;
      if (d.kind === 'db' && st.failover === 'promoted' && cfg.failoverS !== null && st.downFor - dt < cfg.failoverS) events.push({ kind: 'failover', nodeId: id, name: d.name });
    }

    // autoscalers react to the demand they saw this tick
    for (const [id, sc] of this.scalers) {
      const orig = original.get(id);
      if (!orig) continue;
      for (const ev of stepScaler(sc, orig, now, this.state(id).inRps, perInstanceCapacity(orig)))
        if (ev.kind !== 'scaled') events.push({ kind: ev.kind, nodeId: id, name: orig.name, detail: `${ev.from} → ${ev.to}` });
    }

    const live = new Set(edges.map((e) => e.id));
    for (const eid of this.edges.keys()) if (!live.has(eid)) this.edges.delete(eid);
    for (const e of edges) {
      const es = this.edges.get(e.id) ?? { rps: 0 };
      es.rps = ema(es.rps, (edgeFlow.get(e.id) ?? 0) / dt, dt);
      this.edges.set(e.id, es);
    }
    for (const id of this.nodes.keys()) if (!byId.has(id)) this.nodes.delete(id);

    // ---- global ----
    let rps = 0;
    let ok = 0;
    let lat = 0;
    for (const c of clients) {
      const st = this.state(c.id);
      rps += st.inRps;
      ok += st.inRps * st.success;
      lat += st.inRps * st.latencyMs;
    }
    const g = this.global;
    g.t = this.t;
    g.rps = rps;
    g.errorRate = rps > 0.5 ? Math.max(0, 1 - ok / rps) : 0;
    // failed requests count as timeouts: with ≥1% failures the 99th percentile *is* a failure
    const okLat = ok > 0 ? (lat / rps) * 1.8 : 0;
    g.p99 = rps < 0.5 ? 0 : g.errorRate >= 0.01 ? Math.max(okLat, cfg.timeoutS * 1000) : okLat;
    g.cost = nodes.reduce((sum, n) => sum + this.state(n.id).costPerHour, 0);

    this.sinceHistory += dt;
    if (this.sinceHistory >= HISTORY_EVERY_S) {
      this.sinceHistory = 0;
      g.history = [...g.history, { rps: g.rps, err: g.errorRate, p99: g.p99, cost: g.cost }].slice(-HISTORY_LEN);
      for (const [, st] of this.nodes) st.history = [...st.history, st.util].slice(-HISTORY_LEN);
    }
    return events;
  }

  snapshot(nodes: SystemNode[], edges: SystemEdge[]) {
    const nodeStats: Record<string, NodeStats> = {};
    for (const n of nodes) {
      const st = this.state(n.id);
      nodeStats[n.id] = {
        inRps: st.inRps,
        dropRps: st.dropRps,
        util: st.util,
        queue: st.queue,
        latencyMs: st.latencyMs,
        success: st.success,
        hitRps: st.hitRps,
        reachable: st.reachable,
        lagS: st.drainRps > 0 ? st.queue / st.drainRps : st.queue > 1 ? Infinity : 0,
        coldFrac: st.coldFrac,
        failover: st.failover,
        costPerHour: st.costPerHour,
        retryAmp: st.retryAmp,
        breaker: n.data.breaker ? st.breaker : null,
        lateFrac: st.lateFrac,
        history: st.history,
        scaling: this.scalers.has(n.id) ? { live: this.scalers.get(n.id)!.live, pending: this.scalers.get(n.id)!.pending.length, desired: this.scalers.get(n.id)!.desired } : null,
        warmth: st.warmth,
      };
    }
    const edgeStats: Record<string, EdgeStats> = {};
    for (const e of edges) {
      const t = this.state(e.target);
      edgeStats[e.id] = { rps: this.edges.get(e.id)?.rps ?? 0, errRatio: 1 - t.success, util: t.util };
    }
    return { nodeStats, edgeStats, global: { ...this.global } };
  }
}
