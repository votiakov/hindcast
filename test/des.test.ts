import { describe, expect, it } from 'vitest';
import { simulateDes } from '../src/sim/des/des';
import { shop, steady } from './fixtures';

describe('discrete-event engine', () => {
  it('is deterministic per seed', () => {
    const a = simulateDes(shop, steady(600, 10), { seed: 7 });
    const b = simulateDes(shop, steady(600, 10), { seed: 7 });
    expect({ ...a.summary, wallMs: 0 }).toEqual({ ...b.summary, wallMs: 0 });
  });

  it('serves light load with no errors and sane latency', () => {
    const r = simulateDes(shop, steady(400, 15));
    expect(r.summary.meanErrorRate).toBe(0);
    expect(r.summary.p50Ms).toBeGreaterThan(20);
    expect(r.summary.p99Ms).toBeLessThan(300);
  });

  it('agrees with the fluid engine on overload (within a few points)', () => {
    const r = simulateDes(shop, steady(2000, 20));
    const tail = r.timeline.slice(-5);
    const err = tail.reduce((s, x) => s + x.errorRate, 0) / tail.length;
    expect(err).toBeGreaterThan(0.4);
    expect(err).toBeLessThan(0.6);
  });

  it('metastable failure: immediate retries never recover from a spike, a retry budget does', () => {
    const arch = (retryPolicy: string) => ({
      components: [
        { id: 'users', kind: 'client', retries: 3, retryPolicy, timeoutMs: 1000 },
        { id: 'lb', kind: 'lb' },
        { id: 'api', kind: 'server', instances: 4, queueS: 3 },
        { id: 'db', kind: 'db', tier: 'M' },
      ],
      connections: [['users', 'lb'], ['lb', 'api'], ['api', 'db']],
    });
    const sc = { duration: 60, readRatio: 0.8, traffic: [{ at: 0, rps: 700 }, { at: 10, rps: 700 }, { at: 10.1, rps: 1600 }, { at: 16, rps: 1600 }, { at: 16.1, rps: 700 }, { at: 60, rps: 700 }] };
    const tailErr = (r: ReturnType<typeof simulateDes>) => r.timeline.slice(-10).reduce((s, x) => s + x.errorRate, 0) / 10;
    expect(tailErr(simulateDes(arch('immediate'), sc))).toBeGreaterThan(0.5);
    expect(tailErr(simulateDes(arch('budget'), sc))).toBeLessThan(0.05);
  });
});
