# Tools: CLI, MCP server, app links, Analysis panel

## CLI — `npm run sim -- <command>`

| command | what it does |
|---|---|
| `validate <arch>` | schema + lint (exit code 1 on errors) |
| `simulate <arch> [scenario] [--rps N] [--duration S] [--engine fluid\|des] [--seed N]` | one run; summary, bottlenecks with explanations, events; DES adds p50/p90/p99/p99.9 |
| `analyze <arch> [scenario] [--runs 20] [--seed 1]` | discrete-event Monte Carlo with 95 % CIs, in parallel threads |
| `compare <arch> <variants> [scenario]` | baseline + variants ranked (SLO first, then cost) with each one's top bottleneck |
| `breaking-point <arch> [--p99 300] [--errors 0.01]` | max sustainable req/s and the limiting component |
| `optimize <arch> [scenario] [--runtimes] [--p99 …] [--out file.yaml]` | cheapest sizing that meets the SLO; writes the optimized spec with `--out` |
| `import-terraform <terraform-show.json> [--name …] [--out arch.yaml]` | Terraform state/plan JSON → spec (AWS-priced) + assumptions to review |
| `link <arch> [variants]` | URL that opens the architecture (or a comparison) in the app |
| `catalog` | component catalogue as JSON |

Every command accepts `--json`. Files may be YAML or JSON. Examples live in `examples/`:

```bash
npm run sim -- simulate examples/shop.yaml examples/black-friday.yaml --engine des
npm run sim -- compare  examples/shop.yaml examples/shop-variants.yaml examples/black-friday.yaml
npm run sim -- analyze  examples/shop.yaml --rps 800 --runs 24
npm run sim -- optimize examples/shop.yaml examples/black-friday.yaml --runtimes --out optimized.yaml
npm run sim -- link     examples/shop.yaml examples/shop-hypothesis.yaml
npm run sim -- import-terraform examples/terraform/shop.tfstate.json --out shop.yaml
```

`BOTTLENECK_APP_URL` (default `http://localhost:5173`) controls generated links.

## MCP server — `npm run mcp`

Registered for Claude Code in `.mcp.json` (restart Claude Code in this folder and approve
`bottleneck`). Transport: stdio. The server sends usage instructions on initialise.

| tool | inputs | returns |
|---|---|---|
| `list_components` | — | catalogue: kinds, numbers, tiers, runtimes, modelling notes |
| `validate_architecture` | `architecture` | `{ ok, issues[], spec }` |
| `simulate` | `architecture`, `scenario?`, `engine? fluid\|des`, `seed?`, `include_timeline?` | summary, SLO, bottlenecks (+ explanations), events, components |
| `analyze` | `architecture`, `scenario?`, `runs?` | Monte Carlo metrics with CIs, pSloMet, bottleneck frequencies |
| `compare_architectures` | `architecture`, `variants[]`, `scenario?` | ranked variants + per-variant summaries |
| `find_breaking_point` | `architecture`, `readRatio?`, `slo?` | max req/s within SLO, limiting component |
| `optimize_cost` | `architecture`, `scenario?`, `allow_runtimes?`, `slo?` | before/after cost, savings, changes as a ready variant, log, verification |
| `import_terraform` | `terraform_json`, `name?` | spec, assumptions, skipped resources, lint |
| `show_architecture` | `architecture`, `compare_with?`, `scenario?` | **live canvas**: renders the simulation inline in MCP Apps hosts (Claude, ChatGPT…); text + link elsewhere |
| `open_in_app` | `architecture`, `compare_with?` (variant), `scenario?` | URL for the app (sandbox, or side-by-side comparison playing the scenario) |

Suggested assistant workflow: `import_terraform` (or `list_components` → write the spec from the user's description
from k8s manifests, diagrams, metrics) → confirm assumptions, request rates and SLOs with the user → `validate_architecture` → `simulate`/`analyze` the
current state → propose variants → `compare_architectures` / `optimize_cost` → `open_in_app` to hand
over a live demo.

### Live canvas (MCP Apps)

`show_architecture` is an MCP Apps tool: hosts that support the extension render the full app inline
and play the architecture or comparison immediately. The UI is a single-file build of the app
served as `ui://bottleneck/canvas.html`:

```
npm run build:mcp      # → dist-mcp/mcp-app.html (rebuild after app changes)
```

Hosts without UI support (e.g. the Claude Code terminal) get a text summary and an app link.
Inside the canvas the Analysis panel's web workers are not available (they are separate files);
use the `analyze` / `optimize_cost` tools instead.

## App links

| hash | opens |
|---|---|
| `#spec=<base64url(JSON spec)>` | Sandbox with the spec auto-laid-out |
| `#compare=<base64url({ a: {title, spec}, b: {title, spec}, scenario? })>` | Compare mode; with a scenario it plays like a built-in comparison and ends with a takeaway computed by the engine |

The **{ }** button in Sandbox copies the current board as a YAML spec (`graphToSpec`).

## Analysis panel (app)

Flask button in the top bar (Sandbox and Compare). Runs in web workers:

- **Run Monte Carlo** — Sandbox: current traffic for 60 s (optionally killing the busiest server at
  30 s); Compare: the selected scenario, per side with that side's events.
- **Find breaking point** (Sandbox).
- **Find cheapest config meeting SLO** (Sandbox) with optional runtime changes; **Apply to board**
  applies the changes; hints explain structural blockers.
