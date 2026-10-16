import { memo, useMemo } from 'react';
import { NodeResizer, NodeToolbar, Position, type NodeProps } from '@xyflow/react';
import { HeartPulse, Scissors, Trash2, Zap } from 'lucide-react';
import type { ZoneNode as ZoneNodeT } from '../sim/catalog';
import { useSim } from '../sim/store';
import { useBoardId } from './BoardContext';

/** Availability zone / region / VPC frame. Failing it takes down every node whose centre is inside. */
function ZoneNodeImpl({ id, data, selected }: NodeProps<ZoneNodeT>) {
  const b = useBoardId();
  const { setZoneFailed, updateZone, removeNode, toast, apply } = useSim.getState();
  // a string, so the selector returns the same value until a zone changes (a fresh array every time
  // would re-render without end)
  const othersKey = useSim((s) => JSON.stringify(s.boards[b].nodes.filter((n) => n.type === 'zone' && n.id !== id).map((n) => ({ id: n.id, label: String((n.data as { label?: string }).label ?? n.id) }))));
  const others = useMemo(() => JSON.parse(othersKey) as { id: string; label: string }[], [othersKey]);
  const partitioned = useSim((s) => s.boards[b].nodes.some((n) => n.type === 'system' && (n.data as { side?: string }).side));

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
          {partitioned ? (
            <button className="tb-btn good" onClick={() => apply(b, { type: 'heal-partition' })} title="Restore the network between zones">
              <Scissors size={14} /> Heal partition
            </button>
          ) : (
            others.length > 0 && (
              <select className="tb-select" value="" onChange={(e) => e.target.value && apply(b, { type: 'partition', a: id, b: e.target.value })} title="Network partition: cut every link between this zone and another — both keep running">
                <option value="">✂ partition from…</option>
                {others.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.label}
                  </option>
                ))}
              </select>
            )
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
