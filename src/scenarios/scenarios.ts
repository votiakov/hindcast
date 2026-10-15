import type { SimAction } from '../sim/actions';
import { graph, link, X, type Graph } from './build';

export type ScenarioAction = SimAction;

export interface ScenarioEvent {
  at: number;
  message: string;
  a?: ScenarioAction;
  b?: ScenarioAction;
}

export interface Scenario {
  id: string;
  title: string;
  /** one-liner shown on the picker card */
  tagline: string;
  /** what the viewer should watch for */
  watch: string;
  a: { title: string; graph: Graph };
  b: { title: string; graph: Graph };
  readRatio: number;
  /** traffic keyframes (linear between points); last point ends the run */
  timeline: { at: number; rps: number; caption?: string }[];
  events: ScenarioEvent[];
  takeaway: { a: string; b: string; lesson: string };
}

const extra = new Map<string, Scenario>();
/** register an ad-hoc scenario (e.g. from a link) so it can be played like a built-in one */
export function registerScenario(s: Scenario): Scenario {
  extra.set(s.id, s);
  return s;
}
export const findScenario = (id: string | null): Scenario | undefined => (id ? (extra.get(id) ?? SCENARIOS.find((s) => s.id === id)) : undefined);

export function scenarioTraffic(s: Scenario, t: number): number {
  const tl = s.timeline;
  if (t <= tl[0].at) return tl[0].rps;
  for (let i = 1; i < tl.length; i++) {
    if (t <= tl[i].at) {
      const p = (t - tl[i - 1].at) / (tl[i].at - tl[i - 1].at);
      return tl[i - 1].rps + (tl[i].rps - tl[i - 1].rps) * p;
    }
  }
  return tl[tl.length - 1].rps;
}

export function scenarioCaption(s: Scenario, t: number): string | undefined {
  let c: string | undefined;
  for (const k of s.timeline) if (k.caption && t >= k.at) c = k.caption;
  for (const e of s.events) if (t >= e.at) c = e.message;
  return c;
}

export const scenarioDuration = (s: Scenario) => s.timeline[s.timeline.length - 1].at;

export const BASIC_SCENARIOS: Scenario[] = [
  {
    id: 'monolith-vs-micro',
    title: 'Monolith vs Microservices',
    tagline: 'One shared database dies. How much of the product goes down with it?',
    watch: 'Error rate after the crash. The monolith shares one fate; services fail independently.',
    readRatio: 0.8,
    a: {
      title: 'Monolith',
      graph: graph(
        [
          ['users', 'client', X[0], 200],
          ['lb', 'lb', X[1], 200],
          ['app', 'server', X[2], 160, { instances: 4, tier: 'M' }],
          ['shared-db', 'db', X[3], 200, { tier: 'M' }],
        ],
        [['users', 'lb'], ['lb', 'app'], ['app', 'shared-db']],
      ),
    },
    b: {
      title: 'Microservices',
      graph: graph(
        [
          ['users', 'client', X[0], 280],
          ['gateway', 'gateway', X[1], 280, { limit: 5000 }],
          ['accounts', 'server', X[2], 0, { instances: 3 }],
          ['orders', 'server', X[2], 280, { instances: 3 }],
          ['catalog', 'server', X[2], 560, { instances: 3 }],
          ['accounts-db', 'db', X[3], 20],
          ['orders-db', 'db', X[3], 300],
          ['catalog-db', 'db', X[3], 580],
        ],
        [
          ['users', 'gateway'],
          ['gateway', 'accounts'], ['gateway', 'orders'], ['gateway', 'catalog'],
          ['accounts', 'accounts-db'], ['orders', 'orders-db'], ['catalog', 'catalog-db'],
        ],
      ),
    },
    timeline: [
      { at: 0, rps: 300, caption: 'Normal day. Both architectures serve traffic happily.' },
      { at: 4, rps: 1200 },
      { at: 30, rps: 1200 },
    ],
    events: [
      { at: 11, message: '💥 The orders database crashes', a: { type: 'kill-id', id: 'shared-db' }, b: { type: 'kill-id', id: 'orders-db' } },
      { at: 23, message: '🛠 Database restored', a: { type: 'revive-id', id: 'shared-db' }, b: { type: 'revive-id', id: 'orders-db' } },
    ],
    takeaway: {
      a: 'One database, one blast radius: when it died, 100% of requests failed — login, browsing, everything.',
      b: 'Only orders broke (~⅓ of traffic). Accounts and catalog kept serving. The price: more nodes, an extra hop, and far more to operate.',
      lesson: 'Microservices buy fault isolation and independent scaling — paid for in cost, latency hops and operational complexity.',
    },
  },
  {
    id: 'single-vs-ha-db',
    title: 'Single DB vs HA Cluster',
    tagline: 'The primary database dies mid-day. Outage or blip?',
    watch: 'A stays dark until a human restores it. B elects a replica in ~3s and carries on.',
    readRatio: 0.9,
    a: {
      title: 'One big database',
      graph: graph(
        [
          ['users', 'client', X[0], 200],
          ['lb', 'lb', X[1], 200],
          ['api', 'server', X[2], 160, { instances: 8 }],
          ['db', 'db', X[3], 200, { tier: 'L' }],
        ],
        [['users', 'lb'], ['lb', 'api'], ['api', 'db']],
      ),
    },
    b: {
      title: 'Primary + 2 replicas',
      graph: graph(
        [
          ['users', 'client', X[0], 200],
          ['lb', 'lb', X[1], 200],
          ['api', 'server', X[2], 160, { instances: 8 }],
          ['db', 'db', X[3], 200, { tier: 'M' }],
          ['replica-1', 'replica', X[4], 40],
          ['replica-2', 'replica', X[4], 360],
        ],
        [['users', 'lb'], ['lb', 'api'], ['api', 'db'], ['db', 'replica-1'], ['db', 'replica-2']],
      ),
    },
    timeline: [
      { at: 0, rps: 400, caption: 'Read-heavy app (90% reads). A scaled up; B scaled out with replicas.' },
      { at: 4, rps: 1500 },
      { at: 32, rps: 1500 },
    ],
    events: [
      { at: 10, message: '💥 Primary database hardware failure', a: { type: 'kill-id', id: 'db' }, b: { type: 'kill-id', id: 'db' } },
      { at: 25, message: '🛠 On-call restores the single DB from backup', a: { type: 'revive-id', id: 'db' } },
    ],
    takeaway: {
      a: 'A single primary is a single point of failure: total outage until a human fixed it. Vertical scaling also gets expensive fast (size L = 4.8× the cost).',
      b: 'Replicas shared the reads, then one was promoted automatically — a ~3s blip instead of an outage, and it was cheaper.',
      lesson: 'Redundancy beats size. Trade-offs: replication lag (stale reads) and writes still bottleneck on one primary.',
    },
  },
  {
    id: 'sync-vs-async',
    title: 'Sync vs Event-driven',
    tagline: 'Bursty traffic hits a slow payment worker. Who feels the pain — users or the backlog?',
    watch: 'A’s users see errors and seconds of latency during bursts. B’s users stay fast while the queue backlog grows and drains.',
    readRatio: 0.5,
    a: {
      title: 'Synchronous call chain',
      graph: graph(
        [
          ['users', 'client', X[0], 200],
          ['lb', 'lb', X[1], 200],
          ['api', 'server', X[2], 160, { instances: 6 }],
          ['worker-lb', 'lb', X[3], 200],
          ['payments', 'worker', X[4], 160, { instances: 4 }],
          ['db', 'db', X[5], 200],
        ],
        [['users', 'lb'], ['lb', 'api'], ['api', 'worker-lb'], ['worker-lb', 'payments'], ['payments', 'db']],
      ),
    },
    b: {
      title: 'Queue + workers',
      graph: graph(
        [
          ['users', 'client', X[0], 200],
          ['lb', 'lb', X[1], 200],
          ['api', 'server', X[2], 160, { instances: 6 }],
          ['jobs', 'queue', X[3], 200],
          ['payments', 'worker', X[4], 160, { instances: 4 }],
          ['db', 'db', X[5], 200],
        ],
        [['users', 'lb'], ['lb', 'api'], ['api', 'jobs'], ['jobs', 'payments'], ['payments', 'db']],
      ),
    },
    timeline: [
      { at: 0, rps: 300, caption: 'Checkout traffic. Payment workers handle 400 jobs/s total.' },
      { at: 6, rps: 300 },
      { at: 7, rps: 850, caption: '📈 Flash-sale burst: 850 checkouts/s' },
      { at: 12, rps: 850 },
      { at: 13, rps: 300, caption: 'Burst over.' },
      { at: 19, rps: 300 },
      { at: 20, rps: 950, caption: '📈 Second, bigger burst' },
      { at: 25, rps: 950 },
      { at: 26, rps: 300, caption: 'Quiet again — watch B’s backlog drain.' },
      { at: 40, rps: 300 },
    ],
    events: [],
    takeaway: {
      a: 'Every user request waited on the slowest dependency. When payments saturated, users got timeouts and errors.',
      b: 'Users got an instant “order received”. The burst became backlog that drained later — work finished seconds late, but nothing was lost.',
      lesson: 'Async decouples user latency from backend capacity. Costs: eventual consistency, idempotency, dead-letter queues, harder debugging.',
    },
  },
  {
    id: 'servers-vs-serverless',
    title: 'Servers vs Serverless',
    tagline: 'Quiet night, busy morning, then a flash sale. Which bill and which latency do you prefer?',
    watch: 'Cost line: serverless is nearly free when idle and very expensive at peak. Fixed fleet costs the same always — and overflows at peak.',
    readRatio: 0.8,
    a: {
      title: 'Fixed fleet (4 servers)',
      graph: graph(
        [
          ['users', 'client', X[0], 200],
          ['lb', 'lb', X[1], 200],
          ['api', 'server', X[2], 160, { instances: 4 }],
          ['store', 'storage', X[3], 200],
        ],
        [['users', 'lb'], ['lb', 'api'], ['api', 'store']],
      ),
    },
    b: {
      title: 'Serverless functions',
      graph: graph(
        [
          ['users', 'client', X[0], 200],
          ['gateway', 'gateway', X[1], 200, { limit: 10000 }],
          ['fn', 'function', X[2], 200],
          ['store', 'storage', X[3], 200],
        ],
        [['users', 'gateway'], ['gateway', 'fn'], ['fn', 'store']],
      ),
    },
    timeline: [
      { at: 0, rps: 40, caption: '🌙 3 a.m. — almost nobody around.' },
      { at: 9, rps: 40 },
      { at: 11, rps: 700, caption: '☀️ Morning traffic' },
      { at: 22, rps: 700 },
      { at: 23, rps: 2600, caption: '🔥 Flash sale!' },
      { at: 34, rps: 2600 },
      { at: 36, rps: 40, caption: '🌙 Back to quiet.' },
      { at: 44, rps: 40 },
    ],
    events: [],
    takeaway: {
      a: 'Predictable bill, but you pay for idle servers at night — and the fixed capacity overflowed during the sale.',
      b: 'Pennies at night and absorbed the sale, but cold starts added latency on ramps and the bill at peak was several times higher.',
      lesson: 'Serverless wins for spiky / low traffic. Steady high throughput is cheaper on provisioned servers (ideally with autoscaling).',
    },
  },
  {
    id: 'brute-vs-cache',
    title: 'Brute Force vs CDN + Cache',
    tagline: 'A read storm ramps to 3,000 req/s. More servers, or fewer requests?',
    watch: 'A throws money at servers and a huge DB and still saturates. B answers most requests before they ever reach the origin.',
    readRatio: 0.9,
    a: {
      title: 'Scale everything up',
      graph: graph(
        [
          ['users', 'client', X[0], 200],
          ['lb', 'lb', X[1], 200],
          ['api', 'server', X[2], 140, { instances: 12 }],
          ['db', 'db', X[3], 200, { tier: 'L' }],
        ],
        [['users', 'lb'], ['lb', 'api'], ['api', 'db']],
      ),
    },
    b: {
      title: 'CDN + cache',
      graph: graph(
        [
          ['users', 'client', X[0], 200],
          ['cdn', 'cdn', X[1], 200],
          ['lb', 'lb', X[2], 200],
          ['api', 'server', X[3], 160, { instances: 6 }],
          ['redis', 'cache', X[4], 200],
          ['db', 'db', X[5], 200],
        ],
        [['users', 'cdn'], ['cdn', 'lb'], ['lb', 'api'], ['api', 'redis'], ['redis', 'db']],
      ),
    },
    timeline: [
      { at: 0, rps: 400, caption: 'Your product just went viral on social media…' },
      { at: 20, rps: 3200, caption: '📈 Read storm building' },
      { at: 32, rps: 3200 },
    ],
    events: [],
    takeaway: {
      a: 'Costs more than double, and it still ran out of server capacity at the top of the curve.',
      b: 'The CDN absorbed ~60% at the edge, Redis ~85% of the rest — the database barely noticed. Cheaper and faster.',
      lesson: 'The cheapest request is the one you never serve. Trade-off: cache invalidation and staleness.',
    },
  },
  {
    id: 'single-vs-multi-az',
    title: 'Single-AZ vs Multi-AZ',
    tagline: 'An entire availability zone goes dark. Is your architecture still standing?',
    watch: 'A loses everything at once. B loses half its servers, fails the database over to the other zone, and keeps serving.',
    readRatio: 0.8,
    a: {
      title: 'Everything in one AZ',
      graph: graph(
        [
          ['users', 'client', X[0], 200],
          ['lb', 'lb', X[1], 200],
          ['api', 'server', X[2], 160, { instances: 6 }],
          ['db', 'db', X[3], 200],
        ],
        [['users', 'lb'], ['lb', 'api'], ['api', 'db']],
        [['az-a', 'us-east-1a', X[1] - 40, 90, 1000, 420]],
      ),
    },
    b: {
      title: 'Spread across 2 AZs',
      graph: graph(
        [
          ['users', 'client', X[0], 300],
          ['lb', 'lb', X[1], 300],
          ['api-a', 'server', X[2], 30, { instances: 4 }],
          ['db', 'db', X[3], 50],
          ['api-b', 'server', X[2], 520, { instances: 4 }],
          ['replica', 'replica', X[3], 540],
        ],
        [['users', 'lb'], ['lb', 'api-a'], ['lb', 'api-b'], ['api-a', 'db'], ['api-b', 'db'], ['db', 'replica']],
        [
          ['az-a', 'us-east-1a', X[2] - 40, -60, 680, 400],
          ['az-b', 'us-east-1b', X[2] - 40, 430, 680, 400],
        ],
      ),
    },
    timeline: [
      { at: 0, rps: 300, caption: 'Business as usual.' },
      { at: 4, rps: 800 },
      { at: 32, rps: 800 },
    ],
    events: [
      { at: 10, message: '⚡ Power failure: us-east-1a is down', a: { type: 'fail-zone', id: 'az-a' }, b: { type: 'fail-zone', id: 'az-a' } },
      { at: 26, message: '🛠 us-east-1a power restored', a: { type: 'restore-zone', id: 'az-a' }, b: { type: 'restore-zone', id: 'az-a' } },
    ],
    takeaway: {
      a: 'Cheap and simple — and a single zone outage took down 100% of the product until the zone came back.',
      b: 'The LB routed around dead servers, the replica in 1b was promoted, and the surviving half carried the load.',
      lesson: 'Spread every tier across failure domains (N+1 per zone). It costs more and adds cross-AZ latency/egress — usually worth it.',
    },
  },
  {
    id: 'retry-storm',
    title: 'Naive Retries vs Resilient Clients',
    tagline: 'A six-second spike. Then traffic goes back to normal. Only one system does.',
    watch: 'After the spike: A stays at ~100% errors forever (its own retries keep it down). B recovers in seconds.',
    readRatio: 0.8,
    a: {
      title: '3× immediate retries, deep queue',
      graph: graph(
        [
          ['users', 'client', X[0], 200, { retries: 3, retryPolicy: 'immediate', timeoutMs: 1000 }],
          ['lb', 'lb', X[1], 200],
          ['api', 'server', X[2], 150, { instances: 4, queueS: 3 }],
          ['db', 'db', X[3], 200, { tier: 'L' }],
        ],
        [['users', 'lb'], ['lb', 'api'], ['api', 'db']],
      ),
    },
    b: {
      title: 'Retry budget, breaker, short queue',
      graph: graph(
        [
          ['users', 'client', X[0], 200, { retries: 3, retryPolicy: 'budget', timeoutMs: 1000, breaker: true }],
          ['lb', 'lb', X[1], 200],
          ['api', 'server', X[2], 150, { instances: 4, queueS: 0.25 }],
          ['db', 'db', X[3], 200, { tier: 'L' }],
        ],
        [['users', 'lb'], ['lb', 'api'], ['api', 'db']],
      ),
    },
    timeline: [
      { at: 0, rps: 700, caption: 'Same app, same 4 servers. The only difference: how clients retry and how deep the queue is.' },
      { at: 8, rps: 700 },
      { at: 9, rps: 1600, caption: '📈 A six-second burst: 1,600 req/s' },
      { at: 14, rps: 1600 },
      { at: 15, rps: 700, caption: 'Burst over. Traffic is back to normal…' },
      { at: 20, rps: 700, caption: '…but A never recovers: stale queue + retries ×4 keep it saturated.' },
      { at: 40, rps: 700 },
    ],
    events: [],
    takeaway: {
      a: 'Clients gave up after 1s while the 3-second queue kept serving stale requests; every “late” answer triggered 3 more attempts. 4× the load, forever — a metastable failure.',
      b: 'Retries capped at 10% extra load, a breaker that backs off, and a short queue that sheds instead of hoarding. Errors during the burst, full recovery right after.',
      lesson: 'Retries are load. Budget them, bound your queues, and let breakers shed — or a 6-second blip becomes an outage.',
    },
  },
  {
    id: 'ai-api-vs-gpu',
    title: 'LLM API vs Self-hosted GPUs',
    tagline: 'Your AI feature went viral. Same traffic, two bills.',
    watch: 'Cost: the pay-per-request API scales with every request. The GPU pool is a flat cost, with the API only catching overflow.',
    readRatio: 0.8,
    a: {
      title: 'Hosted LLM API only',
      graph: graph(
        [
          ['users', 'client', X[0], 200],
          ['lb', 'lb', X[1], 200],
          ['api', 'server', X[2], 160, { instances: 2 }],
          ['llm-api', 'llmapi', X[3], 200, { limit: 300 }],
        ],
        [['users', 'lb'], ['lb', 'api'], ['api', 'llm-api']],
      ),
    },
    b: {
      title: 'Semantic cache → GPU pool, API as overflow',
      graph: graph(
        [
          ['users', 'client', X[0], 200],
          ['lb', 'lb', X[1], 200],
          ['api', 'server', X[2], 160, { instances: 2 }],
          ['semcache', 'cache', X[3], 200, { hitRate: 0.35, name: 'semantic-cache', routing: 'failover' }],
          ['gpu', 'llm', X[4], 40, { instances: 10, batching: true }],
          ['llm-api', 'llmapi', X[4], 380, { limit: 300 }],
        ],
        [['users', 'lb'], ['lb', 'api'], ['api', 'semcache'], ['semcache', 'llm-api'], ['semcache', 'gpu']],
      ),
    },
    timeline: [
      { at: 0, rps: 15, caption: 'Launch week: 15 req/s. Both work. A is simpler.' },
      { at: 8, rps: 15 },
      { at: 16, rps: 150, caption: '🚀 It went viral: 150 req/s' },
      { at: 32, rps: 150, caption: 'Look at the cost line.' },
      { at: 34, rps: 250, caption: '📈 Peak: 250 req/s — B spills overflow to the API' },
      { at: 42, rps: 250 },
    ],
    events: [],
    takeaway: {
      a: 'Simplest possible stack and zero ops — and a bill that grows with every request: ~$1,000+/hour at 150 req/s at $0.002 per call.',
      b: 'A semantic cache answers repeated questions, a fixed GPU pool serves the rest, the API only catches spikes. Flat ~$25–60/hour.',
      lesson: 'Pay-per-request is perfect at low volume. Past the break-even, own the steady state and rent the peak. (Assumes an open model is good enough for your use case.)',
    },
  },
  {
    id: 'node-vs-go',
    title: 'Node.js vs Go vs the Database',
    tagline: 'Same API, rewritten in Go. How much does the language really save?',
    watch: 'A needs 10 Node instances for what B serves with 4 Go instances — until traffic triples and the database becomes the wall for both.',
    readRatio: 0.85,
    a: {
      title: 'Node.js × 10',
      graph: graph(
        [
          ['users', 'client', X[0], 200],
          ['lb', 'lb', X[1], 200],
          ['api', 'server', X[2], 140, { instances: 10, runtime: 'node' }],
          ['db', 'db', X[3], 200, { tier: 'L' }],
        ],
        [['users', 'lb'], ['lb', 'api'], ['api', 'db']],
      ),
    },
    b: {
      title: 'Go × 4',
      graph: graph(
        [
          ['users', 'client', X[0], 200],
          ['lb', 'lb', X[1], 200],
          ['api', 'server', X[2], 160, { instances: 4, runtime: 'go' }],
          ['db', 'db', X[3], 200, { tier: 'L' }],
        ],
        [['users', 'lb'], ['lb', 'api'], ['api', 'db']],
      ),
    },
    timeline: [
      { at: 0, rps: 800, caption: 'Same JSON API. A: Node.js. B: Go. Same latency target.' },
      { at: 6, rps: 2000, caption: '2,000 req/s: B does it with 60% fewer instances — and lower latency.' },
      { at: 22, rps: 2000 },
      { at: 30, rps: 5500, caption: '📈 Traffic ×2.75 — now every request still hits the same database…' },
      { at: 44, rps: 5500, caption: 'The database is the bottleneck for both. No rewrite fixes that — a cache does.' },
    ],
    events: [],
    takeaway: {
      a: 'Node.js needs ~2.5× the instances of Go for a CPU-bound JSON API. More instances, bigger bill — but still a database-bound system at peak.',
      b: 'Go served the same load with 4 instances at lower latency. Then it hit exactly the same database wall.',
      lesson: 'A faster runtime cuts compute cost; it does not remove architectural bottlenecks. Profile first: if you\'re I/O- or DB-bound, the rewrite buys little.',
    },
  },
];

import { ADVANCED } from './advanced';

/** built-in comparisons: the basics, then the advanced (principal-level) set */
/** a cache on a write-heavy system: the habit that saves nothing (after The System Design Primer's Mint.com problem) */
BASIC_SCENARIOS.push({
  id: 'cache-on-writes',
  title: 'A Cache on a Write-Heavy App',
  tagline: 'Nine in ten requests are writes. Does a cache help?',
  watch: 'The database on the left stays red: only reads can hit a cache, and there are hardly any.',
  readRatio: 0.1,
  a: {
    title: 'Cache in front of a medium DB',
    graph: graph(
      [
        ['users', 'client', X[0], 200],
        ['lb', 'lb', X[1], 200],
        ['api', 'server', X[2], 200, { instances: 12 }],
        ['cache', 'cache', X[3], 200],
        ['db', 'db', X[4], 200, { tier: 'M' }],
      ],
      [['users', 'lb'], ['lb', 'api'], ['api', 'cache'], ['cache', 'db']],
    ),
  },
  b: {
    title: 'A large DB, no cache',
    graph: graph(
      [
        ['users', 'client', X[0], 200],
        ['lb', 'lb', X[1], 200],
        ['api', 'server', X[2], 200, { instances: 12 }],
        ['db', 'db', X[3], 200, { tier: 'L' }],
      ],
      [['users', 'lb'], ['lb', 'api'], ['api', 'db']],
    ),
  },
  timeline: [
    { at: 0, rps: 1200, caption: '1,200 req/s, 90% of them writes. Both keep up.' },
    { at: 8, rps: 2600, caption: 'Month-end: 2,600 req/s.' },
    { at: 30, rps: 2600 },
  ],
  events: [],
  takeaway: {
    a: 'The cache answered under 9% of requests — the reads that hit. Every write went through to a database that could not take them.',
    b: 'A database sized for writes carried the month-end with room to spare, for about $0.90/h more than the cache — and none of the failed requests.',
    lesson: 'Caches scale reads. Look at the read/write mix before reaching for one: a write-heavy system needs somewhere for its writes to go.',
  },
});

/** fan-out on write vs fan-out on read (after The System Design Primer's Twitter timeline problem) */
const timelineWrite = (() => {
  let g = graph(
    [
      ['users', 'client', X[0], 220],
      ['lb', 'lb', X[1], 220],
      ['api', 'server', X[2], 220, { instances: 14, name: 'timeline api' }],
      ['timelines', 'db', X[3], 80, { name: 'timelines (Redis)', capacity: 20000, latencyMs: 1 }],
      ['fanout-q', 'queue', X[3], 360, { name: 'fan-out queue' }],
      ['fanout', 'worker', X[4], 360, { instances: 4, name: 'fan-out workers' }],
      ['tweets', 'db', X[5], 360, { name: 'tweets', capacity: 15000, latencyMs: 5 }],
    ],
    [['users', 'lb'], ['lb', 'api'], ['api', 'timelines'], ['api', 'fanout-q'], ['fanout-q', 'fanout'], ['fanout', 'timelines'], ['fanout', 'tweets']],
  );
  g = link(g, 'api', 'timelines', { carries: 'reads' });
  g = link(g, 'api', 'fanout-q', { carries: 'writes' });
  return link(g, 'fanout', 'timelines', { calls: 20 });
})();
const timelineRead = (() => {
  let g = graph(
    [
      ['users', 'client', X[0], 220],
      ['lb', 'lb', X[1], 220],
      ['api', 'server', X[2], 220, { instances: 14, name: 'timeline api' }],
      ['tweets', 'db', X[3], 220, { name: 'tweets', capacity: 15000, latencyMs: 5 }],
    ],
    [['users', 'lb'], ['lb', 'api'], ['api', 'tweets']],
  );
  return link(g, 'api', 'tweets', { calls: 20 });
})();

BASIC_SCENARIOS.push({
  id: 'fanout-write-vs-read',
  title: 'Timelines: Fan-out on Write vs on Read',
  tagline: 'Build every timeline when a tweet is posted — or when it is read?',
  watch: 'The tweets database on the right: every timeline read becomes twenty lookups.',
  readRatio: 0.94,
  a: { title: 'Fan-out on write', graph: timelineWrite },
  b: { title: 'Fan-out on read', graph: timelineRead },
  timeline: [
    { at: 0, rps: 300, caption: '300 req/s: 94% timeline reads, 6% new tweets, 20 followers each on average. Both keep up.' },
    { at: 10, rps: 300 },
    { at: 18, rps: 3000, caption: 'Evening peak: 3,000 req/s.' },
    { at: 35, rps: 3000 },
  ],
  events: [],
  takeaway: {
    a: 'A tweet costs twenty timeline writes, done later by workers; a read is one lookup in a pre-built timeline. Reads are what users wait on, and they stayed fast.',
    b: 'A tweet is one write, but every read merges twenty followees’ tweets: 3,000 reads a second became 56,000 lookups, and the database could not keep up.',
    lesson: 'Do the work on the side that happens less: Twitter builds timelines on write. Its exception proves it — for accounts with millions of followers it fans out on read and merges at serve time.',
  },
});

/** a viral post: more shards vs a cache (after The System Design Primer's sharding section) */
const postsBoard = (shards: number, cache: boolean) =>
  graph(
    [
      ['users', 'client', X[0], 200],
      ['lb', 'lb', X[1], 200],
      ['api', 'server', X[2], 200, { instances: 48 }],
      ...(cache ? [['cache', 'cache', X[3], 200] as const] : []),
      ['db', 'db', X[cache ? 4 : 3], 200, { tier: 'L', shards, name: 'posts db' }],
    ] as Parameters<typeof graph>[0],
    cache ? [['users', 'lb'], ['lb', 'api'], ['api', 'cache'], ['cache', 'db']] : [['users', 'lb'], ['lb', 'api'], ['api', 'db']],
  );

BASIC_SCENARIOS.push({
  id: 'hot-key-shards-vs-cache',
  title: 'A Viral Post: More Shards or a Cache?',
  tagline: 'One post takes 40% of the traffic. Shard harder, or cache it?',
  watch: 'The database on the left: twice the shards, and the one holding the post is still red.',
  readRatio: 0.5,
  a: { title: 'Six shards', graph: postsBoard(6, false) },
  b: { title: 'Three shards and a cache', graph: postsBoard(3, true) },
  timeline: [
    { at: 0, rps: 9000, caption: '9,000 req/s, half of them writes, spread evenly over the shards. Both keep up.' },
    { at: 30, rps: 9000 },
  ],
  events: [{ at: 8, message: '🔥 A post goes viral: 40% of traffic on one key', a: { type: 'hot-key', id: 'db', share: 0.4 }, b: { type: 'hot-key', id: 'db', share: 0.4 } }],
  takeaway: {
    a: 'Six shards split the other posts six ways, but the viral one lives on one shard — and half of everything landed there. Twice the database bill bought nothing for the post that mattered.',
    b: 'The cache answered most reads, the viral post’s included, before they reached a shard: the hot shard took a fraction of the load, for the price of one cache.',
    lesson: 'Sharding splits keys, not a key. For a hot key, take the load off the shard — cache its reads, or give it a home of its own.',
  },
});

/** async vs sync replication through a partition and a failover (after the primer's CAP section) */
const regionsBoard = (sync: boolean) =>
  link(
    graph(
      [
        ['users', 'client', X[0], 330],
        ['lb', 'lb', X[1], 330],
        ['api', 'server', X[2], 330, { instances: 4 }],
        ['db', 'db', X[3] + 40, 110, { name: 'primary' }],
        ['rep', 'replica', X[3] + 40, 560, { name: 'replica' }],
      ],
      [['users', 'lb'], ['lb', 'api'], ['api', 'db'], ['db', 'rep']],
      [
        ['east', 'us-east (primary)', X[3], 40, 330, 210],
        ['west', 'us-west', X[3], 490, 330, 210],
      ],
    ),
    'db',
    'rep',
    sync ? { latencyMs: 70, replication: 'sync' } : { latencyMs: 70 },
  );

BASIC_SCENARIOS.push({
  id: 'async-vs-sync-replication',
  title: 'CAP, Live: Async vs Sync Replication',
  tagline: 'The regions lose each other. Keep writing, or keep every write?',
  watch: 'The right side refuses writes while the regions cannot talk. The left keeps writing — and loses those writes when us-east dies.',
  readRatio: 0.8,
  a: { title: 'Asynchronous replica', graph: regionsBoard(false) },
  b: { title: 'Synchronous replica', graph: regionsBoard(true) },
  timeline: [
    { at: 0, rps: 400, caption: '400 req/s, one in five a write. The replica in us-west is 70 ms away.' },
    { at: 30, rps: 400 },
  ],
  events: [
    { at: 5, message: '✂ The link between us-east and us-west is down', a: { type: 'partition', a: 'east', b: 'west' }, b: { type: 'partition', a: 'east', b: 'west' } },
    { at: 14, message: '⚡ us-east lost power', a: { type: 'fail-zone', id: 'east' }, b: { type: 'fail-zone', id: 'east' } },
  ],
  takeaway: {
    a: 'Writes never stopped — and every write acknowledged during the partition was gone when the replica was promoted: it had never received them.',
    b: 'Every write the primary could not copy to us-west was refused for as long as the regions were apart. None was lost.',
    lesson: 'During a partition you choose: availability (keep writing, maybe lose it) or consistency (refuse until you can copy it). A third region for the synchronous copy buys both.',
  },
});

/** a database you size vs a key-value store you pay per request (the primer's SQL or NoSQL) */
const storeBoard = (store: 'db' | 'kv') =>
  graph(
    [
      ['users', 'client', X[0], 200],
      ['lb', 'lb', X[1], 200],
      ['api', 'server', X[2], 200, { instances: 40, name: 'api' }],
      store === 'db' ? ['store', 'db', X[3], 200, { tier: 'L', name: 'postgres (L)' }] : ['store', 'kv', X[3], 200, { name: 'dynamodb' }],
    ],
    [['users', 'lb'], ['lb', 'api'], ['api', 'store']],
  );

BASIC_SCENARIOS.push({
  id: 'sql-box-vs-kv-on-demand',
  title: 'A Database Box vs a Key-Value Store on Demand',
  tagline: 'Size a database for the peak, or pay for every request?',
  watch: 'The cost strip: the box costs the same all night; the key-value store costs nothing at rest — and the most at the peak.',
  readRatio: 0.8,
  a: { title: 'Postgres, size L', graph: storeBoard('db') },
  b: { title: 'Key-value, on demand', graph: storeBoard('kv') },
  timeline: [
    { at: 0, rps: 300, caption: 'A quiet night: 300 req/s. The box idles at its full price.' },
    { at: 10, rps: 300 },
    { at: 13, rps: 8000, caption: 'A launch: 8,000 req/s, twice what the biggest box serves.' },
    { at: 26, rps: 8000 },
    { at: 28, rps: 300, caption: 'Back to quiet.' },
    { at: 36, rps: 300 },
  ],
  events: [],
  takeaway: {
    a: 'The box was paid for all night and still could not serve the launch: half of it failed at the largest size there is.',
    b: 'Pay-per-request cost almost nothing at rest and absorbed the launch — at several times the box’s hourly price while it lasted.',
    lesson: 'Managed key-value stores trade a fixed bill for a per-request one: cheap when quiet, elastic at a spike, dearer at sustained high load — and one hot key still throttles. Pick by the shape of your traffic and your access pattern, not by fashion.',
  },
});

/** two regions behind a health-checked DNS name: how long a region outage lasts for users */
const dnsBoard = (ttlS: number, healthCheckS: number) =>
  graph(
    [
      ['users', 'client', X[0], 330],
      ['dns', 'dns', X[1], 330, { routing: 'failover', ttlS, healthCheckS, name: 'api.example.com' }],
      ['lb-east', 'lb', X[2], 150],
      ['api-east', 'server', X[3], 150, { instances: 4 }],
      ['lb-west', 'lb', X[2], 520],
      ['api-west', 'server', X[3], 520, { instances: 4 }],
    ],
    [['users', 'dns'], ['dns', 'lb-east'], ['dns', 'lb-west'], ['lb-east', 'api-east'], ['lb-west', 'api-west']],
    [
      ['east', 'us-east', X[2] - 40, 90, 700, 210],
      ['west', 'us-west', X[2] - 40, 460, 700, 210],
    ],
  );

BASIC_SCENARIOS.push({
  id: 'dns-ttl-failover',
  title: 'DNS Failover: Why It Takes Minutes',
  tagline: 'A region dies. The standby is ready. How long do users keep failing?',
  watch: 'Errors after the outage: everyone fails until the health check notices, then fewer as cached answers expire.',
  readRatio: 0.8,
  a: { title: 'Defaults: TTL 60 s, checks 30 s', graph: dnsBoard(60, 30) },
  b: { title: 'Tuned: TTL 5 s, checks 10 s', graph: dnsBoard(5, 10) },
  timeline: [
    { at: 0, rps: 600, caption: '600 req/s to us-east; us-west is the failover target, idle and ready.' },
    { at: 10, rps: 600, caption: 'us-east loses power.' },
    { at: 30, rps: 600, caption: 'The health checks have noticed. Clients still holding the old answer keep trying us-east.' },
    { at: 110, rps: 600 },
  ],
  events: [{ at: 10, message: '⚡ us-east is down', a: { type: 'fail-zone', id: 'east' }, b: { type: 'fail-zone', id: 'east' } }],
  takeaway: {
    a: 'A minute and a half of errors with a healthy standby the whole time: 30 s for the checks to agree, then a 60 s TTL for every cache to let go.',
    b: 'About fifteen seconds: checks every few seconds and a short TTL — paid for with more DNS queries, and resolvers that ignore short TTLs will still lag.',
    lesson: 'DNS failover is as fast as its slowest cache. Keep TTLs short on names you fail over, or fail over below DNS: a global load balancer or anycast moves traffic in seconds.',
  },
});

/** listings written to a database and indexed for search: how long until a new one can be found */
const listingsBoard = (refreshS: number) =>
  link(
    graph(
      [
        ['users', 'client', X[0], 200],
        ['lb', 'lb', X[1], 200],
        ['api', 'server', X[2], 200, { instances: 4, routing: 'fanout', name: 'listings api' }],
        ['search', 'search', X[3], 80, { instances: 3, refreshS, name: 'listings search' }],
        ['db', 'db', X[3], 360, { name: 'listings db' }],
      ],
      [['users', 'lb'], ['lb', 'api'], ['api', 'search'], ['api', 'db']],
    ),
    'api',
    'db',
    { carries: 'writes' },
  );

BASIC_SCENARIOS.push({
  id: 'search-refresh',
  title: 'Search Freshness: Refresh Every 30 s vs 1 s',
  tagline: 'A seller posts a listing and searches for it. Is it there?',
  watch: 'Stale reads: searches that cannot see a listing written before them. Errors, latency and the bill are the same on both sides.',
  readRatio: 0.9,
  a: { title: 'Refresh every 30 s', graph: listingsBoard(30) },
  b: { title: 'Refresh every 1 s', graph: listingsBoard(1) },
  timeline: [
    { at: 0, rps: 300, caption: '300 req/s: searches, and one in ten a new or edited listing, written to the database and to the index.' },
    { at: 8, rps: 300, caption: 'A was set to refresh every 30 s for a bulk import, and nobody set it back.' },
    { at: 30, rps: 300 },
  ],
  events: [],
  takeaway: {
    a: 'A write becomes searchable at the next refresh: up to 30 s later. With 30 writes a second, nearly every search missed something just written — the seller’s own listing included.',
    b: 'A one-second refresh: a listing is findable about a second after it is saved. Same nodes, same bill, no stale reads counted.',
    lesson: 'A search index is eventually consistent: a write is searchable after the next refresh, later when indexing queues behind busy nodes. Raise the interval for bulk loads and set it back. When a user must see their own write at once, read it from the database, or wait for the refresh on that one write — not a shorter refresh for everyone.',
  },
});

/** a retrieval service over a vector index (OpenSearch k-NN, pgvector) */
const vectorBoard = (v: { recall?: number; instances: number; tier?: 'S' | 'M' | 'L'; vectorsM?: number; name: string }) =>
  graph(
    [
      ['users', 'client', X[0], 200],
      ['lb', 'lb', X[1], 200],
      ['api', 'server', X[2], 200, { instances: 8, name: 'retrieval api' }],
      ['vectors', 'vector', X[3], 200, { instances: v.instances, tier: v.tier ?? 'M', recall: v.recall, vectorsM: v.vectorsM, name: v.name }],
    ],
    [['users', 'lb'], ['lb', 'api'], ['api', 'vectors']],
  );

BASIC_SCENARIOS.push({
  id: 'vector-recall',
  title: 'Vector Search: Recall 0.99 vs 0.95',
  tagline: 'Same index, same nodes. One setting asks for 4% better recall.',
  watch: 'The vector database on the left: every query walks five times as much of the graph.',
  readRatio: 0.95,
  a: { title: 'Recall 0.99', graph: vectorBoard({ recall: 0.99, instances: 2, name: 'docs (k-NN)' }) },
  b: { title: 'Recall 0.95', graph: vectorBoard({ recall: 0.95, instances: 2, name: 'docs (k-NN)' }) },
  timeline: [
    { at: 0, rps: 150, caption: '150 queries/s against a million documents on two medium nodes. Both keep up — A is already five times as busy.' },
    { at: 8, rps: 150 },
    { at: 12, rps: 500, caption: 'A product launch: 500 queries/s.' },
    { at: 32, rps: 500 },
  ],
  events: [],
  takeaway: {
    a: 'Recall 0.99 made each query five times the work of 0.95: 240 queries/s from the two nodes instead of 1,200, at 50 ms a query instead of 10. The launch took it past its capacity.',
    b: 'Recall 0.95 served the launch at under half its capacity. To give A the same headroom would take about ten nodes instead of two.',
    lesson: 'Approximate search trades recall for work: each halving of what a query may miss doubles the graph it walks. Measure what recall your answers need — a reranker over the top 50 rarely needs 0.99 — and pay for that, not for the last point.',
  },
});

BASIC_SCENARIOS.push({
  id: 'vector-memory',
  title: 'Vector Search: When the Index Outgrows Memory',
  tagline: 'Ten million vectors, 35 GB of graph. Four nodes hold 32 GB of it. Does 9% matter?',
  watch: 'The vector database on the left: lookups that miss memory read the disk at ten times the cost.',
  readRatio: 0.95,
  a: { title: 'Four medium nodes (32 GB)', graph: vectorBoard({ instances: 4, vectorsM: 10, name: 'embeddings (10M)' }) },
  b: { title: 'Five medium nodes (40 GB)', graph: vectorBoard({ instances: 5, vectorsM: 10, name: 'embeddings (10M)' }) },
  timeline: [
    { at: 0, rps: 800, caption: '800 queries/s. A was sized for its CPU, and the index has grown past its memory.' },
    { at: 8, rps: 800 },
    { at: 12, rps: 1600, caption: 'Peak: 1,600 queries/s.' },
    { at: 32, rps: 1600 },
  ],
  events: [],
  takeaway: {
    a: '9% of the HNSW graph did not fit in memory, and lookups there read the disk: each query cost 1.8× the work. Four nodes served about 1,300 queries/s instead of 2,400, and the peak broke it.',
    b: 'One more node put the whole graph in memory: 3,000 queries/s, more than twice A’s capacity, for one node’s price ($0.36/h).',
    lesson: 'Size a vector database by memory first: the graph (about 3.5 GB per million 768-dimension vectors) must fit in what its nodes keep for it. A little over the line costs far more than its share — plan for the index the data will grow into.',
  },
});

/** an origin far from its users, with or without code at the edge in front of it */
const edgeBoard = (edge: boolean) =>
  link(
    graph(
      [
        ['users', 'client', X[0], 200],
        ...(edge ? [['edge', 'edge', X[1], 200, { edgeShare: 0.7, cpuMs: 2, cpuLimitMs: 10, name: 'edge function' }] as const] : []),
        ['lb', 'lb', X[edge ? 2 : 1], 200],
        ['api', 'server', X[edge ? 3 : 2], 200, { instances: 4, name: 'origin api' }],
        ['db', 'db', X[edge ? 4 : 3], 200, { tier: 'M' }],
      ] as Parameters<typeof graph>[0],
      edge ? [['users', 'edge'], ['edge', 'lb'], ['lb', 'api'], ['api', 'db']] : [['users', 'lb'], ['lb', 'api'], ['api', 'db']],
    ),
    edge ? 'edge' : 'users',
    'lb',
    { latencyMs: 80 },
  );

BASIC_SCENARIOS.push({
  id: 'edge-vs-origin',
  title: 'An Edge Function vs the Origin Round Trip',
  tagline: 'Redirects, geo, A/B buckets, auth checks: answer them near the user, or 80 ms away?',
  watch: 'The origin API: on the right it sees three requests in ten. And the edge function’s errors: work past its CPU limit is killed.',
  readRatio: 0.8,
  a: { title: 'Everything at the origin', graph: edgeBoard(false) },
  b: { title: 'An edge function in front', graph: edgeBoard(true) },
  timeline: [
    { at: 0, rps: 600, caption: '600 req/s from users 80 ms from the origin. 70% of them only need a redirect, a header or a yes/no.' },
    { at: 8, rps: 600 },
    { at: 12, rps: 2000, caption: 'A campaign: 2,000 req/s.' },
    { at: 32, rps: 2000 },
  ],
  events: [],
  takeaway: {
    a: 'Every request crossed the ocean and back for an answer the edge could have given in a few milliseconds, and the origin had to serve all 2,000 a second: it could not.',
    b: 'The edge function answered 70% near the users; the origin saw 600 a second at the peak. The price: every request is billed at the edge (about $2.40/h at 2,000 a second), and 2 ms of CPU on average against a 10 ms limit still runs one request in 150 past it — those are killed.',
    lesson: 'An edge function takes the cheap, frequent decisions off the origin and out of the round trip. Keep it small: CPU time has a long tail, and the platform kills what runs past the limit (about 1 ms on CloudFront Functions, 10 ms on Workers Free). Heavy work belongs at the origin.',
  },
});

export const SCENARIOS: Scenario[] = [...BASIC_SCENARIOS, ...ADVANCED];
