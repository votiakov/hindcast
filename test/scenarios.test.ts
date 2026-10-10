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
