# Calibration — how a model is fitted from real telemetry

`bottleneck calibrate` (and the app, when you drop files on the Backtest tab) turns a dataset —
metrics, traces and a bill on one time grid — into a model of the system: what each component costs,
how much load it can take, how its latency grows with load, and how each endpoint's requests travel
through it. The model is then replayed over the same history and compared with what was measured,
so every number it uses comes with a statement of how well it explains the data.

This page describes every step, every rule, and where each rule came from. Most of the rules were
added because a recording of a real system broke a prediction; those are marked **Learned from** with
the reference system that taught it ([reference/README.md](../reference/README.md)).

Code: `src/backtest/import/` (data in), `src/backtest/calibrate.ts` (the fit),
`src/backtest/engine.ts` (the replay), `src/backtest/accuracy.ts` (checks).

---

## 1. The dataset

Everything is placed on one time grid (`step`, the metrics' own resolution by default). Each bucket
holds, per service and per endpoint, whatever the sources provided:

| series | per | from |
|---|---|---|
| `rps` | service, endpoint | request metrics, or traces (divided by the sampling rate) |
| `doneRps` | service | traces: requests *finishing* in the bucket (span end times) |
| `errorRate`, `p50Ms`, `p95Ms`, `p99Ms`, `meanMs` | service, endpoint | request metrics or traces |
| `selfMeanMs`, `selfP99Ms` | service | traces: time spent in the service itself, children excluded |
| `cpuCores`, `cpuLimitCores`, `replicas`, `memoryBytes`, `netTxBps`, `netRxBps` | service | container / instance metrics |

Missing values stay missing (`null`), never zero: a gap in a scrape is not a quiet minute.

Sources are matched by name. `rename:` in the manifest maps raw names (a pod prefix, a CloudWatch
dimension) to one service id for all sources. Endpoint ids from different sources are matched
loosely: `frontend GET /api/cart`, `frontend HTTP GET /api/cart/` and `frontend GET /api/cart?x=1`
are the same endpoint, and path parameters spelled `{id}`, `[id]` or `:id` are treated alike.

## 2. Traces → topology

Traces (OTLP JSON lines from the collector's file exporter, one OTLP document, or Jaeger JSON) are
folded into *visits*: one service handling one call.

- A visit starts at a SERVER or CONSUMER span, at a span whose service differs from its parent's, or
  at a CLIENT span to something that isn't instrumented — a database, cache or queue. That dependency
  becomes a **virtual service** named from `peer.service`, `db.system` / `db.system.name` or
  `messaging.system`, and gets its kind (db, cache, queue) from those attributes.
- Every other span belongs to the visit above it. **Self time** = the visit's duration minus the time
  covered by its child visits (interval union, so parallel calls are not double-subtracted).
- The **critical path** through each trace is walked back from the end: how many milliseconds of the
  end-to-end latency each service owns. This, not the call count, is how much a slower service slows
  an endpoint.
- Per endpoint: which services it visits and how many times per request (`visits`), the call graph
  (`calls`), the critical-path milliseconds per service, payload sizes per hop (`bytes`, from
  `http.request/response.body.size`, `rpc.*.size` and similar attributes), its error rate and latency.
- **Endpoint names.** The root span's route template names the endpoint. When the root span only
  says `GET`, the template is taken from a framework span inside the visit (`http.route`, Next.js's
  "executing api route (pages) /api/products/[productId]"); failing that, the request path with
  ids replaced (numbers, UUIDs, hex, opaque codes with digits → `{id}`).
- **Framework SERVER spans** inside the same service (Next.js, some Spring setups) are part of the
  visit already open, not new visits. **Learned from** the Astronomy Shop: Next.js wraps each request
  in two SERVER spans.
- **Background roots** (timers, DNS lookups at start-up, anything with no incoming request) are
  skipped: they are not requests anyone made.
- `ignore:` drops services outside the system (load generators, synthetic monitors).

### Corrections applied after import

- **Double-counted rates.** Span metrics count SERVER spans. Where traces show more than one SERVER
  span per visit, the metric request rate is divided by that ratio (recorded in
  `topology.rateCorrected`). **Learned from** the Astronomy Shop: the frontend's rate read double and
  its CPU per request half.
- **Sampling drift.** A probabilistic sampler doesn't keep exactly its setting. Where request metrics
  count the same requests the traces saw, the real share is measured (`topology.samplingCheck`) and
  every rate that only traces provide is rescaled by it. **Learned from** HotROD: a 20% sampler kept
  20.7%.

## 3. Per service

### CPU per request

Least squares over the buckets: CPU cores per replica = `base` + `perReq` × req/s per replica. The
fit's R² and the slope's standard error are kept. R² under 0.3 adds the note *"CPU barely follows
load — capacity is not CPU-bound or CPU data is noisy"*.

### CPU quota throttling

Kubernetes enforces a CPU limit as a quota per 100 ms CFS period. A runtime that does its work on
one thread (Node.js), or that bursts across several, uses its quota early in a period and waits out
the rest. It stops keeping up well before its average CPU reaches the limit. In the Kubernetes
reference, a Node.js frontend at half a core broke at 79% of its limit in a load test, and lower
under real traffic.

Where the history has `cpuThrottled` (throttled periods / periods), calibration fits
`ln(throttled share) = a + b × (CPU / limit)` over the buckets with some throttling and none
saturated. It needs at least 12 buckets, b > 0 and R² ≥ 0.3. The **knee** is where the curve
reaches 25%, the threshold of kube-prometheus's `CPUThrottlingHigh` alert. CPU-bound capacity is
then `(limit × knee − base) / perReq` instead of `(limit − base) / perReq`, and resizing the limit
keeps the knee.

Two guards:

- **Failing while throttled:** if the service failed while throttled past the threshold (errors
  ≥ 1% or p99 at half the client timeout), the throttled capacity also caps one read from latency.
  A load-test step holds for a minute what hours of traffic can't. The latency fit is then scored
  only on the loads the capped capacity can sustain.
- **Healthy while throttled:** if the history shows it throttled past the threshold for 3+ buckets
  with its latency within 2× of normal and no errors, the quota does not limit it: no knee.

### Self time at low load

The median self time (mean and p99) over the 30% least-loaded buckets: what a request costs when
nothing queues.

### Capacity — what limits a replica

Several explanations are *replayed through the measured history* (a fluid queue with 5-second
sub-steps: when demand exceeds capacity a backlog builds and drains) and scored by how well they
reproduce the measured self time bucket by bucket (squared log error):

| explanation | what it means | fitted |
|---|---|---|
| **none** | load never came near a limit | — |
| **CPU-bound** | the CPU limit is reached at the fitted CPU per request | capacity = (limit − base) / perReq; servers = cores |
| **free queue** | an M/M/c queue — a worker pool, an async runtime | servers c (1…256), capacity K, variability |
| **tied queue** | a lock or connection pool: c holders each held for s ms, so K = c / s | c, the hold time s (the low-load self time already contains some waiting), variability |
| **seen at K** | what *finished* per second while the service was overloaded is its capacity | servers and hold time at that K |

The tied model is physically grounded, so the free one has to be clearly better (15%) to win.
**Learned from** HotROD: its simulated MySQL connection is a mutex — one holder, capacity = 1 / hold time.

**Variability.** Waits are `v ×` the M/M/c wait (Allen–Cunneen, Poisson arrivals: v = (1 + cs²)/2;
0.5 for constant service times, 1 for exponential, above 1 for heavy tails). v is fitted from
0.3 to 1.7. **Learned from** HotROD: with near-constant service times nothing queues until the very
edge; assuming exponential service overstated waits.

Then, in order of precedence:

1. **A manual override** (`model.services.<id>.perReplicaRps` in the manifest) wins.
2. **A knee in the history.** If users were timing out (≥ 5% errors with p99 at the deadline) *and*
   this service's own self time exploded (> 4× normal), the history brackets its limit:
   - *healthy* = the highest rate it was offered and finished, in a bucket where neither the bucket
     before nor **the bucket after** was overloaded — an overload takes time to build (a pool's
     backlog, a filling heap), so the last bucket before a collapse doesn't prove the rate was
     sustainable. Offered = the entry endpoints' request rate (completions can run above arrivals
     while a backlog drains). **Learned from** PetClinic: it held 260 req/s for twenty seconds,
     then collapsed; stepped up a minute at a time it broke at 213.
   - *broke* = the offered rate where it started to fail.
   - capacity = the midpoint, band = [healthy, broke].
   - **Metastable failure.** If, while overloaded, it finished far less than that (< 80% of
     capacity), that rate is kept as `overloadedRps`: once it tips over, it serves only that much
     until the backlog is gone, so it stays down after load returns to normal. **Learned from**
     PetClinic: collapsed after 256 req/s and kept failing while finishing about 140 req/s, until load fell
     to half of that five minutes later.
   - The limit is labelled **CPU** when the CPU read agrees (within 25%) **or when the CPU ran pinned
     at its limit while collapsed** — garbage collection and thrashing burn CPU, so more cores move
     the knee. A CPU resize then scales both capacity and `overloadedRps`. **Learned from**
     PetClinic: broke at 43% CPU, collapsed at 1.92 of 2 cores; 4 cores predicted 487 req/s,
     measured 470.
   - Only the service whose own time exploded gets a knee — not the database it waits on.
3. **CPU reached its limit** (≥ 90%) in the history: the capacity is read from the CPU directly —
   the most that finished while pinned, the requests per CPU-second in the busiest 15% of buckets
   scaled to the limit, or, when users were already timing out while pinned, what it could still
   finish. Taken when the latency fit claims more than that, because then **the queue sits outside
   the spans**: an event loop too busy to accept a request starts no span, so self time stays flat
   while clients wait seconds. **Learned from** the Astronomy Shop: the Node.js frontend at 100% CPU
   showed 18 ms of self time while users waited 2 s. For such services the steepness of the hidden
   queue (`loadExponent` 1–4) is read from end-to-end latency instead.
4. **The queue fit** explains self time clearly better (15%) than *none* or *CPU*: concurrency-bound
   (or CPU-bound, if its capacity matches the CPU read within 25%).
5. **The CPU fit** explains it as well as *none*: CPU-bound.
6. **Load never came close**: the CPU limit is the only limit known — CPU-bound, noted as
   *extrapolated*.

### Long histories

Over 1,000 buckets, the capacity fits (and the bootstrap behind the band) run on a compact copy of
the history (`compactFit`):
- the busiest episodes, busiest first, up to ~750 buckets. An episode is the stretches at ≥ 70%
  of the service's peak load, or with its own time ≥ 2× the quiet one, with the 3 buckets before
  and the 15 after, where a backlog drains;
- an even sample of 250 of everything else.

The limit shows near the peaks, and a fortnight of similar afternoons repeats what one of them
says. Fit quality (the replay error that sets good / fair / poor) is still measured on the whole
history. On HotROD tiled to 20,250 buckets the fitted numbers are identical, and calibration takes
46 s instead of about 7 minutes.

### Capacity bands

Every capacity carries a 10th–90th percentile band and 40 samples that the backtest draws from:

- a **knee**: uniform between healthy and broke;
- **seen at saturation**: narrow, widened by how well CPU per request is known;
- **CPU only** (never near the limit): from the CPU slope ± its standard error;
- **queue fits**: a block bootstrap of the history (blocks of 6 buckets) with servers and
  variability refitted per draw — with little load near the limit they trade off against capacity,
  and the band has to show that;
- **extrapolation disagreement**: when the history never passed 85% of the fitted capacity and CPU
  and latency read the limit more than 10% apart, the band spans both and the point estimate is
  their geometric mean — neither read is more trustworthy that far from the data.

### Latency tail

The p99 = self p99 + queueing excess × `tail`; `tail` (0.5–6) is fitted on the measured self p99s.

### Hosted dependencies

`model.hostedBy: { redis: driver }` says an in-process dependency (seen as its own service in
traces) runs inside another: it shares that service's replicas, CPU and bill, and can't be scaled on
its own. **Learned from** HotROD: its "mysql" and "redis" are simulated inside customer and driver.

## 4. Cost from the bill

From the AWS Cost and Usage Report (legacy or 2.0 columns) or the GCP billing export, line items are
attributed to components by a cost-allocation tag (`tag: user:service`), by resource id
(`resources: { "db-7XK2": orders-db }`), or by name. Then, per component:

- **$ per replica-hour** = compute spend / replica-hours actually run inside the bill window
  (from the replica series);
- **$ per request** = request-billed spend / requests;
- storage and other fixed lines, and spend no component explains, become a fixed $/hour —
  shown, not hidden;
- **egress** bytes per request from the bill's data-transfer line;
- for resizes and Graviton moves: the price's CPU/memory split (80/20 unless set) and the architecture
  (x86 unless `model.services.<id>.arch: arm` is set in the manifest).

Data transfer between components is priced from their placement (`placement:` zone and region) at
AWS rates: same zone free, cross-zone $0.01/GB each way, cross-region $0.02/GB, internet $0.09/GB.

## 5. Per endpoint

- **Critical-path weights**: how many of each service's self-milliseconds land on this endpoint's
  path.
- **Overhead**: measured mean at low traffic minus the path — network, proxies, serialization.
- **Baseline errors**: request-weighted over the low-traffic buckets (a median would read 0 for rare
  errors).
- **Errors that grow with load**: a line through the buckets that weren't overloaded (rate limits,
  timeouts inside, contention), kept when the slope is clearly positive. **Learned from** HotROD: its
  driver fails more lookups as traffic rises, so a second customer replica fixes latency but not the
  breaking point — the stress test then measured exactly that.
- **Latency shape**: with a median known, latency is **lognormal through (p50, p99)**; a global p99
  across endpoints is a quantile of the traffic-weighted mixture. **Learned from** the Astronomy Shop:
  "mostly 3 ms, rarely 300 ms" — an exponential tail overstated the mix by 30%; lognormal brought it
  to 9%.
- **Tail**: fitted on **everyday buckets** (within the SLO) by replaying the whole model — overloads
  are capacity's business, and their p99s would drag the multiplier up for every ordinary minute.
- **Own SLO**: `model.endpoints.<id>.slo` in the manifest; others use the system SLO.

## 6. Fit quality — what the model can't explain is flagged

The whole history is replayed through the model and compared with what was measured:

| status | mean absolute error |
|---|---|
| **good** | < 15% |
| **fair** | < 30% |
| **poor** | < 60% |
| **unexplained** | ≥ 60%, or nothing to check against |
| **cost only** | in the bill or container metrics but never in traces or request metrics |

Services are checked on self time, endpoints on p99. Each component also carries plain-English notes:
how its capacity was read, what limited it, whether it was extrapolated. They show in the app
(Backtest → Model tab, and on every node when a moment is opened on the board), in
`bottleneck calibrate` output, and in every report.

## 7. Accuracy

Two kinds of check travel with the model (`model.accuracy`) into the app, the CLI
(`bottleneck accuracy model.json`) and every report:

- **Holdout** (`--holdout 0.3`): calibrated on the first 70% of the requests, the last 30% predicted
  (split by requests, not by time, so a quiet week with one busy hour isn't judged on its empty
  nights) — p99 over every
  request, cost against the bill sliced to that window, and how often the measurement fell inside the
  model's 10–90% band.
- **Against recorded runs** (the reference systems): the run with a change really applied, and
  stepped load tests.
  - **p99**: over every request of the run (from the load generator's request log), predicted vs
    measured. The typical and worst error over 5-minute windows is reported too.
  - **breaking point**: for each plateau of a step test, the SLO score (the larger of p99 / SLO and
    error rate / SLO) over every request in the plateau's second half; the breaking point is where the
    score first crosses 1 for good, interpolated log-linearly between plateaus. The prediction is
    scored the same way.
  - **cost**: predicted vs the run's bill.

Targets: p99 within 20%, breaking point within 15%, cost within 10%. Current results:
[reference/README.md](../reference/README.md#results).

## 8. Limits

- A limit the history never approached is an extrapolation; the band says how wide. A history with
  one overload in it is worth more than a month of quiet days.
- Cold starts (JIT warm-up, empty caches after a deploy) are not modelled for the backtest.
- Errors that are not load-related (bad deploys, bugs) are a baseline rate, not predicted.
- CPU per request is linear in load. On 4 cores PetClinic's CPU per request rose from 4.1 to 5.9 ms
  as load grew; the model doesn't see that from a 2-core history, and leaves it to the band.
- Per-5-minute p99 of a garbage-collected runtime swings 5× at the same load; the model predicts the
  distribution, not which window a pause lands in.
