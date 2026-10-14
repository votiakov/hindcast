import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { parse } from 'yaml';
import { initSync } from '../src/backtest/wasm/hindcast_engine.js';
import { runPlanNative } from '../src/backtest/native';
import { runPlanTs, setNativeEngine, type Plan, type RunOpts, type Traffic } from '../src/backtest/engine';
import { backtest } from '../src/backtest/backtest';
import { reviveModel, type Model } from '../src/backtest/model';
import type { Dataset } from '../src/backtest/dataset';
import { OUTAGES, replayOutage } from '../src/backtest/outages';
import { nodeLoss } from '../src/backtest/resilience';

/**
 * The Rust engine (engine-rs, WebAssembly) against the TypeScript one, on every replay the product
 * runs for the bundled reference systems: each replay goes through both engines and every series and
 * event must agree. Floating point may differ in the last bits (exp/log/pow implementations), so
 * numbers are compared to a relative 1e-9.
 */
type Diff = { where: string; ts: unknown; rs: unknown };

function compare(a: unknown, b: unknown, where: string, out: Diff[]) {
  if (out.length > 20) return;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return;
    if (a === b) return;
    const tol = 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
    if (!(Math.abs(a - b) <= tol)) out.push({ where, ts: a, rs: b });
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return void out.push({ where: `${where}.length`, ts: a.length, rs: b.length });
    for (let i = 0; i < a.length; i++) compare(a[i], b[i], `${where}[${i}]`, out);
    return;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
    const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
    if (ka.join() !== kb.join()) return void out.push({ where: `${where} keys`, ts: ka, rs: kb });
    for (const k of ka) compare((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${where}.${k}`, out);
    return;
  }
  if (a !== b) out.push({ where, ts: a, rs: b });
}

let runs = 0;
const diffs: Diff[] = [];

beforeAll(() => {
  initSync({ module: readFileSync('src/backtest/wasm/hindcast_engine_bg.wasm') });
  setNativeEngine((plan: Plan, traffic: Traffic, opts: RunOpts) => {
    const ts = runPlanTs(plan, traffic, opts);
    const rs = runPlanNative(plan, traffic, opts);
    runs++;
    compare(ts, rs, 'run', diffs);
    return ts;
  });
});
afterAll(() => setNativeEngine(null));

const bundles = existsSync('public/reference') ? readdirSync('public/reference').filter((f) => f.endsWith('.json') && f !== 'index.json') : [];

describe.each(bundles)('Rust engine matches TypeScript on %s', (file) => {
  const w = JSON.parse(readFileSync(`public/reference/${file}`, 'utf8')) as { dataset: Dataset; model: Model; strategies: string[] };
  const model = reviveModel(w.model);

  it('every bundled strategy, with load scaled up', () => {
    const before = runs;
    backtest(model, w.dataset, w.strategies.map((s) => parse(s)), { draws: 2 });
    backtest(model, w.dataset, w.strategies.map((s) => parse(s)), { draws: 1, load: { scale: 2 } });
    expect(runs).toBeGreaterThan(before);
    expect(diffs, JSON.stringify(diffs.slice(0, 5), null, 1)).toEqual([]);
  });

  it('every public outage', () => {
    for (const o of OUTAGES.slice(0, 6)) replayOutage(model, o, [], { draws: 1 });
    expect(diffs, JSON.stringify(diffs.slice(0, 5), null, 1)).toEqual([]);
  });

  it('losing each node', () => {
    if (!Object.values(model.services).some((s) => s.pods)) return;
    nodeLoss(model, w.dataset, { draws: 1 });
    expect(diffs, JSON.stringify(diffs.slice(0, 5), null, 1)).toEqual([]);
  });
});
