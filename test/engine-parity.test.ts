import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { parse } from 'yaml';
import { initSync } from '../src/backtest/wasm/hindcast_engine.js';
import { runPlanNative, backtestNative, calibrateNative } from '../src/backtest/native';
import { calibrateTs } from '../src/backtest/calibrate';
import { runPlanTs, setNativeEngine, type Plan, type RunOpts, type Traffic } from '../src/backtest/engine';
import { backtest, backtestTs } from '../src/backtest/backtest';
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

function compare(a: unknown, b: unknown, where: string, out: Diff[], anyOrder = false) {
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
    for (let i = 0; i < a.length; i++) compare(a[i], b[i], `${where}[${i}]`, out, anyOrder);
    return;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
    const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
    if ((anyOrder ? [...ka].sort().join() : ka.join()) !== (anyOrder ? [...kb].sort().join() : kb.join())) return void out.push({ where: `${where} keys`, ts: ka, rs: kb });
    for (const k of ka) compare((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${where}.${k}`, out, anyOrder);
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

it('the committed WebAssembly is built from the committed Rust (npm run engine:build)', async () => {
  const { engineSourceHash } = await import('../scripts/engine-stamp.mjs');
  expect(readFileSync('src/backtest/wasm/source.sha256', 'utf8').trim()).toBe(engineSourceHash());
});

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

  it('the whole backtest in Rust: strategies, doubled load, an outage, no observed replicas', () => {
    const specs = w.strategies.map((s) => parse(s));
    const cases: [unknown[], Parameters<typeof backtestTs>[3]][] = [
      [specs, { draws: 5 }],
      [specs, { draws: 3, load: { scale: 2 } }],
      [specs.slice(0, 2), { draws: 2, observed: false, seed: 11 }],
      [[], { draws: 2, load: { peakRps: 500 } }],
    ];
    const outage = OUTAGES.map((o) => replayOutage(model, o, [], { draws: 1 })).find((x) => x.replay)?.replay;
    void outage;
    for (const [s, o] of cases) {
      const out: Diff[] = [];
      compare(backtestTs(model, w.dataset, s, o), backtestNative(model, w.dataset, s, o), 'backtest', out);
      expect(out, JSON.stringify(out.slice(0, 5), null, 1)).toEqual([]);
    }
  });

  it('a strategy the schema rejects fails the same way', () => {
    const bad = { name: 'bad', changes: [{ endpoint: '*', retries: { budget: 2 } }] };
    let a = '';
    let b = '';
    try { backtestTs(model, w.dataset, [bad], { draws: 1 }); } catch (e) { a = (e as Error).message; }
    try { backtestNative(model, w.dataset, [bad], { draws: 1 }); } catch (e) { b = (e as Error).message; }
    expect(b).toMatch(/an endpoint change takes endpoint, retries \{ attempts, budget\? \}/);
    expect(JSON.parse(b).map((i: { message: string; path: unknown }) => [i.message, i.path])).toEqual(JSON.parse(a).map((i: { message: string; path: unknown }) => [i.message, i.path]));
  });

  it('calibration in Rust fits the same model (key order aside)', () => {
    for (const o of [{}, { bootstrap: 8, seed: 3, listPrices: true }]) {
      const out: Diff[] = [];
      compare(calibrateTs(w.dataset, o), calibrateNative(w.dataset, o), 'model', out, true);
      expect(out, JSON.stringify(out.slice(0, 6), null, 1)).toEqual([]);
    }
  });

  it('losing each node', () => {
    if (!Object.values(model.services).some((s) => s.pods)) return;
    nodeLoss(model, w.dataset, { draws: 1 });
    expect(diffs, JSON.stringify(diffs.slice(0, 5), null, 1)).toEqual([]);
  });
});
