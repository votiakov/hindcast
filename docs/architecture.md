# Architecture

Hindcast is one TypeScript codebase with three front-ends over the same simulation core:

```
                ┌──────────────────────────── src/sim ─────────────────────────────┐
                │ catalog.ts      numbers + node data shape (per kind)              │
   spec (YAML)  │ components/     behaviour per kind (fluid engine)                 │
 ─────────────► │ engine.ts       fluid engine — live visuals, fast search          │
                │ des/            discrete-event engine — analysis, percentiles     │
                │ actions.ts      pure scripted actions (kill, fail-zone, degrade…) │
                │ headless.ts     simulate / compare / breakingPoint / catalog      │
                │ optimize.ts     cost optimizer                                    │
                └───────────────┬───────────────────────┬──────────────────────────┘
                                │                       │
           ┌────────────────────┴──────┐   ┌────────────┴─────────────┐
           │ app (React, src/…)        │   │ cli/  mcp/  scripts/     │
           │ boards, lessons, compare, │   │ terminal, AI assistants, │
           │ studio, analysis panel    │   │ video rendering          │
           └───────────────────────────┘   └──────────────────────────┘
```

## Directory map

| path | role |
|---|---|
| `src/backtest/` | The backtest's types and the app's typed calls into the engine: `dataset.ts`, `model.ts` (shapes, slicing), `import/manifest.ts` (the import manifest schema → the engine's importer), `import/promql.ts` (the Prometheus export queries, from the engine), `calibrate.ts`, `engine.ts`, `strategy.ts`, `backtest.ts`, `accuracy.ts`, `resilience.ts`, `outages.ts` (the public-outage catalogue), `configDiff.ts`, `fromBoard.ts`, `toSpec.ts`, `report.ts`, `card.ts`; `native.ts` loads `wasm/` (built from `engine-rs/`) |
| `src/backtest-ui/` | The backtest screen (strategy terminal): store, chart panes, workspace loading and file drop, outage replays, board bridge, Studio card |
| `reference/` | Reference systems run under load in Docker (recording stack, k6 replay, synthetic bill from measured runtime, bundling into `public/reference/`) — see reference/README.md |
| `src/sim/catalog.ts` | Component kinds (`KINDS`), tiers, runtimes, AI batching constants; `SystemNodeData` (everything a node can be configured with); `capacityOf`, `baseLatencyOf`, `costOf`, `fnCostPerRequest` |
| `engine-rs/` | The engine in Rust: simulation, DES, audit, calibration, backtest, importers. Built to WebAssembly for the app (`npm run engine:build`) and to the native `hindcast` binary: the CLI (`src/cli/`), the agent tools (`src/cli/agent/`) and the MCP server (`src/cli/mcp/`, `hindcast mcp`) |
| `src/sim/engine.ts` | The board's fluid engine: the engine's `SimEngine`, one per running board, with the stats types the UI reads |
| `src/sim/des/` | Discrete-event runs (`des.ts`), Monte Carlo (`analyze.ts`) and the browser worker pool that spreads runs over cores (`browserPool.ts`, `browser.worker.ts`) — the work itself in the engine |
| `src/sim/actions.ts` | `SimAction` union + pure `applyAction(nodes, action, ctx)` used by lessons, scenarios, episodes and the headless runner |
| `src/sim/headless.ts` | Engine as a library: `simulate`, `compare`, `breakingPoint`, `catalog` |
| `src/sim/optimize.ts` | Cost optimizer (grow / shrink / verify) |
| `src/sim/store.ts` | Zustand store: modes, boards (`main`, `A`, `B`), one fluid engine per board, lesson/compare/studio state, settings, toasts, the 20 Hz tick |
| `src/spec/` | Spec schema (zod), validation/lint, spec ↔ board conversion with auto-layout, app links, YAML export |
| `src/canvas/` | React Flow canvas (`BoardCanvas`), node/edge renderers, shared node view-model (`nodeModel.ts`: health, stats, explanations), node control panel |
| `src/theme/` | The one look (Terminal): node/edge renderers in `theme/reference/`, palette and chrome in `terminal.css` |
| `src/ui/` | Top bar, palette, control bar, lesson panel, compare view, analysis panel, settings, toasts; `HomeBoard.tsx` — the **Live** start screen: a running system that fails on arrival, with callouts pinned to the stressed component offering the next move (scale → 3× traffic → cache → your own system) |
| `src/lessons/` | Lesson format (`types.ts`) and lessons |
| `src/scenarios/` | Comparison scenario format, the built-in scenarios, templates |
| `src/studio/` | Episodes (scripted clips), brands, the export Stage, the Studio editor |
| `engine-rs/` | The engine in Rust: simulation, DES, audit, calibration, backtest, importers. Built to WebAssembly for the app (`npm run engine:build`) and to the native `hindcast` binary: the CLI (`src/cli/`), the agent tools (`src/cli/agent/`) and the MCP server (`src/cli/mcp/`, `hindcast mcp`) |
| `bin/hindcast` | Runs the native binary in a checkout, building it on first use (`npm run sim`, `npm run mcp`, `.mcp.json`) |
| `test/golden/` | The CLI's and MCP server's golden outputs (`npm run cli:golden`, `npm run mcp:golden`) |
| `scripts/record.mjs` | Frame-perfect episode renderer (`npm run record`) |
| `examples/` | Example specs, scenarios and variants |

## Runtime model of the app

- **Boards.** The store holds three boards: `main` (Lesson, Sandbox, single-layout Studio episodes)
  and `A`/`B` (Compare, comparison episodes). Each board has its own React Flow graph and its own
  fluid `Engine` instance (`engines[boardId]`). Canvas components learn which board they render via
  `BoardContext`.
- **Tick.** `App` runs `store.tick()` every 50 ms of wall time; the store advances simulated time in
  fixed 50 ms steps (`speed` × real time), feeds the current traffic (lesson step / scenario timeline /
  sandbox slider × pattern × optional jitter) into every active board's engine, fires due scripted
  actions, evaluates lesson goals, and snapshots stats into the board for rendering.
- **Actions.** All scripted changes go through `applyAction` (pure). The store resolves zone
  membership from geometry (node centre inside the zone frame); the headless runner uses the
  spec's explicit `members`.
- **Rendering.** `SystemNode` and `FlowEdge` pick a renderer per theme. All themes share
  `nodeView()` (health, stats, tags) and `explain()` (plain-English callouts) from `canvas/nodeModel.ts`.
  Request particles are SVG `<animateMotion>` elements with bucketed counts/durations so React
  doesn't restart them every tick.
- **Studio.** `Stage` renders an episode at its true pixel size (1080×1350 etc.). In render mode
  (`?render=1&ep=…`) the app shows only the stage and exposes `window.studio`; `scripts/record.mjs`
  drives it with Playwright's fake clock, pins CSS/SMIL animations to the frame clock and pipes
  screenshots into ffmpeg.
- **Analysis.** The Analysis panel serialises the current board(s) to a spec (`graphToSpec`) and
  runs the discrete-event engine in web workers (`browserPool.ts`), so the UI never blocks.

## Conventions

- Simulation code under `src/sim` and `src/spec` imports nothing from React or the store
  (`nodeModel.ts` is the one shared UI-agnostic helper), so it runs in Node, workers and tests.
- Numbers live in the catalog; behaviour lives in components/engines; content (lessons, scenarios,
  episodes) is data.
- One look, Terminal (`<html data-theme="terminal">`): `src/styles.css` holds base layout, `reference.css` the figure rules, `terminal.css` the palette and chrome.
