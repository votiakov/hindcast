# Bottleneck backtest — pull-request check

Every pull request that changes `deploy/` is backtested against recorded production traffic before
it merges. The check turns the manifest diff into a strategy (replica counts, CPU and memory limits,
HorizontalPodAutoscalers, `kubernetes.io/arch`), replays the history through the calibrated model of
this system, comments the result on the pull request and fails if the change would have added time
out of SLO.

The system here is Jaeger's HotROD demo, recorded under load (see `reference/` in Bottleneck). The
model's accuracy against runs it never saw is part of every comment.

| file | what |
|---|---|
| `.github/workflows/backtest.yml` | the check |
| `deploy/hotrod.yaml` | what is deployed |
| `.bottleneck/model.json` | calibrated model (`bottleneck calibrate`) |
| `.bottleneck/dataset.json` | recorded history (`bottleneck import`) |
| `.bottleneck/bottleneck.mjs` | Bottleneck CLI in one file (`npm run build:cli`) |

Try it: open a pull request that sets `customer` to 2 replicas, or adds
`nodeSelector: { kubernetes.io/arch: arm64 }` to a deployment.
