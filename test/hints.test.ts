import { describe, expect, it } from 'vitest';
import { LESSONS } from '../src/lessons';
import { hintStage } from '../src/lessons/hints';

const step = { ask: 'Which card is red, and what is it short of?', hint: 'Add instances.', hintAfter: 8 };
const ls = { failT: 0, missed: false, passed: false, answered: false };

describe('two-stage hints', () => {
  it('shows nothing until the learner has been failing for hintAfter seconds', () => {
    expect(hintStage(step, ls)).toBe('none');
    expect(hintStage(step, { ...ls, failT: 7.9 })).toBe('none');
    expect(hintStage({ ...step, hintAfter: undefined }, { ...ls, failT: 7.9 })).toBe('none');
  });

  it('asks the question first, and gives the answer only when asked for it', () => {
    expect(hintStage(step, { ...ls, failT: 8 })).toBe('ask');
    expect(hintStage(step, { ...ls, failT: 60 })).toBe('ask');
    expect(hintStage(step, { ...ls, failT: 8, answered: true })).toBe('answer');
  });

  it('asks at once when the level’s window closed', () => {
    expect(hintStage(step, { ...ls, missed: true })).toBe('ask');
  });

  it('a revealed answer waits for the next failure after a replay, then comes back without the question stage', () => {
    expect(hintStage(step, { ...ls, answered: true })).toBe('none');
    expect(hintStage(step, { ...ls, failT: 9, answered: true })).toBe('answer');
  });

  it('shows nothing on a passed level or one without a hint, and the answer directly when there is no question', () => {
    expect(hintStage(step, { ...ls, failT: 20, passed: true })).toBe('none');
    expect(hintStage({}, { ...ls, failT: 20 })).toBe('none');
    expect(hintStage({ hint: 'Add instances.' }, { ...ls, failT: 20 })).toBe('answer');
  });

  for (const lesson of LESSONS)
    it(`${lesson.title}: every level with a hint asks a question first`, () => {
      for (const s of lesson.steps) {
        if (!s.hint) continue;
        expect(s.ask, `${s.id} needs a first-stage question beside its hint`).toBeTruthy();
        expect(s.ask, `${s.id}: the first stage asks a question`).toContain('?');
        expect(s.ask, `${s.id}: plain voice, no exclamation marks`).not.toMatch(/!/);
        expect(s.ask!.length, `${s.id}: the question is shorter than the answer`).toBeLessThan(s.hint.length);
      }
      // a level with a solution is a challenge, so it has a hint (and so a question) to reach it by
      for (const s of lesson.steps) if (s.solution) expect(s.hint, `${s.id} has a solution but no hint`).toBeTruthy();
    });
});
