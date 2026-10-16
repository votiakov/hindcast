import { describe, expect, it } from 'vitest';
import { LESSONS } from '../src/lessons';
import { MARGIN, playLesson, playLevel, playLevelDes, referenceBoard } from '../src/lessons/verify';
import { applyChangesToGraph } from '../src/spec/convert';
import type { ChangeSpec } from '../src/spec/schema';

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

/**
 * The tracer lesson is read off the discrete-event engine (the one "trace" runs), so its levels must
 * fail and pass there too, not only on the fluid engine the lesson loop plays.
 */
describe('Follow One Request: both engines', () => {
  const lesson = LESSONS.find((l) => l.id === 'deadlines')!;
  const step = (id: string) => lesson.steps.findIndex((s) => s.id === id);
  lesson.steps.forEach((s, i) => {
    it(`${s.id}: fails as given and passes with its fix on the discrete-event engine`, () => {
      expect(playLevelDes(referenceBoard(lesson, i - 1), s, lesson.readRatio, { trafficScale: MARGIN.fail }).passed).toBe(false);
      expect(playLevelDes(referenceBoard(lesson, i), s, lesson.readRatio, { trafficScale: MARGIN.pass }).passed).toBe(true);
    }, 60_000);
  });

  it('retries: immediate retries turn the stall into an outage on both engines, and backoff does not save them', () => {
    const i = step('retries');
    const b = referenceBoard(lesson, i - 1);
    // backoff delays each retry by 50–100 ms but still sends it: the load still triples
    for (const retryPolicy of ['immediate', 'backoff'] as const) {
      const board = applyChangesToGraph(b.nodes, b.edges, [{ op: 'set', id: 'users', fields: { retries: 2, retryPolicy } }]);
      expect(playLevel(board, lesson.steps[i], lesson.readRatio).passed, retryPolicy).toBe(false);
      expect(playLevelDes(board, lesson.steps[i], lesson.readRatio).passed, `${retryPolicy} (discrete-event)`).toBe(false);
    }
  }, 60_000);

  it('the timeouts cannot be bought out of: a large database is over budget, a cache barely helps', () => {
    for (const id of ['deadline', 'aligned']) {
      const i = step(id);
      const b = referenceBoard(lesson, i - 1);
      const large = applyChangesToGraph(b.nodes, b.edges, [{ op: 'set', id: 'db', fields: { tier: 'L' } }]);
      const cache: ChangeSpec[] = [
        { op: 'add', component: { id: 'cache', kind: 'cache' } },
        { op: 'disconnect', from: 'api', to: 'db' },
        { op: 'connect', from: 'api', to: 'cache' },
        { op: 'connect', from: 'cache', to: 'db' },
      ];
      const cached = applyChangesToGraph(b.nodes, b.edges, cache);
      for (const [what, board] of [['large db', large], ['cache', cached]] as const) {
        expect(playLevel(board, lesson.steps[i], lesson.readRatio).passed, `${id}: ${what}`).toBe(false);
        expect(playLevelDes(board, lesson.steps[i], lesson.readRatio).passed, `${id}: ${what} (discrete-event)`).toBe(false);
      }
    }
  }, 60_000);
});
