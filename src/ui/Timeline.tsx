import { useEffect, useMemo, useRef } from 'react';
import { useSim, recorders } from '../sim/store';

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

/** the recorded run as a postmortem-style timeline */
export function timelineMarkdown(): string {
  const s = useSim.getState();
  const rec = recorders.main;
  const fr = rec.frames;
  if (!fr.length) return '';
  const slo = { err: s.settings.sloErrorRate, p99: s.settings.sloP99Ms };
  const peakErr = fr.reduce((a, f) => (f.global.errorRate > a.global.errorRate ? f : a), fr[0]);
  const peakP99 = fr.reduce((a, f) => (f.global.p99 > a.global.p99 ? f : a), fr[0]);
  const out = fr.filter((f) => f.global.rps > 0.5 && (f.global.errorRate > slo.err || f.global.p99 > slo.p99)).length * 0.25;
  const failed = fr.reduce((a, f) => a + f.global.rps * f.global.errorRate * 0.25, 0);
  const lines = [
    `# Incident timeline — ${s.boards.main.title}`,
    '',
    `Recorded ${fmt(fr[0].t)}–${fmt(fr[fr.length - 1].t)} (simulated). SLO: errors ≤ ${+(slo.err * 100).toFixed(2)}%, p99 ≤ ${slo.p99} ms.`,
    '',
    `- Out of SLO for **${out.toFixed(1)} s**; about **${Math.round(failed).toLocaleString('en-US')}** requests failed`,
    `- Peak errors **${(peakErr.global.errorRate * 100).toFixed(1)}%** at ${fmt(peakErr.t)}; peak p99 **${Math.round(peakP99.global.p99)} ms** at ${fmt(peakP99.t)}`,
    '',
    '| time | event |',
    '|---|---|',
    ...rec.marks.filter((m) => m.t >= fr[0].t).map((m) => `| ${fmt(m.t)} | ${m.text.replace(/\|/g, '/')} |`),
  ];
  return lines.join('\n');
}

/**
 * Flight-recorder track: error rate (red) and throughput (faint) over the whole run, with every
 * event as a tick. Drag to scrub — the board shows exactly what it looked like at that moment.
 */
export function Timeline() {
  const v = useSim((s) => s.recVersion);
  const scrub = useSim((s) => s.scrub);
  const setScrub = useSim((s) => s.setScrub);
  const track = useRef<HTMLDivElement>(null);
  const rec = recorders.main;
  const n = rec.frames.length;

  const paths = useMemo(() => {
    const fr = rec.frames;
    if (fr.length < 2) return null;
    const maxRps = Math.max(1, ...fr.map((f) => f.global.rps));
    const x = (i: number) => (i / (fr.length - 1)) * 1000;
    let err = `M0,40`;
    let rps = '';
    fr.forEach((f, i) => {
      err += ` L${x(i).toFixed(1)},${(40 - Math.min(1, f.global.errorRate) * 38).toFixed(1)}`;
      rps += `${i ? ' L' : 'M'}${x(i).toFixed(1)},${(40 - (f.global.rps / maxRps) * 34).toFixed(1)}`;
    });
    err += ` L1000,40 Z`;
    return { err, rps };
  }, [v]); // eslint-disable-line react-hooks/exhaustive-deps

  const at = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * (n - 1));
  };

  useEffect(() => {
    if (!scrub) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest?.('input, select, textarea')) return;
      const s = useSim.getState();
      if (!s.scrub) return;
      if (e.key === 'ArrowLeft') s.setScrub(s.scrub.index - (e.shiftKey ? 20 : 4));
      else if (e.key === 'ArrowRight') s.setScrub(s.scrub.index + (e.shiftKey ? 20 : 4));
      else if (e.key === 'Escape') s.setScrub(null);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [scrub]);

  if (n < 2 || !paths) return null;
  const t0 = rec.frames[0].t;
  const t1 = rec.frames[n - 1].t;
  const pos = (t: number) => `${((t - t0) / Math.max(1e-9, t1 - t0)) * 100}%`;
  const head = scrub ? scrub.index / (n - 1) : 1;
  const cur = scrub ? rec.frames[scrub.index] : null;

  return (
    <div className={`tl ${scrub ? 'scrubbing' : ''}`}>
      <div
        className="tl-track"
        ref={track}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          setScrub(at(e.clientX));
        }}
        onPointerMove={(e) => e.buttons === 1 && setScrub(at(e.clientX))}
        title="Drag to rewind — the board shows that moment"
      >
        <svg viewBox="0 0 1000 40" preserveAspectRatio="none">
          <path d={paths.rps} className="tl-rps" />
          <path d={paths.err} className="tl-err" />
        </svg>
        {rec.marks
          .filter((m) => m.t >= t0)
          .map((m, i) => (
            <i key={i} className={`tl-mark ${m.tone}`} style={{ left: pos(m.t) }} title={`${fmt(m.t)} ${m.text}`} />
          ))}
        <i className="tl-head" style={{ left: `${head * 100}%` }} />
      </div>
      <div className="tl-meta">
        {cur ? (
          <>
            <b>{fmt(cur.t)}</b>
            <span>
              {Math.round(cur.global.rps)} req/s · {(cur.global.errorRate * 100).toFixed(1)}% errors · p99 {Math.round(cur.global.p99)} ms
            </span>
            <button className="tl-live" onClick={() => setScrub(null)}>
              back to live
            </button>
          </>
        ) : (
          <>
            <span>
              {fmt(t0)}–{fmt(t1)} recorded · drag to rewind
            </span>
            <button
              className="tl-live"
              title="Copy the run as an incident timeline (Markdown) — events, peaks, time out of SLO"
              onClick={() => {
                navigator.clipboard?.writeText(timelineMarkdown());
                useSim.getState().toast('good', 'Incident timeline copied (Markdown)');
              }}
            >
              copy timeline
            </button>
          </>
        )}
      </div>
    </div>
  );
}
