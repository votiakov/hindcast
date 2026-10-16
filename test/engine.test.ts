import { describe, expect, it } from 'vitest';
import { simulate, breakingPoint, compare } from '../src/sim/headless';
import { DEFAULT_ENGINE_CONFIG, Engine, retryAmp } from '../src/sim/engine';
import { specToGraph } from '../src/spec/convert';
import { shop, shopWithReplica, steady } from './fixtures';
import { PRICING, type PricingId } from '../src/sim/pricing';
import type { Kind } from '../src/sim/catalog';

describe('fluid engine', () => {
  it('serves light load within SLO', () => {
    const r = simulate(shop, steady(300));
    expect(r.summary.meanErrorRate).toBeLessThan(0.001);
    expect(r.summary.sloCompliance).toBeGreaterThan(0.95);
    expect(r.bottlenecks).toHaveLength(0);
  });

  it('drops the excess when offered load exceeds capacity', () => {
    // 4 × 250 req/s API = 1000 req/s; offer 2000
    const r = simulate(shop, steady(2000));
    const tail = r.timeline.slice(-5);
    const err = tail.reduce((s, x) => s + x.errorRate, 0) / tail.length;
    expect(err).toBeGreaterThan(0.4);
    expect(err).toBeLessThan(0.6);
    expect(r.bottlenecks[0].id).toBe('api');
  });

  it('is deterministic without jitter', () => {
    expect(simulate(shop, steady(1200))).toEqual(simulate(shop, steady(1200)));
  });

  it('finds the API fleet as the breaking point near its capacity', () => {
    const bp = breakingPoint(shop);
    expect(bp.limitedBy).toBe('api');
    expect(bp.maxRps).toBeGreaterThan(800);
    expect(bp.maxRps).toBeLessThanOrEqual(1000);
  });

  it('fails over to a replica when the primary dies, a minute later by default', () => {
    const sc = { ...steady(400, 80), events: [{ at: 10, action: { type: 'kill-id', id: 'db' } }] };
    const noReplica = simulate(shop, sc);
    const withReplica = simulate(shopWithReplica, sc);
    expect(noReplica.timeline.at(-1)!.errorRate).toBeGreaterThan(0.9);
    // electing: reads go on to the replica, writes fail
    const electing = withReplica.timeline.find((p) => p.t > 40)!.errorRate;
    expect(electing).toBeGreaterThan(0.05);
    expect(electing).toBeLessThan(0.9);
    expect(withReplica.timeline.at(-1)!.errorRate).toBeLessThan(0.01);
    const fast = { ...shopWithReplica, components: shopWithReplica.components.map((c) => (c.kind === 'db' ? { ...c, failoverS: 5 } : c)) };
    expect(simulate(fast, sc).timeline.find((p) => p.t > 40)!.errorRate).toBeLessThan(0.01);
  });

  it('cost grows with instances', () => {
    const a = simulate(shop, steady(100, 5)).summary.meanCostPerHour;
    const big = { ...shop, components: shop.components.map((c) => (c.id === 'api' ? { ...c, instances: 8 } : c)) };
    const b = simulate(big, steady(100, 5)).summary.meanCostPerHour;
    expect(b).toBeGreaterThan(a);
  });

  it('ranks SLO-meeting variants first in compare', () => {
    const { ranked } = compare(shop, [{ name: 'bigger', changes: [{ op: 'set', id: 'api', fields: { instances: 8 } }] }], steady(1500));
    expect(ranked[0].name).toBe('bigger');
    expect(ranked[0].meetsSlo).toBe(true);
  });
});

import { simulateDes } from '../src/sim/des/des';

describe("a component's peak and mean utilisation", () => {
  // both engines report the load offered over capacity: the shop's 4 × 250/s API offered 2000 req/s is
  // at 200%, and 500 req/s at 50%. (The discrete-event engine reported its pool's busy share, which
  // stops at 100% however far it is overloaded: 131.6% where the fluid engine said 320% on Black Friday)
  it('is the same quantity in both engines', () => {
    for (const [rps, load] of [[2000, 2], [500, 0.5]]) {
      const f = simulate(shop, steady(rps)).components.api;
      const d = simulateDes(shop, steady(rps), { seed: 1 }).components.api;
      expect(f.meanUtil).toBeCloseTo(load, 1);
      expect(Math.abs(d.meanUtil - load)).toBeLessThan(load * 0.05);
      expect(Math.abs(d.peakUtil - f.peakUtil)).toBeLessThan(load * 0.15);
    }
  });
});

describe('a deadline over a fast branch and a slow, failing one', () => {
  // api splits its calls between `fast` and `slow`, with a 200 ms deadline. slow takes 500/s against
  // 100/s: it sheds 400/s and the 100/s it serves wait ~1 s in its queue, past the deadline. So every
  // call to slow fails and every call to fast succeeds: 50% fail. (Lateness weighted by calls instead
  // of by successful answers made fast's answers look half late too: success 0.6 × on time 0.5, so
  // the fluid engine had 68% failing.)
  const spec = {
    components: [{ id: 'users', kind: 'client' }, { id: 'api', kind: 'server', capacity: 1e5, timeoutMs: 200 }, { id: 'fast', kind: 'server', capacity: 1e5, latencyMs: 5 }, { id: 'slow', kind: 'worker', capacity: 100 }],
    connections: [['users', 'api'], ['api', 'fast'], ['api', 'slow']],
  };
  it('half the requests fail, in both engines', () => {
    const f = simulate(spec, { duration: 40, rps: 1000 }).summary.meanErrorRate;
    const d = simulateDes(spec, { duration: 40, rps: 1000 }, { seed: 1 }).summary.meanErrorRate;
    expect(Math.abs(d - 0.5)).toBeLessThan(0.03);
    expect(Math.abs(f - 0.5)).toBeLessThan(0.03);
  });
});

describe('a breaker whose calls fail exactly half the time', () => {
  // one of api's two dependencies answers in 1 s against a 200 ms deadline: half the calls fail, the
  // breaker's threshold. The rate a breaker measures over a window wanders around that, so one window
  // soon measures past it and trips it; with the fallback, few requests fail
  const spec = {
    components: [{ id: 'users', kind: 'client' }, { id: 'api', kind: 'server', capacity: 1e5, timeoutMs: 200, breaker: true, fallback: true }, { id: 'fast', kind: 'server', capacity: 1e5, latencyMs: 5 }, { id: 'slow', kind: 'external', latencyMs: 1000 }],
    connections: [['users', 'api'], ['api', 'fast'], ['api', 'slow']],
  };
  it('trips in both engines', () => {
    const f = simulate(spec, { duration: 60, rps: 300 });
    const d = simulateDes(spec, { duration: 60, rps: 300 }, { seed: 1 });
    expect(f.events.some((e) => e.what.startsWith('breaker-open'))).toBe(true);
    expect(d.events.some((e) => e.what.startsWith('breaker-open'))).toBe(true);
    expect(f.summary.meanErrorRate).toBeLessThan(0.15);
    expect(d.summary.meanErrorRate).toBeLessThan(0.15);
  });
});

describe('a worker that takes calls and also consumes a queue', () => {
  // 60 calls/s and a queue of 60 messages/s, one worker of 100/s. Consumers pull: the queue gets the
  // 40/s the calls leave free and backs up, and the calls are neither dropped nor kept waiting behind
  // the messages (the queue used to push its consumer's whole capacity at it: 160/s against 100/s)
  const spec = {
    components: [{ id: 'users', kind: 'client' }, { id: 'jobs', kind: 'queue' }, { id: 'api', kind: 'function', timeoutMs: 500 }, { id: 'w', kind: 'worker' }],
    connections: [['users', 'jobs'], ['users', 'api'], ['jobs', 'w'], ['api', 'w']],
  };
  it('the calls do not fail in either engine; the queue drains what is left', () => {
    const b = specToGraph(spec);
    const e = new Engine();
    for (let i = 0; i < 40 / 0.05; i++) e.step(b.nodes as never, b.edges as never, 120, 0.8, 0.05, DEFAULT_ENGINE_CONFIG);
    const s = e.snapshot(b.nodes as never, b.edges as never);
    expect(s.global.errorRate).toBeLessThan(0.01);
    expect(s.nodeStats.w.dropRps).toBeLessThan(1);
    expect(s.edgeStats['e-jobs-w'].rps).toBeCloseTo(40, 0);
    expect(simulateDes(spec, { duration: 40, rps: 120 }, { seed: 1 }).summary.meanErrorRate).toBeLessThan(0.01);
  });
});

describe('a worker that consumes two queues', () => {
  // 80 messages/s into each of two queues, one worker of 100/s pulling from both. Together the queues
  // hand it no more than it can work on (100/s, about half each) and back up; the worker drops nothing.
  // Each queue used to drain at the worker's whole capacity: 160/s pushed at a 100/s worker
  const spec = {
    components: [{ id: 'users', kind: 'client' }, { id: 'q1', kind: 'queue' }, { id: 'q2', kind: 'queue' }, { id: 'w', kind: 'worker' }],
    connections: [['users', 'q1'], ['users', 'q2'], ['q1', 'w'], ['q2', 'w']],
  };
  it('shares its capacity between them in both engines', () => {
    const b = specToGraph(spec);
    const e = new Engine();
    for (let i = 0; i < 40 / 0.05; i++) e.step(b.nodes as never, b.edges as never, 160, 0.8, 0.05, DEFAULT_ENGINE_CONFIG);
    const s = e.snapshot(b.nodes as never, b.edges as never);
    expect(s.nodeStats.w.dropRps).toBeLessThan(1);
    expect(s.edgeStats['e-q1-w'].rps + s.edgeStats['e-q2-w'].rps).toBeCloseTo(100, 0);
    expect(s.edgeStats['e-q1-w'].rps).toBeCloseTo(50, 0);
    expect(s.nodeStats.q1.queue).toBeGreaterThan(1000);
    const d = simulateDes(spec, { duration: 40, rps: 160 }, { seed: 1 });
    expect(d.components.w.droppedTotal).toBe(0);
    expect(d.components.w.meanUtil).toBeGreaterThan(0.95);
  });
});

describe('latency of the successful answers, in both engines', () => {
  // the fluid engine's answers pooled over the run (as scripts/engine-crosscheck.ts compares them)
  // against the discrete-event engine's histogram, on boards worked out by hand
  const both = (spec: object, rps: number) => {
    const f = simulate(spec, { duration: 40, rps }, { answers: true });
    const d = simulateDes(spec, { duration: 40, rps }, { seed: 1 }).summary;
    return { f: { ...f.answers!, err: f.summary.meanErrorRate }, d: { p50Ms: d.p50Ms, p99Ms: d.p99Ms, err: d.meanErrorRate } };
  };
  const near = (x: number, want: number, tol: number) => expect(Math.abs(x - want)).toBeLessThanOrEqual(want * tol);

  it('a function: warm answers at its service time, one cold start per environment it starts', () => {
    const fn = { components: [{ id: 'users', kind: 'client' }, { id: 'fn', kind: 'function' }], connections: [['users', 'fn']] };
    // lognormal 35 ms (cv 0.6): p50 = 35 × e^(−σ²/2) = 30 ms. From nothing to 200/s it starts about
    // 200 × (0.4 + 0.035) = 87 environments, each with one cold answer: 1.1% of the run's 8000, so
    // the p99 is a cold one (~435 ms). The fluid engine used to cold-start 200/s × 4 s of them and
    // spread them over every answer: p50 42 ms
    const a = both(fn, 200);
    for (const e of [a.f, a.d]) {
      near(e.p50Ms, 31, 0.1);
      expect(e.p99Ms).toBeGreaterThan(300);
    }
    // at 2000/s the 105 environments of the 3000/s limit fill while they start: the rest of that
    // first ~0.4 s is throttled (1% errors) and the cold answers are 0.13%: the p99 is a warm one,
    // 3.1 × 35 = 109 ms
    const b = both(fn, 2000);
    for (const e of [b.f, b.d]) {
      near(e.p99Ms, 115, 0.1);
      near(e.err, 0.01, 0.3);
    }
  });

  it('an edge: what it answers itself is a mode of its own', () => {
    // half answered at the edge in ~3 ms, half by the server (~25 ms): the p50 is where they meet
    const a = both({ components: [{ id: 'users', kind: 'client' }, { id: 'edge', kind: 'edge' }, { id: 'api', kind: 'server' }], connections: [['users', 'edge'], ['edge', 'api']] }, 200);
    for (const e of [a.f, a.d]) expect(e.p50Ms).toBeLessThan(15);
    near(a.f.p99Ms, a.d.p99Ms, 0.15);
  });

  it('a retry after a shed call costs the time the shed took, not an answer', () => {
    // api (retries 2) splits 600/s between a 100/s worker and storage: the worker sheds two thirds of
    // its calls at once (0.5 ms) and they are retried; its answers wait its 1 s queue. The p99 is
    // one of those, ~1.2 s, in both (the fluid engine used to charge each retry a whole answer's time)
    const a = both({ components: [{ id: 'users', kind: 'client' }, { id: 'api', kind: 'server', capacity: 1e5, retries: 2 }, { id: 'w', kind: 'worker' }, { id: 's', kind: 'storage' }], connections: [['users', 'api'], ['api', 'w'], ['api', 's']] }, 600);
    for (const e of [a.f, a.d]) near(e.p99Ms, 1200, 0.1);
  });

  it("an overloaded pool: its answers wait out the queue's bound, no longer", () => {
    // a 100/s worker offered 300/s: two thirds shed; the rest wait ~1 s (the queue's bound) and are
    // served in 80 ms (p99 3.1 × 80): p50 ≈ 1.05 s, p99 ≈ 1.2 s. The fluid engine used to add the
    // M/M/c wait at 98% load on top of the full backlog: p50 1.3 s, p99 2.6 s
    const a = both({ components: [{ id: 'users', kind: 'client' }, { id: 'w', kind: 'worker' }], connections: [['users', 'w']] }, 300);
    for (const e of [a.f, a.d]) {
      near(e.p50Ms, 1040, 0.06);
      near(e.p99Ms, 1220, 0.06);
    }
  });

  it('the lower half of an answer: none in no time', () => {
    // a cache that hits 40%: the p50 is the server's answers' 17th percentile, lognormal 25 ms ×
    // e^(−σ²/2 − 0.97σ) ≈ 12.5 ms, plus the cache, the wait and the hops: the DES says 16. The fluid
    // shape below the mean was exponential, with far too many answers near zero: p50 12 ms
    const a = both({ components: [{ id: 'users', kind: 'client' }, { id: 'c', kind: 'cache', hitRate: 0.4 }, { id: 'api', kind: 'server' }], connections: [['users', 'c'], ['c', 'api']] }, 100);
    for (const e of [a.f, a.d]) near(e.p50Ms, 16, 0.12);
  });

  it('an answer that needed a retry is a slower mode of its own', () => {
    // storage (lognormal 38 ms, cv 0.3) fails 20% at the end of its work, users retry once: 16 of
    // every 96 answers took two attempts, so the p99 is that mode's 94th percentile, 2 × 38 ms ×
    // (1 + 1.55 × 0.3 / √2) ≈ 101 ms (+ hops). Added to every answer's mean, the retry left the p99 at 76
    const spec = { components: [{ id: 'users', kind: 'client', retries: 1 }, { id: 's', kind: 'storage' }], connections: [['users', 's']] };
    const sc = { duration: 40, rps: 200, events: [{ at: 0, action: { type: 'inject-errors', id: 's', rate: 0.2 } }] };
    const f = simulate(spec, sc, { answers: true }).answers!;
    const d = simulateDes(spec, sc, { seed: 1 }).summary;
    for (const p99 of [f.p99Ms, d.p99Ms]) near(p99, 105, 0.08);
  });
});

describe('retry amplification', () => {
  it('immediate retries amplify load geometrically', () => {
    expect(retryAmp(0, 3, 'immediate')).toBe(1);
    expect(retryAmp(0.5, 3, 'immediate')).toBeCloseTo(1.875);
  });
  it('backoff delays retries without skipping any: as many attempts as immediate retries', () => {
    expect(retryAmp(0.5, 2, 'backoff')).toBeCloseTo(1.75);
    expect(retryAmp(0.5, 2, 'backoff')).toBe(retryAmp(0.5, 2, 'immediate'));
  });
  it('backoff does not save a stalled database from its retries: both engines stay down', () => {
    // users 100/s with a 1 s deadline; a 250/s database with a 10 s queue at 30% from 8 s to 14 s,
    // still about 3 s deep when it recovers. Two retries keep 300 attempts/s arriving, each waits past
    // the deadline and fails, so the queue never drains, delays of 50–300 ms or not. One retry (200/s)
    // drains it. The fluid engine counted 30% of backed-off retries (160/s) and recovered
    const errorsAfter = (retries: number, retryPolicy: string, from = 40) => {
      const spec = { components: [{ id: 'users', kind: 'client', timeoutMs: 1000, retries, retryPolicy }, { id: 'db', kind: 'db', capacity: 250, queueS: 10 }], connections: [['users', 'db']] };
      const sc = { duration: 50, rps: 100, events: [{ at: 8, action: { type: 'degrade', id: 'db', factor: 0.3 } }, { at: 14, action: { type: 'degrade', id: 'db', factor: 1 } }] };
      const worst = (tl: { t: number; errorRate: number }[]) => tl.filter((p) => p.t > from).reduce((m, p) => Math.max(m, p.errorRate), 0);
      return [worst(simulate(spec, sc, { sampleEvery: 1 }).timeline), worst(simulateDes(spec, sc, { seed: 1 }).timeline)];
    };
    for (const e of errorsAfter(2, 'backoff')) expect(e).toBeGreaterThan(0.9);
    for (const e of errorsAfter(2, 'immediate')) expect(e).toBeGreaterThan(0.9);
    for (const e of errorsAfter(1, 'backoff')) expect(e).toBeLessThan(0.01);
    // one immediate retry: the queue (about 450 waiting, 1.8 s) drains at 250 − 200 = 50/s and is
    // under the 1 s deadline by about 18 s (the DES: 19–20 s). A late attempt is retried when its
    // deadline fires, 1 s later: retrying it at once kept the fluid engine down until 24 s
    for (const e of errorsAfter(1, 'immediate', 23)) expect(e).toBeLessThan(0.01);
  });
  it('a retry budget caps extra load at 10%', () => {
    expect(retryAmp(0.9, 3, 'budget')).toBeCloseTo(1.1);
  });
});

import { loadCurve } from '../src/sim/headless';

describe('load curve', () => {
  it('latency rises with load and errors start past capacity', () => {
    const c = loadCurve(shop, { maxRps: 2000, points: 8 });
    expect(c[0].p99Ms).toBeLessThan(c[5].p99Ms);
    expect(c[0].errorRate).toBe(0);
    expect(c[7].errorRate).toBeGreaterThan(0.3);
    // fixed costs amortise: a request is cheaper at higher (healthy) load
    expect(c[3].perMillion).toBeLessThan(c[0].perMillion);
  });
});

describe('pricing profiles', () => {
  it('prices the same design differently per cloud, from cited SKUs', () => {
    const cost = (pricing?: string) => simulate({ ...shop, ...(pricing ? { pricing } : {}) }, steady(300, 5)).summary.meanCostPerHour;
    const aws = cost('aws-us-east-1');
    const gcp = cost('gcp-us-central1');
    expect(aws).toBeGreaterThan(0);
    expect(gcp).toBeGreaterThan(0);
    expect(Math.abs(aws - gcp) / aws).toBeLessThan(0.5); // same ballpark, not identical
    expect(aws).not.toBe(gcp);
    const azure = cost('azure-eastus');
    expect(Math.abs(aws - azure) / aws).toBeLessThan(0.5);
  });

  it('a commitment takes the published rate off what is reserved, and only that', async () => {
    const { commitmentFactor } = await import('../src/sim/pricing');
    for (const id of ['aws-us-east-1', 'gcp-us-central1', 'azure-eastus'] as const)
      for (const c of ['1y', '3y'] as const)
        for (const kind of ['server', 'db', 'cache', 'lb'] as const) {
          const design = (commitment?: string) => ({ pricing: id, ...(commitment ? { commitment } : {}), components: [{ id: 'u', kind: 'client' }, { id: 'x', kind, tier: 'M' }], connections: [['u', 'x']] });
          const od = simulate(design() as never, steady(0, 2)).summary.meanCostPerHour;
          const committed = simulate(design(c) as never, steady(0, 2)).summary.meanCostPerHour;
          expect([id, c, kind, committed]).toEqual([id, c, kind, expect.closeTo(od * commitmentFactor(kind, id, c), 2)]);
        }
  });

  it('the engine charges every fixed price the app shows with its source', () => {
    // one idle component of each kind, size S: the engine's hourly cost is the profile's S (or fixed) price
    for (const id of Object.keys(PRICING) as PricingId[]) {
      for (const [kind, p] of Object.entries(PRICING[id].kinds) as [Kind, NonNullable<(typeof PRICING)[PricingId]['kinds'][Kind]>][]) {
        const hourly = p.tiers?.S.hourly ?? p.fixed?.hourly;
        if (hourly === undefined) continue;
        const design = { pricing: id, components: [{ id: 'u', kind: 'client' }, { id: 'x', kind, tier: 'S', ...(kind === 'stream' ? { partitions: 1 } : {}) }], connections: [['u', 'x']] };
        const got = simulate(design as never, steady(0, 2)).summary.meanCostPerHour;
        expect([id, kind, got]).toEqual([id, kind, expect.closeTo(hourly, 2)]);
      }
    }
  });
});
