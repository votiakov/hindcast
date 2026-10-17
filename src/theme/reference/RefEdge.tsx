import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LinkLatency } from '../../canvas/LinkLatency';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, useStore, type EdgeProps, type ReactFlowState } from '@xyflow/react';
import { pathPoints, placeLabel, type Box } from '../../canvas/labelSpot';
import { X } from 'lucide-react';
import type { EdgeMark } from '../../ui/journey';

export interface RefEdgeData {
  rps: number;
  err: number;
  util: number;
  running: boolean;
  onRemove: () => void;
  /** max particles per edge (board-wide budget) */
  cap?: number;
  /** a traced request: its hops over this link, or 'off' when it did not take it */
  trace?: EdgeMark | 'off' | null;
}

/** Small, quiet request dots — present, not decorative. */
const Dots = memo(function Dots({ path, count, dur, fail }: { path: string; count: number; dur: number; fail?: boolean }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => {
        const begin = `${(-(i * dur) / count).toFixed(2)}s`;
        return (
          <circle key={i} r={fail ? 2.8 : 2.4} className={fail ? 'ref-dot fail' : 'ref-dot'}>
            {fail ? (
              <>
                <animateMotion dur={`${dur}s`} repeatCount="indefinite" path={path} begin={begin} keyPoints="0;0.75" keyTimes="0;1" calcMode="linear" />
                <animate attributeName="opacity" values="1;1;0" keyTimes="0;0.7;1" dur={`${dur}s`} begin={begin} repeatCount="indefinite" />
              </>
            ) : (
              <animateMotion dur={`${dur}s`} repeatCount="indefinite" path={path} begin={begin} />
            )}
          </circle>
        );
      })}
    </>
  );
});

/** the cards on the board (components and notes) as one string, so a link redraws only when one moves or resizes */
const cardKey = (s: ReactFlowState) => {
  let k = '';
  for (const n of s.nodeLookup.values()) {
    if (n.type !== 'system' && n.type !== 'note') continue;
    const { width: w, height: h } = n.measured;
    if (w && h) k += `${Math.round(n.internals.positionAbsolute.x)},${Math.round(n.internals.positionAbsolute.y)},${Math.round(w)},${Math.round(h)};`;
  }
  return k;
};
const cardBoxes = (k: string): Box[] =>
  k
    .split(';')
    .filter(Boolean)
    .map((c) => {
      const [x, y, w, h] = c.split(',').map(Number);
      return { x, y, w, h };
    });

/** the label's size as laid out (flow units), re-read after every render: its text changes as the run goes */
function useLabelSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const [w, h] = [el.offsetWidth, el.offsetHeight];
    if (Math.abs(w - size.w) > 1 || Math.abs(h - size.h) > 1) setSize({ w, h });
  });
  return [ref, size] as const;
}

function RefEdgeImpl({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, data }: EdgeProps & { data: RefEdgeData }) {
  const [path, lx, ly] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 6, offset: 20 });
  const { rps, err, util, running, onRemove } = data;
  const tr = data.trace && data.trace !== 'off' ? data.trace : null;
  const trOff = data.trace === 'off';
  const live = rps >= 0.5;
  const failing = err > 0.05;
  const width = live ? 1.5 + Math.min(2, Math.log10(rps + 1) * 0.6) : 1.25;
  const total = !live ? 0 : Math.min(Math.min(12, data.cap ?? 12), Math.max(2, Math.round(Math.log2(rps + 1) * 1.2)));
  const failN = err > 0.02 ? Math.max(1, Math.round(total * err)) : 0;
  const okN = Math.max(0, total - failN);
  // more traffic, faster dots; a congested link slows them down (bucketed: React keeps the animations)
  const pace = Math.min(2.4, Math.max(0.9, 2.4 - 0.32 * Math.log10(rps + 1)));
  const dur = Math.round(pace * (1 + Math.min(0.8, util * 0.6)) * 4) / 4;
  // the label keeps clear of the cards: along the link to the nearest free spot, else lifted over them
  const cards = useStore(cardKey);
  const [label, size] = useLabelSize();
  const spot = useMemo(() => placeLabel(pathPoints(path), size, cardBoxes(cards), { x: lx, y: ly }), [path, lx, ly, size, cards]);

  return (
    <g className={trOff ? 'tr-off-edge' : undefined}>
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={22}
        markerEnd={failing || tr?.bad ? 'url(#ref-arrow-bad)' : 'url(#ref-arrow)'}
        className={`ref-edge ${failing ? 'bad' : ''} ${live ? 'live' : ''} ${selected ? 'sel' : ''} ${tr ? `tr-on ${tr.bad ? 'tr-bad' : tr.queued ? 'tr-q' : ''}` : ''}`}
        style={{ strokeWidth: tr ? Math.max(width, 2.5) : width }}
      />
      {running && !tr && okN > 0 && <Dots path={path} count={okN} dur={dur} />}
      {running && !tr && failN > 0 && <Dots path={path} count={failN} dur={dur} fail />}
      <EdgeLabelRenderer>
        <div ref={label} className={`edge-label nodrag nopan ${trOff ? 'tr-off-edge' : ''} ${spot.over ? 'over' : ''}`} style={{ transform: `translate(-50%, -50%) translate(${spot.x}px, ${spot.y}px)`, zIndex: tr || spot.over || selected ? 2 : undefined }}>
          {tr && (
            <span className="tr-label">
              {tr.lines.map((l, i) => (
                <span key={i} className={l.c}>
                  {l.t}
                </span>
              ))}
            </span>
          )}
          {live && !tr && (
            <span className={`ref-rate ${failing ? 'bad' : ''}`} title={`${Math.round(rps)} requests a second over this link${failing ? `; ${Math.round(err * 100)}% of them fail, where it leads or further on. The error rate at the top counts what the users see, over all their requests` : ''}`}>
              <span className="ref-rps">{rps >= 1000 ? `${(rps / 1000).toFixed(1)}k` : rps.toFixed(0)} req/s</span>
              {failing && (
                <b>
                  <span className="ref-rps"> · </span>
                  {Math.round(err * 100)}% err
                </b>
              )}
            </span>
          )}
          <LinkLatency id={id} selected={selected} />
          {selected && (
            <button className="edge-x" onClick={onRemove} title="Delete connection">
              <X size={12} />
            </button>
          )}
        </div>
      </EdgeLabelRenderer>
    </g>
  );
}

export const RefEdge = memo(RefEdgeImpl);

/** arrowhead markers; rendered once per canvas */
export function RefMarkers() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
      <defs>
        <marker id="ref-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
          <path d="M0,1 L9,5 L0,9 z" className="ref-arrow" />
        </marker>
        <marker id="ref-arrow-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
          <path d="M0,1 L9,5 L0,9 z" className="ref-arrow bad" />
        </marker>
      </defs>
    </svg>
  );
}
