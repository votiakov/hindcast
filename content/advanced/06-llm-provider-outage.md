# When your LLM provider goes down

Scenario: `llm-provider-outage` · Episode: `cmp-llm-provider-outage`
Render: `npm run record -- cmp-llm-provider-outage --theme reference --aspect 4:5`

## Verified numbers (discrete-event engine, 6 seeded runs)

| | A: one provider, naive retries | B: failover to provider B + breaker |
|---|---|---|
| errors during the outage (8–26 s) | 98% | 0% |
| p99 during the outage | n/a | ~3.7 s (provider B is slower) |
| p99 before the outage | ~2.8 s | ~2.8 s |
| demand on provider A at peak | ~2× its rate limit (retries) | normal |
| cost over the run | $301/h | $626/h |

Sources: [FailureAtlas (2026)](https://arxiv.org/pdf/2607.17525); [ContinuityBench (2026)](https://arxiv.org/pdf/2607.15899).

## LinkedIn post

If your product calls one LLM API, it depends on something you can't page and can't restart. It goes down on its own schedule.

I ran an outage in Hindcast: 90 AI requests a second, provider A gone for 18 seconds.

Version A uses one provider, and clients retry 3 times immediately. During the outage 98% of requests failed, and the retries pushed demand on provider A to about twice its rate limit while it was already down.

Version B calls provider A first and fails over to provider B, with a circuit breaker so it stops sending traffic to A once A is clearly broken. Errors during the outage: 0%. The price was latency. Provider B is slower in this setup, so p99 went from about 2.8 s to 3.7 s while it carried the load.

The bill looks backwards at first. B cost $626/h over the run and A $301/h, because B kept serving users and paying per request while A served nobody. An outage is cheap if the invoice is the only thing you look at.

Two things the simulation doesn't capture, and they matter more than the numbers. The second provider's model answers differently, so prompts and evals have to cover both. And failover only works if you run it before the day you need it.

FailureAtlas, a 2026 paper on multi-provider LLM serving, catalogs how these systems break. Most of the failure modes are ordinary distributed-systems problems with a new kind of dependency.

## Carousel

1. Hook: "Your AI feature has a single point of failure you don't even run."
2. A: one provider + retries. B: gateway failover + breaker.
3. Outage: A 98% errors, retries double the load on a dead endpoint.
4. B: 0% errors, +0.9 s p99.
5. The backwards bill.
6. What the sim can't show: model differences, untested failover.

## Article outline

- LLM APIs as critical third-party dependencies: rate limits, regional outages, model deprecations.
- The experiment and the numbers, including the cost paradox.
- Gateway design: ordered failover, breakers, budgets, health probes, per-provider prompt variants.
- Testing failover: scheduled provider-kill drills, eval suites run against every provider.
- Limitation: simulation models availability, latency and price; it doesn't model answer quality or stateful sessions.
