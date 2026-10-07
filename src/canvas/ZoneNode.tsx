import { memo } from 'react';
import { NodeResizer, NodeToolbar, Position, type NodeProps } from '@xyflow/react';
import { HeartPulse, Trash2, Zap } from 'lucide-react';
import type { ZoneNode as ZoneNodeT } from '../sim/catalog';
import { useSim } from '../sim/store';
import { useBoardId } from './BoardContext';

/** Availability zone / region / VPC frame. Failing it takes down every node whose centre is inside. */
function ZoneNodeImpl({ id, data, selected }: NodeProps<ZoneNodeT>) {
  const b = useBoardId();
  const { setZoneFailed, updateZone, removeNode, toast } = useSim.getState();

  return (
    <>
      <NodeResizer isVisible={selected} minWidth={260} minHeight={180} lineClassName="zone-resize-line" handleClassName="zone-resize-handle" />
      <NodeToolbar isVisible={selected} position={Position.Top} align="start" className="node-toolbar">
        <div className="tb-group">
          <input className="zone-input nodrag" value={data.label} onChange={(e) => updateZone(b, id, { label: e.target.value })} />
        </div>
        <div className="tb-group">
          {data.failed ? (
            <button className="tb-btn good wide" onClick={() => setZoneFailed(b, id, false)}>
              <HeartPulse size={14} /> Restore zone
            </button>
          ) : (
            <button
              className="tb-btn danger wide"
              onClick={() => {
                setZoneFailed(b, id, true);
                toast('bad', `⚡ ${data.label} is down`);
              }}
            >
              <Zap size={14} /> Fail zone
            </button>
          )}
          <button className="tb-btn" onClick={() => removeNode(b, id)} title="Delete zone (keeps its nodes)">
            <Trash2 size={14} />
          </button>
        </div>
      </NodeToolbar>
      <div className={`zone ${data.failed ? 'failed' : ''} ${selected ? 'selected' : ''}`}>
        <div className="zone-label">
          <span className="zone-dot" />
          {data.label}
          {data.failed && <span className="zone-status">OUTAGE</span>}
        </div>
      </div>
    </>
  );
}

export const ZoneNode = memo(ZoneNodeImpl);
