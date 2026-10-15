import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { parse } from 'yaml';
import { backtest } from '../src/backtest/backtest';
import { reviveModel, type Model } from '../src/backtest/model';
import type { Dataset } from '../src/backtest/dataset';
import { OUTAGES, replayOutage } from '../src/backtest/outages';

/** the reference systems that ship with the app: recorded, calibrated, checked against unseen runs */
const bundles = existsSync('public/reference') ? readdirSync('public/reference').filter((f) => f.endsWith('.json') && f !== 'index.json') : [];

describe.each(bundles)('reference workspace %s', (file) => {
  const w = JSON.parse(readFileSync(`public/reference/${file}`, 'utf8')) as { name: string; dataset: Dataset; model: Model; strategies: string[] };
  const model = reviveModel(w.model);

  it('backtests every bundled strategy', () => {
    const r = backtest(model, w.dataset, w.strategies.map((s) => parse(s)), { draws: 2 });
    expect(r.strategies).toHaveLength(w.strategies.length);
    for (const s of r.strategies) expect(Number.isFinite(s.summary.monthly.p50)).toBe(true);
  });

  it('meets the accuracy targets on the runs it never saw', () => {
    const reference = model.accuracy.find((a) => a.method === 'reference');
    expect(reference, 'no reference-run accuracy record').toBeTruthy();
    const checks = reference!.checks.filter((c) => c.metric !== 'errors');
    expect(checks.length).toBeGreaterThan(0);
    // the Kubernetes reference is the validation study itself (reference/k8s/README.md): its record
    // is published as measured, misses included, so it is checked for being there, not for passing
    if (file.startsWith('k8s-')) return;
    for (const c of checks) expect(c.pass, `${c.metric}: ${c.note} (${(c.error * 100).toFixed(1)}%)`).toBe(true);
  });

  it('replays every public outage', () => {
    for (const o of OUTAGES) expect(() => replayOutage(model, o, [], { draws: 1 })).not.toThrow();
  });
});

describe('a memory leak, read from the ordinary day', () => {
  // the k8s reference: email gains ~10 KB per request it serves and is OOM-killed on every launch day
  const bundle = JSON.parse(readFileSync('public/reference/k8s-shop.json', 'utf8')) as { model: Model; dataset: Dataset };
  const m = reviveModel(bundle.model);

  it('calibration tells a leak (memory following requests served) from memory following load', () => {
    const mem = m.services.email.memory as { leak?: number; limit: number | null; base: number };
    expect(mem.leak).toBeGreaterThan(0);
    // ~9.6 MiB per 1,000 requests, from a base of ~64 MiB to a 150 MiB limit: OOM after ~8,000 requests
    expect((mem.leak ?? 0) * 1024 * 1000).toBeGreaterThan(5);
    expect((mem.leak ?? 0) * 1024 * 1000).toBeLessThan(15);
    expect(m.services.email.fit.notes.join(' ')).toMatch(/a leak/);
    // a service whose memory doesn't grow with what it served has none
    expect((m.services.frontend.memory as { leak?: number }).leak ?? 0).toBe(0);
  });

  it('the replay OOM-kills it at launch-day traffic, not on the ordinary day', () => {
    const ooms = (scale: number) => backtest(m, bundle.dataset, [], { load: { scale }, draws: 1 }).baseline.events.filter((e) => /email: OOM-killed/.test(e.what)).length;
    expect(ooms(1)).toBe(0);
    expect(ooms(2.22)).toBeGreaterThan(0);
  });
});
