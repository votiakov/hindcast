//! Hindcast's replay engine in Rust: the same replay as src/backtest/engine.ts, compiled to
//! WebAssembly for the browser, the CLI and the MCP server. The TypeScript engine stays as the
//! reference: test/engine-parity.test.ts runs both on the same plans and compares every series.

pub mod backtest;
pub mod dataset;
pub mod engine;
pub mod math;
pub mod model;
pub mod strategy;
pub mod types;

pub use engine::run_plan;

/// every series of a result in one buffer, in the order the JavaScript side reads them back:
/// totals, cost, then per service, per endpoint, and the node pool
pub fn pack(out: &types::RunResult) -> Vec<f64> {
    let mut v: Vec<f64> = Vec::with_capacity(out.t.len() * (9 + out.services.len() * 9 + out.endpoints.len() * 6 + 3));
    for a in [&out.t, &out.rps, &out.error_rate, &out.p99_ms, &out.cost_per_hour, &out.cost.compute, &out.cost.requests, &out.cost.transfer, &out.cost.other] {
        v.extend_from_slice(a);
    }
    for s in out.services.values() {
        for a in [&s.rps, &s.util, &s.replicas, &s.wait_ms, &s.self_mean_ms, &s.self_p99_ms, &s.backlog, &s.cpu_cores] {
            v.extend_from_slice(a);
        }
        if let Some(o) = &s.oom_down {
            v.extend_from_slice(o);
        }
    }
    for e in out.endpoints.values() {
        for a in [&e.rps, &e.error_rate, &e.mean_ms, &e.p99_ms, &e.p50_ms, &e.cost] {
            v.extend_from_slice(a);
        }
    }
    if let Some(c) = &out.cluster {
        for a in [&c.nodes, &c.requested_cpu, &c.requested_memory_gb] {
            v.extend_from_slice(a);
        }
    }
    v
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use crate::types::{Opts, Plan, Traffic};
    use serde::Serialize;
    use wasm_bindgen::prelude::*;

    /// runPlan(plan, traffic, opts) → RunResult, as plain JS objects
    #[wasm_bindgen(js_name = runPlan)]
    pub fn run_plan(plan: JsValue, traffic: JsValue, opts: JsValue) -> Result<JsValue, JsValue> {
        let plan: Plan = serde_wasm_bindgen::from_value(plan)?;
        let traffic: Traffic = serde_wasm_bindgen::from_value(traffic)?;
        let opts: Opts = if opts.is_undefined() || opts.is_null() { Opts::default() } else { serde_wasm_bindgen::from_value(opts)? };
        let out = crate::engine::run_plan(&plan, &traffic, &opts);
        let ser = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true).serialize_missing_as_null(true);
        Ok(out.serialize(&ser)?)
    }

    /// backtest(model, dataset, strategies, opts) → BacktestResult (src/backtest/backtest.ts)
    #[wasm_bindgen]
    pub fn backtest(model: JsValue, dataset: JsValue, strategies: JsValue, opts: JsValue) -> Result<JsValue, JsValue> {
        let model: crate::model::Model = serde_wasm_bindgen::from_value(model)?;
        let dataset: crate::dataset::Dataset = serde_wasm_bindgen::from_value(dataset)?;
        let strategies: Vec<serde_json::Value> = serde_wasm_bindgen::from_value(strategies)?;
        let opts: crate::backtest::BacktestOptions = if opts.is_undefined() || opts.is_null() { Default::default() } else { serde_wasm_bindgen::from_value(opts)? };
        let out = crate::backtest::backtest(&model, &dataset, &strategies, &opts).map_err(|e| JsValue::from(js_sys::Error::new(&e)))?;
        let ser = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true).serialize_missing_as_null(true);
        Ok(out.serialize(&ser)?)
    }

    /// the same replay with the long series packed: the plan without its observed replicas, the
    /// traffic without its series; `series` holds each endpoint's n values (null as 0), then each
    /// service's observed replicas (null as NaN) at the offsets in `observed`. Returns
    /// [every result series in one Float64Array (see `pack`), events]
    #[wasm_bindgen(js_name = runPlanPacked)]
    pub fn run_plan_packed(plan: JsValue, traffic: JsValue, endpoints: Vec<String>, observed: JsValue, series: &[f64], opts: JsValue) -> Result<js_sys::Array, JsValue> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Meta {
            start: f64,
            step_s: f64,
            n: f64,
        }
        let mut plan: Plan = serde_wasm_bindgen::from_value(plan)?;
        let meta: Meta = serde_wasm_bindgen::from_value(traffic)?;
        let observed: Vec<(String, usize, usize)> = serde_wasm_bindgen::from_value(observed)?;
        let opts: Opts = if opts.is_undefined() || opts.is_null() { Opts::default() } else { serde_wasm_bindgen::from_value(opts)? };
        let n = meta.n.max(0.0) as usize;
        let mut eps = crate::types::Map::new();
        for (k, name) in endpoints.into_iter().enumerate() {
            eps.insert(name, series[k * n..(k + 1) * n].iter().map(|&x| Some(x)).collect());
        }
        for (id, off, len) in observed {
            if let Some(s) = plan.services.get_mut(&id) {
                s.observed_replicas = Some(series[off..off + len].iter().map(|&x| if x.is_nan() { None } else { Some(x) }).collect());
            }
        }
        let traffic = Traffic { start: meta.start, step_s: meta.step_s, n: meta.n, endpoints: eps };
        let out = crate::engine::run_plan(&plan, &traffic, &opts);
        let data = js_sys::Float64Array::from(&crate::pack(&out)[..]);
        let ser = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true).serialize_missing_as_null(true);
        let events = out.events.serialize(&ser)?;
        Ok(js_sys::Array::of2(&data, &events))
    }
}
