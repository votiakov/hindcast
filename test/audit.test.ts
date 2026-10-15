import { describe, expect, it } from 'vitest';
import { audit } from '../src/sim/audit';
import { auditMarkdown } from '../src/sim/auditReport';
import { shop } from './fixtures';

describe('failure audit', () => {
  const r = audit(shop, { rps: 500, incidentCostPerMinute: 1000 });

  it('flags the single database and load balancer as critical', () => {
    const crit = r.findings.filter((f) => f.severity === 'critical').map((f) => f.id);
    expect(crit).toContain('component:db');
    expect(crit).toContain('component:lb');
  });

  it('reports recovery net of the fluid engine\'s smoothing, and says why a slow component sheds', () => {
    // a component that comes back answers at once (the discrete-event engine agrees); only the
    // engine's 0.3 s smoothing chain made it look like 4–5 s
    expect(r.findings.find((f) => f.id === 'component:db')!.impact.recoveryS).toBe(0);
    expect(r.findings.find((f) => f.id === 'component:lb')!.impact.recoveryS).toBe(0);
    expect(r.findings.find((f) => f.id === 'slow:api')!.explanation).toMatch(/busy 11× as long.*sheds the rest/);
  });

  it('absorbs the loss of one instance of a 4-instance fleet', () => {
    expect(r.findings.find((f) => f.id === 'instance:api')!.severity).toBe('ok');
  });

  it('proposes verified, priced fixes', () => {
    const db = r.findings.find((f) => f.id === 'component:db')!;
    expect(db.fixes[0].title).toMatch(/replica/);
    expect(db.fixes[0].monthlyDelta).toBeGreaterThan(0);
    // reads go on to the replica; writes wait out the failover (60 s), longer than the incident
    expect(db.fixes[0].after.severity).toBe('major');
    expect(db.fixes[0].after.errorRate).toBeLessThan(db.impact.errorRate / 2);
    const lb = r.findings.find((f) => f.id === 'component:lb')!;
    expect(lb.fixes[0].after.severity).toBe('ok');
  });

  it('measures headroom against the breaking point', () => {
    expect(r.headroom.limitedBy).toBe('api');
    expect(r.headroom.ratio).toBeGreaterThan(1.4);
    expect(r.headroom.ratio).toBeLessThanOrEqual(2);
  });

  it('prices incidents and renders a report', () => {
    expect(r.findings.find((f) => f.id === 'component:db')!.costAtRisk).toBeGreaterThan(0);
    const md = auditMarkdown(r);
    expect(md).toContain('# Failure audit');
    expect(md).toContain('What breaks first');
  });

  it('a redundant design scores higher', () => {
    const better = audit({
      ...shop,
      components: [...shop.components.map((c) => (c.id === 'api' ? { ...c, instances: 6 } : c)), { id: 'replica', kind: 'replica', tier: 'M' }],
      connections: [...shop.connections, ['db', 'replica']],
    }, { rps: 500, fixes: false });
    expect(better.score).toBeGreaterThan(r.score);
  });
});
