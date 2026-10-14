import type { Node, Edge } from '@xyflow/react';
import { kindPricing } from './pricing';
import type { AutoscaleSpec } from './autoscale';
import * as wasm from '../backtest/wasm/hindcast_engine.js';

/**
 * Component catalog: the *numbers* (capacity, latency, price) and node data shape.
 * Behaviour lives in ./components — one module per family, looked up by kind.
 * All figures are illustrative defaults; any node can override them via `SystemNodeData`.
 */

export type Kind =
  | 'client' | 'cdn' | 'lb' | 'gateway'
  | 'server' | 'worker' | 'function'
  | 'cache' | 'db' | 'replica' | 'storage'
  | 'queue'
  | 'llm' | 'llmapi'
  | 'external';
export type Tier = 'S' | 'M' | 'L';

/** how a node spreads its outgoing calls across children */
export type RouteMode = 'split' | 'fanout' | 'failover';
/** client / caller retry behaviour */
export type RetryPolicy = 'immediate' | 'backoff' | 'budget';
export type Runtime = 'node' | 'python' | 'java' | 'go' | 'rust';

/**
 * Language runtime profiles, relative to Node.js. Illustrative ratios for a typical
 * JSON-over-HTTP API (real gains depend heavily on the workload — I/O-bound code gains far less).
 */
export const RUNTIMES: Record<Runtime, { label: string; throughput: number; latency: number; coldStartMs: number; memoryMB: number; color: string }> = {
  node: { label: 'Node.js', throughput: 1, latency: 1, coldStartMs: 250, memoryMB: 256, color: '#84cc16' },
  python: { label: 'Python', throughput: 0.45, latency: 1.6, coldStartMs: 350, memoryMB: 256, color: '#3b82f6' },
  java: { label: 'Java', throughput: 1.5, latency: 0.8, coldStartMs: 1800, memoryMB: 512, color: '#f97316' },
  go: { label: 'Go', throughput: 2.5, latency: 0.5, coldStartMs: 80, memoryMB: 128, color: '#22d3ee' },
  rust: { label: 'Rust', throughput: 3.5, latency: 0.35, coldStartMs: 40, memoryMB: 128, color: '#f43f5e' },
};
/** kinds whose code you write — they get a runtime picker */
export const RUNTIME_KINDS: Kind[] = ['server', 'worker', 'function'];
/** AWS-Lambda-like pricing: per-request fee + GB-seconds */
export const FN_PRICE = { perRequest: 0.2 / 1_000_000, perGbSecond: 0.0000166667 };

export interface SystemNodeData extends Record<string, unknown> {
  kind: Kind;
  name: string;
  tier: Tier;
  alive: boolean;
  /** cache / cdn */
  hitRate?: number;
  /** server / worker / llm: horizontal instances behind this node */
  instances?: number;
  /** instances currently down */
  down?: number;
  /** gateway: rate limit, function: max concurrency, llmapi: provider rate limit (req/s) */
  limit?: number;

  // --- resilience knobs (any caller) ---
  /** retries per failed call (0 = none) */
  retries?: number;
  retryPolicy?: RetryPolicy;
  /** client deadline: responses slower than this count as failures (ms) */
  timeoutMs?: number;
  /** stop calling a failing dependency for a while */
  breaker?: boolean;
  /** when the breaker is open, serve a degraded response instead of an error */
  fallback?: boolean;
  routing?: RouteMode;
  /** each call fans out to N partitions of the callee in parallel and waits for the slowest */
  fanout?: number;
  /** rare hiccups (GC pause, compaction, noisy neighbour): share of requests that stall… */
  stallRate?: number;
  /** …and for how long (ms) */
  stallMs?: number;
  /** llm: continuous batching (more throughput, more latency) */
  batching?: boolean;
  /** server / worker / function: language runtime (unset = generic baseline) */
  runtime?: Runtime;

  // --- per-node overrides of catalog numbers ---
  capacity?: number;
  latencyMs?: number;
  costPerHour?: number;
  /** max seconds of work a node will queue before shedding (bounded queue) */
  queueS?: number;
  /** brownout multiplier on capacity (1 = healthy) */
  degraded?: number;

  // --- dynamics ---
  /** server / worker / llm: target-tracking autoscaling (instances = starting size) */
  autoscale?: AutoscaleSpec;
  /** cache / cdn: seconds to re-warm after a restart or flush (time constant) */
  warmupS?: number;
  /** cache/cdn: writes go on to the origin (through) or wait in the cache and flush later (behind) */
  writePolicy?: 'through' | 'behind';
  /** cache: the data it fronts, GB (hit rate then follows from its size and `skew`) */
  workingSetGb?: number;
  /** cache: Zipf exponent of key popularity (default 1) */
  skew?: number;
  /** db: horizontal partitions (capacity and cost × shards) */
  shards?: number;
  /** db: share of its traffic on one key — all of it on one shard */
  hotKeyShare?: number;
  /** set by a network partition: links between components on different sides are cut */
  side?: string;
  /** cache / cdn: bumped by the flush action — the engine empties the cache when it changes */
  flushes?: number;

  // --- gray failures (set by inject actions, cleared by restore) ---
  /** share of requests this node fails outright (bad deploy, poisoned config) */
  faultRate?: number;
  /** extra latency on every request (slow disk, noisy neighbour, GC) */
  faultLatencyMs?: number;
}

export interface ZoneData extends Record<string, unknown> {
  label: string;
  failed?: boolean;
}

export type SystemNode = Node<SystemNodeData, 'system'>;
export type ZoneNode = Node<ZoneData, 'zone'>;
export type AppNode = SystemNode | ZoneNode;
export type SystemEdge = Edge;

export const isSystem = (n: AppNode): n is SystemNode => n.type === 'system';

export interface KindSpec {
  kind: Kind;
  label: string;
  prefix: string;
  color: string;
  /** requests/sec one size-S instance can process */
  capacity: number;
  /** service time at zero load */
  baseLatencyMs: number;
  /** $/hour for one size-S instance */
  costPerHour: number;
  /** $ per request (usage-billed services) */
  costPerRequest?: number;
  /** default bounded-queue length in seconds of work (falls back to the engine timeout) */
  queueS?: number;
  /** supports S/M/L sizing */
  tiered: boolean;
  /** supports horizontal instances */
  scalable?: boolean;
  description: string;
}

export const KINDS: Record<Kind, KindSpec> = {
  client: {
    kind: 'client', label: 'Users', prefix: 'users', color: '#a78bfa',
    capacity: Infinity, baseLatencyMs: 0, costPerHour: 0, tiered: false,
    description: 'Traffic source. Can retry failed requests and give up after a timeout — like real clients.',
  },
  cdn: {
    kind: 'cdn', label: 'CDN', prefix: 'cdn', color: '#60a5fa',
    capacity: 100000, baseLatencyMs: 5, costPerHour: 0.08, tiered: false,
    description: 'Edge cache close to users. Serves cacheable responses; misses go to origin.',
  },
  lb: {
    kind: 'lb', label: 'Load Balancer', prefix: 'lb', color: '#38bdf8',
    capacity: 20000, baseLatencyMs: 1, costPerHour: 0.05, tiered: true,
    description: 'Spreads requests across healthy downstream nodes (or fails over in order). Health checks skip dead instances.',
  },
  gateway: {
    kind: 'gateway', label: 'API Gateway', prefix: 'gw', color: '#2dd4bf',
    capacity: 20000, baseLatencyMs: 3, costPerHour: 0.08, tiered: false,
    description: 'Routes requests and enforces a rate limit — excess gets a fast 429 instead of melting the backend.',
  },
  server: {
    kind: 'server', label: 'API Server', prefix: 'api', color: '#34d399',
    capacity: 250, baseLatencyMs: 25, costPerHour: 0.1, tiered: true, scalable: true,
    description: 'Stateless app server. Scale out with instances (needs a load balancer in front).',
  },
  worker: {
    kind: 'worker', label: 'Worker', prefix: 'worker', color: '#a3e635',
    capacity: 100, baseLatencyMs: 80, costPerHour: 0.08, tiered: true, scalable: true,
    description: 'Background job processor — slow, heavy work (payments, emails, video). Pulls from a queue or sits behind a LB.',
  },
  function: {
    kind: 'function', label: 'Serverless Fn', prefix: 'fn', color: '#fb923c',
    capacity: 3000, baseLatencyMs: 35, costPerHour: 0, costPerRequest: 0.6 / 1_000_000, tiered: false,
    description: 'Scales automatically up to a concurrency limit. Pay per request ($0.60 / 1M). Cold starts when scaling up fast.',
  },
  cache: {
    kind: 'cache', label: 'Cache', prefix: 'redis', color: '#f472b6',
    capacity: 20000, baseLatencyMs: 1, costPerHour: 0.15, tiered: true,
    description: 'In-memory cache. Hits return immediately; misses fall through to the next node.',
  },
  db: {
    kind: 'db', label: 'Database', prefix: 'postgres', color: '#fbbf24',
    capacity: 1000, baseLatencyMs: 10, costPerHour: 0.4, tiered: true,
    description: 'Primary database. Handles all writes. Connect Read Replicas to it to offload reads — and to fail over.',
  },
  replica: {
    kind: 'replica', label: 'Read Replica', prefix: 'replica', color: '#facc15',
    capacity: 1000, baseLatencyMs: 10, costPerHour: 0.35, tiered: true,
    description: 'Connect from a Database. Serves a share of reads. Promoted to primary automatically if the primary dies.',
  },
  storage: {
    kind: 'storage', label: 'Object Storage', prefix: 's3', color: '#94a3b8',
    capacity: 50000, baseLatencyMs: 40, costPerHour: 0.03, tiered: false,
    description: 'S3-style blob storage. Practically infinite throughput, but slow per request.',
  },
  queue: {
    kind: 'queue', label: 'Queue', prefix: 'queue', color: '#c084fc',
    capacity: 50000, baseLatencyMs: 3, costPerHour: 0.06, tiered: false,
    description: 'Async buffer. Producers get an instant ack; consumers drain at their own pace. Spikes become backlog, not errors.',
  },
  llm: {
    kind: 'llm', label: 'GPU Inference', prefix: 'gpu', color: '#f97316',
    capacity: 6, baseLatencyMs: 800, costPerHour: 4, queueS: 3, tiered: false, scalable: true,
    description: 'Self-hosted model on GPUs (one instance = one GPU). Continuous batching packs ~4× more requests per GPU at the cost of latency.',
  },
  llmapi: {
    kind: 'llmapi', label: 'LLM Provider API', prefix: 'llm-api', color: '#e879f9',
    capacity: 100, baseLatencyMs: 1500, costPerHour: 0, costPerRequest: 0.002, tiered: false,
    description: 'Hosted model API. Scales for you, but enforces a rate limit (429s) and bills per request (~$0.002).',
  },
  external: {
    kind: 'external', label: 'External API', prefix: 'ext', color: '#38bdf8',
    capacity: 1000, baseLatencyMs: 200, costPerHour: 0, tiered: false,
    description: 'Someone else\'s service: a payment provider, a partner API, the websites a crawler fetches. You cannot size it — only respect its rate limit and live with its latency and errors.',
  },
};

export const TIERS: Record<Tier, { capacity: number; cost: number; label: string }> = {
  S: { capacity: 1, cost: 1, label: 'Small' },
  M: { capacity: 2, cost: 2.2, label: 'Medium' },
  L: { capacity: 4, cost: 4.8, label: 'Large' },
};

export const CATEGORIES: { id: string; label: string; kinds: Kind[] }[] = [
  { id: 'traffic', label: 'Traffic', kinds: ['client'] },
  { id: 'edge', label: 'Edge & Network', kinds: ['cdn', 'lb', 'gateway'] },
  { id: 'compute', label: 'Compute', kinds: ['server', 'worker', 'function'] },
  { id: 'data', label: 'Data', kinds: ['cache', 'db', 'replica', 'storage'] },
  { id: 'async', label: 'Messaging', kinds: ['queue'] },
  { id: 'ai', label: 'AI', kinds: ['llm', 'llmapi'] },
  { id: 'outside', label: 'Third party', kinds: ['external'] },
];

export const QUEUE_MAX_BACKLOG = 200_000;
/** default cache re-warm time constant (s) */
export const CACHE_WARMUP_S = 20;

/** continuous batching multipliers for GPU inference */
export const BATCHING = { capacity: 4, latencyMs: 400 };

export function defaultData(kind: Kind, name: string): SystemNodeData {
  const d: SystemNodeData = { kind, name, tier: 'S', alive: true };
  if (KINDS[kind].scalable) Object.assign(d, { instances: 1, down: 0 });
  if (kind === 'cache') d.hitRate = 0.85;
  if (kind === 'cdn') d.hitRate = 0.6;
  if (kind === 'gateway') d.limit = 1500;
  if (kind === 'function') d.limit = 3000;
  if (kind === 'llmapi') d.limit = 100;
  if (kind === 'external') d.limit = 1000;
  return d;
}

export function instancesUp(d: SystemNodeData): number {
  return Math.max(0, (d.instances ?? 1) - (d.down ?? 0));
}

export function isUp(d: SystemNodeData): boolean {
  return d.alive && instancesUp(d) > 0;
}

/** capacity in req/s; `reachable` = instances that actually receive traffic */
/** the share of reads a cache answers: its hitRate, or what its size and the data it fronts give (engine) */
export const cacheHitRate = (d: SystemNodeData): number => (d.kind === 'cache' && d.workingSetGb ? wasm.cacheHitRate(d) : (d.hitRate ?? 0.85));

export function capacityOf(d: SystemNodeData, reachable = instancesUp(d)): number {
  const spec = KINDS[d.kind];
  let cap: number;
  if (d.kind === 'function' || d.kind === 'llmapi' || d.kind === 'external' || d.kind === 'gateway') cap = d.limit ?? spec.capacity;
  else {
    const tier = spec.tiered ? TIERS[d.tier].capacity : 1;
    const batch = d.kind === 'llm' && d.batching ? BATCHING.capacity : 1;
    const rt = d.runtime ? RUNTIMES[d.runtime].throughput : 1;
    cap = (d.capacity ?? spec.capacity) * tier * batch * rt * (spec.scalable ? Math.max(1, reachable) : 1) * shardsOf(d);
  }
  return cap * (d.degraded ?? 1);
}

/** a database's shard count (1 for everything else) */
export const shardsOf = (d: SystemNodeData): number => (d.kind === 'db' || d.kind === 'replica' ? Math.max(1, Math.floor(d.shards ?? 1)) : 1);

/** the share of a database's traffic on its busiest shard: the hot key, plus an even share of the rest */
export function hotShardShare(d: SystemNodeData): number {
  const h = d.kind === 'db' ? Math.min(1, Math.max(0, d.hotKeyShare ?? 0)) : 0;
  return h + (1 - h) / shardsOf(d);
}

export function baseLatencyOf(d: SystemNodeData): number {
  const rt = d.runtime ? RUNTIMES[d.runtime].latency : 1;
  return (d.latencyMs ?? KINDS[d.kind].baseLatencyMs) * rt + (d.kind === 'llm' && d.batching ? BATCHING.latencyMs : 0);
}

/** serverless $ per request: flat catalog price, or memory × duration when a runtime is chosen */
export function fnCostPerRequest(d: SystemNodeData): number {
  if (!d.runtime && !kindPricing('function')) return KINDS[d.kind].costPerRequest ?? 0;
  const r = RUNTIMES[d.runtime ?? 'node'];
  return FN_PRICE.perRequest + FN_PRICE.perGbSecond * (r.memoryMB / 1024) * (baseLatencyOf(d) / 1000);
}

/** fixed hourly cost (usage cost is added by the engine) — follows the active pricing profile */
export function costOf(d: SystemNodeData): number {
  const spec = KINDS[d.kind];
  const n = (d.instances ?? 1) * shardsOf(d);
  const p = d.costPerHour === undefined ? kindPricing(d.kind) : undefined;
  if (p?.tiers) return p.tiers[spec.tiered ? d.tier : 'S'].hourly * n;
  if (p?.fixed) return p.fixed.hourly * n;
  if (p?.perRequest) return 0;
  const tier = spec.tiered ? TIERS[d.tier].cost : 1;
  return (d.costPerHour ?? spec.costPerHour) * tier * n;
}

/** the concrete SKU behind a component under the active pricing profile (if any) */
export function skuOf(d: SystemNodeData): string | null {
  const p = kindPricing(d.kind);
  if (!p || d.costPerHour !== undefined) return null;
  return p.tiers ? p.tiers[KINDS[d.kind].tiered ? d.tier : 'S'].sku : p.fixed?.sku ?? null;
}
