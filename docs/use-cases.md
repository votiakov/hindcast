# Use cases

What people use Bottleneck for, what each needs, and how to do it. Two families:

- **With your real data** — metric exports, traces and the bill from a running system; the model
  is calibrated from them and its accuracy is shown. Answers are about *your* system.
- **Without data** — a design drawn on the board, imported from Terraform or Kubernetes, or written
  as YAML; numbers come from the component catalogue (or your own). Answers are directional:
  good for comparing designs, finding the weak spot, and teaching.

---

## With your real data

### 1. Will this resize save money without hurting users?

*"Can we drop the API from 2 vCPU to 1?"*

- **Needs**: request metrics and CPU per service (Prometheus or CloudWatch), traces, the bill.
- **How**: write the strategy and backtest it over the last weeks.
  ```yaml
  name: API on 1 vCPU
  changes:
    - service: api
      cpu: 1
  ```
  ```
  bottleneck backtest model.json dataset.json api-1cpu.yaml --last 14d --html report.html
  ```
- **You get**: $/month saved (with a range), minutes out of SLO, failed requests, and the worst
  moment and why ("Sep 14 12:03 — api at 104% of capacity, 1.2 s queue"). A resize below the CPU
  the service actually uses makes it CPU-bound, and the backtest shows where that bites.
- **Evidence**: the Astronomy Shop's 1-core frontend was predicted to break at 574 req/s; measured
  614 (6.5%).

### 2. Move to Graviton (Arm)

- **Strategy**: `arch: arm` per service → Arm pricing (×0.8 per vCPU-hour on Fargate). Set
  `perf:` from your own benchmark if throughput per vCPU differs; otherwise it is assumed equal and
  the report says so.
- **You get**: the saving per month and whether anything gets closer to its limit.

### 3. Tune an autoscaling policy

*"Target 60% or 75%? 30-second or 60-second metrics? How much warm-up?"*

- **Strategy**: `autoscale: { min, max, targetCpu, warmupS, cooldownS, intervalS, metricWindowS }`.
  Write one per candidate and backtest them together — they are ranked side by side.
- **You get**: replicas over time, cost, and the minutes the scaler was too slow (a ramp it didn't
  catch during warm-up). The scaler runs on its own clock with its metric window, so CloudWatch's
  60-second averages behave differently from a 15-second Prometheus window.
- **Evidence**: the Astronomy Shop's autoscaled run was predicted to within 9% on p99 and 3% on cost.

### 4. Add replicas, a cache or a read replica

- `replicas: 3` — fixed count. `cache: { hitRate: 0.8 }` — a cache in front (a hit skips that
  service and everything below it; ElastiCache price unless given). `readReplicas: 1` with
  `readShare: 0.8` — reads split over primary and replicas.
- **You get**: what it costs against the time out of SLO it removes.
- **Evidence**: HotROD — a second customer replica was predicted to fix latency but *not* raise the
  breaking point (the driver's errors cap it at 7.7 req/s); the stress test measured 7.7.

### 5. Find the breaking point and the headroom

*"How much more traffic can we take before Black Friday, and what gives out first?"*

```
bottleneck headroom model.json [strategy.yaml]
```

- **You get**: the req/s it sustains with today's endpoint mix within the SLO, and the component
  that saturates next ("Sustains 6.1 req/s … then mysql saturates"), with the model's accuracy.
  In the app, the Model tab lists every component's capacity and what limits it (CPU, a lock or
  pool, a knee seen in the history), and flags limits that are extrapolated.
- **Evidence**: breaking points within 0–13% on all three reference systems.

### 6. Retry budgets and client timeouts

- **Strategy**: `endpoint: "*"` (or one endpoint) with `retries: { attempts: 2, budget: 0.1 }` and
  `timeoutMs:`.
- **You get**: whether retries would have turned a blip into an outage — the backtest replays the
  extra load the retries create. A strategy with no budget can show up as 100% errors at the peak
  (HotROD's "Clients retry twice, no budget" does exactly that).

### 7. Check a pull request before it merges

- **Needs**: a calibrated model and dataset committed (or fetched) in the repository, and the
  ready-made workflow from [examples/backtest-ci](../examples/backtest-ci).
- **How**: the workflow turns the changed Kubernetes manifests into a strategy
  (`bottleneck diff-strategy --base … --head …`: replicas, CPU/memory limits, HPAs,
  `kubernetes.io/arch`), backtests it over the last N days, and posts the result on the PR. `--gate`
  fails the check if the change adds time out of SLO.
- **You get**: "frontend CPU 1 → 0.05 saves $23/month; it would have caused 20 minutes out of SLO,
  the worst on Oct 7 at 16:26 UTC". A working repository: `scripts/make-backtest-demo.sh`.

### 8. Would we survive a famous outage?

```
bottleneck outage model.json list
bottleneck outage model.json slack-2021-01-04 autoscale.yaml --role primary-db=orders-db
```

or Backtest tab → *Replay an outage…*

- **What it is**: the published timeline of Cloudflare 2019, GitHub 2018, Slack 2021 or AWS us-east-1
  2025 turned into what your system would have felt — traffic relative to your normal load and faults
  on roles (`edge`, `primary-db`, `managed-kv`, `compute`, `all`) mapped to your components.
- **You get**: minutes out of SLO, failed requests and the worst moment, as built and with each
  strategy — e.g. whether autoscaling helps when launches are impaired. Each replay states its
  assumptions and cites its source.

### 9. Where does the money go, per endpoint and across zones?

- **Needs**: traces (payload sizes per hop), `placement:` zones/regions per service, the bill.
- **You get**: $ per million requests per endpoint (compute along its path, usage-billed requests,
  data transfer); a `zone:` / `region:` change in a strategy prices the cross-zone and cross-region
  bytes it adds or removes.

### 10. Endpoint SLOs

- Give critical endpoints their own SLO in the manifest (`model.endpoints.<id>.slo`). The Endpoints
  tab and the report count minutes out of *each endpoint's own* SLO — a checkout that must answer in
  800 ms is judged by that, not by the system's average.

### 11. Find what the model can't explain

- Every component gets a fit status from replaying the history: good / fair / poor / unexplained /
  cost only, with notes. Use it as an audit of your telemetry: a service that is "cost only" is in the
  bill but never in traces; "unexplained" latency means something outside the model (a cron job, a
  noisy neighbour, a missing span) is moving it.

### 12. Open a moment on the board

- Click any moment of the history: the system appears as a live canvas, replaying that bucket's
  traffic through the model. Explore it like a Sandbox design — kill a component, add a cache — and
  press *Backtest these edits* to replay that change over the whole history.

### 13. Turn a result into a post

- Backtest tab → **Card ↗**, or `bottleneck backtest … --card card.json` then
  `npm run record -- --card card.json`: the chart drawing itself, then the verdict, as MP4 and PNG
  stills at post size, with the model's measured accuracy on the card.

---

## Without data

### 14. Find what breaks first in a design, and what it costs

- Draw it, import it (`import-terraform`, `import-k8s`, or drop the file on the board), or write it
  as YAML. Run the **failure audit** (Sandbox → audit, or `bottleneck audit arch.yaml --rps 500
  --cost-per-min 1000`).
- **You get**: a risk register — every component dying, every dependency turning slow, caches
  restarting cold, zones going dark, a traffic surge — graded by what users would have seen, with
  blast radius, recovery time and $ at risk; each fix verified by re-running the incident and priced
  per month. `audit` exits with code 2 on a critical finding, so it can gate a PR that changes a spec.

### 15. Compare two designs

- **Compare** tab (17 built-in comparisons) or `bottleneck compare arch.yaml variants.yaml
  scenario.yaml`. Same traffic and failures on both; the engine computes the takeaway.

### 16. Cheapest sizing that meets the SLO

- Analysis → optimizer, or `bottleneck optimize arch.yaml scenario.yaml --runtimes --out
  optimized.yaml`; optionally lets it change language runtimes.

### 17. Confidence, not one run

- `bottleneck analyze` / Analysis → Monte Carlo: discrete-event runs with 95% confidence intervals
  on p50/p99/p99.9, errors and cost; the share of runs that meet the SLO.

### 18. Learn system design by breaking things

- **Lessons**: scaling basics, retry storms, autoscaling lag and cold-cache stampedes, AI serving,
  language runtimes — each level has an objective the engine checks.
- **Live**: a failing system with the next move pinned to the component under stress.

### 19. Explain an incident or a design to a room

- **Present** (P): no chrome, large numbers, captions; ←/→ walks through the audit's incidents.
  The timeline's *Copy* gives the run as an incident timeline in Markdown.

### 20. Ask an AI assistant

- The **MCP server** gives Claude (or any MCP client) the same engine: `import_terraform`,
  `audit_resilience`, `compare_architectures`, `optimize_cost`, `backtest_strategy`, `replay_outage`
  and more; `show_architecture` renders the live canvas inline in hosts that support MCP Apps.
  See [tools.md](tools.md#mcp-server--npm-run-mcp).

### 21. Make comparison videos

- **Studio**: scripted A/B episodes rendered to MP4 and carousels in four formats, three themes and
  your brand. See [content.md](content.md).
