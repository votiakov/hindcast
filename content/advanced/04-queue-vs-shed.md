# Never drop a request? Queue vs shed

Scenario: `queue-vs-shed` · Episode: `cmp-queue-vs-shed`
Render: `npm run record -- cmp-queue-vs-shed --theme reference --aspect 4:5`

## Verified numbers (discrete-event engine, 6 seeded runs)

| | A: deep queue (10 s) | B: admission control + 200 ms queue |
|---|---|---|
| errors during the surge (1,900 req/s, capacity ~1,000) | 98% | ~47% |
| users served per second during the surge | ~40 | ~1,000 |
| p99 of served requests (whole run) | ~970 ms | ~240 ms |
| after traffic returns to 600 req/s | ~14 s still failing every request | fine immediately |

## LinkedIn post

"We never drop a request" sounds like good engineering. Under overload it's how you drop nearly all of them.

The setup in Hindcast: 4 API servers with capacity for about 1,000 req/s, and clients that time out after 1 second. Traffic jumps from 600 to 1,900 req/s for 18 seconds.

A queues everything, up to 10 seconds of work. B admits 950 req/s at the edge and keeps a 200 ms queue behind that.

During the surge A's servers sit at 100% CPU and 98% of requests still fail. Each request waits behind ten seconds of other requests, so by the time it's processed the client has left. The work gets done and nobody receives it.

B rejects about half the surge instantly and serves the rest with a p99 around 240 ms. That's roughly 1,000 users a second getting an answer instead of about 40.

When traffic drops back to 600, B is fine at once. A keeps failing every request for another 14 seconds while it works through a queue full of abandoned requests.

Little's law explains it: time in the queue is queue length divided by throughput. A queue adds latency, never capacity, and once that latency passes your client timeout it becomes errors.

I'd rather tell a user "busy, try again" in 3 ms than send them a correct answer they stopped waiting for 9 seconds ago.

## Carousel

1. Hook: "Never drop a request" is how you drop all of them.
2. Setup: capacity 1,000 req/s, timeout 1 s, surge to 1,900.
3. A: 100% CPU, 98% errors, the queue full of requests nobody's waiting for.
4. B: half rejected fast, half served in ~240 ms.
5. Recovery: A fails for 14 more seconds.
6. Little's law in one line.

## Article outline

- Goodput vs throughput: CPU at 100% doing useless work.
- Little's law with the numbers from the run.
- Why queue limits should be expressed in time (seconds of work), not items.
- Admission control options: rate limits at the edge, concurrency limits, priority-based shedding (keep checkout, shed recommendations).
- Limitation: the model sheds uniformly; priority shedding isn't simulated yet.
