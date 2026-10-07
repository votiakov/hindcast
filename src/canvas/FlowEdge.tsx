import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, useInternalNode, type EdgeProps } from '@xyflow/react';
import { X } from 'lucide-react';
import { useSim } from '../sim/store';
import type { Kind, SystemNode } from '../sim/catalog';
import { useBoardId } from './BoardContext';
import { LinkLatency } from './LinkLatency';
import { TransitEdge } from '../theme/transit/TransitEdge';
import { RefEdge } from '../theme/reference/RefEdge';

const OK = '#22d3ee';
/** particle colour by the kind of traffic leaving a node */
const SOURCE_COLOR: Partial<Record<Kind, string>> = {
  cache: '#f472b6', // cache misses
  cdn: '#f472b6', // origin fetches
  queue: '#c084fc', // async jobs
  db: '#fbbf24', // reads offloaded to replicas
};
const ERR = '#f43f5e';

/**
 * Requests are drawn as SVG particles riding the edge path via SMIL <animateMotion>.
 * Counts and durations are bucketed so React doesn't restart animations every tick.
 */
const Particles = memo(function Particles({ path, count, dur, color, fail }: { path: string; count: number; dur: number; color: string; fail?: boolean }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => {
        const begin = `${(-(i * dur) / count).toFixed(2)}s`;
        return (
          <g key={i}>
            <circle r={fail ? 3.2 : 2.6} fill={color} className={fail ? 'particle fail' : 'particle'}>
              {fail ? (
                <>
                  <animateMotion dur={`${dur}s`} repeatCount="indefinite" path={path} begin={begin} keyPoints="0;0.78" keyTimes="0;1" calcMode="linear" />
                  <animate attributeName="opacity" values="1;1;0" keyTimes="0;0.75;1" dur={`${dur}s`} begin={begin} repeatCount="indefinite" />
                  <animate attributeName="r" values="3;3;9" keyTimes="0;0.75;1" dur={`${dur}s`} begin={begin} repeatCount="indefinite" />
                </>
              ) : (
                <animateMotion dur={`${dur}s`} repeatCount="indefinite" path={path} begin={begin} />
              )}
            </circle>
          </g>
        );
      })}
    </>
  );
});

function FlowEdgeImpl(props: EdgeProps) {
  const { id, source, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected } = props;
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const b = useBoardId();
  const es = useSim((s) => s.boards[b].edgeStats[id]);
  const running = useSim((s) => s.running && s.settings.particles);
  const theme = useSim((s) => s.settings.theme);
  const removeEdge = useSim((s) => s.removeEdge);
  const src = useInternalNode<SystemNode>(source);
  // SVG particles are the most expensive thing on screen: share a fixed budget across the board
  const cap = useSim((s) => Math.max(2, Math.min(16, Math.floor(220 / Math.max(1, s.boards[b].edges.length)))));

  if (theme !== 'neon') {
    const data = { rps: es?.rps ?? 0, err: Math.min(1, Math.max(0, es?.errRatio ?? 0)), util: es?.util ?? 0, running, cap, onRemove: () => removeEdge(b, id) };
    return theme === 'transit' ? <TransitEdge {...props} data={data} /> : <RefEdge {...props} data={data} />;
  }

  const rps = es?.rps ?? 0;
  const err = Math.min(1, Math.max(0, es?.errRatio ?? 0));
  const total = rps < 0.5 ? 0 : Math.min(cap, Math.max(2, Math.round(Math.log2(rps + 1) * 1.5)));
  const failN = err > 0.02 ? Math.max(1, Math.round(total * err)) : 0;
  const okN = Math.max(0, total - failN);
  // slower particles on congested links
  const dur = Math.round((1.4 + Math.min(2.2, (es?.util ?? 0) * 1.6)) * 4) / 4;
  const width = rps < 0.5 ? 1.5 : 1.5 + Math.min(5, Math.log10(rps + 1) * 1.4);
  const base = (src && SOURCE_COLOR[src.data.kind]) ?? OK;
  const stroke = err > 0.05 ? ERR : base;

  return (
    <>
      <BaseEdge id={id} path={path} interactionWidth={24} style={{ stroke: '#334155', strokeWidth: width + 2, opacity: selected ? 1 : 0.7 }} />
      <path d={path} fill="none" stroke={stroke} strokeWidth={width} strokeOpacity={rps > 0.5 ? 0.35 : 0.12} className="edge-glow" />
      {running && okN > 0 && <Particles path={path} count={okN} dur={dur} color={base} />}
      {running && failN > 0 && <Particles path={path} count={failN} dur={dur} color={ERR} fail />}
      <EdgeLabelRenderer>
        <div className="edge-label nodrag nopan" style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}>
          {rps >= 0.5 && <span className={`edge-rps ${err > 0.05 ? 'bad' : ''}`}>{rps >= 1000 ? `${(rps / 1000).toFixed(1)}k` : rps.toFixed(0)}/s</span>}
          <LinkLatency id={id} selected={selected} />
          {selected && (
            <button className="edge-x" onClick={() => removeEdge(b, id)} title="Delete connection">
              <X size={12} />
            </button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export const FlowEdge = memo(FlowEdgeImpl);
