# Kubernetes reference — would the backtest have told you the truth?

The Docker reference systems run on Docker Compose with synthetic traffic. This one runs the
observability stack most Kubernetes teams run, on a laptop cluster (kind, two workers), with
traffic shaped by a real web log, and asks the question that matters: **before a
change ships, does the backtest's verdict match what really happens when it ships?**

Two systems answer it here: the Astronomy Shop below, which the model's throttle rules were shaped
on, and [PetClinic](petclinic/README.md), which they weren't. Out of sample, with every verdict
committed before its run: the Shop 6 right, 1 wrong, 8 inconclusive; PetClinic 5 right, 1 wrong, 3
inconclusive; together 11, 2 and 11 of 24, against a plain CPU-ratio rule's 18 right and 6 wrong.
What the first 8 inconclusives rest on, and why they don't yet separate passes from failures, is
[after the PetClinic summary](#a-second-system-petclinic).

## The setup

- **Cluster**: [kind](https://kind.sigs.k8s.io) with a control plane and two workers
  ([kind.yaml](kind.yaml)).
- **Observability**, the common production stack:
  - kube-prometheus-stack: kubelet/cAdvisor, kube-state-metrics, Prometheus scraping every 15 s
    ([monitoring.values.yaml](monitoring.values.yaml)).
  - ingress-nginx with its request metrics.
  - An OpenTelemetry Collector turning every span into RED metrics.
  - Jaeger keeping a 10% sample of traces.
- **The system**: the OpenTelemetry Astronomy Shop (2.0.2), 11 services in 9 languages, as plain
  manifests ([shop/gen.ts](shop/gen.ts) → [shop/shop.yaml](shop/shop.yaml)), with CPU requests
  equal to limits. The frontend runs 3 replicas: the over-provisioned starting point the questions
  try to trim.
- **Traffic**: the arrival curve of a real log, not real users. The NASA Kennedy Space Center web server log for July 1995 (Internet Traffic
  Archive), replayed with k6 at 83× its rate. Each day is compressed into 40 minutes; arrivals are
  Poisson within each 20-second slice, so the curve and the spikes are the log's own
  ([../load/fromLog.mjs](../load/fromLog.mjs)).
  - **12 July** is an ordinary day: it peaks at 180 req/s.
  - **13 July** is the launch of Space Shuttle STS-70: a real flash crowd, 2.2× the ordinary
    day's peak.
- **The agent's path**: each run's telemetry is collected the way an agent collects it.
  `connect_telemetry` and `collect_telemetry` run against the live Prometheus and Jaeger, and k6
  keeps every request it made as the ground truth.

## The questions

The model is calibrated on one ordinary day (`history`) and never sees any other run. Each change
is a manifest variant, as a pull request would leave it ([shop/variants](shop/variants)):

| run | the question | the change, applied for real |
|---|---|---|
| `launch` | Does the system as built survive launch day? | — |
| `normal-2` | Can the frontend go from 3 replicas to 2 on an ordinary day? | `frontend-2.yaml` |
| `launch-2` | …and on launch day? | `frontend-2.yaml` |
| `normal-1` | Can it go to 1 replica on an ordinary day? | `frontend-1.yaml` |
| `launch-hpa` | Does an HPA (1–3 replicas at 60% CPU) handle launch day? | `frontend-hpa.yaml` |

For each run, three answers are compared with what k6 measured:

1. **The verdict before the change shipped**: `verify_change` on the calibration day. For launch
   day it is replayed at 2.2× (`traffic: { scale: 2.2 }`), the forecast an engineer would make.
2. **The model's prediction over the traffic that actually came**: model error alone, without
   forecast error. This gives p99 over every request, the error rate, and minutes out of SLO
   (SLO: p99 ≤ 1 s, errors ≤ 1%).
3. **The naive answer**: the frontend's busiest CPU utilisation in the history, scaled by the change
   (3/2, 3/1) and by the forecast. "Under 100% is fine."

Reality's verdict uses the same gate as `verify_change`. A change fails if it adds more than
half a minute out of SLO over the as-built system on the same day, or if more of its requests fail
than failed as built by more than the SLO's error budget over the day (1% of its requests); the
as-built system fails if it spends any minute out of SLO or fails more than 1% of its requests.

**The gate changed on 2026-10-17** to count failed requests as well as minutes: a change on a day
already out of SLO at its peak can't add minutes there, however many more requests it fails.
Every verdict below was recomputed with it, reality's and the backtest's, and none moved; nor did
any of PetClinic's (scored from the request counts its validation record keeps, as its request logs
are not in the repository): on every run the change either already failed on the minutes or stayed well within
the budget (the closest, `launch-2-750`, fails 1,606 more requests than launch day as built against
a budget of 3,001, and fails on its 4 minutes anyway).

## Results

**Recomputed on 2026-10-16, after an importer fix.** The frontend runs several replicas (three as
built, two in `normal-2`, two to five under the HPA), and the collector wrote their span-metric
counters into one Prometheus series per endpoint. Each time the series switched between replicas,
`rate()` read the drop as a counter reset, so the frontend's mix of requests read from the metrics
was wrong, by a different amount for each endpoint. The importer now takes the mix from the traces
where the two disagree beyond sampling and the services behind the frontend side with the traces.
Every collection below was imported again from the files it was collected with: nothing was
re-recorded, no measurement changed, and the predictions committed before the runs, with every
backtest verdict, are the same. Two collections were affected, `normal-2` (checkouts were 1.2% of
its requests by the series, 4.2% by the traces) and `launch-x1.3-hpa`. What moved, before → after:

- `normal-2`, model on the day's real traffic: ordinary-day model p99 81 → 83 ms, errors
  0.00% → 0.03%, 0 → 1 min out of SLO; with the load test, errors 0.00% → 0.04%, 0 → 0.5 min.
- `launch-x1.3-hpa`, same column: p99 268 → 265 ms, errors 0.05% → 0.06%, 1.5 → 1 min; with the
  load test, p99 352 → 342 ms, errors 0.11% → 0.13%, 1 → 2 min.
- Memory leak, model on the day: `normal-2` no kill → `email` killed at minute 36.3 (it wasn't, so
  the kill-or-not call is right in 10 of 13 runs, before 11); `launch-x1.3-hpa` minute 21.3 → 19.5
  (observed 22.0).
- The accuracy record shipped with the model ([k8s-shop.json](../../public/reference/k8s-shop.json)):
  p99 error `normal-2` 16.5% → 17.3%, `launch-x1.3-hpa` 9.8% → 6.5%; both still within 20%.

Unchanged: the out-of-sample tally (3 right, 1 wrong, 5 inconclusive), the in-sample scores, p99
within 20% on the day's traffic in 3 of 14 runs, and the node loss (+7 min and 21,221 failed
predicted, +7 min and 16,804 on the day). The re-import also marks the gRPC calls and leaves
timed-out requests out of the runs' quiet-time baselines; neither moves a number here, because the
models are calibrated on the history collections.

**Recomputed on 2026-10-17, after two more fixes, found while checking round 5.** The frontend
(Next.js) wraps each request in two server spans. The outer one appears in span metrics as an
endpoint named only by its method ("frontend GET", "frontend POST"). The importer dropped those
series only where the traces showed exactly 2 server spans per visit. In the load test, a few
traces lost their outer span, and the average fell to 1.986. So the method-only series stayed, as
18% of the frontend's requests calling nothing behind it. The importer now drops them where most
visits carry two spans (1.5 or more). Second, a few broken traces kept the series' own template
(`GET /api/products/{id}`, 42 traces visiting product-catalog 0.57 times) beside the framework's
name for the same route (`/api/products/[productId]`, 4,829 traces visiting it once). The exact
name won. Now the matching name with the most traces does, in calibration and in the importer's
mix check. Six collections had frontends at 1.92–1.998 spans per visit: the load-tested model's
history, `normal-1`, `normal-nodeloss`, `normal-x1.5`, `launch-2-750` and `launch-email300`. They
were imported again from the files they were collected with (the history and `launch-2-750` now
take their endpoint mix from the traces, which match what the services behind served within 4%,
against 15% for the series). Nothing was re-recorded. The predictions committed before the runs
are unchanged, and so are the out-of-sample scores, which count them. What moved, before → after:

- The load-tested model, as built on launch day (in sample): **pass → fail**, 0.5 → 2 min out of
  SLO, measured 0.5. Wrong. With checkouts at 4.0% of requests instead of 3.0%, its leak takes
  `email` to the limit at minute 19.8 and again at 32.3 (the real kill came at 27.5), and it counts
  both restarts. The ordinary-day model already calls this day a fail for the same reason. The
  load-tested in-sample score goes from 2 right, 0 wrong to 1 right, 1 wrong.
- The load-tested model on `launch-cart250` today (round 4, measured fail): pass → inconclusive.
  Its score counts the pass committed before the run.
- So one verdict became wrong and one wrong verdict became a hedge. None became right.
- Its minutes before the day, with no verdict moving: `normal-2` 0 → 0.5, `launch-2` 4.5 → 5.5,
  `normal-1` 0 → 0.5, `launch-hpa` 1 → 2.5.
- The model on the day's real traffic, `normal-1`, ordinary-day model: 0 → 11 min out of SLO,
  p99 83 → 5000 ms (measured 19.5 min, 5007 ms). Half of that run's frontend requests had been on
  the method-only series, which the ordinary-day model has no endpoint for, so its replay had
  dropped them. p99 within 20% of measured: ordinary-day model 4 → 6 of 20 runs, load-tested 7 → 6.
- Node loss on the day: +7 min and 16,804 failed → +7.5 min and 50,367 (measured +10.5 min,
  32,886).
- Memory leak on the day: `normal-1` no kill → minute 36.6 (none came, so the kill-or-not call is
  right in 9 of 13, was 10), `launch-2-750` 29.3 → 21.8 (observed 29.0), `normal-x1.5` 35.9 →
  30.5 (observed 35.0). These replays now carry all of the frontend's requests, and more
  checkouts reach `email`.

<!-- RESULTS -->
**Calibrated on the ordinary day:**

| run | question | measured (k6, every request) | backtest before the day | model on the day’s real traffic | naive CPU ratio |
|---|---|---|---|---|---|
| `launch` | As built (3 frontend replicas), on launch day? | **pass**: p99 419 ms, errors 0.00%, 0.5 min out of SLO | fail ❌, 1 min | p99 116 ms, errors 0.11%, 1 min | pass ✅ at 84% CPU |
| `normal-2` | 2 frontend replicas instead of 3, on an ordinary day? | **pass**: p99 142 ms, errors 0.02%, 1 min out of SLO | pass ✅ (medium confidence), 0 min | p99 83 ms, errors 0.03%, 1 min | pass ✅ at 57% CPU |
| `launch-2` | 2 frontend replicas instead of 3, on launch day? | **fail**: p99 5233 ms, errors 45.3%, 11.5 min out of SLO | fail ✅ (low confidence), 19.3 min | p99 5000 ms, errors 61.1%, 15.5 min | fail ✅ at 126% CPU |
| `normal-1` | 1 frontend replica, on an ordinary day? | **fail**: p99 5007 ms, errors 27.9%, 19.5 min out of SLO | fail ✅ (low confidence), 10.5 min | p99 5000 ms, errors 31.5%, 11 min | fail ✅ at 113% CPU |
| `launch-hpa` | An HPA (1–3 replicas at 60% CPU) instead of 3 fixed, on launch day? | **fail**: p99 159 ms, errors 0.08%, 1.5 min out of SLO | fail ✅ (low confidence), 2.5 min | p99 3742 ms, errors 1.2%, 2.5 min | pass ❌ at 84% CPU |

Backtest verdicts: **4 right**, 0 inconclusive (it said to load-test), 1 wrong, of 5. Naive CPU ratio: 4 right.

*Out of sample* — added after the throttle model was designed on the runs above; the verdicts are the ones committed in `validation/predictions-oos.json` before each run was recorded:

| run | question | measured (k6, every request) | backtest before the day | model on the day’s real traffic | naive CPU ratio |
|---|---|---|---|---|---|
| `launch-2c` | 2 frontend replicas at 1 core instead of 3 at half a core, on launch day? | **fail**: p99 596 ms, errors 0.33%, 3.5 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 0 min | p99 72 ms, errors 0.12%, 0.5 min | pass ❌ at 63% CPU |
| `normal-1c` | 1 frontend replica at 1 core, on an ordinary day? | **pass**: p99 28 ms, errors 0.00%, 0 min out of SLO | pass ✅ (medium confidence), 0 min | p99 46 ms, errors 0.04%, 0.5 min | pass ✅ at 57% CPU |
| `normal-1-750` | 1 frontend replica at 750m, on an ordinary day? | **pass**: p99 55 ms, errors 0.00%, 0 min out of SLO | pass ✅ (medium confidence), 0 min | p99 65 ms, errors 0.03%, 0.5 min | pass ✅ at 76% CPU |
| `launch-x1.3` | As built, on a launch day with 30% more traffic? | **fail**: p99 1178 ms, errors 0.29%, 5.5 min out of SLO | fail ✅, 9 min | p99 5000 ms, errors 5.5%, 4 min | fail ✅ at 109% CPU |

Backtest verdicts: **3 right**, 1 inconclusive (it said to load-test; 0 of them leaned the right way), 0 wrong, of 4. Naive CPU ratio: 3 right.

*Out of sample* — round 2, chosen after round 1 was scored; the verdicts are the ones committed in `validation/predictions-oos-2.json` before each run was recorded:

| run | question | measured (k6, every request) | backtest before the day | model on the day’s real traffic | naive CPU ratio |
|---|---|---|---|---|---|
| `launch-x1.3-4` | 4 frontend replicas, on a launch day with 30% more traffic? | **pass**: p99 321 ms, errors 0.14%, 1 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 0 min | p99 5000 ms, errors 5.5%, 7 min | pass ✅ at 82% CPU |
| `launch-x1.3-hpa` | An HPA (2–5 replicas at 50% CPU), on a launch day with 30% more traffic? | **pass**: p99 327 ms, errors 0.10%, 0.5 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 0 min | p99 265 ms, errors 0.06%, 1 min | pass ✅ at 65% CPU |
| `launch-2-750` | 2 frontend replicas at 750m instead of 3 at half a core, on launch day? | **fail**: p99 293 ms, errors 0.54%, 4.5 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 0 min | p99 71 ms, errors 0.05%, 0.5 min | pass ❌ at 84% CPU |

Backtest verdicts: **0 right**, 3 inconclusive (it said to load-test; 2 of them leaned the right way), 0 wrong, of 3. Naive CPU ratio: 2 right.

*Out of sample* — round 3, chosen after round 2 was scored; the verdicts are the ones committed in `validation/predictions-oos-3.json` before each run was recorded:

| run | question | measured (k6, every request) | backtest before the day | model on the day’s real traffic | naive CPU ratio |
|---|---|---|---|---|---|
| `normal-x1.5` | As built, on an ordinary day with 50% more traffic? | **fail**: p99 250 ms, errors 0.70%, 6 min out of SLO | pass ❌, 0.5 min | p99 91 ms, errors 0.04%, 0.5 min | pass ❌ at 57% CPU |
| `launch-email300` | email with 300 MiB instead of 150, on launch day? | **pass**: p99 124 ms, errors 0.00%, 0 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 0 min | p99 113 ms, errors 0.00%, 0 min | pass ✅ at 84% CPU |

Backtest verdicts: **0 right**, 1 inconclusive (it said to load-test; 1 of them leaned the right way), 1 wrong, of 2. Naive CPU ratio: 1 right.

*Out of sample* — chosen after the leak, JIT warm-up, the failed-request gate and holdout confidence were added: three changes away from the frontend, in .NET, Python and Go; the verdicts are the ones committed in `validation/predictions-oos-4.json` before each run was recorded:

| run | question | measured (k6, every request) | backtest before the day | model on the day’s real traffic | naive CPU ratio |
|---|---|---|---|---|---|
| `launch-cart250` | cart at 250m instead of 500m, on launch day? | **fail**: p99 93 ms, errors 0.16%, 1.5 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 1 min | p99 108 ms, errors 0.05%, 0.5 min | pass ❌ at 90% CPU |
| `launch-rec2` | 2 recommendation replicas instead of 1, on launch day? | **fail**: p99 64 ms, errors 0.19%, 2 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 1 min | p99 110 ms, errors 0.06%, 0.5 min | pass ❌ at 84% CPU |
| `normal-catalog125` | product-catalog at 125m instead of 250m, on an ordinary day? | **pass**: p99 52 ms, errors 0.00%, 0 min out of SLO | pass ✅ (medium confidence), 0 min | p99 78 ms, errors 0.04%, 0.5 min | pass ✅ at 58% CPU |

Backtest verdicts: **1 right**, 2 inconclusive (it said to load-test; 0 of them leaned the right way), 0 wrong, of 3. Naive CPU ratio: 1 right.

*Out of sample* — chosen after the as-built launch day was recorded twice; a change fails only if it is worse than both recordings (launch and launch-b); the verdicts are the ones committed in `validation/predictions-oos-5.json` before each run was recorded:

| run | question | measured (k6, every request) | backtest before the day | model on the day’s real traffic | naive CPU ratio |
|---|---|---|---|---|---|
| `launch-catalog125` | product-catalog at 125m instead of 250m, on launch day? | **fail**: p99 175 ms, errors 0.38%, 3.5 min out of SLO | fail ✅ (low confidence), 4.5 min | p99 3801 ms, errors 0.90%, 3 min | fail ✅ at 129% CPU |
| `launch-checkout125` | checkout at 125m instead of 250m, on launch day? | **pass**: p99 80 ms, errors 0.00%, 0 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 1 min | p99 103 ms, errors 0.05%, 0.5 min | pass ✅ at 84% CPU |
| `launch-3-400` | 3 frontend replicas at 400m instead of 500m, on launch day? | **fail**: p99 194 ms, errors 0.40%, 3.5 min out of SLO | fail ✅ (low confidence), 7.5 min | p99 5000 ms, errors 4.7%, 3.5 min | fail ✅ at 105% CPU |

Backtest verdicts: **2 right**, 1 inconclusive (it said to load-test; 1 of them leaned the right way), 0 wrong, of 3. Naive CPU ratio: 3 right.

**Every out-of-sample round together** (15 runs): Backtest verdicts: **6 right**, 8 inconclusive (it said to load-test; 4 of them leaned the right way), 1 wrong, of 15. Naive CPU ratio: 10 right, 5 wrong (a rule like that never abstains).

p99 of the model on each day's real traffic, against the measured p99: within 20% in **6 of 20** runs; the others off by 29–2477%.

**Calibrated on the ordinary day and a 12-minute load test:**

| run | question | measured (k6, every request) | backtest before the day | model on the day’s real traffic | naive CPU ratio |
|---|---|---|---|---|---|
| `launch` | As built (3 frontend replicas), on launch day? | **pass**: p99 419 ms, errors 0.00%, 0.5 min out of SLO | fail ❌, 2 min | p99 150 ms, errors 0.13%, 1.5 min | pass ✅ at 84% CPU |
| `normal-2` | 2 frontend replicas instead of 3, on an ordinary day? | **pass**: p99 142 ms, errors 0.02%, 1 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 0.5 min | p99 118 ms, errors 0.04%, 0.5 min | pass ✅ at 57% CPU |
| `launch-2` | 2 frontend replicas instead of 3, on launch day? | **fail**: p99 5233 ms, errors 45.3%, 11.5 min out of SLO | fail ✅ (low confidence), 5.5 min | p99 5000 ms, errors 27.0%, 10 min | fail ✅ at 126% CPU |
| `normal-1` | 1 frontend replica, on an ordinary day? | **fail**: p99 5007 ms, errors 27.9%, 19.5 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 0.5 min | p99 273 ms, errors 0.04%, 0.5 min | fail ✅ at 113% CPU |
| `launch-hpa` | An HPA (1–3 replicas at 60% CPU) instead of 3 fixed, on launch day? | **fail**: p99 159 ms, errors 0.08%, 1.5 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 2.5 min | p99 181 ms, errors 0.05%, 1 min | pass ❌ at 84% CPU |

Backtest verdicts: **1 right**, 3 inconclusive (it said to load-test; 1 of them leaned the right way), 1 wrong, of 5. Naive CPU ratio: 4 right.

*Out of sample* — added after the throttle model was designed on the runs above; the verdicts are the ones committed in `validation/predictions-oos.json` before each run was recorded:

| run | question | measured (k6, every request) | backtest before the day | model on the day’s real traffic | naive CPU ratio |
|---|---|---|---|---|---|
| `launch-2c` | 2 frontend replicas at 1 core instead of 3 at half a core, on launch day? | **fail**: p99 596 ms, errors 0.33%, 3.5 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 0 min | p99 134 ms, errors 0.13%, 1 min | pass ❌ at 63% CPU |
| `normal-1c` | 1 frontend replica at 1 core, on an ordinary day? | **pass**: p99 28 ms, errors 0.00%, 0 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 0 min | p99 88 ms, errors 0.04%, 0.5 min | pass ✅ at 57% CPU |
| `normal-1-750` | 1 frontend replica at 750m, on an ordinary day? | **pass**: p99 55 ms, errors 0.00%, 0 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 0 min | p99 101 ms, errors 0.04%, 0.5 min | pass ✅ at 76% CPU |
| `launch-x1.3` | As built, on a launch day with 30% more traffic? | **fail**: p99 1178 ms, errors 0.29%, 5.5 min out of SLO | pass ❌, 0 min | p99 336 ms, errors 0.18%, 1.5 min | fail ✅ at 109% CPU |

Backtest verdicts: **0 right**, 3 inconclusive (it said to load-test; 2 of them leaned the right way), 1 wrong, of 4. Naive CPU ratio: 3 right.

*Out of sample* — round 2, chosen after round 1 was scored; the verdicts are the ones committed in `validation/predictions-oos-2.json` before each run was recorded:

| run | question | measured (k6, every request) | backtest before the day | model on the day’s real traffic | naive CPU ratio |
|---|---|---|---|---|---|
| `launch-x1.3-4` | 4 frontend replicas, on a launch day with 30% more traffic? | **pass**: p99 321 ms, errors 0.14%, 1 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 0 min | p99 2887 ms, errors 0.28%, 2.5 min | pass ✅ at 82% CPU |
| `launch-x1.3-hpa` | An HPA (2–5 replicas at 50% CPU), on a launch day with 30% more traffic? | **pass**: p99 327 ms, errors 0.10%, 0.5 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 0 min | p99 364 ms, errors 0.13%, 2 min | pass ✅ at 65% CPU |
| `launch-2-750` | 2 frontend replicas at 750m instead of 3 at half a core, on launch day? | **fail**: p99 293 ms, errors 0.54%, 4.5 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 0 min | p99 106 ms, errors 0.06%, 1 min | pass ❌ at 84% CPU |

Backtest verdicts: **0 right**, 3 inconclusive (it said to load-test; 2 of them leaned the right way), 0 wrong, of 3. Naive CPU ratio: 2 right.

*Out of sample* — round 3, chosen after round 2 was scored; the verdicts are the ones committed in `validation/predictions-oos-3.json` before each run was recorded:

| run | question | measured (k6, every request) | backtest before the day | model on the day’s real traffic | naive CPU ratio |
|---|---|---|---|---|---|
| `normal-x1.5` | As built, on an ordinary day with 50% more traffic? | **fail**: p99 250 ms, errors 0.70%, 6 min out of SLO | pass ❌, 0.5 min | p99 151 ms, errors 0.03%, 0.5 min | pass ❌ at 57% CPU |
| `launch-email300` | email with 300 MiB instead of 150, on launch day? | **pass**: p99 124 ms, errors 0.00%, 0 min out of SLO | pass ✅ (medium confidence), 0 min | p99 161 ms, errors 0.00%, 0 min | pass ✅ at 84% CPU |

Backtest verdicts: **1 right**, 0 inconclusive (it said to load-test), 1 wrong, of 2. Naive CPU ratio: 1 right.

*Out of sample* — chosen after the leak, JIT warm-up, the failed-request gate and holdout confidence were added: three changes away from the frontend, in .NET, Python and Go; the verdicts are the ones committed in `validation/predictions-oos-4.json` before each run was recorded:

| run | question | measured (k6, every request) | backtest before the day | model on the day’s real traffic | naive CPU ratio |
|---|---|---|---|---|---|
| `launch-cart250` | cart at 250m instead of 500m, on launch day? | **fail**: p99 93 ms, errors 0.16%, 1.5 min out of SLO | pass ❌ (medium confidence), 0.5 min | p99 132 ms, errors 0.06%, 0.5 min | pass ❌ at 90% CPU |
| `launch-rec2` | 2 recommendation replicas instead of 1, on launch day? | **fail**: p99 64 ms, errors 0.19%, 2 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 0.5 min | p99 150 ms, errors 0.05%, 0.5 min | pass ❌ at 84% CPU |
| `normal-catalog125` | product-catalog at 125m instead of 250m, on an ordinary day? | **pass**: p99 52 ms, errors 0.00%, 0 min out of SLO | pass ✅ (medium confidence), 0 min | p99 113 ms, errors 0.03%, 0.5 min | pass ✅ at 58% CPU |

Backtest verdicts: **1 right**, 1 inconclusive (it said to load-test; 0 of them leaned the right way), 1 wrong, of 3. Naive CPU ratio: 1 right.

*Out of sample* — chosen after the as-built launch day was recorded twice; a change fails only if it is worse than both recordings (launch and launch-b); the verdicts are the ones committed in `validation/predictions-oos-5.json` before each run was recorded:

| run | question | measured (k6, every request) | backtest before the day | model on the day’s real traffic | naive CPU ratio |
|---|---|---|---|---|---|
| `launch-catalog125` | product-catalog at 125m instead of 250m, on launch day? | **fail**: p99 175 ms, errors 0.38%, 3.5 min out of SLO | pass ❌ (medium confidence), 0.5 min | p99 153 ms, errors 0.06%, 0.5 min | fail ✅ at 129% CPU |
| `launch-checkout125` | checkout at 125m instead of 250m, on launch day? | **pass**: p99 80 ms, errors 0.00%, 0 min out of SLO | pass ✅ (medium confidence), 0.5 min | p99 129 ms, errors 0.06%, 0.5 min | pass ✅ at 84% CPU |
| `launch-3-400` | 3 frontend replicas at 400m instead of 500m, on launch day? | **fail**: p99 194 ms, errors 0.40%, 3.5 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 0.5 min | p99 185 ms, errors 0.06%, 0.5 min | fail ✅ at 105% CPU |

Backtest verdicts: **1 right**, 1 inconclusive (it said to load-test; 0 of them leaned the right way), 1 wrong, of 3. Naive CPU ratio: 3 right.

**Every out-of-sample round together** (15 runs): Backtest verdicts: **3 right**, 8 inconclusive (it said to load-test; 4 of them leaned the right way), 4 wrong, of 15. Naive CPU ratio: 10 right, 5 wrong (a rule like that never abstains).

p99 of the model on each day's real traffic, against the measured p99: within 20% in **6 of 20** runs; the others off by 30–799%.

**A node failure, for real:** check_node_loss from the ordinary day and the pod placement at the instant of the kill, the model on the day’s own traffic, and the client’s measurement — each against the as-built ordinary day.

| run | node lost | services left with no replica | predicted before | model on the day | measured |
|---|---|---|---|---|---|
| `normal-nodeloss` | bnk8s-worker at minute 19.3 | ad, cart, email, jaeger, payment, quote, shipping | +7 min, +21,221 failed | +7.5 min, +50,367 failed | +10.5 min, +32,886 failed |

**A memory leak:** the minutes into each run at which the ordinary-day model has the leaking service OOM-killed — committed before the run (out of sample), and replayed on the run’s own traffic — against the minutes its working set really dropped.

| run | service | predicted before | model on the day | observed |
|---|---|---|---|---|
| `history` | email | — | none | none |
| `launch` | email | — | 21.9 | 27.5 |
| `normal-2` | email | — | 36.3 | none |
| `launch-2` | email | — | 26.7 | none |
| `normal-1` | email | — | 36.6 | none |
| `launch-hpa` | email | — | 23.1 | 25.5 |
| `launch-2c` | email | — | 17.3 | 28.0 |
| `normal-1c` | email | — | 36.8 | 40.0 |
| `normal-1-750` | email | — | 36.7 | none |
| `launch-x1.3` | email | — | 17.5, 33.2 | 22.0 |
| `launch-x1.3-4` | email | — | 18.0, 26.6 | 21.5 |
| `launch-x1.3-hpa` | email | — | 19.5 | 22.0 |
| `launch-2-750` | email | — | 21.8 | 29.0 |
| `normal-x1.5` | email | 29.5 | 30.5 | 35.0 |
| `launch-email300` | email | none | none | none |
| `launch-cart250` | email | 23.3 | 21.6 | 27.0 |
| `launch-rec2` | email | 23.3 | 26.9 | 25.5 |
| `normal-catalog125` | email | none | 35.1 | none |
| `launch-catalog125` | email | 23.3 | 22.4 | 27.0 |
| `launch-checkout125` | email | 23.3 | 22.3 | 24.0 |
| `launch-3-400` | email | 23.3 | 22.3 | 28.5 |

The first 2 minutes of every run are left out of the scoring, measured and predicted alike (pods restarted minutes earlier). Generated by `npx tsx reference/k8s/evaluate.ts`, 2026-10-17.
<!-- /RESULTS -->

## What it says

- **The first version overestimated a single-threaded service under a CPU limit.** In the load
  test, the frontend (Node.js, half a core per pod) collapsed at about 195 requests/s per pod. At
  that point its CPU was at 79% of the limit and throttled in 44% of CFS periods. Under hours of real
  traffic it broke 15–20% below that (normal-1, launch-2). The model read capacity from CPU per
  request extrapolated to 100% of the limit, 214–246 req/s. It called one replica safe on an
  ordinary day (27% errors) and the autoscaler safe on launch day. From the ordinary day alone it
  got 2 of 5 right; a plain CPU-ratio rule got 4.
- **Calibration now reads CFS throttling** (`container_cpu_cfs_throttled_periods_total`, in the
  kubernetes preset). On the ordinary day the frontend was throttled in 2.6% of periods at 12% of
  its limit and 8.8% at 37%. Fitted as an exponential, that reaches 25%, the threshold of
  kube-prometheus's `CPUThrottlingHigh` alert, at 66% of the limit. That is the CPU the model now
  lets it use: 134 req/s per pod, where it used to assume 214–246.
  Two guards keep this from penalising services that run throttled without harm. `recommendation`
  (Python) spends a quarter of its periods throttled and handled launch day fine:
  - the throttle cap overrides a capacity read from latency only where the history shows the
    service failing while throttled (the load test's last step, for the frontend);
  - a service seen throttled past the threshold while keeping its latency is left alone.
- **With it, the ordinary day alone got all 5 right when these rules were written**, the
  autoscaler included, which the CPU-ratio rule calls safe. (Since the leak term was added, it
  gets 4: it now calls the as-built launch day a fail by a minute; see the leak below.) With the load test as well: 3 right and 2 inconclusive (it asked for a
  load test), none wrong. The load test reads a higher limit (72% of the limit, 169 req/s per pod),
  because 60-second steps hold briefly what hours of traffic can't. Its latency fit for the frontend
  is poor, which is why it hedges.
- **Caveat: the throttle rules were designed while looking at these five runs.** The 25%
  threshold comes from the alert rather than from these results. The two guards came from what
  went wrong here, so the score above is in-sample until new runs confirm it.
- **Out of sample, across all three rounds, the calm-day model got 3 of 9 right, 1 wrong, and
  said inconclusive on 5** (3 of those leaned the right way). The CPU-ratio rule got 6 right and 3
  wrong. The model is wrong less often because it abstains more often: on hit rate alone it does
  not beat the rule. Its p99 on each day's own traffic is within 20% of the measured p99 in 3 of
  14 runs; it underestimates busy days.
- **Round 1: 3 of 4 right, with none wrong.** Its verdicts on four new
  questions were committed
  ([predictions-oos.json](shop/validation/predictions-oos.json)) before those runs were recorded:
  - 30% more launch traffic: fail. ✓
  - one 1-core frontend on an ordinary day: pass. ✓
  - one 750m frontend on an ordinary day: pass. ✓
  - 2 frontends at 1 core instead of 3 at half a core on launch day: inconclusive, with low
    confidence because the change pushed the frontend past anything the history showed. That run
    failed for 3.5 minutes.

  The CPU-ratio rule also got 3 right but called that last run safe. The model calibrated with the
  load test did worse: it called the +30% day a pass, and it failed for 5.5 minutes. It hedged on
  the other three.
- **Round 2: three more questions, all hedged, two of three leaning the right way.** Both models
  answered inconclusive (leaning pass) to all three, committed in
  [predictions-oos-2.json](shop/validation/predictions-oos-2.json) before the runs:
  - 4 frontends on a launch day with 30% more traffic: passed (1 min out of SLO, as built had 5.5).
  - an autoscaler (2–5 at 50% CPU) on the same day: passed.
  - 2 frontends at 750m instead of 3 at half a core on launch day: **failed** for 4.5 minutes. The
    CPU-ratio rule also called it safe.

  Every hedge said why: the changes pushed the frontend (and `recommendation`) past any load the
  ordinary day showed. What actually failed the 750m run was not the frontend:
  - **Every checkout timed out for four minutes (minutes 24–27), after `email` was OOM-killed.**
    All 1,611 failures were `POST /api/checkout`, each at the 5 s timeout, and none at the traffic
    peak (minutes 14–16). `email` (limit 150 MiB) climbs steadily through every launch-day run and
    is OOM-killed between minutes 20 and 24 in all of them; in most, checkout recovers within a
    minute, here it stayed stuck for four. Round 1's `launch-2c` failed the same way (minutes
    24–26). Both are judged on whether that restart happened to take long, not on the frontend
    change they test — so neither says much about the frontend, and the replay has no term for a
    memory leak (memory that grows with requests served, not with load) or for callers that stay
    broken after a restart.
  - **`recommendation` held 99 req/s on the +30% day**; calibrated from a day that never took it
    past 29% of its capacity, the model put it at 71, so its replay of the 4-frontend run fails
    where the real one did not.

  Neither is tuned away here: the next model change should be judged on runs it has not seen.
- **Round 3: the leak, out of sample.** Predicted before the runs
  ([predictions-oos-3.json](shop/validation/predictions-oos-3.json)), from the ordinary day alone:
  - an ordinary day at 1.5×: `email` OOM-killed at minute 29.5. It was killed at minute 35.0 (the
    replay on the day's own traffic: 35.9).
  - launch day with `email` at 300 MiB: never killed. It wasn't, and the day passed with no errors
    at all — the change the leak pointed to.

  The 1.5× day's verdict was still wrong (both models: pass; measured 6 minutes out of SLO), and
  the reason is new: **`email` stops answering while its memory sits at the limit, minutes before
  the kernel kills it.** Every checkout failed from minute 28 to 33 there, and in the two failed
  two-frontend launch runs from 24 to 27 (killed at 29) and 24 to 26 (killed at 28). The replay
  kills the container the moment it reaches the limit and restarts it; the stall before the kill
  — reclaim and garbage collection at a full heap — costs more than the restart, and the replay
  has no term for it yet.
- **The leak was in the ordinary day all along, and calibration now reads it.** On the ordinary day
  `email`'s memory follows the requests it has served (R² 0.98, +9.6 MiB per 1,000) and hardly
  follows its load (R² 0.25): a leak, which takes it from 64 MiB towards its 150 MiB limit and never
  back. Calibration now fits memory against requests served since the container started (the count
  restarting where memory drops), and calls it a leak when that explains it far better than load
  does. The replay counts each container's requests and OOM-kills it at the limit.

  Across all thirteen runs (the table under the results): whether `email` is killed within the run,
  right in 9 of 13 — it predicted kills in `launch-2`, where the frontend failed 45% of requests and
  fewer checkouts reached `email`, in `normal-1-750` at minute 36.7 of 40, in `normal-2` at
  minute 36.3 and in `normal-1` at minute 36.6, and none came (recomputed after fixes on 2026-10-16
  and 2026-10-17; before: 11 of 13, `normal-2` had no kill, because its metrics undercounted
  checkouts, and `normal-1` none, because half its requests were missing from the replay). When:
  a few minutes early, mostly. A second kill after the restart it predicts twice and never saw: the
  restarted container grows more slowly than the one rate the model has. What a kill costs is the
  uncertain part — the replay restarts it after CrashLoopBackOff (~0.5 min out of SLO), while the
  real checkouts lost nothing at one restart and 3–4 minutes at others. Counting that restart makes
  the ordinary-day model call the as-built launch day a fail (1 min out of SLO against a measured
  0.5), so the in-sample score above drops to 4 of 5 — kept, because the kill is real and a forecast
  that hides it is worse.
- **Losing a node: the prediction was right about what breaks, and Kubernetes recovered on time.
  The outage still ran 50% longer, because of the clients.** `check_node_loss` ran on the ordinary
  day with the pod placement at the moment of the kill. It said seven services would lose their
  only replica (ad, cart, email, payment, quote, shipping, jaeger), and that the two remaining
  frontends would hold. Both were right. Its estimate was +7 minutes out of SLO and 21,221 failed
  requests.

  The node was stopped for real (`docker stop` on the kind node, minute 19 of the ordinary day).
  The replacement pods were ready 348 s later; the model allows 380 s (50 s to mark the node
  NotReady, 300 s before eviction, 30 s to start a pod). Everything except cart recovered then.
  `/api/cart` and checkout kept failing at 100% for another four minutes, though the new cart pod
  was ready. The frontend's gRPC channel to cart had given up reconnecting. It recovered only when
  both surviving frontend containers ran out of JavaScript heap and restarted, at 600 s.

  Measured: +10.5 minutes, 32,886 failed requests. The replay has no term for callers that stay
  broken after their dependency is back, such as reconnect backoff or stuck channels. Treat its
  recovery time as the platform's, and the clients' as extra.
- **A CPU limit below one core adds one CFS stall to every endpoint's p99.** The client measured
  the same medians at every limit. The p99 of almost every endpoint moved together: 60–80 ms at half a
  core, 33–43 ms at 750m, 10–15 ms at 1 core. That is one wait of (1 − limit) × 100 ms: the rest of
  the CFS period after a single-threaded burst has spent its quota. The traces can't show it; the
  wait sits outside the frontend's spans.

  Calibration now takes that stall out of each endpoint's baseline tail, and the replay puts it back
  at the plan's limit. Two other fixes found on the way:
  - a path mean summed from self times above the measured mean (checkout: 59.6 ms against 21.8 ms)
    is scaled down to the measured mean;
  - endpoint tails are shaped through p50, p90 and p99 from the traces, so an endpoint that is fast
    except for 1% of slow requests keeps them at its p99.

  At 1 core the calm-day model's p99 went from 98 to 46 ms (measured 28); at 750m from 101 to 65
  (55). The load-tested model went from 253 to 88 and from 256 to 101. The cost: the load-tested
  model's "fail" on one replica (normal-1) is now "inconclusive". That fail had come from the
  inflated tail; its load-test capacity of 169 req/s per pod sits just above the day's 164.5 peak.
- **Busy days are still underestimated.** On launch day the frontend's p99 climbed to 500–700 ms at
  60% CPU, where the model says 116–150 ms. Stalls stack as more periods are throttled, and the
  model only counts one. That is the next gap.
- **It knew when it didn't know.** Where a change pushed the frontend past anything the history had
  shown, `verify_change` said *inconclusive*, never pass. The recorded agent demo
  ([demos/agent.tape](../../demos/agent.tape)) predates the throttle model: it said to load-test
  before cutting to 2 replicas for launch day, and that run failed 45% of its requests.

The calibration's foundation, CPU from traffic, holds up on real production telemetry: see
[../alibaba](../alibaba). When traffic moved, its forecasts were off 5.9% on 44 of Alibaba's busiest
services, against 11–13% for naive forecasts.

## Without traces, live

Who-calls-whom without traces ([docs/agents.md](../../docs/agents.md#without-traces)) was tested
here on 16 October 2026. The collector keeps the client span's peer as a span-metric dimension
(`server.address`, `peer.service`, `net.peer.name`), and the `servicegraph` connector writes
`traces_service_graph_*` to Prometheus, both with their default settings ([shop/gen.ts](shop/gen.ts)).
Only the collector's ConfigMap changed. The traffic was one ordinary day (12 July, x83, compressed into
25 minutes, peak 157 req/s at the ingress), 23:14:24–23:39:25 UTC, as built. It was not recorded as a
run: the numbers below come from `quickstart` over that window (`--start/--end`, `--namespace shop
--exclude jaeger,otel-collector --p99 1000 --errors 0.01`), three ways:

- **span metrics**: Prometheus alone, `--calls spanmetrics`. Client spans are matched by RPC name,
  else by the peer labels.
- **service graph**: Prometheus alone, which reads the service graph first.
- **traces**: `--jaeger`; 2,950 traces from the 10% sample. The **traces** column is after the
  endpoint-mix fix below, from the same 2,950 traces (kept with the run) and Prometheus over the same
  window; **traces, before the fix** is the column as first published.

The **measured** column is what each service's server spans counted over the window, divided by the
requests ingress-nginx counted (134,483). For `valkey-cart` and `flagd`, which have no spans of their
own, it is cart's client spans. Calls per request from traces are the model's: each frontend
endpoint's share of the requests times its traced visits.

| | span metrics | service graph | traces | traces, before the fix | measured |
|---|---|---|---|---|---|
| call edges (traced graph: 15, flagd's self-call left out) | 15: 14 of the traced ones, missing shipping → quote; plus ad → flagd (a flag stream, 1 call) | 13 of 15, missing cart → valkey-cart and cart → flagd | 15 | 15 | |
| calls per frontend request: product-catalog | 1.32 | 1.51 | 1.48 | 2.19 | 1.51 |
| cart | 0.39 | 0.46 | 0.48 | 0.51 | 0.46 |
| ad | 0.13 | 0.12 | 0.12 | 0.26 | 0.12 |
| recommendation | 0.12 | 0.12 | 0.12 | 0.27 | 0.12 |
| currency | 0.14 | 0.13 | 0.13 | 0.14 | 0.14 |
| shipping | 0.084 | 0.080 | 0.073 | 0.079 | 0.083 |
| checkout, payment, email, quote | 0.042–0.043 | 0.040–0.042 | 0.037 | 0.040 | 0.041–0.042 |
| valkey-cart | 0.64 | — | 0.79 | 0.70 | 0.75 |
| flagd | 0.036 | — | 0.073 | 0.079 | 0.042 |
| capacity per replica: frontend | 120 req/s, CPU | 120 req/s, CPU | 220 req/s, 1 at a time | 220 req/s, 1 at a time | |
| recommendation | 44 req/s, 6 at a time | 52 req/s, 4 at a time | 68 req/s, 1 at a time | 68 req/s, 1 at a time | |
| the other nine traced services | the same in all three (CPU, from the same metrics) | | | | |
| valkey-cart, flagd | 4,100 and 461 req/s, CPU only (no latency metric) | not modelled (cost only) | 28,732 and 25,050 req/s | 28,732 and 25,050 req/s | |
| headroom | 362.8 req/s, frontend first (frontend's fit is poor, so the review calls it a guess) | 361 req/s, frontend first | 605.1 req/s, recommendation first | 411.1 req/s, recommendation first | |
| held-out p99 (the last 7 min) | 65.8 ms predicted, 56.8 measured; typical error per 30 s bucket 50% | 67.5 against 56.8; 49% | no check: the traced endpoints have no p99 series, because span names carry raw URLs | the same | |

What it says:

- **Call counts.** For every service it covers, the service graph came within 4% of what the
  servers served. Its counts come from pairs of spans the collector saw.
  - Span metrics don't match what was served. The frontend's Node.js gRPC client spans count 15–30%
    fewer calls than cart and product-catalog served, and about 24% more than ad and checkout
    served. Calls into a service are scaled down where callers count more than it served (ad,
    checkout), never up.
  - With traces, after the fix below, product-catalog, cart, ad and recommendation came within 4% of
    what was served; currency, shipping and the checkout path 9–12% low (108 checkouts in the sample).
- **The traces' first numbers were wrong, and the traces were not.** The published column had ad and
  recommendation about 2× high and product-catalog 1.45× high. The 2,950 traces were a fair sample:
  their own server spans per trace came within 4% of what product-catalog, cart, ad and
  recommendation served (1.48, 0.48, 0.122, 0.117). Two things went wrong after them:
  - The model takes each frontend endpoint's share of the requests from the frontend's span-metric
    series, and those were wrong. The frontend runs three replicas, and the collector's Prometheus
    exporter writes their counters into one series with no label per replica, so the series jumps
    between three counters (one URL's: 316, 293, 359, 310, 394 on consecutive scrapes) and `rate()`
    reads every drop as a reset. Over the window the frontend's routed server spans summed to about
    2.4 per ingress request (the importer's own note: "counted 242% of the requests the edge saw"), inflated by a different factor for each endpoint, so after scaling to the
    ingress's total GET /api/data still had 16% of the requests where the traces (and ad's own count)
    put 12%, and POST /api/cart 4% where the traces put 14%. The services behind the frontend run one
    replica each, so their own counts were right.
  - The comparison then weighted the traced paths by those series and missed /api/products: its
    traced name (`/api/products/[productId]`, Next.js's route) is not the series' (`{id}`), so it got
    almost no weight, which raised every other endpoint's share. The model itself matched the two and
    said 1.77, 0.33, 0.17 and 0.17 for product-catalog, cart, ad and recommendation.

  The importer now takes an entry service's endpoint mix from the traces where the two disagree
  beyond what sampling explains (χ²) and the services behind the entry served what the traced mix
  predicts at least twice as closely as the series' (here within 7%, against 65%). The collection
  warns when it does. A tail-sampled trace set, whose mix the services' counts contradict, leaves the
  series as they were. The headroom moved from 411 to 605 req/s, recommendation still first:
  recommendation now carries 12% of the requests rather than 17%.
- **gRPC from the spans.** A model built from traces now marks a call as gRPC where its client or
  server span says so (`rpc.system = grpc`, a `grpc.*` attribute, or a name of the form
  `package.Service/Method`), so `check_node_loss` gives traced models its `ifCallersStayBroken`
  sensitivity without gRPC metrics. On this window the spans give the 11 calls the span-metric names
  gave, plus cart → flagd.
- **What each source can't see.**
  - The service graph names an uninstrumented callee only through the connector's
    `virtual_node_peer_attributes`, which default to `peer.service`, `db.name` and `db.system`. Cart's
    Valkey calls became the virtual node `redis`, which names no workload. Its flagd calls (and ad's
    and recommendation's flag streams) became `unknown`. Both are left out and the review names them.
  - Span metrics miss shipping → quote: the Rust HTTP client's span carries no peer attribute. quote
    is then carried by the entry traffic in proportion to its own requests, which gives the right
    rate (0.042).
- **The live data exposed four bugs, now fixed.**
  - cart's .NET gRPC client traces each flagd call twice, once as the RPC and once as the HTTP/2
    `POST` under it, so cart → flagd was counted twice. A bare POST to a callee that matches the RPC
    count is now counted once.
  - A peer-matched RPC span is now marked gRPC.
  - The service graph's `unknown` is no longer taken as a callee, and `redis` is no longer reported as
    "another namespace, or excluded".
  - Where both sources exist, `--calls` picks one. The service graph is read first.

  On this window the fixes left the service graph's numbers as they were. The flagd double count
  would have doubled flagd's 0.042.
- **Headroom.** Without traces it came out 12% lower, with the frontend first. With traces the
  frontend was fitted as one-at-a-time at 220 req/s, which puts recommendation first. Neither
  traffic level was reached on this day (busiest: 157 req/s), so all three are extrapolations.

On the cluster, `kubectl apply` of the otel-collector ConfigMap from [shop/shop.yaml](shop/shop.yaml),
then `kubectl -n shop rollout restart deploy otel-collector`. To revert: apply the ConfigMap from
`git show e95c7ca^:reference/k8s/shop/shop.yaml` and restart the collector the same way. Nothing else in
the shop was redeployed.

## Retrodiction: callers that stay broken

*A retrodiction, not a prediction.* The node kill above ran 3.5 minutes longer than the replay
because the frontend's gRPC channel to cart stayed broken after cart was back. The engines now have
a term for that, `reconnect` on a link (seconds, or `until-restart`), and `check_node_loss` reports a
sensitivity beside its answer when a service the node takes is called over gRPC: the same loss with
each such caller's calls to it failing 252 s more after the replacement is up. The 252 s were read
off this same run (cart ready 348 s after the node stopped; the frontend's calls to it failing until
the frontend restarted at 600 s), so matching the measurement here is in-sample by construction and
says nothing about other clusters. It is one observation on one kind cluster, stated as an assumption.

`npx tsx reference/k8s/retrodict-reconnect.ts` (after `evaluate.ts`), with the gRPC calls taken from
`shop.yaml`'s `*_ADDR` settings that have no `http://` scheme:

| `normal-nodeloss` | the answer | with every gRPC caller stuck 252 s | with frontend → cart alone stuck | measured |
|---|---|---|---|---|
| before the day (ordinary day, placement at the kill) | +7 min, +21,221 failed | +11 min, +32,386 failed | +11 min, +26,544 failed | +10.5 min, +32,886 failed |
| on the day (the run’s own traffic) | +7.5 min, +50,367 failed | +11 min, +60,705 failed | +11 min, +56,402 failed | |

The sensitivity counts frontend → ad and the checkout's calls as stuck too; on the day only the
frontend's channel to cart was. The verdicts and validation data above are unchanged: the answer is
still +7 minutes, and the sensitivity sits beside it.

## Round 4: away from the frontend

Rounds 1–3 asked about the frontend and email. Round 4 asked about three other services, in three
languages, after the leak, JIT warm-up, the failed-request gate and holdout confidence had been
added. The verdicts were committed in
[shop/validation/predictions-oos-4.json](shop/validation/predictions-oos-4.json) before any of the
runs was recorded. The naive rule for these is every service's CPU ratio, not just the frontend's.

| run | change | measured | ordinary-day model | with the load test | CPU rule |
|---|---|---|---|---|---|
| `launch-cart250` | cart (.NET) at 250m instead of 500m, launch day | **fail**, +1 min out of SLO | inconclusive, leans pass | pass ❌ | pass ❌ |
| `launch-rec2` | 2 recommendation (Python) replicas instead of 1, launch day | **fail**, +1.5 min | inconclusive, leans pass | inconclusive, leans pass | pass ❌ |
| `normal-catalog125` | product-catalog (Go) at 125m instead of 250m, ordinary day | **pass** | pass ✅ | pass ✅ | pass ✅ |

**Neither failure was caused by its change.** In both runs the minutes out of SLO are one burst
of checkout timeouts, at minute 25–26 (cart) and 23–24.5 (recommendation). It came as email, which
leaks memory, was killed for running out of its 150 MiB. The system as built has the same kill on
launch day, at minute 26 of the `launch` run. There it happened to cost only one 30-second bucket
out of SLO, against two to four here. The same kill shows in round 0's `launch-hpa`, and it is
what failed round 2's `launch-2-750`. The model predicts this kill: it read the leak from the
ordinary day.

The gate counts more than half a minute added over as built as a failure. That threshold is
smaller than how much one recurring incident varies between two recordings of the same day. So
these two count as fails, by the rule fixed before the runs, and are scored that way above. What
they measure is run-to-run noise around an incident the system has anyway, not the change.

**What it says.** On round 4 the model was never wrong. It hedged on the two launch-day questions,
while the CPU rule passed both and is scored wrong. Both hedges came from the same rule: the
frontend, which neither change touches, runs on launch day at 91% of a capacity the history never
tested. The system as built runs it there too, so the rule lowers confidence in a comparison it
doesn't affect. That looks like a flaw. A fix was tried afterwards, in sample: for a service the change
doesn't touch and loads no harder than as built (within 5%), lower confidence only to medium. On the
committed runs it turned three inconclusives into passes. `launch-email300` was right, but
`launch-2c` and `launch-cart250` were wrong, both on days where the email kill decided the
outcome. One right and two wrong, so it isn't kept. Picking which failures to count after seeing
them is the bias this record is meant to rule out, and for a gate a hedge costs less than a wrong pass.

Two lessons for the method, not the model:
- a fixed half-minute threshold needs a noise floor for incidents the system has as built;
- the reality side of the comparison would be steadier with each day recorded twice.

## How noisy is reality? The launch day recorded twice

The half-minute gate assumes two recordings of the same day would agree to within half a minute.
To check, the as-built launch day was recorded a second time with nothing changed (`launch-b`,
declared in [shop/reference.yaml](shop/reference.yaml) before it ran). The two runs scored the same
way (every k6 request after the first two minutes, 30-second buckets, SLO p99 1 s and errors 3%):

| run | minutes out of SLO | failed requests | why |
|---|---|---|---|
| `launch` | 0.5 | 5 | one slow bucket at minute 16; email's OOM kill at minute 26 cost nothing |
| `launch-b` | 1.5 | 571 | email's OOM kill at minute 26.5: checkout timeouts for three buckets |

The difference is one minute, from the same incident landing on traffic or not, on an
unchanged system. That is twice the gate. Every launch-day change in this study was scored against
`launch`, the luckier of the two. Against `launch-b`:

| run | minutes out | added over `launch` | added over `launch-b` | scored | against `launch-b` | the model said |
|---|---|---|---|---|---|---|
| `launch-2` | 11.5 | +11 | +10 | fail | fail | fail |
| `launch-hpa` | 1.5 | +1 | 0 | fail | **pass** | fail (in sample) |
| `launch-2c` | 3.5 | +3 | +2 | fail | fail | inconclusive |
| `launch-2-750` | 4.5 | +4 | +3 | fail | fail | inconclusive |
| `launch-email300` | 0 | −0.5 | −1.5 | pass | pass | inconclusive, leans pass |
| `launch-cart250` | 1.5 | +1 | 0 | fail | **pass** | inconclusive, leans pass |
| `launch-rec2` | 2 | +1.5 | +0.5 | fail | **pass** | inconclusive, leans pass |

The published scores above stay as they were scored, against `launch`. The gate was fixed before
the runs, and choosing a baseline afterwards is what the record must not do. Read against
`launch-b`, round 4's two "failures" are passes. The model leaned pass on both, and the CPU rule's
two wrong calls there become right.

**From round 5 on** (declared here, before any round 5 exists), a change on a day recorded twice as
built fails only if it adds more than half a minute out of SLO, or more failed requests than the
error budget, over **both** as-built recordings.

## Round 5: scored against both recordings

The first round under the rule declared after `launch-b`: a launch-day change fails only if it is
worse than both as-built recordings. The verdicts were committed in
[shop/validation/predictions-oos-5.json](shop/validation/predictions-oos-5.json) before any of
the runs was recorded.

| run | change | measured | ordinary-day model | with the load test | CPU rule |
|---|---|---|---|---|---|
| `launch-catalog125` | product-catalog (Go) at 125m instead of 250m | **fail**, 3.5 min out of SLO | fail ✅, 3 min predicted (low confidence) | pass ❌ | fail ✅ |
| `launch-checkout125` | checkout (Go) at 125m instead of 250m | **pass**, 0 min | inconclusive | pass ✅ | pass ✅ |
| `launch-3-400` | 3 frontend replicas at 400m instead of 500m | **fail**, 3.5 min | fail ✅, 3.5 min predicted (low confidence) | inconclusive | fail ✅ |

By the count, the ordinary-day model called both real failures, and even their size: 3 and 3.5
minutes out of SLO predicted, 3.5 and 3.5 measured. But it was right for the wrong reason, as the
diagnosis below shows. It hedged on the change that passed. The CPU rule got
all three right. The model calibrated with the load test did worse here. It passed product-catalog
at 125m, which failed (0.5 min predicted against 3.5 measured).

**Why (checked 2026-10-17, after the runs).** Neither failure came from its change, and the
load-tested model was right about product-catalog's capacity.

- **What failed was `email`, both times.** Every minute out of SLO in `launch-catalog125` falls in
  one stretch, minutes 23–27 of the run. `email` sat at its 150 MiB limit with its CPU pinned at
  its 250m quota (80–100% of periods throttled, its own p99 up to 137 s). Checkouts hung for 30 s
  and the frontend failed 4% of requests, until the kernel killed `email` (memory 177 → 79 MB).
  `launch-3-400` failed the same way, at minutes 24.5–28. It is the stall round 3 found: a
  recurring incident of the system as built, not of either change. In `launch-b`, `email` stayed
  pinned for 2 thirty-second buckets (1.5 min out of SLO), and in `launch` its kill cost nothing.
  Across the launch-day runs whose change doesn't touch `email`, it stayed pinned for 1 to 8
  buckets. Here it was 5 and 6.
- **product-catalog at 125m was never short of CPU.** At the launch peak it served 534 req/s on
  0.081 cores, 65% of its limit, with 9.6% of periods throttled and its own p99 at 2 ms
  throughout. The frontend's p99 stayed under 372 ms. Read from the run itself, it used 0.130 ms
  of CPU per request, so its CPU limit sits near 870 req/s.
- **The ordinary-day model was right by the count but wrong about the cause.** Both its fails
  predicted the minutes out of SLO at the traffic peak, minutes 15.5–18, and nothing failed there.
  For product-catalog it read 11.6 mcores plus 0.207 ms per request from a day that never passed
  239 req/s (R² 0.82). That puts its capacity at 1,152 req/s at 250m and 548 at 125m. Its launch
  forecast also sent product-catalog 590 req/s at the peak against 534 measured: its endpoint mix
  gives 1.69 product-catalog calls per frontend request, and the runs show 1.5. 108% of capacity
  meant a 1.4 s queue at the peak. For the frontend at 400m it read 101–108%; the real replicas
  used 58% of their limit there.
- **The load test pinned the CPU line down without reaching the limit.** In `stress`,
  product-catalog went up to 876 req/s on 0.155 cores, 62% of its 250m limit, with at most 5.3% of
  periods throttled. With the load test the fit is 17.7 mcores plus 0.157 ms per request (R² 0.96),
  or 683 req/s at 125m. Neither model has a throttling term for product-catalog: no bucket in
  either history came near the 25% of throttled periods that marks a quota collapse. Both scale
  the capacity linearly to the new limit, and here that held: measured, it was higher still.
  Per-request CPU also varies between recordings of the same day (0.239 ms in `launch`, 0.158 ms
  in `launch-b`, both at 250m).
- **It also under-counted product-catalog's load, which is fixed now** (see the note under
  Results). The load-tested model's import kept the frontend's outer framework spans ("frontend
  GET", "frontend POST") as endpoints. That put 18% of the frontend's requests on endpoints that
  call nothing. It also read the call path of `GET /api/products/{id}`, 31% of the traffic, from 42
  broken traces that visit product-catalog 0.57 times, instead of the 4,829 that visit it once.
  It sent product-catalog 1.29 calls per frontend request (measured 1.5) and put the launch peak at
  68% of capacity. After the fix it puts it at 73%, and the verdict is still a pass.

Is the load-tested model worse out of sample in general? On the shop's 15 out-of-sample runs it
got 3 right, 4 wrong and 8 inconclusive, against 6 right, 1 wrong and 8 inconclusive for the
ordinary-day model. All four of its misses are passes on runs that failed. Three of those
(`normal-x1.5`, `launch-cart250` and `launch-catalog125`) failed on `email`'s stall. Only
`launch-x1.3` failed on the frontend, at 30% more traffic, which the ordinary-day model called. The
load test widens the range the model has seen, so it hedges less. When the outcome turns on an
incident that neither model's verdict changes, that means more wrong passes. The ordinary-day
model scored better on these runs, but its two round-5 fails were right for the wrong reason.

## Round 6: stacked on a leak-free baseline (in progress)

Rounds 4 and 5 were decided by email's memory leak, which the system as built has. Round 6 stacks
three capacity changes on email at 300 MiB, where the leak can't stall checkout, and judges each
against two recordings of that baseline. The verdicts were committed in
[shop/validation/predictions-oos-6.json](shop/validation/predictions-oos-6.json) before any run.
Both baseline recordings (`launch-email300`, `launch-e300-b`) spent 0 minutes out of SLO.

**The first recording of the three changes is void.** The laptop went onto battery at 18:10, and
on battery macOS runs in Low Power Mode. The change runs (19:33–21:50) cost about twice the CPU
per request of the baseline (frontend 4.0–4.8 ms against 2.18 ms, product-catalog 0.28–0.30 ms
against 0.17 ms, on the same traffic), so all three failed at the peak, where the baseline didn't.
That is a measurement of a slower laptop, not of the changes, so it isn't scored. The models'
"fail" calls would have looked right for the wrong reason. A first attempt at `launch-e300-2` was
also cut by the lid closing mid-run. The recorder now refuses to record on battery and voids a run
the machine slept through. The three runs are to be recorded again on mains power.

## A second system: PetClinic

[petclinic/](petclinic/README.md) runs Spring PetClinic Microservices on the same cluster and the
same days, as a check on a system the model was not shaped on. Its six verdicts were committed
before any of its runs was recorded. The model got 4 right, 1 wrong and 1 inconclusive, and the
plain CPU rule got 5 right. The miss was a JVM whose CPU limit was halved. It never finished
warming up under load: about four times the CPU per request for half an hour, a cold start the
model did not know about. It has since learned JIT warm-up; replayed on these runs afterwards, in sample, it gets 5 right and 1 inconclusive. A second round, with its verdicts committed before it ran, tested the warm-up on three new changes. All three passed. The model got 1 right and 2 inconclusive (both leaning pass), and the rule got 3 right.

**Tried and dropped (2026-10-17, in sample).** Round 2 suggested turning the check on what the
system carries while restarted pods are cold into a warning instead of a reason to withhold the
verdict. On PetClinic's runs that turned `launch-visits125` into a right pass, but it also turned
`normal-cust125` into a wrong one: its rollout met load, the busy moment the check describes. For a
gate, a wrong pass costs more than a hedge, so the check still withholds the verdict.

**What the 8 out-of-sample inconclusives rest on** (both systems, the ordinary-day model):

| run | measured | what made it inconclusive |
|---|---|---|
| shop `launch-2c` | fail | low confidence: capacity past what the history showed (frontend 65% against its 41%; recommendation fits poorly and is pushed harder) |
| shop `launch-x1.3-4` | pass | low confidence: frontend at 89% of a capacity the history never tested (peak 41%) |
| shop `launch-x1.3-hpa` | pass | the same, at 84% |
| shop `launch-2-750` | fail | the same, at 88% |
| shop `launch-email300` | pass | the same, at 91% |
| petclinic `launch-cust125` | fail | the same: customers-service at 89% (peak 18%) |
| petclinic `launch-visits125` | pass | the cold-capacity check (kept, see above) |
| petclinic `launch-cust175` | pass | the same capacity rule (96%, while the pod is cold), and 7.2 min out of SLO in the worst 10% of capacity draws |

Apart from `launch-visits125`, all of them come from the extrapolated-capacity rule: 4 passes and 3
fails. With the rule taken out the model would have passed all 7: 4 right and 3 wrong. The CPU
rule got 5 right and 2 wrong on the same runs. On these runs the abstention isn't systematic: it
holds back about as many wrong answers as right ones. The replay's margin doesn't tell the two
apart either. With today's code, the failing runs had more headroom over the replayed peak (×1.37,
×1.16, ×1.16) than the passing shop runs (×1.04–×1.12). So a "large margin overrides it" exception
would have made things worse here, and it would have been fitted to these answers. The rule stays.
`launch-cust175` is the case to watch. Its 96% is the cold pod's share of a capacity cut ×5 by the
assumed warm-up. In reality the pod showed no cold stretch, because the warm-up ramp before the run
had compiled it. Measuring the warm-up from the history would settle it, but this history doesn't
show a pod starting (see [petclinic/](petclinic/README.md#round-2-testing-the-warm-up-on-runs-it-was-not-fitted-on)).

## Running it

```sh
kind create cluster --config reference/k8s/kind.yaml --kubeconfig ~/.kube/bnk8s   # never your own context
export KUBECONFIG=~/.kube/bnk8s
helm upgrade --install monitoring prometheus-community/kube-prometheus-stack -n monitoring --create-namespace -f reference/k8s/monitoring.values.yaml
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx -n ingress-nginx --create-namespace \
  --set controller.hostPort.enabled=true --set controller.service.type=ClusterIP \
  --set-string controller.nodeSelector.ingress-ready=true --set controller.metrics.enabled=true \
  --set controller.metrics.serviceMonitor.enabled=true --set-string controller.extraArgs.metrics-per-undefined-host=true \
  --set 'controller.tolerations[0].key=node-role.kubernetes.io/control-plane' --set 'controller.tolerations[0].operator=Exists' --set 'controller.tolerations[0].effect=NoSchedule'
helm upgrade --install metrics-server metrics-server/metrics-server -n kube-system --set 'args={--kubelet-insecure-tls}'
sh reference/k8s/nasa/fetch.sh
kubectl apply -f reference/k8s/shop/shop.yaml
BNK8S_KUBECONFIG=~/.kube/bnk8s sh reference/k8s/record-all.sh shop history launch normal-2 launch-2 normal-1 launch-hpa
npx tsx reference/k8s/evaluate.ts shop
```

Each run takes about 47 minutes: a restart, a 3-minute warm-up, the 40-minute day, and collection.

## What a real cluster taught the product

Each of these broke a recording or a prediction, and is now handled in the product for every
user's cluster, not just this one.

- **Containers aren't services.** Real clusters name containers `app` or `server`, and run sidecars
  (`istio-proxy`) in every pod. Kubernetes metrics are grouped by the workload that owns each pod
  (Deployment, StatefulSet, DaemonSet, from the pod name). Many clusters set CPU requests and no
  limits; the request then stands in.
- **A cluster's Prometheus sees everything.** coredns, the monitoring stack and other teams' pods
  are all there. Collection keeps the Kubernetes metrics to the namespaces the traced services run in.
- **Span metrics undercount.** Span names carrying raw URLs (`GET /api/cart?sessionId=…`) make
  thousands of sparse series, and Prometheus' `rate()` loses each new series' first increment. At
  150 req/s the frontend's span metrics counted 62% of the requests. The **ingress-nginx** preset
  counts every request at the edge, and its rate, errors and latency take precedence for the entry
  service.
- **Frameworks count twice.** Next.js wraps every request in two server spans, the outer one named
  only `GET` or `POST`. A third of the endpoint traffic had no route and no downstream path. Those
  series are dropped where the traces show two server spans per visit.
- **Traces lose spans.** The checkout service's outgoing calls didn't arrive in Jaeger, so cart,
  currency and shipping looked like entry services and their calls like requests of their own.
  Orphan spans now hang under the innermost span whose time contains them.
- **Short windows mis-sliced traces.** The trace sampler cut every window into 96 slices of at
  least a minute, so a 40-minute window's weights came from 96 minutes of Prometheus. Slices now
  match the window.

The cluster itself needed what a production cluster needs. Each of these caused an outage during
a recording:
- `enableServiceLinks: false`: Kubernetes injected `FLAGD_PORT=tcp://…` into every pod, and the
  feature-flag service listened on a random port.
- A TCP readiness probe instead of `GET /`: the page calls product-catalog, and an HTTP check that
  depends on a downstream service took every replica out of rotation when that service slowed down.
- `GOMEMLIMIT` and memory headroom for the Go services, which were OOM-killed at 64–128Mi.
- A collector that accepts OTLP logs and metrics: refused, the C++ SDK retried on new threads
  (1,194 of them) until its CPU limit was spent.
- Jaeger on disk (Badger): in memory it was OOM-killed on a busy day.
- `--metrics-per-undefined-host=true`: ingress-nginx records nothing for an Ingress without a host.
