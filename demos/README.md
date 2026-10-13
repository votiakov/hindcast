# Demos

Recorded against the Kubernetes reference (reference/k8s): a kind cluster running the Astronomy
Shop under real traffic, observed by kube-prometheus-stack, ingress-nginx, an OpenTelemetry
Collector and Jaeger.

- `agent.tape` — Claude Code, with the MCP server connected, answers "can we cut the frontend to
  2 replicas before launch day?" from the cluster's telemetry (VHS: `vhs demos/agent.tape`).
- `app.mjs` — the Backtest screen on the same system: the calibration day, the three changes, launch
  day at ×2.2 (Playwright: `node demos/app.mjs`).

Outputs go to `demos/out/` (not committed).
