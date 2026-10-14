# The tail at scale

Scenario: `tail-at-scale` · Episode: `cmp-tail-at-scale`
Render: `npm run record -- cmp-tail-at-scale --theme reference --aspect 4:5`

## Verified numbers (discrete-event engine, 6 seeded runs)

| | A: 1 shard per request | B: fan-out to 50 shards |
|---|---|---|
| p50 | 32 ms | 60 ms |
| p99 | ~110 ms (±7) | 276 ms |
| runs keeping p99 under 300 ms | 6 of 6 | 3 of 6 |
| shards | identical: 8 ms typical, 0.8% of calls stall for 200 ms | same |

P(at least one of 50 shards stalls) = 1 − (1 − 0.008)^50 ≈ 33%.

Source: Dean & Barroso, "The Tail at Scale", CACM 2013 ([summary](https://dev.to/speed_engineer/your-average-latency-is-lying-to-you-the-tail-at-scale-43l)); hedged requests ([InfoQ](https://infoq.com/articles/adaptive-hedged-requests-p99-latency)).

## LinkedIn post

Every shard in this system answers in about 8 ms. One call in 125 hits a 200 ms stall, the usual GC pause or compaction. On its own that tail barely shows up in a dashboard.

Now fan each search request out to 50 shards and wait for all of them.

Jeff Dean and Luiz Barroso did the math in "The Tail at Scale": the chance that at least one of 50 shards stalls is 1 − (1 − 0.008)^50, about 33%. One request in three now waits on the slowest shard.

I ran both versions in Hindcast with identical shards and every request simulated, 300 req/s. One shard per request: p50 32 ms, p99 around 110 ms. Fifty shards per request: p50 60 ms, p99 276 ms. In half of the randomized runs the fan-out version couldn't keep p99 under 300 ms.

Same shards, same stall rate. The only change is how many of them each request waits on.

Mean latency per service hides all of this. A scatter-gather endpoint can look healthy service by service while users wait on the 99th percentile of the slowest dependency.

What I'd reach for first is fewer and larger partitions where the data allows it. After that, hedged requests that send a second copy to another replica once the first is slower than the p95. In the paper's BigTable test, hedging cut p99.9 for a 1,000-key read from 1,800 ms to 74 ms with about 2% more requests.

Hedging isn't in the simulator yet, so for now it shows the problem and not that fix.

## Carousel

1. Hook: "Every shard is fast. Your users still wait."
2. One shard: 8 ms, rare 200 ms stall.
3. Fan-out ×50: the 33% math.
4. Results: p99 110 ms vs 276 ms.
5. Why averages lie.
6. Fixes: fewer partitions, tail-aware timeouts, hedging.

## Article outline

- Rare events at scale: per-component tails become per-request medians.
- The simulation (scatter-gather to 50 identical shards) and the percentile table.
- Why dashboards miss it: averages, per-service views, sampling.
- Mitigations with numbers: partitioning, timeouts with partial results, hedged and tied requests (paper's BigTable numbers).
- Limitation: hedging not yet simulated; stall model is a fixed rate and duration.
