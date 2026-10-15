import type { SystemEdge } from '../sim/catalog';
import type { SimAction } from '../sim/actions';
import type { ChangeSpec } from '../spec/schema';

export type ChaosAction = SimAction;

/** attribution for lessons built on The System Design Primer's problems and topics (CC BY 4.0) */
export const PRIMER_CREDIT = 'After The System Design Primer by Donne Martin (CC BY 4.0) — github.com/donnemartin/system-design-primer';

export interface StepGoal {
  maxErrorRate: number;
  maxP99: number;
  maxCost?: number;
  /** $/h averaged over the whole level so far (a bill, not a moment); checked when the hold completes */
  maxAvgCost?: number;
  /** queues: seconds of backlog (at the current drain rate) any queue may hold */
  maxLagS?: number;
  /** queues: share of the jobs their consumers take that fail — work lost behind the queue, which the
   *  producers never see (they were acknowledged) */
  maxJobErrorRate?: number;
  /** acknowledged writes that may be lost over the level (a failover to a replica that fell behind, a write-behind cache that died) */
  maxLostWrites?: number;
  /** share of requests failed over the whole checked window (a brief election may spike; the window total may not) */
  maxTotalErrorRate?: number;
  /** how long the system must stay within SLO to pass */
  holdSeconds: number;
  /** step time when the goal starts being checked (default: end of the traffic ramp) */
  startAfter?: number;
  /** the hold must be complete by this step time: the system has to ride out what happens in the
   *  window, not recover afterwards (default: no deadline) */
  deadline?: number;
}

export interface LessonStep {
  id: string;
  title: string;
  story: string;
  objective: string;
  /** traffic ramps linearly from -> to over rampSeconds, then holds; or follows keyframes */
  traffic: { from: number; to: number; rampSeconds: number } | { keyframes: { at: number; rps: number }[] };
  goal?: StepGoal;
  hint?: string;
  /** seconds of failing the goal before the hint appears */
  hintAfter?: number;
  chaos?: { at: number; action: ChaosAction; message: string }[];
  /** a design that passes, as edits to the board the previous level leaves (tested; "show me" applies it) */
  solution?: { note: string; changes: ChangeSpec[] };
  /** what the level taught, shown when it is passed */
  takeaway?: string;
}

export interface Lesson {
  id: string;
  title: string;
  subtitle: string;
  initial: { nodes: import('../sim/catalog').AppNode[]; edges: SystemEdge[] };
  /** share of reads (default 0.8) */
  readRatio?: number;
  /** shown on the completion card */
  outro?: string;
  steps: LessonStep[];
  /** where the lesson's problem comes from, shown under it (a licence's attribution) */
  credit?: string;
  /** cost thresholds ($/hr) for 3 and 2 stars at the end */
  stars: { three: number; two: number };
}

export function trafficAt(step: LessonStep, t: number): number {
  const tr = step.traffic;
  if ('keyframes' in tr) {
    const k = tr.keyframes;
    if (t <= k[0].at) return k[0].rps;
    for (let i = 1; i < k.length; i++) if (t <= k[i].at) return k[i - 1].rps + ((k[i].rps - k[i - 1].rps) * (t - k[i - 1].at)) / (k[i].at - k[i - 1].at);
    return k[k.length - 1].rps;
  }
  if (tr.rampSeconds <= 0 || t >= tr.rampSeconds) return tr.to;
  return tr.from + (tr.to - tr.from) * (t / tr.rampSeconds);
}

/** when the step's goal starts being evaluated */
export function goalStart(step: LessonStep): number {
  if (step.goal?.startAfter !== undefined) return step.goal.startAfter;
  return 'keyframes' in step.traffic ? 0 : step.traffic.rampSeconds;
}

/** peak traffic of the final step, for completion text */
export function finalRps(lesson: Lesson): number {
  const tr = lesson.steps[lesson.steps.length - 1].traffic;
  return 'keyframes' in tr ? Math.max(...tr.keyframes.map((k) => k.rps)) : tr.to;
}
