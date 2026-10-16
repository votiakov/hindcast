# Simulation engines

Hindcast has two engines with the same inputs (an architecture graph + traffic + scripted
actions) and different jobs:

| | **fluid** (`engine-rs/src/sim/engine.rs`) | **discrete-event** (`engine-rs/src/sim/des.rs`) |
|---|---|---|
| unit | request *volume* per 50 ms tick | every individual request |
| speed | ~1 ms per simulated second | ~2 M events/s (≈ 0.1–0.5 s per simulated minute at 1–3 k req/s) |
| latency | mean + p99 from each component's latency mixture (M/M/c waits, lognormal service) | real p50/p90/p99/p99.9 from histograms |
| feedback loops | approximated from last tick's failure rate | emergent (retries, timeouts, breakers act per request) |
| randomness | optional jitter | seeded PRNG, Monte Carlo across seeds |
| used by | the live app, lessons, studio, optimizer search, breaking point | Analysis panel, `analyze`, optimizer verification, CLI/MCP `--engine des` |

Both are written in Rust; the app runs them as WebAssembly (`src/sim/engine.ts` and
`src/sim/des/` are the browser-side wrappers), the CLI and MCP server as one native binary.

Both model routing (split / fan-out / failover), retries (immediate / backoff / budget), deadlines,
circuit breakers with fallback, bounded queues, DB failover to replicas, zones, language runtimes,
serverless cold starts, GPU inference and hosted LLM APIs, target-tracking autoscaling with warm-up,
cache warmth, injected errors and latency, and network latency per link. The test suite checks that
the two engines agree where they should.

Both are directional models — excellent for comparing designs, finding bottlenecks and teaching;
not a replacement for load testing a real system. Calibrate with per-component `capacity`,
`latencyMs` and `costPerHour` (or use `pricing: aws-us-east-1`) when modelling real infrastructure.

---

## Shared concepts

**Capacity.** Each component has a capacity in req/s:

```
capacity = base capacity (catalog or `capacity` override)
         × tier multiplier (S 1, M 2, L 4)          — sizable kinds
         × runtime throughput (Node 1, Go 2.5, …)   — server / worker / function
         × batching (×4)                             — llm with batching
         × reachable instances                       — scalable kinds
         × degraded factor                           — brownouts
```

gateway / llmapi / function use their `limit` instead (rate limit or max concurrency).

**Reachable instances.** A scalable node (server, worker, llm) only spreads load over all
instances when it is fed by an `lb`, `gateway` or `queue`; otherwise clients know one address and
only one instance gets traffic.

**Service time.** `baseLatencyOf` = catalog/override latency × runtime latency factor (+400 ms for
batching).

**Reads and writes.** `readRatio` (scenario/sandbox) splits traffic, and both engines follow each
class along the graph: only reads can hit a cache (its misses and every write go on to the origin,
so what reaches a database behind a cache is mostly writes); databases keep writes on the primary and
share reads evenly between the primary and live replica children. Success is tracked per class, so a
failure only writes see (an election, a cache with no origin) is not retried away by reads' success.
A write-behind cache (`writePolicy: behind`) answers writes itself and flushes them ~5 s later; a
cache that dies takes the unflushed ones with it (`lostWrites` in the results).

**Failover.** A dead primary with live replicas *elects* for its `failoverS` (default 60 s, as RDS
Multi-AZ's 60–120 s; see catalog.md): writes fail,
reads keep working on replicas. Then the first replica is *promoted*: it takes writes plus its share
of reads, and the dead primary only forwards (shown as "failed over").

**Cost.** Fixed `$/h = costPerHour × tier cost (S 1, M 2.2, L 4.8) × instances`, plus usage: serverless
`requests × fnCostPerRequest` (flat $0.60/M, or memory × duration × Lambda-like price when a runtime is
set) and LLM APIs `successful requests × $0.002`.

---

## Fluid engine

Every tick (`dt` = 50 ms of simulated time):

1. **Topological order** of the graph (Kahn's algorithm; nodes in cycles are appended).
2. **Forward pass** — clients emit `traffic × dt`; each node's `Behavior.process()` absorbs its
   arrivals and decides what to forward:
   - `queueStage`: arrivals join a bounded FIFO in front of `capacity × dt`; work beyond
     `queueS × capacity` (default 1 s) is shed and counts as failed.
   - cache/cdn answer `hitRate` locally and forward misses (no origin → misses fail).
   - lb/gateway route only to healthy children; gateway sheds above its rate limit (429s).
   - db splits reads to replicas, runs the failover state machine.
   - queue: producers succeed on enqueue; the backlog drains at the consumers' combined capacity.
   - function: concurrency limit, warm pool that grows with demand (τ 4 s up, 1 s down), cold starts.
   - llmapi: provider rate limit; latency doesn't grow with your load.
3. **Generic caller layer** (any node with children), applied after `process()`:
   - **breaker**: closed → open when last tick's downstream attempt failure > 50 % for ≥ 1 s;
     open lets 2 % through for 5 s; half-open lets 20 % through; closes when failure < 10 %.
     Blocked calls fail fast or, with `fallback`, succeed with a degraded response.
   - **retries**: forwarded volume × amplification, from the failure rate `f` of the attempts whose
     retries go out now (sent a failed attempt's time earlier: the deadline for a late one, at once for a rejection):
     immediate and backoff `Σₖ fᵏ (k = 0…R)` (backoff delays a retry, it does not skip it: over any
     stretch longer than the delays it sends as many attempts); budget `min(Σ, 1.1)` (≤ 10 % extra
     load). A retry costs the failed attempt's time plus, with backoff, the DES's mean wait
     (`50 ms × 2ᵏ`, capped at 2 s).
   - **routing**: `split` (even), `fanout` (every child gets the full volume), `failover`
     (children in order; what one failed last tick spills to the next).
4. **Backward pass** (reverse topological order) — aggregate the children per routing mode
   (split: flow-weighted mean; fanout: product of successes, max latency; failover:
   `1 − Π(1 − sᵢ)`), apply the caller **deadline** (responses later than `timeoutMs` count as failures,
   judged branch by branch: each child's answers are a small latency mixture, so a fast branch's answers
   are on time and a slow one's are late), then retries' effect on success
   (`1 − f^(R+1)`, budget-limited), then the breaker, then the kind's `Behavior.fold()`:
   - own latency = service time + the M/M/c wait of a pool of capacity × service-time workers (as the
     DES runs it), scaled for lognormal service (Allen–Cunneen, cv 0.6) + backlog past saturation;
   - each answer's latency is kept as a mixture of up to eight (weight, mean, spread) parts — a cache's
     hits and misses, a fast and a slow branch, answers that needed k retries (a share ∝ fᵏ, later by
     k failed attempts and, with backoff, k waits) — combined down the call graph;
   - a failure takes the time it took: at once when shed, the component's own time when it fails a
     request itself (`inject-errors`, as the DES fails it at the end of the work), the deadline when late.
5. **Global**: error rate from client success; p99 from the users' latency mixture, and once errors reach 1 % it is at
   least the timeout (failed requests count as timeouts); cost; 0.25 s history samples.

All rates are smoothed with an exponential moving average (τ ≈ 0.3–0.6 s) so visuals don't flicker.

**Adding a kind:** add it to `Kind` and `KINDS` in `catalog.ts` (numbers, flags), add a behaviour in
`components/behaviors.ts` (or reuse `compute`) and register it in `components/index.ts`, add an
icon in `canvas/icons.tsx`, colours in `theme/themes.ts`, and (if it has new knobs) controls in
`canvas/NodeControls.tsx` and fields in `spec/schema.ts`.

---

## Discrete-event engine

### Model

- **Clock and events.** A binary heap keyed by (time, sequence). Events are closures. One simulated
  second ≈ (requests × hops × 2) events.
- **Arrivals.** Each client generates a Poisson process whose rate follows the scenario's traffic
  curve (exact thinning in 250 ms horizons). Each request is a read with probability `readRatio`.
- **Components as worker pools.** Little's law turns a component into `workers` parallel servers:

  ```
  workers      = round(capacity × baseLatency)          (≥ 1)
  service mean = workers / capacity                     (keeps total capacity exact)
  service time ~ LogNormal(mean, cv = 0.6)              (long tail; cv configurable)
  ```

  e.g. an S API server (250 req/s, 25 ms) ×4 instances behind a LB → 24 workers. A bounded FIFO
  queue holds up to `capacity × queueS` requests; arrivals beyond it are rejected, and requests that
  waited longer than `queueS` are shed when dequeued.
- **Kinds.** gateway/llmapi: token-bucket rate limiter (429 → fast failure); llmapi has unlimited
  provider capacity with log-normal latency around its base; function: pool sized by its concurrency
  limit, no queue (throttles), warm pool (an instance stays warm ~60 s) and cold starts per new
  instance; queue: backlog (≤ 200 k) with a pull model — a message is dispatched only when a
  consumer has a free worker; cache/cdn: hit with probability `hitRate`; db: per-request read/write
  routing to primary or replicas and the failover state machine.
- **Network hop**: 0.3 ms per call.
- **Callers** (any node with children, including clients), per call:
  1. **Breaker** — outcomes are tallied per 1 s window; ≥ 10 calls with > 50 % failures opens it for
     5 s; half-open admits 10 % probes; < 10 % failures closes it, > 50 % re-opens. Short-circuited calls
     fail in 1 ms or return the fallback.
  2. **Attempt with deadline** — if `timeoutMs` is set, the attempt is abandoned at the deadline
     (the callee keeps working — *wasted work*, the root of metastable failures).
  3. **Retries** — immediate (1 ms), backoff (`50 ms × 2ᵏ`, capped at 2 s, ×0.5–1.5 jitter) or budget
     (token bucket: +0.1 token per call, ≤ 20 tokens, one per retry).
  4. **Routing** — split (uniform random child), fanout (all, wait for all), failover (in order).
- **Metrics** — every 1 s window: user request rate, error rate, p50/p99 of successful requests
  (log-bucketed histogram, ≈ 2.5 % precision), per-component utilisation (busy-time / workers),
  drops, retry amplification (attempts/calls), late responses, breaker state, cost.
  Run totals: p50/p90/p99/p99.9 over all successful requests, mean/peak error, time in SLO.
- **Determinism** — same spec + scenario + seed → identical result (also across worker threads).

### Configuration (`DesConfig`)

| key | default | meaning |
|---|---|---|
| `seed` | 1 | PRNG seed |
| `serviceCv` | 0.6 | service-time variability (0 = deterministic) |
| `queueS` | 1 | default bounded queue length, seconds of work |
| `failoverS` | 60 | election time for databases without their own `failoverS`; `null` disables failover |
| `coldStartMs` | 400 | generic cold start (runtimes override: Rust 40 … Java 1800) |
| `hopMs` | 0.3 | one-way network latency per call |
| `maxEvents` | 60 M | safety valve |

### Validation

- **Refactor parity (fluid).** The component/behaviour refactor was checked against a baseline of
  all six comparison scenarios (error, p99, cost on both sides every 5 s, jitter off): 0 mismatches.
- **Near saturation.** At 900 req/s (90 % utilised) the fluid engine gives p99 ≈ 99 ms and the DES
  98 ms; at 1,200 req/s both give 14.8 % errors. Across 200 generated boards the two engines' error
  rates agree within 5 points on 199 (`scripts/engine-crosscheck.ts`; test/sandbox.test.ts checks the
  core cases on every change). The one left is a worker loaded to exactly its capacity, where the DES
  itself has no steady state (29–45% failed depending on the seed) and the fluid engine holds 14.3%.
  Latency is compared too: on the 98 boards both engines serve healthily (under 5% errors, no
  component at ≥ 97% load), the fluid p50 and p99 of answers fall inside the DES's five-seed range
  ±25% + 5 ms on 97. The one outside is a cold-start cascade the per-tick fluid model can't stagger.
  A third set of 100 boards exercises retries under failure: each retrying caller gets a policy
  (immediate, backoff or budget), the users often a deadline and retries, one component fails 3% or
  20% of its answers and another runs at 30% of its capacity for 10 s. Error rates agree within 5
  points on all 100; latency on 50 of the 52 healthy ones. Outside: a function cold-start cascade (as
  above, there without retries or faults too) and two stacked layers of retries with backoff, where
  the fluid engine carries a failed call's time as a mean without its own spread.
  The summary p99s are not the same quantity: the fluid one counts failures as timeouts once they pass
  1%, the DES's is of successful answers only (see [What "p99" means](#what-p99-means-in-each-engine)).
- **Metastable failure emerges.** 700 req/s with a 6 s spike to 1,600, client timeout 1 s, API queue 3 s:

  | client | errors during spike | errors 20–30 s | errors 50–60 s |
  |---|---|---|---|
  | no retries | 64 % | 59 % (stale queue draining) | 0 % |
  | 3 immediate retries | 58 % | **100 %** | **100 % — never recovers** |
  | 3 retries + backoff | 50 % | 100 % | 100 % |
  | retry budget | 63 % | 68 % | 0 % |
  | immediate + 0.3 s queue | 37 % | 0 % | 0 % |

### What "p99" means in each engine

The engines' default p99 figures are different quantities, and stay so until a decision is made on
one definition (changing either would move every p99 reported so far, validation included):

| field | fluid (`simulate`) | discrete-event (`simulate --engine des`) |
|---|---|---|
| `meanP99Ms`, `peakP99Ms` | mean and worst of the per-second p99; a second with ≥ 1 % failures reads as the timeout (`timeoutS`): **failures as timeouts** | mean and worst of the per-second p99 of that second's **successful answers** |
| `p99Ms` (DES only), p50/p90/p99.9 | — | the run's percentiles of successful answers; a request still waiting when the run ends counts with what it waited |
| `p99AnswersMs` | the run's p99 of successful answers (the answer mixtures pooled tick by tick, as `scripts/engine-crosscheck.ts` compares them) | the same number as `p99Ms` |
| `p99WithFailuresMs` | the run's p99 of every request, a failure at the time it took to fail: each tick's mean time to fail (a rejection at once, a call that failed downstream after what that took, a late one at its deadline), with no spread of its own | the run's p99 of every request, each failure at the time it actually took |

`p99AnswersMs` and `p99WithFailuresMs` are the ones to compare across engines. Either is left out
where it can't be computed (no successful answer; no request). The fluid engine's figure with
failures is a mean per tick, so where failures dominate and their times spread (a few fast
rejections, a few long timeouts) it reads lower than the DES's. Where they're printed, the CLI, the
audit reports and the app label each p99: "incl. failures" for the fluid engine's (failures as
timeouts), "answers" for successful answers only.

### Dynamics (both engines)

Shared code keeps the engines consistent (`src/sim/autoscale.ts`, `cacheWarmth` in `catalog.ts`):

- **Autoscaling** — every second the scaler wants `ceil(demand ÷ (per-instance capacity × targetUtil))`
  instances within `[min, max]`. Launched instances are billed immediately and serve after `warmupS`.
  Scale-in removes at most half the surplus per step, only after `cooldownS` without scaling activity.
  Instances killed by chaos are replaced (like an auto-scaling group replacing unhealthy hosts).
- **Cache warmth** — a cache that dies, restarts or is flushed comes back empty: effective hit rate =
  `hitRate × (1 − e^(−t / warmupS))`. The origin briefly sees nearly all traffic: the thundering herd.
  Fluid and DES agree on the resulting error spike within about one percentage point.
- **Gray failures** — `faultRate`: the component fails that share of the requests it handles (without
  calling downstream). `faultLatencyMs`: added to every request's latency. On a database, cache or any
  other kind it is work: in the DES it is added to the service time and holds a worker, so throughput
  falls with it; the fluid engine applies the same capacity factor `base ÷ (base + fault)`. On a
  server or worker it is a wait (on a call the model does not draw, a lock, a slow disk behind it): the
  DES frees the worker after the work and delays the answer, and the fluid engine leaves capacity
  alone. It costs capacity only through `threads` (below).
- **Slow dependencies hold threads, not workers** — a request waiting on its calls (or on its own
  injected wait) holds a thread only when the component has `threads` (thread-per-request: Tomcat,
  a Java or Rails server). Then the pool finishes at most `threads × instances ÷ hold time` requests a
  second (Little's law), the hold time being the work plus every call it waits on; the rest wait for a
  thread and are shed ("out of threads"). A `bulkhead` caps the calls that may wait on one dependency;
  past it a call fails at once, or with `bulkheadWaitMs` queues for a slot (DES: first come, first
  served, failing when the wait is up; fluid: while more calls are offered than the slots hold, the
  queue is never empty, so a call that gets a slot waited the whole wait and one that does not fails
  after it). The wait holds the caller's thread. Hand check (`bulkhead_wait_tests`): a caller with
  40 threads and a bulkhead of 10 calls a 2 s dependency and a fast one, 200 req/s split evenly. At
  once, 10 of the 200 slow calls in flight get a slot and the rest fail: 47 % of requests fail
  (fluid 47.3 %, DES 46.9 %) and the fast half is untouched. With a 1 s wait every slow call holds a
  thread about a second longer, the 40 threads run out, and the fast half fails too
  (fluid 82.4 %, DES 83.6 %). Asynchronous, the same wait costs nothing beyond the slow half.
  Without `threads` (async: Node, Go, Envoy) waiting holds nothing: a slow dependency adds its latency
  to the caller's answers, and fails requests only through deadlines (`timeoutMs`, which still
  trigger retries). Hand check: a caller of 2 × 150 req/s offered 200 req/s, whose dependency turns
  slow by 250 ms — without `threads` no request fails and the p99 rises by 250 ms in both engines;
  with `threads: 20` per instance, 40 threads held 25 + 25 + 250 ms = 0.3 s finish 133 req/s and a
  third of the requests fail (fluid 33.3 %, DES 33–34 %). `slow_dependency_tests` in both engines.
- **Link latency** — a connection's `latencyMs` is added to every call over it (DES: on the request
  hop; fluid: to the child's latency in the backward pass).

- **Shards and hot keys** — a sharded database is a pool of workers and a queue per shard. Each
  request lands on the hot key's shard with probability `hotKeyShare`, otherwise on one picked by
  hash (DES); the fluid engine runs the busiest shard and the rest as two queues. The utilisation the
  board shows is the busiest shard's.
- **Replication and partitions** — a `partition` between two zones cuts every link between their
  members (calls over it fail at once). An async replica cut off from its primary accumulates lag
  (one second per second; it catches up at 10× once healed); reads it serves meanwhile count as
  `staleReads`. When the primary dies the replica is promoted after the election, and the writes it
  lagged behind are `lostWrites`. A sync replica never lags, but the primary's writes fail while the
  replica is unreachable. During the election writes fail; reads are served by the replicas.

### Limitations (both engines)

- No slow dependencies other than via `degrade`/`inject-latency`, or memory/GC modelling.
- Load balancing across instances is perfectly even (hot spots are modelled only as a database's hot
  key); a cache does not know which keys are hot, so it lowers a hot shard's load in proportion to
  its hit rate; queues are single FIFO with unlimited consumers' patience.
- Numbers are illustrative defaults (see catalog.md) — calibrate for real-system claims.
- The fluid engine is deterministic: exactly at capacity (ρ = 1) it holds where the DES's random
  arrivals overflow. Treat anything above ~95 % utilised as failing, or use the DES.
- Fan-out: the DES issues N parallel calls and waits for all (exact max-of-N). The fluid engine
  multiplies load by N, success by `s^N`, and latency by `1 + 0.6·√(2 ln N)` plus the probability that
  any partition stalls (`1 − (1 − p)^N`) × stall duration.
- Stalls: the DES adds `stallMs` to a request with probability `stallRate`; the fluid engine adds the
  expected value to mean latency, so fluid percentiles understate stall tails — use the DES for them.
- Failover routing tries live children first, then the cheapest (pay-per-request services such as LLM
  APIs and serverless last), then connection order — "self-hosted first, paid API as overflow".
