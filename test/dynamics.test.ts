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
