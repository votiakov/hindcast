import type { Dataset } from './dataset';
import type { Model } from './model';
import type { Fault } from './engine';
import * as wasm from './wasm/hindcast_engine.js';

/**
 * Losing a Kubernetes node at the worst moment: every pod on it goes at once. Services left with no
 * replica are down; the rest lose that share of their capacity and the survivors take the load.
 * Kubernetes replaces the pods after the node is marked NotReady (~50 s) and the default 300 s
 * toleration for not-ready/unreachable nodes runs out, plus a start — unless a fixed pool has no
 * room for them, in which case they stay Pending.
 */

export interface NodeLossOptions {
  /** seconds from the node going away to replacement pods serving (default 50 + 300 + 30) */
  recoverS?: number;
  /** strategy to check under: its replica changes re-spread evenly over the nodes */
  strategy?: unknown;
  /** replay at another load */
  load?: { scale?: number; peakRps?: number };
  draws?: number;
  /** minutes out of SLO a node loss may add before it counts as a failure (default 0.5) */
  gateMinutes?: number;
  /** placement to use instead of the model's (pods per node per service) */
  pods?: Record<string, Record<string, number>>;
  /** only these nodes (default: every node) */
  nodes?: string[];
  /** when the node goes, seconds from the start of the history (default: a minute before its busiest moment) */
  atS?: number;
  /** lose whole zones (every node in one) instead of single nodes — needs the nodes' zones */
  zones?: boolean;
}

export interface NodeLossReport {
  at: number;
  peakRps: number;
  recoverS: number | null;
  nodes: number;
  survives: boolean;
  results: NodeLossResult[];
  singlePointsOfFailure: { service: string; replicas: number; node: string }[];
  notes: string[];
}

export interface NodeLossFaults {
  faults: Fault[];
  lost: { service: string; pods: number; of: number; down: boolean }[];
  atS: number;
  at: number;
  recoverS: number | null;
  peakRps: number;
}

export interface NodeLossResult {
  node: string;
  lost: { service: string; pods: number; of: number; down: boolean }[];
  verdict: 'survives' | 'fails';
  minutesOutOfSlo: number;
  failedRequests: number;
  worst: string;
  recovered: boolean;
  /** with the node lost: the whole replay's minutes out of SLO and failed requests (not the difference) */
  total: { minutesOutOfSlo: number; failedRequests: number };
}

export function nodeLoss(model: Model, d: Dataset, o: NodeLossOptions = {}): NodeLossReport {
  return wasm.nodeLoss(model, d, o) as NodeLossReport;
}

/** the faults one node's loss puts on a history: from `atS` seconds in (default a minute before its
 *  busiest moment) until the pods are replaced (`recoverS`, null: never) */
export function nodeLossFaults(model: Model, d: Dataset, node: string, o: { atS?: number; recoverS?: number | null; pods?: Record<string, Record<string, number>> } = {}): NodeLossFaults {
  return wasm.nodeLossFaults(model, d, node, o.atS, o.recoverS, o.pods) as NodeLossFaults;
}

/** pods per node per service: as collected, or for a strategy's new replica counts spread evenly */
export function podsPerNode(model: Model, strategy?: unknown): Record<string, Record<string, number>> {
  return wasm.podsPerNode(model, strategy);
}
