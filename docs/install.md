# Install and build

## The CLI, MCP server and agent tools: a release binary

Download the binary for your platform from the
[latest release](https://github.com/votiakov/hindcast/releases/latest), make it executable and
run it. No Node or Rust is needed.

| platform | file |
|---|---|
| macOS, Apple silicon | `hindcast-aarch64-apple-darwin` |
| macOS, Intel | `hindcast-x86_64-apple-darwin` |
| Linux, x86-64 (static) | `hindcast-x86_64-unknown-linux-musl` |
| Windows, x86-64 | `hindcast-x86_64-pc-windows-msvc.exe` |

```sh
curl -fsSLo hindcast https://github.com/votiakov/hindcast/releases/latest/download/hindcast-aarch64-apple-darwin
chmod +x hindcast
./hindcast demo                                    # a recorded system built in: no network, no files
./hindcast quickstart --prometheus http://localhost:9090 --last 24h
```

`hindcast demo` shows the output on the OpenTelemetry Astronomy Shop recorded under load, with
nothing to download: a capacity review, four strategies backtested, and the accuracy record.
`hindcast demo --workspace ./hindcast-demo` writes that data to disk, so `backtest`, `outage`,
`headroom` and the agent tools run on it too.

The same binary is the MCP server (`hindcast mcp`) and runs every agent tool from a shell
(`hindcast agent <tool> '<json>'`); `hindcast agent setup` writes the configuration for an MCP host.
See [agents.md](agents.md).

## The app, the lessons and everything else: a clone

```sh
git clone --depth 1 https://github.com/votiakov/hindcast.git
cd hindcast
npm install
npm run dev            # app on http://localhost:5173
npm run sim -- …       # CLI (headless engine); same as bin/hindcast …
npm run mcp            # MCP server (stdio), registered for MCP hosts in .mcp.json
npm test               # engine, spec and audit tests (a couple of minutes)
```

- Needs Node 22.12 or newer.
- The CLI, the MCP server and the agent tools are one native binary: `bin/hindcast` builds it on
  first use (about two minutes, once), which needs a Rust toolchain ([rustup](https://rustup.rs)).
  `npm run cli:build` builds it explicitly, to `engine-rs/target/release/hindcast`.
- The app doesn't need Rust: the engine is committed as WebAssembly. Rebuilding it with
  `npm run engine:build` needs the `wasm32-unknown-unknown` target and `wasm-bindgen-cli`.
- A clone is about 470 MB (less with `--depth 1`, which skips the history). Most of it is the
  recorded reference runs the accuracy tables are regenerated from; they stay in the repository so
  anyone can check those tables.

In a checkout, `hindcast` in the examples is `bin/hindcast` (or `npm run sim --`).

## The user guide

The app's **Docs** button, or http://localhost:5173/docs/index.html, explains every view screen by
screen. Its source is `docs-site/pages/`; `npm run docs:shots` recaptures the screenshots from a
running app and `npm run docs:build` rebuilds the pages.

## No cluster? Backtest the recorded reference systems

The data the accuracy tables come from is committed, so a backtest runs without any infrastructure.
In the app, the **Backtest** tab opens on HotROD; the system picker switches to the Astronomy Shop,
PetClinic and the shop on Kubernetes. With the binary alone, `hindcast demo` shows the Astronomy
Shop and `hindcast demo --workspace <dir>` writes its files out. From the CLI, in a clone:

```sh
hindcast backtest reference/shop/model.json reference/shop/dataset.json \
  reference/shop/strategies/1-autoscale-frontend.yaml reference/shop/strategies/3-graviton.yaml
hindcast accuracy reference/shop/model.json      # how well that model predicted runs it never saw
hindcast outage   reference/shop/model.json list # public outages to replay against it
```

The reference models were calibrated on 40-minute runs of demo systems (in Docker, or on a kind
cluster), so treat them as a way to see what the output looks like, not as numbers about your
system. How they were recorded: [reference/README.md](../reference/README.md) and
[reference/k8s/README.md](../reference/k8s/README.md).
