import type { Dataset } from './dataset';
import type { Model } from './model';
import type { Fault } from './engine';
import { backtest } from './backtest';
import { scaleTraffic, trafficOf } from './calibrate';
import { StrategySpec } from './strategy';

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

const RECOVER_S = 50 + 300 + 30;

export function nodeLoss(model: Model, d: Dataset, o: NodeLossOptions = {}) {
  let spread = o.pods ? Object.fromEntries(Object.entries(o.pods).filter(([id]) => model.services[id] && !model.services[id].hostedBy)) : podsPerNode(model, o.strategy);
  if (o.zones) {
    // a zone is one big node: every pod in it goes at once
    const zoneOf = model.cluster?.zones ?? {};
    if (!Object.keys(zoneOf).length) throw new Error('the nodes have no zones (they come from kube_node_info provider ids on AWS and GCP): check single nodes instead');
    spread = Object.fromEntries(Object.entries(spread).map(([id, p]) => [id, Object.entries(p).reduce<Record<string, number>>((acc, [n, k]) => ((acc[zoneOf[n] ?? n] = (acc[zoneOf[n] ?? n] ?? 0) + k), acc), {})]));
  }
  const nodes = (o.nodes ?? [...new Set(Object.values(spread).flatMap((p) => Object.keys(p)))]).sort();
  if (!nodes.length) throw new Error('no pod placement in the model: collect from a Kubernetes cluster (kube-state-metrics kube_pod_info) to check node loss');
  let traffic = trafficOf(d, model);
  if (o.load) traffic = scaleTraffic(traffic, o.load).traffic;
  // the busiest moment of the history
  let peak = 0;
  let at = 0;
  for (let i = 0; i < traffic.n; i++) {
    const t = Object.values(traffic.endpoints).reduce((a, s) => a + (s[i] ?? 0), 0);
    if (t > peak) (peak = t), (at = i);
  }
  const start = o.atS ?? Math.max(0, at * traffic.stepS - 60);
  // without an autoscaler and with no room left on the other nodes, the pods stay Pending
  const c = model.cluster;
  const want = c ? requested(model, c.other) : null;
  const roomless = !!c && !c.autoscaled && !!want && (want.cpu > (c.nodes - 1) * c.node.cpu || want.memoryGb > (c.nodes - 1) * c.node.memoryGb);
  const recoverS = o.recoverS ?? RECOVER_S;
  const strategies = o.strategy ? [o.strategy] : [];
  const draws = o.draws ?? 8;
  const gate = o.gateMinutes ?? 0.5;
  const base = backtest(model, d, strategies, { draws, traffic, seed: 11 });
  const ref = o.strategy ? base.strategies[0] : base.baseline;
  const results: NodeLossResult[] = [];
  for (const node of nodes) {
    const lost = Object.entries(spread)
      .filter(([, p]) => (p[node] ?? 0) > 0)
      .map(([service, p]) => {
        const of = Object.values(p).reduce((a, x) => a + x, 0);
        return { service, pods: p[node], of, down: p[node] >= of };
      });
    const until = roomless ? undefined : start + recoverS;
    const faults: Fault[] = lost.map((l) => ({ service: l.service, at: start, until, ...(l.down ? { down: true } : { replicasLost: l.pods }), note: `${node} lost: ${l.service} ${l.down ? 'has no replica left' : `down to ${l.of - l.pods} of ${l.of} replicas`}` }));
    const r = backtest(model, d, strategies, { draws, traffic, faults, seed: 11 });
    const s = o.strategy ? r.strategies[0] : r.baseline;
    const added = s.summary.minutesOutOfSlo.p50 - ref.summary.minutesOutOfSlo.p50;
    results.push({ node, lost, verdict: added > gate ? 'fails' : 'survives', minutesOutOfSlo: Math.round(added * 10) / 10, failedRequests: Math.round(s.summary.failedRequests.p50 - ref.summary.failedRequests.p50), worst: s.worst.why, recovered: !roomless, total: { minutesOutOfSlo: Math.round(s.summary.minutesOutOfSlo.p50 * 10) / 10, failedRequests: Math.round(s.summary.failedRequests.p50) } });
  }
  results.sort((a, b) => b.minutesOutOfSlo - a.minutesOutOfSlo || b.failedRequests - a.failedRequests);
  // services one node failure takes out entirely
  const spof = Object.entries(spread)
    .filter(([, p]) => Object.keys(p).length === 1)
    .map(([service, p]) => ({ service, replicas: Object.values(p)[0], node: Object.keys(p)[0] }));
  return {
    at: traffic.start + start,
    peakRps: Math.round(peak * 10) / 10,
    recoverS: roomless ? null : recoverS,
    nodes: nodes.length,
    survives: results.every((x) => x.verdict === 'survives'),
    results,
    singlePointsOfFailure: spof,
    notes: [
      roomless ? 'the node pool is fixed and the other nodes have no room for the lost pods: they stay Pending until the node returns' : `pods come back ${Math.round(recoverS / 60)} min after the node goes (NotReady after ~50 s, the default 300 s eviction toleration, a start)`,
      ...(o.strategy ? ['replica counts the strategy changes are spread evenly over the nodes, as the default scheduler does'] : []),
    ],
  };
}

/** the faults one node's loss puts on a history: from `atS` seconds in (default a minute before its
 *  busiest moment) until the pods are replaced (`recoverS`, null: never) */
export function nodeLossFaults(model: Model, d: Dataset, node: string, o: { atS?: number; recoverS?: number | null; pods?: Record<string, Record<string, number>> } = {}) {
  const spread = o.pods ?? podsPerNode(model);
  const traffic = trafficOf(d, model);
  let peak = 0;
  let at = 0;
  for (let i = 0; i < traffic.n; i++) {
    const t = Object.values(traffic.endpoints).reduce((a, s) => a + (s[i] ?? 0), 0);
    if (t > peak) (peak = t), (at = i);
  }
  const start = o.atS ?? Math.max(0, at * traffic.stepS - 60);
  const recoverS = o.recoverS === undefined ? RECOVER_S : o.recoverS;
  const lost = Object.entries(spread)
    .filter(([id, p]) => (p[node] ?? 0) > 0 && model.services[id] && !model.services[id].hostedBy)
    .map(([service, p]) => {
      const of = Object.values(p).reduce((a, x) => a + x, 0);
      return { service, pods: p[node], of, down: p[node] >= of };
    });
  const faults: Fault[] = lost.map((l) => ({ service: l.service, at: start, ...(recoverS !== null ? { until: start + recoverS } : {}), ...(l.down ? { down: true } : { replicasLost: l.pods }), note: `${node} lost: ${l.service} ${l.down ? 'has no replica left' : `down to ${l.of - l.pods} of ${l.of} replicas`}` }));
  return { faults, lost, atS: start, at: traffic.start + start, recoverS, peakRps: peak };
}

/** pods per node per service: as collected, or for a strategy's new replica counts spread evenly */
export function podsPerNode(model: Model, strategy?: unknown): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [id, s] of Object.entries(model.services)) if (s.pods && !s.hostedBy) out[id] = { ...s.pods };
  if (!strategy) return out;
  const spec = StrategySpec.parse(strategy);
  const nodes = [...new Set(Object.values(out).flatMap((p) => Object.keys(p)))].sort();
  for (const ch of spec.changes) {
    if (!('service' in ch) || !out[ch.service]) continue;
    const now = Object.values(out[ch.service]).reduce((a, x) => a + x, 0);
    const r = ch.replicas ?? (ch.autoscale ? ch.autoscale.min : ch.spread ? now : undefined);
    if (r === undefined) continue;
    const p: Record<string, number> = {};
    for (let k = 0; k < r; k++) p[nodes[k % nodes.length]] = (p[nodes[k % nodes.length]] ?? 0) + 1;
    out[ch.service] = p;
  }
  return out;
}

/** every pod's requests with the services at their typical replica counts */
function requested(model: Model, other: { cpu: number; memoryGb: number }) {
  let cpu = other.cpu;
  let memoryGb = other.memoryGb;
  for (const s of Object.values(model.services))
    if (s.requests && !s.hostedBy) {
      cpu += s.replicas * s.requests.cpu;
      memoryGb += s.replicas * s.requests.memoryGb;
    }
  return { cpu, memoryGb };
}
