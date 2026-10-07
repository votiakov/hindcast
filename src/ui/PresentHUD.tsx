import { useEffect, useState } from 'react';
import { useSim } from '../sim/store';
import { replay } from './AuditPanel';
import './present.css';

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

/** the incidents worth showing on stage, worst first */
export function deck() {
  const r = useSim.getState().audit.result;
  return r ? r.findings.filter((f) => f.kind !== 'headroom' && f.severity !== 'ok') : [];
}

export function presentStep(dir: 1 | -1) {
  const s = useSim.getState();
  const d = deck();
  if (!d.length || s.mode !== 'sandbox') return;
  const i = Math.max(0, Math.min(d.length - 1, s.presentIdx + dir));
  s.setPresentIdx(i);
  replay(d[i]);
}

/**
 * Presentation overlay: the board is the slide. Big, legible numbers; the latest event as a caption;
 * ←/→ walk through the failure audit's incidents, each replayed live.
 */
export function PresentHUD() {
  const mode = useSim((s) => s.mode);
  const g = useSim((s) => s.boards[s.mode === 'compare' ? s.focus : 'main'].global);
  const a = useSim((s) => s.boards.A.global);
  const b = useSim((s) => s.boards.B.global);
  const titleA = useSim((s) => s.boards.A.title);
  const titleB = useSim((s) => s.boards.B.title);
  const title = useSim((s) => (s.mode === 'sandbox' ? s.boards.main.title : s.mode === 'compare' ? `${s.boards.A.title} vs ${s.boards.B.title}` : s.mode === 'lesson' ? s.lesson.lesson.title : 'Bottleneck'));
  const pb = useSim((s) => s.playback);
  const idx = useSim((s) => s.presentIdx);
  const toasts = useSim((s) => s.toasts);
  const [caption, setCaption] = useState<{ id: number; text: string; tone: string } | null>(null);
  const d = deck();

  useEffect(() => {
    const t = toasts[toasts.length - 1];
    if (t && t.id !== caption?.id) setCaption({ id: t.id, text: t.text.replace(/^[^\p{L}\p{N}[]+/u, ''), tone: t.tone });
  }, [toasts]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!caption) return;
    const t = setTimeout(() => setCaption(null), 4500);
    return () => clearTimeout(t);
  }, [caption]);

  const big = (label: string, value: string, tone?: string) => (
    <div className={`ph-num ${tone ?? ''}`}>
      <div className="ph-v">{value}</div>
      <div className="ph-l">{label}</div>
    </div>
  );
  const errTone = (e: number, rps: number) => (rps < 0.5 ? '' : e > 0.01 ? 'bad' : 'good');

  return (
    <div className="ph">
      <div className="ph-top">
        <div className="ph-title">
          <div className="ph-t1">{title}</div>
          {pb && <div className="ph-t2">{pb.title}</div>}
        </div>
        {mode === 'compare' ? (
          <div className="ph-nums">
            {big(`${titleA} errors`, `${(a.errorRate * 100).toFixed(1)}%`, errTone(a.errorRate, a.rps))}
            {big(`${titleB} errors`, `${(b.errorRate * 100).toFixed(1)}%`, errTone(b.errorRate, b.rps))}
            {big(`${titleA} $/mo`, `$${Math.round(a.cost * 730).toLocaleString('en-US')}`)}
            {big(`${titleB} $/mo`, `$${Math.round(b.cost * 730).toLocaleString('en-US')}`)}
          </div>
        ) : (
          <div className="ph-nums">
            {big('req/s', g.rps >= 1000 ? `${(g.rps / 1000).toFixed(1)}k` : g.rps.toFixed(0))}
            {big('errors', `${(g.errorRate * 100).toFixed(g.errorRate < 0.1 ? 2 : 1)}%`, errTone(g.errorRate, g.rps))}
            {big('p99', fmtMs(g.p99), g.rps < 0.5 ? '' : g.p99 > 300 ? 'bad' : 'good')}
            {big('per month', `$${Math.round(g.cost * 730).toLocaleString('en-US')}`)}
          </div>
        )}
      </div>
      {caption && (
        <div key={caption.id} className={`ph-caption ${caption.tone}`}>
          {caption.text}
        </div>
      )}
      <div className="ph-keys">
        {d.length > 0 && mode === 'sandbox' && (
          <span>
            ← → incidents {idx >= 0 ? `${idx + 1}/${d.length}` : `(${d.length})`}
          </span>
        )}
        <span>space play</span>
        <span>F fullscreen</span>
        <span>esc exit</span>
      </div>
    </div>
  );
}
