import { describe, expect, it } from 'vitest';
import { simulate, breakingPoint, compare } from '../src/sim/headless';
import { retryAmp } from '../src/sim/engine';
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

  it('fails over to a replica when the primary dies', () => {
    const sc = { ...steady(400, 40), events: [{ at: 10, action: { type: 'kill-id', id: 'db' } }] };
    const noReplica = simulate(shop, sc);
    const withReplica = simulate(shopWithReplica, sc);
    expect(noReplica.timeline.at(-1)!.errorRate).toBeGreaterThan(0.9);
    expect(withReplica.timeline.at(-1)!.errorRate).toBeLessThan(0.01);
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

describe('retry amplification', () => {
  it('immediate retries amplify load geometrically', () => {
    expect(retryAmp(0, 3, 'immediate')).toBe(1);
    expect(retryAmp(0.5, 3, 'immediate')).toBeCloseTo(1.875);
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
