import * as wasm from '../backtest/wasm/hindcast_engine.js';
import type { Journey, TraceSpan } from '../sim/des/des';

/**
 * One sampled request (a journey from the discrete-event engine) laid out for reading: the text
 * readout in the strip, row by row in monospace (worded in the engine, engine-rs/src/sim/journey.rs,
 * the same rows `hindcast simulate --trace` and the trace_request tool print), and the marks the
 * board draws on its nodes and links. Pure: the engine measured everything; this only words and
 * places it.
 */

/** compact: 0.4ms, 12ms, 840ms, 1.21s */
export const ms = (x: number) => (x >= 1000 ? `${+(x / 1000).toFixed(x >= 10000 ? 1 : 2)}s` : x >= 10 ? `${Math.round(x)}ms` : `${+x.toFixed(1)}ms`);
/** a deadline as people set it: 500 ms, 1 s */
const deadline = (x: number) => (x >= 1000 ? `${+(x / 1000).toFixed(2)} s` : `${Math.round(x)} ms`);

export interface HopTimes {
  /** the network on the way there */
  net: number;
  /** waiting in its queue for a worker (or still waiting when the caller gave up) */
  wait: number;
  /** its own work, not counting the calls it made */
  work: number;
  /** most of the hop was spent in the queue */
  queued: boolean;
  /** the call never reached it (refused before it left, or cut off) */
  unreached: boolean;
}

export function hopTimes(j: Journey, s: TraceSpan): HopTimes {
  const cut = s.gaveUpMs ?? s.endMs ?? j.ms;
  const stuck = s.outcome === 'timeout' || s.outcome === 'open';
  // the engine's wait covers one that was worked on, or shed after waiting; one still in the queue
  // when its caller gave up waited until then
  const wait = s.startMs != null || s.waitMs > 0 ? s.waitMs : stuck && s.arriveMs != null ? Math.max(0, cut - s.arriveMs) : 0;
  const work = s.servedMs != null ? s.serviceMs : s.startMs != null ? Math.max(0, cut - s.startMs) : 0;
  const net = s.networkMs;
  return { net, wait, work, queued: wait >= 1 && wait >= 0.25 * (net + work + wait), unreached: s.arriveMs == null };
}

/** what went wrong at this hop, in the engine's words; null where it only passed a failure on */
export function failMark(j: Journey, i: number): string | null {
  const s = j.spans[i];
  if (s.outcome === 'timeout') {
    // given up on with everything below it: the mark goes where the request was stuck
    if (j.spans.some((c) => c.parent === i && c.outcome === 'timeout')) return null;
    return s.deadlineMs != null ? `timeout (${deadline(s.deadlineMs)})` : 'timeout';
  }
  if (s.outcome !== 'failed' || s.origin !== s.id || !s.reason) return null;
  // a caller that timed out waiting: the hop it gave up on carries the mark
  if (s.reason.startsWith('timed out') && j.spans.some((c) => c.parent === i && c.outcome === 'timeout')) return null;
  return s.reason;
}

export function okMark(s: TraceSpan): string | null {
  return s.outcome === 'hit' ? 'cache hit' : s.outcome === 'queued' ? 'queued for its consumers' : null;
}

const viaLabel = (s: TraceSpan) => (s.via === 'retry' ? `retry ${s.attempt} ` : s.via === 'failover' ? 'failover ' : s.via === 'routed' ? 'routed ' : '');

export type Cls = '' | 'arrow' | 'q' | 'bad' | 'ok' | 'name' | 'focus' | 'dim';
export type Run = { t: string; c: Cls };

/** the display name of each component the journey reaches */
const namesOf = (j: Journey, nameOf: (id: string) => string) => Object.fromEntries(j.spans.map((s) => [s.id, nameOf(s.id)]));

/**
 * The journey as rows of text: the first call each hop makes continues on its row, the others
 * (retries, fan-out parts, failover targets) branch below it, under the hop that made them:
 *
 *   users ─0.4ms─▶ api ══ 840ms queue + 12ms ══▶ db ✕ timeout (1 s)
 *                  └─ retry 1 ─0.3ms─▶ db ✕ overloaded
 */
export function journeyRows(j: Journey, nameOf: (id: string) => string, focus?: string | null): Run[][] {
  return wasm.journeyRows(j, namesOf(j, nameOf), focus ?? undefined) as Run[][];
}

export interface NodeMark {
  /** on the path; failed: the failure started here; timeout: a caller gave up on it here */
  state: 'on' | 'failed' | 'timeout';
  note: string | null;
}
export interface EdgeMark {
  /** one per hop over the link (a retry is a second), with its tone */
  lines: { t: string; c: '' | 'q' | 'bad' }[];
  bad: boolean;
  queued: boolean;
}
export interface BoardMarks {
  nodes: Record<string, NodeMark>;
  edges: Record<string, EdgeMark>;
}

/** what the board lights: each component the request reached, and each link with its hops' times */
export function boardMarks(j: Journey, edges: { id: string; source: string; target: string }[]): BoardMarks {
  const nodes: Record<string, NodeMark> = {};
  const byPair = new Map(edges.map((e) => [`${e.source}>${e.target}`, e.id]));
  const lines: Record<string, { text: string; bad: boolean; queued: boolean }[]> = {};
  j.spans.forEach((s, i) => {
    const bad = failMark(j, i);
    const prev = nodes[s.id];
    const state: NodeMark['state'] = s.outcome === 'timeout' && bad ? 'timeout' : bad ? 'failed' : 'on';
    if (!prev || (prev.state === 'on' && state !== 'on')) nodes[s.id] = { state, note: bad ?? okMark(s) ?? prev?.note ?? null };
    // a retry that failed here differently: both, in order
    else if (bad && prev.state !== 'on' && prev.note && !prev.note.split(', then ').includes(bad)) prev.note = `${prev.note}, then ${bad}`;
    if (s.parent < 0) return;
    const id = byPair.get(`${j.spans[s.parent].id}>${s.id}`);
    if (!id) return;
    const t = hopTimes(j, s);
    const via = viaLabel(s);
    const time = t.unreached ? 'not sent' : t.queued ? `${ms(t.wait)} queue${t.net + t.work >= 1 ? ` · ${ms(t.net + t.work)}` : ''}` : ms(t.net + t.work);
    // the reason is on the component; the link says which attempt failed
    (lines[id] ??= []).push({ text: `${via ? via.trim() + ' · ' : ''}${time}${bad ? ' ✕' : ''}`, bad: !!bad, queued: t.queued });
  });
  const out: Record<string, EdgeMark> = {};
  for (const [id, ls] of Object.entries(lines)) {
    const tone = (l: (typeof ls)[number]) => ({ t: l.text, c: l.bad ? ('bad' as const) : l.queued ? ('q' as const) : ('' as const) });
    // a link stays short: the first hop over it, then the rest in one line
    const rest = ls.slice(1);
    const retries = rest.every((l) => l.text.startsWith('retry'));
    const more = rest.length ? [{ t: `+${rest.length} ${retries ? (rest.length > 1 ? 'retries' : 'retry') : 'more'}${rest.some((l) => l.bad) ? ' ✕' : ''}`, c: rest.some((l) => l.bad) ? ('bad' as const) : ('' as const) }] : [];
    const shown = rest.length === 1 ? ls.map(tone) : [tone(ls[0]), ...more];
    out[id] = { lines: shown, bad: ls.some((l) => l.bad), queued: ls.some((l) => l.queued) };
  }
  return { nodes, edges: out };
}

/** the one-line summary: what it was, how long the user waited, and how it ended */
export function journeyVerdict(j: Journey, nameOf: (id: string) => string): string {
  return wasm.journeyVerdict(j, namesOf(j, nameOf));
}
