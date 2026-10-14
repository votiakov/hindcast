import init, * as wasm from './wasm/hindcast_engine.js';
import { initSync, runPlanPacked, backtest as wasmBacktest, calibrate as wasmCalibrate } from './wasm/hindcast_engine.js';
import { setNativeAccuracy, type ReferenceRun, type RequestLog } from './accuracy';
import { setNativeResilience, type NodeLossOptions } from './resilience';
import { setNativeOutages, type Outage, type OutageReplay, type Role } from './outages';
import { setNativeStrategy, type Applied } from './strategy';
import { setNativePlan } from './engine';
import type { AccuracyRecord } from './model';
import type { Num } from './dataset';
import { setNativeSim, type NativeSim } from '../sim/engine';
import { setNativeHeadless } from '../sim/headless';
import { setNativeDes } from '../sim/des/des';
import { setNativeAnalyze } from '../sim/des/analyze';
import { setNativeOptimize } from '../sim/optimize';
import { setNativeAudit } from '../sim/audit';
import { setNativeCalibrate, type CalibrateOptions } from './calibrate';
import { setNativeImport, type ImportResult } from './import/manifest';
import { setNativeConfigDiff } from './configDiff';
import { setNativeTerraform } from './terraformDiff';
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

/** calibration in the compiled engine */
export function calibrateNative(d: Dataset, options: CalibrateOptions = {}): Model {
  return wasmCalibrate(d, options) as Model;
}

export const basePlanNative = (model: Model, observed?: Record<string, Num[] | undefined>): Plan => wasm.basePlan(model, observed) as Plan;
export const applyStrategyNative = (model: Model, base: Plan, input: unknown): Applied => wasm.applyStrategy(model, base, input) as Applied;
export const modelBreakingPointNative = (model: Model, plan?: Plan, opts: { maxRps?: number; steps?: number; holdS?: number } = {}): { rps: number; limitedBy: string | null } => wasm.modelBreakingPoint(model, plan, opts);
export const holdoutAccuracyNative = (d: Dataset, opts: CalibrateOptions & { holdout?: number; requests?: RequestLog } = {}): AccuracyRecord => {
  const { holdout, requests, ...rest } = opts;
  return wasm.holdoutAccuracy(d, rest, holdout, requests) as AccuracyRecord;
};
export const referenceAccuracyNative = (model: Model, runs: ReferenceRun[], label: string): AccuracyRecord => wasm.referenceAccuracy(model, runs, label) as AccuracyRecord;
export const nodeLossNative = (model: Model, d: Dataset, o: NodeLossOptions = {}) => wasm.nodeLoss(model, d, o);
export const nodeLossFaultsNative = (model: Model, d: Dataset, node: string, o: { atS?: number; recoverS?: number | null; pods?: Record<string, Record<string, number>> } = {}) => wasm.nodeLossFaults(model, d, node, o.atS, o.recoverS, o.pods);
export const podsPerNodeNative = (model: Model, strategy?: unknown): Record<string, Record<string, number>> => wasm.podsPerNode(model, strategy);
export const outageScenarioNative = (model: Model, outage: Outage, opts: { baseRps?: number; roles?: Partial<Record<Role, string[]>> } = {}): OutageReplay => {
  const r = wasm.outageScenario(model, outage, opts.baseRps, opts.roles) as OutageReplay;
  // the catalogue entry itself (timeline, sources, assumptions) stays the JavaScript one
  r.outage = outage;
  return r;
};

const use = () => {
  setNativeEngine(runPlanNative);
  setNativeBacktest(backtestNative);
  setNativeCalibrate(calibrateNative);
  setNativeConfigDiff({
    readWorkloads: (docs) => wasm.readWorkloads(docs),
    strategyFromDiff: (before, after, name, known) => wasm.strategyFromDiff(before, after, name, known),
  });
  setNativeTerraform({
    instanceType: (t) => wasm.instanceType(t),
    strategyFromTerraformPlan: (plan, name, known) => wasm.strategyFromTerraformPlan(plan, name, known),
  });
  setNativeImport((m, fs) => {
    return wasm.importBundle(m, fs) as ImportResult;
  });
  setNativePlan({ basePlan: basePlanNative });
  setNativeStrategy({ applyStrategy: applyStrategyNative });
  setNativeAccuracy({ modelBreakingPoint: modelBreakingPointNative, holdoutAccuracy: holdoutAccuracyNative, referenceAccuracy: referenceAccuracyNative });
  setNativeResilience({ nodeLoss: nodeLossNative as never, nodeLossFaults: nodeLossFaultsNative as never, podsPerNode: podsPerNodeNative });
  setNativeOutages({ outageScenario: outageScenarioNative });
  setNativeSim(() => new wasm.SimEngine() as unknown as NativeSim);
  setNativeDes((spec, scenario, cfg) => wasm.simulateDes(spec, scenario, cfg));
  setNativeAnalyze((spec, scenario, opts) => wasm.analyze(spec, scenario, opts));
  setNativeOptimize((spec, scenario, opts) => wasm.optimize(spec, scenario, opts));
  setNativeAudit((spec, o = {}) => {
    const { onProgress, ...opts } = o;
    return wasm.audit(spec, opts, onProgress);
  });
  setNativeHeadless({
    simulate: (spec, scenario, opts) => wasm.simulate(spec, scenario, opts),
    compare: (base, variants, scenario, opts) => wasm.compareVariants(base, variants, scenario, opts),
    breakingPoint: (spec, opts) => wasm.breakingPoint(spec, opts),
    loadCurve: (spec, opts) => wasm.loadCurve(spec, opts),
  });
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
        void wasm;
      }
      use();
      return true;
    } catch (e) {
      console.warn(`(compiled engine not loaded, using the TypeScript one: ${(e as Error).message})`);
      return false;
    }
  })());
}
