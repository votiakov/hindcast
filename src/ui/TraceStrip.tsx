import { useEffect, useMemo, useRef } from 'react';
import { useReactFlow } from '@xyflow/react';
import { X } from 'lucide-react';
import { useSim, type BoardId } from '../sim/store';
import { isSystem } from '../sim/catalog';
import { boardNow, current, listFor, TRACE_RUN_S, useTracer } from './tracer';
import { journeyRows, journeyVerdict } from './journey';
import './trace.css';

/**
 * The tracer's readout, docked at the foot of the board while a request is drawn on it: which
 * component, which of its sampled requests, the path as text (the board shows the same on its links),
 * and the run it came from. Selecting another component follows a request through that one instead.
 */
export function TraceStrip({ board }: { board: BoardId }) {
  const t = useTracer();
  const nodes = useSim((s) => s.boards[board].nodes);
  const edges = useSim((s) => s.boards[board].edges);
  const on = t.board === board && t.status !== 'idle';
  const names = useMemo(() => new Map(nodes.filter(isSystem).map((n) => [n.id, n.data.name])), [nodes]);
  const nameOf = (id: string) => names.get(id) ?? id;
  const selected = useMemo(() => nodes.find((n) => n.selected && isSystem(n))?.id ?? null, [nodes]);
  // the board changed since the run: its requests no longer describe it
  const stale = useMemo(() => on && t.status === 'ready' && !!t.run && boardNow(board).key !== t.run.key, [on, t.status, t.run, board, nodes, edges]);

  useEffect(() => {
    if (on && t.status === 'ready' && selected && selected !== t.node) t.setNode(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);
  // frame the components the sampled requests reach, above the strip
  const ref = useRef<HTMLDivElement>(null);
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (!on || t.status !== 'ready' || !t.report || !t.node) return;
    const ids = new Set(listFor(t.report, t.node, t.failedOnly).flatMap((i) => t.report!.journeys[i].spans.map((s) => s.id)));
    if (!ids.size) return;
    const timer = setTimeout(() => {
      const strip = ref.current?.getBoundingClientRect();
      const box = ref.current?.parentElement?.getBoundingClientRect();
      if (!strip || !box) return;
      const padding = { top: '70px', right: '60px', left: `${Math.round(strip.left - box.left + 20)}px`, bottom: `${Math.round(box.bottom - strip.top + 36)}px` } as const;
      void fitView({ nodes: [...ids].map((id) => ({ id })), padding, duration: 350, maxZoom: 1.1 });
    }, 40);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, t.status, t.node, t.failedOnly, t.report]);
  useEffect(() => {
    if (!on) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !(e.target as HTMLElement)?.closest?.('input, textarea, select') && t.close();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);

  if (!on || !t.node) return null;
  const list = listFor(t.report, t.node, t.failedOnly);
  const j = current(t);
  const n = t.report?.byNode[t.node];
  const rows = j ? journeyRows(j, nameOf, t.node) : [];

  return (
    <div ref={ref} className="trace-strip nodrag nopan nowheel" onPointerDown={(e) => e.stopPropagation()}>
      <div className="ts-head">
        <span className="ts-title">
          request through <b>{nameOf(t.node)}</b>
        </span>
        {t.status === 'ready' && (
          <>
            <span className="ts-step">
              <button onClick={() => t.step(-1)} disabled={list.length < 2} title="The previous sampled request">
                ‹ prev
              </button>
              <b>{list.length ? `${Math.min(t.pos, list.length - 1) + 1}/${list.length}` : '0/0'}</b>
              <button onClick={() => t.step(1)} disabled={list.length < 2} title="The next sampled request">
                next ›
              </button>
            </span>
            <button className={`ts-toggle ${t.failedOnly ? 'on' : ''}`} onClick={() => t.setFailedOnly(!t.failedOnly)} disabled={!n?.failed.length} title={n?.failed.length ? 'Only requests that failed' : 'None of the sampled requests through it failed'}>
              failed only
            </button>
            {j && (
              <span className={`ts-verdict ${j.ok ? '' : 'bad'}`} title={journeyVerdict(j, nameOf)}>
                {journeyVerdict(j, nameOf)}
              </span>
            )}
          </>
        )}
        <span className="ts-gap" />
        {t.status === 'ready' && (
          <button className="ts-act" onClick={t.rerun} title="Run the board as it is now again and sample new requests">
            run again
          </button>
        )}
        <button className="ts-x" onClick={t.close} title="Stop tracing (Esc)">
          <X size={13} />
        </button>
      </div>
      {t.status === 'running' && <div className="ts-msg">following requests through {nameOf(t.node)} in a {TRACE_RUN_S} s discrete-event run of the board as it is now…</div>}
      {t.status === 'error' && <div className="ts-msg bad">the run failed: {t.error}</div>}
      {t.status === 'ready' && !j && <div className="ts-msg">no sampled request reached {nameOf(t.node)} in the run. Is traffic flowing to it?</div>}
      {t.status === 'ready' && j && (
        <pre className="ts-path" aria-label="The request's path">
          {rows.map((r, i) => (
            <div key={i}>
              {r.map((run, k) => (
                <span key={k} className={run.c ? `c-${run.c}` : undefined}>
                  {run.t}
                </span>
              ))}
            </div>
          ))}
        </pre>
      )}
      {t.status === 'ready' && t.run && (
        <div className={`ts-foot ${stale ? 'stale' : ''}`}>
          {stale ? (
            <>The board changed since this run: run again to follow requests through it as it is now.</>
          ) : (
            <>
              {j ? `began ${j.atS.toFixed(1)} s into` : 'from'} a {TRACE_RUN_S} s discrete-event run of the board as it is now at {t.run.rps.toLocaleString('en-US')} req/s · {n ? `${n.seen.toLocaleString('en-US')} followed requests went through ${nameOf(t.node)}, ${n.seenFailed.toLocaleString('en-US')} of them failed` : 'none of the followed requests went through it'}
            </>
          )}
          <span className="ts-key">
            <i>─12ms─▶</i> network and its own work <i className="q">══ queue ══▶</i> waited for a worker first
          </span>
        </div>
      )}
    </div>
  );
}
