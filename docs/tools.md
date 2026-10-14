# Tools: CLI, MCP server, app links, Analysis panel

## CLI — `npm run sim -- <command>`

| command | what it does |
|---|---|
| `validate <arch>` | schema + lint (exit code 1 on errors) |
| `simulate <arch> [scenario] [--rps N] [--duration S] [--engine fluid\|des] [--seed N]` | one run; summary, bottlenecks with explanations, events; DES adds p50/p90/p99/p99.9 |
| `analyze <arch> [scenario] [--runs 20] [--seed 1]` | discrete-event Monte Carlo with 95 % CIs, in parallel threads |
| `compare <arch> <variants> [scenario]` | baseline + variants ranked (SLO first, then cost) with each one's top bottleneck |
| `breaking-point <arch> [--p99 300] [--errors 0.01]` | max sustainable req/s and the limiting component |
| `audit <arch> [--rps N] [--cost-per-min $] [--md report.md]` | **failure audit**: what breaks first and what it costs — see below; exit code 2 when anything is critical (use it in CI) |
| `optimize <arch> [scenario] [--runtimes] [--p99 …] [--out file.yaml]` | cheapest sizing that meets the SLO; writes the optimized spec with `--out` |
| `import-terraform <terraform-show.json> [--name …] [--out arch.yaml]` | Terraform state/plan JSON → spec (AWS-priced) + assumptions to review |
| `import-k8s <manifests.yaml …> [--name …] [--out arch.yaml]` | Kubernetes manifests → spec (HPAs become autoscaling) + assumptions to review |
| `link <arch> [variants]` | URL that opens the architecture (or a comparison) in the app |
| `catalog` | component catalogue as JSON |
| `agent <tool> '<json>' \| @file \| -` | any agent tool from a shell, JSON in and out (`agent list`); see [agents.md](agents.md) |

### Backtesting on real data

| command | what it does |
|---|---|
| `export-prometheus --url … --start … --end … [--step 60] [--preset otel-spanmetrics,http-server,cadvisor,kubernetes] [--selector 'namespace="shop"'] --out dir/` | runs the preset queries against a Prometheus and writes query_range JSON plus the `metrics:` block of an import manifest |
| `import <hindcast.import.yaml> [--out dataset.json]` | metric exports, traces and bills → one dataset on a time grid; prints what each source gave |
| `calibrate <dataset.json> [--out model.json] [--p99 500] [--errors 0.01] [--timeout 5000] [--holdout 0.3]` | fits the model; prints every component with its capacity, limit, fit status and notes; `--holdout` adds an accuracy record |
| `backtest <model.json> <dataset.json> <strategy.yaml …> [--last 14d] [--draws 30] [--md r.md] [--html r.html] [--comment pr.md] [--card card.json] [--gate]` | replays the strategies over the history: $/month, minutes out of SLO, failed requests, worst moment and why, incidents, per-endpoint results, ranking; `--gate` exits 2 if a strategy adds time out of SLO |
| `headroom <model.json> [strategy.yaml]` | req/s sustained within SLO with today's endpoint mix, and what saturates next |
| `accuracy <model.json>` | the model's accuracy records against the targets |
| `outage <model.json> <outage-id \| list> [strategy.yaml …] [--rps N] [--role primary-db=orders-db]` | replays a public outage against the model, as built and with strategies |
| `diff-strategy --base <dir> --head <dir> [--model model.json] [--out strategy.yaml]` | Kubernetes manifests before/after → a strategy (replicas, CPU/memory, HPAs, arch) |

Guide: [backtest.md](backtest.md); the model: [calibration.md](calibration.md). A standalone build
of the CLI (`npm run build:cli` → `dist-cli/hindcast.mjs`, Node 20, no install) is what the PR
workflow ships.

Every command accepts `--json`. Files may be YAML or JSON. Examples live in `examples/`:

```bash
npm run sim -- simulate examples/shop.yaml examples/black-friday.yaml --engine des
npm run sim -- compare  examples/shop.yaml examples/shop-variants.yaml examples/black-friday.yaml
npm run sim -- analyze  examples/shop.yaml --rps 800 --runs 24
npm run sim -- optimize examples/shop.yaml examples/black-friday.yaml --runtimes --out optimized.yaml
npm run sim -- link     examples/shop.yaml examples/shop-hypothesis.yaml
npm run sim -- import-terraform examples/terraform/shop.tfstate.json --out shop.yaml
```

`HINDCAST_APP_URL` (default `http://localhost:5173`) controls generated links. The CLI is `hindcast`
(`bottleneck` still works as an alias), and every `HINDCAST_*` variable falls back to the old
`BOTTLENECK_*` name.

## MCP server — `npm run mcp`

Registered for Claude Code in `.mcp.json` (restart Claude Code in this folder and approve
`hindcast`). Transport: stdio. The server sends usage instructions on initialise.

| tool | inputs | returns |
|---|---|---|
| `list_components` | — | catalogue: kinds, numbers, tiers, runtimes, modelling notes |
| `validate_architecture` | `architecture` | `{ ok, issues[], spec }` |
| `simulate` | `architecture`, `scenario?`, `engine? fluid\|des`, `seed?`, `include_timeline?` | summary, SLO, bottlenecks (+ explanations), events, components |
| `analyze` | `architecture`, `scenario?`, `runs?` | Monte Carlo metrics with CIs, pSloMet, bottleneck frequencies |
| `compare_architectures` | `architecture`, `variants[]`, `scenario?` | ranked variants + per-variant summaries |
| `find_breaking_point` | `architecture`, `readRatio?`, `slo?` | max req/s within SLO, limiting component |
| `optimize_cost` | `architecture`, `scenario?`, `allow_runtimes?`, `slo?` | before/after cost, savings, changes as a ready variant, log, verification |
| `audit_resilience` | `architecture`, `rps?`, `read_ratio?`, `slo?`, `incident_cost_per_minute?` | resilience score, headroom, ranked risk register with blast radius and recovery, verified + priced fixes, Markdown report |
| `import_terraform` | `terraform_json`, `name?` | spec, assumptions, skipped resources, lint |
| `import_kubernetes` | `manifests_yaml`, `name?` | spec, assumptions, skipped objects, lint |
| `show_architecture` | `architecture`, `compare_with?`, `scenario?` | **live canvas**: renders the simulation inline in MCP Apps hosts (Claude, ChatGPT…); text + link elsewhere |
| `open_in_app` | `architecture`, `compare_with?` (variant), `scenario?` | URL for the app (sandbox, or side-by-side comparison playing the scenario) |
| `backtest_strategy` | `model?`, `dataset?` (paths; default the workspace's), `strategies[]` (objects or YAML), `last?`, `draws?` | the backtest of each strategy over the recorded history: $/month, minutes out of SLO, worst moment, incidents, ranking, the model's accuracy |
| `replay_outage` | `model?`, `outage`, `strategies?`, `rps?` | a public outage replayed against the model, as built and with strategies |
| `connect_telemetry` … `read_cluster` | see [agents.md](agents.md#tool-reference) | nine tools for an agent working on a live system: connect, collect, calibrate, verify (strategies, Kubernetes diffs, Terraform plans), suggest fixes and savings, headroom, design checks, cluster snapshots, status |

Prompts: `verify-infra-change` and `check-my-design` ([agents.md](agents.md#prompts)).

Suggested assistant workflow for a live system: `model_status` → `connect_telemetry` → `collect_telemetry` →
`calibrate_model` → `verify_change` ([agents.md](agents.md)). For a design on paper: `import_terraform` (or `list_components` → write the spec from the user's description
from k8s manifests, diagrams, metrics) → confirm assumptions, request rates and SLOs with the user → `validate_architecture` → `simulate`/`analyze` the
current state → propose variants → `compare_architectures` / `optimize_cost` → `open_in_app` to hand
over a live demo.

### Live canvas (MCP Apps)

`show_architecture` is an MCP Apps tool: hosts that support the extension render the full app inline
and play the architecture or comparison immediately. The UI is a single-file build of the app
served as `ui://hindcast/canvas.html`:

```
npm run build:mcp      # → dist-mcp/mcp-app.html (rebuild after app changes)
```

Hosts without UI support (e.g. the Claude Code terminal) get a text summary and an app link.
Inside the canvas the Analysis panel's web workers are not available (they are separate files);
use the `analyze` / `optimize_cost` tools instead.

## Failure audit

`audit` replays one minute at the expected load once per thing that goes wrong in production, and
grades what users would have seen:

| incident | for |
|---|---|
| one instance dies / the component goes down | every component (fleets lose one instance; singletons die) |
| zone goes dark | every zone |
| turns slow (+250 ms) | every component except lb/queue |
| fails 20 % of requests | every component except lb/queue/cdn |
| restarts cold | every cache / CDN |
| traffic surges 3× for 20 s | once |
| load ramps past the breaking point | headroom = breaking point ÷ expected load |

Timeline per incident: warm-up 0–10 s, fault at 10 s, cleared at 40 s, observed to 60 s.
Severity: **critical** (≥ 25 % of requests failing, or never recovering after the fault clears — a
metastable failure), **major** (out of SLO for more than 3 s), **minor** (a blip, or healed by itself
within 8 s with < 5 % errors — failover, autoscaling), **ok**. The resilience score is the share of
incidents survived, weighted by severity.

For every major/critical incident, candidate fixes are generated (N+1 instances, a load balancer in
front, a read replica, a standby, a cache bypass, timeouts + breakers with fallback, retry budgets,
capacity, autoscaling, a bigger origin for cold caches), **each verified by re-running the same incident
on the changed design**, and priced in $/month against the current design. Fixes that do not help are
dropped. In the app: shield button in Sandbox → risk register, risk marks on the board, *Replay on the
board* plays an incident live, *Apply* applies a fix (undoable), *Copy report* gives Markdown.

### In CI

`audit` exits with code 2 when an incident is critical, so it can gate pull requests that change an
architecture spec. `examples/ci/architecture-audit.yml` is a GitHub Actions workflow that runs the audit
on the changed spec, comments the Markdown report on the PR, uploads the HTML report and fails the check
on critical findings.

## App

| feature | how |
|---|---|
| Command palette | ⌘K — every command, component, design, template, lesson, chaos action; type a number to set traffic |
| Undo / redo | ⌘Z / ⇧⌘Z (board edits, applied fixes, YAML edits) |
| Designs | the design name in the top bar: save (⌘S), save a copy, open file, download YAML, share link, saved designs, templates. The sandbox autosaves locally |
| Open files | drop a spec (.yaml/.json) or `terraform show -json` output anywhere on the board |
| Architecture as code | `</>` button: YAML editor two-way synced with the board, inline errors and lint |
| Flight recorder | every Sandbox run is recorded; drag the track above the controls to rewind the whole board; ←/→ step, Esc back to live |
| Cost & error budget | click the metrics: $/month per component, $ per million requests, burn rate against a 30-day SLO |
| Present mode | P — chrome-free board, large numbers, event captions; with an audit, ←/→ replays each incident live; F fullscreen |
| Faults | select a component → *fault…*: 10/50 % errors, +100/500/2000 ms, 50 % capacity, flush cache, restore |
| Links | select a connection → network latency preset |
| Calibrate | select a component → *calibrate*: one instance served R req/s at C % CPU with p50 L ms and costs $/h → capacity, latency and price overrides that reproduce it at the current size and runtime |
| Audit in Compare | *audit* on each side's header: score, incidents survived, headroom, cost and the top risks with their fixes, at the scenario's peak load |
| Studio clip | in the audit, *Studio clip* turns an incident into an episode (as built vs fixed, same incident); render it with `npm run record -- --ep-file <file>.json` |
| Replay real traffic | drop a CSV (time, req/s — Prometheus / CloudWatch / Datadog exports) on the board; long series are time-compressed to ~5 min (the factor is shown). CLI: `simulate <arch> --traffic metrics.csv` (real time up to an hour) |
| Timeline export | *copy timeline* on the recorder: the run as a postmortem-style Markdown timeline |

## App links

`?embed=1` (+ `&rps=800`, `&theme=reference`) with `#spec=…` shows only the running board, its numbers
and a traffic slider — for an `<iframe>` in a blog post, docs or slides. *Copy embed code* in the design
menu produces the snippet.

| hash | opens |
|---|---|
| `#backtest` | the Backtest tab |
| `#backtest=<url>` | the Backtest tab with a workspace bundle fetched from `<url>`: what an agent's `verify_change` returns as `app.open` |
| `#spec=<base64url(JSON spec)>` | Sandbox with the spec auto-laid-out |
| `#compare=<base64url({ a: {title, spec}, b: {title, spec}, scenario? })>` | Compare mode; with a scenario it plays like a built-in comparison and ends with a takeaway computed by the engine |

The design menu's *Copy spec* / *Copy share link* export the current board (`graphToSpec`).

## Analysis panel (app)

Flask button in the top bar (Sandbox and Compare). Runs in web workers:

- **Run Monte Carlo** — Sandbox: current traffic for 60 s (optionally killing the busiest server at
  30 s); Compare: the selected scenario, per side with that side's events.
- **Find breaking point** (Sandbox).
- **Find cheapest config meeting SLO** (Sandbox) with optional runtime changes; **Apply to board**
  applies the changes; hints explain structural blockers.
