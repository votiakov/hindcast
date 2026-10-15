/**
 * The terms the board, the lessons and the reports use, each in a sentence or two. Explanations on
 * the board underline the first use of a term; hovering it shows the definition.
 */
export const GLOSSARY: Record<string, string> = {
  p50: 'The median response time: half the requests are faster, half slower.',
  p99: 'The response time 99% of requests beat. The slowest 1% — at a million requests a day, ten thousand people.',
  'p99.9': 'The response time 99.9% of requests beat: the tail that large fan-outs make everyone wait for.',
  SLO: 'Service level objective: the target a system is held to, e.g. “errors under 1% and p99 under 300 ms”.',
  'error budget': 'What the SLO allows to fail over a period: at 99.9% a month, about 43 minutes of full outage.',
  'burn rate': 'How fast the current error rate uses up the error budget: 1× lasts the month, 14.4× spends 2% of it in an hour.',
  throughput: 'Requests handled per second.',
  goodput: 'Requests answered successfully per second — throughput minus what failed.',
  latency: 'How long a request takes, from the caller’s side.',
  utilisation: 'The share of a component’s capacity in use. Waiting grows steeply past about 70%.',
  utilised: 'In use as a share of capacity. Waiting grows steeply past about 70%.',
  capacity: 'The requests a second a component can serve before it has to queue or refuse.',
  queue: 'Work waiting for a free worker. A bounded queue sheds what would wait too long.',
  backlog: 'Messages waiting in a queue or stream for a consumer.',
  'load shedding': 'Refusing work on purpose when overloaded, so the work accepted still finishes in time.',
  timeout: 'How long a caller waits for an answer before giving up and counting the call as failed.',
  retries: 'Calling again after a failure. They rescue transient errors and multiply the load on a struggling dependency.',
  'retry amplification': 'Each failed call retried N times turns one request into up to N + 1 calls, on the component least able to take them.',
  'retry budget': 'A cap on retries as a share of calls (here 10%), so retries cannot snowball.',
  backoff: 'Waiting longer before each retry (with jitter), so retries spread out instead of arriving together.',
  'circuit breaker': 'Stops calling a dependency that keeps failing, for a while, then lets a few probes through to see if it recovered.',
  fallback: 'A degraded answer served instead of failing — a cached page, a default — while the real one is unavailable.',
  bulkhead: 'A separate share of threads per dependency, so one slow dependency cannot take all of them.',
  threads: 'In thread-per-request servers, each request in flight holds a thread, waiting on its calls included.',
  'rate limit': 'A cap on requests a second; past it, requests get HTTP 429 instead of service.',
  'token bucket': 'A rate limiter that allows bursts: tokens refill at the rate, each request spends one.',
  replica: 'A copy of a database that follows the primary. It serves reads, and can be promoted if the primary dies.',
  'replication lag': 'How far a replica is behind its primary. Reads there miss the latest writes; a failover loses them.',
  failover: 'Moving traffic from a failed component to a standby — for a database, promoting a replica.',
  shard: 'A horizontal partition of the data: each shard holds part of the keys and serves them on its own.',
  'hot key': 'One key with a large share of the traffic. It lands on one shard or partition, which saturates while the others idle.',
  partition: 'A slice of a stream or table. A stream subscriber can run at most one consumer per partition.',
  'network partition': 'The network between two parts of a system fails while both keep running, each unable to reach the other.',
  'cache hit rate': 'The share of reads a cache answers itself; the misses go on to the origin.',
  'cold cache': 'A cache that restarted empty. Until it refills, its misses stampede the origin.',
  'write-behind': 'A cache that acknowledges writes and flushes them later: fast, but writes are lost if it dies first.',
  CDN: 'Content delivery network: caches near the users answer what they can; the rest goes to the origin.',
  origin: 'The system behind a cache or CDN that answers its misses.',
  'cold start': 'The time a new serverless instance (or container) takes before its first request: loading the runtime and code.',
  'provisioned concurrency': 'Serverless instances kept warm ahead of demand, so they start no cold; billed by the hour, used or not.',
  autoscaling: 'Adding instances when load rises and removing them when it falls. New ones serve only after their warm-up.',
  'warm-up': 'How long a new instance takes before it serves: booting, starting the runtime, filling caches.',
  'availability zone': 'An isolated data centre within a region. Spreading over zones survives losing one.',
  TTL: 'Time to live: how long a cached answer (a DNS record, a cache entry) is kept before it is asked for again.',
  'health check': 'A periodic probe that marks a target down after a few failures, so traffic is routed away from it.',
  'fan-out': 'One request calling many others — every partition, every follower’s timeline. It waits for the slowest.',
  'scatter-gather': 'Sending a request to many partitions in parallel and waiting for all of them; the slowest sets the latency.',
  idempotency: 'Doing an operation twice has the same effect as once — what makes retrying a payment safe.',
  'CFS throttling': 'Linux CPU limits (Kubernetes limits) cut a container off for the rest of each 100 ms period once it used its quota, adding stalls to its latency.',
  'back-pressure': 'A slow consumer signalling upstream to slow down, instead of letting queues grow without bound.',
  'Little’s law': 'Requests in flight = arrival rate × time each spends. It links concurrency, throughput and latency.',
  'prefix limit': 'S3 takes 5,500 reads or 3,500 writes a second per key prefix; a hot prefix gets 503 SlowDown.',
  'stale DNS answer': 'A client still using a cached DNS answer that points at a target which has since died.',
  'refresh interval': 'How often a search index makes new writes searchable (1 s by default). Until the next refresh, searches miss them.',
  recall: 'The share of the true nearest neighbours an approximate search returns. 0.99 walks far more of the index than 0.95.',
  ANN: 'Approximate nearest neighbour search: finding similar vectors fast by giving up a little recall instead of comparing them all.',
  HNSW: 'Hierarchical navigable small world: the graph most vector databases search. Fast while it fits in memory, slow from disk.',
  'cold storage': 'Archive tiers (S3 Glacier) that cost pennies a GB to keep and are slow, and priced, to read back.',
  restore: 'Bringing an archived object back from Glacier Flexible Retrieval: minutes to hours, paid for per request and per GB.',
  'edge function': 'Small code that runs at the CDN’s edge before the origin (CloudFront Functions, Cloudflare Workers), near the user.',
  'CPU limit': 'The CPU time an edge function may use per request (about 1 ms on CloudFront Functions, 10 ms on Workers Free); past it, it is killed.',
};

const TERMS = Object.keys(GLOSSARY).sort((a, b) => b.length - a.length);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PATTERN = new RegExp(`(?<![\\w-])(${TERMS.map(escape).join('|')})(?![\\w-])`, 'gi');

/** a text split around its glossary terms: strings, and { term, def } for the first use of each */
export function withTerms(text: string): (string | { term: string; def: string })[] {
  const seen = new Set<string>();
  const out: (string | { term: string; def: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(PATTERN)) {
    const key = TERMS.find((t) => t.toLowerCase() === m[0].toLowerCase())!;
    if (seen.has(key)) continue;
    seen.add(key);
    if (m.index! > last) out.push(text.slice(last, m.index));
    out.push({ term: m[0], def: GLOSSARY[key] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
