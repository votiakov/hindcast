import { Handle, Position } from '@xyflow/react';
import { KINDS, type SystemNodeData } from '../../sim/catalog';
import type { NodeStats } from '../../sim/engine';
import { KIND_ICONS } from '../../canvas/icons';
import { healthOf, type NodeView } from '../../canvas/nodeModel';
import { kindColor } from '../themes';

const CROWD_CELLS = 10;

/**
 * A component drawn as a metro station: the line runs straight through a track segment,
 * the marker sits on it (an interchange pill with one dot per instance), and the label
 * underneath reads like station signage.
 */
export function Station({ data, st, v, selected, showCost, running }: { data: SystemNodeData; st: NodeStats | undefined; v: NodeView; selected: boolean; showCost: boolean; running: boolean }) {
  const spec = KINDS[data.kind];
  const Icon = KIND_ICONS[data.kind];
  const color = kindColor('transit', data.kind);
  const util = st?.util ?? 0;
  const crowd = v.meter ? Math.min(CROWD_CELLS, Math.round(Math.min(v.meter.fill, 1.2) * CROWD_CELLS)) : 0;
  const reachable = running ? (st?.reachable ?? v.instancesUp) : v.instancesUp;

  return (
    <div className={`stn h-${v.health} ${selected ? 'sel' : ''} ${v.promotedReplica ? 'promoted' : ''} ${v.failedOver ? 'failed-over' : ''}`} style={{ ['--kc' as string]: color }}>
      {data.kind !== 'client' && <Handle type="target" position={Position.Left} className="stn-handle" />}
      <div className="stn-track" />
      <div className="stn-marker">
        {spec.scalable && v.instances > 1 ? (
          <div className="stn-pill">
            {Array.from({ length: v.instances }, (_, i) => {
              const s = i >= v.instancesUp ? 'dead' : i >= reachable ? 'idle' : healthOf(util, st?.dropRps ?? 0, st?.inRps ?? 0, true);
              return <span key={i} className={`stn-pip p-${s}`} />;
            })}
          </div>
        ) : (
          <div className="stn-dot" />
        )}
      </div>
      <Handle type="source" position={Position.Right} className="stn-handle" />

      <div className="stn-label">
        <div className="stn-name">
          <span className="stn-tag">
            <Icon size={12} strokeWidth={2.5} />
          </span>
          <span className="stn-title">{data.name}</span>
          {spec.scalable && v.instances > 1 && <span className="stn-count">×{v.instances}</span>}
        </div>
        <div className="stn-kind">
          {spec.label}
          {spec.tiered && <> · {data.tier}</>}
          {showCost && data.kind !== 'client' && <> · ${v.cost.toFixed(2)}/h</>}
          {v.sku && <> · {v.sku}</>}
        </div>
        <div className="stn-board">
          {v.stats.map((s) => (
            <span key={s.label} className={s.bad ? 'bad' : ''}>
              <i>{s.label}</i> {s.value}
            </span>
          ))}
        </div>
        {v.meter && (
          <div className="stn-crowd" title={`${v.meter.label} ${v.meter.value}`}>
            {Array.from({ length: CROWD_CELLS }, (_, i) => (
              <span key={i} className={i < crowd ? 'on' : ''} />
            ))}
            <b>
              {v.meter.label} {v.meter.value}
            </b>
          </div>
        )}
        {v.tags.length > 0 && (
          <div className="stn-tags">
            {v.tags.map((t) => (
              <span key={t.text} className={`stn-chip ${t.tone ?? ''}`}>
                {t.text}
              </span>
            ))}
          </div>
        )}
        {v.noOrigin && <div className="stn-notice">No origin connected — every miss fails</div>}
        {v.unreachable && <div className="stn-notice">No load balancer — only 1 instance reachable</div>}
        {v.promotedReplica && <div className="stn-notice good">Promoted → now the primary</div>}
      </div>

      {v.electing && <div className="stn-sign warn">Electing new primary…</div>}
      {!v.up && <div className={`stn-sign ${v.failedOver ? 'diverted' : ''}`}>{v.failedOver ? 'Service diverted' : 'Station closed'}</div>}
    </div>
  );
}
