# What the validation found (October 2026)

Written on 18 October 2026, after six out-of-sample rounds on the Astronomy Shop and two on
PetClinic, both on a kind cluster on one laptop. The full record, run by run, is in
[reference/k8s/README.md](../reference/k8s/README.md) and
[reference/k8s/petclinic/README.md](../reference/k8s/petclinic/README.md). This page says what it
adds up to.

## The pass/fail verdict alone doesn't beat a simple CPU check

27 questions were asked out of sample, each verdict committed to the repository before its run
was recorded. The question each time: does this change (replicas, a CPU limit, an autoscaler, a
memory limit) keep the system within its SLO on that day? The comparison is a rule anyone can
work out in a spreadsheet: take a service's busiest CPU in the history, scale it by the change, and
call it a pass under 100%.

| | right | wrong | inconclusive |
|---|---|---|---|
| Hindcast, calibrated on an ordinary day | 11 | 5 | 11 |
| the plain CPU rule | 18 | 9 | — |

- **Where Hindcast gave a pass or a fail (16 times), the CPU rule gave the same answer every time.**
  It was right 11 times. Hindcast never confidently disagreed with the rule.
- **Where Hindcast said inconclusive (11 times), the rule was right 7 times.** Hindcast's own lean
  was right 4 times.
- **Every one of Hindcast's 5 wrong calls was also wrong for the rule.**

So on this question, for these kinds of changes on these two systems, Hindcast adds no accuracy
over a CPU ratio. It is wrong less often because it abstains, not because it is right more often.
Recalibrating on more of the recorded runs (a leave-one-run-out test,
[reference/k8s/loo.ts](../reference/k8s/loo.ts)) didn't change that.

## Why it misses where it does

- **Load beyond the history.** The model fits CPU per request as a straight line on an ordinary
  day and extrapolates it to launch-day peaks (2.2×). On these systems CPU per request often fell
  at higher load, so the model under-read capacity. In round 6, all three changes passed on launch
  day where the model said fail.
- **The system changed under the calibration.** Between 13 and 18 October the shop's services got
  7–34% cheaper per request. The drift check (`check_drift`, `hindcast drift`) now measures this
  and says "recalibrate", but the extrapolation above is the larger effect.
- **Incidents the change doesn't cause decide the day.** On the shop's launch day, email's memory
  leak gets it OOM-killed at minute 23–28 whatever the change. Whether the kill lands on traffic
  moved minutes out of SLO by a minute between recordings, twice the half-minute gate.
- **Recording conditions.** One round's runs were recorded on battery, where Low Power Mode
  doubled CPU per request, and two runs were cut by the laptop sleeping. Those runs are void, and
  the recorder now refuses to start on battery and voids any run with a sleep gap.

## What Hindcast gets that a CPU ratio can't see

These come from the same recordings, and none of them is visible to a CPU ratio:

- **Memory leaks and OOM kills.** Calibration reads a leak per 1,000 requests from an ordinary day.
  Two kill-or-not predictions committed before their runs came true. One was a kill predicted at
  minute 29.5, which came at 35. The other was a change predicted to stop the kill, which it did.
- **Node loss.** With the pod placement at the moment a node was stopped, the replay timed
  Kubernetes' recovery at 380 s against 348 s measured, and named the seven services that lost
  their only replica.
- **JIT warm-up.** A Java service whose CPU limit was halved never finished compiling under load
  and failed for 29.5 minutes. The CPU rule passed that run's ordinary-day twin as well. The model
  now replays warm-up, but its parameters are fitted on that one service, and only one later round
  tested them.
- **Throttling before 100% CPU, retries, timeouts, connection limits, slow dependencies.** These
  are modelled in both engines and in the replay, and they set when a request fails. A CPU ratio
  reports none of them.
- **Minutes and money.** How many minutes out of SLO, which endpoint, when, and what the change
  costs or saves per month.

The design sandbox, lessons, comparisons and failure audit don't depend on telemetry at all. These
findings don't bear on them.

## What follows

Pass/fail on capacity changes is the one place where Hindcast doesn't add value over a
spreadsheet, and the record says so plainly. Its value is in the failures and the costs above.
The planned improvements are in [roadmap.md](roadmap.md).
