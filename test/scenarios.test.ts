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
