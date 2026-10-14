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
 * the same replay with the long series packed: the plan without its observed replicas, the
 * traffic without its series; `series` holds each endpoint's n values (null as 0), then each
 * service's observed replicas (null as NaN) at the offsets in `observed`. Returns
 * [every result series in one Float64Array (see `pack`), events]
 */
export function runPlanPacked(plan: any, traffic: any, endpoints: string[], observed: any, series: Float64Array, opts: any): Array<any>;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly runPlan: (a: any, b: any, c: any) => [number, number, number];
  readonly backtest: (a: any, b: any, c: any, d: any) => [number, number, number];
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
