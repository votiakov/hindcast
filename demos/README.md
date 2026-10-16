# Demos

The agent demo runs against the Kubernetes reference (reference/k8s): a kind cluster running the
Astronomy Shop under real traffic, observed by kube-prometheus-stack, ingress-nginx, an
OpenTelemetry Collector and Jaeger.

- `agent.tape` — Claude Code, with the MCP server connected, answers "can we cut the frontend to
  2 replicas before launch day?" from the cluster's telemetry (VHS: `vhs demos/agent.tape`).
- `app.mjs` — the README's hero: the Backtest screen on the Astronomy Shop reference, its recorded
  day, then the same day at twice the traffic (as built it breaks, autoscaling the frontend holds),
  then the Review screen. Writes `app-backtest.mp4` and the `backtest.gif` cut, copied by hand to
  `docs/media/` (Playwright and ffmpeg: `node demos/app.mjs --url <dev server>`).

- `nodeloss.mjs` — losing a Kubernetes node at the busiest moment: what Hindcast predicts from the
  recorded day and the pod placement, and (once `normal-nodeloss` is recorded and scored) what was
  measured when the node was stopped for real (Playwright: `node demos/nodeloss.mjs`).

Outputs go to `demos/out/` (not committed).
