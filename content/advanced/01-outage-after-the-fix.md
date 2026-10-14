# The outage after the fix

Scenario: `outage-after-the-fix` (Compare) · Episode: `cmp-outage-after-the-fix` (Studio)
Render: `npm run record -- cmp-outage-after-the-fix --theme reference --aspect 4:5`

## Verified numbers (discrete-event engine, 6 seeded runs)

| | A: retry immediately at every layer | B: retry budget + admission control |
|---|---|---|
| errors while the store is down (8–20 s) | 100% | 100% |
| errors after the store is back (23–45 s) | 100% | 0% |
| p99 after recovery | n/a (nothing served) | 95 ms |
| cost | $2.57/h | $2.60/h |

Sources: AWS us-east-1 outage, Oct 20 2025 ([technical deep-dive](https://dev.to/harshith_reddy_dev/anatomy-of-a-cloud-collapse-a-technical-deep-dive-on-the-aws-outage-of-october-2025-2mj4)); metastable failures ([Isaacs et al., HotOS 2025](https://sigops.org/s/conferences/hotos/2025/papers/hotos25-106.pdf)).

## LinkedIn post

On October 20, 2025, a race condition in DynamoDB's DNS automation left dynamodb.us-east-1.amazonaws.com with an empty record. AWS had DNS fixed in about two and a half hours. The region took around fifteen to recover.

Most of that outage happened after the root cause was gone. When the record came back, clients and internal services retried at the same moment, the backlog never drained, and AWS had to throttle globally and restart control-plane nodes to get out of it.

I rebuilt a small version of that in Hindcast, the simulator I've been building. The same app twice: 900 req/s, six API servers, a state store that disappears for 12 seconds and then comes back.

Version A does what most HTTP stacks do by default. Clients retry 3 times immediately, the API retries twice more, and each API server keeps a 3-second queue. Version B caps retries at 10% extra load, keeps a 250 ms queue and throttles at the edge.

While the store is gone, both are at 100% errors. No difference.

After it returns, B is back to 0% errors and a 95 ms p99 within seconds. A stays at 100% errors for the rest of the run. Nothing is broken anymore; the servers are busy answering requests whose callers already gave up, and every timeout produces more retries.

Recovery is its own code path, and very few teams design it. Retry budgets, jittered backoff, bounded queues and a throttle you can switch on are cheap to add before the incident and expensive to improvise during one.

This is a model, not AWS. The numbers are mine, the shape is theirs.

## Carousel (Studio stills, 4:5)

1. Hook: "AWS fixed the bug in 2.5 hours. The outage lasted 15."
2. Two systems, same traffic: A retries everywhere with a deep queue; B has a retry budget, short queue, edge throttle.
3. The store disappears: both at 100% errors.
4. The store comes back: B recovers in seconds.
5. A stays down on its own load (retries ×4, queue full of abandoned work).
6. Takeaway card: design the recovery path.

## Article outline

- Open on the timeline: DNS fixed at ~2.5 h, recovery at ~15 h. The gap is the article.
- What a metastable failure is: a trigger pushes the system into a bad state, and a sustaining effect (retries, abandoned work in queues) keeps it there after the trigger is gone. Cite the HotOS 2025 paper.
- The simulation: setup, the 12-second loss, the two recoveries. Show the Compare screenshots.
- Why A never comes back: client timeout 1 s vs queue depth 3 s means every served response is late; each late response triggers up to 4 attempts from the client and more from the API; offered load stays above capacity forever.
- Why B does: budget caps amplification at 1.1×, the 250 ms queue keeps responses inside the timeout, the edge throttle sheds what's left.
- What to change on Monday: retry budgets per client library, queue limits expressed in time not items, a pre-built "global throttle" switch, and a game day that kills a dependency and measures time to recover after it returns.
- Limitation: it's a fluid/discrete-event model with illustrative capacities; the mechanism matches, the absolute numbers don't map to AWS.
