# Simulation engines

Bottleneck has two engines with the same inputs (an architecture graph + traffic + scripted
actions) and different jobs:

| | **fluid** (`src/sim/engine.ts`) | **discrete-event** (`src/sim/des/des.ts`) |
|---|---|---|
| unit | request *volume* per 50 ms tick | every individual request |
| speed | ~1 ms per simulated second | ~2 M events/s (≈ 0.1–0.5 s per simulated minute at 1–3 k req/s) |
| latency | mean + estimated p99 (mean × 1.8) | real p50/p90/p99/p99.9 from histograms |
| feedback loops | approximated from last tick's failure rate | emergent (retries, timeouts, breakers act per request) |
| randomness | optional jitter | seeded PRNG, Monte Carlo across seeds |
| used by | the live app, lessons, studio, optimizer search, breaking point | Analysis panel, `analyze`, optimizer verification, CLI/MCP `--engine des` |

Both are directional models — excellent for comparing designs, finding bottlenecks and teaching;
not a replacement for load testing a real system. Calibrate with per-component `capacity`,
`latencyMs` and `costPerHour` when modelling real infrastructure.

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

**Reads and writes.** `readRatio` (scenario/sandbox) splits traffic. Databases keep writes on the
primary and share reads evenly between the primary and live replica children.

**Failover.** A dead primary with live replicas *elects* for `failoverS` (default 3 s): writes fail,
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
   - **retries**: forwarded volume × amplification, from last tick's failure rate `f`:
     immediate `Σₖ fᵏ (k = 0…R)`; backoff `1 + 0.3 × (Σ − 1)` (spread over time);
     budget `min(Σ, 1.1)` (≤ 10 % extra load).
   - **routing**: `split` (even), `fanout` (every child gets the full volume), `failover`
     (children in order; what one failed last tick spills to the next).
4. **Backward pass** (reverse topological order) — aggregate the children per routing mode
   (split: flow-weighted mean; fanout: product of successes, max latency; failover:
   `1 − Π(1 − sᵢ)`), apply the caller **deadline** (responses later than `timeoutMs` count as failures,
   with a smooth ramp from 0.8× to 1.2× the deadline), then retries' effect on success
   (`1 − f^(R+1)`, budget-limited), then the breaker, then the kind's `Behavior.fold()`:
   - own latency = `base / (1 − ρ)` (ρ capped at 0.95) + queue wait.
5. **Global**: error rate from client success; p99 ≈ mean × 1.8, and once errors reach 1 % it is at
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
| `failoverS` | 3 | election time; `null` disables failover |
| `coldStartMs` | 400 | generic cold start (runtimes override: Rust 40 … Java 1800) |
| `hopMs` | 0.3 | one-way network latency per call |
| `maxEvents` | 60 M | safety valve |

### Validation

- **Refactor parity (fluid).** The component/behaviour refactor was checked against a baseline of
  all six comparison scenarios (error, p99, cost on both sides every 5 s, jitter off): 0 mismatches.
- **Overload agreement.** Web-shop spec (4 × S API, M DB): at 1,200 req/s the DES gives 14.0 % errors,
  the fluid engine 12.8 %.
- **Near saturation the engines differ on purpose.** At 900 req/s (90 % utilised) the fluid engine's
  single-server approximation gives p99 ≈ 450 ms; the DES, modelling the real 24-worker pool, gives
  p99 ≈ 98 ms. Large pools queue far less until right at saturation (M/M/c vs M/M/1). Prefer the DES
  for latency claims.
- **Metastable failure emerges.** 700 req/s with a 6 s spike to 1,600, client timeout 1 s, API queue 3 s:

  | client | errors during spike | errors 20–30 s | errors 50–60 s |
  |---|---|---|---|
  | no retries | 64 % | 59 % (stale queue draining) | 0 % |
  | 3 immediate retries | 58 % | **100 %** | **100 % — never recovers** |
  | 3 retries + backoff | 50 % | 100 % | 100 % |
  | retry budget | 63 % | 68 % | 0 % |
  | immediate + 0.3 s queue | 37 % | 0 % | 0 % |

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
  calling downstream). `faultLatencyMs`: added to every request's service time; in the DES this holds
  workers longer, so throughput falls with it; the fluid engine applies the same capacity factor
  `base ÷ (base + fault)`.
- **Link latency** — a connection's `latencyMs` is added to every call over it (DES: on the request
  hop; fluid: to the child's latency in the backward pass).

### Limitations (both engines)

- No network partitions, slow dependencies other than via `degrade`, or memory/GC modelling.
- Load balancing is perfectly even (no hot instances); caches have a fixed hit rate (no cold cache /
  stampede dynamics yet); queues are single FIFO with unlimited consumers' patience.
- Numbers are illustrative defaults (see catalog.md) — calibrate for real-system claims.
- The fluid engine's single-server latency term (`base / (1 − ρ)`) is very pessimistic for pools with
  long service times (GPU inference at 1.2 s): above ~80 % utilisation it can report tens of seconds
  where the DES (modelling the real pool) reports a few. Size such pools for ≤ 70 % or use the DES.
- Fan-out: the DES issues N parallel calls and waits for all (exact max-of-N). The fluid engine
  multiplies load by N, success by `s^N`, and latency by `1 + 0.6·√(2 ln N)` plus the probability that
  any partition stalls (`1 − (1 − p)^N`) × stall duration.
- Stalls: the DES adds `stallMs` to a request with probability `stallRate`; the fluid engine adds the
  expected value to mean latency, so fluid percentiles understate stall tails — use the DES for them.
- Failover routing tries live children first, then the cheapest (pay-per-request services such as LLM
  APIs and serverless last), then connection order — "self-hosted first, paid API as overflow".
