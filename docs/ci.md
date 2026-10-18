# Hindcast in CI

Every pull request that changes how a system is deployed can be backtested before it merges: the
change is replayed over recorded production traffic through the calibrated model, and the check
says what it would have cost and whether it would have broken the SLO. The verdicts are the ones
the agent tool `verify_change` gives (pass, fail or inconclusive, with a confidence); the CI path
and the agent path run the same function.

Two ways to run it:

- **The GitHub Action** (`uses: votiakov/hindcast@v1`), below. It fetches the binary, reads the
  base version of the manifests from git, comments on the pull request and fails the check.
- **The CLI in any CI system**: `hindcast verify-change` (see [the command](#the-command)), or the
  older `diff-strategy` + `backtest --gate` pair in [examples/backtest-ci](../examples/backtest-ci).

What the repository needs either way: a calibrated model and a recorded history. If you ran
`hindcast quickstart` in the repository, they are already there: `.hindcast/model.json` and
`.hindcast/dataset.json` (from files, `hindcast import` and `hindcast calibrate` write the same
two). Commit those two files and leave the rest of `.hindcast/` (raw telemetry, reports)
ignored:

```gitignore
.hindcast/*
!.hindcast/model.json
!.hindcast/dataset.json
!.hindcast/drift.json
```

They hold service names, endpoint paths and request rates, nothing more; if even that is
sensitive, fetch them in the job instead of committing them. Refresh them on a schedule from a
runner that can reach your Prometheus (`hindcast quickstart --prometheus … --last 7d`, then commit
the two files); the pull-request check itself needs nothing but the repository.

**Drift.** A committed model ages: the system it was fitted on changes under it. The same scheduled
job can check that daily, `hindcast agent check_drift '{"workspace":".hindcast","last":"6h"}'`,
and commit `.hindcast/drift.json` with the model; when it finds drift, recalibrate (the quickstart
above) instead. The pull-request check doesn't collect anything, but it reads `drift.json` beside
the model: a service it found changed lowers the verdict's confidence (to low where the verdict
rests on it), and the comment opens with a line saying the system has changed since calibration
and to recalibrate. A drift check more than a day old gets a line too. With no `drift.json`, the
comment says nothing about drift. See [agents.md](agents.md#check_drift-has-the-system-changed-since-calibration).

## GitHub Action

```yaml
name: Backtest infrastructure changes
on:
  pull_request:
    paths: ['deploy/**', '.hindcast/**']
permissions:
  contents: read
  pull-requests: write      # for the comment; without it the result is in the job summary only
jobs:
  backtest:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: votiakov/hindcast@v1
        with:
          model: .hindcast/model.json
          dataset: .hindcast/dataset.json
          manifests: deploy/
```

On a pull request it:

1. downloads the Hindcast release binary for the runner (Linux x64, macOS arm64 and x64, Windows
   x64), checks that it runs, and caches it;
2. writes out the manifests as they are at the pull request's base commit (`git show
   <base>:<path>`, fetching that one commit if the checkout is shallow), to compare with the
   working tree's;
3. runs `hindcast verify-change`: the manifest diff becomes a strategy (replicas, CPU and memory
   limits and requests, HorizontalPodAutoscalers, `kubernetes.io/arch`), backtested over the
   dataset;
4. appends the result to the job summary and posts it as one pull-request comment, which later
   pushes update in place (the comment carries a hidden marker it is found by);
5. fails the step when the verdict is `fail` (configurable with `fail-on`).

A Terraform plan works the same way, without a base: the plan holds before and after itself.

```yaml
      - run: terraform plan -out plan.out && terraform show -json plan.out > plan.json
      - uses: votiakov/hindcast@v1
        with:
          model: .hindcast/model.json
          dataset: .hindcast/dataset.json
          terraform-plan: plan.json
```

`manifests` and `terraform-plan` can be given together, and `strategies` adds strategy files of
your own; each is judged on its own and the step's verdict is the worst of them.

### Inputs

| input | default | what |
|---|---|---|
| `model` | (required) | the calibrated model, `hindcast calibrate` |
| `dataset` | (required) | the recorded history, `hindcast import` |
| `manifests` | | Kubernetes manifests, a directory or a file; the base version comes from git |
| `terraform-plan` | | `terraform show -json` output |
| `strategies` | | strategy files to backtest as well, space- or newline-separated |
| `base-ref` | the pull request's base commit; elsewhere `HEAD^` | the commit to compare the manifests with |
| `head-ref` | the working tree | read the head manifests from this commit instead |
| `base-manifests` | | files to use as the manifests before the change, instead of reading `base-ref` |
| `baseline-ref` | | a stacked pull request: the commit whose manifests are an approved change not yet deployed, applied to both sides ([below](#stacked-pull-requests)) |
| `baseline-manifests` | | files to use as the baseline's manifests, instead of reading `baseline-ref` |
| `baseline-strategy` | | a strategy file to apply to both sides as the baseline |
| `last` | `14d` | replay only the most recent part of the history; empty replays all of it |
| `draws` | `30` | capacity draws behind the 10–90% bands |
| `gate-minutes` | `0.5` | minutes out of SLO a change may add over the window before it fails (it also fails on more failed requests than the SLO's error budget over the window, whatever this is) |
| `slo-p99-ms` | the model's | override the p99 SLO, for the system and every endpoint |
| `slo-error-rate` | the model's | override the error-rate SLO (`0.01` = 1%), for the system and every endpoint |
| `fail-on` | `fail` | `fail`, `inconclusive` (fail on either), or `never` |
| `comment` | `true` | post the pull-request comment |
| `comment-key` | | tells apart several Hindcast checks on one pull request (e.g. one per system) |
| `title` | `Hindcast backtest` | the comment's heading |
| `version` | the action's tag | the release to run, e.g. `v1.2.0`. At `@v1` it is the newest `v1.x` release; at a branch or a commit, the latest release |
| `binary` | | a `hindcast` binary to run instead of downloading one (relative to `working-directory`) |
| `working-directory` | `.` | the directory the other paths are relative to |
| `github-token` | `github.token` | for the download and the comment |

### Choosing `fail-on`

With the default, only `fail` fails the check; an `inconclusive` passes it, and the comment says to
load-test first. On the reference runs that matters: of 26 questions whose verdicts were committed
before they ran, 11 came back inconclusive, and 5 of those failed for real (the Astronomy Shop's
`launch-2c`, `launch-2-750`, `launch-cart250` and `launch-rec2`, PetClinic's `launch-cust125`). The other 6 passed, so blocking on
inconclusive would also have held back 6 good changes. `fail-on: inconclusive` is the stricter
choice for a system where a bad rollout costs more than a delayed one;
[reference/k8s](../reference/k8s/README.md#a-second-system-petclinic) lists what each inconclusive
rested on.

### Outputs

| output | what |
|---|---|
| `verdict` | `pass`, `fail`, `inconclusive`, or `nothing to verify` (no change the model can backtest) |
| `confidence` | `high`, `medium` or `low`, the lowest over the changes |
| `gate` | `failed` when the verdict is one `fail-on` names, else `passed` |
| `monthly-delta` | $ per month the first change adds (negative: saves), median |
| `minutes-out-of-slo-delta` | minutes out of SLO it adds over the window, median |
| `failed-requests-delta` | failed requests it adds over the window, median |
| `summary` | path of the Markdown comment |
| `result` | path of the full `verify_change` result (JSON) |
| `report` | path of the HTML report |

To keep the HTML report with the run:

```yaml
      - uses: votiakov/hindcast@v1
        id: hindcast
        with: { model: .hindcast/model.json, dataset: .hindcast/dataset.json, manifests: deploy/ }
      - if: always() && steps.hindcast.outputs.report != ''
        uses: actions/upload-artifact@v4
        with: { name: hindcast-report, path: '${{ steps.hindcast.outputs.report }}' }
```

### Permissions and secrets

- `contents: read` to check out the repository; `pull-requests: write` for the comment. Without
  the second, the comment step warns and the result stays in the job summary.
- No secrets beyond `GITHUB_TOKEN`. The action reads the repository and the release, and writes
  only its one pull-request comment.
- Pull requests from forks get a read-only token on the `pull_request` event: the check runs and
  fails as usual, and the comment is skipped with a warning.
- The comment goes through the `gh` CLI, which every GitHub-hosted runner has. On a self-hosted
  runner without it, the result is in the job summary only.

### Versions

`uses: votiakov/hindcast@v1` runs the action as of the newest `v1.x` release and that release's
binary; today that is v1.2.0. A full release tag (`@v1.2.0`) or a commit pins it. The action needs
a release that has `hindcast verify-change` (newer than v1.1.0); with an older one it stops and
says so. With `version` set, that release's binary runs, whichever tag the action itself was taken
from.

Some of this page is on `main` and not yet in a release ([the list](install.md#release-or-main)):
the stacked-pull-request inputs (`baseline-ref`, `baseline-manifests`, `baseline-strategy`) and the
decision table that opens the comment. At `@v1` the comment opens on the evidence, and the
baseline inputs don't exist (GitHub warns about an unexpected input and the change is judged
against what runs). To use them before the next release, take the action at `@main` and give it a
binary built from `main` with the `binary` input (a step that runs `cargo build --release --bin
hindcast` in a checkout of this repository, as this repository's own CI does below). Without
`binary`, `@main` downloads v1.2.0, which would ignore the baseline, so the action stops and says
so instead.

### What the comment looks like

The backtest-ci example's HotROD model, on a pull request that cuts the frontend's CPU limit from 1
to 50 millicores (`test/cli-fixtures/hotrod-frontend-50m.yaml`), as the action writes it. The
table on top is for whoever approves the change: what is asked, the money a month and a year, the
risk to users, how sure the backtest is and the one reason why, and the next step. The evidence an
engineer reviews follows it, and `--md` / `--html` reports open with the same table. (This is a
build from `main`; v1.2.0's comment has no table and opens on the evidence.)

````markdown
<!-- hindcast-verify-change -->
### ❌ Hindcast backtest: fail — would have broken the SLO

**frontend CPU 1 → 0.05**

| | |
|---|---|
| **Ask** | approve frontend CPU 1 → 0.05 |
| **Money** | saves $23/month, about $276 a year, priced from your bill |
| **Risk to users** | 18 min more out of SLO and 7,212 more failed requests, replaying the last 41 minutes of recorded traffic |
| **How sure** | low: frontend would run at 150% of a capacity the history never tested (peak 7%): the outcome rests on an extrapolated limit (3 more caveats below) |
| **Next** | don't ship it as it is |

<sub>SLO: the target of 99% of requests answered within 1,000 ms and under 3% failing. Time out of SLO: minutes that missed it. p99: the time 99% of requests finish within.</sub>

#### The evidence

**frontend CPU 1 → 0.05** — **fail** · confidence **low**

It saves $23/month; it would have caused 18 minutes out of SLO, the longest new incident starting Oct 7 at 16:28 UTC (frontend at 71% of capacity (3.9 req/s on 1 × 5.5 req/s), 132 ms wait).

- **$ / month:** −$23.03/month (your bill)
- **minutes out of SLO:** +18 min (+14 min … +19.5 min) — 32 min in all with the change, 13.8 min as built
- **failed requests:** +7,212 (+6,611 … +8,151)
- **worst moment:** Oct 7 at 16:49 UTC — p99 5000 ms, 100% errors; frontend at 202% of capacity (11.2 req/s on 1 × 5.5 req/s), 203.5 s queue

Why:
- adds 18 min out of SLO (10–90%: 14 … 19.5)
- fails 7,212 more requests than as built (+510% of 1,413), more than the SLO's error budget over the whole window (3% of 11,657 requests: 350)
- worse for frontend GET /dispatch against their own SLOs
- headroom drops from 6.1 to 3.9 req/s (the history peaked at 11.2)

Confidence low:
- frontend would run at 150% of a capacity the history never tested (peak 7%): the outcome rests on an extrapolated limit
- mysql fits not at all and runs near its limit; the change leaves it as it was, so the comparison holds better than the absolute numbers
- the model missed p99 (holdout, off by 72%) on data it never saw: off by more than half on what the verdict is counted from (latency, the breaking point), so a replay can't be trusted to place the SLO's edge
- only 0.7 h of history: daily and weekly peaks may be missing

<sub>Replayed the last 41 minutes of recorded traffic through the calibrated model · 30 draws (capacities varied within their fitted ranges) · ranges are 10th–90th percentiles: 8 in 10 draws fall inside</sub>

| | $/month | minutes out of SLO | failed requests | worst moment |
|---|---|---|---|---|
| As built | $95.56 | 14 min (14 min … 15 min) | 1,413 (748 … 2,125) | Oct 7 at 16:51 UTC · mysql at 84% of capacity (7.5 req/s on 1 × 8.9 req/s), still draining a 18.0 s backlog |
| frontend CPU 1 → 0.05 | −$23.03 | 32 min (28 min … 33 min) | 8,755 (7,866 … 9,225) | Oct 7 at 16:49 UTC · frontend at 202% of capacity (11.2 req/s on 1 × 5.5 req/s), 203.5 s queue |

<sub>SLO: p99 ≤ 1000 ms, errors ≤ 3% · fails if it adds more than 0.5 min out of SLO over the window, or more failed requests than the SLO's error budget over it (3% of 11,657 requests: 350)</sub>

<details><summary>Model accuracy: 5/6 checks within target</summary>

```
PASS p99            predicted 641 ms vs measured 659 ms — off by 2.6% (target ≤ 20%) · replicas-2: p99 of all 11,590 requests of the run; per 5-minute window the typical error is 3%, worst 6%
PASS cost           predicted $0.102 vs measured $0.102 — off by 0.2% (target ≤ 10%) · replicas-2: predicted cost vs the run's bill
PASS breaking-point predicted 6.6 req/s vs measured 7.6 req/s — off by 13.5% (target ≤ 15%) · stress: step load test, p99 and errors over every request of each plateau (SLO p99 ≤ 1000 ms, errors ≤ 3%)
PASS breaking-point predicted 7.7 req/s vs measured 7.7 req/s — off by 0.0% (target ≤ 15%) · stress-replicas-2: step load test, p99 and errors over every request of each plateau (SLO p99 ≤ 1000 ms, errors ≤ 3%)
MISS p99            predicted 1384 ms vs measured 5022 ms — off by 72.4% (target ≤ 20%) · p99 of all 3,443 requests on the last 13 min, calibrated on the 28 min before; per 5-minute window the typical error is 37%, and the measurement fell inside the model's 10–90% band in 1 of 2 windows
PASS cost           predicted $0.027 vs measured $0.027 — off by 1.1% (target ≤ 10%) · model cost vs the bill over the held-out window
```
</details>

<details><summary>What was backtested</summary>

```yaml
name: frontend CPU 1 → 0.05
description: from the pull request diff
changes:
  - service: frontend
    cpu: 0.05
```
</details>
````

The check failed, as it should: the cut saves $23 a month and would have added 18 minutes out of
SLO. Confidence is low because the frontend would run past anything the 41-minute history showed,
and the comment says so. A change the model cannot backtest (an image tag, a label) posts "nothing
to verify" and passes.

### Stacked pull requests

On `main`, not yet in a release: see [Versions](#versions) for running it today.

PR #1 is approved but not deployed yet; PR #2 is branched from it. Compared with what runs, PR #2's
verdict would mix in PR #1's effect. With a baseline, both sides of the comparison have PR #1
applied, and the verdict, the deltas and the gate are about PR #2 alone:

```yaml
on:
  pull_request:
    paths: ['deploy/**']

jobs:
  backtest:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: votiakov/hindcast@v1
        with:
          model: .hindcast/model.json
          dataset: .hindcast/dataset.json
          manifests: deploy/
          base-ref: origin/main                                       # what runs
          # the pull request this one targets: PR #1's head, applied to both sides
          baseline-ref: ${{ github.event.pull_request.base.ref != 'main' && github.event.pull_request.base.sha || '' }}
```

A pull request into `main` has no baseline (`baseline-ref` empty) and is compared with what runs, as
before. One stacked on another's branch gets PR #1's manifests (at `baseline-ref`) as the baseline,
and its change is read from them to its head. The comment opens with what it was compared with:

```
**Compared with** as built with "customer 1 → 2 replicas" applied: the baseline is in place on
both sides, its pods running before the window, and each change is judged on what it adds on top of it.
```

and "as built" in its lines reads the same ("13.5 min as built with "customer 1 → 2 replicas"
applied"). The baseline's pods are taken as running before the window on both sides, so its own
rollout is never PR #2's cold start; a service PR #1 changes counts as touched for confidence,
since both sides now rest on the model's reading of it. `baseline-strategy` takes a strategy file
instead, for a baseline that isn't in manifests. How the two are stacked is in
[agents.md](agents.md#stacked-changes-baseline).

### Testing the action without a pull request

`base-ref`, `head-ref` and `base-manifests` make it run anywhere. This repository's CI runs the
action from the checkout with a binary built in the job (`.github/workflows/ci.yml`, job `action`),
since no release holds the current commit's binary:

```yaml
      - run: cp test/cli-fixtures/hotrod-frontend-50m.yaml examples/backtest-ci/deploy/hotrod.yaml
      - uses: ./
        id: cut
        continue-on-error: true
        with:
          model: reference/hotrod/model.json
          dataset: reference/hotrod/dataset.json
          manifests: examples/backtest-ci/deploy
          base-ref: HEAD                         # the committed manifests are the base
          binary: engine-rs/target/release/hindcast
          comment: 'false'
```

The script behind it runs locally too:

```sh
HINDCAST_BIN=engine-rs/target/release/hindcast INPUT_MODEL=reference/hotrod/model.json \
INPUT_DATASET=reference/hotrod/dataset.json INPUT_MANIFESTS=test/cli-fixtures/hotrod-frontend-50m.yaml \
INPUT_BASE_MANIFESTS=examples/backtest-ci/deploy bash action/verify.sh
```

and stacked, the 50m cut on top of an approved second customer replica:

```sh
HINDCAST_BIN=engine-rs/target/release/hindcast INPUT_MODEL=reference/hotrod/model.json \
INPUT_DATASET=reference/hotrod/dataset.json INPUT_MANIFESTS=test/cli-fixtures/hotrod-customer-2-frontend-50m.yaml \
INPUT_BASE_MANIFESTS=examples/backtest-ci/deploy INPUT_BASELINE_MANIFESTS=test/cli-fixtures/hotrod-customer-2.yaml \
bash action/verify.sh
```

It prints the verdict, writes the comment, the JSON result and the reports to a temporary
directory, and ends on `gate: failed` or `gate: passed`: what the action's last step would make
of it. The script itself exits 0 on any verdict (in a workflow, that last step fails the job).
Swap in your own `.hindcast/model.json`, `.hindcast/dataset.json` and manifests to try it on
your system before adding the workflow.

## The command

```
hindcast verify-change --model model.json --dataset dataset.json
    (--base <dir> --head <dir> | --terraform-plan plan.json | <strategy.yaml …>)
    [--baseline-head <dir> | --baseline strategy.yaml | --baseline-terraform-plan plan.json]
    [--last 14d] [--draws 30] [--gate-minutes 0.5] [--p99 500] [--errors 0.01] [--scale 2 | --peak 400]
    [--comment comment.md] [--json result.json] [--md report.md] [--html report.html] [--outputs $GITHUB_OUTPUT]
    [--title "Hindcast backtest"] [--comment-key <key>] [--run-url <url>] [--fail-on fail|inconclusive|never]
```

It is `verify_change` on files named on the command line: the same strategies, verdict and
confidence. `--comment` writes the pull-request comment above, `--json` the tool's full result,
`--outputs` appends `verdict=…`, `confidence=…`, `gate=…`, the first change's deltas and the
comment's `marker=…` as `key=value` lines. The exit code is 0, or 2 when the verdict is one
`--fail-on` names (default `fail`), and 1 on an error, a flag it doesn't take among them (a
misspelt `--baseline-hed` is refused, never ignored). Without `--draws`, the number of draws is
fitted to a time budget, so pass it in CI for repeatable bands.

`--baseline-head <dir>` stacks the change on an approved one not yet deployed: the baseline is
`--base` → `--baseline-head`, applied to both sides, and the change is `--baseline-head` → `--head`.
`--baseline` (a strategy file) and `--baseline-terraform-plan` give the baseline in those shapes.

```sh
hindcast verify-change --model reference/hotrod/model.json --dataset reference/hotrod/dataset.json \
  --base examples/backtest-ci/deploy --baseline-head test/cli-fixtures/hotrod-customer-2.yaml \
  --head test/cli-fixtures/hotrod-customer-2-frontend-50m.yaml --draws 4
# verdict fail · confidence low
#   compared with as built with "customer 1 → 2 replicas" applied: …
#   fail frontend CPU 1 → 0.05: saves $23/month; it would have caused 18 minutes out of SLO, …
```
