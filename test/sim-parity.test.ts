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

import { parse as parseYaml } from 'yaml';
import { breakingPoint as wBreakingPoint, compareVariants as wCompare, loadCurve as wLoadCurve, simulate as wSimulate } from '../src/backtest/wasm/hindcast_engine.js';
import { breakingPointTs, compareTs, loadCurveTs, simulateTs } from '../src/sim/headless';
import { graphToSpec } from '../src/spec/convert';
import { TEMPLATES } from '../src/scenarios/templates';
import { shop, shopWithReplica } from './fixtures';

const yaml = (f: string) => parseYaml(readFileSync(f, 'utf8'));
const same = (a: unknown, b: unknown, where: string) => {
  const out: Diff[] = [];
  compare(a, b, where, out);
  expect(out, JSON.stringify(out.slice(0, 5), null, 1)).toEqual([]);
};

describe('the headless simulator in Rust matches TypeScript', () => {
  const specs: [string, unknown][] = [
    ['shop', shop],
    ['shop + replica', shopWithReplica],
    ['examples/shop.yaml', yaml('examples/shop.yaml')],
    ...TEMPLATES.map((t) => [`template ${t.id}`, graphToSpec(t.graph.nodes, t.graph.edges, t.title)] as [string, unknown]),
  ];
  const chaos = (spec: { components: { id: string; kind: string }[]; zones?: { id: string }[] }) => {
    const pick = (k: string) => spec.components.find((c) => c.kind === k)?.id ?? spec.components[1].id;
    return {
      name: 'chaos',
      duration: 40,
      traffic: [{ at: 0, rps: 300 }, { at: 20, rps: 1500 }, { at: 40, rps: 900 }],
      events: [
        { at: 5, action: { type: 'kill', kind: 'server', pick: 'busiest' } },
        { at: 8, action: { type: 'degrade', id: pick('server'), factor: 0.5 } },
        { at: 12, action: { type: 'inject-errors', id: pick('db'), rate: 0.1 } },
        { at: 15, action: { type: 'inject-latency', id: pick('server'), ms: 80 } },
        { at: 18, action: { type: 'flush-cache', id: pick('cache') } },
        { at: 22, action: { type: 'restore', id: pick('server') } },
        ...(spec.zones?.length ? [{ at: 25, action: { type: 'fail-zone', id: spec.zones[0].id } }, { at: 32, action: { type: 'restore-zone', id: spec.zones[0].id } }] : []),
        { at: 28, action: { type: 'kill-id', id: pick('db') } },
        { at: 35, action: { type: 'revive-all' }, note: 'all back' },
      ],
    };
  };
  it.each(specs)('simulate %s: steady, black friday, chaos', (_, spec) => {
    for (const sc of [{ duration: 20, rps: 800, readRatio: 0.8 }, yaml('examples/black-friday.yaml'), chaos(spec as never)]) same(simulateTs(spec, sc), wSimulate(spec, sc, {}), 'simulate');
  });
  it('compare the example variants', () => {
    const o = (x: unknown) => JSON.parse(JSON.stringify(x));
    same(o(compareTs(yaml('examples/shop.yaml'), yaml('examples/shop-variants.yaml'), yaml('examples/black-friday.yaml'))), o(wCompare(yaml('examples/shop.yaml'), yaml('examples/shop-variants.yaml'), yaml('examples/black-friday.yaml'), {})), 'compare');
  });
  it('breaking point and load curve', () => {
    for (const spec of [shop, shopWithReplica, yaml('examples/shop.yaml')]) {
      same(breakingPointTs(spec), wBreakingPoint(spec, {}), 'breakingPoint');
      same(loadCurveTs(spec, { maxRps: 3000, points: 6 }), wLoadCurve(spec, { maxRps: 3000, points: 6 }), 'loadCurve');
    }
  });
  it('a broken spec is refused by both', () => {
    const bad = { components: [{ id: 'x', kind: 'nope' }], connections: ['a ->'] };
    expect(() => simulateTs(bad)).toThrow();
    expect(() => wSimulate(bad, {}, {})).toThrow();
  });
});
