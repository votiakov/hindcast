import { NodeToolbar, Position } from '@xyflow/react';
import { HeartPulse, Minus, Plus, Skull, Trash2 } from 'lucide-react';
import { KINDS, RUNTIME_KINDS, RUNTIMES, TIERS, cacheHitRate, hotShardShare, isUp, type RetryPolicy, type RouteMode, type Runtime, type SystemNodeData, type Tier } from '../sim/catalog';
import { useSim } from '../sim/store';
import { useBoardId } from './BoardContext';
import { fmt } from './nodeModel';
import { Calibrate } from './Calibrate';
import { useState } from 'react';

/** nodes that make outgoing calls and can therefore retry / break */
const CALLERS = new Set(['client', 'server', 'worker', 'function', 'gateway', 'lb']);

/** Station control panel shown above a selected node (both themes). */
export function NodeControls({ id, data, selected }: { id: string; data: SystemNodeData; selected: boolean }) {
  const b = useBoardId();
  const { updateNode, killNode, reviveNode, removeNode, apply } = useSim.getState();
  const spec = KINDS[data.kind];
  const instances = data.instances ?? 1;
  const set = (patch: Partial<SystemNodeData>) => updateNode(b, id, patch);
  const caller = CALLERS.has(data.kind);
  const routeModes: RouteMode[] = ['split', 'failover', 'fanout'];
  const [cal, setCal] = useState(false);
  const calibratable = data.kind !== 'client' && data.kind !== 'gateway' && data.kind !== 'llmapi' && data.kind !== 'external' && data.kind !== 'function' && data.kind !== 'queue';

  return (
    <NodeToolbar isVisible={selected} position={Position.Top} className="node-toolbar">
      <div className="tb-row">
        {spec.tiered && (
          <div className="tb-group">
            {(Object.keys(TIERS) as Tier[]).map((t) => (
              <button key={t} className={`tb-chip ${data.tier === t ? 'on' : ''}`} onClick={() => set({ tier: t })} title={`${TIERS[t].label}: ×${TIERS[t].capacity} capacity, ×${TIERS[t].cost} cost`}>
                {t}
              </button>
            ))}
          </div>
        )}
        {spec.scalable && (
          <div className="tb-group">
            <button className="tb-btn" onClick={() => set({ instances: Math.max(1, instances - 1), down: Math.min(data.down ?? 0, Math.max(0, instances - 2)) })} title="Remove instance">
              <Minus size={14} />
            </button>
            <span className="tb-count">×{instances}</span>
            <button className="tb-btn" onClick={() => set({ instances: Math.min(24, instances + 1) })} title="Add instance">
              <Plus size={14} />
            </button>
          </div>
        )}
        {spec.scalable && (
          <div className="tb-group" title="Target-tracking autoscaling: adds instances when utilisation passes the target, after a warm-up">
            <button
              className={`tb-chip wide ${data.autoscale ? 'on' : ''}`}
              onClick={() => set({ autoscale: data.autoscale ? undefined : { min: instances, max: Math.min(24, Math.max(instances * 4, 4)), targetUtil: 0.6, warmupS: 30, cooldownS: 60 } })}
            >
              autoscale
            </button>
            {data.autoscale && (
              <>
                <span className="tb-label">max</span>
                <select className="tb-select" value={data.autoscale.max} onChange={(e) => set({ autoscale: { ...data.autoscale!, max: Math.max(+e.target.value, data.autoscale!.min) } })}>
                  {[2, 4, 6, 8, 12, 16, 24].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                <span className="tb-label">warm-up</span>
                <select className="tb-select" value={data.autoscale.warmupS ?? 30} onChange={(e) => set({ autoscale: { ...data.autoscale!, warmupS: +e.target.value } })} title="Launch → serving. k8s pod 5–20 s · Fargate 30–60 s · EC2 ASG 90–180 s">
                  {[5, 15, 30, 60, 120, 180].map((n) => (
                    <option key={n} value={n}>
                      {n}s
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
        )}
        {RUNTIME_KINDS.includes(data.kind) && (
          <div className="tb-group" title="Language runtime — changes throughput per instance, latency, cold starts and serverless cost">
            <span className="tb-label">runtime</span>
            <select className="tb-select" value={data.runtime ?? ''} onChange={(e) => set({ runtime: (e.target.value || undefined) as Runtime | undefined })}>
              <option value="">generic</option>
              {(Object.keys(RUNTIMES) as Runtime[]).map((r) => (
                <option key={r} value={r}>
                  {RUNTIMES[r].label}
                </option>
              ))}
            </select>
          </div>
        )}
        {data.kind === 'llm' && (
          <div className="tb-group">
            <button className={`tb-chip wide ${data.batching ? 'on' : ''}`} onClick={() => set({ batching: !data.batching })} title="Continuous batching: ~4× throughput per GPU, +400ms latency">
              batching
            </button>
          </div>
        )}
        {data.kind === 'db' && (
          <div className="tb-group">
            <span className="tb-label" title="Horizontal partitions: each shard is a full database holding part of the keys — capacity and cost × shards. A hot key still lands on one shard.">shards</span>
            <input className="tb-num" type="number" min={1} max={256} step={1} value={data.shards ?? 1} onChange={(e) => set({ shards: Math.round(+e.target.value) > 1 ? Math.min(256, Math.round(+e.target.value)) : undefined })} />
            {data.hotKeyShare ? <span className="tb-count" title="Share of traffic on the busiest shard: the hot key plus its even share of the rest">hot shard {Math.round(hotShardShare(data) * 100)}%</span> : null}
          </div>
        )}
        {(data.kind === 'cache' || data.kind === 'cdn') && (
          <div className="tb-group">
            <span className="tb-label">hit</span>
            {data.kind === 'cache' && data.workingSetGb ? (
              <span className="tb-count" title="From the cache's memory and the data it fronts">{Math.round(cacheHitRate(data) * 100)}%</span>
            ) : (
              <>
                <input type="range" min={0} max={0.99} step={0.01} value={data.hitRate ?? 0.85} onChange={(e) => set({ hitRate: +e.target.value })} />
                <span className="tb-count">{Math.round((data.hitRate ?? 0.85) * 100)}%</span>
              </>
            )}
            {data.kind === 'cache' && (
              <>
                <span className="tb-label" title="The data this cache fronts: with it, the hit rate follows from the cache's size (S 6.4, M 13, L 26 GB) and how skewed the reads are">data GB</span>
                <input className="tb-num" type="number" min={0} step={1} value={data.workingSetGb ?? ''} placeholder="—" onChange={(e) => set({ workingSetGb: +e.target.value > 0 ? +e.target.value : undefined })} />
                {data.workingSetGb ? (
                  <>
                    <span className="tb-label" title="Zipf exponent: 1 is typical of web traffic, higher means a few keys get most reads">skew</span>
                    <input className="tb-num" type="number" min={0.1} max={3} step={0.1} value={data.skew ?? 1} onChange={(e) => set({ skew: +e.target.value || undefined })} />
                  </>
                ) : null}
              </>
            )}
            <span className="tb-label">writes</span>
            <select className="tb-select" value={data.writePolicy ?? 'through'} onChange={(e) => set({ writePolicy: e.target.value as 'through' | 'behind' })} title="through: writes go on to the origin. behind: acknowledged at the cache and flushed ~5 s later — lost if the cache dies first">
              <option value="through">through</option>
              <option value="behind">behind</option>
            </select>
          </div>
        )}
        {(data.kind === 'gateway' || data.kind === 'function' || data.kind === 'llmapi' || data.kind === 'external') && (
          <div className="tb-group">
            <span className="tb-label">{data.kind === 'function' ? 'max conc.' : 'rate limit'}</span>
            <input type="range" min={data.kind === 'llmapi' ? 10 : 100} max={data.kind === 'llmapi' ? 1000 : 10000} step={data.kind === 'llmapi' ? 10 : 100} value={data.limit ?? 1000} onChange={(e) => set({ limit: +e.target.value })} />
            <span className="tb-count wide">{fmt(data.limit ?? 1000)}/s</span>
          </div>
        )}
        <div className="tb-group">
          {isUp(data) && data.kind !== 'client' ? (
            <button className="tb-btn danger" onClick={() => killNode(b, id)} title="Kill (chaos)">
              <Skull size={14} />
            </button>
          ) : !isUp(data) ? (
            <button className="tb-btn good" onClick={() => reviveNode(b, id)} title="Revive">
              <HeartPulse size={14} />
            </button>
          ) : null}
          {data.kind !== 'client' && isUp(data) && (
            <select
              className="tb-select"
              value=""
              title="Inject a gray failure — the node stays up but misbehaves"
              onChange={(e) => {
                const v = e.target.value;
                if (v === 'restore') apply(b, { type: 'restore', id });
                else if (v === 'flush') apply(b, { type: 'flush-cache', id });
                else if (v.startsWith('hot')) apply(b, { type: 'hot-key', id, share: +v.slice(3) });
                else if (v.startsWith('err')) apply(b, { type: 'inject-errors', id, rate: +v.slice(3) });
                else if (v.startsWith('lat')) apply(b, { type: 'inject-latency', id, ms: +v.slice(3) });
                else if (v.startsWith('deg')) apply(b, { type: 'degrade', id, factor: +v.slice(3) });
              }}
            >
              <option value="" disabled>
                fault…
              </option>
              <option value="err0.1">10% errors</option>
              <option value="err0.5">50% errors</option>
              <option value="lat100">+100 ms</option>
              <option value="lat500">+500 ms</option>
              <option value="lat2000">+2 s</option>
              <option value="deg0.5">50% capacity</option>
              {(data.kind === 'cache' || data.kind === 'cdn') && <option value="flush">flush cache</option>}
              {data.kind === 'db' && <option value={data.hotKeyShare ? 'hot0' : 'hot0.3'}>{data.hotKeyShare ? 'cool the hot key' : 'hot key (30% on one key)'}</option>}
              {(data.faultRate || data.faultLatencyMs || data.degraded !== undefined) && <option value="restore">restore</option>}
            </select>
          )}
          {calibratable && (
            <button className={`tb-chip wide ${cal || data.capacity !== undefined || data.latencyMs !== undefined ? 'on' : ''}`} onClick={() => setCal(!cal)} title="Calibrate from production numbers: req/s at CPU %, p50, $/h">
              calibrate
            </button>
          )}
          <button className="tb-btn" onClick={() => removeNode(b, id)} title="Delete">
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {cal && calibratable && (
        <div className="tb-row">
          <div className="tb-group">
            <Calibrate d={data} apply={(p) => (set(p), setCal(false))} />
          </div>
        </div>
      )}
      {caller && (
        <div className="tb-row">
          <div className="tb-group" title="Retries per failed call and how they are scheduled">
            <span className="tb-label">retries</span>
            <select className="tb-select" value={data.retries ?? 0} onChange={(e) => set({ retries: +e.target.value })}>
              {[0, 1, 2, 3, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            {(data.retries ?? 0) > 0 && (
              <select className="tb-select" value={data.retryPolicy ?? 'immediate'} onChange={(e) => set({ retryPolicy: e.target.value as RetryPolicy })}>
                <option value="immediate">immediate</option>
                <option value="backoff">backoff + jitter</option>
                <option value="budget">retry budget 10%</option>
              </select>
            )}
          </div>
          {data.kind === 'client' && (
            <div className="tb-group" title="Clients give up on responses slower than this">
              <span className="tb-label">timeout</span>
              <select className="tb-select" value={data.timeoutMs ?? 0} onChange={(e) => set({ timeoutMs: +e.target.value || undefined })}>
                <option value={0}>none</option>
                {[300, 500, 1000, 2000, 5000].map((ms) => (
                  <option key={ms} value={ms}>
                    {ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="tb-group" title="Circuit breaker: stop calling a failing dependency for a while">
            <button className={`tb-chip wide ${data.breaker ? 'on' : ''}`} onClick={() => set({ breaker: !data.breaker })}>
              breaker
            </button>
            {data.breaker && (
              <button className={`tb-chip wide ${data.fallback ? 'on' : ''}`} onClick={() => set({ fallback: !data.fallback })} title="Serve a degraded response while the breaker is open">
                fallback
              </button>
            )}
          </div>
          {data.kind !== 'client' && (
            <div className="tb-group" title="How calls spread over downstream nodes">
              <span className="tb-label">routing</span>
              <select className="tb-select" value={data.routing ?? 'split'} onChange={(e) => set({ routing: e.target.value as RouteMode })}>
                {routeModes.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          )}
          {(data.kind === 'server' || data.kind === 'worker' || data.kind === 'function') && (
            <div className="tb-group" title="Scatter-gather: each call goes to N partitions in parallel and waits for the slowest">
              <span className="tb-label">fan-out</span>
              <select className="tb-select" value={data.fanout ?? 1} onChange={(e) => set({ fanout: +e.target.value > 1 ? +e.target.value : undefined })}>
                {[1, 5, 10, 20, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    ×{n}
                  </option>
                ))}
              </select>
            </div>
          )}
          {data.kind !== 'client' && data.kind !== 'gateway' && data.kind !== 'llmapi' && data.kind !== 'external' && data.kind !== 'function' && data.kind !== 'queue' && (
            <div className="tb-group" title="Bounded queue: seconds of work this node will hold before shedding">
              <span className="tb-label">queue</span>
              <select className="tb-select" value={data.queueS ?? ''} onChange={(e) => set({ queueS: e.target.value === '' ? undefined : +e.target.value })}>
                <option value="">default</option>
                {[0.1, 0.25, 0.5, 1, 3, 10].map((q) => (
                  <option key={q} value={q}>
                    {q}s
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}
    </NodeToolbar>
  );
}
