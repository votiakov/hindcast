import { describe, expect, it } from 'vitest';
import { LESSONS } from '../src/lessons';
import { recordChaos, undoChaos } from '../src/lessons/chaos';
import { referenceBoard } from '../src/lessons/verify';
import { applyAction } from '../src/sim/actions';
import type { AppNode } from '../src/sim/catalog';
import { nodesInZone } from '../src/sim/zones';

/**
 * "Next level" in the app: the faults a level injected (dropped calls, a degraded database, a dead
 * instance, a failed zone, a partition, a hot key) end with it, so the next level starts from the
 * board the headless check plays it on (src/lessons/verify.ts starts every level from the design
 * alone). They used to carry over: the network drops of "Follow One Request" level 2 were still
 * on in level 3.
 */
const fire = (nodes: AppNode[], action: Parameters<typeof applyAction>[1]) => applyAction(nodes, action, { inRps: () => 0, zoneMembers: (z) => nodesInZone(nodes, z) }).nodes;

describe('a level ends with its faults', () => {
  for (const lesson of LESSONS)
    lesson.steps.forEach((step, i) => {
      if (!step.chaos?.length) return;
      it(`${lesson.id} / ${step.id}: the next level starts without them`, () => {
        const design = referenceBoard(lesson, i).nodes as AppNode[];
        let nodes = design;
        let undo = {};
        for (const c of step.chaos!) {
          const after = fire(nodes, c.action);
          undo = recordChaos(undo, nodes, after);
          nodes = after;
        }
        expect(undoChaos(nodes, undo)).toEqual(design);
      });
    });

  it('Follow One Request: level 3 starts without level 2\'s network drops, the player\'s changes kept', () => {
    const lesson = LESSONS.find((l) => l.id === 'deadlines')!;
    const i = lesson.steps.findIndex((s) => s.id === 'retries');
    let nodes = referenceBoard(lesson, i - 1).nodes as AppNode[];
    let undo = {};
    for (const c of lesson.steps[i].chaos!) {
      const after = fire(nodes, c.action);
      undo = recordChaos(undo, nodes, after);
      nodes = after;
    }
    expect((nodes.find((n) => n.id === 'db')!.data as { faultRate?: number }).faultRate).toBe(0.03);
    // the player's fix during the level stays
    nodes = nodes.map((n) => (n.id === 'users' ? ({ ...n, data: { ...n.data, retries: 2, retryPolicy: 'budget' } } as AppNode) : n));
    const next = undoChaos(nodes, undo);
    expect(next).toEqual(referenceBoard(lesson, i).nodes);
    expect('faultRate' in next.find((n) => n.id === 'db')!.data).toBe(false);
  });

  it('a field the player had set before the chaos comes back as the player set it', () => {
    const lesson = LESSONS.find((l) => l.id === 'sharding')!;
    const i = lesson.steps.findIndex((s) => s.id === 'famous');
    const design = (referenceBoard(lesson, i).nodes as AppNode[]).map((n) => (n.id === 'db' ? ({ ...n, data: { ...n.data, hotKeyShare: 0.1 } } as AppNode) : n));
    const after = fire(design, { type: 'hot-key', id: 'db', share: 0.3 });
    expect(undoChaos(after, recordChaos({}, design, after))).toEqual(design);
  });
});

describe('the app: "Next level"', () => {
  it('Follow One Request: level 2\'s drops end when the player goes on to level 3', async () => {
    const { useSim } = await import('../src/sim/store');
    const lesson = LESSONS.find((l) => l.id === 'deadlines')!;
    const i = lesson.steps.findIndex((s) => s.id === 'retries');
    useSim.getState().setMode('lesson');
    useSim.getState().pickLesson('deadlines');
    // on level 2 with its solution on the board, run past the drops' start
    const ref = referenceBoard(lesson, i);
    useSim.setState((s) => ({ lesson: { ...s.lesson, stepIndex: i }, boards: { ...s.boards, main: { ...s.boards.main, nodes: ref.nodes as AppNode[], edges: ref.edges } } }));
    useSim.getState().setRunning(true);
    for (let k = 0; k < 20; k++) useSim.getState().tick(0.05);
    const db = () => useSim.getState().boards.main.nodes.find((n) => n.id === 'db')!.data as { faultRate?: number };
    expect(db().faultRate).toBe(0.03);
    useSim.getState().nextStep();
    expect(useSim.getState().lesson.stepIndex).toBe(i + 1);
    expect(db().faultRate).toBeUndefined();
    expect(useSim.getState().boards.main.nodes).toEqual(ref.nodes);
  });
});
