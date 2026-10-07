import { Handle, Position } from '@xyflow/react';
import { KINDS, type SystemNodeData } from '../../sim/catalog';
import type { NodeStats } from '../../sim/engine';
import { KIND_ICONS } from '../../canvas/icons';
import { explain, healthOf, type NodeView } from '../../canvas/nodeModel';

const STATUS: Record<NodeView['health'], string> = {
  idle: 'Idle',
  ok: 'Healthy',
  warm: 'Busy',
  hot: 'Overloaded',
  down: 'Down',
};

/**
 * A component as a figure in an engineering reference: a spec card with a status strip,
 * key/value readings, a utilisation scale, and a plain-English callout when something is happening.
 */
export function RefNode({ data, st, v, selected, showCost, running, explainOn }: { data: SystemNodeData; st: NodeStats | undefined; v: NodeView; selected: boolean; showCost: boolean; running: boolean; explainOn: boolean }) {
  const spec = KINDS[data.kind];
  const Icon = KIND_ICONS[data.kind];
  const note = explainOn ? explain(data, st, v) : null;
  const util = st?.util ?? 0;
  const reachable = running ? (st?.reachable ?? v.instancesUp) : v.instancesUp;
  const status = v.failedOver ? 'Failed over' : v.electing ? 'Electing' : v.promotedReplica ? 'Primary' : STATUS[v.health];

  return (
    <div className={`ref-node s-${v.health} ${selected ? 'sel' : ''} ${v.promotedReplica ? 'promoted' : ''}`}>
      {data.kind !== 'client' && <Handle type="target" position={Position.Left} className="ref-handle" />}
      <div className="ref-head">
        <Icon size={15} strokeWidth={1.75} className="ref-icon" />
        <div className="ref-titles">
          <div className="ref-kind">
            {spec.label}
            {spec.tiered && <span> · {data.tier}</span>}
          </div>
          <div className="ref-name">
            {data.name}
            {spec.scalable && v.instances > 1 && <span className="ref-mult">×{v.instances}</span>}
          </div>
        </div>
        <span className="ref-status">{status}</span>
      </div>

      <dl className="ref-rows">
        {v.stats.map((s) => (
          <div key={s.label} className={s.bad ? 'bad' : ''}>
            <dt>{s.label}</dt>
            <dd>{s.value}</dd>
          </div>
        ))}
        {showCost && data.kind !== 'client' && (
          <div>
            <dt>cost{v.sku && <span className="ref-sku"> · {v.sku}</span>}</dt>
            <dd>${v.cost.toFixed(2)}/h</dd>
          </div>
        )}
      </dl>

      {v.meter && (
        <div className="ref-scale">
          <div className="ref-scale-head">
            <span>{v.meter.label.toLowerCase()}</span>
            <span>{v.meter.value}</span>
          </div>
          <div className="ref-scale-track">
            <div className="ref-scale-fill" style={{ width: `${Math.min(100, v.meter.fill * 100)}%` }} />
            <i style={{ left: '70%' }} />
          </div>
        </div>
      )}

      {spec.scalable && (v.instances > 1 || v.booting > 0 || data.autoscale) && (
        <div className="ref-instances">
          {Array.from({ length: v.instances }, (_, i) => {
            const s = i >= v.instancesUp ? 'dead' : i >= reachable ? 'idle' : healthOf(util, st?.dropRps ?? 0, st?.inRps ?? 0, true);
            return <span key={i} className={`ri-${s}`} />;
          })}
          {Array.from({ length: v.booting }, (_, i) => (
            <span key={`b${i}`} className="ri-boot" title="Booting" />
          ))}
          <em>
            {v.instancesUp}/{v.instances} up{v.booting > 0 && ` · +${v.booting} booting`}
          </em>
        </div>
      )}

      {v.tags.length > 0 && (
        <div className="ref-tags">
          {v.tags.map((t) => (
            <span key={t.text} className={t.tone ?? ''}>
              {t.text.toLowerCase()}
            </span>
          ))}
        </div>
      )}

      {note && <div className={`ref-note ${note.tone}`}>{note.text}</div>}
      <Handle type="source" position={Position.Right} className="ref-handle" />
    </div>
  );
}
