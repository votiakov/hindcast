import type { KindSpec, SystemNodeData } from '../catalog';
import type { EngineConfig, NodeState } from '../engine';

/** an outgoing connection, resolved */
export interface Route {
  edgeId: string;
  target: string;
  data: SystemNodeData;
  up: boolean;
}

export interface ProcessCtx {
  id: string;
  d: SystemNodeData;
  spec: KindSpec;
  st: NodeState;
  /** request volume that arrived this tick (not a rate) */
  arrivals: number;
  dt: number;
  cfg: EngineConfig;
  readRatio: number;
  /** all outgoing connections */
  routes: Route[];
  /** fed by a LB / gateway / queue, so every instance is reachable */
  pooled: boolean;
  /** clients only: volume to emit this tick */
  emit: number;
}

export interface ProcessResult {
  /** volume handled by this node's own capacity (used for utilisation) */
  processed: number;
  /** volume that failed at this node */
  failed: number;
  /** volume this node sends downstream, before the routing policy splits it */
  forward: number;
  /** children eligible to receive `forward` (default: all routes) */
  routes?: Route[];
  /** explicit share per edge (sums to 1), bypassing the routing policy */
  shares?: Map<string, number>;
  /** share of requests answered without calling downstream (cache hits, db-local) */
  localShare?: number;
  hits?: number;
  /** instantaneous utilisation 0..n */
  util: number;
  /** false = node is down; everything sent to it fails */
  up: boolean;
}

export interface FoldCtx {
  d: SystemNodeData;
  spec: KindSpec;
  st: NodeState;
  up: boolean;
  /** share of arrivals not failed by this node itself */
  keep: number;
  localShare: number;
  /** aggregated success / latency of the downstream call (routing, retries & breaker already applied) */
  childSucc: number;
  childLat: number;
  hasKids: boolean;
  cfg: EngineConfig;
}

export interface Behavior {
  /** forward pass: absorb arrivals, decide what to send downstream */
  process(ctx: ProcessCtx): ProcessResult;
  /** backward pass: end-to-end success probability and mean latency for a request entering this node */
  fold(ctx: FoldCtx): { success: number; latencyMs: number };
  /** usage-based $/h on top of the fixed price */
  usageCostPerHour?(d: SystemNodeData, st: NodeState): number;
}
