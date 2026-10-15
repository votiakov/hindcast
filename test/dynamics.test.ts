import { describe, expect, it } from 'vitest';
import { simulate } from '../src/sim/headless';
import { simulateDes } from '../src/sim/des/des';
import { shop, steady } from './fixtures';

const autoscaled = (warmupS: number) => ({
  components: [
    { id: 'users', kind: 'client' },
    { id: 'lb', kind: 'lb' },
    { id: 'api', kind: 'server', instances: 2, autoscale: { min: 2, max: 12, targetUtil: 0.6, warmupS, cooldownS: 20 } },
    { id: 'db', kind: 'db', tier: 'L' },
  ],
  connections: [['users', 'lb'], ['lb', 'api'], ['api', 'db']],
});
const ramp = { duration: 120, readRatio: 0.8, traffic: [{ at: 0, rps: 300 }, { at: 20, rps: 300 }, { at: 25, rps: 1500 }, { at: 80, rps: 1500 }, { at: 85, rps: 300 }, { at: 120, rps: 300 }] };

describe('autoscaling', () => {
  for (const [name, run] of [['fluid', simulate], ['des', simulateDes]] as const) {
    it(`${name}: scales out to absorb a surge, then back in`, () => {
      const r = run(autoscaled(10), ramp);
      const at = (t: number) => r.timeline.find((x) => x.t >= t)!;
      expect(at(15).costPerHour).toBeLessThan(at(70).costPerHour); // more instances billed at peak
      expect(at(70).errorRate).toBeLessThan(0.02); // caught up
      expect(at(119).costPerHour).toBeLessThan(at(70).costPerHour); // scaled back in
      expect(r.events.some((e) => e.what.startsWith('scale-out'))).toBe(true);
    });
  }

  it('slow warm-up costs errors during the surge', () => {
    const fast = simulate(autoscaled(5), ramp).summary;
    const slow = simulate(autoscaled(60), ramp).summary;
    expect(slow.failedRequests).toBeGreaterThan(fast.failedRequests * 3);
  });
});

const cached = {
  components: [
    { id: 'users', kind: 'client' },
    { id: 'lb', kind: 'lb' },
    { id: 'api', kind: 'server', instances: 8 },
    { id: 'redis', kind: 'cache', hitRate: 0.9, warmupS: 15 },
    { id: 'db', kind: 'db' },
  ],
  connections: [['users', 'lb'], ['lb', 'api'], ['api', 'redis'], ['redis', 'db']],
};

describe('cache warmth', () => {
  for (const [name, run] of [['fluid', simulate], ['des', simulateDes]] as const) {
    it(`${name}: a flushed cache stampedes the database, then recovers`, () => {
      const r = run(cached, { ...steady(1500, 90), events: [{ at: 20, action: { type: 'flush-cache', id: 'redis' } }] });
      const at = (t: number) => r.timeline.find((x) => x.t >= t)!;
      expect(at(18).errorRate).toBeLessThan(0.01);
      const surge = Math.max(...r.timeline.filter((x) => x.t > 20 && x.t < 30).map((x) => x.errorRate));
      expect(surge).toBeGreaterThan(0.08); // db suddenly sees ~10× the reads
      expect(at(89).errorRate).toBeLessThan(0.02);
    });
  }
});

describe('gray failures', () => {
  for (const [name, run] of [['fluid', simulate], ['des', simulateDes]] as const) {
    it(`${name}: injected errors and latency show up end to end`, () => {
      const errs = run(shop, { ...steady(300, 30), events: [{ at: 10, action: { type: 'inject-errors', id: 'db', rate: 0.3 } }] });
      expect(errs.timeline.at(-1)!.errorRate).toBeGreaterThan(0.2);
      const slow = run(shop, { ...steady(300, 30), events: [{ at: 10, action: { type: 'inject-latency', id: 'db', ms: 200 } }] });
      expect(slow.timeline.at(-1)!.p99Ms).toBeGreaterThan(200);
    });
  }
});

describe('link latency', () => {
  it('a cross-region hop adds its round trip to every request', () => {
    const near = simulateDes(shop, steady(200, 10)).summary.p50Ms;
    const far = { ...shop, connections: [['users', 'lb'], ['lb', 'api'], { from: 'api', to: 'db', latencyMs: 80 }] };
    const farP50 = simulateDes(far, steady(200, 10)).summary.p50Ms;
    expect(farP50 - near).toBeGreaterThan(70);
    expect(farP50 - near).toBeLessThan(95);
    const fluidNear = simulate(shop, steady(200, 10)).timeline.at(-1)!.p99Ms;
    const fluidFar = simulate(far, steady(200, 10)).timeline.at(-1)!.p99Ms;
    expect(fluidFar).toBeGreaterThanOrEqual(fluidNear + 79.5);
  });
});

describe('threads and bulkheads', () => {
  // half the requests call a payment API that has slowed to 2 s; the api has 2 × 50 threads
  const slow = (api: Record<string, unknown>) => ({
    components: [
      { id: 'users', kind: 'client' },
      { id: 'lb', kind: 'lb' },
      { id: 'api', kind: 'server', instances: 2, threads: 50, ...api },
      { id: 'db', kind: 'db' },
      { id: 'pay', kind: 'external', latencyMs: 2000, limit: 5000 },
    ],
    connections: [['users', 'lb'], ['lb', 'api'], ['api', 'db'], ['api', 'pay']],
  });
  const both = (spec: unknown) => ({ fluid: simulate(spec as never, steady(400, 40)).summary.meanErrorRate, des: simulateDes(spec, steady(400, 40), { seed: 2 }) });

  it('a slow dependency holds every thread, and the requests that never touch it fail too', () => {
    const { fluid, des } = both(slow({}));
    // only half call the slow API, yet most fail: the rest find no free thread
    expect(fluid).toBeGreaterThan(0.6);
    expect(des.summary.meanErrorRate).toBeGreaterThan(0.6);
    expect(Math.abs(fluid - des.summary.meanErrorRate)).toBeLessThan(0.1);
    expect(des.failures[0]).toMatchObject({ id: 'api', reason: 'out of threads (all waiting on calls)' });
    expect(des.bottlenecks[0].note).toMatch(/^Out of threads/);
  });

  it('a bulkhead loses only the slow dependency’s calls, and the rest stay fast', () => {
    const { fluid, des } = both(slow({ bulkhead: 10 }));
    expect(fluid).toBeLessThan(0.52);
    expect(des.summary.meanErrorRate).toBeLessThan(0.52);
    expect(des.failures[0].reason).toMatch(/^bulkhead full/);
    expect(des.summary.p50Ms).toBeLessThan(100);
  });

  it('a bulkhead spares the slow dependency too: what it refuses never reaches it, in both engines', () => {
    const spec = slow({ bulkhead: 10 });
    const fluidPay = simulate(spec as never, steady(400, 40)).components.pay.meanUtil;
    const desPay = simulateDes(spec, steady(400, 40), { seed: 2 }).components.pay.meanUtil;
    const unprotected = simulate(slow({}) as never, steady(400, 40)).components.pay.meanUtil;
    // 2 × 10 calls in flight at 2 s each: ~10 calls a second reach it, not ~200
    expect(fluidPay).toBeLessThan(unprotected * 0.25);
    expect(Math.abs(fluidPay - desPay)).toBeLessThan(Math.max(fluidPay, desPay) * 0.5 + 1e-3);
  });

  it('a timeout gives the threads back sooner', () => {
    const { fluid, des } = both(slow({ timeoutMs: 300 }));
    expect(fluid).toBeLessThan(0.6);
    expect(des.summary.meanErrorRate).toBeLessThan(0.6);
  });

  it('asynchronous servers (no threads) are unaffected by how long their calls take', () => {
    const spec = slow({});
    delete (spec.components[2] as Record<string, unknown>).threads;
    const { fluid } = both(spec);
    // the payment calls succeed, slowly; nothing else fails
    expect(fluid).toBeLessThan(0.02);
  });
});

describe('provisioned concurrency', () => {
  // a Java function (1.8 s cold starts) hit by a burst
  const fn = (extra: Record<string, unknown>) => ({
    pricing: 'aws-us-east-1',
    components: [
      { id: 'u', kind: 'client' },
      { id: 'fn', kind: 'function', runtime: 'java', ...extra },
    ],
    connections: [['u', 'fn']],
  });
  const burst = { duration: 30, traffic: [{ at: 0, rps: 20 }, { at: 10, rps: 20 }, { at: 11, rps: 400 }, { at: 30, rps: 400 }] };

  it('keeps executions warm through a burst, and bills them by the hour', () => {
    const cold = simulateDes(fn({}), burst, { seed: 4 });
    const warm = simulateDes(fn({ provisioned: 100 }), burst, { seed: 4 });
    // the burst's worst second: cold starts (1.8 s for Java) vs warm executions
    expect(cold.summary.peakP99Ms).toBeGreaterThan(1000);
    expect(warm.summary.peakP99Ms).toBeLessThan(300);
    expect(simulate(fn({}) as never, burst as never).summary.peakP99Ms).toBeGreaterThan(1000);
    expect(simulate(fn({ provisioned: 100 }) as never, burst as never).summary.peakP99Ms).toBeLessThan(300);
    // 100 × 0.5 GB × $0.0000041667 per GB-s × 3600 = $0.75/h on top
    expect(warm.summary.meanCostPerHour - cold.summary.meanCostPerHour).toBeCloseTo(0.75, 1);
    const f = simulate(fn({ provisioned: 100 }) as never, burst as never);
    expect(f.summary.meanCostPerHour - simulate(fn({}) as never, burst as never).summary.meanCostPerHour).toBeCloseTo(0.75, 1);
  });
});

describe('a cut link', () => {
  const spec = {
    components: [
      { id: 'u', kind: 'client' },
      { id: 'lb', kind: 'lb' },
      { id: 'a', kind: 'server' },
      { id: 'b', kind: 'server' },
      { id: 'db', kind: 'db' },
    ],
    connections: [['u', 'lb'], ['lb', 'a'], ['lb', 'b'], ['a', 'db'], ['b', 'db']],
  };
  // a loses its way to the database for 10 s; b still reaches it
  const sc = { duration: 30, rps: 200, events: [{ at: 10, action: { type: 'cut-link', from: 'a', to: 'db' } }, { at: 20, action: { type: 'heal-link', from: 'a', to: 'db' } }] };

  it('fails only the calls over it, in both engines, and heals', () => {
    const des = simulateDes(spec, sc, { seed: 5 });
    const fluid = simulate(spec as never, sc as never).summary.meanErrorRate;
    // half the traffic goes through a, for a third of the run
    for (const e of [des.summary.meanErrorRate, fluid]) {
      expect(e).toBeGreaterThan(0.08);
      expect(e).toBeLessThan(0.3);
    }
    expect(des.failures[0]).toMatchObject({ id: 'db', reason: 'unreachable (network partition)' });
    expect(des.timeline.at(-1)!.errorRate).toBe(0);
  });
});

describe('object storage prefixes', () => {
  const store = (extra: Record<string, unknown>) => ({ components: [{ id: 'u', kind: 'client' }, { id: 's3', kind: 'storage', ...extra }], connections: [['u', 's3']] });
  const errs = (spec: unknown, rps: number, readRatio = 1) => {
    const sc = { duration: 20, rps, readRatio };
    return { fluid: simulate(spec as never, sc as never).summary.meanErrorRate, des: simulateDes(spec, sc, { seed: 6 }).summary.meanErrorRate };
  };

  it('a prefix takes 5,500 reads a second, however big the bucket', () => {
    const one = errs(store({ prefixes: 1 }), 5000);
    expect(one.fluid).toBeLessThan(0.01);
    expect(one.des).toBeLessThan(0.01);
    const over = errs(store({ prefixes: 1 }), 7000);
    expect(over.fluid).toBeCloseTo(1 - 5500 / 7000, 1);
    expect(over.des).toBeCloseTo(1 - 5500 / 7000, 1);
  });

  it('writes cost more: 3,500 a second', () => {
    const w = errs(store({ prefixes: 1 }), 4000, 0);
    expect(w.fluid).toBeCloseTo(1 - 3500 / 4000, 1);
    expect(w.des).toBeCloseTo(1 - 3500 / 4000, 1);
  });

  it('a hot prefix throttles while the others idle', () => {
    // 30% on one of 10 prefixes: it gets 37% of 20,000/s = 7,400/s against 5,500
    const hot = errs(store({ hotKeyShare: 0.3 }), 20000);
    for (const e of [hot.fluid, hot.des]) expect(e).toBeCloseTo((7400 - 5500) / 20000, 1);
    const spread = errs(store({}), 20000);
    expect(spread.fluid).toBeLessThan(0.01);
  });
});

describe('a hot row', () => {
  // every order updates one stock counter: 30% of the writes on one key
  const spec = (h: number) => ({ components: [{ id: 'u', kind: 'client' }, { id: 'db', kind: 'db', tier: 'L', ...(h ? { hotRowShare: h } : {}) }], connections: [['u', 'db']] });
  const run = (h: number) => {
    const sc = { duration: 30, rps: 1000, readRatio: 0.5 };
    return { fluid: simulate(spec(h) as never, sc as never).summary.meanErrorRate, des: simulateDes(spec(h), sc, { seed: 8 }) };
  };

  it('serialises its writes: one at a time, however big the database', () => {
    expect(run(0).fluid).toBeLessThan(0.01);
    // 500 writes/s, 30% on one row = 150/s against a lock that passes ~100/s
    const hot = run(0.3);
    for (const e of [hot.fluid, hot.des.summary.meanErrorRate]) {
      expect(e).toBeGreaterThan(0.02);
      expect(e).toBeLessThan(0.1);
    }
    expect(hot.des.bottlenecks[0].note).toMatch(/^Hot row/);
  });
});

describe('a gateway’s burst', () => {
  const spec = (burst?: number) => ({ components: [{ id: 'u', kind: 'client' }, { id: 'gw', kind: 'gateway', limit: 1000, ...(burst ? { burst } : {}) }, { id: 'api', kind: 'server', instances: 20 }], connections: [['u', 'gw'], ['gw', 'api']] });
  // 5 s at 1,800/s over a 1,000/s limit: 4,000 requests above the rate (long enough for the fluid
  // engine, which smooths over fractions of a second, to see it whole)
  const sc = { duration: 25, traffic: [{ at: 0, rps: 500 }, { at: 9.9, rps: 500 }, { at: 10, rps: 1800 }, { at: 15, rps: 1800 }, { at: 15.1, rps: 500 }, { at: 25, rps: 500 }] };
  const failed = (spec: unknown) => ({ fluid: simulate(spec as never, sc as never).summary, des: simulateDes(spec, sc, { seed: 9 }).summary });

  it('a bucket of 5,000 lets a short burst through; one second of the limit does not', () => {
    const big = failed(spec(5000));
    const small = failed(spec());
    for (const r of [big.fluid, big.des]) expect(r.meanErrorRate).toBeLessThan(0.01);
    // ~3,000 of ~17,000 requests fail without the burst
    for (const r of [small.fluid, small.des]) expect(r.meanErrorRate).toBeGreaterThan(0.12);
  });
});

describe('a queue’s redrive policy', () => {
  // a consumer that fails 30% of the messages it takes (a flaky downstream)
  const spec = (q: Record<string, unknown>) => ({
    components: [
      { id: 'u', kind: 'client' },
      { id: 'q', kind: 'queue', ...q },
      { id: 'w', kind: 'worker', instances: 6 },
    ],
    connections: [['u', 'q'], ['q', 'w']],
  });
  const sc = { duration: 120, rps: 200, events: [{ at: 0, action: { type: 'inject-errors', id: 'w', rate: 0.3 } }] };

  it('retries what the consumer fails, and dead-letters only what fails every time', async () => {
    const { jobErrorRate } = await import('../src/lessons/verify');
    const { Engine, DEFAULT_ENGINE_CONFIG } = await import('../src/sim/engine');
    const { specToGraph } = await import('../src/spec/convert');
    // fluid: step the board, then read the job loss the lessons use
    const loss = (q: Record<string, unknown>) => {
      const g = specToGraph(spec(q));
      const sys = g.nodes.filter((n) => n.type === 'system').map((n) => (n.id === 'w' ? { ...n, data: { ...n.data, faultRate: 0.3 } } : n)) as never[];
      const e = new Engine();
      for (let t = 0; t < 120; t += 0.05) e.step(sys, g.edges, 200, 0.8, 0.05, DEFAULT_ENGINE_CONFIG);
      return jobErrorRate(sys, g.edges, e.snapshot(sys, g.edges).nodeStats);
    };
    expect(loss({})).toBeCloseTo(0.3, 1);
    expect(loss({ maxReceives: 3, visibilityS: 5 })).toBeCloseTo(0.027, 2);
    // the DES counts each dead letter
    const des = simulateDes(spec({ maxReceives: 3, visibilityS: 5 }), sc, { seed: 11 });
    expect(des.summary.deadLetters! / des.summary.requests).toBeCloseTo(0.027, 2);
    // the retries are load: ~1.39 receives per message
    const w = des.components.w;
    expect(w.meanUtil).toBeGreaterThan(simulateDes(spec({}), sc, { seed: 11 }).components.w.meanUtil * 1.25);
    expect(simulateDes(spec({}), sc, { seed: 11 }).summary.deadLetters ?? 0).toBe(0);
  });
});

describe('a connection limit', () => {
  // each request holds a connection for 10 s (a streamed answer); 1,000 connections at most
  const spec = { components: [{ id: 'u', kind: 'client' }, { id: 'gw', kind: 'gateway', limit: 100000, maxConnections: 1000, connectionS: 10 }, { id: 'api', kind: 'server', instances: 4 }], connections: [['u', 'gw'], ['gw', 'api']] };
  const refused = (rps: number) => {
    const sc = { duration: 120, rps };
    return { fluid: simulate(spec as never, sc as never).summary.meanErrorRate, des: simulateDes(spec, sc, { seed: 12 }).summary.meanErrorRate };
  };

  it('refuses what Erlang B says: a little at the limit, the excess well past it', () => {
    // offered 1,000 connections against 1,000: Erlang B ≈ 2.5%
    const at = refused(100);
    expect(at.fluid).toBeCloseTo(0.025, 2);
    expect(at.des).toBeGreaterThan(0.01);
    expect(at.des).toBeLessThan(0.05);
    // 1,500 offered: about a third refused
    const over = refused(150);
    for (const e of [over.fluid, over.des]) {
      expect(e).toBeGreaterThan(0.28);
      expect(e).toBeLessThan(0.38);
    }
    expect(refused(50).fluid).toBeLessThan(0.001);
  });
});

describe('a scheduled job', () => {
  // users read from the database; every 60 s a batch job sends it 6,000 requests over 10 s
  const spec = (job: boolean) => ({
    components: [
      { id: 'users', kind: 'client' },
      ...(job ? [{ id: 'export', kind: 'client', everyS: 60, batch: 6000, batchS: 10 }] : []),
      { id: 'db', kind: 'db' },
    ],
    connections: [['users', 'db'], ...(job ? [['export', 'db']] : [])],
  });
  const sc = { duration: 120, rps: 600 };

  it('takes no share of the users’ traffic, and fails the users while it runs', () => {
    for (const r of [simulate(spec(false) as never, sc as never).summary, simulateDes(spec(false), sc, { seed: 13 }).summary]) expect(r.meanErrorRate).toBeLessThan(0.01);
    // 600 + 600 req/s against ~1,000 for 10 s of every 60: the users lose some of theirs
    const fluid = simulate(spec(true) as never, sc as never).summary;
    const des = simulateDes(spec(true), sc, { seed: 13 }).summary;
    for (const r of [fluid, des]) {
      expect(r.meanErrorRate).toBeGreaterThan(0.01);
      expect(r.meanErrorRate).toBeLessThan(0.2);
      // the users' requests only: 600 req/s for 120 s
      expect(r.requests).toBeGreaterThan(600 * 110);
      expect(r.requests).toBeLessThan(600 * 130);
    }
  });
});
