# PetClinic on Kubernetes: a second system, scored out of sample

The Astronomy Shop study ([../README.md](../README.md)) shaped the model: the throttle rules were
designed on its runs. This study checks the model on a system it was not shaped on.
[Spring PetClinic Microservices](https://github.com/spring-petclinic/spring-petclinic-microservices)
(3.4.1) runs on the same kind cluster with the same observability stack. It has JVMs, a reactive
gateway in front of thread-per-request services, and the OpenTelemetry Java agent in every pod.

- **Manifests**: [gen.ts](gen.ts) → [petclinic.yaml](petclinic.yaml). There are 2 gateways at 500m and one
  each of customers, visits and vets at 250m. CPU requests equal limits.
- **Traffic**: the same NASA July 1995 log, ×55. The ordinary day (12 July) peaks at 120 req/s;
  launch day (13 July, STS-70) peaks at 2.2× that. The request mix is [mix.json](mix.json): owners, pets,
  visits and vets, reads and writes.
- **Before recording**, every pod gets 5 minutes of warm-up traffic stepping from 10 to 100
  req/s, so the JIT compiles the hot paths. That is what a rollout with a readiness gate and a
  slow start gives you.

## The questions

Round 1's six questions were chosen after the ordinary day (`history`) was recorded. Every verdict
was predicted from that day alone and committed in
[validation/predictions-oos.json](validation/predictions-oos.json) (commit `998b834`) before
any of these runs was recorded. Round 2's three were chosen after round 1 was scored and committed
the same way ([below](#round-2-testing-the-warm-up-on-runs-it-was-not-fitted-on)). Each change is a
manifest variant ([variants/](variants)). Over both rounds: 5 right, 1 wrong, 3 inconclusive, against
the plain CPU rule's 8 right and 1 wrong.

<!-- RESULTS -->
**Calibrated on the ordinary day:**

*Out of sample* — chosen after the ordinary day was recorded; every verdict was predicted from it alone and committed before any of these runs was recorded; the verdicts are the ones committed in `validation/predictions-oos.json` before each run was recorded:

| run | question | measured (k6, every request) | backtest before the day | model on the day’s real traffic | naive CPU ratio |
|---|---|---|---|---|---|
| `launch` | As built (2 gateways), on launch day? | **pass**: p99 8 ms, errors 0.00%, 0 min out of SLO | pass ✅, 0 min | p99 9 ms, errors 0.00%, 0 min | pass ✅ at 62% CPU |
| `launch-gw1` | 1 gateway instead of 2, on launch day? | **pass**: p99 8 ms, errors 0.00%, 0 min out of SLO | pass ✅ (medium confidence), 0 min | p99 9 ms, errors 0.00%, 0 min | pass ✅ at 81% CPU |
| `normal-gw1` | 1 gateway instead of 2, on an ordinary day? | **pass**: p99 9 ms, errors 0.00%, 0 min out of SLO | pass ✅ (medium confidence), 0 min | p99 9 ms, errors 0.00%, 0 min | pass ✅ at 37% CPU |
| `launch-cust125` | customers-service at 125m instead of 250m, on launch day? | **fail**: p99 5003 ms, errors 64.5%, 29.5 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 0 min | p99 5000 ms, errors 65.4%, 29 min | fail ✅ at 125% CPU |
| `normal-cust125` | customers-service at 125m instead of 250m, on an ordinary day? | **fail**: p99 5001 ms, errors 2.2%, 4 min out of SLO | pass ❌ (medium confidence), 0 min | p99 14 ms, errors 0.00%, 0 min | pass ❌ at 56% CPU |
| `launch-hpa` | An HPA (1–3 gateways at 60% CPU) instead of 2 fixed, on launch day? | **pass**: p99 7 ms, errors 0.00%, 0 min out of SLO | pass ✅ (medium confidence), 0 min | p99 9 ms, errors 0.00%, 0 min | pass ✅ at 62% CPU |

Backtest verdicts: **4 right**, 1 inconclusive (it said to load-test; 0 of them leaned the right way), 1 wrong, of 6. Naive CPU ratio: 5 right.

*Retrodiction, not a prediction* — what today's code says from the same ordinary day, after the model learned JIT warm-up. The warm-up's defaults (×5 CPU per request while cold, 30 core-seconds of compilation, 6% of the limit for the compiler under load) were fitted on `launch-cust125` and `normal-cust125` after they were recorded, so this is the model explaining runs it was shaped on, in sample:

| run | measured | committed before the run (scored above) | today’s code on the ordinary day (retrodiction) |
|---|---|---|---|
| `launch` | **pass**, 0 min out of SLO | pass ✅, 0 min | pass ✅, 0 min |
| `launch-gw1` | **pass**, 0 min out of SLO | pass ✅ (medium confidence), 0 min | pass ✅ (medium confidence), 0 min |
| `normal-gw1` | **pass**, 0 min out of SLO | pass ✅ (medium confidence), 0 min | pass ✅ (medium confidence), 0 min |
| `launch-cust125` | **fail**, 29.5 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 0 min | fail ✅ (low confidence), 38.5 min |
| `normal-cust125` | **fail**, 4 min out of SLO | pass ❌ (medium confidence), 0 min | inconclusive ⚠️ leans pass (medium confidence), 0 min |
| `launch-hpa` | **pass**, 0 min out of SLO | pass ✅ (medium confidence), 0 min | pass ✅ (medium confidence), 0 min |

Retrodiction: 5 right, 1 inconclusive, 0 wrong, of 6 — in sample, not a score. (The out-of-sample table's “model on the day’s real traffic” column is always today’s code, so it carries the same caveat.)

*Out of sample* — chosen after round 1 was scored and the model learned JIT warm-up from its miss; predicted from the same ordinary day and committed before any of these runs was recorded; the verdicts are the ones committed in `validation/predictions-oos-2.json` before each run was recorded:

| run | question | measured (k6, every request) | backtest before the day | model on the day’s real traffic | naive CPU ratio |
|---|---|---|---|---|---|
| `launch-visits125` | visits-service at 125m instead of 250m, on launch day? | **pass**: p99 8 ms, errors 0.00%, 0 min out of SLO | inconclusive ⚠️ leans pass (medium confidence), 0 min | p99 10 ms, errors 0.00%, 0 min | pass ✅ at 62% CPU |
| `launch-cust175` | customers-service at 175m instead of 250m, on launch day? | **pass**: p99 9 ms, errors 0.00%, 0 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 0.3 min | p99 11 ms, errors 0.00%, 0 min | pass ✅ at 89% CPU |
| `launch-cust-hpa` | An HPA (1–3 customers-service pods at 60% CPU) instead of 1 fixed, on launch day? | **pass**: p99 9 ms, errors 0.00%, 0 min out of SLO | pass ✅ (medium confidence), 0 min | p99 9 ms, errors 0.00%, 0 min | pass ✅ at 41% CPU |

Backtest verdicts: **1 right**, 2 inconclusive (it said to load-test; 2 of them leaned the right way), 0 wrong, of 3. Naive CPU ratio: 3 right.

*Retrodiction, not a prediction* — what today's code says from the same ordinary day, after the model learned JIT warm-up. The warm-up's defaults (×5 CPU per request while cold, 30 core-seconds of compilation, 6% of the limit for the compiler under load) were fitted on `launch-cust125` and `normal-cust125` after they were recorded, so this is the model explaining runs it was shaped on, in sample:

| run | measured | committed before the run (scored above) | today’s code on the ordinary day (retrodiction) |
|---|---|---|---|
| `launch-visits125` | **pass**, 0 min out of SLO | inconclusive ⚠️ leans pass (medium confidence), 0 min | inconclusive ⚠️ leans pass (medium confidence), 0 min |
| `launch-cust175` | **pass**, 0 min out of SLO | inconclusive ⚠️ leans pass (low confidence), 0.3 min | inconclusive ⚠️ leans pass (low confidence), 0.3 min |
| `launch-cust-hpa` | **pass**, 0 min out of SLO | pass ✅ (medium confidence), 0 min | pass ✅ (medium confidence), 0 min |

Retrodiction: 1 right, 2 inconclusive, 0 wrong, of 3 — in sample, not a score. (The out-of-sample table's “model on the day’s real traffic” column is always today’s code, so it carries the same caveat.)

**Every out-of-sample round together** (9 runs): Backtest verdicts: **5 right**, 3 inconclusive (it said to load-test; 2 of them leaned the right way), 1 wrong, of 9. Naive CPU ratio: 8 right, 1 wrong (a rule like that never abstains).

p99 of the model on each day's real traffic, against the measured p99: within 20% in **5 of 9** runs; the others off by 22–100%.



The first 2 minutes of every run are left out of the scoring, measured and predicted alike (pods restarted minutes earlier). Generated by `npx tsx reference/k8s/evaluate.ts petclinic`, 2026-10-17.
<!-- /RESULTS -->

## What round 1 says

**4 right, 1 wrong, 1 inconclusive that leaned the wrong way. The plain CPU rule got 5 right.**
The backtest was right about the system as built and about all three gateway changes (one
gateway instead of two, on either day, and the HPA). It got the CPU cut wrong on both days, and
on this round the rule beat it. Its p99 is pessimistic on healthy days: 14 ms predicted against 7–9 ms measured. That is
off by more than 20% in every run, but the absolute error is a few milliseconds, against a 500 ms
SLO.

*Recomputed with today's model (in sample: the fix was found on these runs, and the table above
shows it).* The model's p99 on each run's own traffic is now 9 ms on every healthy run. With the
JIT warm-up below (also in sample), it is within 20% in 4 of 6 runs: launch 9 against 8,
launch-gw1 9 against 8, normal-gw1 9 against 9, and launch-cust125 5000 against 5003. launch-hpa,
9 against 7, is still 29% off, and normal-cust125 is 14 ms against 5001. The ordinary-day holdout reads 9 ms against 9 measured, off by 4%
instead of 58%. The cause was where the baseline came from. Calibration read each endpoint's
baseline latency from the quietest 30% of the ordinary day, and here the quietest minutes are the
slowest: at 20 req/s k6 measured 6–7 ms mean and 12–33 ms p99 per 30 s bucket, at 60 req/s and
above 3.5 ms and 7–9 ms. The gateway path wakes for each request when it idles between them, so
latency falls with load until anything queues. The baseline now comes from every bucket in which
nothing on the path queues, weighted by its requests. The verdicts above are the committed ones
and the warm-up section below gives today's code's verdicts.

**The miss: halving a JVM's CPU limit.** At 125m, customers-service broke on both days. On launch
day it spent 29.5 minutes out of SLO with 64% of requests failing; on the ordinary day it spent 4
minutes out. The backtest said *inconclusive, leans pass* for launch day, because customers-service
would run at 89% of a capacity the history never tested. For the ordinary day it said *pass*. The
naive CPU rule caught launch day (125% CPU) and missed the ordinary day.

The recording shows why. As built, customers-service spends 1.04 ms of CPU per request. At 125m,
from the start of each run, it spent 4.3 ms on launch day and 3.9 ms on the ordinary day, pinned
at its limit and throttled in every period. Then on launch day, at minute 30.5, it switched to
the warm cost within one 30-second bucket. It went from 41 to 125 requests a second on the same
CPU, and it never went back. On the ordinary day the same switch came at minute 8.5. A gradual
recovery would follow the traffic. An abrupt, permanent drop to the warm cost is what a JVM does
when its JIT finishes compiling the hot paths. (Memory stayed at 650 MiB of 1 GiB and the pod did
not restart.)

So the 5-minute warm-up that compiles everything at 250m does not finish at 125m. The JIT's
compiler threads compete with the request threads for the same throttled CPU. Under load they
lose, and the service stays on interpreted code at about four times the cost. Once warm, 125m is
enough: about 120 req/s of capacity against the ordinary day's peak of 78. The steady state the
model predicted was right; the cold start it never modelled was what failed. The history cannot
show this, because its pods were already warm.

This is a known trap: Java services on Kubernetes with tight CPU limits that never warm up. The
model did not know about it when it made the verdicts above.

## What the model learned from the miss (in sample)

The model now knows JIT warm-up. A pod of a JIT runtime that starts during a replay starts cold.
That covers a rollout of the change itself (a new pod template replaces the pods), pods an
autoscaler adds, replacements after a node is lost, and restarts after an OOM kill. While cold, a
request costs ×*m* the CPU it costs warm, until the pod has done *D* core-seconds of compilation.
The compiler gets only the CPU the requests leave idle under the limit, plus a share *g* of the
limit when they take all of it. Nothing else drives the spiral: a saturated pod barely compiles, so
it stays slow because it is slow. An idle one is warm in minutes.

The JVM's defaults are *m* = 5, *D* = 30 core-seconds and *g* = 6%. They were fitted on
`launch-cust125` and `normal-cust125` (engine-rs `model.rs`, `assumed_warmup`). Each run was
replayed from its 5-minute warm-up ramp onwards, on its own traffic, and a grid search looked for
the minute each run turned warm. With these numbers the replay turns warm at minute 29.1 on launch
day and 8.5 on the ordinary day (measured: 30.5 and 8.5), with 29 and 1.5 minutes out of SLO
(measured: 29.5 and 4). Cold, the pod served 26–39 req/s against the model's 200 when warm, which is
×5 to ×7.7. Nearby values fit as well along a ridge: *D*/*g* is what sets the launch day, so *D* = 35 with
*g* = 8% fits about as well. These are two runs of one service, so the parameters are in sample.
Where a history shows a pod starting, calibration measures *D* instead. This history shows none.

The runtime comes from the traces (`telemetry.sdk.language`, `process.runtime.name`) or, in a
Kubernetes diff, from the pod template: an image named for a JVM, or `JAVA_TOOL_OPTIONS` with the
OpenTelemetry agent, as here. A JVM's verdict now reads like this (`normal-cust125`, today's code):
*"customers-service restarts on its new 125m CPU limit and a JVM needs ~30 core-seconds of JIT
compilation to warm up (assumed): until then a request costs ×5 its warm CPU; in the replay it is warm
7.8 min after it starts"*, followed by *"while its restarted pods are still cold the system sustains
53.4 req/s, below the peak it has to serve (107.1): rolled out at a busy moment, it would not warm
up"*. The verdict is inconclusive, leaning pass, at medium confidence, and the warning says the
warm-up is assumed. On launch day it says fail.

The retrodiction table under the results shows today's verdicts beside the committed ones. It is
not a score: the warm-up was designed on these two runs. The ordinary day is still not called a
fail. The model rolls the change out at the first moment of the replayed day, about 25 req/s at
customers-service, and at that load the pod warms. The run failed because its rollout met a
5-minute ramp to 100 req/s at the gateway, which left a backlog the cold pod could not clear. The
model can't know when a team will deploy. What it can do is say how much load a cold pod takes and
leave the verdict open. Round 2, below, tested the warm-up on runs it was not fitted on.

## Round 2: testing the warm-up on runs it was not fitted on

After round 1 the model learned JIT warm-up from its miss. Three new questions were then chosen,
and their verdicts committed in [validation/predictions-oos-2.json](validation/predictions-oos-2.json)
before any of the runs was recorded: a different JVM at the same cut, an in-between limit, and pods
an autoscaler adds. All three changes passed in reality.

**1 right, 2 inconclusive (both leaned the right way), 0 wrong. The plain CPU rule got 3 right.**
On this round the model was never wrong, but it hedged twice where the rule just answered.

- **visits-service at 125m: inconclusive, leans pass.** The replay warmed the pod 7.9 minutes after
  the rollout. The recording shows it cold for about the first 5 minutes (2.2 ms of CPU per request,
  throttled in 69% of periods), then warm. What made the verdict inconclusive was a second check:
  the model works out how much traffic the system can carry while the new pods are cold. Here that
  was 123 req/s, below the day's peak of 238. A rollout at a busy moment would not warm up, so the
  verdict says to roll out when traffic is low. This rollout happened at the day's quiet start, and
  it warmed up. The check answers a question about rollout timing that the replayed day doesn't ask.
  As a warning only, it would have made this a right pass; it still withholds the verdict, for the
  reason given after this list.
- **customers-service at 175m: inconclusive, leans pass, low confidence.** The replay had the pod
  cold for 10.2 minutes. The recording shows no cold stretch at all: 1.19 ms of CPU per request in
  the first five minutes, the same as as built. The recorder's 5-minute warm-up traffic before the run
  (10 → 100 req/s) compiled the hot paths even at 175m, and the replay doesn't include that traffic.
  The warm-up's assumed cost, fitted at 125m, was too pessimistic here. Low confidence also came from
  the capacity: the change runs customers-service at 96% of a capacity the history never tested.
- **customers-service on an HPA of 1–3: pass**, right. The pod started cold (5.4 ms of CPU per
  request in the first five minutes), the autoscaler added a second, and the day stayed in SLO.

Across both rounds (9 runs) the model got 5 right, 1 wrong and 3 inconclusive, and the CPU rule got
8 right and 1 wrong. The model's one wrong answer came before it knew warm-up. On these runs its
inconclusives cost more right answers than they saved wrong ones. Two changes follow from this
round, tried afterwards (in sample):
- **Making the cold-capacity check a warning was dropped.** It turned `launch-visits125` into a right
  pass, but it also turned round 1's `normal-cust125` into a wrong one, because that rollout met
  load. For a gate, a hedge is cheaper than a wrong pass.
- **Setting the warm-up's compile work from the history isn't possible here.** Calibration does
  measure it from a pod start in the history and then drops the "assumed" warning (a test pins
  this). But no replica count changes on this ordinary day, and the recorder's warm-up traffic runs
  before the collected window.
The inconclusives on both systems, and the rule behind each, are listed in
[../README.md](../README.md#a-second-system-petclinic).

## What the repository keeps

The measured side of each of round 1's six runs (p99, errors and minutes out of SLO over every k6
request) is in [validation/validation.json](validation/validation.json). It was computed while the
request logs existed. The per-request logs of those six runs were lost before they were committed:
they sat in a git-ignored file awaiting compression when the working copy was removed. The recorder
now writes the compressed log itself. `evaluate.ts petclinic` keeps the committed measurements
and recomputes only the model's side. The ordinary day's log (`runs/history/requests.csv.gz`) and round 2's three
are committed.

## Running it

```sh
npx tsx reference/k8s/record.ts petclinic <run>       # needs the kind cluster (../README.md)
npx tsx reference/k8s/evaluate.ts petclinic            # regenerates the table above from the committed data
```
