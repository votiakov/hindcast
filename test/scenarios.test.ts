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
