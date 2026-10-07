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
    for (const c of checks) expect(c.pass, `${c.metric}: ${c.note} (${(c.error * 100).toFixed(1)}%)`).toBe(true);
  });

  it('replays every public outage', () => {
    for (const o of OUTAGES) expect(() => replayOutage(model, o, [], { draws: 1 })).not.toThrow();
  });
});
