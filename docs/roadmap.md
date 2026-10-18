# Planned improvements

From what the October 2026 validation found ([findings.md](findings.md)). None of these is built
yet. The first item is a decision for the project's owner before any code.

1. **Say what Hindcast is for.** The README leads with the pass/fail verdict, which a CPU ratio
   matches. Proposed: lead with the failures a CPU check misses (memory leaks and OOM kills, node
   loss, warm-up after a rollout, throttling, retries, connection limits), and the minutes and
   dollars they cost. Keep the accuracy record as it is, misses included. *Awaiting a decision.*

2. **"Risks a CPU check can't see" in every verdict.** A short list in `verify_change`'s answer,
   the PR comment and every report. One plain sentence per risk, with its number and its basis
   (measured or assumed), and whether the change adds it or the system has it already. For
   example: "email is OOM-killed at minute ~26 at this load (+9.6 MiB per 1,000 requests,
   measured): checkout fails for 1–2 minutes, as built too". When there is none, it says so: "the
   CPU check is the whole story".

3. **Say how the verdict relates to the CPU check.** `cpuCheck` is already in every answer. The
   verdict should open with "agrees with the CPU check", or with why it doesn't. When it is
   inconclusive, it should say which way the CPU check points. On the committed runs, the CPU
   rule was right on 7 of the 11 inconclusives and the replay's lean on 4.

4. **CPU per request that changes with load.** Replace the straight-line fit with one that lets
   CPU per request fall (or rise) with load. Give it an uncertainty band that widens beyond the
   history, and use a team's own past busy days (several collection windows) where they exist.
   This is the main source of the model's misses.

5. **Callers that stay broken after a dependency restarts.** After a rollout or node loss, a
   gRPC caller's channel can stay broken for minutes. On the reference cluster that was 252 s
   after node loss, and checkout failed for minutes after a rollout. Today it is a sensitivity on
   node loss only. Apply it to rollouts and name it as a risk.

6. **Drift on a schedule.** Run the drift check daily in CI and put its result in the PR comment
   (the `drift.json` hook exists). Then a verdict on a model that is out of date says so before
   anyone reads it.

7. **Release 1.2.1.** It is tagged, but no binaries are built yet. It builds once the private
   repository's free Actions minutes reset or the repository goes public. Until then, the Action
   at `@v1` runs 1.2.0, which lacks stacked changes, the load-test plan, the drift check and the
   decision table.

Not planned: more validation rounds of the same kind. The record shows where the model stands on
pass/fail. Effort goes to the items above, and new recordings only where one confirms a fix.
