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
| `src/backtest/` | Backtesting on real data, UI-free: `dataset.ts` (telemetry on a time grid), `import/` (Prometheus, CloudWatch, CSV, OTLP/Jaeger traces, AWS CUR / GCP billing, import manifest, Prometheus export presets), `calibrate.ts` (fit the model), `engine.ts` (bucketed replay with backlog, autoscalers, faults, cost; `runPlanTs` is the TypeScript reference), `native.ts` + `wasm/` (the same replay compiled from `engine-rs/`), `strategy.ts`, `backtest.ts` (bands, incidents, ranking), `accuracy.ts`, `outages.ts`, `configDiff.ts` (k8s diff → strategy), `fromBoard.ts`, `toSpec.ts`, `report*.ts`, `card.ts` |
| `src/backtest-ui/` | The backtest screen (strategy terminal): store, chart panes, workspace loading and file drop, outage replays, board bridge, Studio card |
| `reference/` | Reference systems run under load in Docker (recording stack, k6 replay, synthetic bill from measured runtime, bundling into `public/reference/`) — see reference/README.md |
| `src/sim/catalog.ts` | Component kinds (`KINDS`), tiers, runtimes, AI batching constants; `SystemNodeData` (everything a node can be configured with); `capacityOf`, `baseLatencyOf`, `costOf`, `fnCostPerRequest` |
| `src/sim/components/` | Fluid-engine behaviour per kind: `types.ts` (the `Behavior` contract), `shared.ts` (bounded queue stage, M/M/1 latency), `behaviors.ts`, `index.ts` (kind → behaviour registry) |
| `engine-rs/` | The engine in Rust, built to WebAssembly by `npm run engine:build` into `src/backtest/wasm/` (committed, with a hash of the source it came from): the replay, backtest, strategies, calibration, accuracy, node loss and outage replays (`src/`), the design simulator, its headless runs, the discrete-event simulator, analysis, optimizer and failure audit (`src/sim/`), the importers behind an import manifest (`src/import/`) and the Kubernetes config diff (`config_diff.rs`). Each TypeScript module keeps its `…Ts` reference and dispatches to the compiled one once `src/backtest/native.ts` has loaded it (the app, its workers, the CLI, the MCP server, the replay threads); `HINDCAST_ENGINE=ts` keeps TypeScript. Parity: `test/engine-parity.test.ts`, `test/sim-parity.test.ts`, `test/import-parity.test.ts` (every import manifest and Kubernetes manifest in the repository), `test/backtest-native.test.ts` (the backtest suite again on the compiled engine). `npm run engine:bench`: replay 3.5×, backtest 4–5×, calibration 5–13×, simulator 4×, DES 3×, import 1.0–1.2× (JSON parsing is where V8 is already native) |
| `src/sim/engine.ts` | Fluid engine: topological forward/backward passes, routing, retries, breakers, deadlines, stats, cost |
| `src/sim/des/` | Discrete-event engine (`des.ts`), PRNG (`random.ts`), latency histograms (`histogram.ts`), Monte Carlo (`analyze.ts`), worker pools for Node (`nodePool.ts`, `nodeWorker.ts`) and the browser (`browserPool.ts`, `browser.worker.ts`) |
| `src/sim/actions.ts` | `SimAction` union + pure `applyAction(nodes, action, ctx)` used by lessons, scenarios, episodes and the headless runner |
| `src/sim/headless.ts` | Engine as a library: `simulate`, `compare`, `breakingPoint`, `catalog` |
| `src/sim/optimize.ts` | Cost optimizer (grow / shrink / verify) |
| `src/sim/store.ts` | Zustand store: modes, boards (`main`, `A`, `B`), one fluid engine per board, lesson/compare/studio state, settings, toasts, the 20 Hz tick |
| `src/spec/` | Spec schema (zod), validation/lint, spec ↔ board conversion with auto-layout, app links, YAML export |
| `src/canvas/` | React Flow canvas (`BoardCanvas`), node/edge renderers, shared node view-model (`nodeModel.ts`: health, stats, explanations), node control panel |
| `src/theme/` | Theme registry and per-theme renderers/styles: Terminal (default), Neon, Reference, Transit |
| `src/ui/` | Top bar, palette, control bar, lesson panel, compare view, analysis panel, settings, toasts; `HomeBoard.tsx` — the **Live** start screen: a running system that fails on arrival, with callouts pinned to the stressed component offering the next move (scale → 3× traffic → cache → your own system) |
| `src/lessons/` | Lesson format (`types.ts`) and lessons |
| `src/scenarios/` | Comparison scenario format, the built-in scenarios, templates |
| `src/studio/` | Episodes (scripted clips), brands, the export Stage, the Studio editor |
| `cli/bottleneck.ts` | CLI: `hindcast` (`npm run sim` in the repository) |
| `mcp/server.ts` | MCP server (`npm run mcp`, registered in `.mcp.json`) |
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
- Every visual theme must be scoped under `[data-theme='…']`; Neon's base styles live in `src/styles.css`; Terminal reuses the Reference rules (scoped to both) with its own palette in `terminal.css`.
