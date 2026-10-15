import { useEffect, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { HeartPulse, Minus, Plus, Skull, Trash2 } from 'lucide-react';
import { KINDS, RUNTIME_KINDS, RUNTIMES, TIERS, cacheHitRate, hotShardShare, isUp, provisionedCostH, type RetryPolicy, type RouteMode, type Runtime, type SystemNodeData, type Tier } from '../sim/catalog';
import { useSim } from '../sim/store';
import { useBoardId } from './BoardContext';
import { fmt } from './nodeModel';
import { Calibrate } from './Calibrate';

/** nodes that make outgoing calls and can therefore retry / break */
const CALLERS = new Set(['client', 'server', 'worker', 'function', 'gateway', 'lb']);

/**
 * The controls of a selected component, inside its card: the
 * card opens up instead of a toolbar floating over the board. The rows people change most are
 * always there — size, scaling, what is specific to the kind, chaos; resilience (retries,
 * timeouts, breakers, routing, fan-out, queue) opens under its own heading, and opens by itself
 * when any of it is set.
 */
export function CardControls({ id, data }: { id: string; data: SystemNodeData }) {
  const b = useBoardId();
  const { updateNode, killNode, reviveNode, removeNode, apply } = useSim.getState();
  const spec = KINDS[data.kind];
  const instances = data.instances ?? 1;
  const set = (patch: Partial<SystemNodeData>) => updateNode(b, id, patch);
  const caller = CALLERS.has(data.kind);
  const bounded = data.kind !== 'client' && data.kind !== 'gateway' && data.kind !== 'llmapi' && data.kind !== 'external' && data.kind !== 'kv' && data.kind !== 'archive' && data.kind !== 'function' && data.kind !== 'queue' && data.kind !== 'stream';
  const calibratable = data.kind !== 'client' && data.kind !== 'gateway' && data.kind !== 'llmapi' && data.kind !== 'external' && data.kind !== 'kv' && data.kind !== 'archive' && data.kind !== 'function' && data.kind !== 'queue' && data.kind !== 'stream';
  const tuned = (data.retries ?? 0) > 0 || !!data.breaker || !!data.timeoutMs || (data.routing && data.routing !== 'split') || (data.fanout ?? 1) > 1 || data.queueS !== undefined;
  const [more, setMore] = useState(tuned);
  const [cal, setCal] = useState(false);
  const hasResilience = caller || data.kind !== 'client';
  // routing only means something with more than one component to route to
  const outgoing = useSim((s) => s.boards[b].edges.filter((e) => e.source === id).length);
  const as = data.autoscale;
  const pick = (v: number, list: number[]) => [...new Set([...list, v])].sort((x, y) => x - y);

  // an opened card can grow under the play bar: pan the board up just enough to show all of it
  const box = useRef<HTMLDivElement>(null);
  const { getViewport, setViewport } = useReactFlow();
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const t = setTimeout(() => {
      const r = el.getBoundingClientRect();
      const bar = document.querySelector('.controlbar')?.getBoundingClientRect();
      const limit = (bar?.top ?? window.innerHeight) - 12;
      if (r.bottom > limit) {
        const vp = getViewport();
        setViewport({ ...vp, y: vp.y - Math.min(r.bottom - limit, Math.max(0, r.top - 70)) }, { duration: 250 });
      }
    }, 30);
    return () => clearTimeout(t);
  }, [more, cal, getViewport, setViewport]);

  return (
    // nodrag / nopan / nowheel: inputs inside a card must not move the board
    <div ref={box} className="nc nodrag nopan nowheel" onClick={(e) => e.stopPropagation()}>
      {(spec.tiered || spec.scalable) && (
        <div className="nc-row">
          {spec.scalable && (
            <>
              <span className="nc-l">instances</span>
              <span className="nc-step">
                <button onClick={() => set({ instances: Math.max(1, instances - 1), down: Math.min(data.down ?? 0, Math.max(0, instances - 2)) })} title="Remove an instance">
                  <Minus size={12} />
                </button>
                <b>{instances}</b>
                <button onClick={() => set({ instances: Math.min(500, instances + 1) })} title="Add an instance">
                  <Plus size={12} />
                </button>
              </span>
            </>
          )}
          {spec.tiered && (
            <>
              <span className="nc-l">size</span>
              <span className="nc-seg">
                {(Object.keys(TIERS) as Tier[]).map((t) => (
                  <button key={t} className={data.tier === t ? 'on' : ''} onClick={() => set({ tier: t })} title={`${TIERS[t].label}: ×${TIERS[t].capacity} capacity, ×${TIERS[t].cost} cost`}>
                    {t}
                  </button>
                ))}
              </span>
            </>
          )}
        </div>
      )}

      {spec.scalable && (
        <div className="nc-row" title="Target-tracking autoscaling: adds instances when utilisation passes the target, after a warm-up">
          <span className="nc-l">autoscale</span>
          <button className={`nc-toggle ${as ? 'on' : ''}`} onClick={() => set({ autoscale: as ? undefined : { min: instances, max: Math.min(500, Math.max(instances * 4, 4)), targetUtil: 0.6, warmupS: 30, cooldownS: 60 } })}>
            {as ? 'on' : 'off'}
          </button>
          {as && (
            <>
              <span className="nc-l">min</span>
              <select value={as.min} onChange={(e) => set({ autoscale: { ...as, min: Math.min(+e.target.value, as.max) } })} title="Never fewer than this">
                {pick(as.min, [1, 2, 3, 4, 5, 8, 12, 16]).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <span className="nc-l">max</span>
              <select value={as.max} onChange={(e) => set({ autoscale: { ...as, max: Math.max(+e.target.value, as.min) } })} title="Never more than this">
                {pick(as.max, [2, 4, 6, 8, 12, 16, 24, 32, 48, 64, 100]).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
      )}
      {spec.scalable && as && (
        <div className="nc-row" title="The utilisation it scales to; how long a new instance takes to serve; how long it waits before scaling in">
          <span className="nc-l">target</span>
          <select value={as.targetUtil ?? 0.6} onChange={(e) => set({ autoscale: { ...as, targetUtil: +e.target.value } })}>
            {pick(as.targetUtil ?? 0.6, [0.4, 0.5, 0.6, 0.7, 0.8]).map((n) => (
              <option key={n} value={n}>
                {Math.round(n * 100)}%
              </option>
            ))}
          </select>
          <span className="nc-l">warm-up</span>
          <select value={as.warmupS ?? 30} onChange={(e) => set({ autoscale: { ...as, warmupS: +e.target.value } })} title="Launch → serving. k8s pod 5–20 s · Fargate 30–60 s · EC2 ASG 90–180 s">
            {pick(as.warmupS ?? 30, [5, 10, 15, 30, 60, 120, 180]).map((n) => (
              <option key={n} value={n}>
                {n}s
              </option>
            ))}
          </select>
          <span className="nc-l">cooldown</span>
          <select value={as.cooldownS ?? 60} onChange={(e) => set({ autoscale: { ...as, cooldownS: +e.target.value } })} title="Wait after scaling before giving instances back">
            {pick(as.cooldownS ?? 60, [10, 30, 60, 120, 300]).map((n) => (
              <option key={n} value={n}>
                {n}s
              </option>
            ))}
          </select>
        </div>
      )}

      {RUNTIME_KINDS.includes(data.kind) && (
        <div className="nc-row" title="Language runtime — changes throughput per instance, latency, cold starts and serverless cost">
          <span className="nc-l">runtime</span>
          <select value={data.runtime ?? ''} onChange={(e) => set({ runtime: (e.target.value || undefined) as Runtime | undefined })}>
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
        <div className="nc-row" title="Continuous batching: ~4× throughput per GPU, +400ms latency">
          <span className="nc-l">batching</span>
          <button className={`nc-toggle ${data.batching ? 'on' : ''}`} onClick={() => set({ batching: !data.batching })}>
            {data.batching ? 'on' : 'off'}
          </button>
        </div>
      )}
      {(data.kind === 'cache' || data.kind === 'cdn') && (
        <div className="nc-row">
          <span className="nc-l">hit rate</span>
          {data.kind === 'cache' && data.workingSetGb ? (
            <b className="nc-v" title="From the cache's memory and the data it fronts">{Math.round(cacheHitRate(data) * 100)}% (sized)</b>
          ) : (
            <>
              <input type="range" min={0} max={0.99} step={0.01} value={data.hitRate ?? 0.85} onChange={(e) => set({ hitRate: +e.target.value })} />
              <b className="nc-v">{Math.round((data.hitRate ?? 0.85) * 100)}%</b>
            </>
          )}
        </div>
      )}
      {data.kind === 'queue' && (
        <div className="nc-row" title="Redrive (SQS maxReceiveCount): a message a consumer fails comes back after the visibility timeout, until it has been received this many times — then it goes to the dead-letter queue. Off: a failed message is gone">
          <span className="nc-l">redrive</span>
          <select value={data.maxReceives ?? 0} onChange={(e) => set({ maxReceives: +e.target.value || undefined })}>
            <option value={0}>off</option>
            {[2, 3, 5, 10].map((n) => (
              <option key={n} value={n}>
                {n} receives
              </option>
            ))}
          </select>
          {data.maxReceives ? (
            <>
              <span className="nc-l">visible after</span>
              <select value={data.visibilityS ?? 30} onChange={(e) => set({ visibilityS: +e.target.value })}>
                {[5, 30, 120, 900].map((n) => (
                  <option key={n} value={n}>
                    {n >= 60 ? `${n / 60} min` : `${n}s`}
                  </option>
                ))}
              </select>
            </>
          ) : null}
        </div>
      )}
      {data.kind === 'client' && (
        <div className="nc-row" title="Users share the traffic slider; a scheduled job (a cron, a nightly export) sends its own batch every so often, and its requests don't count as the users'">
          <span className="nc-l">sends</span>
          <select value={data.everyS ?? 0} onChange={(e) => set({ everyS: +e.target.value || undefined, ...(+e.target.value && !data.batch ? { batch: 5000 } : {}) })}>
            <option value={0}>user traffic</option>
            {[60, 300, 3600].map((n) => (
              <option key={n} value={n}>
                a job every {n >= 3600 ? `${n / 3600} h` : `${n / 60} min`}
              </option>
            ))}
          </select>
          {data.everyS ? (
            <>
              <input className="nc-num" type="number" min={0} step={500} value={data.batch ?? 0} onChange={(e) => set({ batch: Math.max(0, +e.target.value || 0) })} />
              <span className="nc-l">requests in {data.batchS ?? 10}s</span>
            </>
          ) : null}
        </div>
      )}
      {data.kind === 'storage' && (
        <div className="nc-row" title="Key prefixes: S3 takes 5,500 reads or 3,500 writes a second per prefix, however big the bucket — spread hot keys over more prefixes">
          <span className="nc-l">prefixes</span>
          <input className="nc-num" type="number" min={1} max={100000} step={1} value={data.prefixes ?? 10} onChange={(e) => set({ prefixes: Math.max(1, Math.min(100000, Math.round(+e.target.value) || 1)) })} />
        </div>
      )}
      {data.kind === 'stream' && (
        <div className="nc-row" title="Partitions: 1,000 messages/s in each, $0.015/h each — and a subscriber cannot use more consumer instances than there are partitions">
          <span className="nc-l">partitions</span>
          <input className="nc-num" type="number" min={1} max={1024} step={1} value={data.partitions ?? 4} onChange={(e) => set({ partitions: Math.max(1, Math.min(1024, Math.round(+e.target.value) || 1)) })} />
        </div>
      )}
      {data.kind === 'search' && (
        <div className="nc-row" title="Refresh interval: a written document is searchable only after the next refresh. Longer intervals index faster (fewer, bigger segments), but searches miss recent writes for longer">
          <span className="nc-l">refresh</span>
          <select value={data.refreshS ?? 1} onChange={(e) => set({ refreshS: +e.target.value })}>
            {pick(data.refreshS ?? 1, [1, 5, 30, 60]).map((n) => (
              <option key={n} value={n}>
                {n >= 60 ? `${n / 60} min` : `${n}s`}
              </option>
            ))}
          </select>
        </div>
      )}
      {data.kind === 'vector' && (
        <div className="nc-row" title="Recall: the share of the true nearest neighbours a search finds. Each halving of what it may miss doubles the graph it walks. Vectors: the index size — 3.5 GB of graph per million 768-dimension vectors; what does not fit in the nodes' memory is read from disk">
          <span className="nc-l">recall</span>
          <select value={data.recall ?? 0.95} onChange={(e) => set({ recall: +e.target.value })}>
            {pick(data.recall ?? 0.95, [0.9, 0.95, 0.98, 0.99, 0.999]).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span className="nc-l">vectors (M)</span>
          <input className="nc-num" type="number" min={0.1} max={100000} step={0.5} value={data.vectorsM ?? 1} onChange={(e) => set({ vectorsM: Math.max(0.1, Math.min(100000, +e.target.value || 1)) })} />
        </div>
      )}
      {data.kind === 'edge' && (
        <div className="nc-row" title="Answered at the edge: the share of requests the function handles itself (redirects, auth checks, A/B, personalisation); the rest go on to the origin. CPU: time per request, and the platform's limit — CloudFront Functions about 1 ms, Workers Free 10 ms, Workers paid 30 s">
          <span className="nc-l">at edge</span>
          <input type="range" min={0} max={1} step={0.05} value={data.edgeShare ?? 0.5} onChange={(e) => set({ edgeShare: +e.target.value })} />
          <b className="nc-v">{Math.round((data.edgeShare ?? 0.5) * 100)}%</b>
          <span className="nc-l">CPU ms</span>
          <input className="nc-num" type="number" min={0} max={300000} step={0.5} value={data.cpuMs ?? 1} onChange={(e) => set({ cpuMs: Math.max(0, +e.target.value || 0) })} />
          <span className="nc-l">limit</span>
          <select value={data.cpuLimitMs ?? 10} onChange={(e) => set({ cpuLimitMs: +e.target.value })}>
            {pick(data.cpuLimitMs ?? 10, [1, 5, 10, 50, 30000]).map((n) => (
              <option key={n} value={n}>
                {n >= 1000 ? `${n / 1000} s` : `${n} ms`}
              </option>
            ))}
          </select>
        </div>
      )}
      {data.kind === 'archive' && (
        <div className="nc-row" title="Retrieval: Instant Retrieval reads in milliseconds ($0.01 per 1,000 + $0.03/GB); a Flexible Retrieval restore takes 1–5 min (expedited, $10 per 1,000) or 3–5 h (standard). Data: what it holds, at $0.004 (instant) or $0.0036 per GB-month">
          <span className="nc-l">retrieval</span>
          <select value={data.retrieval ?? 'instant'} onChange={(e) => set({ retrieval: e.target.value as SystemNodeData['retrieval'] })}>
            <option value="instant">instant (ms)</option>
            <option value="expedited">expedited (1–5 min)</option>
            <option value="standard">standard (3–5 h)</option>
          </select>
          <span className="nc-l">data (GB)</span>
          <input className="nc-num" type="number" min={1} step={100} value={data.workingSetGb ?? 1000} onChange={(e) => set({ workingSetGb: Math.max(1, +e.target.value || 1000) })} />
        </div>
      )}
      {data.kind === 'dns' && (
        <div className="nc-row" title="Clients cache an answer for the TTL; health checks notice a dead target after a few failed checks. Until both pass, users keep going to the dead one.">
          <span className="nc-l">TTL</span>
          <select value={data.ttlS ?? 60} onChange={(e) => set({ ttlS: +e.target.value })}>
            {pick(data.ttlS ?? 60, [5, 30, 60, 300, 3600]).map((n) => (
              <option key={n} value={n}>
                {n >= 60 ? `${n / 60} min` : `${n}s`}
              </option>
            ))}
          </select>
          <span className="nc-l">health check</span>
          <select value={data.healthCheckS ?? 30} onChange={(e) => set({ healthCheckS: +e.target.value })}>
            {pick(data.healthCheckS ?? 30, [10, 30, 90]).map((n) => (
              <option key={n} value={n}>
                {n}s
              </option>
            ))}
          </select>
        </div>
      )}
      {(data.kind === 'db' || data.kind === 'replica') && (
        <div className="nc-row">
          <span className="nc-l" title="Horizontal partitions: each shard is a full database holding part of the keys — capacity and cost × shards. A hot key still lands on one shard.">shards</span>
          <input className="nc-num" type="number" min={1} max={256} step={1} value={data.shards ?? 1} onChange={(e) => set({ shards: Math.round(+e.target.value) > 1 ? Math.min(256, Math.round(+e.target.value)) : undefined })} />
          {data.hotKeyShare ? <b className="nc-v" title="Share of traffic on the busiest shard: the hot key plus its even share of the rest">hot shard {Math.round(hotShardShare(data) * 100)}%</b> : null}
        </div>
      )}
      {data.kind === 'db' && (
        <div className="nc-row" title="How long writes fail after the primary dies, until a replica is promoted (reads go on to replicas meanwhile). RDS Multi-AZ: 60–120 s; Multi-AZ DB cluster: about 35 s; Aurora: under 30 s; Cloud SQL HA: about 60 s. Without automatic failover, the time someone takes to promote one by hand.">
          <span className="nc-l">failover</span>
          <select value={data.failoverS ?? 60} onChange={(e) => set({ failoverS: +e.target.value === 60 ? undefined : +e.target.value })}>
            {pick(data.failoverS ?? 60, [30, 60, 120, 1800]).map((n) => (
              <option key={n} value={n}>
                {n >= 600 ? `${n / 60} min (by hand)` : `${n}s`}
              </option>
            ))}
          </select>
        </div>
      )}
      {data.kind === 'cache' && (
        <div className="nc-row">
          <span className="nc-l" title="The data this cache fronts: with it, the hit rate follows from the cache's size (S 6.4, M 13, L 26 GB) and how skewed the reads are">data GB</span>
          <input className="nc-num" type="number" min={0} step={1} value={data.workingSetGb ?? ''} placeholder="—" onChange={(e) => set({ workingSetGb: +e.target.value > 0 ? +e.target.value : undefined })} />
          {data.workingSetGb ? (
            <>
              <span className="nc-l" title="Zipf exponent: 1 is typical of web traffic, higher means a few keys get most reads">skew</span>
              <input className="nc-num" type="number" min={0.1} max={3} step={0.1} value={data.skew ?? 1} onChange={(e) => set({ skew: +e.target.value || undefined })} />
            </>
          ) : null}
        </div>
      )}
      {(data.kind === 'cache' || data.kind === 'cdn') && (
        <div className="nc-row">
          <span className="nc-l" title="After a restart or flush the cache is empty: the hit rate comes back over this time constant">re-warm</span>
          <select value={data.warmupS ?? 20} onChange={(e) => set({ warmupS: +e.target.value })}>
            {pick(data.warmupS ?? 20, [5, 10, 20, 60, 300]).map((n) => (
              <option key={n} value={n}>
                {n}s
              </option>
            ))}
          </select>
          <span className="nc-l">writes</span>
          <select value={data.writePolicy ?? 'through'} onChange={(e) => set({ writePolicy: e.target.value as 'through' | 'behind' })} title="through: writes go on to the origin. behind: acknowledged at the cache and flushed ~5 s later — lost if the cache dies first">
            <option value="through">through</option>
            <option value="behind">behind</option>
          </select>
        </div>
      )}
      {(data.kind === 'gateway' || data.kind === 'function' || data.kind === 'llmapi' || data.kind === 'external' || data.kind === 'kv') && (
        <div className="nc-row">
          <span className="nc-l">{data.kind === 'function' ? 'max conc.' : 'rate limit'}</span>
          <input type="range" min={data.kind === 'llmapi' ? 10 : data.kind === 'kv' ? 1000 : 100} max={data.kind === 'llmapi' ? 1000 : data.kind === 'kv' ? 100000 : 10000} step={data.kind === 'llmapi' ? 10 : data.kind === 'kv' ? 1000 : 100} value={data.limit ?? 1000} onChange={(e) => set({ limit: +e.target.value })} />
          <b className="nc-v">{fmt(data.limit ?? 1000)}/s</b>
        </div>
      )}
      {(data.kind === 'lb' || data.kind === 'gateway') && (
        <div className="nc-row" title="Connections: each request holds one for its duration (a websocket session, a streamed answer, a long poll). Past the limit new ones are refused — Erlang B">
          <span className="nc-l">connections</span>
          <select value={data.maxConnections ?? 0} onChange={(e) => set({ maxConnections: +e.target.value || undefined })}>
            <option value={0}>unlimited</option>
            {[1000, 5000, 10000, 50000, 100000].map((n) => (
              <option key={n} value={n}>
                {fmt(n)}
              </option>
            ))}
          </select>
          {data.maxConnections ? (
            <>
              <span className="nc-l">held</span>
              <select value={data.connectionS ?? 30} onChange={(e) => set({ connectionS: +e.target.value })}>
                {[1, 10, 30, 120, 600].map((n) => (
                  <option key={n} value={n}>
                    {n >= 60 ? `${n / 60} min` : `${n}s`}
                  </option>
                ))}
              </select>
            </>
          ) : null}
        </div>
      )}
      {data.kind === 'gateway' && (
        <div className="nc-row" title="Burst: the token bucket's size — a burst above the rate passes until it is empty (API Gateway: rate 10,000/s, burst 5,000)">
          <span className="nc-l">burst</span>
          <select value={data.burst ?? 0} onChange={(e) => set({ burst: +e.target.value || undefined })}>
            <option value={0}>1 s of the limit</option>
            {[500, 1000, 2000, 5000, 10000].map((n) => (
              <option key={n} value={n}>
                {fmt(n)} requests
              </option>
            ))}
          </select>
        </div>
      )}
      {data.kind === 'function' && (
        <div className="nc-row" title="Provisioned concurrency: executions kept warm — no cold start up to it — billed by the hour whether used or not">
          <span className="nc-l">provisioned</span>
          <select value={data.provisioned ?? 0} onChange={(e) => set({ provisioned: +e.target.value || undefined })}>
            <option value={0}>none</option>
            {[5, 10, 25, 50, 100, 250].map((n) => (
              <option key={n} value={n}>
                {n} warm
              </option>
            ))}
          </select>
          {data.provisioned ? <b className="nc-v">+${(provisionedCostH(data) * 730).toFixed(0)}/mo</b> : null}
        </div>
      )}

      {hasResilience && (
        <button className={`nc-more ${more ? 'open' : ''}`} onClick={() => setMore(!more)}>
          resilience {more ? '▴' : '▾'}
        </button>
      )}
      {more && (
        <>
          {caller && (
            <div className="nc-row" title="Retries per failed call and how they are scheduled">
              <span className="nc-l">retries</span>
              <select value={data.retries ?? 0} onChange={(e) => set({ retries: +e.target.value })}>
                {[0, 1, 2, 3, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              {(data.retries ?? 0) > 0 && (
                <select value={data.retryPolicy ?? 'immediate'} onChange={(e) => set({ retryPolicy: e.target.value as RetryPolicy })}>
                  <option value="immediate">immediate</option>
                  <option value="backoff">backoff + jitter</option>
                  <option value="budget">budget 10%</option>
                </select>
              )}
            </div>
          )}
          {data.kind === 'client' && (
            <div className="nc-row" title="Clients give up on responses slower than this">
              <span className="nc-l">timeout</span>
              <select value={data.timeoutMs ?? 0} onChange={(e) => set({ timeoutMs: +e.target.value || undefined })}>
                <option value={0}>none</option>
                {[300, 500, 1000, 2000, 5000].map((ms) => (
                  <option key={ms} value={ms}>
                    {ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`}
                  </option>
                ))}
              </select>
            </div>
          )}
          {caller && (
            <div className="nc-row" title="Circuit breaker: stop calling a failing dependency for a while">
              <span className="nc-l">breaker</span>
              <button className={`nc-toggle ${data.breaker ? 'on' : ''}`} onClick={() => set({ breaker: !data.breaker })}>
                {data.breaker ? 'on' : 'off'}
              </button>
              {data.breaker && (
                <>
                  <span className="nc-l">fallback</span>
                  <button className={`nc-toggle ${data.fallback ? 'on' : ''}`} onClick={() => set({ fallback: !data.fallback })} title="Serve a degraded response while the breaker is open">
                    {data.fallback ? 'on' : 'off'}
                  </button>
                </>
              )}
            </div>
          )}
          {(data.kind === 'server' || data.kind === 'worker') && (
            <div className="nc-row" title="Threads per instance: every request in flight holds one, waiting on its calls included (thread-per-request, e.g. Tomcat's 200). async: waiting holds nothing">
              <span className="nc-l">threads</span>
              <select value={data.threads ?? 0} onChange={(e) => set({ threads: +e.target.value || undefined })}>
                <option value={0}>async</option>
                {[10, 25, 50, 100, 200, 500].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              {caller && (
                <>
                  <span className="nc-l" title="Bulkhead: calls that may wait on any one dependency at once, per instance — past it a call fails at once instead of taking another thread">
                    bulkhead
                  </span>
                  <select value={data.bulkhead ?? 0} onChange={(e) => set({ bulkhead: +e.target.value || undefined })}>
                    <option value={0}>off</option>
                    {[5, 10, 20, 50, 100].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>
          )}
          {data.kind !== 'client' && (outgoing > 1 || (data.routing ?? 'split') !== 'split' || data.kind === 'server' || data.kind === 'worker' || data.kind === 'function') && (
            <div className="nc-row" title="How calls spread over the components this one calls">
              <span className="nc-l">routing</span>
              <select value={data.routing ?? 'split'} onChange={(e) => set({ routing: e.target.value as RouteMode })}>
                {(['split', 'failover', 'fanout'] as RouteMode[]).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              {(data.kind === 'server' || data.kind === 'worker' || data.kind === 'function') && (
                <>
                  <span className="nc-l" title="Scatter-gather: each call goes to N partitions in parallel and waits for the slowest">
                    fan-out
                  </span>
                  <select value={data.fanout ?? 1} onChange={(e) => set({ fanout: +e.target.value > 1 ? +e.target.value : undefined })}>
                    {[1, 5, 10, 20, 50, 100].map((n) => (
                      <option key={n} value={n}>
                        ×{n}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>
          )}
          {bounded && (
            <div className="nc-row" title="Bounded queue: seconds of work this component holds before it sheds load">
              <span className="nc-l">queue</span>
              <select value={data.queueS ?? ''} onChange={(e) => set({ queueS: e.target.value === '' ? undefined : +e.target.value })}>
                <option value="">default</option>
                {[0.1, 0.25, 0.5, 1, 3, 10].map((q) => (
                  <option key={q} value={q}>
                    {q}s
                  </option>
                ))}
              </select>
            </div>
          )}
        </>
      )}

      <div className="nc-row nc-chaos">
        {isUp(data) && data.kind !== 'client' ? (
          <button className="nc-act danger" onClick={() => killNode(b, id)} title="Kill it (chaos)">
            <Skull size={12} /> kill
          </button>
        ) : !isUp(data) ? (
          <button className="nc-act good" onClick={() => reviveNode(b, id)} title="Bring it back">
            <HeartPulse size={12} /> revive
          </button>
        ) : null}
        {data.kind !== 'client' && isUp(data) && (
          <select
            value=""
            title="A gray failure: it stays up but misbehaves"
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'restore') apply(b, { type: 'restore', id });
              else if (v === 'flush') apply(b, { type: 'flush-cache', id });
              else if (v.startsWith('row')) set({ hotRowShare: +v.slice(3) || undefined });
              else if (v.startsWith('hot')) apply(b, { type: 'hot-key', id, share: +v.slice(3) });
              else if (v.startsWith('err')) apply(b, { type: 'inject-errors', id, rate: +v.slice(3) });
              else if (v.startsWith('lat')) apply(b, { type: 'inject-latency', id, ms: +v.slice(3) });
              else if (v.startsWith('deg')) apply(b, { type: 'degrade', id, factor: +v.slice(3) });
            }}
          >
            <option value="" disabled>
              break it…
            </option>
            <option value="err0.1">10% errors</option>
            <option value="err0.5">50% errors</option>
            <option value="lat100">+100 ms</option>
            <option value="lat500">+500 ms</option>
            <option value="lat2000">+2 s</option>
            <option value="deg0.5">50% capacity</option>
            {(data.kind === 'cache' || data.kind === 'cdn') && <option value="flush">flush cache</option>}
            {data.kind === 'db' && <option value={data.hotRowShare ? 'row0' : 'row0.3'}>{data.hotRowShare ? 'cool the hot row' : 'hot row (30% of writes on one row)'}</option>}
            {(data.kind === 'db' || data.kind === 'kv' || data.kind === 'storage') && <option value={data.hotKeyShare ? 'hot0' : 'hot0.3'}>{data.hotKeyShare ? 'cool the hot key' : data.kind === 'storage' ? 'hot prefix (30% on one)' : 'hot key (30% on one key)'}</option>}
            {(data.faultRate || data.faultLatencyMs || data.degraded !== undefined) && <option value="restore">restore</option>}
          </select>
        )}
        {calibratable && (
          <button className={`nc-act ${cal || data.capacity !== undefined || data.latencyMs !== undefined ? 'on' : ''}`} onClick={() => setCal(!cal)} title="Calibrate from production numbers: req/s at CPU %, p50, $/h">
            calibrate
          </button>
        )}
        <span className="nc-gap" />
        <button className="nc-act" onClick={() => removeNode(b, id)} title="Delete (Backspace)">
          <Trash2 size={12} />
        </button>
      </div>
      {cal && calibratable && <Calibrate d={data} apply={(p) => (set(p), setCal(false))} />}
    </div>
  );
}
