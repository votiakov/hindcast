//! Hindcast's engine: the simulators, calibration, replay and backtest, importers and readers.
//! Compiled to WebAssembly for the app (the `wasm` module below is its whole interface) and to the
//! native `hindcast` binary (src/cli: the CLI, the agent tools, the MCP server).

pub mod accuracy;
pub mod backtest;
pub mod calibrate;
#[cfg(not(target_arch = "wasm32"))]
pub mod cli;
pub mod config_diff;
pub mod convert;
pub mod dataset;
pub mod engine;
pub mod fmath;
pub mod import;
pub mod math;
pub mod model;
pub mod prom_export;
pub mod regimes;
pub mod resilience;
pub mod review;
pub mod sim;
pub mod strategy;
pub mod terraform_diff;
pub mod traffic_csv;
pub mod types;
pub mod yaml_out;

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

/// The WebAssembly heap: dlmalloc, as the standard library uses, but asking the host for memory in
/// steps of a quarter of what is already held (at least 4 MiB). The standard one grows by exactly the
/// shortfall, so a large import made thousands of `memory.grow` calls, each detaching the JavaScript
/// view of the memory.
#[cfg(target_arch = "wasm32")]
mod heap {
    use core::arch::wasm32::{memory_grow, memory_size};
    use core::cell::UnsafeCell;
    use dlmalloc::{Allocator, Dlmalloc};
    use std::alloc::{GlobalAlloc, Layout};

    const PAGE: usize = 65536;

    pub struct Geometric;
    unsafe impl Allocator for Geometric {
        fn alloc(&self, size: usize) -> (*mut u8, usize, u32) {
            let held = memory_size(0) * PAGE;
            for want in [size.max(held / 4).max(4 << 20), size] {
                let pages = want.div_ceil(PAGE);
                let prev = memory_grow(0, pages);
                if prev != usize::MAX {
                    return ((prev * PAGE) as *mut u8, pages * PAGE, 0);
                }
            }
            (core::ptr::null_mut(), 0, 0)
        }
        fn remap(&self, _ptr: *mut u8, _old: usize, _new: usize, _can_move: bool) -> *mut u8 {
            core::ptr::null_mut()
        }
        fn free_part(&self, _ptr: *mut u8, _old: usize, _new: usize) -> bool {
            false
        }
        fn free(&self, _ptr: *mut u8, _size: usize) -> bool {
            false
        }
        fn can_release_part(&self, _flags: u32) -> bool {
            false
        }
        fn allocates_zeros(&self) -> bool {
            true
        }
        fn page_size(&self) -> usize {
            PAGE
        }
    }

    /// single-threaded: WebAssembly here has no threads
    pub struct Heap(UnsafeCell<Dlmalloc<Geometric>>);
    unsafe impl Sync for Heap {}

    unsafe impl GlobalAlloc for Heap {
        unsafe fn alloc(&self, l: Layout) -> *mut u8 {
            (*self.0.get()).malloc(l.size(), l.align())
        }
        unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
            (*self.0.get()).calloc(l.size(), l.align())
        }
        unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
            (*self.0.get()).free(p, l.size(), l.align())
        }
        unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
            (*self.0.get()).realloc(p, l.size(), l.align(), new)
        }
    }

    #[global_allocator]
    static HEAP: Heap = Heap(UnsafeCell::new(Dlmalloc::new_with_allocator(Geometric)));
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

    /// calibrate(dataset, options) → Model (src/backtest/calibrate.ts)
    #[wasm_bindgen]
    pub fn calibrate(dataset: JsValue, options: JsValue) -> Result<JsValue, JsValue> {
        let dataset: crate::dataset::Dataset = serde_wasm_bindgen::from_value(dataset)?;
        let options: crate::calibrate::CalibrateOptions = if options.is_undefined() || options.is_null() { Default::default() } else { serde_wasm_bindgen::from_value(options)? };
        let model = crate::calibrate::calibrate(&dataset, &options);
        let ser = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true).serialize_missing_as_null(true);
        Ok(model.serialize(&ser)?)
    }

    fn ser() -> serde_wasm_bindgen::Serializer {
        serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true).serialize_missing_as_null(true)
    }
    fn from<T: serde::de::DeserializeOwned>(v: JsValue) -> Result<T, JsValue> {
        Ok(serde_wasm_bindgen::from_value(v)?)
    }
    fn opt<T: serde::de::DeserializeOwned + Default>(v: JsValue) -> Result<T, JsValue> {
        if v.is_undefined() || v.is_null() {
            Ok(T::default())
        } else {
            from(v)
        }
    }
    fn err(e: String) -> JsValue {
        JsValue::from(js_sys::Error::new(&e))
    }

    /// basePlan(model, observed?) → Plan
    #[wasm_bindgen(js_name = basePlan)]
    pub fn base_plan(model: JsValue, observed: JsValue) -> Result<JsValue, JsValue> {
        let model: crate::model::Model = from(model)?;
        let observed: Option<crate::types::Map<Option<Vec<crate::types::Num>>>> = if observed.is_undefined() || observed.is_null() { None } else { Some(from(observed)?) };
        Ok(crate::backtest::base_plan(&model, observed.as_ref()).serialize(&ser())?)
    }

    /// applyStrategy(model, plan, spec) → { plan, notes }
    #[wasm_bindgen(js_name = applyStrategy)]
    pub fn apply_strategy(model: JsValue, plan: JsValue, spec: JsValue) -> Result<JsValue, JsValue> {
        let model: crate::model::Model = from(model)?;
        let plan: crate::types::Plan = from(plan)?;
        let spec: serde_json::Value = from(spec)?;
        let a = crate::strategy::apply_strategy(&model, &plan, &crate::strategy::parse_strategy(&spec).map_err(err)?).map_err(err)?;
        #[derive(Serialize)]
        struct Out {
            plan: crate::types::Plan,
            notes: Vec<String>,
        }
        Ok(Out { plan: a.plan, notes: a.notes }.serialize(&ser())?)
    }

    /// modelBreakingPoint(model, plan?, opts?) → { rps, limitedBy }
    #[wasm_bindgen(js_name = modelBreakingPoint)]
    pub fn model_breaking_point(model: JsValue, plan: JsValue, opts: JsValue) -> Result<JsValue, JsValue> {
        #[derive(serde::Deserialize, Default)]
        #[serde(rename_all = "camelCase")]
        struct O {
            max_rps: Option<f64>,
            steps: Option<f64>,
            hold_s: Option<f64>,
        }
        let model: crate::model::Model = from(model)?;
        let plan: Option<crate::types::Plan> = if plan.is_undefined() || plan.is_null() { None } else { Some(from(plan)?) };
        let o: O = opt(opts)?;
        Ok(crate::accuracy::model_breaking_point(&model, plan.as_ref(), o.max_rps, o.steps, o.hold_s).serialize(&ser())?)
    }

    /// holdoutAccuracy(dataset, opts) → AccuracyRecord
    #[wasm_bindgen(js_name = holdoutAccuracy)]
    pub fn holdout_accuracy(dataset: JsValue, opts: JsValue, holdout: Option<f64>, requests: JsValue) -> Result<JsValue, JsValue> {
        let d: crate::dataset::Dataset = from(dataset)?;
        let o: crate::calibrate::CalibrateOptions = opt(opts)?;
        let log: Option<crate::accuracy::RequestLog> = if requests.is_undefined() || requests.is_null() { None } else { Some(from(requests)?) };
        Ok(crate::accuracy::holdout_accuracy(&d, &o, holdout, log.as_ref()).serialize(&ser())?)
    }

    /// referenceAccuracy(model, runs, label) → AccuracyRecord
    #[wasm_bindgen(js_name = referenceAccuracy)]
    pub fn reference_accuracy(model: JsValue, runs: JsValue, label: String) -> Result<JsValue, JsValue> {
        let model: crate::model::Model = from(model)?;
        let runs: Vec<crate::accuracy::ReferenceRun> = from(runs)?;
        Ok(crate::accuracy::reference_accuracy(&model, &runs, &label).map_err(err)?.serialize(&ser())?)
    }

    /// nodeLoss(model, dataset, opts) → the node-loss report
    #[wasm_bindgen(js_name = nodeLoss)]
    pub fn node_loss(model: JsValue, dataset: JsValue, opts: JsValue) -> Result<JsValue, JsValue> {
        let model: crate::model::Model = from(model)?;
        let d: crate::dataset::Dataset = from(dataset)?;
        let o: crate::resilience::NodeLossOptions = opt(opts)?;
        Ok(crate::resilience::node_loss(&model, &d, &o).map_err(err)?.serialize(&ser())?)
    }

    /// reviewCapacity(model, dataset, opts?, onProgress?) → the capacity review (review_capacity's data,
    /// the summary worded for the app, the traffic, each fix's change, the Markdown); onProgress(label,
    /// done, total) at each phase
    #[wasm_bindgen(js_name = reviewCapacity)]
    pub fn review_capacity(model: JsValue, dataset: JsValue, opts: JsValue, progress: JsValue) -> Result<JsValue, JsValue> {
        #[derive(serde::Deserialize, Default)]
        struct Opts {
            draws: Option<f64>,
        }
        let mv: serde_json::Value = from(model)?;
        let dv: serde_json::Value = from(dataset)?;
        let o: Opts = opt(opts)?;
        let f: Option<js_sys::Function> = progress.dyn_into().ok();
        let hook: Option<Box<dyn FnMut(&str, f64, f64)>> = f.map(|f| {
            Box::new(move |label: &str, done: f64, total: f64| {
                let _ = f.call3(&JsValue::NULL, &JsValue::from(label), &JsValue::from(done), &JsValue::from(total));
            }) as Box<dyn FnMut(&str, f64, f64)>
        });
        let r = crate::review::with_progress(hook, || crate::review::capacity::for_app(&mv, &dv, o.draws.unwrap_or(12.0))).map_err(err)?;
        Ok(r.serialize(&ser())?)
    }

    /// nodeLossFaults(model, dataset, node, atS?, recoverS (undefined: default, null: never), pods?)
    #[wasm_bindgen(js_name = nodeLossFaults)]
    pub fn node_loss_faults(model: JsValue, dataset: JsValue, node: String, at_s: Option<f64>, recover_s: JsValue, pods: JsValue) -> Result<JsValue, JsValue> {
        let model: crate::model::Model = from(model)?;
        let d: crate::dataset::Dataset = from(dataset)?;
        let recover: Option<Option<f64>> = if recover_s.is_undefined() { None } else if recover_s.is_null() { Some(None) } else { Some(recover_s.as_f64()) };
        let pods: Option<crate::types::Map<crate::types::Map<f64>>> = if pods.is_undefined() || pods.is_null() { None } else { Some(from(pods)?) };
        Ok(crate::resilience::node_loss_faults(&model, &d, &node, at_s, recover, pods.as_ref()).map_err(err)?.serialize(&ser())?)
    }

    /// podsPerNode(model, strategy?)
    #[wasm_bindgen(js_name = podsPerNode)]
    pub fn pods_per_node(model: JsValue, strategy: JsValue) -> Result<JsValue, JsValue> {
        let model: crate::model::Model = from(model)?;
        let s: Option<serde_json::Value> = if strategy.is_undefined() || strategy.is_null() { None } else { Some(from(strategy)?) };
        Ok(crate::resilience::pods_per_node(&model, s.as_ref()).map_err(err)?.serialize(&ser())?)
    }

    /// outageScenario(model, outage, baseRps?, roles?) → { dataset, faults, roles, warnings, baseRps }
    #[wasm_bindgen(js_name = outageScenario)]
    pub fn outage_scenario(model: JsValue, outage: JsValue, base_rps: Option<f64>, roles: JsValue) -> Result<JsValue, JsValue> {
        let model: crate::model::Model = from(model)?;
        let outage: crate::resilience::Outage = from(outage)?;
        let roles: crate::types::Map<Vec<String>> = opt(roles)?;
        Ok(crate::resilience::outage_scenario(&model, &outage, base_rps, &roles).serialize(&ser())?)
    }

    /// the design simulator's fluid engine, stepped by the app (one tick at a time) and by headless runs
    #[wasm_bindgen]
    pub struct SimEngine {
        inner: crate::sim::engine::Engine,
    }

    #[wasm_bindgen]
    impl SimEngine {
        #[wasm_bindgen(constructor)]
        pub fn new() -> SimEngine {
            SimEngine { inner: crate::sim::engine::Engine::new() }
        }
        #[wasm_bindgen(getter)]
        pub fn t(&self) -> f64 {
            self.inner.t
        }
        pub fn reset(&mut self) {
            self.inner.reset();
        }
        /// step(nodes, edges, trafficRps, readRatio, dt, cfg, pricing) → events
        pub fn step(&mut self, nodes: JsValue, edges: JsValue, traffic: f64, read_ratio: f64, dt: f64, cfg: JsValue, pricing: String) -> Result<JsValue, JsValue> {
            let nodes: Vec<crate::sim::engine::SimNode> = from(nodes)?;
            let edges: Vec<crate::sim::engine::SimEdge> = from(edges)?;
            let cfg: crate::sim::engine::EngineConfig = if cfg.is_undefined() || cfg.is_null() { Default::default() } else { from(cfg)? };
            Ok(self.inner.step(&nodes, &edges, traffic, read_ratio, dt, &cfg, &pricing).serialize(&ser())?)
        }
        /// snapshot(nodes, edges) → { nodeStats, edgeStats, global }
        pub fn snapshot(&mut self, nodes: JsValue, edges: JsValue) -> Result<JsValue, JsValue> {
            let nodes: Vec<crate::sim::engine::SimNode> = from(nodes)?;
            let edges: Vec<crate::sim::engine::SimEdge> = from(edges)?;
            Ok(self.inner.snapshot(&nodes, &edges).serialize(&ser())?)
        }
    }

    fn jerr(e: String) -> JsValue {
        err(e)
    }

    /// simulate(spec, scenario, opts) → SimResult (src/sim/headless.ts)
    #[wasm_bindgen]
    pub fn simulate(spec: JsValue, scenario: JsValue, opts: JsValue) -> Result<JsValue, JsValue> {
        let spec: serde_json::Value = from(spec)?;
        let sc: serde_json::Value = if scenario.is_undefined() || scenario.is_null() { serde_json::json!({}) } else { from(scenario)? };
        let o: crate::sim::headless::SimOptions = opt(opts)?;
        Ok(crate::sim::headless::simulate(&spec, &sc, &o).map_err(jerr)?.serialize(&ser())?)
    }

    /// compareVariants(base, variants, scenario, opts) → { ranked, results: [{ name, spec, result }] }
    #[wasm_bindgen(js_name = compareVariants)]
    pub fn compare_variants(base: JsValue, variants: JsValue, scenario: JsValue, opts: JsValue) -> Result<JsValue, JsValue> {
        let base: serde_json::Value = from(base)?;
        let variants: Vec<serde_json::Value> = from(variants)?;
        let sc: serde_json::Value = if scenario.is_undefined() || scenario.is_null() { serde_json::json!({}) } else { from(scenario)? };
        let o: crate::sim::headless::SimOptions = opt(opts)?;
        let (ranked, results) = crate::sim::headless::compare(&base, &variants, &sc, &o).map_err(jerr)?;
        #[derive(Serialize)]
        struct Run {
            name: String,
            spec: serde_json::Value,
            result: crate::sim::headless::SimResult,
        }
        #[derive(Serialize)]
        struct Out {
            ranked: Vec<crate::sim::headless::CompareRow>,
            results: Vec<Run>,
        }
        Ok(Out { ranked, results: results.into_iter().map(|(name, a, result)| Run { name, spec: crate::sim::spec::to_value(&a), result }).collect() }.serialize(&ser())?)
    }

    /// toMermaid(spec) → a Mermaid flowchart of the architecture
    #[wasm_bindgen(js_name = toMermaid)]
    pub fn to_mermaid(spec: JsValue) -> Result<String, JsValue> {
        let spec: serde_json::Value = from(spec)?;
        crate::convert::mermaid::spec_to_mermaid(&spec).map_err(jerr)
    }

    /// breakingPoint(spec, opts) → { maxRps, firstFailingRps?, limitedBy, note, slo }
    #[wasm_bindgen(js_name = breakingPoint)]
    pub fn breaking_point(spec: JsValue, opts: JsValue) -> Result<JsValue, JsValue> {
        let spec: serde_json::Value = from(spec)?;
        let o: crate::sim::headless::BreakingOptions = opt(opts)?;
        Ok(crate::sim::headless::breaking_point(&spec, &o).map_err(jerr)?.serialize(&ser())?)
    }

    /// loadCurve(spec, opts) → CurvePoint[]
    #[wasm_bindgen(js_name = loadCurve)]
    pub fn load_curve(spec: JsValue, opts: JsValue) -> Result<JsValue, JsValue> {
        #[derive(serde::Deserialize, Default)]
        #[serde(rename_all = "camelCase")]
        struct O {
            max_rps: f64,
            points: Option<f64>,
            read_ratio: Option<f64>,
            hold_s: Option<f64>,
            cfg: Option<serde_json::Value>,
        }
        let spec: serde_json::Value = from(spec)?;
        let o: O = opt(opts)?;
        Ok(crate::sim::headless::load_curve(&spec, o.max_rps, o.points, o.read_ratio, o.hold_s, o.cfg).map_err(jerr)?.serialize(&ser())?)
    }

    /// simulateDes(spec, scenario, cfg) → DesResult (src/sim/des/des.ts)
    #[wasm_bindgen(js_name = simulateDes)]
    pub fn simulate_des(spec: JsValue, scenario: JsValue, cfg: JsValue) -> Result<JsValue, JsValue> {
        let spec: serde_json::Value = from(spec)?;
        let sc: serde_json::Value = if scenario.is_undefined() || scenario.is_null() { serde_json::json!({}) } else { from(scenario)? };
        let cfg: crate::sim::des::DesConfig = opt(cfg)?;
        Ok(crate::sim::des::simulate_des(&spec, &sc, &cfg).map_err(jerr)?.serialize(&ser())?)
    }

    /// journeyRows(journey, names, focus?) → [[{ t, c }]]: a traced request's path as rows of text runs
    /// (src/ui/journey.ts), as `simulate --trace` and the trace_request tool print it
    #[wasm_bindgen(js_name = journeyRows)]
    pub fn journey_rows(journey: JsValue, names: JsValue, focus: Option<String>) -> Result<JsValue, JsValue> {
        let j: crate::sim::trace::Journey = from(journey)?;
        let names: std::collections::HashMap<String, String> = opt(names)?;
        let name_of = |id: &str| names.get(id).cloned().unwrap_or_else(|| id.to_string());
        Ok(crate::sim::journey::journey_rows(&j, &name_of, focus.as_deref()).serialize(&ser())?)
    }

    /// journeyVerdict(journey, names) → the one-line summary of a traced request
    #[wasm_bindgen(js_name = journeyVerdict)]
    pub fn journey_verdict(journey: JsValue, names: JsValue) -> Result<String, JsValue> {
        let j: crate::sim::trace::Journey = from(journey)?;
        let names: std::collections::HashMap<String, String> = opt(names)?;
        let name_of = |id: &str| names.get(id).cloned().unwrap_or_else(|| id.to_string());
        Ok(crate::sim::journey::journey_verdict(&j, &name_of))
    }

    /// analyze(spec, scenario, { runs, seed, des }) → Analysis: discrete-event Monte Carlo
    #[wasm_bindgen]
    pub fn analyze(spec: JsValue, scenario: JsValue, opts: JsValue) -> Result<JsValue, JsValue> {
        let spec: serde_json::Value = from(spec)?;
        let sc: serde_json::Value = if scenario.is_undefined() || scenario.is_null() { serde_json::json!({}) } else { from(scenario)? };
        let o: crate::sim::optimize::AnalyzeOptions = opt(opts)?;
        Ok(crate::sim::optimize::analyze(&spec, &sc, &o).map_err(jerr)?.serialize(&ser())?)
    }

    /// optimize(spec, scenario, opts) → the cheapest configuration that meets the SLO
    #[wasm_bindgen]
    pub fn optimize(spec: JsValue, scenario: JsValue, opts: JsValue) -> Result<JsValue, JsValue> {
        let spec: serde_json::Value = from(spec)?;
        let sc: serde_json::Value = if scenario.is_undefined() || scenario.is_null() { serde_json::json!({}) } else { from(scenario)? };
        let o: crate::sim::optimize::OptimizeOptions = opt(opts)?;
        Ok(crate::sim::optimize::optimize(&spec, &sc, &o).map_err(jerr)?.serialize(&ser())?)
    }

    /// audit(spec, opts, onProgress?) → the failure audit: what breaks first, and what it costs
    #[wasm_bindgen]
    pub fn audit(spec: JsValue, opts: JsValue, progress: JsValue) -> Result<JsValue, JsValue> {
        let spec: serde_json::Value = from(spec)?;
        let a = crate::sim::spec::parse_architecture(&spec).map_err(jerr)?;
        let o: crate::sim::audit::AuditOptions = opt(opts)?;
        let f: Option<js_sys::Function> = progress.dyn_into().ok();
        let mut cb = |done: f64, total: f64, label: &str| {
            if let Some(f) = &f {
                let _ = f.call3(&JsValue::NULL, &JsValue::from(done), &JsValue::from(total), &JsValue::from(label));
            }
        };
        Ok(crate::sim::audit::audit(&a, &o, &mut cb).map_err(jerr)?.serialize(&ser())?)
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

    /// the files the JS side can reach: { read(path), glob(pattern), lines?(path) }
    struct JsFiles(JsValue);
    impl JsFiles {
        fn call(&self, name: &str, arg: &str) -> Result<JsValue, String> {
            let f: js_sys::Function = js_sys::Reflect::get(&self.0, &JsValue::from(name)).ok().and_then(|f| f.dyn_into().ok()).ok_or_else(|| format!("files.{} is missing", name))?;
            f.call1(&self.0, &JsValue::from(arg)).map_err(|e| e.dyn_ref::<js_sys::Error>().map(|e| String::from(e.message())).or_else(|| e.as_string()).unwrap_or_else(|| format!("{:?}", e)))
        }
    }
    impl crate::import::manifest::FileAccess for JsFiles {
        fn chunks(&mut self, path: &str) -> Option<Result<crate::import::manifest::ChunkReader, String>> {
            let has = js_sys::Reflect::get(&self.0, &JsValue::from("chunks")).map(|f| f.is_function()).unwrap_or(false);
            if !has {
                return None;
            }
            Some(self.call("chunks", path).and_then(|it| {
                let iter = js_sys::try_iter(&it).ok().flatten().ok_or_else(|| format!("{}: chunks() did not return an iterable", path))?;
                let mut iter = iter;
                // each block is copied into the same buffer: no new allocation (and no memory.grow) per block
                Ok(Box::new(move |buf: &mut Vec<u8>| match iter.next() {
                    None => Ok(false),
                    Some(Err(e)) => Err(format!("{:?}", e)),
                    Some(Ok(v)) => {
                        let a = js_sys::Uint8Array::new(&v);
                        buf.resize(a.length() as usize, 0);
                        a.copy_to(buf);
                        Ok(true)
                    }
                }) as crate::import::manifest::ChunkReader)
            }))
        }
        fn read(&mut self, path: &str) -> Result<String, String> {
            self.call("read", path)?.as_string().ok_or_else(|| format!("{}: read() did not return text", path))
        }
        fn glob(&mut self, pattern: &str) -> Result<Vec<String>, String> {
            let a = self.call("glob", pattern)?;
            Ok(js_sys::Array::from(&a).iter().filter_map(|v| v.as_string()).collect())
        }
        fn lines(&mut self, path: &str) -> Option<Result<Box<dyn Iterator<Item = String>>, String>> {
            let has = js_sys::Reflect::get(&self.0, &JsValue::from("lines")).map(|f| f.is_function()).unwrap_or(false);
            if !has {
                return None;
            }
            // pulled one line at a time: trace files run to gigabytes
            Some(self.call("lines", path).and_then(|it| {
                let iter = js_sys::try_iter(&it).ok().flatten().ok_or_else(|| format!("{}: lines() did not return an iterable", path))?;
                Ok(Box::new(iter.filter_map(|v| v.ok().and_then(|v| v.as_string()))) as Box<dyn Iterator<Item = String>>)
            }))
        }
    }

    /// importBundle(manifest, files) → { dataset, log } (src/backtest/import/manifest.ts); the manifest
    /// already validated on the JS side
    #[wasm_bindgen(js_name = importBundle)]
    pub fn import_bundle(manifest: JsValue, files: JsValue) -> Result<JsValue, JsValue> {
        let m: serde_json::Value = from(manifest)?;
        let mut fs = JsFiles(files);
        let (dataset, log) = crate::import::manifest::import_bundle(&m, &mut fs).map_err(jerr)?;
        #[derive(Serialize)]
        struct Out {
            dataset: crate::dataset::Dataset,
            log: Vec<crate::import::manifest::ImportLog>,
        }
        Ok(Out { dataset, log }.serialize(&ser())?)
    }

    /// readWorkloads(documents) → [service, WorkloadConfig][] (src/backtest/configDiff.ts), in document order
    #[wasm_bindgen(js_name = readWorkloads)]
    pub fn read_workloads(documents: JsValue) -> Result<JsValue, JsValue> {
        let docs: Vec<serde_json::Value> = from(documents)?;
        let w: Vec<(String, crate::config_diff::WorkloadConfig)> = crate::config_diff::read_workloads(&docs).into_iter().collect();
        Ok(w.serialize(&ser())?)
    }

    /// strategyFromDiff(before, after, name?, known?) → { strategy, ignored }; workloads as [service, config][]
    #[wasm_bindgen(js_name = strategyFromDiff)]
    pub fn strategy_from_diff(before: JsValue, after: JsValue, name: Option<String>, known: Option<Vec<String>>) -> Result<JsValue, JsValue> {
        let before: Vec<(String, crate::config_diff::WorkloadConfig)> = from(before)?;
        let after: Vec<(String, crate::config_diff::WorkloadConfig)> = from(after)?;
        let known: Option<indexmap::IndexSet<String>> = known.map(|k| k.into_iter().collect());
        let r = crate::config_diff::strategy_from_diff(&before.into_iter().collect(), &after.into_iter().collect(), name.as_deref(), known.as_ref());
        Ok(r.serialize(&ser())?)
    }

    /// strategyFromTerraformPlan(plan, name?, known?) → { strategy, ignored, mapped } (src/backtest/terraformDiff.ts)
    #[wasm_bindgen(js_name = strategyFromTerraformPlan)]
    pub fn strategy_from_terraform_plan(plan: JsValue, name: Option<String>, known: Option<Vec<String>>) -> Result<JsValue, JsValue> {
        let plan: serde_json::Value = from(plan)?;
        let known: Option<indexmap::IndexSet<String>> = known.map(|k| k.into_iter().collect());
        Ok(crate::terraform_diff::strategy_from_terraform_plan(&plan, name.as_deref(), known.as_ref()).serialize(&ser())?)
    }

    /// instanceType("m7g.large") → { cpu, memoryGb, arch }
    #[wasm_bindgen(js_name = instanceType)]
    pub fn instance_type(t: &str) -> Result<JsValue, JsValue> {
        Ok(crate::terraform_diff::instance_type(t).serialize(&ser())?)
    }

    /// importKubernetes(documents, name?) → { spec, assumptions, skipped, mapped } (src/spec/kubernetes.ts)
    #[wasm_bindgen(js_name = importKubernetes)]
    pub fn import_kubernetes(documents: JsValue, name: Option<String>) -> Result<JsValue, JsValue> {
        let docs: Vec<serde_json::Value> = from(documents)?;
        Ok(crate::convert::kubernetes::import_kubernetes(&docs, name.as_deref()).map_err(err)?.serialize(&ser())?)
    }

    /// importTerraform(doc, name?) → { spec, assumptions, skipped, mapped } (src/spec/terraform.ts)
    #[wasm_bindgen(js_name = importTerraform)]
    pub fn import_terraform(doc: JsValue, name: Option<String>) -> Result<JsValue, JsValue> {
        let doc: serde_json::Value = from(doc)?;
        Ok(crate::convert::terraform::import_terraform(&doc, name.as_deref()).map_err(err)?.serialize(&ser())?)
    }

    /// cacheHitRate(nodeData) → the share of reads a cache answers (its hitRate, or what its size and the
    /// data it fronts give)
    #[wasm_bindgen(js_name = cacheHitRate)]
    pub fn cache_hit_rate(d: JsValue) -> Result<f64, JsValue> {
        let d: crate::sim::catalog::NodeData = from(d)?;
        Ok(crate::sim::catalog::cache_hit_rate(&d))
    }

    /// exportPlan(presets, { window?, selector?, entry?, namespaces? }) → [{ preset, query: { file, query, mapping } }]:
    /// the Prometheus queries `export-prometheus` and collect_telemetry run, for scripts that fetch them
    #[wasm_bindgen(js_name = exportPlan)]
    pub fn export_plan(presets: Vec<String>, opts: JsValue) -> Result<JsValue, JsValue> {
        let o: serde_json::Value = if opts.is_undefined() || opts.is_null() { serde_json::Value::Null } else { from(opts)? };
        let strs = |k: &str| o.get(k).and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
        let po = crate::prom_export::Opts {
            window: o.get("window").and_then(|x| x.as_str()).unwrap_or("1m").to_string(),
            selector: o.get("selector").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            entry: strs("entry"),
            namespaces: strs("namespaces"),
        };
        let plan = crate::prom_export::export_plan(&presets, &po).map_err(err)?;
        let out: Vec<serde_json::Value> = plan.iter().map(|p| serde_json::json!({ "preset": p.preset, "query": { "file": p.query.file, "query": p.query.query, "mapping": p.query.mapping } })).collect();
        Ok(out.serialize(&ser())?)
    }

    /// podsByNodeQuery(namespaces) → the PromQL for pods per node per workload
    #[wasm_bindgen(js_name = podsByNodeQuery)]
    pub fn pods_by_node_query(namespaces: Vec<String>) -> String {
        crate::prom_export::pods_by_node_query(&namespaces)
    }

    /// zoneOfProviderId("aws:///us-east-1a/i-…") → "us-east-1a" (AWS, GCP), else null
    #[wasm_bindgen(js_name = zoneOfProviderId)]
    pub fn zone_of_provider_id(id: Option<String>) -> Option<String> {
        crate::prom_export::zone_of_provider_id(id.as_deref())
    }

    /// workloadRe() → the pattern that takes a pod name back to its workload
    #[wasm_bindgen(js_name = workloadRe)]
    pub fn workload_re() -> String {
        crate::prom_export::workload_re()
    }

    /// specToYaml(spec) → YAML as src/spec/yaml.ts writes it
    #[wasm_bindgen(js_name = specToYaml)]
    pub fn spec_to_yaml(spec: JsValue) -> Result<String, JsValue> {
        let v: serde_json::Value = from(spec)?;
        Ok(crate::yaml_out::spec_to_yaml(&v))
    }

    /// toYaml(value) → yaml.stringify(value) with the package's defaults
    #[wasm_bindgen(js_name = toYaml)]
    pub fn to_yaml(v: JsValue) -> Result<String, JsValue> {
        let v: serde_json::Value = from(v)?;
        Ok(crate::yaml_out::to_yaml(&v))
    }
}
