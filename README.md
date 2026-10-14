# Hindcast

Backtest infrastructure changes on your real production data before they ship — and an
architecture simulator that tells you what breaks first, and what it costs.

**Backtesting** (the app's Backtest tab, the CLI and a pull-request check): import metric exports
(Prometheus, CloudWatch), OpenTelemetry traces and the cloud bill (AWS CUR, GCP export); Hindcast
builds a model of the system calibrated from them and shows how well each component is explained;
then any change — resize, autoscaling policy, a cache, a replica, a retry budget, Graviton — is
replayed over the real history as "what would have happened": $ saved or spent, minutes out of SLO,
failed requests, the worst moment and why, with confidence bands. Famous public outages replay
against your model too. Accuracy is measured against real runs of three open demo systems
([reference/](reference/README.md)). Guide: [docs/backtest.md](docs/backtest.md).

**On Kubernetes** it reads what the cluster already exports (kube-prometheus-stack, ingress-nginx,
OpenTelemetry). From that it covers the questions a platform team answers by hand:

- **CPU quota throttling:** a service caps out before its CPU limit, so capacity stops there.
- **Memory:** a lower limit OOM-kills pods in the replay.
- **Nodes:** request cuts save money only if nodes go; fixed and autoscaled pools are told apart,
  and scale-outs wait for a node.
- **Node or zone loss:** what one failure at the busiest moment takes down, the single points of
  failure, and the replicas that survive it.
- **`review_capacity`:** all of it in one report.

It was validated on a real cluster serving real traffic:

- **In-sample:** five decisions answered from an ordinary day, then made for real. The throttle
  rules were designed on these runs.
- **Out of sample:** four more, predicted and committed before they ran.
- **A node failure:** a node stopped at the peak.

See [reference/k8s](reference/k8s/README.md).

Draw a system (or import it from Terraform or Kubernetes manifests, or paste a YAML spec), push traffic and failures through
it, and watch where it gives out. Then run the failure audit: every component dying, every dependency
turning slow, caches restarting cold, zones going dark, a traffic surge. Each incident is graded by what
users would have seen, and each fix is verified by re-running the same incident and priced in $/month.

**For AI agents** ([docs/agents.md](docs/agents.md)): give Claude Code (or any MCP host, or any
agent with a shell) the Hindcast tools and it does the work itself. It connects to your Prometheus
and Jaeger or Tempo, collects a week of history, calibrates the model, reads its trust report, and
verifies a change before proposing it: a strategy, a Kubernetes diff or a Terraform plan. The
answer is a verdict (pass / fail / inconclusive) with a confidence that says which services the
change pushes past anything the history showed, the money with its basis, and the SLO minutes.
Read-only towards your systems.

It runs in four places over the same engine: a visual app, a CLI, an MCP server, and agent tools
on both.

```
npm install
npm run dev            # app on http://localhost:5173
npm run sim -- …       # CLI (headless engine)
npm run mcp            # MCP server (stdio); Claude Code picks it up from .mcp.json
npm test               # engine, spec and audit tests
```

User guide: the app's **Docs** button, or http://localhost:5173/docs/index.html — every view
explained screen by screen (source: `docs-site/pages/`; `npm run docs:shots` recaptures the
screenshots from a running app, `npm run docs:build` rebuilds the pages).

Documentation: [docs/](docs/README.md) — start with the [guide](docs/guide.md) (every view of the
app), [use cases](docs/use-cases.md), the [capability list](docs/capabilities.md) and
[calibration](docs/calibration.md) (how a model is fitted from real telemetry).

## What's in the app

- **Backtest** – real history as a chart, strategies drawn over it, ranked; open any
  moment on the board; Studio card of the result.
- **Live** – a running system that fails on arrival, with the next move pinned to the component under stress.
- **Lessons** – a study path of 14 lessons, 44 levels, in four tracks: scaling a web service (Scale
  101/201, Pastebin, Mint, sizing a cache), asynchrony and failure (queues, retry storms, elasticity,
  zones), data at scale (CAP with sync/async replication and partitions, sharding and hot keys, a web
  crawler), and AI serving and runtimes. Every level has a reference solution ("show me"), a debrief
  and saved progress; each is proven solvable in the tests.
- **Sandbox** – build anything. Autoscaling, retries, timeouts, breakers, failover, fan-out, gray
  failures, cross-region links. Every run is recorded; drag the timeline to rewind the whole board.
- **Failure audit** – risk register with blast radius, recovery time and $ at risk; replay any incident
  on the board; apply a verified fix with one click (undoable); copy the report as Markdown.
- **Architecture as code** – a YAML editor that stays in sync with the board in both directions.
- **Compare** – two designs, same traffic and failures, side by side, with a measured scoreboard and a
  takeaway computed by the engine. Twenty-three built-in comparisons, each proven to show a difference.
- **Present** – press P: no chrome, large numbers, captions; ←/→ walks through the audit's incidents live.
- **Studio** – scripted episodes rendered in the browser to MP4, GIF and a PDF carousel for posts
  (or frame-perfect from the command line with `npm run record`).
- **Agents** – an MCP server and CLI so an agent can connect to Prometheus and Jaeger/Tempo, calibrate,
  and verify an infrastructure change against real history (`npm run sim -- agent setup`).

⌘K opens the command palette. ⌘Z undoes. ⌘S saves the design locally. Drop a spec, Kubernetes
manifests or a `terraform show -json` file on the board to open it. `?` lists the shortcuts.

## The engines

Two engines take the same inputs:

- **fluid** (`src/sim/engine.ts`) – request volume per 50 ms tick through a queueing model. Fast enough
  for the live board, breaking-point search, the optimizer and the audit (≈ 1 ms per simulated second).
- **discrete-event** (`src/sim/des/`) – every request simulated: real p50/p99/p99.9, retry storms,
  timeouts and breaker oscillation emerge rather than being approximated; seeded and deterministic;
  Monte Carlo with confidence intervals.

Both model routing (split / fan-out / failover), retries (immediate / backoff / budget), deadlines,
circuit breakers with fallback, bounded queues, DB failover to replicas, zones, language runtimes,
serverless cold starts, GPU inference and hosted LLM APIs, target-tracking autoscaling with warm-up,
cache warmth, injected errors and latency, and network latency per link. The test suite checks that
the two engines agree where they should.

Results are directional: good for comparing designs, finding bottlenecks and teaching. Calibrate
`capacity`, `latencyMs` and `costPerHour` per component (or use `pricing: aws-us-east-1`) before making
claims about a real system.

## Spec

```yaml
version: 1
name: Web shop
pricing: aws-us-east-1
components:
  - { id: users, kind: client, retries: 2, retryPolicy: budget, timeoutMs: 1000 }
  - { id: lb, kind: lb }
  - id: api
    kind: server
    instances: 4
    runtime: go
    autoscale: { min: 4, max: 16, warmupS: 20 }
  - { id: redis, kind: cache, hitRate: 0.9 }
  - { id: db, kind: db, tier: M }
  - { id: db-replica, kind: replica, tier: M }
connections:
  - [users, lb]
  - [lb, api]
  - [api, redis]
  - { from: redis, to: db, latencyMs: 1 }
  - [db, db-replica]
zones:
  - { id: az-a, label: us-east-1a, members: [api, db] }
```

Scenarios add traffic (constant or keyframes), timed events (`kill-id`, `fail-zone`, `degrade`,
`inject-errors`, `inject-latency`, `flush-cache`, …) and an SLO. Variants are edit lists against a base.
Full reference: [docs/spec.md](docs/spec.md).

## CLI

```
npm run sim -- audit            examples/shop.yaml --rps 500 --cost-per-min 1000 --md report.md
npm run sim -- simulate         examples/shop.yaml examples/black-friday.yaml [--engine des]
npm run sim -- simulate         examples/shop.yaml --traffic examples/traffic-day.csv --duration 240
npm run sim -- compare          examples/shop.yaml examples/shop-variants.yaml examples/black-friday.yaml
npm run sim -- analyze          examples/shop.yaml --rps 800 --runs 24
npm run sim -- optimize         examples/shop.yaml examples/black-friday.yaml --out optimized.yaml
npm run sim -- breaking-point   examples/shop.yaml
npm run sim -- import-terraform examples/terraform/shop.tfstate.json --out shop.yaml
npm run sim -- import-k8s       examples/kubernetes/shop.yaml --out shop.yaml
npm run sim -- link             examples/shop.yaml
```

`audit` exits with code 2 when it finds a critical incident, so it can gate a pull request that
changes an architecture spec. Every command takes `--json`.

## MCP server

Agents working on a live system: `connect_telemetry` → `collect_telemetry` → `calibrate_model` →
`verify_change` (plus `suggest_changes`, `find_headroom`, `verify_design`, `read_cluster`, `model_status`); see
[docs/agents.md](docs/agents.md). The server is the `hindcast` binary itself (`npm run cli:build` →
`engine-rs/target/release/hindcast`): `claude mcp add hindcast -- …/hindcast mcp`, or
`hindcast agent setup` for any host.

| tool | |
|---|---|
| `audit_resilience` | what breaks first, and what it costs: risk register, verified + priced fixes, Markdown report |
| `simulate` / `analyze` | one run (fluid or DES) / Monte Carlo with confidence intervals |
| `compare_architectures` | baseline and variants under one scenario, ranked |
| `find_breaking_point` | max req/s within SLO and the limiting component |
| `optimize_cost` | cheapest sizing that meets the SLO |
| `import_terraform` / `import_kubernetes` | `terraform show -json` or k8s manifests → spec + assumptions to confirm |
| `show_architecture` / `open_in_app` | live canvas in MCP Apps hosts / a link into the app |
| `list_components` / `validate_architecture` | catalogue / schema + lint |

Details: [docs/tools.md](docs/tools.md).

## Credits

Several lessons, comparisons and the back-of-the-envelope presets are built on the problems and topics
of [The System Design Primer](https://github.com/donnemartin/system-design-primer) by Donne Martin,
licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The wording and the simulations
are our own; each lesson based on it says so under its picker.
