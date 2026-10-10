# Verifying infrastructure changes with Bottleneck

Copy this section into your project's `AGENTS.md` (or `CLAUDE.md`, `.cursorrules`, …) so coding
agents check infrastructure changes against production history before proposing them.

## Rule

Before proposing or committing a change to replicas, CPU or memory limits, autoscaling, instance
types or architecture (Graviton), caches, read replicas, retries or timeouts, verify it with
Bottleneck and report the verdict.

## How

Bottleneck runs as an MCP server (`bottleneck`) or from the shell. The shell form, JSON in and
JSON out:

```bash
B="node /path/to/bottleneck/dist-cli/bottleneck.mjs agent"

$B model_status                                     # what's already there; follow "next"
# only if there is no model, or it is older than a week:
$B connect_telemetry '{"prometheus":{"url":"<prometheus-url>","tokenEnv":"PROM_TOKEN"},"jaeger":{"url":"<jaeger-url>"},"system":{"name":"<system>","slo":{"p99Ms":<p99>,"errorRate":<rate>}}}'
$B collect_telemetry '{"last":"7d"}'
$B calibrate_model

# the change: a strategy, a Kubernetes diff, or a Terraform plan
terraform show -json plan.out > /tmp/plan.json
$B verify_change '{"changes":[{"terraformPlan":"/tmp/plan.json"}]}'
$B verify_change '{"changes":[{"kubernetes":{"base":"k8s/","head":"k8s-new/"}}]}'
$B verify_change '{"changes":[{"strategy":{"name":"Graviton for api","changes":[{"service":"api","arch":"arm"}]}}]}'
```

## Reporting

Answer in this order:

1. **Verdict and confidence**: `pass` / `fail` / `inconclusive`, and `high` / `medium` / `low`.
   A pass with low confidence means the change runs a service past anything the history showed:
   say so, and recommend a load test instead of calling it safe.
2. **Money**: `cost.monthlyDelta` as a range when `lo` and `hi` differ, and `cost.basis` (your
   bill, or list prices).
3. **Reliability**: minutes out of SLO added, the worst moment and its `why`, endpoints that get
   worse.
4. **What would make it safer**, if it failed.
5. The HTML report path (`reports.html`) for a human, or `reports.bundle`, which opens on the app's
   Backtest screen when dropped on it.

Never present a backtest as a guarantee. Never apply anything because a verdict passed; applying
is a separate, human-approved step.
