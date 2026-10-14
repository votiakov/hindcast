/* tslint:disable */
/* eslint-disable */
/**
 * runPlan(plan, traffic, opts) → RunResult, as plain JS objects
 */
export function runPlan(plan: any, traffic: any, opts: any): any;
/**
 * backtest(model, dataset, strategies, opts) → BacktestResult (src/backtest/backtest.ts)
 */
export function backtest(model: any, dataset: any, strategies: any, opts: any): any;
/**
 * calibrate(dataset, options) → Model (src/backtest/calibrate.ts)
 */
export function calibrate(dataset: any, options: any): any;
/**
 * basePlan(model, observed?) → Plan
 */
export function basePlan(model: any, observed: any): any;
/**
 * applyStrategy(model, plan, spec) → { plan, notes }
 */
export function applyStrategy(model: any, plan: any, spec: any): any;
/**
 * modelBreakingPoint(model, plan?, opts?) → { rps, limitedBy }
 */
export function modelBreakingPoint(model: any, plan: any, opts: any): any;
/**
 * holdoutAccuracy(dataset, opts) → AccuracyRecord
 */
export function holdoutAccuracy(dataset: any, opts: any, holdout: number | null | undefined, requests: any): any;
/**
 * referenceAccuracy(model, runs, label) → AccuracyRecord
 */
export function referenceAccuracy(model: any, runs: any, label: string): any;
/**
 * nodeLoss(model, dataset, opts) → the node-loss report
 */
export function nodeLoss(model: any, dataset: any, opts: any): any;
/**
 * nodeLossFaults(model, dataset, node, atS?, recoverS (undefined: default, null: never), pods?)
 */
export function nodeLossFaults(model: any, dataset: any, node: string, at_s: number | null | undefined, recover_s: any, pods: any): any;
/**
 * podsPerNode(model, strategy?)
 */
export function podsPerNode(model: any, strategy: any): any;
/**
 * outageScenario(model, outage, baseRps?, roles?) → { dataset, faults, roles, warnings, baseRps }
 */
export function outageScenario(model: any, outage: any, base_rps: number | null | undefined, roles: any): any;
/**
 * simulate(spec, scenario, opts) → SimResult (src/sim/headless.ts)
 */
export function simulate(spec: any, scenario: any, opts: any): any;
/**
 * compareVariants(base, variants, scenario, opts) → { ranked, results: [{ name, spec, result }] }
 */
export function compareVariants(base: any, variants: any, scenario: any, opts: any): any;
/**
 * breakingPoint(spec, opts) → { maxRps, firstFailingRps?, limitedBy, note, slo }
 */
export function breakingPoint(spec: any, opts: any): any;
/**
 * loadCurve(spec, opts) → CurvePoint[]
 */
export function loadCurve(spec: any, opts: any): any;
/**
 * simulateDes(spec, scenario, cfg) → DesResult (src/sim/des/des.ts)
 */
export function simulateDes(spec: any, scenario: any, cfg: any): any;
/**
 * the same replay with the long series packed: the plan without its observed replicas, the
 * traffic without its series; `series` holds each endpoint's n values (null as 0), then each
 * service's observed replicas (null as NaN) at the offsets in `observed`. Returns
 * [every result series in one Float64Array (see `pack`), events]
 */
export function runPlanPacked(plan: any, traffic: any, endpoints: string[], observed: any, series: Float64Array, opts: any): Array<any>;
/**
 * the design simulator's fluid engine, stepped by the app (one tick at a time) and by headless runs
 */
export class SimEngine {
  free(): void;
  constructor();
  reset(): void;
  /**
   * step(nodes, edges, trafficRps, readRatio, dt, cfg, pricing) → events
   */
  step(nodes: any, edges: any, traffic: number, read_ratio: number, dt: number, cfg: any, pricing: string): any;
  /**
   * snapshot(nodes, edges) → { nodeStats, edgeStats, global }
   */
  snapshot(nodes: any, edges: any): any;
  readonly t: number;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly runPlan: (a: any, b: any, c: any) => [number, number, number];
  readonly backtest: (a: any, b: any, c: any, d: any) => [number, number, number];
  readonly calibrate: (a: any, b: any) => [number, number, number];
  readonly basePlan: (a: any, b: any) => [number, number, number];
  readonly applyStrategy: (a: any, b: any, c: any) => [number, number, number];
  readonly modelBreakingPoint: (a: any, b: any, c: any) => [number, number, number];
  readonly holdoutAccuracy: (a: any, b: any, c: number, d: number, e: any) => [number, number, number];
  readonly referenceAccuracy: (a: any, b: any, c: number, d: number) => [number, number, number];
  readonly nodeLoss: (a: any, b: any, c: any) => [number, number, number];
  readonly nodeLossFaults: (a: any, b: any, c: number, d: number, e: number, f: number, g: any, h: any) => [number, number, number];
  readonly podsPerNode: (a: any, b: any) => [number, number, number];
  readonly outageScenario: (a: any, b: any, c: number, d: number, e: any) => [number, number, number];
  readonly __wbg_simengine_free: (a: number, b: number) => void;
  readonly simengine_new: () => number;
  readonly simengine_t: (a: number) => number;
  readonly simengine_reset: (a: number) => void;
  readonly simengine_step: (a: number, b: any, c: any, d: number, e: number, f: number, g: any, h: number, i: number) => [number, number, number];
  readonly simengine_snapshot: (a: number, b: any, c: any) => [number, number, number];
  readonly simulate: (a: any, b: any, c: any) => [number, number, number];
  readonly compareVariants: (a: any, b: any, c: any, d: any) => [number, number, number];
  readonly breakingPoint: (a: any, b: any) => [number, number, number];
  readonly loadCurve: (a: any, b: any) => [number, number, number];
  readonly simulateDes: (a: any, b: any, c: any) => [number, number, number];
  readonly runPlanPacked: (a: any, b: any, c: number, d: number, e: any, f: number, g: number, h: any) => [number, number, number];
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_export_2: WebAssembly.Table;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
