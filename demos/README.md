# Demos

The agent demo runs against the Kubernetes reference (reference/k8s): a kind cluster running the
Astronomy Shop under real traffic, observed by kube-prometheus-stack, ingress-nginx, an
OpenTelemetry Collector and Jaeger.

- `agent.tape` — Claude Code, with the MCP server connected, answers "can we cut the frontend to
  2 replicas before launch day?" from the cluster's telemetry (VHS: `vhs demos/agent.tape`).
- `app.mjs` — the Backtest screen on the Astronomy Shop reference, whose accuracy is within target on
  every recorded run: the recorded day, four changes, the same day at twice the traffic, and the
  accuracy record (Playwright: `node demos/app.mjs`).

- `nodeloss.mjs` — losing a Kubernetes node at the busiest moment: what Hindcast predicts from the
  recorded day and the pod placement, and (once `normal-nodeloss` is recorded and scored) what was
  measured when the node was stopped for real (Playwright: `node demos/nodeloss.mjs`).

Outputs go to `demos/out/` (not committed).
