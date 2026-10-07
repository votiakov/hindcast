# Analysis: Monte Carlo, breaking point, optimizer

## Monte Carlo (`src/sim/des/analyze.ts`)

`analyze(spec, scenario, { runs, seed })` runs the discrete-event engine `runs` times with seeds
`seed + i × 7919` and aggregates:

- **metrics** — error rate, peak error rate, p50, p99, p99.9, time-in-SLO, cost — each as
  `{ mean, ci95, min, max }`, where `ci95` is the half-width of the 95 % confidence interval of the
  mean (Student-t for small samples).
- **pSloMet** — share of runs that stayed within SLO ≥ 99 % of the time. The most decision-ready
  number: "this design holds the SLO in 100 % of 24 runs" vs "in 40 %".
- **bottlenecks** — how often each component was the #1 bottleneck, with its explanation.

Runners:

| runner | where | parallelism |
|---|---|---|
| `analyze` | anywhere | sequential |
| `analyzeParallel` (`nodePool.ts`) | CLI, MCP | worker threads (cores − 1); each thread bootstraps `tsx`; falls back to in-process |
| `analyzeInBrowser` (`browserPool.ts`) | app Analysis panel | web workers (≤ 6) |

All three give identical results for the same seeds. Typical cost: a 60 s scenario at ~1 k req/s is
~0.4 M events ≈ 0.1–0.2 s per run.

## Breaking point (`breakingPoint` in `src/sim/headless.ts`)

Highest constant load that stays within SLO at steady state (mean of the last 5 s of a 25 s fluid
run). Exponential search from 50 req/s doubling until the SLO breaks, then binary search to within
1 %. Returns `maxRps`, `firstFailingRps` and the limiting component with its explanation.

## Cost optimizer (`src/sim/optimize.ts`)

Finds the cheapest sizing of the **existing topology** that meets the SLO under a scenario. It never
adds or removes components — proposing a cache or a queue is a design decision; the optimizer then
sizes it. Knobs: instances (scalable kinds), tiers (sizable kinds) and, optionally, runtimes.

1. **Grow** while the SLO is missed: try every grow move (instances +15 % (≥ 1), tier up, faster
   runtime) on components that are hot (peak utilisation ≥ 60 %, drops, or down), evaluate each with
   the fluid engine, and apply the move with the best *quality gain per extra $/h*
   (quality = time-in-SLO × 1000 − errors × 100 − p99/1000). Stops when the SLO is met or nothing helps
   (then it reports structural blockers, e.g. "put a load balancer in front of api").
2. **Shrink** once the SLO is met: repeatedly try instances −1 / tier down anywhere and keep any
   change that still meets the SLO and is cheaper. This is what cuts over-provisioned bills.
3. **Verify** with discrete-event Monte Carlo (default 10 runs; 6 in the app).

Output: feasibility, before/after cost (hourly and monthly), monthly savings, the exact changes as a
variant (`[{ op: set, id, fields }]`), a step log, verification, and the number of simulations run.

Example (over-provisioned web shop at 1,200 req/s): $4,789 → $1,161 per month, SLO met in 100 % of
verification runs, 40 simulations, ~1.3 s.

Tips:

- Put the failures you must survive into the scenario (e.g. kill the busiest server at peak) — the
  optimizer then sizes for N+1 instead of the bare minimum.
- Search uses the fluid engine, which is pessimistic near saturation; verification uses the DES.
  If verification passes comfortably, a further manual shrink may still hold.
