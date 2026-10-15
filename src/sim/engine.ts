import {  type RetryPolicy, type SystemEdge, type SystemNode } from './catalog';
import { getPricing } from './pricing';
import * as wasm from '../backtest/wasm/hindcast_engine.js';

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

const BACKOFF = { spread: 0.3, delayMs: 200 };
const RETRY_BUDGET = 0.1;

export type BreakerState = 'closed' | 'open' | 'half';

export interface NodeStats {
  /** a replica: how far behind its primary, s */
  replLagS?: number;
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
  /** thread-per-request: how long a request waits on this component's calls, ms (a thread is held for it) */
  holdMs?: number;
  /** its own time per request, ms: work and queue, not what it waits on */
  ownMs?: number;
  /** a queue with a redrive policy: messages a second sent to the dead-letter queue */
  deadLetterRps?: number;
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
  /** writes acknowledged and then lost (a write-behind cache that died) */
  lostWrites: number;
  /** reads answered by a replica more than a second behind its primary */
  staleReads: number;
  /** the furthest any replica is behind its primary, s */
  replicaLagS: number;
  history: { rps: number; err: number; p99: number; cost: number }[];
}

export interface SimEvent {
  kind: 'overload' | 'recovered' | 'failover' | 'breaker-open' | 'breaker-closed' | 'scale-out' | 'scale-in';
  nodeId: string;
  name: string;
  detail?: string;
}

/** outgoing attempts per original call, given per-attempt failure rate f */
export function retryAmp(f: number, retries: number, policy: RetryPolicy): number {
  let sum = 0;
  for (let k = 0; k <= retries; k++) sum += f ** k;
  if (policy === 'backoff') return 1 + (sum - 1) * BACKOFF.spread; // retries spread out over time
  if (policy === 'budget') return Math.min(sum, 1 + RETRY_BUDGET); // at most +10% extra load
  return sum;
}

export interface Snapshot {
  nodeStats: Record<string, NodeStats>;
  edgeStats: Record<string, EdgeStats>;
  global: GlobalStats;
}

/** the fluid engine (engine-rs SimEngine, WebAssembly): one per running board */
export class Engine {
  // boards create their engines when the store module loads, before the WebAssembly has: the
  // compiled one is made on first use
  private made: wasm.SimEngine | null = null;
  private get impl() {
    return (this.made ??= new wasm.SimEngine());
  }
  get t(): number {
    return this.made?.t ?? 0;
  }
  reset() {
    // a fresh engine has nothing to reset
    this.made?.reset();
  }
  step(nodes: SystemNode[], edges: SystemEdge[], trafficRps: number, readRatio: number, dt: number, cfg: EngineConfig = DEFAULT_ENGINE_CONFIG): SimEvent[] {
    return this.impl.step(nodes, edges, trafficRps, readRatio, dt, cfg, getPricing()) as SimEvent[];
  }
  snapshot(nodes: SystemNode[], edges: SystemEdge[]): Snapshot {
    return this.impl.snapshot(nodes, edges) as Snapshot;
  }
}
