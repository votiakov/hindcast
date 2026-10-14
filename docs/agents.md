# Bottleneck for AI agents

An agent that changes infrastructure (Terraform, Helm, Kubernetes manifests, autoscalers, instance
types) can ask Bottleneck, before anything ships, *what this change would have done to the last
week of production*: $ per month, minutes out of SLO, the worst moment and why, and how far to
trust the answer. The agent does the tedious part itself: it connects to Prometheus and
Jaeger/Tempo, collects the history, calibrates the model and reads the trust report. The user asks
a question and gets a verdict with evidence.

```
agent ──MCP / CLI──▶ connect_telemetry ─▶ collect_telemetry ─▶ calibrate_model ─▶ verify_change / suggest_changes
                     (probe, read-only)   (history → dataset)  (model + trust)    (verdict + confidence)
                                                                                   verify_design (no history)
```

Everything is read-only towards your systems. Bottleneck queries your Prometheus, your
Jaeger/Tempo and (only when asked, against a named context) `kubectl get`. It writes only inside
its workspace directory, and nothing leaves your machine.

## Set up

One command does it for any host:

```bash
npm run sim -- agent setup                  # in the repository; or: node dist-cli/bottleneck.mjs agent setup
npm run sim -- agent setup cursor --write   # claude | cursor | vscode | desktop | windsurf
```

It builds the single-file server if needed, starts it and completes an MCP handshake (so a broken
install shows up here, not in your agent), then prints the config for each host with absolute paths
filled in. With a host and `--write` it merges the entry into that host's file (`.mcp.json`,
`.cursor/mcp.json`, `.vscode/mcp.json`, Claude Desktop's or Windsurf's user config) and keeps every
other server there. `--project <dir>` sets where project files and the `.bottleneck/` workspace go.
The manual steps below do the same by hand.

### Claude Code

In this repository it is already registered (`.mcp.json`). Elsewhere, build the single-file
server once and register it:

```bash
npm run build:mcp-server            # → dist-cli/bottleneck-mcp.mjs (Node 20, no install)
claude mcp add bottleneck -- node /path/to/bottleneck/dist-cli/bottleneck-mcp.mjs
```

### Any MCP host (Claude Desktop, Cursor, Windsurf, VS Code, …)

```json
{
  "mcpServers": {
    "bottleneck": {
      "command": "node",
      "args": ["/path/to/bottleneck/dist-cli/bottleneck-mcp.mjs"],
      "env": { "BOTTLENECK_WORKSPACE": "/path/to/project/.bottleneck", "PROM_TOKEN": "…" }
    }
  }
}
```

`BOTTLENECK_WORKSPACE` defaults to `.bottleneck/` in the directory the server starts in. Put
credentials in `env` and name them in the tools (`tokenEnv: "PROM_TOKEN"`); the values never go
into the workspace.

### Agents without MCP (shell, CI, Codex, Aider, scripts)

Every tool is also a CLI command, with JSON in and JSON out:

```bash
bottleneck agent list
bottleneck agent connect_telemetry '{"prometheus":{"url":"http://prometheus:9090"},"jaeger":{"url":"http://jaeger:16686"}}'
bottleneck agent collect_telemetry '{"last":"7d"}'
bottleneck agent calibrate_model
bottleneck agent verify_change @change.json          # or - to read stdin
```

(`npm run sim -- agent …` inside the repository; `node dist-cli/bottleneck.mjs agent …` from the
standalone build.) A ready-made instruction file for such agents is in
[`examples/agents/AGENTS.md`](../examples/agents/AGENTS.md).

### Prompts

Hosts that surface MCP prompts get two commands:

- **verify-infra-change** `change`: model_status, connect and collect if needed, calibrate, verify,
  and answer in a fixed order (verdict and confidence, money with its basis, SLO minutes, worst
  moment, what would make it safer).
- **check-my-design** `design` `rps?` `budget?`: write a spec, verify_design, apply fixes until it
  passes.

## The workflow

### 1. `connect_telemetry`: what is there

```json
{ "prometheus": { "url": "http://prometheus:9090" },
  "jaeger": { "url": "http://jaeger:16686" },
  "system": { "name": "shop", "slo": { "p99Ms": 800, "errorRate": 0.01 }, "timeoutMs": 5000 } }
```

It probes before anything is collected:

- **Prometheus**: which presets its metrics support, which services each names, when traffic
  flowed (the newest and oldest requests, bisected to minutes), and metrics under older names it
  can't read yet.
- **Jaeger/Tempo**: the services, which ones requests *enter through*, which ones only start
  traces as clients (load generators, which it then ignores), and the call edges.
- **Renames**: container metrics often spell services differently from traces (`shop-worker` vs
  `worker`). Unambiguous renames are applied; a load balancer is never folded into its backend.
- **Namespaces**: a cluster's Prometheus sees every namespace (coredns, the monitoring stack, other
  teams). Kubernetes metrics are kept to the namespaces the traced services run in; pass
  `prometheus.namespaces` to choose them yourself.
- **Broken traces**: real traces lose spans (an exporter drops a batch, a hop isn't instrumented).
  A span whose parent never arrived is a broken link, not an entry service; only true roots (or, in
  a trace that lost its root, its earliest span) count.

It returns `problems` to fix and `ready`. Calling it again merges new settings. Everything goes
into `sources.json` in the workspace, with credentials as env var names only.

### 2. `collect_telemetry`: the history

```json
{ "last": "7d" }
```

- Runs the preset queries over the window in fine buckets: 30 s up to a day, 60 s up to two weeks.
  A three-minute overload is the most valuable part of a history, and wide buckets average it
  away. Ranges past Prometheus' 11,000 points per series are fetched in chunks.
- Endpoint-level series are queried only on the entry services; counting every service's spans
  would count each request several times.
- **The edge wins.** Where ingress-nginx counts the entry service's requests, its rate, errors
  (5xx and 499, the client giving up) and latency replace the span-metric values, and the endpoint
  rates keep their shares but are scaled to the edge's total. Span metrics undercount: span names
  that carry raw URLs (`GET /api/cart?sessionId=…`) make thousands of sparse series, and `rate()`
  loses each one's first increment — 38% of the requests at low load on the Kubernetes reference.
- A framework that wraps each request in two server spans (Next.js: `GET`, then `GET /api/cart`)
  shows the outer one as an endpoint named only by its method. Where the traces see two server spans
  per visit, those method-only series are dropped as the duplicates they are.
- Fetches traces spread over the window. Jaeger and Tempo return the newest first, so it cuts the
  window into up to 96 slices (at least a minute each) and gives each slice a share of the traces (3,000 by default) weighted by
  the requests Prometheus saw in it. Idle slices get none, and a quiet day with one busy hour gets
  its traces from that hour.
- Imports everything into `dataset.json`. Collecting again replaces the dataset and drops the old
  model.

The result says, per service, which signals exist (`rps, errorRate, p99Ms, cpuCores,
cpuLimitCores, replicas, memoryBytes, traces`) and which are missing. It also warns about what
that means: no CPU limit means no CPU capacity, no bill means list prices, and services in no
trace may belong to another system (`system.exclude`).

**One overload in the history is worth more than a month of quiet days.** Capacity that the
history never approached is an extrapolation, and the trust report says so. When the real history
is calm, add a load test to it: `windows: [{ "start": …, "end": … }, { "start": …, "end": … }]`
collects several windows into one history (an ordinary week plus last month's load test, say). The
gaps between them stay empty.

### 3. `calibrate_model`: the model, and how far to trust it

It fits capacity per replica (with a 10–90% band) and what limits it: CPU, or a lock or pool
(*n at a time*). It also fits latency, the errors that grow with load, and cost per service. The
last 30% of the *requests* is held back to measure accuracy on data the model never saw. That is
30% of the requests, not of the time, so a quiet week with one busy hour isn't judged on its
empty nights.

The **trust report** sorts every service:

| list | meaning |
|---|---|
| `trusted` | good or fair fit, and its limit was reached in the history (or it has none) |
| `caution` | good fit, but the history peaked at a fraction of its capacity: the limit is extrapolated |
| `untrusted` | poor or unexplained fit: the model can't reproduce what was measured |
| `costOnly` | in the bill or container metrics, never in traces: priced, not modelled for latency |

Per service: `historyPeakUtil` (the highest share of capacity the history ran it at) and
`basis` (`limit seen in history`, `extrapolated`, `no limit seen`).

### 4. `verify_change`: the verdict

```json
{ "changes": [
    { "strategy": { "name": "Graviton", "changes": [{ "service": "api", "arch": "arm" }] } },
    { "kubernetes": { "base": "deploy/", "head": "deploy-new/" } },
    { "terraformPlan": "plan.json" },
    { "cluster": { "head": "k8s/edited/" } }
  ],
  "last": "7d",
  "traffic": { "scale": 2.2 } }
```

`traffic` replays the history at another load: `scale` ×N, or `peakRps` for its busiest moment.
"Is it safe on launch day, at 2.2× a normal day?" is the same history with the same daily shape,
spikes and endpoint mix, as built and with the change alike. A load the history never reached
lowers the confidence to match.

| a change can be | read from |
|---|---|
| a **strategy** (object or YAML) | replicas, autoscale, cpu, memoryGb, arch, perf, capacityRps, cache, readReplicas, zone/region; per endpoint: retries, timeoutMs ([strategies](backtest.md#3-strategies)) |
| a **Kubernetes diff** (`base`, `head`: directories, files or YAML text) | Deployments, StatefulSets: replicas, CPU/memory limits, `kubernetes.io/arch`; HPAs |
| a **Terraform plan** (`terraform show -json plan.out`) | `aws_ecs_service` desired_count; `aws_ecs_task_definition` cpu, memory, architecture; `aws_appautoscaling_target`/`_policy` (CPU target tracking); `aws_autoscaling_group`; `aws_launch_template`/`aws_instance` instance_type (Graviton families → arm, vCPU and memory from the size); `aws_db_instance`/`aws_rds_cluster_instance` class and read replicas; `google_cloud_run_v2_service`; `kubernetes_deployment(_v1)`/`stateful_set(_v1)` |
| **edited manifests vs the live cluster** | `read_cluster` snapshot as the base |

Resources map to model services by the `bottleneck:service` tag/label (or the
`bottleneck.dev/service` annotation), else by name. Anything that changes and can't be modelled is
listed in `notes` with the reason (a new service, an S3 bucket, an unmatched name).

Each result:

```jsonc
// verify_change on the live HotROD (from the run under "Tested against"): client retries without a budget
{
  "name": "Clients retry twice, no budget",
  "verdict": "fail",                       // pass | fail | inconclusive
  "summary": "costs the same and adds 6 minutes out of SLO",
  "reasons": ["costs the same and adds 6 minutes out of SLO", "adds 6 min out of SLO (10–90%: 5.5 … 6.5)", "worst at 2026-10-09T19:16:30Z: mysql at 357% of capacity (32.1 req/s on 1 × 9.0 req/s), 148.4 s queue", "worse for frontend GET /dispatch against their own SLOs"],
  "cost": {"monthlyDelta": {"p50": 0, "lo": 0, "hi": 0}, "monthly": 81.45, "basis": "unchanged services"},
  "reliability": {
    "minutesOutOfSloDelta": {"p50": 6, "lo": 5.5, "hi": 6.5},
    "failedRequestsDelta": {"p50": 1241, "lo": 1055, "hi": 2006},
    "errorBudgetUsed": {"asBuilt": "548%", "after": "1003%"},
    "worst": {"at": "2026-10-09T19:16:30Z", "p99Ms": 5000, "errorRate": 1, "why": "mysql at 357% of capacity (32.1 req/s on 1 × 9.0 req/s), 148.4 s queue"},
    "incidents": [ … ], "endpointsWorse": [ … ]
  },
  "headroom": {"beforeRps": 5.3, "afterRps": 5.3, "limitedBy": "errors that grow with load (frontend GET /dispatch: +0.56% per req/s)", "historyPeakRps": 10.7},
  "confidence": {
    "level": "low",                        // high | medium | low
    "services": [{"service": "route", "touched": false, "fit": "good", "historyPeakUtil": 0.14, "predictedPeakUtil": 0.41, "basis": "beyond anything the history showed"}, {"service": "mysql", "touched": false, "fit": "unexplained", "historyPeakUtil": 1.19, "predictedPeakUtil": 1.5, "basis": "near a limit the history reached"}],
    "warnings": ["route would run at 41% of capacity, past the history's 14%: its capacity there is extrapolated", "driver would run at 35% of capacity, past the history's 12%: its capacity there is extrapolated", "mysql: the model fits it not at all, and this change pushes it harder than the history did", "only 1 h of history: daily and weekly peaks may be missing"]
  }
}
```

And for a human:

- **`app.open`** (MCP): a link that opens the Backtest screen with these strategies over the same
  history. It shows the chart, the ranked strategies, the worst moment, incidents, endpoints, and
  any moment on the board. The MCP server serves the bundle on `127.0.0.1` while it runs, only to
  the app's origin (`BOTTLENECK_APP_URL`).
- `reports.html`: the self-contained report (charts, verdicts, accuracy), plus `reports.markdown`,
  the strategies as YAML, and `reports.bundle` (the same as the app link, as a file: drop it on
  the Backtest screen when the server isn't running).

#### How the verdict is decided

- **fail**: the median adds more than `gateMinutes` (default 0.5) minutes out of SLO over the window.
- **inconclusive**: the median passes but the worst 10% of capacity draws don't, *or* confidence is
  low, *or* the change cuts headroom below traffic the system has already seen.
- **pass**: otherwise.

#### How confidence is decided

For every service the change touches, or that the change pushes harder (above 60% of capacity, or
25% past its history peak):

- **low**: the service fits poorly or is unexplained, *or* the change runs it at ≥ 80% of a
  capacity the history never came near (the outcome rests on an extrapolated limit).
- **medium**: it runs past the history's peak at < 80%, *or* the touched service fits only
  fairly, *or* the model missed an accuracy check, *or* accuracy was never measured, *or* the
  history is shorter than a day.
- **high**: otherwise.

The cost basis is stated separately: `your bill`, `list price` (AWS Fargate on-demand, us-east-1,
from CPU and memory limits, used when there is no bill) or `unpriced`.

**A pass at low confidence is not "safe".** It means the backtest found no problem on capacities
the history never tested. The MCP instructions tell agents to say so and recommend a load test.

### `suggest_changes`: what should we change?

```json
{ "goal": "both" }          // "reliability" | "cost" | "both"
```

Candidates come from the history itself:

- **Fixes** for every service that ran at ≥ 85% of its capacity: one more replica (or double, from
  two), of the *host* when the service runs in-process (HotROD's mysql → more `customer`
  replicas). When CPU is the limit, it also tries twice the CPU and CPU autoscaling.
- **Savings** for every priced service that stayed under 35% (`idleBelow`) at its busiest, along
  with everything running inside it: one replica fewer, half the CPU, Graviton.

Every candidate is backtested and judged like `verify_change`. The result lists:

- `fixes`: the candidates that cut minutes out of SLO, *or failed requests by at least a tenth*.
  Minutes can stay put when something else breaks the SLO in the same minutes.
- `savings`: the candidates that pass, biggest saving first.
- `combinedSavings`: all passing savings applied together. Two safe cuts can be unsafe at once.
- `rejected`, with each verdict.

On the live HotROD: mysql (inside `customer`) saturated. Two customer replicas cut failed
requests by 79% (−1,170) at +$15/month, at low confidence because the lock fits poorly. Six
savings passed (half the CPU on frontend, route and driver, Graviton for each), and together they
saved $35/month with no change in SLO minutes. It ran in about 3 seconds.

### `find_headroom`

The req/s the system sustains within SLO with today's endpoint mix, as built and with a strategy,
and what binds first. That can be a service saturating, or errors that grow with load crossing
the error SLO.

### `check_node_loss`

Kubernetes only. It replays the history's busiest moment with each node gone. Every pod on the node
disappears at once, using placement from `kube_pod_info` at the end of the history. A service with
no replica left is down; the rest serve on what's left. Kubernetes replaces the pods after
NotReady (~50 s), the default 300 s eviction toleration and a start: about 6 minutes. A fixed
pool with no room for them leaves them Pending. It returns, per node:

- what the node takes down;
- the minutes out of SLO and failed requests it adds.

It also lists the services one node failure takes out entirely. With a `strategy`, the strategy's
new replica counts are spread evenly over the nodes, as the default scheduler does.

On the Kubernetes reference, the as-built shop fails either way. Losing a worker at the peak adds
6.5–7.3 minutes out of SLO and about 50,000 failed requests: 14 services run a single replica.

### `read_cluster`

```json
{ "context": "prod-eu", "namespace": "shop" }
```

Runs exactly `kubectl --context prod-eu -n shop get deployments,statefulsets,horizontalpodautoscalers -o json`.
The context is required, and the current context is never used implicitly. It saves the snapshot
in `.bottleneck/cluster/` and returns replicas, limits, autoscalers and architecture per workload.
`verify_change` with `{ "cluster": { "head": "<edited manifests>" } }` then backtests the edit
against what is actually running.

### `model_status`

Cheap; call it first. It returns the connections, the history window and its age, the model with
its trust report and accuracy, recent reports, warnings (history older than a week, accuracy
missed or never measured) and the next step.

## Designs on paper: `verify_design`

No history needed. The agent writes an architecture spec ([spec.md](spec.md); `list_components`
gives the catalogue). Then:

```json
{ "spec": { "name": "shop", "components": […], "connections": […] }, "rps": 400, "budgetMonthly": 900 }
```

It validates the spec, simulates it at the load and replays every failure: instance and component
deaths, zone loss, slow and erroring dependencies, cold caches, a 3× surge. It also measures
headroom and cost against the budget. The verdict is `pass`, `pass with risks` or `fail`. Each
finding carries verified fixes with the exact spec `changes` to apply, so an agent can loop until
it passes. It also returns a link that opens the design in the app for a human.

Numbers come from catalogue defaults unless the spec overrides capacity, latency and cost. Once
the system runs, calibrate it on telemetry for real numbers.

## What your telemetry needs

| signal | where Bottleneck reads it | without it |
|---|---|---|
| request rate, errors, latency per service | Prometheus: OpenTelemetry Collector **spanmetrics** (`traces_span_metrics_*`), OpenTelemetry **HTTP server** metrics (`http_server_request_duration_seconds_*`) or **Spring Boot / Micrometer** (`http_server_requests_seconds_*`, by `application` tag or scrape job; p99 needs `percentiles-histogram`) | nothing to model |
| the same per endpoint, on entry services | the same metrics, by `span_name` or `http_route` | endpoint rates from traces, scaled by the measured sampling share |
| requests, errors, latency at the edge | **ingress-nginx** (`nginx_ingress_controller_*`, by backend Service). Requests to an Ingress without a host are only counted with `--metrics-per-undefined-host=true` | the entry service's rates come from span metrics, which undercount sparse series |
| CPU used, CPU limit, replicas, memory and its limit | **cAdvisor** (Docker Compose labels) or **Kubernetes** (kubelet cAdvisor + kube-state-metrics, grouped by the Deployment, StatefulSet or DaemonSet that owns each pod; CPU requests stand in where no limit is set; CFS throttling, peak working set, memory limits, requests and the nodes are collected) | capacity only from latency; resize strategies can't be priced |
| topology, self time per service | **Jaeger** (`/api/traces`), **Tempo** (`/api/search` + `/api/traces/{id}`), or OTLP / Jaeger JSON files | no topology: which service calls which is unknown |
| cost | AWS CUR or GCP billing export (file) | AWS Fargate list prices from CPU and memory limits |

Older names are recognised and reported as `nearMisses` with what to do, but not read: spanmetrics
`calls_total` from the old processor, `http_server_duration_milliseconds`. A recording rule that
renames them makes them work. `selector`
adds label matchers to every query (`cluster="prod-eu"`); `namespaces` scopes the Kubernetes and
ingress metrics. `exclude` drops another system's services.

Authentication: `tokenEnv` (bearer), `basicAuthEnv` (`user:password`) and `headersEnv` (e.g.
`X-Scope-OrgID` for Mimir/Cortex/Tempo multi-tenancy), each naming an env var. Path prefixes
(`https://mimir/prometheus`) work.

## Safety

- **Read-only.** Prometheus: `query`, `query_range`, label values, buildinfo. Jaeger/Tempo:
  search and trace fetch. Kubernetes: one `get` against a named context. Nothing is ever applied.
- **Credentials** are env var names in the workspace, never values. A missing variable is
  reported, not sent as an empty header.
- **Workspace contents**: telemetry exports, the dataset, the model, reports. Telemetry can
  contain endpoint paths and service names. Keep `.bottleneck/` out of version control
  (`.gitignore` it) if those are sensitive.
- **No network calls** except to the endpoints you configure.

## Workspace

```
.bottleneck/
  sources.json        connections and system hints
  telemetry/          the last collection: metrics/*.json, traces/*.jsonl, bottleneck.import.yaml
  dataset.json        the imported history
  model.json          the calibrated model (same format as `bottleneck calibrate`)
  calibration.json    per service: history peak vs capacity, trust
  cluster/            read_cluster snapshots
  reports/            verify_change reports: .html, .md, .strategies.yaml, .bottleneck.json (opens in the app)
```

The files are the CLI's formats, so everything an agent produced can be reopened by hand:
`bottleneck backtest .bottleneck/model.json .bottleneck/dataset.json strategy.yaml --html r.html`,
or dropped on the app's Backtest screen.

## Tool reference

| tool | inputs | returns |
|---|---|---|
| `connect_telemetry` | `prometheus{url, selector?, namespaces?, presets?, tokenEnv?…}`, `jaeger{url}` \| `tempo{url}` \| `traceFiles[]`, `bill{cur\|gcp, tag?}`, `system{name, slo, timeoutMs, rename, hostedBy, entry, ignore, exclude}` | probes, renames applied, `problems`, `ready` |
| `collect_telemetry` | `last` \| `start`/`end` \| `windows[]`, `stepS?`, `maxTraces?` | window, coverage per service, endpoints, warnings |
| `calibrate_model` | `holdout?` (0.3), `slo?`, `timeoutMs?`, `listPrices?` | services with capacity, band, limit, basis, cost; accuracy; trust lists |
| `model_status` | — | what the workspace holds, warnings, next step |
| `verify_change` | `changes[]`, `last?`, `traffic?{scale \| peakRps}`, `gateMinutes?`, `draws?` (30, fewer on long histories to fit ~40 s) | per change: verdict, confidence, cost, reliability, headroom, reasons; reports and `app.open` |
| `suggest_changes` | `goal?` (reliability \| cost \| both), `last?`, `draws?`, `gateMinutes?`, `idleBelow?` | saturated services; fixes and savings that pass, each judged; the savings combined; rejected candidates |
| `find_headroom` | `strategy?` | req/s within SLO, what binds, history peak |
| `check_node_loss` | `strategy?`, `traffic?{scale \| peakRps}`, `recoverS?` | per node: services lost or degraded, minutes out of SLO and failed requests added; single points of failure |
| `verify_design` | `spec`, `rps?`, `slo?`, `budgetMonthly?`, `incidentCostPerMinute?` | verdict, problems, findings with fixes as spec changes, app link |
| `read_cluster` | `context`, `namespace?`, `selector?` | workloads, snapshot path, the exact command run |

The earlier tools are still there: `simulate`, `analyze`, `audit_resilience`, `compare_architectures`,
`find_breaking_point`, `optimize_cost`, `import_terraform`, `import_kubernetes`, `validate_architecture`,
`list_components`, `show_architecture`, `open_in_app`, `backtest_strategy`, `replay_outage`
([tools.md](tools.md#mcp-server--npm-run-mcp)). `backtest_strategy` and `replay_outage` default to
the workspace model.

## Tested against

Live, against real infrastructure: the reference HotROD (four Go services, a mutex-guarded
simulated MySQL, CPU-limited containers) under a 30-minute "production day" from k6. Telemetry
went through an OpenTelemetry Collector into Prometheus (span metrics, container metrics) and
Jaeger (20% sampled traces). The stack is in `reference/stack/`.

**Claude Code, headless, given only this** (and `--allowedTools mcp__bottleneck`):

> Our HotROD ride-dispatch system's Prometheus is at http://localhost:9090 and Jaeger at
> http://localhost:16686. SLO: p99 under 1 s and under 3% errors; clients time out after 5 s. Use
> the last hour of history. Two questions before I change anything: can we move all our services
> to Graviton without hurting reliability, and would letting clients retry failed requests twice
> (no retry budget) make things better or worse?

It ran 17 turns in 2.5 minutes ($0.88 of model time):

1. `model_status`, then `connect_telemetry` with the two URLs and the SLO.
2. `collect_telemetry` `last: 1h`. The coverage report said that `app`, `app-lb` and `postgres`
   were in no trace, and that `mysql` and `redis` are traced but have no container. The agent
   checked the container labels in Prometheus, recognised a second system (PetClinic) sharing the
   Prometheus, and connected again with `exclude` for it and `hostedBy` for mysql and redis.
3. `calibrate_model`. mysql came out at 9.1 req/s per replica, a lock held about 105 ms
   (band 7.6–10.6). A stress test of the same build measured 9.9 req/s.
4. `verify_change`, with both changes, and then a third run on its own initiative: Graviton at 20%
   lower throughput per vCPU (`perf: 0.8`), to see whether slower Arm cores would matter.

Its answer, condensed:

- **Graviton: inconclusive, confidence low.** It saves $16.29/month (Fargate list prices, about
  20%) with no change in minutes out of SLO, even at 20% slower cores, because the only
  saturated component is a lock and not CPU. Confidence is low because there is one hour of
  history and the model fits the mysql lock poorly. Recommended: migrate one service or
  load-test the Arm build first, and check every image is built for arm64.
- **Retries without a budget: fail.** +6 minutes out of SLO (10–90%: +5.5 … +6.5) and +1,241
  failed requests. "Every simulated run made things worse": the failures are timeouts from the
  mysql queue, so each retry joins the same full queue. The agent suggested two customer
  replicas (each process has its own lock) or retries with a budget instead.
- It also noticed the system already misses its SLO: 14.5 minutes out of SLO in the hour, 548% of
  the error budget, safe load about 5.3 req/s against a 10.7 req/s peak.

**Scripted**: `node scripts/agent-e2e.mjs --prom … --jaeger … --last 32m` drives the same flow
through a real MCP client against the built server, and checks that retries without a budget
fail and Graviton saves money without failing. Connect took 2.7 s, collect 4.5 s (1,682 traces
from Jaeger in 32 requests), calibrate 8 s and verify under a second. The holdout p99 check
passed at 3%.

**Tempo**: the collector also exported to Tempo 2.6 for a 6-minute run, and the agent connected
with `tempo` instead of `jaeger`. It found the same services, entry point and call edges,
fetched 509 traces in 517 requests (search per slice, then each trace), and calibrated the mysql
lock at 10.2 req/s. This run also caught Tempo rejecting searches longer than 168 hours, so the
probe samples only the last day.

What the live runs fixed before they passed: the container-name mapping folding a load balancer
into its backend; uninstrumented databases mistaken for load generators; services without
errors missing an error rate; the overload knee reading inflated completion rates (cancelled
queries finish fast); IP addresses becoming services where a span was missing; architecture
spellings (`arm64`); and validation errors an agent couldn't act on.

A second round, on 24 hours of history (a day that was idle but for the two runs), fixed:
- Wide buckets (120 s) averaged the 3-minute overload away, so nothing looked saturated.
- An even trace budget spent 46 of its 48 slices on idle hours: 126 traces, and a nonsense mysql
  fit.
- A time-based holdout judged the model on empty hours (571% off). It is now 30% of the
  *requests*, and passes at 3%.
- A traffic probe that bisected past a busy–idle–busy pattern ended the window at the wrong edge.
- Calibration replayed every idle bucket thousands of times, which took longer than an MCP
  client's 60 s timeout.

Now the 24-hour run passes every check. Collect takes 10 s, calibrate 8 s and verify 17 s. Suggest
takes 40 s: three backtests, with progress notifications between them.

**Long histories.** On two weeks of 1-minute buckets (20,250, the HotROD run tiled), calibration
takes about 46 s and the holdout 34 s, from about 7 minutes before compaction. The capacity fits
run on a compact copy: the busiest episodes, with their drain-out, and a sample of the rest. The
fitted numbers are identical. Each phase stays under a minute and reports progress. A replay of
that history takes about 2 s, so `verify_change` picks its capacity draws to fit ~40 s (and says
so in `notes`) rather than running 30 draws for 4 minutes.

## Limits

- The model is as good as the history: limits the history never approached are extrapolations,
  and the verdicts say so.
- Cold starts after a deploy, garbage-collection pauses and errors unrelated to load are not
  predicted ([calibration.md](calibration.md)).
- List prices are on-demand: no Savings Plans, Reserved Instances or committed-use discounts. Give
  the bill for real numbers.
- Supported trace backends: Jaeger and Tempo APIs, and OTLP/Jaeger files. Datadog, Honeycomb and
  X-Ray need an export to OTLP files first.
- Prometheus-compatible only (Prometheus, Thanos, Mimir, Cortex, VictoriaMetrics, Amazon Managed
  Prometheus behind a SigV4 proxy). CloudWatch works through files with the CLI
  ([backtest.md](backtest.md#1-data-in)).
