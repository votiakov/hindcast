import { describe, expect, it } from 'vitest';
import { LESSONS } from '../src/lessons';
import { playLesson } from '../src/lessons/verify';

/**
 * Every level can be won, and every level with a reference solution is a real challenge: the design
 * the previous level left fails it, the solution passes it. Only a first level may be a warm-up. Played headlessly with
 * the same traffic, chaos and goal as the app.
 */
describe('lessons', () => {
  for (const lesson of LESSONS)
    it(`${lesson.title}: every level fails as left and passes with its solution`, () => {
      const results = playLesson(lesson);
      results.forEach((r, i) => {
        const step = lesson.steps[i];
        // a level with a solution is a challenge: the board as left fails it; one without is a warm-up
        if (step.solution) expect(r.before.passed, `${r.step} should fail with the design the previous level left`).toBe(false);
        else {
          expect(i, `${r.step}: only a lesson's first level may be a warm-up without a solution`).toBe(0);
          expect(r.before.passed, `${r.step} should pass as built`).toBe(true);
        }
        expect(r.after.passed, `${r.step} should pass with its solution`).toBe(true);
        expect(step.takeaway, `${r.step} needs a takeaway`).toBeTruthy();
      });
    }, 60_000);
});
