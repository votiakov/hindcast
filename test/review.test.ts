import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { reviveModel, type Model } from '../src/backtest/model';
import type { Dataset } from '../src/backtest/dataset';
import { reviewCapacity } from '../src/backtest/review';
import { StrategySpec } from '../src/backtest/strategy';
import { backtest } from '../src/backtest/backtest';

/** the capacity review the Backtest tab shows, computed in wasm by the same code as review_capacity */
const bundles = existsSync('public/reference') ? readdirSync('public/reference').filter((f) => f.endsWith('.json') && f !== 'index.json') : [];

describe.each(bundles)('capacity review of %s', (file) => {
  const w = JSON.parse(readFileSync(`public/reference/${file}`, 'utf8')) as { dataset: Dataset; model: Model };
  const model = reviveModel(w.model);
  const phases: string[] = [];
  const r = reviewCapacity(model, w.dataset, { draws: 3 }, (label) => phases.push(label));

  it('says the five lines a lead reads first, worded for the app', () => {
    expect(r.summary.map((l) => l.label)).toEqual(expect.arrayContaining(['Risk', 'Headroom', 'Cost', 'Do this', 'Trust']));
    for (const l of r.summary) expect(l.text).not.toMatch(/verify_change|connect_telemetry|calibrate_model/);
    // the Markdown is the report as the CLI writes it, its summary included
    expect(r.markdown).toContain(`# Capacity review — ${r.system}`);
    expect(r.markdown).toContain('**Risk:**');
    expect(phases).toEqual(['headroom', 'busier days', 'losing a node', 'fixes and savings']);
  });

  it('carries the traffic to draw headroom over', () => {
    expect(r.traffic.rps).toHaveLength(w.dataset.n);
    expect(r.traffic.peakRps).toBeCloseTo(Math.max(...r.traffic.rps), 0);
    expect(r.headroom.rps).toBeGreaterThan(0);
    expect(r.busier.map((b) => b.scale)).toEqual([1.5, 2]);
  });

  it('gives every fix and saving a change that backtests in the app', () => {
    const changes = [...r.fixes, ...r.savings].map((x) => x.change);
    if (r.nodeLoss?.fix) changes.push(r.nodeLoss.fix.change);
    if (r.combinedSavings) changes.push(r.combinedSavings.change);
    for (const c of changes) expect(() => StrategySpec.parse(c)).not.toThrow();
    if (changes.length) expect(backtest(model, w.dataset, changes.slice(0, 2), { draws: 1 }).strategies).toHaveLength(Math.min(2, changes.length));
    for (const f of r.fixes) expect(['pass', 'fail', 'inconclusive']).toContain(f.verdict);
  });

  it('says why there is no commitment, where there is none', () => {
    expect(r.commitment !== null || typeof r.commitmentAbsent === 'string').toBe(true);
  });
});

it('words the stuck-caller sensitivity as an assumption when the model marks gRPC calls', () => {
  const w = JSON.parse(readFileSync('public/reference/k8s-shop.json', 'utf8')) as { dataset: Dataset; model: Model & { provenance?: unknown } };
  const model = reviveModel({ ...w.model, provenance: { grpc: { calls: [['frontend', 'cart']] } } } as Model);
  const r = reviewCapacity(model, w.dataset, { draws: 3 });
  const sb = r.nodeLoss?.ifCallersStayBroken;
  expect(sb).toBeTruthy();
  expect(sb!.said).toMatch(/An assumption, not part of the answer above\.$/);
  expect(r.restartRisks?.map((x) => x.service)).toContain('cart');
});
