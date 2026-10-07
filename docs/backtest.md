# Backtesting infrastructure changes on real data

Bottleneck replays your real production history through a model calibrated from that history, with
a change applied — "what would have happened" — before the change ships. It works from files: metric
exports, traces and the cloud bill. Nothing connects to your systems.

```
bottleneck export-prometheus --url http://prometheus:9090 --start 2026-09-01 --end 2026-09-15 --out telemetry
#   …add traces (OTLP JSON) and a bill (AWS CUR or GCP export) to telemetry/bottleneck.import.yaml
bottleneck import    telemetry/bottleneck.import.yaml --out dataset.json
bottleneck calibrate dataset.json --holdout 0.3 --out model.json
bottleneck backtest  model.json dataset.json graviton.yaml autoscale.yaml --last 14d --html report.html
```

or open the app: the backtest is its main screen. Drop the files (or a `dataset.json` + `model.json`)
on it.

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

`bottleneck export-prometheus` writes the `metrics:` block for you. Presets: `otel-spanmetrics`
(OpenTelemetry Collector spanmetrics connector), `http-server` (OTel HTTP semantic-convention
histograms, with per-route series), `cadvisor` (Docker Compose labels), `kubernetes` (kubelet +
kube-state-metrics). `--selector 'namespace="shop"'` scopes every query.

What each source gives the model:

| source | gives |
|---|---|
| request metrics | load per service and endpoint, latency and errors per bucket |
| CPU, limits, replicas | CPU per request, capacity per replica, replica-hours |
| traces | the topology; for every endpoint which services it visits and how often; the critical path (how many ms of each request each service owns); self time per service per bucket; payload sizes; uninstrumented databases, caches and queues as their own components (from `db.system`, `messaging.system`, `peer.service`) |
| bill | $ per replica-hour, per request and per GB for each component; spend no component explains |

## 2. The calibrated model

`bottleneck calibrate` fits, per component:

- **CPU per request** — cores per replica = base + per-request cost × req/s per replica (least squares).
- **Capacity per replica** — three explanations are replayed through the measured history and the one
  that reproduces the measured self time best wins: *no limit seen*, *CPU-bound* (the CPU limit
  reached at the fitted CPU per request), or *concurrency-bound* (an M/M/c queue — locks, connection
  pools, worker pools — with servers and capacity fitted). Overloads in the history are replayed with
  a fluid backlog, so they inform the fit instead of breaking it. A block bootstrap over the history
  gives a 10th–90th percentile band for the capacity.
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
backtest), and from **pull requests** (`bottleneck diff-strategy` reads Kubernetes manifests before and
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

## 5. Surfaces

- **App** — the backtest is the main screen: measured p99 as candles, the as-built replay and every
  strategy over it with bands, errors, cost and the savings curve on one time axis; ranked strategy
  list; Overview / Incidents / Endpoints / Changes (edit the YAML live) / Model tabs. Click any
  moment to open it on the board as a replay. *Card ↗* makes a Studio card of the focused strategy.
- **CLI** — `import`, `calibrate`, `backtest`, `headroom` (model breaking point), `accuracy`,
  `outage`, `diff-strategy`, `export-prometheus`; Markdown / HTML reports; `--comment` writes the PR
  comment; `--gate` exits 2 if a strategy adds time out of SLO.
- **PR check** — [examples/backtest-ci](../examples/backtest-ci) (workflow, manifests);
  `scripts/make-backtest-demo.sh` assembles a ready repository.
- **Studio** — `bottleneck backtest … --card card.json`, then `npm run record -- --card card.json`
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
bottleneck outage model.json list
bottleneck outage model.json slack-2021-01-04 autoscale.yaml --role primary-db=orders-db
```

Each replay states its assumptions (how a provider-side failure maps onto your components) and
cites its source.

## 7. Accuracy

How well this works is measured, not claimed. See [reference/README.md](../reference/README.md): three
open demo systems were run under load in Docker with telemetry recorded, imported, calibrated on one
run and checked against runs the model never saw — a strategy actually applied, and step load tests
to the breaking point. Targets: p99 within 20% (typical per-bucket error), breaking point within 15%,
cost within 10% of the bill.
