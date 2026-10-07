import type { ArchitectureSpec } from '../spec/schema';
import type { Model } from './model';
import type { Plan } from './engine';

/**
 * The calibrated model drawn as a board: every component becomes a canvas component whose
 * capacity, latency and price are the fitted numbers. The board engine moves one request per edge,
 * so calls that happen several times per request (or off the critical path) are folded into the
 * callee's capacity and latency. Good for watching a moment replay; the backtest itself always
 * runs on the model.
 */
export function modelToSpec(model: Model, plan: Plan, name = model.name): { spec: ArchitectureSpec; notes: string[] } {
  const notes: string[] = [];
  const kinds: Record<string, ArchitectureSpec['components'][number]['kind']> = { server: 'server', db: 'db', cache: 'cache', queue: 'queue', external: 'server', lb: 'lb' };
  const eps = Object.values(model.endpoints);
  // visits and critical-path weight per entry request, traffic-weighted over endpoints
  const visits: Record<string, number> = {};
  const weight: Record<string, number> = {};
  for (const e of eps) {
    for (const [s, v] of Object.entries(e.visits)) visits[s] = (visits[s] ?? 0) + e.share * v;
    for (const [s, w] of Object.entries(e.weights)) weight[s] = (weight[s] ?? 0) + e.share * w;
  }
  const edges = new Set<string>();
  for (const e of eps) for (const k of Object.keys(e.calls)) edges.add(k);
  const components: ArchitectureSpec['components'] = [{ id: 'users', kind: 'client', timeoutMs: model.timeoutMs }];
  const connections: ArchitectureSpec['connections'] = [];
  const entry = new Set(eps.map((e) => e.service));

  for (const [id, s] of Object.entries(model.services)) {
    const p = plan.services[id];
    if (!p) continue;
    const v = Math.max(1e-6, visits[id] ?? 1);
    const reps = p.replicas ?? (p.autoscale ? p.autoscale.min : model.services[p.hostedBy ?? id]?.replicas ?? 1);
    const capacity = isFinite(p.perReplicaRps) ? p.perReplicaRps / v : 1e6;
    if (v > 1.05) notes.push(`${id}: called ${v.toFixed(1)}× per request — capacity shown per request (${capacity.toFixed(1)} req/s per replica)`);
    const kind = kinds[s.kind] ?? 'server';
    const scalable = kind === 'server';
    components.push({
      id,
      kind,
      ...(scalable && !p.hostedBy && reps > 1 ? { instances: Math.min(500, Math.round(reps)) } : {}),
      ...(p.autoscale && scalable ? { autoscale: { min: Math.max(1, p.autoscale.min), max: Math.max(1, p.autoscale.max), targetUtil: Math.min(0.95, p.autoscale.target), warmupS: p.autoscale.warmupS, cooldownS: p.autoscale.cooldownS } } : {}),
      capacity: Math.max(0.01, capacity),
      latencyMs: Math.max(0, p.selfMean * (weight[id] ?? 1)),
      costPerHour: p.hostedBy ? 0 : p.replicaHour,
      ...(p.cache ? { name: `${id} (+ cache ${Math.round(p.cache.hitRate * 100)}%)` } : {}),
    });
  }
  // replicas are only reachable behind a balancer on the board: put one in front of each scaled service
  for (const c of [...components]) {
    if (!c.instances && !c.autoscale) continue;
    const lb = `${c.id}-lb`;
    components.push({ id: lb, kind: 'lb', costPerHour: 0 });
    connections.push([lb, c.id]);
  }
  const target = (id: string) => (components.some((c) => c.id === `${id}-lb`) ? `${id}-lb` : id);
  for (const id of entry) if (model.services[id]) connections.push(['users', target(id)]);
  for (const k of edges) {
    const [from, to] = k.split('>');
    if (model.services[from] && model.services[to]) connections.push([from, target(to)]);
  }
  const zones = new Map<string, string[]>();
  for (const [id, p] of Object.entries(plan.services)) if (p.zone) (zones.get(p.zone) ?? zones.set(p.zone, []).get(p.zone)!).push(id);
  return {
    spec: { version: 1, name, components, connections, ...(zones.size > 1 ? { zones: [...zones].map(([id, members]) => ({ id, members })) } : {}) } as ArchitectureSpec,
    notes,
  };
}
