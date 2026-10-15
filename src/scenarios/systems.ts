import { graph, link, X, type Graph } from './build';

/**
 * Real systems, rebuilt from what their engineers published: the shape of each architecture, sized
 * to run at the traffic given. The numbers are illustrative (round, scaled down to a laptop); the
 * structure — what calls what, where the fan-out and the caches are — follows the write-up named.
 */
export interface RealSystem {
  id: string;
  title: string;
  /** what it shows, in one sentence */
  note: string;
  /** the public write-up it follows */
  source: string;
  rps: number;
  readRatio: number;
  graph: Graph;
}

const Y = [0, 230, 460, 690];

// chat: a socket gateway keeps every connection; messages land in a partitioned store and fan out to
// the members' sessions through an event bus (Discord's "How Discord Stores Trillions of Messages",
// and its gateway / Elixir write-ups)
const chat: RealSystem = {
  id: 'chat',
  title: 'Chat at scale (Discord-style)',
  note: 'A message is written once to a partitioned store, then fanned out to every member online — the fan-out is the load, not the write.',
  source: 'Discord engineering blog: “How Discord Stores Trillions of Messages” (2023) and its gateway write-ups',
  rps: 600,
  readRatio: 0.85,
  graph: link(
    graph(
      [
        ['users', 'client', X[0], Y[1]],
        ['gateway', 'lb', X[1], Y[1], { name: 'websocket gateway' }],
        ['api', 'server', X[2], Y[1], { instances: 6, name: 'api', routing: 'fanout' }],
        ['guilds', 'cache', X[3], Y[0], { name: 'guild cache', hitRate: 0.95 }],
        ['messages', 'kv', X[3], Y[2], { name: 'messages (ScyllaDB)', limit: 60000 }],
        ['events', 'stream', X[3], Y[3], { name: 'message events', partitions: 16 }],
        ['fanout', 'worker', X[4], Y[3], { instances: 8, name: 'session fan-out' }],
        ['guilddb', 'db', X[4], Y[0], { name: 'guilds (Postgres)' }],
      ],
      [['users', 'gateway'], ['gateway', 'api'], ['api', 'guilds'], ['guilds', 'guilddb'], ['api', 'messages'], ['api', 'events'], ['events', 'fanout']],
    ),
    'api',
    'messages',
    { carries: 'writes' },
  ),
};
chat.graph = link(chat.graph, 'api', 'events', { carries: 'writes' });

// video: almost every byte comes from caches inside the ISPs; the API decides what to play, and its
// own data sits behind a memcached layer (Netflix Open Connect and EVCache write-ups)
const video: RealSystem = {
  id: 'video',
  title: 'Video streaming (Netflix-style)',
  note: 'The CDN in the ISPs answers 95% of requests; what reaches the origin is the playback API and its cache — which is why a cold cache is the outage to fear.',
  source: 'Netflix TechBlog: Open Connect overview, and “EVCache: distributed in-memory datastore”',
  rps: 3000,
  readRatio: 0.97,
  graph: graph(
    [
      ['viewers', 'client', X[0], Y[1]],
      ['dns', 'dns', X[1], Y[1], { name: 'dns', ttlS: 60 }],
      ['openconnect', 'cdn', X[2], Y[1], { name: 'Open Connect (in ISPs)', hitRate: 0.95 }],
      ['zuul', 'gateway', X[3], Y[1], { name: 'edge gateway (Zuul)', limit: 20000 }],
      ['playback', 'server', X[4], Y[1], { instances: 4, name: 'playback api' }],
      ['evcache', 'cache', X[5], Y[0], { name: 'EVCache', hitRate: 0.9, tier: 'M' }],
      ['cassandra', 'db', X[5], Y[2], { name: 'Cassandra', shards: 4 }],
    ],
    [['viewers', 'dns'], ['dns', 'openconnect'], ['openconnect', 'zuul'], ['zuul', 'playback'], ['playback', 'evcache'], ['evcache', 'cassandra']],
  ),
};

// rides: drivers send their location every few seconds; dispatch asks a geo-sharded index for the
// nearest ones (Uber's "Ringpop" / H3 and dispatch write-ups)
const rides: RealSystem = {
  id: 'rides',
  title: 'Ride dispatch (Uber-style)',
  note: 'Location writes dwarf ride requests; dispatch asks several geo cells at once and waits for the slowest — the tail of one cell is every rider’s wait.',
  source: 'Uber Engineering: “H3: Uber’s Hexagonal Hierarchical Spatial Index” and its dispatch (DISCO) talks',
  rps: 800,
  readRatio: 0.3,
  graph: link(
    graph(
      [
        ['apps', 'client', X[0], Y[1], { name: 'riders + drivers' }],
        ['edge', 'gateway', X[1], Y[1], { name: 'api gateway', limit: 20000 }],
        ['dispatch', 'server', X[2], Y[0], { instances: 4, name: 'dispatch', routing: 'fanout' }],
        ['location', 'server', X[2], Y[2], { instances: 4, name: 'location ingest' }],
        ['geolb', 'lb', X[3], Y[0], { name: 'geo router' }],
        ['geo', 'server', X[4], Y[0], { instances: 6, name: 'geo index (H3 cells, in memory)' }],
        ['positions', 'kv', X[3], Y[2], { name: 'driver positions', limit: 40000 }],
        ['trips', 'db', X[3], Y[1] + 40, { name: 'trips' }],
      ],
      [['apps', 'edge'], ['edge', 'dispatch'], ['edge', 'location'], ['dispatch', 'geolb'], ['geolb', 'geo'], ['dispatch', 'trips'], ['location', 'positions']],
    ),
    'edge',
    'location',
    { carries: 'writes' },
  ),
};
// a ride request asks four neighbouring cells for drivers, in parallel, and waits for the slowest
rides.graph = link(link(rides.graph, 'dispatch', 'geolb', { calls: 4 }), 'edge', 'dispatch', { carries: 'reads' });

// payments: idempotency keys, a primary that acknowledges writes only once a replica has them,
// webhooks from a queue, and the card networks behind timeouts and a breaker (Stripe's write-ups on
// idempotency and its API's availability)
const payments: RealSystem = {
  id: 'payments',
  title: 'Payments API (Stripe-style)',
  note: 'Every charge is a write that must not be lost or doubled: idempotency keys, synchronous replication, and the card network called with a timeout, a retry budget and a breaker.',
  source: 'Stripe blog: “Designing robust and predictable APIs with idempotency” and its rate-limiter write-up',
  rps: 300,
  readRatio: 0.4,
  graph: link(
    graph(
      [
        ['merchants', 'client', X[0], Y[1]],
        ['gateway', 'gateway', X[1], Y[1], { name: 'api gateway (rate limits)', limit: 2000 }],
        ['api', 'server', X[2], Y[1], { instances: 4, name: 'payments api', threads: 100, bulkhead: 40, timeoutMs: 2000, retries: 2, retryPolicy: 'budget', breaker: true, routing: 'fanout' }],
        ['idem', 'cache', X[3], Y[0], { name: 'idempotency keys', hitRate: 0.05 }],
        ['ledger', 'db', X[4], Y[0], { name: 'ledger', tier: 'M' }],
        ['standby', 'replica', X[5], Y[0], { name: 'ledger standby', tier: 'M' }],
        ['networks', 'external', X[3], Y[2], { name: 'card networks', latencyMs: 350, limit: 3000 }],
        ['webhooks', 'queue', X[3], Y[3], { name: 'webhook queue' }],
        ['senders', 'worker', X[4], Y[3], { instances: 3, name: 'webhook senders' }],
      ],
      [['merchants', 'gateway'], ['gateway', 'api'], ['api', 'idem'], ['idem', 'ledger'], ['ledger', 'standby'], ['api', 'networks'], ['api', 'webhooks'], ['webhooks', 'senders']],
    ),
    'ledger',
    'standby',
    { replication: 'sync', latencyMs: 1.5 },
  ),
};
// a charge reaches the card network and queues a webhook; a lookup only reads
payments.graph = link(link(payments.graph, 'api', 'networks', { carries: 'writes' }), 'api', 'webhooks', { carries: 'writes' });

// timelines: a tweet is written into each follower's cached timeline as it is posted, so reading a
// timeline is one cache read (Twitter's "Timelines at Scale" talk)
const timelines: RealSystem = {
  id: 'timelines',
  title: 'Home timelines (Twitter-style fan-out on write)',
  note: 'Writes fan out to every follower’s timeline in a cache, so a read is one lookup; a celebrity with millions of followers is the write that breaks it.',
  source: 'Raffi Krikorian, “Timelines at Scale” (QCon 2013)',
  rps: 2000,
  readRatio: 0.95,
  graph: link(
    link(
      graph(
        [
          ['users', 'client', X[0], Y[1]],
          ['lb', 'lb', X[1], Y[1]],
          ['api', 'server', X[2], Y[1], { instances: 12, name: 'timeline api' }],
          ['timelines', 'cache', X[4], Y[0], { name: 'timeline cache (Redis)', hitRate: 0.98, tier: 'L' }],
          ['fanout', 'queue', X[3], Y[2], { name: 'fan-out queue' }],
          ['writers', 'worker', X[4], Y[2], { instances: 6, name: 'fan-out workers' }],
          ['tweets', 'db', X[5], Y[1], { name: 'tweets', shards: 4 }],
        ],
        [['users', 'lb'], ['lb', 'api'], ['api', 'timelines'], ['timelines', 'tweets'], ['api', 'fanout'], ['fanout', 'writers'], ['writers', 'timelines']],
      ),
      'api',
      'fanout',
      { carries: 'writes' },
    ),
    'writers',
    'timelines',
    { calls: 20 },
  ),
};
timelines.graph = link(timelines.graph, 'api', 'timelines', { carries: 'reads' });

// an LLM product: a cache for repeated prompts, the main provider, and a second one (or your own
// GPUs) to fail over to
const assistant: RealSystem = {
  id: 'assistant',
  title: 'AI assistant with a fallback provider',
  note: 'The provider is a dependency you don’t run: a semantic cache takes repeats, and a second provider takes over when the first rate-limits or goes down.',
  source: 'common practice in LLM gateway write-ups (multi-provider routing with fallback)',
  rps: 10,
  readRatio: 1,
  graph: graph(
    [
      ['users', 'client', X[0], Y[1]],
      ['api', 'server', X[1], Y[1], { instances: 2, name: 'assistant api', timeoutMs: 20000 }],
      ['semantic', 'cache', X[2], Y[1], { name: 'semantic cache', hitRate: 0.3 }],
      ['router', 'gateway', X[3], Y[1], { name: 'model router', routing: 'failover', limit: 2000 }],
      ['primary', 'llmapi', X[4], Y[0], { name: 'provider A', limit: 100 }],
      ['secondary', 'llmapi', X[4], Y[2], { name: 'provider B', limit: 60 }],
    ],
    [['users', 'api'], ['api', 'semantic'], ['semantic', 'router'], ['router', 'primary'], ['router', 'secondary']],
  ),
};

export const REAL_SYSTEMS: RealSystem[] = [chat, video, rides, payments, timelines, assistant];
