# Hindcast backtest — pull-request check

Every pull request that changes `deploy/` is backtested against recorded production traffic before
it merges. The check turns the manifest diff into a strategy (replica counts, CPU and memory limits,
HorizontalPodAutoscalers, `kubernetes.io/arch`), replays the history through the calibrated model of
this system, comments the result on the pull request and fails if the change would have added time
out of SLO.

The system here is Jaeger's HotROD demo, recorded under load (see `reference/` in Hindcast). The
model's accuracy against runs it never saw is part of every comment.

| file | what |
|---|---|
| `.github/workflows/backtest.yml` | the check |
| `deploy/hotrod.yaml` | what is deployed |
| `.hindcast/model.json` | calibrated model (`hindcast calibrate`) |
| `.hindcast/dataset.json` | recorded history (`hindcast import`) |
| `.hindcast/hindcast` | the Hindcast binary for Linux x86-64 (a release asset, or `scripts/make-backtest-demo.sh` builds it) |

Try it: open a pull request that sets `customer` to 2 replicas, or adds
`nodeSelector: { kubernetes.io/arch: arm64 }` to a deployment.
