import { ReactFlowProvider } from '@xyflow/react';
import { BoardCanvas } from '../canvas/BoardCanvas';
import { useSim, type Aspect, type BoardId } from '../sim/store';
import type { GlobalStats } from '../sim/engine';
import { episodeById, episodeCaption, episodeDuration, type Episode } from './episodes';
import { brandById } from './brands';

export const ASPECTS: Record<Aspect, { w: number; h: number; label: string }> = {
  '4:5': { w: 1080, h: 1350, label: 'Feed 4:5' },
  '1:1': { w: 1080, h: 1080, label: 'Square' },
  '9:16': { w: 1080, h: 1920, label: 'Story 9:16' },
  '16:9': { w: 1920, h: 1080, label: 'Slide 16:9' },
};

const fmtRps = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(0));
const fmtMs = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n.toFixed(0)}ms`);

function metricCells(ep: Episode, g: GlobalStats) {
  const live = g.rps > 0.5;
  return ep.metrics.map((m) => {
    switch (m) {
      case 'rps':
        return { k: m, label: 'requests / sec', value: fmtRps(g.rps), tone: '' };
      case 'errors':
        return { k: m, label: 'errors', value: `${(g.errorRate * 100).toFixed(g.errorRate > 0 && g.errorRate < 0.1 ? 1 : 0)}%`, tone: !live ? '' : g.errorRate > 0.01 ? 'bad' : 'good' };
      case 'p99':
        return { k: m, label: 'p99 latency', value: fmtMs(g.p99), tone: !live ? '' : g.p99 > 500 ? 'bad' : g.p99 > 250 ? 'warn' : 'good' };
      case 'cost':
        return { k: m, label: 'cost / hour', value: `$${g.cost.toFixed(2)}`, tone: '' };
    }
  });
}

function Metrics({ ep, b, compact }: { ep: Episode; b: BoardId; compact?: boolean }) {
  const g = useSim((s) => s.boards[b].global);
  const showCost = useSim((s) => s.settings.cost);
  const cells = metricCells(ep, g).filter((c) => c.k !== 'cost' || showCost);
  return (
    <div className={`st-metrics ${compact ? 'compact' : ''}`}>
      {cells.map((c) => (
        <div key={c.k} className={`st-metric ${c.tone}`}>
          <div className="st-metric-v">{c.value}</div>
          <div className="st-metric-l">{c.label}</div>
        </div>
      ))}
    </div>
  );
}

function SingleBoard({ ep }: { ep: Episode }) {
  return (
    <div className="st-boards single">
      <div className="st-board">
        <ReactFlowProvider>
          <BoardCanvas id="main" interactive={false} minimap={false} fitDuration={0} padding={{ top: '30px', left: '30px', right: '30px', bottom: '30px' }} />
        </ReactFlowProvider>
      </div>
      <Metrics ep={ep} b="main" />
    </div>
  );
}

function CompareBoards({ ep, row }: { ep: Episode; row: boolean }) {
  const titleA = useSim((s) => s.boards.A.title);
  const titleB = useSim((s) => s.boards.B.title);
  return (
    <div className={`st-boards compare ${row ? 'row' : 'col'}`}>
      {(['A', 'B'] as const).map((b) => (
        <div key={b} className={`st-board side-${b}`}>
          <div className="st-board-head">
            <span className="pane-tag">{b}</span>
            <span className="st-board-title">{b === 'A' ? titleA : titleB}</span>
            <Metrics ep={ep} b={b} compact />
          </div>
          <div className="st-board-canvas">
            <ReactFlowProvider>
              <BoardCanvas id={b} interactive={false} minimap={false} fitDuration={0} padding={{ top: '20px', left: '20px', right: '20px', bottom: '20px' }} />
            </ReactFlowProvider>
          </div>
        </div>
      ))}
    </div>
  );
}

/** The exported frame. Always rendered at its true pixel size; the editor scales it with CSS. */
export function Stage() {
  const studio = useSim((s) => s.studio);
  const ep = episodeById(studio.episodeId);
  const brand = brandById(studio.brandId);
  const { w, h } = ASPECTS[studio.aspect];
  const caption = episodeCaption(ep, studio.t);
  const dur = episodeDuration(ep);
  const landscape = w > h;

  return (
    <div className={`stage aspect-${studio.aspect.replace(':', 'x')}`} style={{ width: w, height: h, ['--brand' as string]: brand.accent }}>
      <div className="st-header">
        <div className="st-series">
          {ep.series}
          {ep.number !== undefined && <span className="st-ep">EP. {ep.number}</span>}
        </div>
        <h1 className="st-hook">{ep.hook}</h1>
      </div>

      {ep.layout === 'single' ? <SingleBoard ep={ep} /> : <CompareBoards ep={ep} row={landscape} />}

      <div className="st-caption-wrap">
        {caption && (
          <div key={caption.at} className="st-caption">
            {caption.text}
          </div>
        )}
      </div>

      <div className="st-footer">
        <div className="st-avatar">{brand.initials}</div>
        <div className="st-brand">
          <div className="st-brand-name">{brand.name}</div>
          <div className="st-brand-line">{brand.line}</div>
        </div>
        <div className="st-link">{brand.link}</div>
      </div>
      <div className="st-progress">
        <div style={{ width: `${Math.min(100, (studio.t / dur) * 100)}%` }} />
      </div>

      {studio.finished && (
        <div className="st-outro">
          <div className="st-outro-card">
            <div className="st-series">{ep.series}</div>
            <h2>{ep.outro.title}</h2>
            {ep.outro.lines.map((l) => (
              <p key={l}>{l}</p>
            ))}
            {ep.outro.cta && <div className="st-cta">{ep.outro.cta}</div>}
            <div className="st-outro-brand">
              <div className="st-avatar">{brand.initials}</div>
              <div>
                <div className="st-brand-name">{brand.name}</div>
                <div className="st-brand-line">{brand.link}</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
