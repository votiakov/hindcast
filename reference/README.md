# Reference systems — how accurate is the backtest?

Three open demo applications were run under load on Docker, with their telemetry recorded the way a
production system would record it. Bottleneck imported one run of each (the "history"), calibrated
a model from it, and then predicted runs **the model never saw**: the system with a change actually
applied, and step load tests up to the breaking point. The predictions are compared with what the
load generator measured.

| system | what limits it | services |
|---|---|---|
| [HotROD](hotrod/) (Jaeger's demo) | a mutex around a simulated MySQL connection — concurrency, not CPU | frontend, customer (+ in-process mysql), driver (+ in-process redis), route, nginx |
| [Astronomy Shop](shop/) (the OpenTelemetry demo, successor of Google's Online Boutique) | CPU: the Next.js frontend and the services it fans out to | 11 services in TypeScript, Go, C#, C++, Java, Python, Ruby, PHP, Rust, plus Valkey and flagd |
| [PetClinic REST](petclinic/) on PostgreSQL | JVM CPU and a 10-connection pool in front of a CPU-limited database | app, PostgreSQL, nginx |

Online Boutique itself was the first choice for the microservices system; its images are amd64-only
and its Go services crash under emulation on Apple silicon (`fatal error: lfstack.push`), so the
OpenTelemetry demo — forked from it, maintained, multi-arch — stands in.

Docker Desktop's credential helper can hang on pulls; the recordings ran with a plain
`DOCKER_CONFIG` (no `credsStore`).

Results are in each system's `model.json` (`accuracy`), in the app (watchlist → Model accuracy), in
`bottleneck accuracy reference/<system>/model.json`, and in every report generated from these models.

## What is recorded

`reference/stack` runs alongside each system:

- **OpenTelemetry Collector** — receives the apps' spans; writes 20% of traces (sampled by trace id,
  as a production sampler would) to a JSON-lines file, and turns 100% of spans into RED metrics with
  the `spanmetrics` connector.
- **Container metrics** with cAdvisor's names (CPU used, CPU and memory limits, replicas, network),
  from the Docker Engine API — cAdvisor itself cannot read Docker Desktop's engine.
- **Prometheus**, scraping both every 5 s. After each run, `bottleneck`'s own Prometheus presets
  (`otel-spanmetrics`, `cadvisor`) export query_range JSON — the same path a user takes.
- **k6** replays a traffic shape as an open workload with **Poisson arrivals** (k6's arrival-rate
  executor paces requests evenly; real users don't, and even pacing hides queueing). Every request
  is kept (`requests.csv`) and summarised per bucket like load-balancer metrics (`client.csv`).
- **A bill.** Local containers have no cloud bill, so `reference/bill.ts` writes an AWS Cost and Usage
  Report from what was *measured*: the replicas that actually ran, their CPU and memory limits,
  priced as AWS Fargate in us-east-1 ($0.04048 per vCPU-hour, $0.004445 per GB-hour; Graviton
  $0.03238 / $0.00356), plus internet egress for the edge service's transmitted bytes. Never from the
  model. Line items are hourly and clipped to the recording window.

## Runs

Each system has a `reference.yaml` listing its runs:

- `history` — 40 minutes shaped like a compressed day: a night trough, a morning ramp, a lunch peak,
  a three-minute marketing push above capacity, an evening decline. Calibration uses only this.
- a **strategy run** — the same day with a change really applied (more replicas, an autoscaler, a
  bigger instance); the backtest of that strategy over the strategy run's traffic is the prediction.
- **stress** runs — the load stepped up every minute until the SLO breaks, as built and with the
  strategy.

```
sh reference/stack/… # see record.ts
npx tsx reference/record.ts hotrod history      # one run (takes the shape's length in real time)
sh reference/record-all.sh hotrod:history hotrod:stress …
npx tsx reference/bundle.ts hotrod               # import, calibrate, check, write the app workspace
```

## How accuracy is measured

- **p99** — the 99th percentile over *every request* in each 5-minute window (hundreds of requests per
  window, so the measurement itself is stable), predicted vs measured. The figure is the typical
  (median) error over the windows; the worst window is reported too. Target: within 20%.
- **breaking point** — for each plateau of the step load test, the SLO score (the larger of p99 / SLO
  and error rate / SLO) over every request in the plateau's second half; the breaking point is where
  the score crosses 1, interpolated between plateaus. The same definition is applied to the
  prediction. Target: within 15%.
- **cost** — the model's cost over the run vs the bill of that run. Target: within 10%.
- **holdout** — the model is also fitted on the first 70% of the history and checked on the rest.

The tolerances are the ones the product shows next to every result.

## Results

Every check compares a prediction with a recorded run the model never saw (the holdout rows: the
end of the history the model was calibrated without). Generated by `npx tsx reference/results.ts`.

<!-- RESULTS -->
| system | check | run | predicted | measured | off by | target | |
|---|---|---|---|---|---|---|---|
| HotROD | p99 | replicas-2 | 620 ms | 621 ms | 3.1% | ≤ 20% | ✅ |
| HotROD | cost | replicas-2 | $0.102 | $0.102 | 0.2% | ≤ 10% | ✅ |
| HotROD | breaking-point | stress | 6.7 req/s | 7.6 req/s | 12.2% | ≤ 15% | ✅ |
| HotROD | breaking-point | stress-replicas-2 | 7.7 req/s | 7.7 req/s | 0.0% | ≤ 15% | ✅ |
| HotROD | p99 | holdout (last 30% of history) | 1058 ms | 2812 ms | 37.1% | ≤ 20% | ❌ |
| HotROD | cost | holdout (last 30% of history) | $0.027 | $0.027 | 1.1% | ≤ 10% | ✅ |
| Astronomy Shop | p99 | autoscale | 97 ms | 94 ms | 8.6% | ≤ 20% | ✅ |
| Astronomy Shop | cost | autoscale | $0.189 | $0.183 | 3.3% | ≤ 10% | ✅ |
| Astronomy Shop | breaking-point | stress | 251.6 req/s | 286.0 req/s | 12.0% | ≤ 15% | ✅ |
| Astronomy Shop | breaking-point | stress-cpu1 | 573.9 req/s | 613.7 req/s | 6.5% | ≤ 15% | ✅ |
| Astronomy Shop | p99 | holdout (last 30% of history) | 154 ms | 571 ms | 46.3% | ≤ 20% | ❌ |
| Astronomy Shop | cost | holdout (last 30% of history) | $0.053 | $0.056 | 6.3% | ≤ 10% | ✅ |
<!-- /RESULTS -->
