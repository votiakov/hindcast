// Replays two weeks at 60-second buckets through both engines: npx tsx scripts/bench-engine.ts
import { readFileSync } from 'node:fs';
import { basePlan, runPlanTs, type Traffic } from '../src/backtest/engine';
import { initSync } from '../src/backtest/wasm/hindcast_engine.js';
import { runPlanNative } from '../src/backtest/native';
import { reviveModel } from '../src/backtest/model';
import { trafficOf } from '../src/backtest/calibrate';

initSync({ module: readFileSync('src/backtest/wasm/hindcast_engine_bg.wasm') });
for (const file of ['k8s-shop', 'shop']) {
  const w = JSON.parse(readFileSync(`public/reference/${file}.json`, 'utf8'));
  const model = reviveModel(w.model);
  const t0 = trafficOf(w.dataset, model);
  const n = 14 * 24 * 60;
  const traffic: Traffic = { start: t0.start, stepS: 60, n, endpoints: Object.fromEntries(Object.entries(t0.endpoints).map(([k, v]) => [k, Array.from({ length: n }, (_, i) => v[i % v.length] ?? 0)])) };
  const plan = basePlan(model);
  const time = (f: () => unknown) => { const a = performance.now(); f(); return performance.now() - a; };
  time(() => runPlanTs(plan, traffic)); time(() => runPlanNative(plan, traffic));
  const ts = Math.min(time(() => runPlanTs(plan, traffic)), time(() => runPlanTs(plan, traffic)));
  const rs = Math.min(time(() => runPlanNative(plan, traffic)), time(() => runPlanNative(plan, traffic)));
  console.log(`${file}: ${Object.keys(plan.services).length} services, ${Object.keys(plan.endpoints).length} endpoints, ${n} buckets — TypeScript ${ts.toFixed(0)} ms, Rust/WASM ${rs.toFixed(0)} ms (${(ts / rs).toFixed(1)}×)`);
}

// the whole backtest: every strategy of a reference system × 30 draws
{
  const { parse } = await import('yaml');
  const { backtestTs } = await import('../src/backtest/backtest');
  const { backtestNative } = await import('../src/backtest/native');
  const { setNativeEngine } = await import('../src/backtest/engine');
  setNativeEngine(null);
  for (const file of ['k8s-shop', 'shop']) {
    const w = JSON.parse(readFileSync(`public/reference/${file}.json`, 'utf8'));
    const m = reviveModel(w.model);
    const s = w.strategies.map((x: string) => parse(x));
    const t = (f: () => unknown) => { let b = Infinity; for (let i = 0; i < 3; i++) { const a = performance.now(); f(); b = Math.min(b, performance.now() - a); } return b; };
    const ts = t(() => backtestTs(m, w.dataset, s, { draws: 30 }));
    const rs = t(() => backtestNative(m, w.dataset, s, { draws: 30 }));
    console.log(`${file}: backtest of ${s.length} strategies × 30 draws — TypeScript ${ts.toFixed(0)} ms, Rust/WASM ${rs.toFixed(0)} ms (${(ts / rs).toFixed(1)}×)`);
  }
}
