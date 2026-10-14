import { isSystem, type AppNode, type SystemEdge, type SystemNode } from '../sim/catalog';
import { DEFAULT_ENGINE_CONFIG, Engine, type NodeStats } from '../sim/engine';
import { applyAction } from '../sim/actions';
import { applyChangesToGraph } from '../spec/convert';
import { nodesInZone } from '../sim/zones';
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
  worst: { errorRate: number; p99: number; cost: number; lagS?: number; avgCost?: number; lostWrites?: number; totalErrorRate?: number };
}

/** the longest backlog any queue holds, in seconds of draining */
export const maxLag = (sys: SystemNode[], stats: Record<string, NodeStats>) => Math.max(0, ...sys.filter((n) => n.data.kind === 'queue').map((n) => stats[n.id]?.lagS ?? 0));

export interface Board {
  nodes: AppNode[];
  edges: SystemEdge[];
}

const zoneMembersOf = (nodes: AppNode[]) => (zoneId: string) => nodesInZone(nodes, zoneId);

export function playLevel(board: Board, step: LessonStep, readRatio = 0.8, opts: { slack?: number; trafficScale?: number } = {}): LevelResult {
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
  const worst: LevelResult['worst'] = { errorRate: 0, p99: 0, cost: 0 };
  const cfg = { ...DEFAULT_ENGINE_CONFIG };
  let costSum = 0;
  let winReq = 0;
  let winFail = 0;
  let costN = 0;
  for (let t = 0; t < until; t += dt) {
    for (const [ci, c] of (step.chaos ?? []).entries()) {
      if (fired.has(ci) || t < c.at) continue;
      fired.add(ci);
      nodes = applyAction(nodes, c.action, { inRps: (id) => last[id]?.inRps ?? 0, zoneMembers: zoneMembersOf(nodes) }).nodes;
    }
    const sys = nodes.filter(isSystem) as SystemNode[];
    engine.step(sys, edges, trafficAt(step, t) * (opts.trafficScale ?? 1), readRatio, dt, cfg);
    const snap = engine.snapshot(sys, edges);
    last = snap.nodeStats;
    costSum += snap.global.cost;
    costN += 1;
    if (!goal || t + dt < start) continue;
    const g = snap.global;
    worst.errorRate = Math.max(worst.errorRate, g.errorRate);
    worst.p99 = Math.max(worst.p99, g.p99);
    worst.cost = Math.max(worst.cost, g.cost);
    const lag = goal.maxLagS === undefined ? 0 : maxLag(sys, snap.nodeStats);
    worst.lagS = Math.max(worst.lagS ?? 0, lag);
    winReq += g.rps * dt;
    winFail += g.rps * g.errorRate * dt;
    worst.lostWrites = g.lostWrites;
    worst.totalErrorRate = winReq > 0 ? winFail / winReq : 0;
    const ok = g.errorRate <= goal.maxErrorRate && g.p99 <= goal.maxP99 && (goal.maxCost === undefined || g.cost <= goal.maxCost) && (goal.maxLagS === undefined || lag <= goal.maxLagS) && (goal.maxLostWrites === undefined || g.lostWrites <= goal.maxLostWrites) && g.rps > 0;
    hold = ok ? hold + dt : 0;
    worst.avgCost = costSum / costN;
    if (hold >= goal.holdSeconds - 1e-9 && (goal.maxAvgCost === undefined || costSum / costN <= goal.maxAvgCost) && (goal.maxTotalErrorRate === undefined || worst.totalErrorRate <= goal.maxTotalErrorRate)) return { passed: true, at: Math.round((t + dt) * 10) / 10, worst };
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

/**
 * Every level of a lesson: as the previous level left it, then with its solution. The app adds up
 * to ±7% traffic jitter, so a pass is checked at 7% more traffic and a failure at 5% less: a level
 * that only passes in a quiet simulation would fail in front of a player.
 */
export const MARGIN = { pass: 1.07, fail: 0.95 };

export function playLesson(lesson: Lesson) {
  let board: Board = { nodes: lesson.initial.nodes as AppNode[], edges: lesson.initial.edges };
  return lesson.steps.map((step) => {
    const before = playLevel(board, step, lesson.readRatio, { trafficScale: step.solution ? MARGIN.fail : MARGIN.pass });
    board = solve(board, step);
    const after = playLevel(board, step, lesson.readRatio, { trafficScale: MARGIN.pass });
    return { step: step.id, title: step.title, before, after };
  });
}

/** the reference design for level `index`: the lesson's start with every solution up to it applied */
export function referenceBoard(lesson: Lesson, index: number): Board {
  let board: Board = { nodes: lesson.initial.nodes as AppNode[], edges: lesson.initial.edges };
  for (let i = 0; i <= index && i < lesson.steps.length; i++) board = solve(board, lesson.steps[i]);
  return board;
}
