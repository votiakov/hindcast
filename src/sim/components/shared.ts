import { baseLatencyOf, capacityOf, KINDS, type SystemNodeData } from '../catalog';
import type { NodeState } from '../engine';
import type { Behavior, FoldCtx, ProcessCtx, ProcessResult } from './types';

/**
 * Bounded FIFO queue in front of a fixed capacity: the core of most components.
 * Work beyond `queueS` seconds of capacity is shed.
 */
export function queueStage(st: NodeState, arrivals: number, capPerS: number, dt: number, queueS: number) {
  const cap = Math.max(1e-9, capPerS * dt);
  st.queue += arrivals;
  const processed = Math.min(st.queue, cap);
  st.queue -= processed;
  const maxQ = capPerS * queueS;
  let failed = 0;
  if (st.queue > maxQ) {
    failed = st.queue - maxQ;
    st.queue = maxQ;
  }
  return { processed, failed, util: capPerS > 0 ? arrivals / cap : 0 };
}

export const queueSeconds = (ctx: { d: SystemNodeData; cfg: { timeoutS: number } }) => ctx.d.queueS ?? KINDS[ctx.d.kind].queueS ?? ctx.cfg.timeoutS;

/** M/M/1-style service time inflation plus time spent waiting in the queue */
export function serviceLatency(d: SystemNodeData, st: NodeState): number {
  const rho = Math.min(st.util, 0.95);
  return baseLatencyOf(d) / (1 - rho) + (st.queue / Math.max(1, capacityOf(d, st.reachable))) * 1000 + (d.stallRate ?? 0) * (d.stallMs ?? 0);
}

/** instances that get traffic: all of them behind a LB/queue, otherwise just one */
export function reachable(ctx: ProcessCtx): number {
  const up = Math.max(0, (ctx.d.instances ?? 1) - (ctx.d.down ?? 0));
  // a GPU inference pool load-balances internally (vLLM / k8s service), so all GPUs are reachable
  return ctx.pooled || ctx.d.kind === 'llm' ? up : Math.min(1, up);
}

/** process every arrival through the node's own capacity, forward everything processed */
export function processThrough(ctx: ProcessCtx): ProcessResult {
  if (ctx.spec.scalable) ctx.st.reachable = reachable(ctx);
  const q = queueStage(ctx.st, ctx.arrivals, capacityOf(ctx.d, ctx.st.reachable), ctx.dt, queueSeconds(ctx));
  return { processed: q.processed, failed: q.failed, forward: q.processed, util: q.util, up: true };
}

export function foldThrough(ctx: FoldCtx) {
  return {
    success: ctx.keep * (ctx.hasKids ? ctx.childSucc : 1),
    latencyMs: serviceLatency(ctx.d, ctx.st) + (ctx.hasKids ? ctx.childLat : 0),
  };
}

/** default behaviour: app servers, workers, storage, GPU pools… */
export const compute: Behavior = { process: processThrough, fold: foldThrough };
