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

/** above this many instances the fleet folds back into pips */
const FLEET_MAX = 12;

type InstanceState = 'ok' | 'warm' | 'hot' | 'idle' | 'dead' | 'boot';

/**
 * Each instance as a row, the balancer's traffic fanned out to the ones that serve: a dead one is
 * routed around, a booting one waits. Every serving instance takes an even share (the engine balances
 * evenly), so their bars match — what differs is which ones are there.
 */
function Fleet({ name, states, util, motion }: { name: string; states: InstanceState[]; util: number; motion: boolean }) {
  const ROW = 22;
  const h = states.length * ROW;
  const mid = h / 2;
  return (
    <div className="ref-fleet">
      <svg className="ref-fan" width="26" height={h} aria-hidden>
        {states.map((s, i) => {
          const y = i * ROW + ROW / 2;
          const d = `M0 ${mid} C14 ${mid} 12 ${y} 26 ${y}`;
          const serving = s !== 'dead' && s !== 'boot' && s !== 'idle';
          return (
            <g key={i}>
              <path d={d} className={`fan ${serving ? '' : 'off'}`} />
              {motion && serving && (
                <circle r="1.8" className="ref-dot">
                  <animateMotion dur="1.1s" begin={`${-(i * 0.37) % 1.1}s`} repeatCount="indefinite" path={d} />
                </circle>
              )}
            </g>
          );
        })}
      </svg>
      <div className="ref-fleet-rows">
        {states.map((s, i) => (
          <div key={i} className={`fr fr-${s}`} style={{ height: ROW }}>
            <span className="fr-n">
              {name}-{i + 1}
            </span>
            {s === 'dead' ? (
              <span className="fr-note">down · routed around</span>
            ) : s === 'boot' ? (
              <span className="fr-note">booting</span>
            ) : s === 'idle' ? (
              <span className="fr-note">unreachable</span>
            ) : (
              <>
                <span className="fr-bar">
                  <i style={{ width: `${Math.min(100, util * 100)}%` }} />
                </span>
                <span className="fr-v">{Math.round(util * 100)}%</span>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A component as a figure in an engineering reference: a spec card with a status strip,
 * key/value readings, a utilisation scale, and a plain-English callout when something is happening.
 */
export function RefNode({ data, st, v, selected, showCost, running, motion = false, each = false, explainOn, controls }: { data: SystemNodeData; st: NodeStats | undefined; v: NodeView; selected: boolean; showCost: boolean; running: boolean; motion?: boolean; each?: boolean; explainOn: boolean; controls?: React.ReactNode }) {
  const spec = KINDS[data.kind];
  const Icon = KIND_ICONS[data.kind];
  const note = explainOn ? explain(data, st, v) : null;
  const util = st?.util ?? 0;
  const reachable = running ? (st?.reachable ?? v.instancesUp) : v.instancesUp;
  const failing = v.health === 'hot' || v.health === 'warm';
  const users = data.kind === 'client' && (v.health === 'hot' || v.health === 'warm') ? (v.health === 'hot' ? 'Failing' : 'Degraded') : null;
  const status = users ?? (v.failedOver ? 'Failed over' : v.electing ? 'Electing' : v.promotedReplica ? 'Primary' : v.noTargets && failing ? 'No targets' : v.noOrigin && failing ? 'No origin' : STATUS[v.health]);

  const fleet = spec.scalable && each && v.instances + v.booting > 1 && v.instances + v.booting <= FLEET_MAX;
  return (
    <div className={`ref-node s-${v.health} ${fleet ? 'fleet' : ''} ${selected ? 'sel' : ''} ${controls ? 'open' : ''} ${v.promotedReplica ? 'promoted' : ''} ${motion ? 'live' : ''}`}>
      {data.kind !== 'client' && <Handle type="target" position={Position.Left} className="ref-handle" />}
      <div className="ref-head">
        <span className="ref-glyph" style={{ ['--kind' as string]: spec.color }}>
          <Icon size={13} strokeWidth={1.9} />
        </span>
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

      {fleet && (
        <Fleet
          name={data.name}
          util={util}
          motion={motion}
          states={[
            ...Array.from({ length: v.instances }, (_, i): InstanceState => (i >= v.instancesUp ? 'dead' : i >= reachable ? 'idle' : healthOf(util, st?.dropRps ?? 0, st?.inRps ?? 0, true) === 'hot' ? 'hot' : util >= 0.7 ? 'warm' : 'ok')),
            ...Array.from({ length: v.booting }, (): InstanceState => 'boot'),
          ]}
        />
      )}

      {spec.scalable && (v.instances > 1 || v.booting > 0 || data.autoscale) && !fleet && (
        <div className="ref-instances">
          {Array.from({ length: v.instances }, (_, i) => {
            // 'idle' styles an unreachable instance (dashed); one that is simply not busy is healthy
            const h = healthOf(util, st?.dropRps ?? 0, st?.inRps ?? 0, true);
            const s = i >= v.instancesUp ? 'dead' : i >= reachable ? 'idle' : h === 'idle' ? 'ok' : h;
            return <span key={i} className={`ri-${s}`} title={`${data.name}-${i + 1}: ${s === 'dead' ? 'down' : s === 'idle' ? 'unreachable (no load balancer)' : `${Math.round(util * 100)}%`}`} />;
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
      {controls}
      <Handle type="source" position={Position.Right} className="ref-handle" />
    </div>
  );
}
