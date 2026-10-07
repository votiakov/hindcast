# Bottleneck — backtesting roadmap

Promise: **backtest an infrastructure change on your real production data before it ships** — a
strategy tester for systems. Real history in (metrics, traces, bill), a calibrated model out, any
change replayed over that history as "what would have happened", with error bars and a measured
accuracy record.

## Data in (files only)
- [x] Normalised telemetry dataset (`src/backtest/dataset.ts`): per-service and per-endpoint series
- [x] Prometheus `query_range` JSON export + long-format CSV; export helper with standard queries
- [x] CloudWatch `GetMetricData` JSON + console CSV
- [x] OpenTelemetry traces (OTLP JSON lines): topology, calls per request per endpoint, self time, payload sizes
- [x] AWS CUR (legacy + 2.0 column names) and GCP billing export → cost per component

## Calibrated model
- [x] Topology from traces; capacity from CPU-vs-load fit; concurrency limits from latency-vs-load fit
- [x] Latency per service (M/M/c with fitted tail), end-to-end per endpoint along the call path
- [x] Real cost from the bill: $/replica-hour, $/request, $/GB per component
- [x] Fit quality per component (holdout MAPE, R²); unexplained components flagged

## Backtest
- [x] Strategy YAML (resize, replicas, autoscaling, cache, DB replica, retry budget, Graviton, timeout)
- [x] Bucketed replay engine: backlog, timeouts, autoscaler dynamics, cost per bucket
- [x] Confidence bands (parameter bootstrap, Monte Carlo)
- [x] Results: $ saved/spent, minutes out of SLO, failed requests, worst moment and why,
      cumulative cost and error-budget curves; ranking of several strategies
- [x] Strategies from the board and from audit fixes; any moment opens on the board as a replay

## Modelling
- [x] Endpoints with their own paths, costs and SLOs
- [x] Payload sizes → data transfer priced across zones and regions

## Surfaces
- [x] CLI: `import`, `calibrate`, `backtest`, `accuracy`; Markdown/HTML report
- [x] App: backtest is the main screen (chart-first), canvas secondary
- [x] Visual identity: 2–3 concepts shown to Andrii, chosen one built
- [x] PR check: CI workflow backtests a changed config against the last N days and comments on the PR
- [x] Studio cards and clips of backtest results

## Proof
- [ ] Three reference systems (open demo apps under load, telemetry recorded) imported, calibrated,
      backtested; p99 within 20 %, breaking point within 15 %, cost within 10 %; accuracy shown in
      the app, the CLI and every report
- [x] PR workflow running end to end on a sample repository (github.com/votiakov/bottleneck-backtest-demo, private; PR #1)
- [x] Public-outage replays: Cloudflare 2019, GitHub 2018, Slack 2021, AWS us-east-1 2025
- [ ] Tests, docs, commits
