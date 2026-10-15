import { memo } from 'react';
import { type EdgeProps } from '@xyflow/react';
import { useSim } from '../sim/store';
import { useBoardId } from './BoardContext';
import { RefEdge } from '../theme/reference/RefEdge';

function FlowEdgeImpl(props: EdgeProps) {
  const { id } = props;
  const b = useBoardId();
  const es = useSim((s) => s.boards[b].edgeStats[id]);
  const running = useSim((s) => s.running && s.settings.particles);
  const removeEdge = useSim((s) => s.removeEdge);
  // SVG particles are the most expensive thing on screen: share a fixed budget across the board
  const cap = useSim((s) => Math.max(2, Math.min(16, Math.floor(220 / Math.max(1, s.boards[b].edges.length)))));
  const data = { rps: es?.rps ?? 0, err: Math.min(1, Math.max(0, es?.errRatio ?? 0)), util: es?.util ?? 0, running, cap, onRemove: () => removeEdge(b, id) };
  return <RefEdge {...props} data={data} />;
}

export const FlowEdge = memo(FlowEdgeImpl);
