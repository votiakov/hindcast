import { isSystem, type AppNode, type SystemEdge, type SystemNode } from '../sim/catalog';
import { DEFAULT_ENGINE_CONFIG, Engine, type NodeStats } from '../sim/engine';
import { applyAction } from '../sim/actions';
import { applyChangesToGraph } from '../spec/convert';
import { goalStart, trafficAt, type Lesson, type LessonStep } from './types';

/**
 * Play a lesson level without the app: the same traffic ramp, timed chaos and goal check as the
 * lesson loop in the store, on the fluid engine with no jitter. Used to prove every level can be
 * won (with its reference solution) and is a real challenge (the previous level's design fails).
 */

export interface LevelResult {
  passed: boolean;
  /** step time the goal was met for long enough, s */
  at: number | null;
  /** worst moment while the goal was checked */
  worst: { errorRate: number; p99: number; cost: number };
}

export interface Board {
  nodes: AppNode[];
  edges: SystemEdge[];
}

const zoneMembersOf = (nodes: AppNode[]) => (zoneId: string) => nodes.filter((n) => n.parentId === zoneId).map((n) => n.id);

export function playLevel(board: Board, step: LessonStep, readRatio = 0.8, opts: { slack?: number } = {}): LevelResult {
  const dt = 0.05;
  const engine = new Engine();
  let nodes = board.nodes;
  const edges = board.edges;
  const goal = step.goal;
  const start = goalStart(step);
  const until = start + (goal?.holdSeconds ?? 0) + (opts.slack ?? 25);
  const fired = new Set<number>();
  let hold = 0;
  let last: Record<string, NodeStats> = {};
  const worst = { errorRate: 0, p99: 0, cost: 0 };
  const cfg = { ...DEFAULT_ENGINE_CONFIG };
  for (let t = 0; t < until; t += dt) {
    for (const [ci, c] of (step.chaos ?? []).entries()) {
      if (fired.has(ci) || t < c.at) continue;
      fired.add(ci);
      nodes = applyAction(nodes, c.action, { inRps: (id) => last[id]?.inRps ?? 0, zoneMembers: zoneMembersOf(nodes) }).nodes;
    }
    const sys = nodes.filter(isSystem) as SystemNode[];
    engine.step(sys, edges, trafficAt(step, t), readRatio, dt, cfg);
    const snap = engine.snapshot(sys, edges);
    last = snap.nodeStats;
    if (!goal || t + dt < start) continue;
    const g = snap.global;
    worst.errorRate = Math.max(worst.errorRate, g.errorRate);
    worst.p99 = Math.max(worst.p99, g.p99);
    worst.cost = Math.max(worst.cost, g.cost);
    const ok = g.errorRate <= goal.maxErrorRate && g.p99 <= goal.maxP99 && (goal.maxCost === undefined || g.cost <= goal.maxCost) && g.rps > 0;
    hold = ok ? hold + dt : 0;
    if (hold >= goal.holdSeconds - 1e-9) return { passed: true, at: Math.round((t + dt) * 10) / 10, worst };
    if (goal.deadline !== undefined && t + dt > goal.deadline + 1e-9) return { passed: false, at: null, worst };
  }
  return { passed: !goal, at: null, worst };
}

/** the board after a level's reference solution is applied */
export function solve(board: Board, step: LessonStep): Board {
  if (!step.solution) return board;
  const r = applyChangesToGraph(board.nodes, board.edges, step.solution.changes);
  return { nodes: r.nodes, edges: r.edges };
}

/** every level of a lesson: as the previous level left it, then with its solution */
export function playLesson(lesson: Lesson) {
  let board: Board = { nodes: lesson.initial.nodes as AppNode[], edges: lesson.initial.edges };
  return lesson.steps.map((step) => {
    const before = playLevel(board, step, lesson.readRatio);
    board = solve(board, step);
    const after = playLevel(board, step, lesson.readRatio);
    return { step: step.id, title: step.title, before, after };
  });
}

/** the reference design for level `index`: the lesson's start with every solution up to it applied */
export function referenceBoard(lesson: Lesson, index: number): Board {
  let board: Board = { nodes: lesson.initial.nodes as AppNode[], edges: lesson.initial.edges };
  for (let i = 0; i <= index && i < lesson.steps.length; i++) board = solve(board, lesson.steps[i]);
  return board;
}
