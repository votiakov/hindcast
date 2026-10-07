import { graph, X } from './build';
import type { Scenario } from './scenarios';

/**
 * Advanced comparisons — principal/architect-level tradeoffs grounded in real incidents and
 * canonical papers. Each one is verified in both engines (see docs/content.md).
 */

// 1 ─ the outage after the fix (AWS us-east-1, Oct 2025)
const recovery: Scenario = {
  id: 'outage-after-the-fix',
  title: 'The Outage After the Fix',
  tagline: 'A dependency disappears for 12 seconds, then comes back. One system recovers. One never does.',
  watch: 'Look at the moment the database returns: A stays at ~100% errors (its own retries keep it down); B is serving again within seconds.',
  readRatio: 0.8,
  a: {
    title: 'Retry immediately, at every layer',
    graph: graph(
      [
        ['users', 'client', X[0], 200, { retries: 3, retryPolicy: 'immediate', timeoutMs: 1000 }],
        ['lb', 'lb', X[1], 200],
        ['api', 'server', X[2], 150, { instances: 6, queueS: 3, retries: 2, retryPolicy: 'immediate' }],
        ['db', 'db', X[3], 200, { tier: 'L', name: 'state-store' }],
      ],
      [['users', 'lb'], ['lb', 'api'], ['api', 'db']],
    ),
  },
  b: {
    title: 'Retry budget + admission control',
    graph: graph(
      [
        ['users', 'client', X[0], 200, { retries: 3, retryPolicy: 'budget', timeoutMs: 1000 }],
        ['edge', 'gateway', X[1], 200, { limit: 1400, name: 'edge-throttle' }],
        ['api', 'server', X[2], 150, { instances: 6, queueS: 0.25 }],
        ['db', 'db', X[3], 200, { tier: 'L', name: 'state-store' }],
      ],
      [['users', 'edge'], ['edge', 'api'], ['api', 'db']],
    ),
  },
  timeline: [
    { at: 0, rps: 900, caption: 'Normal traffic. Same 6 API servers, same database.' },
    { at: 45, rps: 900 },
  ],
  events: [
    { at: 8, message: '💥 The state store becomes unreachable (think: an empty DNS record)', a: { type: 'kill-id', id: 'db' }, b: { type: 'kill-id', id: 'db' } },
    { at: 20, message: '🛠 Root cause fixed — the state store is back', a: { type: 'revive-id', id: 'db' }, b: { type: 'revive-id', id: 'db' } },
  ],
  takeaway: {
    a: 'Every failed call was retried immediately — by clients and again by the API. The queue filled with work nobody was waiting for, so the fix changed nothing: the system stayed down on its own load.',
    b: 'Retries capped at 10% extra load, a short queue that sheds, and a throttle at the edge. The failure hurt — and the moment the dependency returned, so did service.',
    lesson: 'Fixing the root cause is not recovery. Design the recovery path: retry budgets, jittered backoff, bounded queues and admission control.',
  },
};

// 2 ─ retries at every layer
const retryLayers: Scenario = {
  id: 'retries-every-layer',
  title: 'Retries at Every Layer',
  tagline: 'Four layers, each “just retrying 3 times”. A 10-second database brownout. Count the requests.',
  watch: 'The edge into the database: A multiplies load on the one component that is already struggling. B retries once, at the edge.',
  readRatio: 0.8,
  a: {
    title: '3 retries at every layer',
    graph: graph(
      [
        ['users', 'client', X[0], 200, { retries: 3, retryPolicy: 'immediate', timeoutMs: 2000 }],
        ['lb', 'lb', X[1], 200],
        ['api', 'server', X[2], 150, { instances: 6, retries: 3, retryPolicy: 'immediate', timeoutMs: 1000 }],
        ['mesh', 'lb', X[3], 200, { name: 'orders-lb' }],
        ['orders', 'server', X[4], 150, { instances: 6, retries: 3, retryPolicy: 'immediate', timeoutMs: 1000, name: 'orders-svc' }],
        ['db', 'db', X[5], 200, { tier: 'M' }],
      ],
      [['users', 'lb'], ['lb', 'api'], ['api', 'mesh'], ['mesh', 'orders'], ['orders', 'db']],
    ),
  },
  b: {
    title: 'Retry once, at the edge, with a budget',
    graph: graph(
      [
        ['users', 'client', X[0], 200, { retries: 3, retryPolicy: 'budget', timeoutMs: 2000 }],
        ['lb', 'lb', X[1], 200],
        ['api', 'server', X[2], 150, { instances: 6, timeoutMs: 1000 }],
        ['mesh', 'lb', X[3], 200, { name: 'orders-lb' }],
        ['orders', 'server', X[4], 150, { instances: 6, timeoutMs: 1000, name: 'orders-svc' }],
        ['db', 'db', X[5], 200, { tier: 'M' }],
      ],
      [['users', 'lb'], ['lb', 'api'], ['api', 'mesh'], ['mesh', 'orders'], ['orders', 'db']],
    ),
  },
  timeline: [
    { at: 0, rps: 800, caption: 'Client → API → orders service → database. Healthy.' },
    { at: 40, rps: 800 },
  ],
  events: [
    { at: 8, message: '🐢 Database brownout: 30% of normal capacity', a: { type: 'degrade', id: 'db', factor: 0.3 }, b: { type: 'degrade', id: 'db', factor: 0.3 } },
    { at: 20, message: '🛠 Database back to full capacity', a: { type: 'restore', id: 'db' }, b: { type: 'restore', id: 'db' } },
  ],
  takeaway: {
    a: 'Each layer retried 3×. Failures compound multiplicatively: up to 4 × 4 × 4 = 64 calls reach the database for one user click — exactly when it has the least capacity to spare.',
    b: 'Inner services fail fast; only the edge retries, within a 10% budget. The brownout costs some errors, the database never drowns, and recovery is immediate.',
    lesson: 'Retry in one place, deliberately. Every extra retrying layer multiplies load on the weakest component.',
  },
};

// 3 ─ cells vs one big fleet
const cellIds = [1, 2, 3, 4];
const cells: Scenario = {
  id: 'cells-vs-fleet',
  title: 'Cells vs One Big Fleet',
  tagline: 'A poison request crashes a database. Who is affected: everyone, or a quarter?',
  watch: 'A: one shared fleet and database — one failure, 100% of customers. B: four independent cells — the same failure, 25% of customers.',
  readRatio: 0.8,
  a: {
    title: 'One shared fleet',
    graph: graph(
      [
        ['users', 'client', X[0], 380],
        ['router', 'gateway', X[1], 380, { limit: 10000 }],
        ['api', 'server', X[2], 330, { instances: 8 }],
        ['db', 'db', X[3], 380, { tier: 'L', name: 'shared-db' }],
      ],
      [['users', 'router'], ['router', 'api'], ['api', 'db']],
    ),
  },
  b: {
    title: '4 independent cells',
    graph: graph(
      [
        ['users', 'client', X[0], 380],
        ['router', 'gateway', X[1], 380, { limit: 10000, name: 'cell-router' }],
        ...cellIds.flatMap((i): [string, 'server' | 'db', number, number, Record<string, unknown>][] => [
          [`api-c${i}`, 'server', X[2], (i - 1) * 250, { instances: 2, name: `cell-${i}-api` }],
          [`db-c${i}`, 'db', X[3], (i - 1) * 250 + 30, { name: `cell-${i}-db` }],
        ]),
      ],
      [['users', 'router'], ...cellIds.flatMap((i): [string, string][] => [['router', `api-c${i}`], [`api-c${i}`, `db-c${i}`]])],
    ),
  },
  timeline: [
    { at: 0, rps: 1200, caption: 'Same traffic, same total capacity. A shares everything; B partitions customers into cells.' },
    { at: 36, rps: 1200 },
  ],
  events: [
    { at: 10, message: '☠️ A poison request crashes the database it lands on', a: { type: 'kill-id', id: 'db' }, b: { type: 'kill-id', id: 'db-c2' } },
    { at: 26, message: '🛠 Database restored', a: { type: 'revive-id', id: 'db' }, b: { type: 'revive-id', id: 'db-c2' } },
  ],
  takeaway: {
    a: 'One database, one blast radius. The poison request took down every customer at once.',
    b: 'The same failure stayed inside one cell: 25% of customers affected, 75% never noticed. Add shuffle sharding and the overlap between any two customers shrinks further.',
    lesson: '“Is it better for 100% of customers to see 5% errors, or 5% of customers to see 100%?” Cells let you choose the second — and contain bad deploys the same way.',
  },
};

// 4 ─ queue vs shed
const shed: Scenario = {
  id: 'queue-vs-shed',
  title: 'Never Drop a Request? Queue vs Shed',
  tagline: 'Traffic doubles. One system queues everything. One says no to the excess. Which one serves more users?',
  watch: 'Useful throughput: A’s deep queue makes every response late, so almost nobody is served. B rejects the excess fast and keeps serving at full capacity.',
  readRatio: 0.8,
  a: {
    title: 'Deep queue (“never drop”)',
    graph: graph(
      [
        ['users', 'client', X[0], 200, { timeoutMs: 1000 }],
        ['lb', 'lb', X[1], 200],
        ['api', 'server', X[2], 150, { instances: 4, queueS: 10 }],
        ['db', 'db', X[3], 200, { tier: 'L' }],
      ],
      [['users', 'lb'], ['lb', 'api'], ['api', 'db']],
    ),
  },
  b: {
    title: 'Admission control + short queue',
    graph: graph(
      [
        ['users', 'client', X[0], 200, { timeoutMs: 1000 }],
        ['gate', 'gateway', X[1], 200, { limit: 950, name: 'admission' }],
        ['api', 'server', X[2], 150, { instances: 4, queueS: 0.2 }],
        ['db', 'db', X[3], 200, { tier: 'L' }],
      ],
      [['users', 'gate'], ['gate', 'api'], ['api', 'db']],
    ),
  },
  timeline: [
    { at: 0, rps: 600, caption: 'Both serve 600 req/s comfortably (capacity: 1,000 req/s).' },
    { at: 8, rps: 600 },
    { at: 10, rps: 1900, caption: '📈 Traffic almost doubles past capacity' },
    { at: 26, rps: 1900 },
    { at: 28, rps: 600, caption: 'Back to normal — watch how long A takes to drain its queue.' },
    { at: 42, rps: 600 },
  ],
  events: [],
  takeaway: {
    a: 'The queue accepted everything, so every request waited ~10 seconds behind the others. Clients gave up after 1s: the servers ran at 100% CPU producing answers nobody received. Useful throughput collapsed toward zero.',
    b: 'Requests beyond capacity got a fast “try later”. Everything admitted was served in milliseconds — about 50% of users served during the surge instead of ~0%, and instant recovery.',
    lesson: 'A queue is not capacity. Under overload, bounded queues and admission control maximise goodput; unbounded queues convert overload into latency and then into total failure.',
  },
};

// 5 ─ the tail at scale
const tail: Scenario = {
  id: 'tail-at-scale',
  title: 'The Tail at Scale',
  tagline: 'Each shard is fast. Fan a request out to 50 of them and see what your users feel.',
  watch: 'p99: the shards are identical on both sides. B waits for the slowest of 50 on every request, so a rare slow shard becomes the common case.',
  readRatio: 0.9,
  a: {
    title: '1 shard per request',
    graph: graph(
      [
        ['users', 'client', X[0], 200],
        ['lb', 'lb', X[1], 200],
        ['search', 'server', X[2], 150, { instances: 4, name: 'search-api' }],
        ['shards', 'server', X[3], 150, { instances: 40, capacity: 1000, latencyMs: 8, stallRate: 0.008, stallMs: 200, name: 'index-shards' }],
      ],
      [['users', 'lb'], ['lb', 'search'], ['search', 'shards']],
    ),
  },
  b: {
    title: 'Fan-out to 50 shards',
    graph: graph(
      [
        ['users', 'client', X[0], 200],
        ['lb', 'lb', X[1], 200],
        ['search', 'server', X[2], 150, { instances: 4, fanout: 50, name: 'search-api' }],
        ['shards', 'server', X[3], 150, { instances: 40, capacity: 1000, latencyMs: 8, stallRate: 0.008, stallMs: 200, name: 'index-shards' }],
      ],
      [['users', 'lb'], ['lb', 'search'], ['search', 'shards']],
    ),
  },
  timeline: [
    { at: 0, rps: 300, caption: 'Identical shards: 8 ms typical, but 1 call in 125 stalls for 200 ms (a GC pause). B queries 50 shards per request.' },
    { at: 30, rps: 300 },
  ],
  events: [],
  takeaway: {
    a: 'One shard per request: the user sees the shard’s typical latency, and its slow tail only rarely.',
    b: 'With 50 shards per request, a 1-in-125 stall hits 1 − (1 − 0.008)^50 ≈ 33% of requests. The shard’s rare tail became the user’s common case.',
    lesson: 'In scatter-gather systems, tail latency of the parts is the latency of the whole. Fight it with hedged requests, fewer/larger partitions, and tail-aware timeouts — not with averages.',
  },
};

// 6 ─ multi-provider LLM failover
const llmFailover: Scenario = {
  id: 'llm-provider-outage',
  title: 'When Your LLM Provider Goes Down',
  tagline: 'Your AI feature depends on one model API. It has an outage. Then it rate-limits the retry storm.',
  watch: 'A: 100% errors for the whole outage (and retries hammer a dead endpoint). B: traffic fails over to a second provider within one tick.',
  readRatio: 0.8,
  a: {
    title: 'One provider, naive retries',
    graph: graph(
      [
        ['users', 'client', X[0], 200, { retries: 3, retryPolicy: 'immediate', timeoutMs: 8000 }],
        ['lb', 'lb', X[1], 200],
        ['api', 'server', X[2], 160, { instances: 2 }],
        ['provider-a', 'llmapi', X[3], 200, { limit: 200, name: 'provider-a' }],
      ],
      [['users', 'lb'], ['lb', 'api'], ['api', 'provider-a']],
    ),
  },
  b: {
    title: 'LLM gateway: failover to provider B',
    graph: graph(
      [
        ['users', 'client', X[0], 200, { retries: 3, retryPolicy: 'budget', timeoutMs: 8000 }],
        ['lb', 'lb', X[1], 200],
        ['api', 'server', X[2], 160, { instances: 2, routing: 'failover', breaker: true }],
        ['provider-a', 'llmapi', X[3], 40, { limit: 200, name: 'provider-a' }],
        ['provider-b', 'llmapi', X[3], 380, { limit: 200, latencyMs: 2100, name: 'provider-b' }],
      ],
      [['users', 'lb'], ['lb', 'api'], ['api', 'provider-a'], ['api', 'provider-b']],
    ),
  },
  timeline: [
    { at: 0, rps: 90, caption: '90 AI requests/second against provider A.' },
    { at: 36, rps: 90 },
  ],
  events: [
    { at: 8, message: '⛔ Provider A outage', a: { type: 'kill-id', id: 'provider-a' }, b: { type: 'kill-id', id: 'provider-a' } },
    { at: 26, message: '✅ Provider A recovers', a: { type: 'revive-id', id: 'provider-a' }, b: { type: 'revive-id', id: 'provider-a' } },
  ],
  takeaway: {
    a: 'A single provider is a single point of failure you don’t operate. During the outage every request failed — and immediate retries tripled the traffic aimed at a dead endpoint.',
    b: 'A breaker stops hammering the failed provider and a gateway routes to the second one (slightly slower). Users barely notice; costs stay per-request.',
    lesson: 'Treat model APIs like any critical dependency: multi-provider failover, breakers, retry budgets — and test the failover path before you need it.',
  },
};

/** Paying for peak all day vs following demand — and the warm-up gap autoscaling leaves open. */
const elasticity: Scenario = {
  id: 'fleet-vs-autoscale',
  title: 'Peak-sized Fleet vs Autoscaling',
  tagline: 'Ten servers all day, or two that grow when the rush comes?',
  watch: 'Cost per hour on both sides, and the errors B takes while new instances boot.',
  readRatio: 0.8,
  a: {
    title: 'Sized for peak (10 fixed)',
    graph: graph(
      [
        ['users', 'client', X[0], 200],
        ['lb', 'lb', X[1], 200],
        ['api', 'server', X[2], 150, { instances: 10 }],
        ['db', 'db', X[3], 200, { tier: 'M' }],
      ],
      [['users', 'lb'], ['lb', 'api'], ['api', 'db']],
    ),
  },
  b: {
    title: 'Autoscaling 2–12',
    graph: graph(
      [
        ['users', 'client', X[0], 200],
        ['lb', 'lb', X[1], 200],
        ['api', 'server', X[2], 150, { instances: 2, autoscale: { min: 2, max: 12, targetUtil: 0.6, warmupS: 10, cooldownS: 15 } }],
        ['db', 'db', X[3], 200, { tier: 'M' }],
      ],
      [['users', 'lb'], ['lb', 'api'], ['api', 'db']],
    ),
  },
  timeline: [
    { at: 0, rps: 300, caption: 'A quiet morning: A runs 10 servers at 12% CPU, B runs 2 at 60%.' },
    { at: 18, rps: 300 },
    { at: 21, rps: 1400, caption: 'The lunch rush: 4.5× traffic in three seconds.' },
    { at: 45, rps: 1400 },
    { at: 48, rps: 300, caption: 'Rush over. B scales back in after its cooldown; A keeps paying for 10.' },
    { at: 90, rps: 300 },
  ],
  events: [],
  takeaway: {
    a: 'Never dropped a request — and paid for ten servers through every quiet minute.',
    b: 'Cheaper by the hour, but ate errors for the ~10 s its new instances took to boot. Longer warm-ups (EC2: minutes) widen that gap.',
    lesson: 'Autoscaling trades a warm-up window of risk for a lower bill. Keep the minimum high enough — or the warm-up short enough — to absorb the first seconds of a rush.',
  },
};

/** Losing a whole region: one region vs active-passive across two, with the latency of failing over far away. */
const regionB = graph(
  [
    ['users', 'client', X[0], 330],
    ['dns', 'gateway', X[1], 330, { limit: 20000, routing: 'failover' }],
    ['lb-eu', 'lb', X[2], 60],
    ['api-eu', 'server', X[3], 30, { instances: 4 }],
    ['db-eu', 'db', X[4], 60, { tier: 'M' }],
    ['lb-us', 'lb', X[2], 600],
    ['api-us', 'server', X[3], 570, { instances: 4 }],
    ['db-us', 'db', X[4], 600, { tier: 'M' }],
  ],
  [['users', 'dns'], ['dns', 'lb-eu'], ['dns', 'lb-us'], ['lb-eu', 'api-eu'], ['api-eu', 'db-eu'], ['lb-us', 'api-us'], ['api-us', 'db-us']],
  [
    ['eu', 'eu-west-1', X[2] - 40, -40, 1040, 380],
    ['us', 'us-east-1 (standby)', X[2] - 40, 500, 1040, 380],
  ],
);
// the standby region is an ocean away
regionB.edges = regionB.edges.map((e) => (e.source === 'dns' && e.target === 'lb-us' ? { ...e, data: { latencyMs: 80 } } : e));

const regions: Scenario = {
  id: 'region-failover',
  title: 'One Region vs Two',
  tagline: 'eu-west-1 goes dark. Do your users notice — and what does the insurance cost?',
  watch: 'A is down for as long as the region is. B fails over to us-east-1 and keeps serving, ~80 ms slower, at roughly twice the bill.',
  readRatio: 0.85,
  a: {
    title: 'eu-west-1 only',
    graph: graph(
      [
        ['users', 'client', X[0], 200],
        ['lb-eu', 'lb', X[1], 200],
        ['api-eu', 'server', X[2], 160, { instances: 4 }],
        ['db-eu', 'db', X[3], 200, { tier: 'M' }],
      ],
      [['users', 'lb-eu'], ['lb-eu', 'api-eu'], ['api-eu', 'db-eu']],
      [['eu', 'eu-west-1', X[1] - 40, 90, 1000, 420]],
    ),
  },
  b: { title: 'Active-passive, 2 regions', graph: regionB },
  timeline: [
    { at: 0, rps: 600, caption: 'Both serve European traffic from eu-west-1.' },
    { at: 36, rps: 600 },
  ],
  events: [
    { at: 10, message: '⚡ eu-west-1 is down', a: { type: 'fail-zone', id: 'eu' }, b: { type: 'fail-zone', id: 'eu' } },
    { at: 28, message: '🛠 eu-west-1 is back', a: { type: 'restore-zone', id: 'eu' }, b: { type: 'restore-zone', id: 'eu' } },
  ],
  takeaway: {
    a: 'Down for exactly as long as the region was. Nothing to fail over to.',
    b: 'Kept serving from us-east-1, ~80 ms slower per request while failed over, for about twice the infrastructure. Data replication between regions is assumed, not modelled.',
    lesson: 'Multi-region is insurance: you pay for a second copy every month to buy back the hours a regional outage would cost. Price both before you decide.',
  },
};

export const ADVANCED: Scenario[] = [recovery, retryLayers, cells, shed, tail, llmFailover, elasticity, regions];
