---
name: verify-infra-change
description: Backtest an infrastructure change (replicas, CPU/memory limits, autoscaling, instance types, Graviton, caches, retries, a Terraform plan or Kubernetes manifests) against real production history with the Bottleneck MCP server, and report a verdict with its confidence. Use whenever the user proposes, reviews or asks about such a change, or before you commit one.
---

# Verify an infrastructure change with Bottleneck

Bottleneck (MCP server `bottleneck`) replays a change over the system's recorded history and
says what would have happened: $ per month, minutes out of SLO, the worst moment and why, and
how far to trust it.

## Steps

1. **`model_status`.** If it reports a model fitted on history from the last week, skip to step 4.
2. **Connect and collect.** `connect_telemetry` with the Prometheus URL and the Jaeger or Tempo URL
   (ask the user if you don't know them; credentials go in env vars, named with `tokenEnv`) and
   the system's SLO. Fix anything in `problems`. Then `collect_telemetry` with `last: "7d"`, or
   less if the data doesn't go back that far. Read the coverage: services missing CPU limits or
   traces will be weaker.
3. **`calibrate_model`.** Read the trust report. Note any service the change touches that is in
   `caution` (extrapolated capacity) or `untrusted`.
4. **`verify_change`** with the change, in the most direct form you have:
   - Terraform: run `terraform show -json plan.out > plan.json` and pass `{ terraformPlan: "plan.json" }`.
   - Kubernetes manifests: `{ kubernetes: { base: "<before>", head: "<after>" } }`. Or `read_cluster`
     (with the context the user names) and `{ cluster: { head: "<edited manifests>" } }`.
   - Anything else: a strategy, `{ strategy: { name, changes: [{ service, replicas | autoscale | cpu | memoryGb | arch | cache | readReplicas }] } }`.
   Several alternatives can go in one call; they are ranked.
5. **Answer**, in this order:
   - verdict and confidence; a low-confidence pass is *not* safe, so recommend a load test;
   - money as a range, saying whether it is the bill or list prices;
   - minutes out of SLO added, the worst moment and why, endpoints that get worse;
   - what would make it safer, when it fails (verify that alternative too);
   - the `app.open` link (the Backtest screen with these strategies) and the HTML report path.

Never apply a change because it passed. Never run `kubectl` or `terraform apply` yourself as
part of this skill.
