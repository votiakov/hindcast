import { isSystem, type AppNode, type SystemNode } from '../sim/catalog';
import { DEFAULT_ENGINE_CONFIG, Engine, type NodeStats } from '../sim/engine';
import { applyAction } from '../sim/actions';
import { nodesInZone } from '../sim/zones';
import { scenarioDuration, scenarioTraffic, type Scenario } from './scenarios';

/**
 * Play a comparison without the app: both sides get the same traffic and the same scripted
 * events, on the fluid engine with no jitter, scored the way the takeaway scores them. Used to
 * prove every built-in comparison shows a difference worth watching.
 */

export interface SideResult {
  requests: number;
  failed: number;
  /** seconds outside the SLO */
  outS: number;
  peakP99: number;
  /** $/h averaged over the run */
  cost: number;
  /** reads that could miss a write made before them (a lagging replica, a search index between refreshes) */
  stale: number;
}

export function playScenario(sc: Scenario, slo = { errorRate: 0.01, p99Ms: 300 }): { a: SideResult; b: SideResult } {
  const dt = 0.05;
  const run = (side: 'a' | 'b'): SideResult => {
    const engine = new Engine();
    let nodes = sc[side].graph.nodes as AppNode[];
    const edges = sc[side].graph.edges;
    const fired = new Set<number>();
    let last: Record<string, NodeStats> = {};
    const r: SideResult = { requests: 0, failed: 0, outS: 0, peakP99: 0, cost: 0, stale: 0 };
    let n = 0;
    for (let t = 0; t < scenarioDuration(sc); t += dt) {
      for (const [i, e] of sc.events.entries()) {
        if (fired.has(i) || t < e.at) continue;
        fired.add(i);
        const a = e[side];
        if (a) nodes = applyAction(nodes, a, { inRps: (id) => last[id]?.inRps ?? 0, zoneMembers: (z) => nodesInZone(nodes, z) }).nodes;
      }
      const sys = nodes.filter(isSystem) as SystemNode[];
      engine.step(sys, edges, scenarioTraffic(sc, t), sc.readRatio, dt, DEFAULT_ENGINE_CONFIG);
      const snap = engine.snapshot(sys, edges);
      last = snap.nodeStats;
      const g = snap.global;
      r.requests += g.rps * dt;
      r.failed += g.rps * g.errorRate * dt;
      if (g.rps > 0.5 && (g.errorRate > slo.errorRate || g.p99 > slo.p99Ms)) r.outS += dt;
      r.peakP99 = Math.max(r.peakP99, g.p99);
      r.cost += g.cost;
      r.stale = g.staleReads;
      n++;
    }
    r.cost /= Math.max(1, n);
    return r;
  };
  return { a: run('a'), b: run('b') };
}

/** does the run show a difference a viewer can see: failures, time out of SLO, tail latency, cost or stale reads */
export function differs(a: SideResult, b: SideResult): string[] {
  const out: string[] = [];
  const rel = (x: number, y: number) => Math.abs(x - y) / Math.max(1e-9, Math.max(Math.abs(x), Math.abs(y)));
  if (Math.abs(a.failed - b.failed) > 50 && rel(a.failed, b.failed) > 0.3) out.push('failed requests');
  if (Math.abs(a.outS - b.outS) >= 3) out.push('time out of SLO');
  if (rel(a.peakP99, b.peakP99) > 0.3) out.push('worst p99');
  if (rel(a.cost, b.cost) > 0.15) out.push('cost');
  if (Math.abs(a.stale - b.stale) > 50 && rel(a.stale, b.stale) > 0.3) out.push('stale reads');
  return out;
}
