# Bottleneck

A system-design simulator: build architectures, push traffic and failures through them, watch
where they break — in a visual app, from the command line, or from an AI assistant over MCP.

```
npm install
npm run dev            # visual app on http://localhost:5173
npm run sim -- …       # headless engine (CLI)
npm run mcp            # MCP server (stdio) — Claude Code picks it up from .mcp.json
npm run build:mcp      # single-file app for the MCP live canvas (show_architecture)
npm run record -- …    # render a studio episode to MP4 / PNG carousel
```

Full documentation: [docs/](docs/README.md) — architecture, engines, spec, catalog, analysis,
tools (CLI/MCP), content authoring.

## The engine

`src/sim/engine.ts` is a fluid, tick-based queueing simulation: request volume flows through the
graph (forward pass), success and latency fold back from the leaves (backward pass). Per-kind
behaviour lives in `src/sim/components/`; numbers live in `src/sim/catalog.ts` and can be
overridden per component. Generic features: routing (split / fanout / failover), retries
(immediate / backoff / budget), client deadlines, circuit breakers with fallback, bounded queues,
DB failover to replicas, zones as failure domains, language runtimes, serverless cold starts,
GPU inference and hosted LLM APIs.

A 60 s simulation of a typical architecture runs in ~50 ms in Node. Results are directional —
good for comparing designs and finding bottlenecks, not a replacement for load tests.

## Architecture spec (v1)

YAML or JSON. Schema: `src/spec/schema.ts`.

```yaml
version: 1
name: Web shop
components:
  - { id: users, kind: client, retries: 2, retryPolicy: budget, timeoutMs: 1000 }
  - { id: lb, kind: lb }
  - { id: api, kind: server, instances: 4, runtime: go, breaker: true, fallback: true }
  - { id: redis, kind: cache, hitRate: 0.85 }
  - { id: db, kind: db, tier: M }
  - { id: db-replica, kind: replica }
connections:            # caller → callee
  - [users, lb]
  - [lb, api]
  - [api, redis]
  - [redis, db]
  - [db, db-replica]
zones:                  # failure domains
  - { id: az-a, label: us-east-1a, members: [api, db] }
```

Kinds: `client cdn lb gateway server worker function cache db replica storage queue llm llmapi`
(`npm run sim -- catalog` lists capacities, latency and prices). Calibrate to a real system with
`capacity` (req/s per instance), `latencyMs` and `costPerHour`.

**Scenario**

```yaml
name: Black Friday
duration: 90                     # simulated seconds
readRatio: 0.85
traffic: [{ at: 0, rps: 600 }, { at: 30, rps: 2400 }, { at: 90, rps: 2400 }]   # or: rps: 800
events:
  - { at: 60, action: { type: kill, kind: server, pick: busiest }, note: "instance dies at peak" }
  # kill-id · revive-id · kill · revive-all · fail-zone · restore-zone · degrade(factor) · restore
slo: { maxErrorRate: 0.01, maxP99Ms: 300 }
```

**Variants** (hypotheses) are full specs or edit lists against a base:

```yaml
- name: Go + cache
  changes:
    - { op: set, id: api, fields: { runtime: go, instances: 6 } }
    - { op: add, component: { id: redis, kind: cache } }
    - { op: disconnect, from: api, to: db }
    - { op: connect, from: api, to: redis }
    - { op: connect, from: redis, to: db }
```

## CLI

```
npm run sim -- validate        examples/shop.yaml
npm run sim -- simulate        examples/shop.yaml examples/black-friday.yaml
npm run sim -- compare         examples/shop.yaml examples/shop-variants.yaml examples/black-friday.yaml
npm run sim -- breaking-point  examples/shop.yaml --p99 300
npm run sim -- link            examples/shop.yaml examples/shop-hypothesis.yaml   # opens in the app
npm run sim -- import-terraform examples/terraform/shop.tfstate.json --out shop.yaml
npm run sim -- catalog
```

Add `--json` for machine-readable output.

## MCP server

`.mcp.json` registers it for Claude Code in this folder. Tools:

| tool | what it does |
|---|---|
| `list_components` | catalogue: kinds, capacities, latency, prices, runtimes |
| `validate_architecture` | schema + architectural lint |
| `simulate` | one scenario → SLO compliance, errors, p99, cost, ranked bottlenecks with explanations, event log |
| `compare_architectures` | baseline + variants under one scenario, ranked (SLO first, then cost) |
| `find_breaking_point` | max sustainable req/s within SLO and the limiting component |
| `import_terraform` | `terraform show -json` → AWS-priced spec + assumptions to confirm |
| `analyze` / `optimize_cost` | discrete-event Monte Carlo with CIs / cheapest config meeting the SLO |
| `show_architecture` | live canvas rendered inline in MCP Apps hosts |
| `open_in_app` | link that opens the architecture (or a side-by-side comparison with a scenario) in the app |

In the app, the **{ }** button in Sandbox copies the current board as a YAML spec — paste it to
an assistant or into a file for the CLI.

## App links

- `#spec=<base64url JSON spec>` — open in Sandbox, auto-laid-out
- `#compare=<base64url { a: {title, spec}, b: {title, spec}, scenario? }>` — open side by side; with a
  scenario it plays like a built-in comparison, with a takeaway computed by the engine
