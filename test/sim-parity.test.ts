import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { initSync, SimEngine } from '../src/backtest/wasm/hindcast_engine.js';
import { DEFAULT_ENGINE_CONFIG, EngineTs, type NodeStats } from '../src/sim/engine';
import { isSystem, type AppNode, type SystemNode } from '../src/sim/catalog';
import { applyAction } from '../src/sim/actions';
import { nodesInZone } from '../src/sim/zones';
import { SCENARIOS, scenarioDuration, scenarioTraffic } from '../src/scenarios/scenarios';
import { getPricing, setPricing, type PricingId } from '../src/sim/pricing';

/**
 * The design simulator's Rust engine against the TypeScript one, in lockstep: every built-in
 * comparison, both sides, with its scripted failures, under each pricing profile. Every node's
 * stats, every edge and the global numbers are compared every 20 ticks, events every tick.
 */
type Diff = { where: string; ts: unknown; rs: unknown };
function compare(a: unknown, b: unknown, where: string, out: Diff[]) {
  if (out.length > 10) return;
  if (typeof a === 'number' && typeof b === 'number') {
    if (a === b || (Number.isNaN(a) && Number.isNaN(b))) return;
    if (!(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)))) out.push({ where, ts: a, rs: b });
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return void out.push({ where: `${where}.length`, ts: a.length, rs: b.length });
    a.forEach((x, i) => compare(x, b[i], `${where}[${i}]`, out));
    return;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined).sort();
    const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined).sort();
    if (ka.join() !== kb.join()) return void out.push({ where: `${where} keys`, ts: ka, rs: kb });
    for (const k of ka) compare((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${where}.${k}`, out);
    return;
  }
  if (a !== b) out.push({ where, ts: a, rs: b });
}

beforeAll(() => {
  initSync({ module: readFileSync('src/backtest/wasm/hindcast_engine_bg.wasm') });
});

describe.each(SCENARIOS.map((s) => [s.id, s] as const))('Rust sim engine matches TypeScript: %s', (_, sc) => {
  it.each(['a', 'b'] as const)('side %s', (side) => {
    const pricing: PricingId = side === 'a' ? 'illustrative' : 'aws-us-east-1';
    const before = getPricing();
    setPricing(pricing);
    try {
      const ts = new EngineTs();
      const rs = new SimEngine();
      let nodes = sc[side].graph.nodes as AppNode[];
      const edges = sc[side].graph.edges;
      const fired = new Set<number>();
      let last: Record<string, NodeStats> = {};
      const dt = 0.05;
      const out: Diff[] = [];
      let k = 0;
      for (let t = 0; t < scenarioDuration(sc) && out.length === 0; t += dt, k++) {
        for (const [i, e] of sc.events.entries()) {
          if (fired.has(i) || t < e.at) continue;
          fired.add(i);
          const a = e[side];
          if (a) nodes = applyAction(nodes, a, { inRps: (id) => last[id]?.inRps ?? 0, zoneMembers: (z) => nodesInZone(nodes, z) }).nodes;
        }
        const sys = nodes.filter(isSystem) as SystemNode[];
        const evTs = ts.step(sys, edges, scenarioTraffic(sc, t), sc.readRatio, dt, DEFAULT_ENGINE_CONFIG);
        const evRs = rs.step(sys, edges, scenarioTraffic(sc, t), sc.readRatio, dt, DEFAULT_ENGINE_CONFIG, pricing);
        compare(evTs, evRs, `t=${t.toFixed(2)} events`, out);
        const snapTs = ts.snapshot(sys, edges);
        last = snapTs.nodeStats;
        if (k % 20 === 0) compare(snapTs, rs.snapshot(sys, edges), `t=${t.toFixed(2)}`, out);
      }
      expect(out, JSON.stringify(out.slice(0, 5), null, 1)).toEqual([]);
      rs.free();
    } finally {
      setPricing(before);
    }
  });
});
