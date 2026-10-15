import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '../src/scenarios/scenarios';
import { differs, playScenario } from '../src/scenarios/verify';

describe('built-in comparisons', () => {
  for (const sc of SCENARIOS) {
    it(`${sc.id} shows a difference worth watching`, () => {
      const { a, b } = playScenario(sc);
      expect(differs(a, b)).not.toEqual([]);
    });
  }
});

describe('studio episodes', () => {
  it('every comparison has a written hook for its episode', async () => {
    const { EPISODES } = await import('../src/studio/episodes');
    for (const sc of SCENARIOS) {
      const ep = EPISODES.find((e) => e.id.endsWith(sc.id))!;
      expect(ep, sc.id).toBeDefined();
      expect(ep.hook, sc.id).not.toBe(sc.title);
    }
  });
});

describe('real systems', () => {
  it('each runs healthy at the traffic it is sized for, in both engines', async () => {
    const { REAL_SYSTEMS } = await import('../src/scenarios/systems');
    const { graphToSpec } = await import('../src/spec/convert');
    const { simulate } = await import('../src/sim/headless');
    const { simulateDes } = await import('../src/sim/des/des');
    for (const s of REAL_SYSTEMS) {
      const spec = graphToSpec(s.graph.nodes as never, s.graph.edges as never, s.title);
      const sc = { duration: 30, rps: s.rps, readRatio: s.readRatio };
      expect([s.id, simulate(spec as never, sc as never).summary.meanErrorRate]).toEqual([s.id, expect.closeTo(0, 2)]);
      expect([s.id, simulateDes(spec, sc, { seed: 1 }).summary.meanErrorRate]).toEqual([s.id, expect.closeTo(0, 2)]);
    }
  });
});

describe('comparisons on search, vector and edge tell the same story in both engines', () => {
  const both = async (id: string) => {
    const { graphToSpec } = await import('../src/spec/convert');
    const { simulate } = await import('../src/sim/headless');
    const { simulateDes } = await import('../src/sim/des/des');
    const { scenarioDuration } = await import('../src/scenarios/scenarios');
    const sc = SCENARIOS.find((s) => s.id === id)!;
    const out = {} as Record<'a' | 'b', Record<'fluid' | 'des', { err: number; cost: number; stale: number }>>;
    for (const side of ['a', 'b'] as const) {
      const spec = graphToSpec(sc[side].graph.nodes as never, sc[side].graph.edges as never, sc[side].title);
      const scen = { duration: scenarioDuration(sc), traffic: sc.timeline.map((k) => ({ at: k.at, rps: k.rps })), readRatio: sc.readRatio };
      const pick = (s: { meanErrorRate: number; meanCostPerHour: number; staleReads?: number }) => ({ err: s.meanErrorRate, cost: s.meanCostPerHour, stale: s.staleReads ?? 0 });
      out[side] = { fluid: pick(simulate(spec as never, scen as never).summary), des: pick(simulateDes(spec, scen, { seed: 1 }).summary) };
    }
    return out;
  };

  it('search: a 30 s refresh leaves nearly every search blind to recent writes; 1 s none, at the same cost', async () => {
    const r = await both('search-refresh');
    for (const e of ['fluid', 'des'] as const) {
      expect(r.a[e].stale, e).toBeGreaterThan(7000); // 270 searches/s for 30 s
      expect(r.b[e].stale, e).toBe(0);
      expect(r.a[e].err + r.b[e].err, e).toBeLessThan(0.001);
      expect(r.a[e].cost, e).toBeCloseTo(r.b[e].cost, 1);
    }
  });

  it('vector: recall 0.99 breaks the cluster 0.95 serves; a graph 9% past memory does too', async () => {
    const recall = await both('vector-recall');
    const memory = await both('vector-memory');
    for (const e of ['fluid', 'des'] as const) {
      expect(recall.a[e].err, e).toBeGreaterThan(0.3);
      expect(recall.b[e].err, e).toBeLessThan(0.001);
      expect(memory.a[e].err, e).toBeGreaterThan(0.05);
      expect(memory.b[e].err, e).toBeLessThan(0.001);
    }
  });

  it('edge: the origin alone falls over at the peak; the edge spares it and loses ~0.7% to its CPU limit, for more per hour', async () => {
    const r = await both('edge-vs-origin');
    for (const e of ['fluid', 'des'] as const) {
      expect(r.a[e].err, e).toBeGreaterThan(0.3);
      expect(r.b[e].err, e).toBeGreaterThan(0.004);
      expect(r.b[e].err, e).toBeLessThan(0.012);
      expect(r.b[e].cost, e).toBeGreaterThan(r.a[e].cost);
    }
  });
});
