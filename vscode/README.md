# Hindcast for VS Code

Run a system design from the YAML spec you are editing. The extension is a thin shell. Every number comes from the Hindcast engine: the WebAssembly build bundled with the extension, or the `hindcast` CLI.

- **Hindcast: Open design** opens the live board beside the editor, the same board as the app's embed. Edits to the file reach the board as you type (debounced), and the layout stays put. Click a component on the board and the editor jumps to its line. If an edit breaks the spec, the board keeps the last version that worked and tells you so.
- **Diagnostics.** The engine's checks (schema errors and the lint: a load balancer with nothing behind it, a fleet without a balancer, a fallback without a breaker) show as squiggles on the value at fault. They run as you type and on save.
- **Status bar.** After a quick headless run (60 s at the design's traffic) the status bar shows peak p99, error rate and $/month. It turns amber when the run misses the SLO. Hover for SLO compliance and the busiest component. Click to open the board.
- **Hindcast: Audit design** runs the failure audit: every component dying, zones going dark, slow and failing dependencies, cold caches, a surge, the load ramp. The report opens as a Markdown preview.
- **Completion and hover docs** for `*.hindcast.yaml` (with the Red Hat YAML extension) and `*.hindcast.json`, from a JSON Schema generated from the spec's zod schema.

A file is a spec if it is named `*.hindcast.yaml` / `.yml` / `.json`, or if it is YAML with a `components` list (items with a `kind`) and a `connections` list. So `examples/shop.yaml` works as it is. For schema completion in a plain `.yaml`, add a modeline:

```yaml
# yaml-language-server: $schema=<path to the extension>/schemas/hindcast.schema.json
```

## Settings

| Setting | Default | |
|---|---|---|
| `hindcast.rps` | `0` | Traffic for the status bar run, the board and the audit. `0` means the engine's default: 500 req/s for a run, half the breaking point for an audit. |
| `hindcast.costPerMinute` | `0` | What a minute of full outage costs, for the audit's $ at risk. |
| `hindcast.path` | | The native `hindcast` CLI. Used when the WebAssembly build is missing, or always with `hindcast.engine: cli`. |
| `hindcast.engine` | `auto` | `auto`: the bundled WebAssembly. `cli`: the CLI at `hindcast.path`. |
| `hindcast.validateOnType` | `true` | Check while typing, not only on save. |
| `hindcast.statusBar` | `true` | The status bar item. |

## Build

The extension builds from this repository: it bundles `src/` (the spec schema, validation, the headless runner, the audit report) and the engine's WebAssembly (`src/backtest/wasm/`, from `npm run engine:build` at the root).

```sh
npm install            # at the root, then in vscode/
cd vscode
npm run build          # dist/: extension.cjs, worker.cjs, the .wasm, webview/index.html
npm test               # unit tests (line mapping, schema up to date)
npm run test:host      # end to end in the VS Code installed on this machine (VSCODE_EXECUTABLE to point elsewhere)
npm run package        # dist/hindcast.vsix, for `code --install-extension dist/hindcast.vsix`
npm run schema         # regenerate schemas/hindcast.schema.json after a schema change
```

Nothing is fetched at run time. The webview is one HTML file with the engine inlined, under a strict content security policy. The Terminal theme's web fonts fall back to system fonts.
