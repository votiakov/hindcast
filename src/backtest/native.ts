import init, { initSync, runPlanPacked, backtest as wasmBacktest } from './wasm/hindcast_engine.js';
import { setNativeEngine, type Plan, type RunOpts, type RunResult, type Traffic } from './engine';
import { setNativeBacktest, type BacktestOptions, type BacktestResult } from './backtest';
import type { Model } from './model';
import type { Dataset } from './dataset';

/**
 * Loads the compiled replay engine (engine-rs, built to WebAssembly by `npm run engine:build`) and
 * makes runPlan use it. Same replay, same numbers as the TypeScript engine (test/engine-parity),
 * several times faster. HINDCAST_ENGINE=ts keeps the TypeScript one.
 */
let loading: Promise<boolean> | null = null;

/** the replay in the compiled engine; the long series cross as one Float64Array each way */
export function runPlanNative(plan: Plan, traffic: Traffic, opts: RunOpts = {}): RunResult {
  const n = traffic.n;
  const epIds = Object.keys(plan.endpoints).filter((id) => traffic.endpoints[id]);
  const svcIds = Object.keys(plan.services);
  let size = epIds.length * n;
  const observed: [string, number, number][] = [];
  for (const id of svcIds) {
    const o = plan.services[id].observedReplicas;
    if (o) observed.push([id, size, o.length]), (size += o.length);
  }
  const series = new Float64Array(size);
  epIds.forEach((id, k) => {
    const v = traffic.endpoints[id];
    for (let i = 0; i < n; i++) series[k * n + i] = v[i] ?? 0;
  });
  for (const [id, off, len] of observed) {
    const o = plan.services[id].observedReplicas!;
    for (let i = 0; i < len; i++) series[off + i] = o[i] ?? NaN;
  }
  const services = Object.fromEntries(svcIds.map((id) => [id, plan.services[id].observedReplicas ? { ...plan.services[id], observedReplicas: undefined } : plan.services[id]]));
  const [data, events] = runPlanPacked({ ...plan, services }, { start: traffic.start, stepS: traffic.stepS, n }, epIds, observed, series, opts) as [Float64Array, RunResult['events']];
  let c = 0;
  const take = () => Array.from(data.subarray(c, (c += n)));
  const out: RunResult = { t: take(), rps: take(), errorRate: take(), p99Ms: take(), costPerHour: take(), cost: { compute: take(), requests: take(), transfer: take(), other: take() }, services: {}, endpoints: {}, events };
  for (const id of svcIds) {
    out.services[id] = { rps: take(), util: take(), replicas: take(), waitMs: take(), selfMeanMs: take(), selfP99Ms: take(), backlog: take(), cpuCores: take() };
    if (plan.services[id].memory && n > 0) out.services[id].oomDown = take();
  }
  for (const id of epIds) out.endpoints[id] = { rps: take(), errorRate: take(), meanMs: take(), p99Ms: take(), p50Ms: take(), cost: take() };
  if (plan.cluster) out.cluster = { nodes: take(), requestedCpu: take(), requestedMemoryGb: take() };
  return out;
}

/** the whole backtest in the compiled engine: one crossing for every draw of every strategy */
export function backtestNative(model: Model, d: Dataset, strategies: unknown[], opts: BacktestOptions = {}): BacktestResult {
  const r = wasmBacktest(model, d, strategies, opts) as BacktestResult;
  r.accuracy = model.accuracy;
  return r;
}

const use = () => {
  setNativeEngine(runPlanNative);
  setNativeBacktest(backtestNative);
};

const wanted = () => typeof process === 'undefined' || process.env?.HINDCAST_ENGINE !== 'ts';

/** in Node (CLI, MCP server, workers, tests): synchronous, from the file next to this module */
export async function loadNativeEngine(): Promise<boolean> {
  if (!wanted()) return false;
  return (loading ??= (async () => {
    try {
      if (typeof window === 'undefined' && typeof process !== 'undefined' && process.versions?.node) {
        const { readFileSync } = await import('node:fs');
        initSync({ module: readFileSync(new URL('./wasm/hindcast_engine_bg.wasm', import.meta.url)) });
      } else {
        await init();
      }
      use();
      return true;
    } catch (e) {
      console.warn(`(compiled engine not loaded, using the TypeScript one: ${(e as Error).message})`);
      return false;
    }
  })());
}
