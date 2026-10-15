# Capabilities — the complete list

Everything Hindcast does, grouped, with where to find it (**A** app, **C** CLI, **M** MCP server)
and where it is documented.

## Real data in

| capability | where | docs |
|---|---|---|
| Prometheus `query_range` JSON (any metric, by any label; endpoint and method labels) | A C | [backtest.md §1](backtest.md#1-data-in) |
| Prometheus export presets: `otel-spanmetrics`, `http-server`, `cadvisor`, `kubernetes`, with a label selector | C | [tools.md](tools.md#backtesting-on-real-data) |
| CloudWatch `get-metric-data` output (by Id or Label; count-per-period, % of N vCPU) | A C | [backtest.md §1](backtest.md#1-data-in) |
| Long CSV (timestamp, service, metric, value[, endpoint]) and wide CSV / Grafana exports | A C | [backtest.md §1](backtest.md#1-data-in) |
| Units: s, ms, µs, percent, ratio, cores, millicores, rpm, count-per-period | A C | [backtest.md §1](backtest.md#1-data-in) |
| OpenTelemetry traces (OTLP JSON lines from the collector, one OTLP document) and Jaeger JSON; streamed, any size | A C | [calibration.md §2](calibration.md#2-traces--topology) |
| AWS Cost and Usage Report (legacy and 2.0) and GCP billing export (CSV or JSON lines), by tag or resource id | A C | [calibration.md §4](calibration.md#4-cost-from-the-bill) |
| Renaming across sources; zones/regions per service; SLOs, deadline, in-process dependencies, per-endpoint SLOs as hints | A C | [backtest.md §1](backtest.md#1-data-in) |
| Drop files in the app or `import` in the CLI: one dataset on a time grid, with a log of what each source gave | A C | [guide.md](guide.md#backtest) |

## Calibrated model

| capability | docs |
|---|---|
| Topology from traces: visits, call graph, critical path, self time, payload sizes, uninstrumented databases/caches/queues as components | [calibration.md §2](calibration.md#2-traces--topology) |
| Endpoint names from route templates, framework spans or templated paths | [calibration.md §2](calibration.md#2-traces--topology) |
| Corrections: framework double SERVER spans, measured sampling rate, background work skipped | [calibration.md §2](calibration.md#corrections-applied-after-import) |
| CPU per request (regression with standard error) | [calibration.md §3](calibration.md#cpu-per-request) |
| Capacity per replica: none / CPU-bound / worker pool (M/M/c) / lock or connection pool (c / hold time) / seen while overloaded | [calibration.md §3](calibration.md#capacity--what-limits-a-replica) |
| Knees and metastable failures read from overloads in the history; CPU-pinned collapses scale with cores | [calibration.md §3](calibration.md#capacity--what-limits-a-replica) |
| Queues outside the spans (busy event loops) read from CPU and end-to-end latency | [calibration.md §3](calibration.md#capacity--what-limits-a-replica) |
| Service-time variability (Allen–Cunneen), latency tails, lognormal endpoint latency | [calibration.md §3, §5](calibration.md#5-per-endpoint) |
| Errors that grow with load; baseline errors | [calibration.md §5](calibration.md#5-per-endpoint) |
| Capacity bands (bootstrap, CPU slope error, knee bracket, extrapolation spread) | [calibration.md §3](calibration.md#capacity-bands) |
| Cost from the bill: $ per replica-hour, per request, per GB; unattributed spend shown | [calibration.md §4](calibration.md#4-cost-from-the-bill) |
| Fit status per component and endpoint (good / fair / poor / unexplained / cost only) with notes | [calibration.md §6](calibration.md#6-fit-quality--what-the-model-cant-explain-is-flagged) |
| Holdout accuracy and accuracy against recorded runs, shown in the app, CLI and every report | [calibration.md §7](calibration.md#7-accuracy) |

## Backtest

| capability | where | docs |
|---|---|---|
| Strategies as YAML: replicas, autoscaling (min/max, target, warm-up, cool-down, interval, metric window), CPU/memory resize, Graviton, performance factor, capacity override, cache, read replicas, zone/region, retries with budget, client timeout | A C M | [backtest.md §3](backtest.md#3-strategies) |
| Strategies from the board (*Backtest these edits*), from audit fixes, from Kubernetes manifest diffs | A C | [backtest.md §3](backtest.md#3-strategies) |
| Replay: endpoint traffic → visits → queueing with backlog → critical-path latency → deadline failures → cost; autoscalers on their own clock | A C M | [backtest.md §4](backtest.md#4-the-backtest) |
| Results with 10–90% bands from 30 paired draws: $/month, minutes out of SLO, failed requests, error budget, worst moment and why, incidents, per-endpoint results, ranking | A C M | [backtest.md §4](backtest.md#4-the-backtest) |
| Data transfer priced across zones, regions and to the internet | A C M | [calibration.md §4](calibration.md#4-cost-from-the-bill) |
| Chart-first screen: measured p99, as-built replay, changes with bands, errors, cost, out-of-SLO shading; zoom; changes tested, verdict first; tester tabs | A | [guide.md](guide.md#backtest) |
| Any moment opens on the board as a replay | A | [guide.md](guide.md#backtest) |
| Headroom: req/s sustained within SLO and what saturates next | C | [use-cases.md §5](use-cases.md#5-find-the-breaking-point-and-the-headroom) |
| Reports: terminal, Markdown, self-contained HTML, PR comment | C M | [backtest.md §5](backtest.md#5-surfaces) |
| Pull-request check: workflow, manifest diff → strategy, comment, gate | CI | [examples/backtest-ci](../examples/backtest-ci/README.md) |
| Public-outage replays: Cloudflare 2019, GitHub 2018, Slack 2021, AWS us-east-1 2025, with roles, assumptions and sources | A C M | [backtest.md §6](backtest.md#6-public-outage-replays) |
| Studio cards and clips of backtest results | A C | [backtest.md §5](backtest.md#5-surfaces) |
| Three reference systems with recorded telemetry and measured accuracy | A | [reference/README.md](../reference/README.md) |

## Design simulator

| capability | where | docs |
|---|---|---|
| Live failing system with next moves | A | [guide.md](guide.md#live) |
| Seven lessons, 22 levels with engine-checked objectives; every level proven winnable by a test; show me, debriefs, saved progress | A | [guide.md](guide.md#lessons) |
| Sandbox: 22 component kinds (incl. a key-value store, DNS with TTL-lagged failover, a pub/sub stream, a search index, a vector database, cold archive and edge functions), zones, link latency, templates, per-component runtimes, autoscaling, retries, timeouts, breakers, bounded queues, routing, fan-out, batching, calibration from production numbers | A | [guide.md](guide.md#sandbox), [catalog.md](catalog.md) |
| Chaos: kill, faults (errors, latency, capacity), cache flush, zone failure; traffic patterns and spikes; real traffic from a CSV | A C | [guide.md](guide.md#sandbox) |
| Flight recorder: rewind the whole board; incident timeline as Markdown | A | [tools.md](tools.md#app) |
| Architecture as code: YAML spec, two-way synced; validate and lint | A C M | [spec.md](spec.md) |
| Import from Terraform (`terraform show -json`) and Kubernetes manifests, with assumptions | A C M | [tools.md](tools.md) |
| Failure audit: risk register, blast radius, recovery time, $ at risk, verified and priced fixes, one-click apply, CI gate | A C M | [tools.md](tools.md#failure-audit) |
| Compare: two designs, same scenario, engine-computed takeaway; 32 built-in comparisons | A C M | [guide.md](guide.md#compare) |
| Monte Carlo with confidence intervals, breaking-point search, cost optimizer | A C M | [analysis.md](analysis.md) |
| Two engines: fluid (fast, live) and discrete-event (every request; real tails, retry storms) | A C M | [engines.md](engines.md) |
| Pricing: illustrative, AWS us-east-1, GCP us-central1 | A C | [catalog.md](catalog.md) |
| Present mode, embeds (`?embed=1`), share links (`#spec=`, `#compare=`) | A | [tools.md](tools.md#app-links) |
| One look (Terminal) with live motion; replicas grouped or each | A | [content.md](content.md#themes-srctheme) |

## Content

| capability | where | docs |
|---|---|---|
| Studio episodes: single or A/B boards, captions, camera moves, live graph swaps | A | [content.md](content.md) |
| Episodes from comparisons and audit incidents | A | [content.md](content.md) |
| Rendering: MP4, PNG stills, PDF carousel, GIF; 4:5, 1:1, 9:16, 16:9; brands; themes | C | [content.md](content.md#rendering-video-and-carousels) |

## Integrations

| capability | docs |
|---|---|
| MCP server (stdio) with 23 tools, including backtests and outage replays | [tools.md](tools.md#mcp-server--npm-run-mcp) |
| Agent tools: `connect_telemetry` (probes Prometheus presets, services, traffic history; Jaeger/Tempo services, entry services, load generators; renames), `collect_telemetry` (a window, traces spread over it), `calibrate_model` (trust report), `verify_change` (verdict + confidence + evidence + HTML report + a link that opens it on the backtest screen), `suggest_changes` (fixes for what saturated and savings for what idled, backtested, the safe savings tried together), `find_headroom`, `verify_design`, `read_cluster`, `model_status` | [agents.md](agents.md) |
| Changes from Terraform plans (ECS, app autoscaling, ASG/EC2, RDS, Cloud Run, kubernetes_*), Kubernetes diffs, and edited manifests against a read-only cluster snapshot | [agents.md](agents.md#4-verify_change-the-verdict) |
| AWS Fargate list prices from CPU and memory limits when there is no bill | [agents.md](agents.md#how-confidence-is-decided) |
| Every agent tool from a shell (`hindcast agent <tool> '<json>'`), MCP prompts, a Claude Code skill, the MCP server in the same binary (`hindcast mcp`) | [agents.md](agents.md#set-up), [examples/agents](../examples/agents/README.md) |
| Live canvas inline in MCP Apps hosts | [tools.md](tools.md#live-canvas-mcp-apps) |
| VS Code extension: the live board beside a YAML spec (edits follow as you type, a click on the board jumps to the line), validation as squiggles on the value at fault, p99, errors and $/month in the status bar, the failure audit as a Markdown preview, schema completion; WebAssembly engine bundled, or the CLI | [vscode.md](vscode.md) |
| GitHub Actions: architecture audit and backtest PR checks | [tools.md](tools.md#in-ci), [examples/backtest-ci](../examples/backtest-ci/README.md) |
| One native binary for the CLI, agent tools and MCP server (`engine-rs/target/release/hindcast`) | [tools.md](tools.md#backtesting-on-real-data) |
