import { memo } from 'react';
import { LinkLatency } from '../../canvas/LinkLatency';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@xyflow/react';
import { X } from 'lucide-react';

export interface RefEdgeData {
  rps: number;
  err: number;
  util: number;
  running: boolean;
  onRemove: () => void;
  /** max particles per edge (board-wide budget) */
  cap?: number;
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

function RefEdgeImpl({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, data }: EdgeProps & { data: RefEdgeData }) {
  const [path, lx, ly] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 6, offset: 20 });
  const { rps, err, util, running, onRemove } = data;
  const live = rps >= 0.5;
  const failing = err > 0.05;
  const width = live ? 1.5 + Math.min(2, Math.log10(rps + 1) * 0.6) : 1.25;
  const total = !live ? 0 : Math.min(Math.min(12, data.cap ?? 12), Math.max(2, Math.round(Math.log2(rps + 1) * 1.2)));
  const failN = err > 0.02 ? Math.max(1, Math.round(total * err)) : 0;
  const okN = Math.max(0, total - failN);
  // more traffic, faster dots; a congested link slows them down (bucketed: React keeps the animations)
  const pace = Math.min(2.4, Math.max(0.9, 2.4 - 0.32 * Math.log10(rps + 1)));
  const dur = Math.round(pace * (1 + Math.min(0.8, util * 0.6)) * 4) / 4;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={22}
        markerEnd={failing ? 'url(#ref-arrow-bad)' : 'url(#ref-arrow)'}
        className={`ref-edge ${failing ? 'bad' : ''} ${live ? 'live' : ''} ${selected ? 'sel' : ''}`}
        style={{ strokeWidth: width }}
      />
      {running && okN > 0 && <Dots path={path} count={okN} dur={dur} />}
      {running && failN > 0 && <Dots path={path} count={failN} dur={dur} fail />}
      <EdgeLabelRenderer>
        <div className="edge-label nodrag nopan" style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}>
          {live && (
            <span className={`ref-rate ${failing ? 'bad' : ''}`}>
              {rps >= 1000 ? `${(rps / 1000).toFixed(1)}k` : rps.toFixed(0)} req/s
              {failing && <b> · {Math.round(err * 100)}% err</b>}
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
    </>
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
