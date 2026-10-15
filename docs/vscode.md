# VS Code extension

`vscode/` is a VS Code extension for designs written as specs ([spec.md](spec.md)). It is a thin shell: validation, the runs and the audit come from the engine, either the WebAssembly build bundled with the extension or the native `hindcast` CLI. The board is the app's embed board.

## What it does

| | |
|---|---|
| **Hindcast: Open design** | Opens the live board beside the editor (the editor title has a ▶ button on a spec). Edits reach the board as you type, debounced by 300 ms. Components that already exist keep their place on the board (`mergeSpecIntoGraph`, as with the app's spec editor). Clicking a component on the board selects its `id` in the editor. If an edit stops the file parsing as a spec, the board keeps the last version that did and shows a notice. The *Audit* button runs the audit. |
| **Diagnostics** | `validateSpec` (zod schema plus the architecture lint, the same checks as `hindcast validate`), as you type and on save. YAML syntax errors keep the parser's own position. |
| **Status bar** | A 60 s headless run at the design's traffic (`simulate`, default 500 req/s, or `hindcast.rps`). It shows peak p99, mean error rate and $/month (mean $/h × 730, as on the embed board). The item turns amber when the run misses the SLO. The tooltip adds SLO compliance and the busiest component. |
| **Hindcast: Audit design** | The failure audit ([tools.md](tools.md#failure-audit)), with progress and cancel. The report (`auditMarkdown`, the same as `hindcast audit --md`) opens as a Markdown preview. |
| **Completion** | `vscode/schemas/hindcast.schema.json`, generated from `ArchitectureSpec` with `z.toJSONSchema`. It is registered for `*.hindcast.yaml`/`.yml` (needs the Red Hat YAML extension) and `*.hindcast.json`. |

A file counts as a spec if its name ends in `.hindcast.yaml`, `.hindcast.yml` or `.hindcast.json`, or if it is YAML/JSON with a `components` list (items with a `kind`) and a `connections` list. So the files in `examples/` open as they are.

## How an issue finds its line

`validateSpec` now returns a `path` with each issue: the zod path for schema errors (`['components', 2, 'kind']`), and for the lint the component (`['components', i]`), connection (`['connections', i]`) or zone member at fault. `vscode/src/lineMap.ts` walks the YAML document (`yaml`'s `parseDocument` with a `LineCounter`) along that path to the deepest node that exists. It marks the value when the value is a scalar (`servr` in `kind: servr`), otherwise the key or the first line of the item. A field that is missing (`autoscale.max is missing`) lands on its parent.

The native CLI's `validate --json` gives messages without paths. The same module reads the place back out of the message (`component "api": kind …` gives `['components', <api>, 'kind']`, `connection "a b c": …` gives the connection written that way). The unit tests check that both routes put every issue on the same line.

## Engines

- **WebAssembly (default).** `dist/worker.cjs` runs in a worker thread, so a long audit never blocks the editor. It loads `hindcast_engine_bg.wasm` with `initSync` and calls the same modules as the app (`src/spec/validate`, `src/sim/headless`, `src/sim/audit`, `src/sim/auditReport`). Cancelling an audit terminates the worker. The next call starts a new one.
- **CLI.** Set `hindcast.path` to a `hindcast` binary (`engine-rs/target/release/hindcast`, built by `npm run cli:build`). It is used when the WebAssembly build is missing, or always with `hindcast.engine: cli`. The extension writes the editor's text to a temporary file and runs `validate --json`, `simulate --json [--rps]` and `audit --json --md`.

## The webview

`vscode/webview/main.tsx` renders `<Embed>` (the embed board) with an *Audit* button where the embed has its *open in Hindcast* link. It talks to the extension with `postMessage`: `spec` comes in, and `ready`, `board` (title, component ids, stale), `select`, `audit` and `error` go out. Vite with `vite-plugin-singlefile` builds it into one HTML file with the engine inlined. The extension serves that file under a content security policy with a nonce: `script-src 'nonce-…' 'wasm-unsafe-eval'`, `connect-src data:`, no remote origins. The build strips the Terminal theme's Google Fonts import, so the page fetches nothing.

## Settings

`hindcast.rps`, `hindcast.costPerMinute`, `hindcast.path`, `hindcast.engine` (`auto` | `cli`), `hindcast.validateOnType`, `hindcast.statusBar`. See [vscode/README.md](../vscode/README.md).

## Build, test, package

```sh
cd vscode && npm install
npm run build        # dist/: extension.cjs, worker.cjs, the .wasm, webview/index.html
npm test             # line mapping, schema up to date; with HINDCAST_BIN (or a release build), the CLI fallback
npm run test:host    # end to end in the VS Code installed on this machine, in a throwaway profile
npm run package      # dist/hindcast.vsix (offline, not published)
npm run schema       # regenerate the JSON Schema after changing src/spec/schema.ts
```

The root `npx vitest run` also runs `vscode/test/`. A schema change that is not regenerated fails there. `node test/host/webview-shot.mjs` renders the built webview in headless Chromium with a stub host and writes `dist/webview.png`.

`test:host` starts the installed VS Code with `--extensionDevelopmentPath` and `--extensionTestsPath`, using a fresh user-data and extensions directory with updates and telemetry off. In a copy of `shop.yaml` it checks that diagnostics land on the bad value, that they clear when the file is fixed, the status bar numbers (p99 93 ms, 0% errors, $971/mo, the same as `hindcast simulate`), that the board loads the engine and shows the spec, that an edit reaches the board (a broken one marks it stale), and that the audit report renders.
