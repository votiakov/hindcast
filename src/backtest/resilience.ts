import type { Dataset } from './dataset';
import type { Model } from './model';
import type { Fault } from './engine';
import { backtest } from './backtest';
import { scaleTraffic, trafficOf } from './calibrate';
import { applyStrategy, StrategySpec } from './strategy';
import { basePlan } from './engine';

/** compiled implementations (src/backtest/native.ts sets them) */
const native: { nodeLoss?: typeof nodeLossTs; nodeLossFaults?: typeof nodeLossFaultsTs; podsPerNode?: typeof podsPerNodeTs } = {};
export function setNativeResilience(n: typeof native | null) {
  for (const k of Object.keys(native) as (keyof typeof native)[]) delete native[k];
  if (n) Object.assign(native, n);
}

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

/** compiled (engine-rs) once loaded; the TypeScript one below is the reference */
export function nodeLoss(model: Model, d: Dataset, o: NodeLossOptions = {}): ReturnType<typeof nodeLossTs> {
  return native.nodeLoss ? native.nodeLoss(model, d, o) : nodeLossTs(model, d, o);
}

export function nodeLossTs(model: Model, d: Dataset, o: NodeLossOptions = {}) {
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
  // room for the lost pods elsewhere: every pod's requests (the strategy's replicas and requests)
  // against the nodes left once this node — or every node of this zone — is gone
  const want = c ? requested(model, c.other, o.strategy) : null;
  const nodesIn = (unit: string) => (o.zones ? Object.values(c?.zones ?? {}).filter((z) => z === unit).length || 1 : 1);
  const roomlessFor = (unit: string) => !!c && !c.autoscaled && !!want && (want.cpu > (c.nodes - nodesIn(unit)) * c.node.cpu || want.memoryGb > (c.nodes - nodesIn(unit)) * c.node.memoryGb);
  const roomless = nodes.some(roomlessFor);
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
    const until = roomlessFor(node) ? undefined : start + recoverS;
    const faults: Fault[] = lost.map((l) => ({ service: l.service, at: start, until, ...(l.down ? { down: true } : { replicasLost: l.pods }), note: `${node} lost: ${l.service} ${l.down ? 'has no replica left' : `down to ${l.of - l.pods} of ${l.of} replicas`}` }));
    const r = backtest(model, d, strategies, { draws, traffic, faults, seed: 11 });
    const s = o.strategy ? r.strategies[0] : r.baseline;
    const added = s.summary.minutesOutOfSlo.p50 - ref.summary.minutesOutOfSlo.p50;
    results.push({ node, lost, verdict: added > gate ? 'fails' : 'survives', minutesOutOfSlo: Math.round(added * 10) / 10, failedRequests: Math.round(s.summary.failedRequests.p50 - ref.summary.failedRequests.p50), worst: s.worst.why, recovered: !roomlessFor(node), total: { minutesOutOfSlo: Math.round(s.summary.minutesOutOfSlo.p50 * 10) / 10, failedRequests: Math.round(s.summary.failedRequests.p50) } });
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
      roomless ? `the node pool is fixed and losing ${nodes.filter(roomlessFor).join(', ')} leaves no room for its pods: they stay Pending until it returns` : `pods come back ${Math.round(recoverS / 60)} min after the node goes (NotReady after ~50 s, the default 300 s eviction toleration, a start)`,
      'that is when the platform has recovered; callers can stay broken longer. Reconnect backoff (gRPC waits up to 2 min between attempts) and channels that never reconnect are not in the replay. On the reference cluster a stopped node cost 10.5 min against 7 predicted, because the frontend\'s channel to cart stayed broken until it restarted',
      ...(o.strategy ? ['replica counts the strategy changes are spread evenly over the nodes, as the default scheduler does'] : []),
    ],
  };
}

/** the faults one node's loss puts on a history: from `atS` seconds in (default a minute before its
 *  busiest moment) until the pods are replaced (`recoverS`, null: never) */
/** compiled (engine-rs) once loaded; the TypeScript one below is the reference */
export function nodeLossFaults(model: Model, d: Dataset, node: string, o: { atS?: number; recoverS?: number | null; pods?: Record<string, Record<string, number>> } = {}): ReturnType<typeof nodeLossFaultsTs> {
  return native.nodeLossFaults ? native.nodeLossFaults(model, d, node, o) : nodeLossFaultsTs(model, d, node, o);
}

export function nodeLossFaultsTs(model: Model, d: Dataset, node: string, o: { atS?: number; recoverS?: number | null; pods?: Record<string, Record<string, number>> } = {}) {
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
/** compiled (engine-rs) once loaded; the TypeScript one below is the reference */
export function podsPerNode(model: Model, strategy?: unknown): Record<string, Record<string, number>> {
  return native.podsPerNode ? native.podsPerNode(model, strategy) : podsPerNodeTs(model, strategy);
}

export function podsPerNodeTs(model: Model, strategy?: unknown): Record<string, Record<string, number>> {
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
    // the default scheduler spreads a Deployment's pods and balances the nodes: each replica goes to
    // the node with the fewest of this service, then the fewest pods overall
    delete out[ch.service];
    const load = new Map(nodes.map((n) => [n, 0]));
    for (const q of Object.values(out)) for (const [n, k] of Object.entries(q)) load.set(n, (load.get(n) ?? 0) + k);
    const p: Record<string, number> = {};
    for (let k = 0; k < r; k++) {
      const n = [...nodes].sort((a, b) => (p[a] ?? 0) - (p[b] ?? 0) || load.get(a)! - load.get(b)! || a.localeCompare(b))[0];
      p[n] = (p[n] ?? 0) + 1;
      load.set(n, load.get(n)! + 1);
    }
    out[ch.service] = p;
  }
  return out;
}

/** every pod's requests with the services at their typical replica counts, or the strategy's */
function requested(model: Model, other: { cpu: number; memoryGb: number }, strategy?: unknown) {
  const plan = strategy ? applyStrategy(model, basePlan(model), strategy).plan : basePlan(model);
  let cpu = other.cpu;
  let memoryGb = other.memoryGb;
  for (const [id, s] of Object.entries(plan.services))
    if (s.requests && !s.hostedBy) {
      const r = s.replicas ?? s.autoscale?.min ?? model.services[id].replicas;
      cpu += r * s.requests.cpu;
      memoryGb += r * s.requests.memoryGb;
    }
  return { cpu, memoryGb };
}
