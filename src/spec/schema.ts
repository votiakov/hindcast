import { z } from 'zod';

/**
 * Hindcast architecture spec, v1 — the contract between the engine and everything else
 * (app, CLI, MCP server, future engines). Plain data, JSON or YAML.
 */

export const KIND_VALUES = ['client', 'cdn', 'lb', 'gateway', 'server', 'worker', 'function', 'cache', 'db', 'replica', 'storage', 'queue', 'llm', 'llmapi', 'external', 'kv', 'dns', 'stream', 'search', 'vector', 'archive'] as const;

export const ComponentSpec = z
  .object({
    id: z.string().min(1).describe('Unique id, also used as the display name unless `name` is set'),
    kind: z.enum(KIND_VALUES).describe('Component type — see list_components for capacities, latency and price'),
    name: z.string().optional(),
    tier: z.enum(['S', 'M', 'L']).optional().describe('Vertical size: S ×1, M ×2, L ×4 capacity'),
    instances: z.number().int().min(1).max(500).optional().describe('server/worker/llm: horizontal instances (reachable only behind lb/gateway/queue)'),
    runtime: z.enum(['node', 'python', 'java', 'go', 'rust']).optional().describe('server/worker/function language runtime'),
    hitRate: z.number().min(0).max(0.999).optional().describe('cache/cdn hit ratio'),
    limit: z.number().positive().optional().describe('gateway/llmapi/external/kv rate limit or function max concurrency, req/s'),
    batching: z.boolean().optional().describe('llm: continuous batching (×4 throughput, +400ms)'),
    retries: z.number().int().min(0).max(10).optional().describe('retries per failed downstream call'),
    retryPolicy: z.enum(['immediate', 'backoff', 'budget']).optional(),
    timeoutMs: z.number().positive().optional().describe('client deadline; slower responses count as failures'),
    breaker: z.boolean().optional().describe('circuit breaker on downstream calls'),
    fallback: z.boolean().optional().describe('serve a degraded response while the breaker is open'),
    routing: z.enum(['split', 'fanout', 'failover']).optional().describe('split evenly (default), call all children in parallel, or fail over in order'),
    stallRate: z.number().min(0).max(0.5).optional().describe('share of requests that hit a rare stall (GC pause, compaction, noisy neighbour)'),
    stallMs: z.number().min(0).optional().describe('stall duration in ms'),
    fanout: z.number().int().min(1).max(1000).optional().describe('each call goes to N partitions of the callee in parallel; the caller waits for the slowest (scatter-gather)'),
    queueS: z.number().positive().optional().describe('bounded queue length in seconds of work'),
    autoscale: z
      .object({
        min: z.number().int().min(1).max(500),
        max: z.number().int().min(1).max(500),
        targetUtil: z.number().min(0.1).max(0.95).optional().describe('utilisation to aim for (default 0.6)'),
        warmupS: z.number().min(0).max(900).optional().describe('launch → serving, seconds (default 30; EC2 ASG 90–180, k8s pod 5–20)'),
        cooldownS: z.number().min(0).max(3600).optional().describe('wait after scaling before scaling in (default 60)'),
      })
      .optional()
      .describe('server/worker/llm: target-tracking autoscaling; `instances` is the starting size'),
    warmupS: z.number().positive().optional().describe('cache/cdn: re-warm time constant after a restart or flush (default 20 s)'),
    writePolicy: z.enum(['through', 'behind']).optional().describe('cache/cdn: writes go on to the origin (through, default), or are acknowledged at the cache and flushed ~5 s later — fast, but lost if the cache dies first (behind)'),
    workingSetGb: z.number().positive().optional().describe('archive: the data it holds, GB (default 1,000), priced per GB-month; cache: the data it fronts, GB — with it the hit rate follows from the cache size (S 6.4, M 13, L 26 GB) and `skew`'),
    skew: z.number().min(0.1).max(3).optional().describe('cache: how concentrated reads are on popular keys (Zipf exponent, default 1)'),
    shards: z.number().int().min(1).max(256).optional().describe('db/replica: horizontal partitions, each a full database of its own — capacity and cost × shards; keys are spread by hash (give a sharded database\'s replica the same count)'),
    hotKeyShare: z.number().min(0).max(1).optional().describe('db/kv: share of its traffic on one key (a celebrity, a hot counter): it all lands on one shard, which saturates first'),
    partitions: z.number().int().min(1).max(1024).optional().describe('stream: partitions (default 4) — 1,000 messages/s in each, and a subscriber can use at most one consumer instance per partition'),
    refreshS: z.number().min(0).max(3600).optional().describe('search: how often the index refreshes, s (default 1) — a document is searchable only after the next refresh; a longer interval indexes faster but searches miss recent writes for longer'),
    retrieval: z.enum(['instant', 'expedited', 'standard']).optional().describe('archive: how a read gets its object back — instant (default: milliseconds, Glacier Instant Retrieval, 5,500 reads/s), or a Glacier Flexible Retrieval restore: expedited (1–5 min, $10 per 1,000) or standard (3–5 h) at 1,000 restores/s'),
    recall: z.number().min(0.5).max(0.999).optional().describe('vector: the recall queries are tuned for (default 0.95) — each halving of the neighbours a search may miss doubles its work: 0.99 costs five times 0.95'),
    vectorsM: z.number().positive().max(100000).optional().describe('vector: vectors in the index, millions (default 1; 768 dimensions, 3.5 GB of graph a million) — what does not fit in the nodes\' memory (4/8/16 GB a node by size) is read from disk at ~10× the cost'),
    ttlS: z.number().min(0).max(86400).optional().describe('dns: how long clients cache an answer, s (default 60) — a dead target keeps getting traffic until it expires'),
    healthCheckS: z.number().min(0).max(3600).optional().describe('dns: how long health checks take to notice a dead target, s (default 30; 3 checks × 10 s)'),
    threads: z.number().int().min(1).max(10000).optional().describe('server/worker: threads per instance — every request in flight holds one, waiting on its calls included (thread-per-request, e.g. Tomcat 200). Unset: asynchronous, waiting holds nothing'),
    bulkhead: z.number().int().min(1).max(10000).optional().describe('calls that may wait on any one dependency at once, per instance; past it a call fails at once instead of taking another thread'),
    provisioned: z.number().int().min(0).max(10000).optional().describe('function: provisioned concurrency — executions kept warm, so no cold start up to it; billed by the hour whether used or not ($0.0000041667 per GB-s)'),
    prefixes: z.number().int().min(1).max(100000).optional().describe('storage: key prefixes the objects are spread over (default 10) — S3 takes 5,500 reads or 3,500 writes a second per prefix; `hotKeyShare` puts that share on one prefix'),
    hotRowShare: z.number().min(0).max(1).optional().describe('db: share of the writes that update one row (a stock counter, a balance): its lock takes them one at a time, each for a write\'s time — at most 1,000 ÷ latency a second, however big the database'),
    burst: z.number().positive().optional().describe('gateway: the token bucket\'s size in requests (default one second of `limit`): a burst above the rate passes until the bucket is empty — API Gateway\'s rate 10,000 and burst 5,000'),
    maxReceives: z.number().int().min(1).max(100).optional().describe('queue: a redrive policy (SQS maxReceiveCount) — a message a consumer fails comes back after `visibilityS`, until it has been received this many times, then goes to the dead-letter queue; unset, a failed message is gone'),
    visibilityS: z.number().min(0).max(43200).optional().describe('queue: how long a received message stays hidden before it can be received again, s (default 30, as SQS)'),
    maxConnections: z.number().int().min(1).optional().describe('lb/gateway: connections it can hold at once; each request holds one for `connectionS` (a websocket session, a streamed answer, a long poll) — past it, new ones are refused (Erlang B)'),
    connectionS: z.number().positive().max(86400).optional().describe('lb/gateway: how long each request holds its connection, s (default 30)'),
    everyS: z.number().positive().optional().describe('client: a scheduled job instead of users (a cron, a nightly export) — every everyS seconds it sends `batch` requests over `batchS` (default 10 s), the first run 10 s in; it takes no share of the user traffic, and its requests do not count as the users\''),
    batch: z.number().min(0).optional().describe('client with everyS: requests per run'),
    batchS: z.number().positive().optional().describe('client with everyS: how long a run takes to send them, s (default 10)'),
    capacity: z.number().positive().optional().describe('override: req/s per size-S instance'),
    latencyMs: z.number().nonnegative().optional().describe('override: base service time'),
    costPerHour: z.number().nonnegative().optional().describe('override: $/h per size-S instance'),
  })
  .describe('One component of the architecture');

export const ZoneSpec = z.object({
  id: z.string(),
  label: z.string().optional(),
  members: z.array(z.string()).describe('component ids located in this failure domain'),
});

export const ArchitectureSpec = z.object({
  version: z.literal(1).default(1),
  name: z.string().optional(),
  description: z.string().optional(),
  pricing: z.enum(['illustrative', 'aws-us-east-1', 'gcp-us-central1', 'azure-eastus']).optional().describe('cost model: illustrative teaching defaults, or cited AWS us-east-1 / Google Cloud us-central1 / Azure East US on-demand prices'),
  commitment: z.enum(['none', '1y', '3y']).optional().describe('with a real pricing profile: a 1- or 3-year commitment (savings plan, reserved instances, committed use) at published rates, no upfront; usage prices are not discounted'),
  components: z.array(ComponentSpec).min(1),
  connections: z
    .array(
      z.union([
        z.tuple([z.string(), z.string()]),
        // "lb -> api": how people (and agents) write it without thinking
        z
          .string()
          .regex(/^\s*[^\s>]+\s*->\s*[^\s>]+\s*$/, 'write a connection as "from -> to"')
          .transform((s) => s.split('->').map((x) => x.trim()) as [string, string]),
        z.object({
          from: z.string(),
          to: z.string(),
          latencyMs: z.number().min(0).max(1000).optional().describe('network round trip added to every call over this link (cross-AZ ≈ 1, cross-region ≈ 60–150)'),
          calls: z.number().int().min(1).max(1000).optional().describe('calls per request over this link, made in parallel; the caller needs every one (a tweet written to N timelines, N lookups per page)'),
          carries: z.enum(['reads', 'writes']).optional().describe('the link takes only reads or only writes (CQRS: reads to a cache or replica, writes to a queue); default both'),
          replication: z.enum(['sync', 'async']).optional().describe('database → replica: sync — every write waits for this replica (no data lost on failover, writes stop while it is unreachable); async (default) — the replica lags, a failover loses what it had not received'),
        }),
      ]),
    )
    .describe('caller → callee pairs, e.g. "lb -> api", ["lb","api"] or { from, to, latencyMs }; order matters for failover routing'),
  zones: z.array(ZoneSpec).optional(),
  notes: z
    .array(z.object({ text: z.string().max(2000), x: z.number(), y: z.number(), width: z.number().positive().optional() }))
    .optional()
    .describe('notes on the board: free text at a position, for explaining the design; the engines ignore them'),
});

export const ActionSpec = z.discriminatedUnion('type', [
  z.object({ type: z.literal('kill-id'), id: z.string() }),
  z.object({ type: z.literal('revive-id'), id: z.string() }),
  z.object({ type: z.literal('kill'), kind: z.enum(KIND_VALUES), pick: z.enum(['busiest', 'random']).default('busiest') }),
  z.object({ type: z.literal('revive-all') }),
  z.object({ type: z.literal('fail-zone'), id: z.string() }),
  z.object({ type: z.literal('restore-zone'), id: z.string() }),
  z.object({ type: z.literal('degrade'), id: z.string(), factor: z.number().min(0).max(1) }),
  z.object({ type: z.literal('restore'), id: z.string() }),
  z.object({ type: z.literal('inject-errors'), id: z.string(), rate: z.number().min(0).max(1) }),
  z.object({ type: z.literal('inject-latency'), id: z.string(), ms: z.number().min(0) }),
  z.object({ type: z.literal('flush-cache'), id: z.string() }),
  z.object({ type: z.literal('hot-key'), id: z.string(), share: z.number().min(0).max(1) }).describe('database: this share of its traffic goes to one key — a celebrity, a hot counter — all on one shard (0 ends it)'),
  z.object({ type: z.literal('partition'), a: z.string().describe('zone id'), b: z.string().describe('zone id') }).describe('cut every link between two zones; both keep running'),
  z.object({ type: z.literal('heal-partition') }),
  z.object({ type: z.literal('cut-link'), from: z.string().describe('component id'), to: z.string().describe('component id') }).describe('cut one link: calls over it get no answer until the connection times out'),
  z.object({ type: z.literal('heal-link'), from: z.string(), to: z.string() }),
]);

export const ScenarioSpec = z.object({
  name: z.string().optional(),
  duration: z.number().positive().max(3600).default(60).describe('simulated seconds'),
  rps: z.number().nonnegative().optional().describe('constant traffic (ignored when `traffic` is given)'),
  traffic: z.array(z.object({ at: z.number().nonnegative(), rps: z.number().nonnegative() })).optional().describe('keyframes, linear in between'),
  readRatio: z.number().min(0).max(1).default(0.8),
  events: z.array(z.object({ at: z.number().nonnegative(), action: ActionSpec, note: z.string().optional() })).optional(),
  slo: z.object({ maxErrorRate: z.number().default(0.01), maxP99Ms: z.number().default(300) }).optional(),
});

export const ChangeSpec = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), id: z.string(), fields: ComponentSpec.omit({ id: true, kind: true }).partial() }),
  z.object({ op: z.literal('add'), component: ComponentSpec, zone: z.string().optional().describe('place it in this zone (failure domain)') }),
  z.object({ op: z.literal('remove'), id: z.string() }),
  z
    .object({
      op: z.literal('connect'),
      from: z.string(),
      to: z.string(),
      latencyMs: z.number().min(0).max(1000).optional(),
      calls: z.number().int().min(1).max(1000).optional(),
      carries: z.enum(['reads', 'writes']).optional(),
      replication: z.enum(['sync', 'async']).optional(),
    })
    .describe('add a link, or with link properties set them on an existing one'),
  z.object({ op: z.literal('disconnect'), from: z.string(), to: z.string() }),
]);

export const VariantSpec = z.object({
  name: z.string(),
  /** either a full replacement architecture… */
  spec: ArchitectureSpec.optional(),
  /** …or a list of edits applied to the base */
  changes: z.array(ChangeSpec).optional(),
});

export type ComponentSpec = z.infer<typeof ComponentSpec>;
export type ArchitectureSpec = z.infer<typeof ArchitectureSpec>;
export type ScenarioSpec = z.infer<typeof ScenarioSpec>;
export type ActionSpec = z.infer<typeof ActionSpec>;
export type ChangeSpec = z.infer<typeof ChangeSpec>;
export type VariantSpec = z.infer<typeof VariantSpec>;
