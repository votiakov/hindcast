# Retries at every layer

Scenario: `retries-every-layer` · Episode: `cmp-retries-every-layer`
Render: `npm run record -- cmp-retries-every-layer --theme reference --aspect 4:5`

## Verified numbers (discrete-event engine, 6 seeded runs)

| | A: 3 retries at every layer | B: retry once at the edge, with a budget |
|---|---|---|
| errors during the brownout (DB at 30%, 8–20 s) | 64% | 56% |
| errors after the DB is back (23–40 s) | 99% | 0% |
| p99 after recovery | ~3.5 s | 138 ms |
| database peak load vs restored capacity | above 100% for the rest of the run | normal |

Worst-case amplification with 3 retries at 3 layers: 4 × 4 × 4 = 64 calls per user action.

## LinkedIn post

Count the calls. A user taps "place order". The app retries 3 times on failure. So does the API, and so does the orders service before it gives up on the database. Four attempts at each of three layers is up to 64 calls landing on the database for one tap, and that worst case arrives exactly when the database is struggling.

I ran it in Hindcast: client, API, orders service, Postgres, 800 req/s, then a 10-second brownout where the database drops to 30% of its capacity. Version A retries at every layer. Version B retries only at the client, within a 10% budget, and the inner services time out after 1 s and fail fast.

During the brownout they look similar, 64% vs 56% errors. The retries even feel like they're helping.

Then the database comes back to full capacity. B returns to 0% errors and a 138 ms p99. A sits at 99% errors with a p99 around 3.5 s for the rest of the run, because three layers of retries keep the database above its restored capacity and nothing ever catches up.

The fix is a policy: retry in exactly one place, usually the edge, with a budget and jitter. Inner services set timeouts and fail fast. It feels less safe. It isn't.

The Google SRE book describes this multiplication in its chapter on cascading failures. Seeing it happen on a dashboard is still more convincing than the formula.

## Carousel

1. Hook: "Every layer retries 3 times."
2. The chain: client → API → orders → DB, retries at each hop (A) vs edge only (B).
3. The math slide: 4 × 4 × 4 = 64.
4. Brownout: both hurt, similar error rates.
5. DB restored: B at 0%, A stuck at 99%.
6. Rule: retry in one place, fail fast everywhere else.

## Article outline

- The arithmetic of layered retries; why the worst case lines up with the worst moment.
- The experiment and its two phases (brownout looks fine for A, recovery is where it dies).
- Why fail-fast inner services feel wrong and work better: timeouts propagate failure upward to the one place that can make a budgeted decision.
- Practical policy: retry ownership per call path, retry budgets in shared client libraries, deadline propagation so inner layers don't work on requests the edge already abandoned.
- Limitation: the model has no deadline propagation yet; real systems that pass deadlines downstream do better than A even with inner retries.
