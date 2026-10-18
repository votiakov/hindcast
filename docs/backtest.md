# Backtesting infrastructure changes on real data

Hindcast replays your real production history through a model calibrated from that history, with
a change applied — "what would have happened" — before the change ships. It works from files: metric
exports, traces and the cloud bill. Nothing connects to your systems.

```
hindcast export-prometheus --url http://prometheus:9090 --start 2026-09-01 --end 2026-09-15 --out telemetry
#   …add traces (OTLP JSON) and a bill (AWS CUR or GCP export) to telemetry/hindcast.import.yaml
hindcast import    telemetry/hindcast.import.yaml --out dataset.json
hindcast calibrate dataset.json --holdout 0.3 --out model.json
hindcast backtest  model.json dataset.json graviton.yaml autoscale.yaml --last 14d --html report.html
hindcast backtest  model.json dataset.json fewer-replicas.yaml --scale 2.2      # …on launch day
```

or open the app's **Backtest** tab (or go straight to `#backtest`). Drop the files (or a `dataset.json` + `model.json`)
on it.

With a Prometheus you can reach, one command does the export, import and calibration and ends on a
capacity review (its summary: risk, headroom, cost, the one change, how far to trust it):

```
hindcast quickstart --prometheus http://prometheus:9090 --jaeger http://jaeger:16686 [--last 7d]
```

It leaves `dataset.json` and `model.json` in `.hindcast/`, so `hindcast backtest .hindcast/model.json
.hindcast/dataset.json <strategy.yaml>` works on them next ([agents.md](agents.md#quickstart-one-command-a-capacity-review)).

Traces are optional there. With Prometheus alone, who calls whom comes from Istio or Linkerd
metrics, the OpenTelemetry service graph or span metrics' client spans, or from `--topology
calls.yaml`; self time is estimated as a service's latency less its calls'. Endpoints lose their own
paths (they share their service's), and a service with no latency metric gets its capacity from CPU
alone. The review's Trust line says which applied
([agents.md](agents.md#without-traces)).

## 1. Data in

An import manifest names the files and says what each series is.

```yaml
name: checkout
step: 1m                        # bucket size (default: the metrics' own resolution)
rename: { checkout-svc: checkout }   # raw names → service ids, for every source
metrics:
  - prometheus: metrics/rps.json       # GET /api/v1/query_range response
    metric: rps                        # rps errorRate p50Ms p95Ms p99Ms meanMs cpuCores cpuPercent
    by: service_name                   #   cpuLimitCores replicas netTxBps netRxBps memoryBytes
  - prometheus: metrics/p99.json
    metric: p99Ms
    by: service_name
    unit: s                            # s ms us percent ratio cores millicores rpm count-per-period
  - prometheus: metrics/endpoint-rps.json
    metric: rps
    by: service_name
    endpointBy: http_route             # endpoint-level series
    methodBy: http_request_method
  - cloudwatch: cw/getmetricdata.json  # aws cloudwatch get-metric-data output
    map:
      req: { service: api, metric: rps, unit: count-per-period }   # by Id or Label
      cpu: { service: api, metric: cpuPercent, scale: 2 }          # % of a 2-vCPU instance → cores
  - csv: metrics/long.csv              # timestamp,service,metric,value[,endpoint]
  - wide: grafana-export.csv           # time column + one column per series
    columns: { "api p99": { service: api, metric: p99Ms, unit: s } }
traces:
  - file: traces/*.jsonl               # OTLP JSON lines (collector file exporter) or Jaeger JSON
    sampling: 0.1                      # share of requests traced
    ignore: [loadgenerator]            # services outside the system
billing:
  - cur: bill/cur-2026-09.csv          # AWS CUR, legacy or 2.0 columns
    tag: user:service                  # cost-allocation tag naming the component
    resources: { "db-7XK2": orders-db }  # or resource id (substring) → component
  - gcp: bill/billing-export.jsonl     # Google Cloud billing export, CSV or JSON lines
    tag: app
placement:                             # for data-transfer pricing
  checkout: { zone: us-east-1a, region: us-east-1 }
  orders-db: { zone: us-east-1b, region: us-east-1 }
model:                                 # hints for calibration
  slo: { p99Ms: 400, errorRate: 0.01 }
  timeoutMs: 5000                      # client deadline: slower answers are failures
  hostedBy: { sqlite: checkout }       # in-process dependencies seen in traces
  endpoints:
    "checkout POST /orders": { slo: { p99Ms: 800, errorRate: 0.005 } }
```

`hindcast export-prometheus` writes the `metrics:` block for you. Presets: `otel-spanmetrics`
(OpenTelemetry Collector spanmetrics connector), `http-server` (OTel HTTP semantic-convention
histograms, with per-route series), `http-server-legacy` (the same under the pre-1.0 name,
`http_server_duration_milliseconds`), `spring` (Spring Boot / Micrometer `http_server_requests_seconds`,
per application, Actuator's own scrapes left out), `ingress-nginx` (requests, errors and latency at the edge, per
backend Service — they replace span-metric values for the same service), `istio` (Istio sidecar
metrics, per destination workload), `linkerd` (Linkerd proxy metrics, inbound, per workload),
`cadvisor` (Docker Compose labels), `kubernetes` (kubelet + kube-state-metrics, grouped by owning workload; requests stand in
for missing CPU limits). `--selector 'namespace="shop"'` scopes every query.

What each source gives the model:

| source | gives |
|---|---|
| request metrics | load per service and endpoint, latency and errors per bucket |
| CPU, limits, replicas | CPU per request, capacity per replica, replica-hours |
| traces | the topology; for every endpoint which services it visits and how often; the critical path (how many ms of each request each service owns); self time per service per bucket; payload sizes; uninstrumented databases, caches and queues as their own components (from `db.system`, `messaging.system`, `peer.service`) |
| no traces (`quickstart`, the agent tools) | a topology from mesh, service-graph or span metrics, or a topology file: calls per request per service, the same for every endpoint of a service; self time estimated from latency metrics; no payload sizes or uninstrumented components |
| bill | $ per replica-hour, per request and per GB for each component; spend no component explains |

## 2. The calibrated model

A summary; every rule, and the recording that taught it, is in [calibration.md](calibration.md).

`hindcast calibrate` fits, per component:

- **CPU per request** — cores per replica = base + per-request cost × req/s per replica (least squares).
- **Capacity per replica** — three explanations are replayed through the measured history and the one
  that reproduces the measured self time best wins: *no limit seen*, *CPU-bound* (the CPU limit
  reached at the fitted CPU per request), or *concurrency-bound* (an M/M/c queue — locks, connection
  pools, worker pools — with servers and capacity fitted). Overloads in the history are replayed with
  a fluid backlog, so they inform the fit instead of breaking it. A block bootstrap over the history
  gives a 10th–90th percentile band for the capacity.
- **CPU quota throttling** (Kubernetes, from CFS throttled periods): the share of throttled periods is
  fitted against CPU use, and CPU-bound capacity stops where it reaches 25% (the `CPUThrottlingHigh`
  alert's threshold) instead of at 100% of the limit. A single-threaded runtime under a limit
  collapses well before the limit. Where the history shows the service failing while throttled, this
  caps a capacity read from latency too. Where it shows the service throttled that hard and healthy,
  throttling is ignored.
- **Memory** — the largest container's peak working set per bucket against req/s per replica (a
  line, or flat when memory doesn't follow load), plus the worst spike above that line in the
  history. A strategy that lowers a memory limit below it gets its pods OOM-killed in the replay. They
  restart with CrashLoopBackOff (10 s doubling to 5 min, plus a start), failing every request routed
  to them meanwhile. The explanation names the kill. Cost uses the limit per replica, not the usage.
  A **leak** is told apart from load: memory fitted against the requests a container has served
  since it started (the count restarting where memory drops) — when that explains it far better
  than load does (R² ≥ 0.8, at least 0.2 above), the service gets a leak per request, the note says
  after how many requests it reaches its limit, and the replay counts each container's requests
  and OOM-kills it there. A busier day reaches the limit sooner: the reference shop's `email` leaks
  ~10 KB a request and is killed at minute ~22 of every launch day, never on an ordinary one.
- **JIT warm-up** (a JVM or .NET, named by the traces' `telemetry.sdk.language` /
  `process.runtime.name` or by a Kubernetes diff's pod template: an image named for the runtime,
  `JAVA_TOOL_OPTIONS`, `DOTNET_*`). A pod that starts during the replay starts cold. That covers the
  change's own rollout (a new CPU or memory limit, requests, arch or spread replaces the pods at the
  replay's first moment), an autoscaler's scale-out, a node loss's replacements and a restart after an
  OOM kill. While cold, a request costs ×5 the CPU it costs warm (the balancer gives a cold pod the
  same share as a warm one, so the deployment's capacity drops by that much). The pod warms up after
  30 core-seconds of compilation. The compiler gets the CPU the requests leave idle under the limit,
  and 6% of the limit when they take all of it. A saturated pod therefore barely compiles and stays
  slow, while an idle one is warm in minutes. These are the JVM's defaults, fitted on one Spring Boot
  service ([reference/k8s/petclinic](../reference/k8s/petclinic/README.md#what-the-model-learned-from-the-miss-in-sample)),
  and the verdict calls them *assumed*. Where the history shows a pod starting (the replica count
  rising), calibration measures the core-seconds instead, as the CPU above the fitted line afterwards
  (an upper bound). .NET gets ×2 and 10 core-seconds, a guess. Node's V8 warms its hot paths within
  seconds and is not modelled cold, and neither are Go, Rust or C++. The verdict reports headroom
  once warm, and what the system sustains while the restarted pods are cold. When that is below the
  peak, a rollout at a busy moment would not warm up, and the verdict is at best inconclusive.
- **Nodes** (Kubernetes, from kube-state-metrics): node size, node count, every pod's requests. On a
  cluster compute is what the nodes cost, priced from their allocatable size at EC2 m6i on-demand
  rates unless `hints.cluster.nodePriceHour` says otherwise. The services pay that less the share
  other teams' pods request, spread by their own requests. A pool whose node count followed demand
  is *autoscaled*: the replay adds nodes as requests need them and removes them after 10 unneeded
  minutes. A pool that never changed is *fixed*: a change that frees requests saves nothing until
  the pool shrinks, and the verdict says so. A request that outgrows a fixed pool leaves pods
  Pending.
- **Latency** — self time at low load (mean, p99) plus queueing; a tail multiplier fitted on the p99s.
- **Endpoints** — critical-path weight per service, network/proxy overhead (measured minus the
  path), baseline errors, its own SLO, a tail multiplier fitted on its measured p99.
- **Cost** — compute $ / replica-hours actually run, usage-billed $ / requests, transfer $ / GB.

Every component gets a fit status from replaying the whole history through the model and comparing
with what was measured: **good** (< 15% mean abs. error), **fair** (< 30%), **poor**, **unexplained**
(nothing to check against, or worse than 60%), **cost only** (in the bill or container metrics but
never in traces). `--holdout 0.3` calibrates on the first 70% and predicts the rest: the accuracy
record travels with the model into every report.

## 3. Strategies

A strategy is a YAML file: one change per target.

```yaml
name: Graviton + autoscaling
description: Move the API to Arm and let it follow load
changes:
  - service: api
    arch: arm                  # Graviton pricing (×0.8); set perf: from your own benchmark
    autoscale: { min: 2, max: 8, targetCpu: 0.6, warmupS: 60, cooldownS: 300, intervalS: 15 }
  - service: catalog
    cache: { hitRate: 0.8, latencyMs: 1, costPerHour: 0.219 }   # a cache in front
  - service: orders-db
    readReplicas: 1            # reads split over primary + replicas
    readShare: 0.8
  - service: search
    replicas: 3                # fixed count
    cpu: 2                     # cores per replica; CPU-bound capacity scales, price scales with vCPU+GB
    memoryGb: 4
  - service: payments
    capacityRps: 120           # override after removing a lock
    zone: us-east-1a           # placement → data-transfer pricing
  - endpoint: "*"              # or one endpoint id
    retries: { attempts: 2, budget: 0.1 }   # client retries, extra load capped at +10%
    timeoutMs: 3000
```

Strategies also come from **the board** (open any moment on the board, edit it, press *Backtest these
edits*), from **audit fixes** (each verified fix has a *Backtest* button when the board came from a
backtest), and from **pull requests** (`hindcast diff-strategy` reads Kubernetes manifests before and
after: replicas, CPU/memory limits, HPAs, `kubernetes.io/arch`).

## 4. The backtest

For every bucket of the history: real endpoint traffic → visits per service (through caches, client
retries) → load per replica → M/M/c wait plus a fluid backlog when demand exceeds capacity → latency
per service → end-to-end latency per endpoint along its critical path → failures past the client
deadline → cost (replica-hours, requests, data transfer across zones/regions and to the internet).
Autoscalers run on their own clock with warm-up, cool-down and evaluation period.

Each strategy is replayed 30 times with every capacity drawn from its bootstrap band; the same draws
are used for the as-built run, so differences are paired. Results:

- **$ saved or spent** per month (10th–90th percentile)
- **minutes out of SLO**, **failed requests**, **error budget used**
- **worst moment and why** — the component that limited the system, its load and queue
- **incidents** — every stretch out of SLO with its cause
- **per endpoint** — requests, failures and minutes out of *its own* SLO, $ per million requests
- **series** — p99, errors, $/h, cumulative cost, error budget, replicas, each with a band
- **ranking** — strategies that keep SLO first, then cheapest

**At another load.** `--scale 2.2` (or `--peak 400` for the busiest moment's req/s) replays the
same history at that multiple of its traffic — the daily shape, the spikes and the endpoint mix stay
its own; the as-built system and every strategy see the same load. It answers "does it survive
launch day?" from an ordinary day. The app's **LOAD** control does the same (×0.5 … ×3), and every
report says when a load other than ×1 was used. A load the history never reached is extrapolation:
the trust report lowers the confidence to match.

## 5. Surfaces

- **App** — the Backtest tab: the p99 users saw, the as-built replay and every
  change over it with bands, errors and cost on one time axis, out-of-SLO stretches shaded;
  "replayed at" runs it at ×0.5–×3; the changes tested, verdict first; Overview / Incidents / Endpoints / Changes (edit the YAML live) / Model tabs. Click any
  moment to open it on the board as a replay. *Card ↗* makes a Studio card of the focused strategy.
- **CLI** — `import`, `calibrate`, `backtest`, `headroom` (model breaking point), `accuracy`,
  `outage`, `diff-strategy`, `verify-change`, `export-prometheus`; Markdown / HTML reports; `--comment` writes the PR
  comment; `--gate` exits 2 if a strategy adds time out of SLO, or fails more requests than the SLO's error budget over the window (verify_change's gate).
- **PR check** — the GitHub Action (`uses: votiakov/hindcast@v1`, [ci.md](ci.md)): the manifest
  diff or Terraform plan backtested with `hindcast verify-change`, one comment updated in place, the
  check failed on the verdict. The hand-written workflow it replaces is in
  [examples/backtest-ci](../examples/backtest-ci); `scripts/make-backtest-demo.sh` assembles a ready repository.
- **Studio** — `hindcast backtest … --card card.json`, then `npm run record -- --card card.json`
  renders the clip (chart drawing itself, then the verdict) to MP4 with PNG stills.

## 6. Public-outage replays

"Would your design have survived it?" Each outage is its published timeline turned into what your
system would have felt — traffic relative to your normal load and faults on roles (`edge`,
`primary-db`, `managed-kv`, `compute`, `all`) resolved to your components:

| id | outage |
|---|---|
| `cloudflare-2019-07-02` | a WAF regex took every edge CPU for 27 minutes |
| `github-2018-10-21` | a 43-second partition moved the primaries across the country for a day |
| `slack-2021-01-04` | the Monday after the holidays: surge, packet loss, provisioning failing |
| `aws-use1-2025-10-20` | DynamoDB's DNS record emptied; EC2 launches impaired for hours |

```
hindcast outage model.json list
hindcast outage model.json slack-2021-01-04 autoscale.yaml --role primary-db=orders-db
```

Each replay states its assumptions (how a provider-side failure maps onto your components) and
cites its source.

## 7. Accuracy

How well this works is measured, not claimed. See [reference/README.md](../reference/README.md): three
open demo systems were run under load in Docker with telemetry recorded, imported, calibrated on one
run and checked against runs the model never saw — a strategy actually applied, and step load tests
to the breaking point. Targets: p99 within 20% (over every request of the run), breaking point within 15%,
cost within 10% of the bill. Those checks pass (p99 off by 3–9%, breaking points by 0–14%, cost by
0–3%), single runs each; the holdout (the end of each history, which holds an overload the earlier
part never reached) misses p99 by 72–99%. On a kind cluster, verdicts committed before 27 runs of two systems
got 11 right, 5 wrong and 11 inconclusive (Astronomy Shop 6/4/8, PetClinic 5/1/3), against 18 right
and 9 wrong for a plain CPU-ratio rule ([reference/k8s](../reference/k8s/README.md),
[PetClinic](../reference/k8s/petclinic/README.md)). The evidence is demo systems, not a production fleet.
