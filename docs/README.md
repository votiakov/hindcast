# Hindcast — documentation

The user-facing guide, screen by screen, is served with the app at `/docs/` (built from
`docs-site/pages/` by `npm run docs:build`; screenshots and pin positions by `npm run docs:shots`).
These pages are the reference behind it.

| document | what's in it |
|---|---|
| [install.md](install.md) | Release binaries, building from source, the npm scripts, and backtesting the recorded reference systems with no cluster |
| [capabilities.md](capabilities.md) | Everything Hindcast does, in one list, with where to find it |
| [agents.md](agents.md) | For AI agents: connect to Prometheus and Jaeger/Tempo, collect, calibrate, verify changes (strategies, Kubernetes diffs, Terraform plans) with a verdict and a confidence; setup for Claude Code, other MCP hosts and shell agents |
| [guide.md](guide.md) | The app, view by view: Backtest, Live, Lessons, Sandbox, Compare, Studio, settings, shortcuts |
| [use-cases.md](use-cases.md) | 21 use cases — with your real data and without — and how to do each |
| [calibration.md](calibration.md) | How a model is fitted from real telemetry: every rule, and the recording that taught it |
| [backtest.md](backtest.md) | Backtesting changes on real telemetry: import (Prometheus, CloudWatch, OTel traces, AWS CUR, GCP billing), calibration, strategies, reports, PR check, outage replays, accuracy |
| [ci.md](ci.md) | The GitHub Action and `hindcast verify-change`: backtest every pull request's Kubernetes manifests or Terraform plan, comment the verdict, fail the check |
| [architecture.md](architecture.md) | How the codebase is organised: app, store, boards, engines, themes, studio, headless tools |
| [engines.md](engines.md) | The two simulation engines — models, formulas, constants, validation, limitations, which to use when |
| [spec.md](spec.md) | Architecture spec v1 (components, connections, zones), scenarios, actions, variants |
| [catalog.md](catalog.md) | Every component kind with its default numbers, tiers, runtimes, and the knobs it supports |
| [analysis.md](analysis.md) | Monte Carlo with confidence intervals, breaking-point search, cost optimizer |
| [tools.md](tools.md) | CLI, MCP server, app links, the Analysis panel |
| [vscode.md](vscode.md) | The VS Code extension: the live board beside a spec, the engine's checks as squiggles, p99, errors and $/month in the status bar, the audit as a report |
| [content.md](content.md) | Authoring lessons, comparison scenarios and studio episodes; rendering video; brands and themes |

Start with **agents.md** if an AI agent will do the work, **guide.md** for the app, **use-cases.md** to find your question, **backtest.md** to test a change against your own production data, **architecture.md** if you want to change code, **spec.md** if you want to model a system,
and **content.md** if you want to make lessons or videos.
