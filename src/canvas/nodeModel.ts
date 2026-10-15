import { KINDS, QUEUE_MAX_BACKLOG, erlangB, hotPrefixShare, prefixesOf, baseLatencyOf, capacityOf, clustered, refreshSOf, vectorFit, vectorMemoryGb, archiveLimit, archiveRequestPrice, retrievalOf, VECTOR_GB_PER_M, VECTOR_DISK_FACTOR, threadsCapacity, costOf, hotShardShare, partitionsOf, instancesUp, isUp, shardsOf, skuOf, type SystemNodeData } from '../sim/catalog';
import type { NodeStats } from '../sim/engine';

export type Health = 'idle' | 'ok' | 'warm' | 'hot' | 'down';

export function healthOf(util: number, dropRps: number, inRps: number, up: boolean): Health {
  if (!up) return 'down';
  if (dropRps > Math.max(1, inRps * 0.02) || util >= 0.95) return 'hot';
  if (util >= 0.7) return 'warm';
  if (inRps < 0.5) return 'idle';
  return 'ok';
}

export const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(0)}ms`);
export const fmt = (n: number) => (!isFinite(n) ? '∞' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n >= 10 ? n.toFixed(0) : n.toFixed(1));

export interface NodeView {
  health: Health;
  /** node is serving (incl. a db mid-election) */
  up: boolean;
  failedOver: boolean;
  promotedReplica: boolean;
  electing: boolean;
  instances: number;
  instancesUp: number;
  /** autoscaled: instances still booting */
  booting: number;
  unreachable: boolean;
  noOrigin: boolean;
  /** a balancer or gateway with nothing behind it: whatever it receives fails */
  noTargets: boolean;
  cost: number;
  /** concrete SKU under a real pricing profile, e.g. "m7g.xlarge" */
  sku: string | null;
  stats: { label: string; value: string; bad?: boolean }[];
  meter: { label: string; value: string; fill: number } | null;
  /** short badges: retries, breaker, runtime… */
  tags: { text: string; tone?: 'bad' | 'warn' | 'good' }[];
}

/** everything a node renderer needs, theme-agnostic */
export function nodeView(d0: SystemNodeData, st: NodeStats | undefined, running: boolean, hasOutgoing: boolean): NodeView {
  const spec = KINDS[d0.kind];
  // an autoscaled node shows the instances the scaler is running right now
  const d = st?.scaling ? { ...d0, instances: st.scaling.live, down: Math.min(d0.down ?? 0, st.scaling.live) } : d0;
  const failover = st?.failover ?? 'none';
  const up = isUp(d) || (d.kind === 'db' && failover === 'electing');
  const util = st?.util ?? 0;
  const inRps = st?.inRps ?? 0;
  const dropRps = st?.dropRps ?? 0;

  let health: Health;
  // users have no capacity: their health is how many of their requests succeed
  if (d.kind === 'client') health = !up ? 'down' : inRps <= 0.5 ? 'idle' : (st?.success ?? 1) < 0.9 ? 'hot' : (st?.success ?? 1) < 0.99 ? 'warm' : 'ok';
  else if (d.kind === 'queue' || d.kind === 'stream') health = !up ? 'down' : dropRps > 1 ? 'hot' : (st?.queue ?? 0) > 500 ? 'warm' : inRps < 0.5 ? 'idle' : 'ok';
  else if (failover === 'electing') health = 'hot';
  else health = healthOf(util, dropRps, inRps, up);

  const pct = `${Math.round(Math.min(util, 9.99) * 100)}%`;
  let stats: NodeView['stats'];
  let meter: NodeView['meter'] = { label: 'CPU', value: pct, fill: util };
  switch (d.kind) {
    case 'client':
      stats = [
        { label: 'sending', value: `${fmt(inRps)}/s` },
        { label: 'success', value: `${((st?.success ?? 1) * 100).toFixed(1)}%`, bad: (st?.success ?? 1) < 0.99 },
        { label: 'latency', value: fmtMs(st?.latencyMs ?? 0) },
      ];
      meter = null;
      break;
    case 'queue':
    case 'stream': {
      const backlog = st?.queue ?? 0;
      const lag = st?.lagS ?? 0;
      stats = [
        { label: 'in', value: `${fmt(inRps)}/s` },
        { label: 'backlog', value: fmt(backlog), bad: backlog > 500 },
        { label: 'lag', value: isFinite(lag) ? `${lag.toFixed(1)}s` : '∞', bad: lag > 5 },
      ];
      meter = { label: 'BACKLOG', value: `${((backlog / QUEUE_MAX_BACKLOG) * 100).toFixed(1)}%`, fill: Math.max(backlog > 0 ? 0.02 : 0, backlog / QUEUE_MAX_BACKLOG) };
      break;
    }
    case 'function':
      stats = [
        { label: 'in', value: `${fmt(inRps)}/s` },
        { label: 'cold', value: `${Math.round((st?.coldFrac ?? 0) * 100)}%`, bad: (st?.coldFrac ?? 0) > 0.05 },
        { label: 'throttled', value: `${fmt(dropRps)}/s`, bad: dropRps > 1 },
      ];
      meter = { label: 'CONCURRENCY', value: pct, fill: util };
      break;
    case 'gateway':
    case 'llmapi':
    case 'external':
    case 'kv':
    case 'archive':
      stats = [
        { label: 'in', value: `${fmt(inRps)}/s` },
        { label: d.kind === 'archive' ? 'refused' : '429s', value: `${fmt(dropRps)}/s`, bad: dropRps > 1 },
        { label: 'limit', value: `${fmt(capacityOf(d))}/s` },
      ];
      meter = { label: 'LIMIT USED', value: pct, fill: util };
      break;
    case 'cache':
    case 'cdn':
      stats = [
        { label: 'in', value: `${fmt(inRps)}/s` },
        { label: 'hits', value: `${fmt(st?.hitRps ?? 0)}/s` },
        { label: 'cap', value: `${fmt(capacityOf(d))}/s` },
      ];
      if (st && st.warmth < 0.98) meter = { label: 'WARMTH', value: `${Math.round(st.warmth * 100)}%`, fill: st.warmth };
      break;
    default:
      stats = [
        { label: 'in', value: `${fmt(inRps)}/s` },
        { label: 'dropped', value: `${fmt(dropRps)}/s`, bad: dropRps > 1 },
        { label: 'cap', value: `${fmt(capacityOf(d, st?.reachable))}/s` },
      ];
  }

  const tags: NodeView['tags'] = [];
  if (d.runtime) tags.push({ text: d.runtime.toUpperCase() });
  if (d.batching) tags.push({ text: 'BATCHING' });
  if (d.degraded !== undefined && d.degraded < 1) tags.push({ text: `DEGRADED ×${d.degraded}`, tone: 'warn' });
  if ((d.retries ?? 0) > 0) {
    const amp = st?.retryAmp ?? 1;
    tags.push({ text: `RETRY ${d.retries}× ${d.retryPolicy ?? 'immediate'}${amp > 1.05 ? ` · load ×${amp.toFixed(1)}` : ''}`, tone: amp > 1.5 ? 'bad' : undefined });
  }
  if (d.timeoutMs) tags.push({ text: `TIMEOUT ${fmtMs(d.timeoutMs)}`, tone: (st?.lateFrac ?? 0) > 0.05 ? 'bad' : undefined });
  if (st?.breaker) tags.push({ text: `BREAKER ${st.breaker.toUpperCase()}${d.fallback ? ' +FALLBACK' : ''}`, tone: st.breaker === 'open' ? 'bad' : st.breaker === 'half' ? 'warn' : 'good' });
  if (d.routing && d.routing !== 'split') tags.push({ text: d.routing.toUpperCase() });
  if ((d.fanout ?? 1) > 1) tags.push({ text: `FAN-OUT ×${d.fanout}` });
  if (shardsOf(d) > 1) tags.push({ text: `${shardsOf(d)} SHARDS${d.hotKeyShare ? ` · HOT ${Math.round(hotShardShare(d) * 100)}%` : ''}`, tone: d.hotKeyShare ? 'warn' : undefined });
  if (d.autoscale) tags.push({ text: `AUTOSCALE ${d.autoscale.min}–${d.autoscale.max}${st?.scaling && st.scaling.desired !== st.scaling.live ? ` · want ${st.scaling.desired}` : ''}`, tone: st?.scaling?.pending ? 'warn' : undefined });
  if (st && st.warmth < 0.98 && (d.kind === 'cache' || d.kind === 'cdn')) tags.push({ text: `COLD ${Math.round(st.warmth * 100)}%`, tone: 'bad' });
  if (d.faultRate) tags.push({ text: `FAULT ${Math.round(d.faultRate * 100)}% errors`, tone: 'bad' });
  if (d.faultLatencyMs) tags.push({ text: `FAULT +${fmtMs(d.faultLatencyMs)}`, tone: 'bad' });
  if (d.stallRate) tags.push({ text: `STALLS ${+(d.stallRate * 100).toFixed(2)}% × ${d.stallMs ?? 0}ms`, tone: 'warn' });

  return {
    health,
    up,
    failedOver: d.kind === 'db' && failover === 'promoted',
    promotedReplica: d.kind === 'replica' && failover === 'promoted',
    electing: failover === 'electing',
    instances: d.instances ?? 1,
    instancesUp: instancesUp(d),
    booting: st?.scaling?.pending ?? 0,
    unreachable: !!spec.scalable && d.kind !== 'llm' && !clustered(d.kind) && instancesUp(d) > 1 && (st?.reachable ?? 1) < instancesUp(d) && running,
    noOrigin: (d.kind === 'cache' || d.kind === 'cdn') && !hasOutgoing,
    noTargets: (d.kind === 'lb' || d.kind === 'gateway' || d.kind === 'dns' || d.kind === 'stream') && !hasOutgoing,
    cost: st?.costPerHour ?? costOf(d),
    sku: skuOf(d),
    stats,
    meter,
    tags,
  };
}

/**
 * One plain-English sentence on what a component is going through right now, and why.
 * Powers the educational callouts (reference theme). Null when nothing noteworthy happens.
 */
export function explain(d: SystemNodeData, st: NodeStats | undefined, v: NodeView): { tone: 'bad' | 'warn' | 'info'; text: string } | null {
  if (!st) return null;
  const cap = capacityOf(d, st.reachable);
  if (v.failedOver) return { tone: 'info', text: 'Primary is down. A replica was promoted and now takes writes; this node only forwards.' };
  if (v.electing) return { tone: 'bad', text: 'Primary lost. Electing a replica — writes fail until one is promoted; reads continue on replicas.' };
  if (d.kind === 'client' && d.everyS) return { tone: 'info', text: `A scheduled job, not users: ${fmt(d.batch ?? 0)} requests over ${d.batchS ?? 10} s every ${d.everyS >= 3600 ? `${d.everyS / 3600} h` : d.everyS >= 60 ? `${d.everyS / 60} min` : `${d.everyS} s`}. It competes with the users for what it calls; its own failures are not counted as theirs.` };
  if (d.kind === 'client' && v.up && st.inRps > 0.5 && st.success < 0.99) return { tone: st.success < 0.9 ? 'bad' : 'warn', text: `${Math.round((1 - st.success) * 1000) / 10}% of these users' requests fail. Follow the red links to where they are lost.` };
  if (!v.up) return { tone: 'bad', text: 'Unavailable. Every request routed here fails unless an upstream load balancer can route around it.' };
  if (d.faultRate) return { tone: 'bad', text: `Injected fault: ${Math.round(d.faultRate * 100)}% of requests here fail — a bad deploy looks exactly like this. Callers with retries amplify it.` };
  if (d.faultLatencyMs) return { tone: 'bad', text: `Gray failure: +${fmtMs(d.faultLatencyMs)} on every request. It is still "up", so health checks pass — but each worker is busy longer, so throughput drops too.` };
  if ((d.kind === 'cache' || d.kind === 'cdn') && st.warmth < 0.9) return { tone: 'bad', text: `Cold cache: only ${Math.round(st.warmth * 100)}% warm, so misses that used to be hits stampede the origin until it refills.` };
  if (st.scaling && st.scaling.pending > 0) return { tone: 'warn', text: `Scaling out: ${st.scaling.pending} instance${st.scaling.pending > 1 ? 's' : ''} booting (warm-up ${d.autoscale?.warmupS ?? 30}s). Capacity arrives after the demand did — that gap is where errors happen.` };
  if (st.breaker === 'open') return { tone: 'warn', text: `Circuit breaker open: calls to the failing dependency are cut off${d.fallback ? ' and a fallback response is served' : ' and fail fast'}, giving it room to recover.` };
  if (st.retryAmp > 1.5) return { tone: 'bad', text: `Retry amplification ×${st.retryAmp.toFixed(1)}: failed calls are retried, multiplying the load on an already struggling dependency.` };
  if (st.lateFrac > 0.05) return { tone: 'bad', text: `${Math.round(st.lateFrac * 100)}% of responses arrive after the ${fmtMs(d.timeoutMs ?? 0)} timeout — the work was done, but the caller had already given up.` };
  if (d.kind === 'stream' && st.lagS > 5) return { tone: 'warn', text: `The slowest subscriber is ${isFinite(st.lagS) ? `${st.lagS.toFixed(0)} s` : 'indefinitely'} behind: every subscriber reads every message at its own pace, and none can use more consumers than the stream's ${partitionsOf(d)} partitions. Past retention, the oldest expire unread.` };
  if (d.kind === 'queue' && (st.deadLetterRps ?? 0) > 0.05) return { tone: 'warn', text: `${fmt(st.deadLetterRps ?? 0)}/s go to the dead-letter queue: messages its consumers failed ${d.maxReceives} times. The rest of the failures came back and were retried — which is extra load on the consumers.` };
  if (d.kind === 'queue' && st.lagS > 5) return { tone: 'warn', text: `Backlog of ${fmt(st.queue)} messages: consumers are ${isFinite(st.lagS) ? `${st.lagS.toFixed(0)}s` : 'indefinitely'} behind. Producers are unaffected — work completes later.` };
  if (d.kind === 'dns' && st.dropRps > 0.5) return { tone: 'bad', text: `${fmt(st.dropRps)}/s of clients still hold an answer pointing at a dead target and time out: they keep going there until the health checks notice (${d.healthCheckS ?? 30} s) and their cached answer expires (TTL ${d.ttlS ?? 60} s).` };
    if (d.kind === 'kv' && d.hotKeyShare && st.dropRps > 1 && st.inRps < capacityOf(d) * 0.98) return { tone: 'bad', text: `Hot partition: ${Math.round(d.hotKeyShare * 100)}% of requests are for one key, and one partition takes 3,000 reads or 1,000 writes a second however much the table allows (reads take it first; writes to that key starve) — ${fmt(st.dropRps)}/s are throttled. Cache that key, or spread it over several (write sharding).` };
  if ((d.kind === 'lb' || d.kind === 'gateway') && d.maxConnections) {
    const held = d.connectionS ?? 30;
    const refused = erlangB(d.maxConnections, st.inRps * held);
    if (refused > 0.01)
      return { tone: 'bad', text: `Connections full: ${fmt(st.inRps)} req/s, each holding a connection for ${held} s, need about ${fmt(st.inRps * held)} at once against a limit of ${fmt(d.maxConnections)} — ${Math.round(refused * 100)}% of new ones are refused. Fewer, shorter connections (or a higher limit) fix it; more instances behind it don't.` };
  }
  if (d.kind === 'storage' && st.dropRps > 1) return { tone: 'bad', text: `Prefix limit: an object store takes 5,500 reads or 3,500 writes a second per key prefix, however big the bucket. ${Math.round(hotPrefixShare(d) * 100)}% of requests land on the busiest of ${prefixesOf(d)} prefixes, and ${fmt(st.dropRps)}/s get 503 SlowDown. Spread keys over more prefixes, or cache the hot objects.` };
  if (d.kind === 'archive' && st.dropRps > 1)
    return { tone: 'bad', text: `Archive request limit: ${fmt(st.dropRps)}/s refused (503 SlowDown) above ${fmt(archiveLimit(d))}/s — ${retrievalOf(d) === 'instant' ? "Instant Retrieval shares S3's 5,500 GETs a second per prefix" : 'restore requests are capped at 1,000 a second per account'}. Archives are for data nobody reads in a hurry; put what users read in hot storage or a cache.` };
  if (d.kind === 'archive' && retrievalOf(d) !== 'instant' && st.inRps > 0.01)
    return { tone: 'bad', text: `Every read here is a restore that takes ${retrievalOf(d) === 'expedited' ? '1–5 minutes' : '3–5 hours'} (${retrievalOf(d)} retrieval) and costs $${archiveRequestPrice(d).toFixed(retrievalOf(d) === 'expedited' ? 3 : 5)} a request. Anyone waiting on it synchronously has long timed out: put a queue and a worker in front and notify when it is back, or keep what users read in Instant Retrieval.` };
  if ((d.kind === 'gateway' || d.kind === 'llmapi' || d.kind === 'external' || d.kind === 'kv') && st.dropRps > 1) return { tone: 'warn', text: `Rate limit reached: ${fmt(st.dropRps)}/s rejected with HTTP 429 to protect what is behind it.` };
  if (d.kind === 'function' && st.coldFrac > 0.05) return { tone: 'warn', text: `${Math.round(st.coldFrac * 100)}% of invocations hit a cold start while new instances spin up.${d.provisioned ? '' : ' Provisioned concurrency keeps some warm, for a price by the hour.'}` };
  if (d.kind === 'vector' && vectorFit(d) < 0.999 && (v.health === 'hot' || v.health === 'warm'))
    return { tone: 'bad', text: `The index does not fit in memory: ${fmt((d.vectorsM ?? 1) * VECTOR_GB_PER_M)} GB of graph against the ${fmt(vectorMemoryGb(d))} GB its nodes keep for it, so ${Math.round((1 - vectorFit(d)) * 100)}% of lookups read the disk at ~${VECTOR_DISK_FACTOR}× the cost. Add nodes (or bigger ones) until it fits — that buys more than CPU would.` };
  if (d.kind === 'vector' && (d.recall ?? 0.95) > 0.95 && (v.health === 'hot' || v.health === 'warm')) {
    const miss = 1 - Math.min(0.999, d.recall ?? 0.95);
    return { tone: 'warn', text: `Recall ${d.recall} costs ${(0.05 / miss).toFixed(1)}× the work of 0.95 per query: each halving of the neighbours a search may miss doubles the graph it walks. Is the last bit of recall worth ${Math.round((1 - miss / 0.05) * 100)}% of the capacity?` };
  }
  if (d.kind === 'search' && (st.replLagS ?? 0) > 1) return { tone: 'warn', text: `New documents show up in search ${fmtMs((st.replLagS ?? 0) * 1000)} after they are written: the index refreshes every ${refreshSOf(d)} s${(st.replLagS ?? 0) > refreshSOf(d) + 0.5 ? ', and indexing is queued behind the queries the nodes are busy with' : ''}. Searches in that window miss them — fine for a catalogue, wrong for "I just posted it, where is it?".` };
  if (d.kind === 'replica' && (st.replLagS ?? 0) > 1) return { tone: 'warn', text: `${(st.replLagS ?? 0) >= 60 ? `${Math.round((st.replLagS ?? 0) / 60)} min` : `${Math.round(st.replLagS ?? 0)} s`} behind its primary: reads here miss the latest writes, and a failover now would lose them.` };
  if (v.noTargets && st.inRps > 0.01) return { tone: 'bad', text: `Nothing behind this ${d.kind === 'lb' ? 'load balancer' : d.kind === 'dns' ? 'name' : d.kind === 'stream' ? 'stream (no subscribers)' : 'gateway'}: the ${fmt(st.inRps)} req/s it receives have nowhere to go and fail. Connect it to what it fronts.` };
  if (v.noOrigin && st.dropRps > 0.01) return { tone: 'bad', text: `No origin behind this cache: its ${fmt(st.dropRps)} misses a second have nowhere to go and fail. Connect it to the store it caches, or make it a database if it is the store.` };
  if (d.kind === 'db' && d.hotRowShare && st.dropRps > 1)
    return { tone: 'bad', text: `Hot row: ${Math.round(d.hotRowShare * 100)}% of the writes update one key, and its row lock takes them one at a time (${fmtMs(baseLatencyOf(d))} each) — at most ${fmt(1000 / Math.max(0.1, baseLatencyOf(d)))}/s however big the database. The rest wait, then time out. Batch the updates, split the counter over several rows, or keep it in a cache.` };
  if (d.kind === 'db' && shardsOf(d) > 1 && d.hotKeyShare && (v.health === 'hot' || st.dropRps > 1)) {
    const share = hotShardShare(d);
    return { tone: 'bad', text: `Hot shard: ${Math.round(share * 100)}% of the traffic lands on one of ${shardsOf(d)} shards (${Math.round(d.hotKeyShare * 100)}% on one key), so it saturates while the others idle. More shards cannot split one key — cache it, or grow every shard.` };
  }
  if (d.threads && st.dropRps > 1) {
    const tc = threadsCapacity(d, st.reachable, st.holdMs ?? 0);
    if (tc < cap * 0.95)
      return { tone: 'bad', text: `Out of threads: ${d.threads * Math.max(1, st.reachable)} threads, one per request in flight, each held ${fmtMs(baseLatencyOf(d) + (st.holdMs ?? 0))} — mostly waiting on its calls — so only ${fmt(tc)} req/s get one. A slow dependency is holding them: a timeout gives them back sooner; a bulkhead stops one dependency from taking them all.` };
  }
  if (v.health === 'hot' && st.dropRps > 1 && st.inRps >= cap * 0.9) return { tone: 'bad', text: `Overloaded: ${fmt(st.inRps)} req/s offered vs ${fmt(cap)} req/s capacity. The excess queues, then gets dropped.` };
  // drops while the offered load is below capacity: a surge just passed (the averages lag it)
  if (v.health === 'hot' && st.dropRps > 1) return { tone: 'warn', text: `Recovering from a surge: load came in above its ${fmt(cap)} req/s capacity moments ago, and ${fmt(st.dropRps)} req/s are still being shed while its queue drains.` };
  if (v.health === 'hot') return { tone: 'bad', text: `Saturated at ${Math.round(st.util * 100)}% — requests are queuing and latency is climbing steeply.` };
  if (v.health === 'warm') return { tone: 'warn', text: `${Math.round(st.util * 100)}% utilised. Queueing delay grows non-linearly beyond ~70%; little headroom left for spikes.` };
  if (v.unreachable) return { tone: 'warn', text: 'Extra instances receive no traffic: without a load balancer, clients only know one address.' };
  if (v.noOrigin) return { tone: 'bad', text: 'No origin behind this cache: every miss has nowhere to go and fails.' };
  return null;
}
