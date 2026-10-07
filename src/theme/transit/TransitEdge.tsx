import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, useInternalNode, type EdgeProps } from '@xyflow/react';
import { X } from 'lucide-react';
import type { SystemNode } from '../../sim/catalog';
import { kindColor } from '../themes';

const DISRUPTED = '#D7261E';

/** Trains: short rounded cars riding the line via SMIL, oriented along the track. */
const Trains = memo(function Trains({ path, count, dur, fail }: { path: string; count: number; dur: number; fail?: boolean }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => {
        const begin = `${(-(i * dur) / count).toFixed(2)}s`;
        return (
          <g key={i} className={fail ? 'train fail' : 'train'}>
            <rect x={-8} y={-3.5} width={16} height={7} rx={3.5}>
              {fail ? (
                <>
                  <animateMotion dur={`${dur}s`} repeatCount="indefinite" path={path} begin={begin} rotate="auto" keyPoints="0;0.7" keyTimes="0;1" calcMode="linear" />
                  <animate attributeName="opacity" values="1;1;0" keyTimes="0;0.7;1" dur={`${dur}s`} begin={begin} repeatCount="indefinite" />
                </>
              ) : (
                <animateMotion dur={`${dur}s`} repeatCount="indefinite" path={path} begin={begin} rotate="auto" />
              )}
            </rect>
          </g>
        );
      })}
    </>
  );
});

export interface TransitEdgeData {
  rps: number;
  err: number;
  util: number;
  running: boolean;
  onRemove: () => void;
  cap?: number;
}

function TransitEdgeImpl({ id, source, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, data }: EdgeProps & { data: TransitEdgeData }) {
  const [path, lx, ly] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 22, offset: 26 });
  const src = useInternalNode<SystemNode>(source);
  const { rps, err, util, running, onRemove } = data;
  const color = src?.data.kind ? kindColor('transit', src.data.kind) : '#16161a';
  const live = rps >= 0.5;
  const width = live ? 6 + Math.min(6, Math.log10(rps + 1) * 1.6) : 5;
  const total = !live ? 0 : Math.min(Math.min(10, data.cap ?? 10), Math.max(1, Math.round(Math.log2(rps + 1) * 0.9)));
  const failN = err > 0.02 ? Math.max(1, Math.round(total * err)) : 0;
  const okN = Math.max(0, total - failN);
  const dur = Math.round((2 + Math.min(2.5, util * 1.8)) * 4) / 4;
  const disrupted = err > 0.05;

  return (
    <>
      {/* paper-coloured casing separates crossing lines, like on a printed map */}
      <path d={path} fill="none" className="tr-casing" strokeWidth={width + 6} />
      <BaseEdge id={id} path={path} interactionWidth={26} style={{ stroke: color, strokeWidth: width, opacity: live || selected ? 1 : 0.45 }} />
      {disrupted && <path d={path} fill="none" stroke={DISRUPTED} strokeWidth={width} className="tr-disrupted" />}
      {running && okN > 0 && <Trains path={path} count={okN} dur={dur} />}
      {running && failN > 0 && <Trains path={path} count={failN} dur={dur} fail />}
      <EdgeLabelRenderer>
        <div className="edge-label nodrag nopan" style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}>
          {live && <span className={`tr-rps ${disrupted ? 'bad' : ''}`}>{rps >= 1000 ? `${(rps / 1000).toFixed(1)}k` : rps.toFixed(0)}/s</span>}
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

export const TransitEdge = memo(TransitEdgeImpl);
