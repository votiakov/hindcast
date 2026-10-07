import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { AlertTriangle, RefreshCw, Skull } from 'lucide-react';
import { KINDS, type SystemNode as SystemNodeT } from '../sim/catalog';
import { useSim } from '../sim/store';
import { KIND_ICONS } from './icons';
import { Sparkline } from './Sparkline';
import { useBoardId } from './BoardContext';
import { NodeControls } from './NodeControls';
import { RiskMark } from './RiskMark';
import { healthOf, nodeView, type Health } from './nodeModel';
import { Station } from '../theme/transit/Station';
import { RefNode } from '../theme/reference/RefNode';

export { healthOf, type Health };

export const HEALTH_COLOR: Record<Health, string> = {
  idle: '#64748b',
  ok: '#22d3ee',
  warm: '#fbbf24',
  hot: '#f43f5e',
  down: '#475569',
};

function SystemNodeImpl({ id, data, selected }: NodeProps<SystemNodeT>) {
  const b = useBoardId();
  const st = useSim((s) => s.boards[b].nodeStats[id]);
  const running = useSim((s) => s.running);
  const showCost = useSim((s) => s.settings.cost);
  const theme = useSim((s) => s.settings.theme);
  const hasOutgoing = useSim((s) => s.boards[b].edges.some((e) => e.source === id));
  const explainOn = useSim((s) => s.settings.explain);
  const v = nodeView(data, st, running, hasOutgoing);

  if (theme === 'reference') {
    return (
      <>
        <NodeControls id={id} data={data} selected={selected} />
        <RiskMark id={id} />
        <RefNode data={data} st={st} v={v} selected={selected} showCost={showCost} running={running} explainOn={explainOn} />
      </>
    );
  }

  if (theme === 'transit') {
    return (
      <>
        <NodeControls id={id} data={data} selected={selected} />
        <RiskMark id={id} />
        <Station data={data} st={st} v={v} selected={selected} showCost={showCost} running={running} />
      </>
    );
  }

  const spec = KINDS[data.kind];
  const Icon = KIND_ICONS[data.kind];
  const color = HEALTH_COLOR[v.health];
  const util = st?.util ?? 0;

  return (
    <>
      <NodeControls id={id} data={data} selected={selected} />
      <RiskMark id={id} />

      {spec.scalable &&
        Array.from({ length: Math.min(v.instances - 1, 3) }, (_, i) => (
          <div key={i} className="node-stack" style={{ ['--health' as string]: color, ['--depth' as string]: Math.min(v.instances - 1, 3) - i }} />
        ))}

      <div className={`node health-${v.health} kind-${data.kind} ${selected ? 'selected' : ''} ${v.promotedReplica ? 'promoted' : ''}`} style={{ ['--accent' as string]: spec.color, ['--health' as string]: color }}>
        {data.kind !== 'client' && <Handle type="target" position={Position.Left} className="handle" />}
        <div className="node-head">
          <div className="node-icon">
            <Icon size={18} />
          </div>
          <div className="node-title">
            <div className="node-name">
              {data.name}
              {spec.scalable && v.instances > 1 && <span className="node-badge">×{v.instances}</span>}
            </div>
            <div className="node-kind">
              {spec.label}
              {spec.tiered && <> · {data.tier}</>}
              {showCost && data.kind !== 'client' && <> · ${v.cost.toFixed(2)}/h</>}
              {v.sku && <> · {v.sku}</>}
            </div>
          </div>
          <div className="node-dot" />
        </div>

        <div className="node-stats">
          {v.stats.map((s) => (
            <div key={s.label} className={`stat ${s.bad ? 'bad' : ''}`}>
              <div className="stat-v">{s.value}</div>
              <div className="stat-l">{s.label}</div>
            </div>
          ))}
        </div>
        {v.meter && (
          <>
            <div className="node-meter">
              <div className="meter-label">
                <span>{v.meter.label}</span>
                <span>{v.meter.value}</span>
              </div>
              <div className="meter">
                <div className="meter-fill" style={{ width: `${Math.min(100, v.meter.fill * 100)}%` }} />
              </div>
            </div>
            <Sparkline values={st?.history ?? []} max={data.kind === 'queue' ? undefined : 1.2} color={color} width={196} height={26} />
          </>
        )}

        {v.tags.length > 0 && (
          <div className="node-tags">
            {v.tags.map((t) => (
              <span key={t.text} className={`node-tag ${t.tone ?? ''}`}>
                {t.text}
              </span>
            ))}
          </div>
        )}

        {spec.scalable && (
          <div className="instances">
            <div className="meter-label">
              <span>INSTANCES</span>
              <span>
                {v.instancesUp}/{v.instances} up{v.booting > 0 && ` · +${v.booting} booting`}
              </span>
            </div>
            <div className="instance-grid">
              {Array.from({ length: v.instances }, (_, i) => {
                const reachable = running ? (st?.reachable ?? v.instancesUp) : v.instancesUp;
                const state = i >= v.instancesUp ? 'dead' : i >= reachable ? 'idle' : healthOf(util, st?.dropRps ?? 0, st?.inRps ?? 0, true);
                return (
                  <div key={i} className={`inst inst-${state}`} title={state === 'idle' ? 'Unreachable — no load balancer' : undefined}>
                    <div className="inst-fill" style={{ height: state === 'dead' || state === 'idle' ? 0 : `${Math.min(100, util * 100)}%` }} />
                    <span className="inst-n">{state === 'dead' ? '✕' : i + 1}</span>
                  </div>
                );
              })}
              {Array.from({ length: v.booting }, (_, i) => (
                <div key={`b${i}`} className="inst inst-boot" title="Booting — billed, not serving yet">
                  <span className="inst-n">…</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {v.noOrigin && (
          <div className="node-warn">
            <AlertTriangle size={12} /> No origin connected — every miss fails
          </div>
        )}
        {v.unreachable && (
          <div className="node-warn">
            <AlertTriangle size={12} /> No load balancer — only 1 instance reachable
          </div>
        )}
        {v.promotedReplica && (
          <div className="node-note">
            <RefreshCw size={12} /> Promoted → now the PRIMARY
          </div>
        )}
        {v.electing && (
          <div className="node-down electing">
            <RefreshCw size={20} className="spin" /> ELECTING…
          </div>
        )}
        {!v.up && (
          <div className={`node-down ${v.failedOver ? 'failed-over' : ''}`}>
            {v.failedOver ? (
              <>
                <RefreshCw size={18} /> FAILED OVER
              </>
            ) : (
              <>
                <Skull size={22} /> DOWN
              </>
            )}
          </div>
        )}
        <Handle type="source" position={Position.Right} className="handle" />
      </div>
    </>
  );
}

export const SystemNode = memo(SystemNodeImpl);
