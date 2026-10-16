# Hindcast for AI agents

An agent that changes infrastructure (Terraform, Helm, Kubernetes manifests, autoscalers, instance
types) can ask Hindcast, before anything ships, *what this change would have done to the last
week of production*: $ per month, minutes out of SLO, the worst moment and why, and how far to
trust the answer. The agent does the tedious part itself: it connects to Prometheus and
Jaeger/Tempo (traces are optional: [without them](#without-traces) who calls whom is read from the
metrics), collects the history, calibrates the model and reads the trust report. The user asks
a question and gets a verdict with evidence.

```
agent ──MCP / CLI──▶ connect_telemetry ─▶ collect_telemetry ─▶ calibrate_model ─▶ verify_change / suggest_changes
                     (probe, read-only)   (history → dataset)  (model + trust)    (verdict + confidence)
                                                                                   verify_design (no history)
```

Everything is read-only towards your systems. Hindcast queries your Prometheus, your
Jaeger/Tempo and (only when asked, against a named context) `kubectl get`. It writes only inside
its workspace directory, and nothing leaves your machine.

## Quickstart: one command, a capacity review

Before giving the tools to an agent, see what they say about your system:

```bash
hindcast quickstart --prometheus http://prometheus:9090 --jaeger http://jaeger:16686
#   --tempo <url> in place of --jaeger, or neither (Prometheus alone; see "Without traces")
#   --topology calls.yaml: who calls whom, where no trace or metric says
#   --last 7d for more history (default: the last 24 h), or --start/--end for an exact window
#   --calls spanmetrics: which metrics name the calls, where several do (prometheus.calls)
#   --namespace shop, --exclude jaeger,otel-collector, --p99 500 --errors 0.01, --token-env PROM_TOKEN
```

It runs `connect_telemetry` → `collect_telemetry` → `calibrate_model` → `review_capacity`, prints
each phase as it goes, and ends on a five-line summary — **risk** (does the recorded day already
break the SLO; does a 1.5× or 2× day; does losing a node), **headroom** (req/s within SLO and what
gives out first), **cost** (a month as run, and what a commitment saves), **do this** (the one
change that passed the backtest) and **trust** (which services the model explains, and which it
doesn't, so you know which numbers are guesses). The full report is written to
`.hindcast/reports/capacity-review-<date>.md`. On the reference kind cluster (15 services, two
days of Prometheus and Jaeger) the whole run takes about 20 s; collecting the history is most of
it.

When it can't connect it says why and what to try: a 404 usually means Prometheus is served under
a path (`http://host/prometheus`), a refused connection that it isn't reachable from here
(`kubectl port-forward`), a 401/403 that it wants a token (`--token-env`). Every tool below works on
the workspace it leaves, so the next questions are ordinary tool calls:
`verify_change` with your manifest diff, `suggest_changes` with `traffic`, `check_node_loss`.

### Without traces

Many clusters have Prometheus (kube-prometheus-stack, often ingress-nginx or a service mesh) and
no tracing. `quickstart --prometheus <url>` alone still gives a review, and says what it is missing.
Who calls whom comes from the first of these that names any call:

| source | metric | what it gives |
|---|---|---|
| Istio | `istio_requests_total` (source → destination workload, `request_protocol`), `istio_request_duration_milliseconds_*` | calls per request, per-service latency, the time each caller spends in its calls, gRPC |
| Linkerd | `response_total` (outbound `deployment` → `dst_deployment`), `response_latency_ms_*` | the same; gRPC from `grpc_status` |
| OpenTelemetry service graph | `traces_service_graph_request_total` (client → server) | calls per request; callers' time from `traces_service_graph_request_client_seconds`. A callee with no spans of its own is a virtual node: named by host it is matched to its workload, named by `db.system` (`redis`) or `unknown` it is left out and listed |
| span metrics | client spans (`SPAN_KIND_CLIENT`) whose name matches a server span's elsewhere (`oteldemo.CartService/GetCart` ↔ `POST /oteldemo.CartService/GetCart`) | calls per request for RPC-named calls. HTTP and database client spans are named by method alone (`GET`, `HGET`): where the connector keeps the peer as a dimension (`peer.service`, `server.address` or `net.peer.name`, read as `peer_service`, `server_address`, `net_peer_name`), the host names the callee (port and `.ns.svc.cluster.local` stripped), including a workload with no spans of its own; without it they match nothing and are listed. A gRPC client that also traces the HTTP/2 `POST` under each call (.NET) is counted once |
| a topology file | `--topology calls.yaml` (`topologyFile` in `connect_telemetry`) | what you write: `calls: { web: [api] }` or `{ web: { api: 2 } }` (calls per request), `entry: [web]`, `grpc: [api]` |

The entries are the services ingress-nginx routes to (monitoring UIs such as Jaeger or Grafana
behind the same ingress are left out), the ones a gateway or load generator calls, and servers no
other server calls. Where the entries are known, a server with traffic that no metric names a
caller of (an HTTP call the span names can't match) is carried by the entry traffic in proportion
to its own requests. With none of the sources above, each service with request metrics is its own
entry, and the services without request metrics are read against the entry traffic: their CPU and
memory are fitted per entry request, as if every request passed through them (exclude the ones that
serve no requests, such as batch jobs).

What you lose without traces, and what stands in:

- **Each endpoint's own path.** Endpoints of a service share one path, the service's average calls
  per request. Where the endpoints have no latency series of their own (span names that carry raw
  URLs), they are modelled as one endpoint, `<service> (all requests)`.
- **Measured self time.** A service's self time is its latency less the time its own calls took
  (the caller's own measure of its calls where the source has one, else its callees' latency times
  calls per request), as if the calls ran one after another.
- **Exact call counts.** Client counters include calls that failed before reaching the callee and
  retries; calls into a service are scaled down to what it served.
- **Latency, where no metric has it.** A service with no latency metric gets its capacity from CPU
  alone, up to its throttling knee, and no latency of its own: the review says its limit is read
  from CPU, and `calibrate_model` lists it under `cpuOnly`, not `untrusted` (the model marks it
  `capacity.cpuAlone`). A CPU resize keeps it that way: the capacity moves to the new limit (to the
  same knee, as a share of it), and the wide queue calibration gave it stays, rather than taking
  its width from the core count and inventing a service time. `verify_change` rates a change to it
  medium confidence at most, and low once the change runs it past the history's peak (see
  [How confidence is decided](#how-confidence-is-decided)).

The review's Trust line names what is missing, e.g. *No traces: topology from istio metrics; no
per-endpoint latency*, and `collect_telemetry` returns the same under `withoutTraces`.

**gRPC.** Where a service with one replica is called over gRPC (Istio's `request_protocol`,
Linkerd's `grpc_status`, span names of the form `package.Service/Method`, `grpc_server_*` or
OpenTelemetry `rpc_server_*` metrics with `rpc_system="grpc"`), the review's risks say: *a restart
of X may leave callers' gRPC channels broken; check keepalive/reconnect settings — the replay times
only the platform's recovery*. The node-loss run on the reference cluster lasted 50% longer than
the replay for exactly that reason. This advisory comes with traces too. The gRPC calls found this
way also drive `check_node_loss`'s sensitivity for callers that stay broken (below). Collection from
traces alone doesn't mark calls as gRPC, so a traced model without these metrics gets no sensitivity.

## Set up

One command does it for any host:

```bash
npm run sim -- agent setup                  # in the repository; or: hindcast agent setup
npm run sim -- agent setup cursor --write   # claude | cursor | vscode | desktop | windsurf
```

The server is the `hindcast` binary itself (`hindcast mcp`). Setup starts it and completes an MCP handshake (so a broken
install shows up here, not in your agent), then prints the config for each host with absolute paths
filled in. With a host and `--write` it merges the entry into that host's file (`.mcp.json`,
`.cursor/mcp.json`, `.vscode/mcp.json`, Claude Desktop's or Windsurf's user config) and keeps every
other server there. `--project <dir>` sets where project files and the `.hindcast/` workspace go.
The manual steps below do the same by hand.

### Claude Code

In this repository it is already registered (`.mcp.json`, through `bin/hindcast`, which builds
the binary on first use). Elsewhere, build the binary once and register it:

```bash
npm run cli:build                   # → engine-rs/target/release/hindcast (one native binary, no runtime)
claude mcp add hindcast -- /path/to/hindcast/engine-rs/target/release/hindcast mcp
```

### Over HTTP (a shared or remote server)

```bash
HINDCAST_MCP_TOKEN=… hindcast mcp --http --port 8787            # http://127.0.0.1:8787/mcp
hindcast mcp --http --host 0.0.0.0 --port 8787                  # reachable from other machines
```

Streamable HTTP with JSON responses: POST a JSON-RPC message (or a batch of up to 16) to `/mcp`;
`GET /health` answers `ok`. It listens on loopback unless `--host` says otherwise — and then refuses
to start without `HINDCAST_MCP_TOKEN` (clients send `Authorization: Bearer <token>`) unless you pass
`--no-auth`. On loopback it answers only to a local `Host`, and a browser only from a local `Origin`
(`HINDCAST_MCP_ORIGINS` adds others), so a web page can't drive it by DNS rebinding. Requests are
bounded: 4 MiB bodies, 30 s to send one, 8 at once. Over HTTP it offers only an allowlist of tools
that compute on what they are given — designing, simulating, auditing, importing Terraform or
Kubernetes, `verify_design`. The workspace tools (they read and write local files and query your
Prometheus or cluster), `backtest_strategy` / `replay_outage` (they read paths) and `open_in_app`
are left out unless you add `--all-tools`, on a machine and network you trust.

### Any MCP host (Claude Desktop, Cursor, Windsurf, VS Code, …)

```json
{
  "mcpServers": {
    "hindcast": {
      "command": "/path/to/hindcast/engine-rs/target/release/hindcast",
      "args": ["mcp"],
      "env": { "HINDCAST_WORKSPACE": "/path/to/project/.hindcast", "PROM_TOKEN": "…" }
    }
  }
}
```

`HINDCAST_WORKSPACE` defaults to `.hindcast/` in the directory the server starts in (a
`.bottleneck/` workspace from before the rename is used when there is no `.hindcast/`, and the old
`BOTTLENECK_*` variables are still read). Put
credentials in `env` and name them in the tools (`tokenEnv: "PROM_TOKEN"`); the values never go
into the workspace.

### Agents without MCP (shell, CI, Codex, Aider, scripts)

Every tool is also a CLI command, with JSON in and JSON out:

```bash
hindcast agent list
hindcast agent connect_telemetry '{"prometheus":{"url":"http://prometheus:9090"},"jaeger":{"url":"http://jaeger:16686"}}'
hindcast agent collect_telemetry '{"last":"7d"}'
hindcast agent calibrate_model
hindcast agent verify_change @change.json          # or - to read stdin
```

(`npm run sim -- agent …` inside the repository; the `hindcast` binary anywhere else.) A ready-made instruction file for such agents is in
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
  traces as clients (load generators, which it then ignores), and the call edges. Without them,
  `calls` says where who-calls-whom will come from ([Without traces](#without-traces)), and what is
  lost.
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
| `cpuOnly` | no latency metric (without traces): capacity from CPU and throttling alone, no latency to score the fit on |

Without traces, `withoutTraces` says where the topology came from and what latency there was.

Per service: `historyPeakUtil` (the highest share of capacity the history ran it at) and
`basis` (`limit seen in history`, `extrapolated`, `no limit seen`).

**Mixed windows.** A history often holds more than one configuration of a service: a CPU or memory
limit or request changed, or the replica count (where no autoscaler sets it) moved and held for
half an hour. A setting has to hold 5 minutes to count; a rollout's blip doesn't. Each service is
fitted on one configuration only — the latest, when it carries at least 2 hours (and 30 buckets)
of traffic; otherwise the one that carries the most, since the latest is too short to fit. The
model records it per service (`fit.regime`: the settings, the hours of traffic, the changes and
when), and the trust report lists it (`trust.regimes`), saying which configuration and why.
Fitting across two configurations reads two different services as one: a capacity from a 1-core
limit applied to the half-core one running now.

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

Resources map to model services by the `hindcast:service` tag/label (or the
`hindcast.dev/service` annotation; the pre-rename `bottleneck:service` and `bottleneck.dev/service`
still count), else by name. Anything that changes and can't be modelled is
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
  the app's origin (`HINDCAST_APP_URL`).
- `reports.html`: the self-contained report (charts, verdicts, accuracy), plus `reports.markdown`,
  the strategies as YAML, and `reports.bundle` (the same as the app link, as a file: drop it on
  the Backtest screen when the server isn't running).

#### How the verdict is decided

- **fail**: the median adds more than `gateMinutes` (default 0.5) minutes out of SLO over the window.
- **inconclusive**: the median passes but the worst 10% of capacity draws don't, *or* confidence is
  low, *or* the change cuts headroom below traffic the system has already seen. `leans` says which
  way the median replay went (`pass` or `fail`): what the backtest would say if it trusted itself.
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

A service with no latency metric (capacity from CPU alone, `cpuOnly: true` in
`confidence.services`) is judged on its own rule instead of as unexplained: **medium** at most,
since its CPU limit is known but not how its latency grows near it, and **low** when the change
runs it more than 10% past the history's peak share of that capacity, where CPU per request is
extrapolated. The reasons say which applied and why.

The cost basis is stated separately: `your bill`, `list price` (AWS Fargate on-demand, us-east-1,
from CPU and memory limits, used when there is no bill) or `unpriced`.

**A pass at low confidence is not "safe".** It means the backtest found no problem on capacities
the history never tested. The MCP instructions tell agents to say so and recommend a load test.

### `suggest_changes`: what should we change?

```json
{ "goal": "both" }                                   // "reliability" | "cost" | "both"
{ "goal": "reliability", "traffic": { "scale": 2.2 } }  // what does launch day need?
```

With `traffic`, the history is replayed at that load (×`scale`, or `peakRps` at its busiest
moment) and every candidate is judged there. Candidates come from the history itself:

- **Fixes** for every service that ran at ≥ 85% of its capacity: one more replica (or double, from
  two), of the *host* when the service runs in-process (HotROD's mysql → more `customer`
  replicas). When CPU is the limit, it also tries twice the CPU and CPU autoscaling.
- **Memory** for a service whose history peaked at ≥ 90% of its limit (half again), and for one
  that leaks and is OOM-killed at the replayed load: twice the limit (the kill moves later, by what
  the extra holds) and twice the replicas (each container serves half the requests).
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

### `review_capacity`

The capacity review a platform team does by hand, in one call, every number replayed from the
history. The report opens with a five-line summary for whoever has to decide — risk, headroom,
cost, the one change to make, how far to trust it — and then the evidence:

- whether the recorded day itself held its SLO, replayed (`today`);
- the headroom over the busiest moment, and what saturates first;
- whether 1.5× and 2× today's traffic hold;
- what losing a node at the peak costs, the single points of failure and the backtested fix;
- the services held back by CPU quota throttling or close to their memory limit, and any that leak
  (with the requests until they are OOM-killed);
- how full the node pool runs;
- how much to commit to: the floor the history always ran (nodes, or replicas of list-priced
  services) and what a 1- or 3-year commitment saves on it — skipped when costs come from a bill;
- the fixes and savings that pass;
- `trust`: how many services the model explains, and which it doesn't, and which configuration each
  is fitted on where the history holds several (`trust.configurations`). A headroom set by a
  service it doesn't explain is flagged (`headroom.limitTrusted: false`) and read as a guess;
- `stability`: the headroom recomputed on each third of the history's traffic, calibrated alone.
  When the lowest and highest (the whole history's included) differ by more than half again, the
  summary says the headroom is uncertain, with the range and how many configurations the window
  mixes;
- a model that misses the SLO already at the bottom of the ramp has no headroom to read:
  `headroom.atAnyLoad` names the endpoints that miss it with almost no traffic, instead of a number
  and a service that never saturated.

Losing a node fails when it adds more than half a minute out of SLO **or** fails more requests than
the error budget allows over the outage. The second matters on a day that was already out of SLO
at its peak: no minutes can be added there, but the requests the node takes down still fail.

It writes `reports/capacity-review-<date>.md` into the workspace. On the Kubernetes reference it
takes about 6 seconds. It found the `email` service at 95% of its memory limit, which nobody had
noticed — and, since calibration reads leaks, that it leaks ~10 KB a request and is OOM-killed on
every launch day.

### `check_node_loss`

Kubernetes only. It replays the history's busiest moment with each node gone. Every pod on the node
disappears at once, using placement from `kube_pod_info` at the end of the history. A service with
no replica left is down; the rest serve on what's left. Kubernetes replaces the pods after
NotReady (~50 s), the default 300 s eviction toleration and a start: about 6 minutes. A fixed
pool with no room for them leaves them Pending. It returns, per node:

- what the node takes down;
- the minutes out of SLO and failed requests it adds;
- `ifCallersStayBroken`, where a service the node takes whole is called over gRPC (see **gRPC**
  above) by a caller that kept a replica: the same loss with that caller's calls to it failing
  252 s more after the replacement is up, with its minutes, failed requests and verdict. 252 s is
  how long the frontend's channel to cart stayed broken on the reference cluster (cart ready 348 s
  after its node stopped, the frontend's calls failing until it restarted at 600 s). That is one
  observation on one kind cluster, an assumption rather than a fit, and the main answer leaves it
  out. `cutShort` says the history ended before the callers would have reconnected.
  `review_capacity` reports the worst node's figure in one line under "Losing a node".

It also lists the services one node failure takes out entirely. With `zones: true` it loses a whole
availability zone at once. Zones come from the nodes' provider ids: AWS
(`aws:///us-east-1a/i-…`) and GCP put the zone there, Azure and kind don't. With a `strategy`, the strategy's
new replica counts are spread evenly over the nodes, as the default scheduler does.

`verify_change` runs it too, whenever the model knows the pod placement. It says when a change
leaves a service on one node, and compares the node that holds most of what the change touches,
lost at the busiest moment, as built and with the change. That comparison is a reason and a
`nodeLoss` field, not part of the verdict. The verdict is about the history as it happened; use
`check_node_loss` with the strategy to gate on failures. `suggest_changes` runs the same check and proposes the fix, then replays the loss of every node again
to prove it. The fix adds a second replica, spread over the nodes, for every service on a
request's path that one node takes down. Each degraded service gets enough replicas that what
survives the busiest node carries its peak at 85% of capacity. In a manifest, `spread: even` is
`topologySpreadConstraints` on `kubernetes.io/hostname`; diffs that add one are read as that
change. A datastore needs replication for its second replica to survive.

On the Kubernetes reference, the as-built shop fails either way. Losing a worker at the peak adds
6.5–7.3 minutes out of SLO and about 50,000 failed requests: 14 services run a single replica. The
suggested fix (a fourth frontend replica, a second for 12 services, all spread) survives the loss of
either node, at $0 a month on the reference's fixed node pool, which has room for them.

### `read_cluster`

```json
{ "context": "prod-eu", "namespace": "shop" }
```

Runs exactly `kubectl --context prod-eu -n shop get deployments,statefulsets,horizontalpodautoscalers -o json`.
The context is required, and the current context is never used implicitly. It saves the snapshot
in `.hindcast/cluster/` and returns replicas, limits, autoscalers and architecture per workload.
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

| signal | where Hindcast reads it | without it |
|---|---|---|
| request rate, errors, latency per service | Prometheus: OpenTelemetry Collector **spanmetrics** (`traces_span_metrics_*`), OpenTelemetry **HTTP server** metrics (`http_server_request_duration_seconds_*`, or the pre-1.0 `http_server_duration_milliseconds_*`) or **Spring Boot / Micrometer** (`http_server_requests_seconds_*`, by `application` tag or scrape job; p99 needs `percentiles-histogram`) | nothing to model |
| the same per endpoint, on entry services | the same metrics, by `span_name` or `http_route` | endpoint rates from traces, scaled by the measured sampling share |
| requests, errors, latency at the edge | **ingress-nginx** (`nginx_ingress_controller_*`, by backend Service). Requests to an Ingress without a host are only counted with `--metrics-per-undefined-host=true` | the entry service's rates come from span metrics, which undercount sparse series |
| CPU used, CPU limit, replicas, memory and its limit | **cAdvisor** (Docker Compose labels) or **Kubernetes** (kubelet cAdvisor + kube-state-metrics, grouped by the Deployment, StatefulSet or DaemonSet that owns each pod; CPU requests stand in where no limit is set; CFS throttling, peak working set, memory limits, requests and the nodes are collected) | capacity only from latency; resize strategies can't be priced |
| CPU quota throttling | cAdvisor `container_cpu_cfs_throttled_periods_total` / `container_cpu_cfs_periods_total` | capacity runs to 100% of the CPU limit, which a single-threaded runtime never reaches |
| memory at its peak, against its limit | cAdvisor `container_memory_working_set_bytes` (`max_over_time` per bucket); kube-state-metrics `kube_pod_container_resource_limits{resource="memory"}` | memory cuts are priced but can't be checked for OOM kills |
| nodes and requests | kube-state-metrics `kube_node_info`, `kube_node_status_allocatable`, `kube_node_role` (control-plane nodes left out), `kube_pod_container_resource_requests`, `kube_pod_status_phase` | Fargate list prices per replica; request cuts can't be told apart from savings |
| HorizontalPodAutoscalers | kube-state-metrics `kube_horizontalpodautoscaler_info`, `_spec_min_replicas`, `_spec_max_replicas`, `_spec_target_metric` at the end of the window | the node-loss fix sets fixed replicas instead of raising an HPA's minimum |
| pods per node, node zones | kube-state-metrics `kube_pod_info` (`node` label) at the end of the window; zones from `kube_node_info`'s `provider_id` on AWS and GCP | no node- or zone-loss checks |
| topology, self time per service | **Jaeger** (`/api/traces`), **Tempo** (`/api/search` + `/api/traces/{id}`), or OTLP / Jaeger JSON files | who calls whom from Istio, Linkerd, service-graph or span metrics, or a topology file; self time estimated from latency metrics ([Without traces](#without-traces)) |
| request rate, errors, latency from a mesh | **Istio** (`istio_requests_total`, `istio_request_duration_milliseconds_*`, destination side) or **Linkerd** (`response_total`, `response_latency_ms_*`, inbound) | from the app's own metrics, or none |
| cost | AWS CUR or GCP billing export (file) | AWS Fargate list prices from CPU and memory limits |

Older names are recognised and reported as `nearMisses` with what to do, but not read: spanmetrics
`calls_total` from the old processor. A recording rule that renames them makes them work. OpenTelemetry
HTTP metrics under the pre-1.0 name (`http_server_duration_milliseconds_*`, with `http_method` and
`http_status_code`) are read by the `http-server-legacy` preset. `selector`
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
  contain endpoint paths and service names. Keep `.hindcast/` out of version control
  (`.gitignore` it) if those are sensitive.
- **No network calls** except to the endpoints you configure.

## Workspace

```
.hindcast/
  sources.json        connections and system hints
  telemetry/          the last collection: metrics/*.json, traces/*.jsonl, hindcast.import.yaml
  dataset.json        the imported history
  model.json          the calibrated model (same format as `hindcast calibrate`)
  calibration.json    per service: history peak vs capacity, trust
  cluster/            read_cluster snapshots
  reports/            verify_change reports: .html, .md, .strategies.yaml, .hindcast.json (opens in the app)
```

The files are the CLI's formats, so everything an agent produced can be reopened by hand:
`hindcast backtest .hindcast/model.json .hindcast/dataset.json strategy.yaml --html r.html`,
or dropped on the app's Backtest screen.

## Tool reference

| tool | inputs | returns |
|---|---|---|
| `connect_telemetry` | `prometheus{url, selector?, namespaces?, presets?, tokenEnv?…}`, `jaeger{url}` \| `tempo{url}` \| `traceFiles[]` \| `topologyFile` (all optional), `bill{cur\|gcp, tag?}`, `system{name, slo, timeoutMs, rename, hostedBy, entry, ignore, exclude}` | probes, renames applied, `calls` (without traces), `problems`, `ready` |
| `collect_telemetry` | `last` \| `start`/`end` \| `windows[]`, `stepS?`, `maxTraces?` | window, coverage per service, endpoints, warnings |
| `calibrate_model` | `holdout?` (0.3), `slo?`, `timeoutMs?`, `listPrices?` | services with capacity, band, limit, basis, cost; accuracy; trust lists |
| `model_status` | — | what the workspace holds, warnings, next step |
| `verify_change` | `changes[]`, `last?`, `traffic?{scale \| peakRps}`, `gateMinutes?`, `draws?` (30, fewer on long histories to fit ~40 s) | per change: verdict, confidence, cost, reliability, headroom, reasons; reports and `app.open` |
| `suggest_changes` | `goal?` (reliability \| cost \| both), `traffic?` ({scale} \| {peakRps}), `last?`, `draws?`, `gateMinutes?`, `idleBelow?` | saturated services; fixes and savings that pass, each judged; the savings combined; rejected candidates |
| `find_headroom` | `strategy?` | req/s within SLO, what binds, history peak |
| `review_capacity` | `draws?` | headroom, 1.5× and 2× load, node loss and its fix, throttled and memory-bound services, node pool fill, fixes and savings; a Markdown report |
| `check_node_loss` | `strategy?`, `traffic?{scale \| peakRps}`, `recoverS?`, `zones?` | per node: services lost or degraded, minutes out of SLO and failed requests added, and with gRPC callers the same if they stay broken 252 s more; single points of failure |
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

**Claude Code, headless, given only this** (and `--allowedTools mcp__hindcast`):

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
- Without traces, the review rests on the estimates under [Without traces](#without-traces).
  **Tested live** on the reference kind cluster
  ([reference/k8s](../reference/k8s/README.md#without-traces-live), one 25-minute ordinary day,
  against a traced run over the same window):
  - span metrics with the peer labels found 14 of the traces' 15 call edges. They miss shipping →
    quote, because the Rust HTTP client's span carries no peer attribute.
  - the service graph found 13. It can't name Valkey (`redis`, from `db.system`) or flagd (`unknown`).
  - Calls per request: the service graph came within 4% of what each service served. Span metrics
    were 12–15% low for cart and product-catalog (the frontend's gRPC client spans undercount), and the
    traces 2× high for ad and recommendation.
  - Headroom: 361–363 req/s without traces, frontend first; 411 req/s with them, recommendation first.
  - Held-out p99: a typical error of 49–50% per 30 s bucket from either source. The traced run had
    no held-out check on this window.
  - valkey-cart and flagd, which have no spans, were modelled from CPU alone through their peer
    labels.

  **Still mocks only**:
  - Linkerd and Istio: there is no mesh on the reference cluster.
  - A service-graph virtual node named by host.
  - Peer labels in Kubernetes DNS form (`cart.shop.svc.cluster.local:8080`): the reference services
    call each other by bare Service name.
  - The CPU-only resize and the CPU-only confidence rule: no change was made for real.
- A CPU-only service keeps calibration's wide queue (32 at a time), which still waits a little as
  it nears its capacity (the M/M/c wait of that width): a stand-in, not a measured latency.
- Prometheus-compatible only (Prometheus, Thanos, Mimir, Cortex, VictoriaMetrics, Amazon Managed
  Prometheus behind a SigV4 proxy). CloudWatch works through files with the CLI
  ([backtest.md](backtest.md#1-data-in)).
