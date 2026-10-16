# Kubernetes reference — would the backtest have told you the truth?

The other reference systems run on Docker Compose with synthetic traffic. This one is the
production setup most teams have (on a laptop: kind, two workers), with traffic shaped by a real
web log, and asks the question that matters: **before a
change ships, does the backtest's verdict match what really happens when it ships?**

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
half a minute out of SLO over the as-built system on the same day; the as-built system fails if it
spends any minute out of SLO.

## Results

<!-- RESULTS -->
**Calibrated on the ordinary day:**

| run | question | measured (k6, every request) | backtest before the day | model on the day’s real traffic | naive CPU ratio |
|---|---|---|---|---|---|
| `launch` | As built (3 frontend replicas), on launch day? | **pass**: p99 419 ms, errors 0.00%, 0.5 min out of SLO | fail ❌, 1 min | p99 116 ms, errors 0.11%, 1 min | pass ✅ at 84% CPU |
| `normal-2` | 2 frontend replicas instead of 3, on an ordinary day? | **pass**: p99 142 ms, errors 0.02%, 1 min out of SLO | pass ✅ (medium confidence), 0 min | p99 81 ms, errors 0.00%, 0 min | pass ✅ at 57% CPU |
| `launch-2` | 2 frontend replicas instead of 3, on launch day? | **fail**: p99 5233 ms, errors 45.3%, 11.5 min out of SLO | fail ✅ (low confidence), 19.3 min | p99 5000 ms, errors 61.1%, 15.5 min | fail ✅ at 126% CPU |
| `normal-1` | 1 frontend replica, on an ordinary day? | **fail**: p99 5007 ms, errors 27.9%, 19.5 min out of SLO | fail ✅ (low confidence), 10.5 min | p99 83 ms, errors 0.00%, 0 min | fail ✅ at 113% CPU |
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
| `launch-x1.3-hpa` | An HPA (2–5 replicas at 50% CPU), on a launch day with 30% more traffic? | **pass**: p99 327 ms, errors 0.10%, 0.5 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 0 min | p99 268 ms, errors 0.05%, 1.5 min | pass ✅ at 65% CPU |
| `launch-2-750` | 2 frontend replicas at 750m instead of 3 at half a core, on launch day? | **fail**: p99 293 ms, errors 0.54%, 4.5 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 0 min | p99 67 ms, errors 0.03%, 1 min | pass ❌ at 84% CPU |

Backtest verdicts: **0 right**, 3 inconclusive (it said to load-test; 2 of them leaned the right way), 0 wrong, of 3. Naive CPU ratio: 2 right.

*Out of sample* — round 3, chosen after round 2 was scored; the verdicts are the ones committed in `validation/predictions-oos-3.json` before each run was recorded:

| run | question | measured (k6, every request) | backtest before the day | model on the day’s real traffic | naive CPU ratio |
|---|---|---|---|---|---|
| `normal-x1.5` | As built, on an ordinary day with 50% more traffic? | **fail**: p99 250 ms, errors 0.70%, 6 min out of SLO | pass ❌, 0.5 min | p99 85 ms, errors 0.02%, 0.5 min | pass ❌ at 57% CPU |
| `launch-email300` | email with 300 MiB instead of 150, on launch day? | **pass**: p99 124 ms, errors 0.00%, 0 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 0 min | p99 92 ms, errors 0.00%, 0 min | pass ✅ at 84% CPU |

Backtest verdicts: **0 right**, 1 inconclusive (it said to load-test; 1 of them leaned the right way), 1 wrong, of 2. Naive CPU ratio: 1 right.

**Every out-of-sample round together** (9 runs): Backtest verdicts: **3 right**, 5 inconclusive (it said to load-test; 3 of them leaned the right way), 1 wrong, of 9. Naive CPU ratio: 6 right, 3 wrong (a rule like that never abstains).

p99 of the model on each day's real traffic, against the measured p99: within 20% in **3 of 14** runs; the others off by 26–2253%.

**Calibrated on the ordinary day and a 12-minute load test:**

| run | question | measured (k6, every request) | backtest before the day | model on the day’s real traffic | naive CPU ratio |
|---|---|---|---|---|---|
| `launch` | As built (3 frontend replicas), on launch day? | **pass**: p99 419 ms, errors 0.00%, 0.5 min out of SLO | pass ✅, 0.5 min | p99 150 ms, errors 0.13%, 1.5 min | pass ✅ at 84% CPU |
| `normal-2` | 2 frontend replicas instead of 3, on an ordinary day? | **pass**: p99 142 ms, errors 0.02%, 1 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 0 min | p99 118 ms, errors 0.00%, 0 min | pass ✅ at 57% CPU |
| `launch-2` | 2 frontend replicas instead of 3, on launch day? | **fail**: p99 5233 ms, errors 45.3%, 11.5 min out of SLO | fail ✅ (low confidence), 4.5 min | p99 5000 ms, errors 21.7%, 10 min | fail ✅ at 126% CPU |
| `normal-1` | 1 frontend replica, on an ordinary day? | **fail**: p99 5007 ms, errors 27.9%, 19.5 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 0 min | p99 212 ms, errors 0.00%, 0 min | fail ✅ at 113% CPU |
| `launch-hpa` | An HPA (1–3 replicas at 60% CPU) instead of 3 fixed, on launch day? | **fail**: p99 159 ms, errors 0.08%, 1.5 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 1 min | p99 179 ms, errors 0.05%, 1 min | pass ❌ at 84% CPU |

Backtest verdicts: **2 right**, 3 inconclusive (it said to load-test; 1 of them leaned the right way), 0 wrong, of 5. Naive CPU ratio: 4 right.

*Out of sample* — added after the throttle model was designed on the runs above; the verdicts are the ones committed in `validation/predictions-oos.json` before each run was recorded:

| run | question | measured (k6, every request) | backtest before the day | model on the day’s real traffic | naive CPU ratio |
|---|---|---|---|---|---|
| `launch-2c` | 2 frontend replicas at 1 core instead of 3 at half a core, on launch day? | **fail**: p99 596 ms, errors 0.33%, 3.5 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 0 min | p99 134 ms, errors 0.13%, 1 min | pass ❌ at 63% CPU |
| `normal-1c` | 1 frontend replica at 1 core, on an ordinary day? | **pass**: p99 28 ms, errors 0.00%, 0 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 0 min | p99 88 ms, errors 0.04%, 0.5 min | pass ✅ at 57% CPU |
| `normal-1-750` | 1 frontend replica at 750m, on an ordinary day? | **pass**: p99 55 ms, errors 0.00%, 0 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 0 min | p99 101 ms, errors 0.04%, 0.5 min | pass ✅ at 76% CPU |
| `launch-x1.3` | As built, on a launch day with 30% more traffic? | **fail**: p99 1178 ms, errors 0.29%, 5.5 min out of SLO | pass ❌, 0 min | p99 335 ms, errors 0.18%, 1.5 min | fail ✅ at 109% CPU |

Backtest verdicts: **0 right**, 3 inconclusive (it said to load-test; 2 of them leaned the right way), 1 wrong, of 4. Naive CPU ratio: 3 right.

*Out of sample* — round 2, chosen after round 1 was scored; the verdicts are the ones committed in `validation/predictions-oos-2.json` before each run was recorded:

| run | question | measured (k6, every request) | backtest before the day | model on the day’s real traffic | naive CPU ratio |
|---|---|---|---|---|---|
| `launch-x1.3-4` | 4 frontend replicas, on a launch day with 30% more traffic? | **pass**: p99 321 ms, errors 0.14%, 1 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 0 min | p99 2887 ms, errors 0.28%, 2.5 min | pass ✅ at 82% CPU |
| `launch-x1.3-hpa` | An HPA (2–5 replicas at 50% CPU), on a launch day with 30% more traffic? | **pass**: p99 327 ms, errors 0.10%, 0.5 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 0 min | p99 352 ms, errors 0.11%, 1 min | pass ✅ at 65% CPU |
| `launch-2-750` | 2 frontend replicas at 750m instead of 3 at half a core, on launch day? | **fail**: p99 293 ms, errors 0.54%, 4.5 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 0 min | p99 110 ms, errors 0.06%, 0.5 min | pass ❌ at 84% CPU |

Backtest verdicts: **0 right**, 3 inconclusive (it said to load-test; 2 of them leaned the right way), 0 wrong, of 3. Naive CPU ratio: 2 right.

*Out of sample* — round 3, chosen after round 2 was scored; the verdicts are the ones committed in `validation/predictions-oos-3.json` before each run was recorded:

| run | question | measured (k6, every request) | backtest before the day | model on the day’s real traffic | naive CPU ratio |
|---|---|---|---|---|---|
| `normal-x1.5` | As built, on an ordinary day with 50% more traffic? | **fail**: p99 250 ms, errors 0.70%, 6 min out of SLO | pass ❌, 0.5 min | p99 131 ms, errors 0.02%, 0 min | pass ❌ at 57% CPU |
| `launch-email300` | email with 300 MiB instead of 150, on launch day? | **pass**: p99 124 ms, errors 0.00%, 0 min out of SLO | pass ✅ (medium confidence), 0 min | p99 134 ms, errors 0.00%, 0 min | pass ✅ at 84% CPU |

Backtest verdicts: **1 right**, 0 inconclusive (it said to load-test), 1 wrong, of 2. Naive CPU ratio: 1 right.

**Every out-of-sample round together** (9 runs): Backtest verdicts: **1 right**, 6 inconclusive (it said to load-test; 4 of them leaned the right way), 2 wrong, of 9. Naive CPU ratio: 6 right, 3 wrong (a rule like that never abstains).

p99 of the model on each day's real traffic, against the measured p99: within 20% in **5 of 14** runs; the others off by 48–799%.

**A node failure, for real:** check_node_loss from the ordinary day and the pod placement at the instant of the kill, the model on the day’s own traffic, and the client’s measurement — each against the as-built ordinary day.

| run | node lost | services left with no replica | predicted before | model on the day | measured |
|---|---|---|---|---|---|
| `normal-nodeloss` | bnk8s-worker at minute 19.3 | ad, cart, email, jaeger, payment, quote, shipping | +7 min, +21,221 failed | +7 min, +16,804 failed | +10.5 min, +32,886 failed |

**A memory leak:** the minutes into each run at which the ordinary-day model has the leaking service OOM-killed — committed before the run (out of sample), and replayed on the run’s own traffic — against the minutes its working set really dropped.

| run | service | predicted before | model on the day | observed |
|---|---|---|---|---|
| `history` | email | — | none | none |
| `launch` | email | — | 21.9 | 27.5 |
| `normal-2` | email | — | none | none |
| `launch-2` | email | — | 26.7 | none |
| `normal-1` | email | — | none | none |
| `launch-hpa` | email | — | 23.1 | 25.5 |
| `launch-2c` | email | — | 17.3 | 28.0 |
| `normal-1c` | email | — | 36.8 | 40.0 |
| `normal-1-750` | email | — | 36.7 | none |
| `launch-x1.3` | email | — | 17.5, 33.2 | 22.0 |
| `launch-x1.3-4` | email | — | 18.0, 26.6 | 21.5 |
| `launch-x1.3-hpa` | email | — | 21.3 | 22.0 |
| `launch-2-750` | email | — | 29.3 | 29.0 |
| `normal-x1.5` | email | 29.5 | 35.9 | 35.0 |
| `launch-email300` | email | none | none | none |

The first 2 minutes of every run are left out of the scoring, measured and predicted alike (pods restarted minutes earlier). Generated by `npx tsx reference/k8s/evaluate.ts`, 2026-10-16.
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
  right in 11 of 13 — it predicted kills in `launch-2`, where the frontend failed 45% of requests and
  fewer checkouts reached `email`, and in `normal-1-750` at minute 36.7 of 40, and neither came. When:
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
| on the day (the run's own traffic) | +7 min, +16,804 failed | +11 min, +22,689 failed | +11 min, +20,279 failed | |

The sensitivity counts frontend → ad and the checkout's calls as stuck too; on the day only the
frontend's channel to cart was. The verdicts and validation data above are unchanged: the answer is
still +7 minutes, and the sensitivity sits beside it.

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
