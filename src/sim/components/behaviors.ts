import { BATCHING, baseLatencyOf, capacityOf, QUEUE_MAX_BACKLOG, RUNTIMES, requestPrice } from '../catalog';
import { compute, foldThrough, processThrough, queueSeconds, queueStage, serviceLatency } from './shared';
import type { Behavior } from './types';

/** Traffic source. Retries, deadlines and breakers are applied generically by the engine. */
export const client: Behavior = {
  process: (ctx) => ({ processed: ctx.emit, failed: 0, forward: ctx.emit, util: 0, up: ctx.d.alive }),
  fold: (ctx) => ({ success: ctx.hasKids ? ctx.childSucc : 0, latencyMs: ctx.childLat }),
};

/** Load balancer: route only to healthy children. */
export const lb: Behavior = {
  process: (ctx) => {
    const r = processThrough(ctx);
    const routes = ctx.routes.filter((k) => k.up);
    if (!routes.length) return { ...r, failed: r.failed + r.processed, forward: 0, routes };
    return { ...r, routes };
  },
  fold: (ctx) => ({
    success: ctx.hasKids ? ctx.keep * ctx.childSucc : 0,
    latencyMs: serviceLatency(ctx.d, ctx.st) + ctx.childLat,
  }),
};

/** API gateway: LB + rate limit. Over-limit requests get a fast 429. */
export const gateway: Behavior = {
  process: (ctx) => {
    const limit = ctx.d.limit ?? Infinity;
    const processed = Math.min(ctx.arrivals, limit * ctx.dt);
    const routes = ctx.routes.filter((k) => k.up);
    const failed = ctx.arrivals - processed + (routes.length ? 0 : processed);
    return { processed, failed, forward: routes.length ? processed : 0, routes, util: ctx.arrivals / (limit * ctx.dt), up: true };
  },
  fold: (ctx) => ({ success: ctx.hasKids ? ctx.keep * ctx.childSucc : 0, latencyMs: ctx.spec.baseLatencyMs + ctx.childLat }),
};

/** Cache / CDN: answer `hitRate` locally, forward misses. No origin → misses fail. */
export const cache: Behavior = {
  process: (ctx) => {
    const r = processThrough(ctx);
    const h = ctx.d.hitRate ?? 0.85;
    const hits = r.processed * h;
    let forward = r.processed - hits;
    let failed = r.failed;
    if (!ctx.routes.length) {
      failed += forward;
      forward = 0;
    }
    return { ...r, failed, forward, hits, localShare: h };
  },
  fold: (ctx) => ({
    success: ctx.keep * (ctx.localShare + (1 - ctx.localShare) * (ctx.hasKids ? ctx.childSucc : 1)),
    latencyMs: serviceLatency(ctx.d, ctx.st) + (1 - ctx.localShare) * ctx.childLat,
  }),
};

/**
 * Primary database. Writes stay here; reads are shared evenly with live replica children.
 * A dead primary with replicas elects one after `failoverS`; until then reads still work.
 */
export const db: Behavior = {
  process: (ctx) => {
    const { d, st, dt, cfg, readRatio } = ctx;
    const writeRatio = 1 - readRatio;
    let replicas = ctx.routes.filter((k) => k.data.kind === 'replica' && k.up);
    st.failover = 'none';
    let shares: Map<string, number> | undefined;
    if (!d.alive) {
      st.downFor += dt;
      if (replicas.length && cfg.failoverS !== null) {
        if (st.downFor >= cfg.failoverS) {
          // first replica is the new primary: all writes plus its share of reads
          st.failover = 'promoted';
          shares = new Map(replicas.map((k, i) => [k.edgeId, readRatio / replicas.length + (i === 0 ? writeRatio : 0)]));
        } else st.failover = 'electing';
      }
    } else st.downFor = 0;

    if (!d.alive && st.failover === 'none') {
      st.queue = 0;
      return { processed: 0, failed: ctx.arrivals, forward: 0, util: 0, up: false };
    }
    if (st.failover === 'promoted') {
      st.queue = 0;
      return { processed: 0, failed: 0, forward: ctx.arrivals, routes: replicas, shares, localShare: 0, util: 0, up: true };
    }
    const localShare = writeRatio + readRatio / (replicas.length + 1);
    const toReplicas = ctx.arrivals * (1 - localShare);
    const capPerS = st.failover === 'electing' ? 0 : capacityOf(d);
    const q = queueStage(st, ctx.arrivals - toReplicas, capPerS, dt, queueSeconds(ctx));
    return { processed: q.processed, failed: q.failed, forward: toReplicas, routes: (replicas = replicas), localShare, util: q.util, up: true };
  },
  fold: (ctx) => ({
    success: ctx.localShare * ctx.keep + (1 - ctx.localShare) * (ctx.hasKids ? ctx.childSucc : 1),
    latencyMs: ctx.localShare * serviceLatency(ctx.d, ctx.st) + (1 - ctx.localShare) * ctx.childLat,
  }),
};

/** Queue: producers succeed on enqueue; consumers drain at their combined capacity. */
export const queue: Behavior = {
  process: (ctx) => {
    const { st } = ctx;
    st.queue += ctx.arrivals;
    let failed = 0;
    if (st.queue > QUEUE_MAX_BACKLOG) {
      failed = st.queue - QUEUE_MAX_BACKLOG;
      st.queue = QUEUE_MAX_BACKLOG;
    }
    const routes = ctx.routes.filter((k) => k.up);
    const drain = routes.reduce((sum, k) => sum + capacityOf(k.data), 0);
    st.drainRps = drain;
    const processed = Math.min(st.queue, drain * ctx.dt);
    st.queue -= processed;
    return { processed, failed, forward: processed, routes, util: st.queue / QUEUE_MAX_BACKLOG, up: true };
  },
  // async: the producer only waits for the enqueue ack
  fold: (ctx) => ({ success: ctx.keep, latencyMs: ctx.spec.baseLatencyMs }),
};

/** Serverless: scales to a concurrency limit, cold starts while the warm pool catches up. */
export const fn: Behavior = {
  process: (ctx) => {
    const { st, dt } = ctx;
    const cap = capacityOf(ctx.d) * dt;
    const processed = Math.min(ctx.arrivals, cap);
    const demand = ctx.arrivals / dt;
    const k = (tau: number) => 1 - Math.exp(-dt / tau);
    st.warm += (demand - st.warm) * k(demand > st.warm ? 4 : 1);
    st.coldFrac = demand > 0.5 ? Math.max(0, (demand - st.warm) / demand) : 0;
    return { processed, failed: ctx.arrivals - processed, forward: processed, util: ctx.arrivals / cap, up: true };
  },
  fold: (ctx) => ({
    success: ctx.keep * (ctx.hasKids ? ctx.childSucc : 1),
    latencyMs:
      baseLatencyOf(ctx.d) +
      ctx.st.coldFrac * (ctx.cfg.coldStartMs > 0 && ctx.d.runtime ? RUNTIMES[ctx.d.runtime].coldStartMs : ctx.cfg.coldStartMs) +
      (ctx.hasKids ? ctx.childLat : 0),
  }),
  usageCostPerHour: (d, st) => st.inRps * 3600 * requestPrice(d),
};

/** Hosted LLM API: provider scales for you, but rate-limits (429) and bills per request. Latency doesn't grow with your load. */
export const llmapi: Behavior = {
  process: (ctx) => {
    const cap = capacityOf(ctx.d) * ctx.dt;
    const processed = Math.min(ctx.arrivals, cap);
    return { processed, failed: ctx.arrivals - processed, forward: processed, util: ctx.arrivals / cap, up: true };
  },
  fold: (ctx) => ({ success: ctx.keep * (ctx.hasKids ? ctx.childSucc : 1), latencyMs: (ctx.d.latencyMs ?? ctx.spec.baseLatencyMs) + (ctx.hasKids ? ctx.childLat : 0) }),
  usageCostPerHour: (d, st) => (st.inRps - st.dropRps) * 3600 * (d.costPerHour === undefined ? requestPrice(d) : 0),
};

/** Self-hosted GPU inference: a compute pool with long service times and optional batching. */
export const llm: Behavior = {
  process: processThrough,
  fold: foldThrough,
};

export { compute, BATCHING };
