import { create } from 'zustand';
import { useSim, type BoardId } from '../sim/store';
import { isSystem, type SystemEdge } from '../sim/catalog';
import { graphToSpec } from '../spec/convert';
import type { Journey, TraceReport } from '../sim/des/des';
import { traceInBrowser } from '../sim/des/browserPool';
import { boardMarks, type BoardMarks } from './journey';

/**
 * The request tracer on the board: a short discrete-event run of the board as it is now (its traffic,
 * and what is killed, broken or cut), following a sample of requests hop by hop; then one of the
 * requests through the chosen component at a time, drawn on the board and read out in the strip.
 */

/** seconds simulated, and when following starts (queues and breakers have settled by then) */
export const TRACE_RUN_S = 12;
const TRACE_FROM_S = 4;

export interface TraceRun {
  rps: number;
  requests: number;
  failed: number;
  /** the spec it ran, to tell when the board has changed since */
  key: string;
}

interface TracerState {
  board: BoardId | null;
  node: string | null;
  status: 'idle' | 'running' | 'ready' | 'error';
  error: string | null;
  report: TraceReport | null;
  run: TraceRun | null;
  seed: number;
  /** which of the component's sampled requests */
  pos: number;
  failedOnly: boolean;
  marks: BoardMarks | null;
  start: (board: BoardId, node: string) => void;
  setNode: (node: string) => void;
  step: (d: number) => void;
  setFailedOnly: (on: boolean) => void;
  rerun: () => void;
  close: () => void;
}

/** the board as a spec, plus scenario events at 0 s that put it in its current state */
export function boardNow(b: BoardId) {
  const { boards, settings, traffic } = useSim.getState();
  const { nodes, edges, title, nodeStats } = boards[b];
  const spec = { ...graphToSpec(nodes, edges, title), pricing: settings.pricing, ...(settings.commitment !== 'none' ? { commitment: settings.commitment } : {}) };
  const events: { at: number; action: Record<string, unknown> }[] = [];
  for (const n of nodes.filter(isSystem)) {
    const d = n.data;
    const kills = !d.alive ? Math.max(1, d.instances ?? 1) : (d.down ?? 0);
    for (let k = 0; k < kills; k++) events.push({ at: 0, action: { type: 'kill-id', id: n.id } });
    if (d.degraded !== undefined) events.push({ at: 0, action: { type: 'degrade', id: n.id, factor: d.degraded } });
    if (d.faultRate) events.push({ at: 0, action: { type: 'inject-errors', id: n.id, rate: d.faultRate } });
    if (d.faultLatencyMs) events.push({ at: 0, action: { type: 'inject-latency', id: n.id, ms: d.faultLatencyMs } });
    for (const to of d.cutTo ?? []) events.push({ at: 0, action: { type: 'cut-link', from: n.id, to } });
  }
  // what the users send now (a scheduled job's batches are its own)
  const users = nodes.filter(isSystem).filter((n) => n.data.kind === 'client' && !n.data.everyS);
  const sending = users.reduce((s, n) => s + (nodeStats[n.id]?.inRps ?? 0), 0);
  const rps = Math.max(1, Math.round(sending >= 0.5 ? sending : traffic));
  const key = JSON.stringify([spec, events]);
  return { spec, scenario: { name: 'the board now', duration: TRACE_RUN_S, rps, readRatio: useSim.getState().readRatio, events }, rps, key };
}

/** the sampled requests through a component (all, or the failed ones) */
export function listFor(report: TraceReport | null, node: string | null, failedOnly: boolean): number[] {
  const n = node ? report?.byNode[node] : undefined;
  if (!n) return [];
  return failedOnly ? n.failed : n.all;
}

export function current(s: Pick<TracerState, 'report' | 'node' | 'failedOnly' | 'pos'>): Journey | null {
  const list = listFor(s.report, s.node, s.failedOnly);
  if (!list.length || !s.report) return null;
  return s.report.journeys[list[Math.min(s.pos, list.length - 1)]] ?? null;
}

const marksFor = (s: Pick<TracerState, 'report' | 'node' | 'failedOnly' | 'pos' | 'board'>, edges?: SystemEdge[]) => {
  const j = current(s);
  if (!j || !s.board) return null;
  return boardMarks(j, edges ?? useSim.getState().boards[s.board].edges);
};

let ticket = 0;

export const useTracer = create<TracerState>()((set, get) => {
  const go = async (board: BoardId, node: string, seed: number) => {
    const t = ++ticket;
    const now = boardNow(board);
    set({ board, node, status: 'running', error: null, seed, marks: null, pos: 0 });
    try {
      const r = await traceInBrowser(now.spec, now.scenario, seed, { perNode: 12, perSec: 60, fromS: TRACE_FROM_S, maxSpans: 80 });
      if (t !== ticket) return;
      const failedOnly = (r.trace.byNode[node]?.failed.length ?? 0) > 0;
      const next = { board, node, report: r.trace, failedOnly, pos: 0 };
      set({ ...next, status: 'ready', run: { rps: now.rps, requests: r.requests, failed: r.failed, key: now.key }, marks: marksFor(next) });
    } catch (e) {
      if (t !== ticket) return;
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  };
  const update = (p: Partial<TracerState>) => {
    const next = { ...get(), ...p };
    set({ ...p, marks: next.status === 'ready' ? marksFor(next) : null });
  };
  return {
    board: null,
    node: null,
    status: 'idle',
    error: null,
    report: null,
    run: null,
    seed: 1,
    pos: 0,
    failedOnly: false,
    marks: null,
    start: (board, node) => void go(board, node, 1),
    setNode: (node) => {
      const s = get();
      if (node === s.node) return;
      update({ node, pos: 0, failedOnly: s.failedOnly && (s.report?.byNode[node]?.failed.length ?? 0) > 0 });
    },
    step: (d) => {
      const s = get();
      const n = listFor(s.report, s.node, s.failedOnly).length;
      if (n) update({ pos: (s.pos + d + n) % n });
    },
    setFailedOnly: (failedOnly) => update({ failedOnly, pos: 0 }),
    rerun: () => {
      const s = get();
      if (s.board && s.node) void go(s.board, s.node, s.seed + 1);
    },
    close: () => {
      ticket++;
      set({ board: null, node: null, status: 'idle', error: null, report: null, run: null, marks: null, pos: 0 });
    },
  };
});
