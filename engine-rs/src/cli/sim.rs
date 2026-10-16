//! The design commands: validate, simulate, compare, breaking-point, import-terraform, import-k8s.

use super::util::*;
use crate::math::{js_num, js_round, js_to_fixed};
use crate::sim::headless::{BreakingOptions, SimOptions, SimResult};
use crate::sim::spec::{check_architecture, Issue};
use indexmap::IndexMap;
use serde_json::{json, Map as JMap, Value};

pub fn command(cmd: &str, f: &Flags, out: &mut Out) -> Result<Option<i32>, String> {
    let json = f.has("json");
    let pos = |i: usize| f.pos.get(i).cloned().unwrap_or_else(|| "undefined".into());
    Ok(Some(match cmd {
        "validate" => {
            let v = validate(&load(&pos(0))?);
            if json {
                out.log(&pretty(&v.to_json()));
                return Ok(Some(0));
            }
            if v.issues.is_empty() {
                out.log(&green("✓ valid, no issues"));
            }
            for i in &v.issues {
                out.log(&format!("{} {}", if i.0 == "error" { red("error  ") } else { yellow("warning") }, i.1));
            }
            if v.ok {
                0
            } else {
                1
            }
        }
        "simulate" => {
            let spec = load(&pos(0))?;
            let sc = scenario_from(f.pos.get(1).map(|s| s.as_str()), f, out)?;
            if let Some(comp) = f.get("trace") {
                if f.get("engine").as_deref() != Some("des") {
                    return Err("--trace follows requests in the discrete-event engine: add --engine des".into());
                }
                if comp == "true" {
                    return Err("--trace needs a component: --trace <component id>".into());
                }
                let count = f.num("count").filter(|c| c.is_finite() && *c >= 1.0).map(|c| c.floor() as usize).unwrap_or(3);
                let t = trace_request(&spec, &sc, f.num("seed").unwrap_or(1.0), &comp, f.has("failed"), count)?;
                if json {
                    out.log(&pretty(&t.to_json()));
                } else {
                    print_trace(&t, out);
                }
                return Ok(Some(0));
            }
            if f.get("engine").as_deref() == Some("des") {
                let cfg = crate::sim::des::DesConfig { seed: f.num("seed").unwrap_or(1.0), ..Default::default() };
                let r = crate::sim::des::simulate_des(&spec, &sc, &cfg)?;
                if json {
                    out.log(&pretty(&to_json(&r)));
                } else {
                    print_des(&r, out);
                }
                return Ok(Some(0));
            }
            let r = crate::sim::headless::simulate(&spec, &sc, &SimOptions::default())?;
            if json {
                out.log(&pretty(&to_json(&r)));
            } else {
                print_result(&to_json(&r), out);
            }
            0
        }
        "compare" => {
            let base = load(&pos(0))?;
            let (variants, vsc) = variants_file(&pos(1))?;
            let sc = match f.pos.get(2) {
                Some(p) => scenario_from(Some(p), f, out)?,
                None => {
                    let mut s = match vsc {
                        Some(Value::Object(o)) => o,
                        _ => JMap::new(),
                    };
                    if let Value::Object(o) = scenario_from(None, f, out)? {
                        for (k, v) in o {
                            s.insert(k, v);
                        }
                    }
                    Value::Object(s)
                }
            };
            let (ranked, _) = crate::sim::headless::compare(&base, &variants, &sc, &SimOptions::default())?;
            if json {
                out.log(&pretty(&to_json(&ranked)));
                return Ok(Some(0));
            }
            out.log(&format!("\n{}top bottleneck", bold(&format!("{}{}{}{}{}{}", pad("#", 3), pad("variant", 32), pad("SLO", 8), pad("errors", 9), pad("peak p99", 10), pad("$/month", 10)))));
            for (i, r) in ranked.iter().enumerate() {
                let slo = if r.meets_slo { green(&pad("met", 8)) } else { red(&pad(&pct(r.slo_compliance), 8)) };
                out.log(&format!("{}{}{}{}{}{}{}", pad(&(i + 1).to_string(), 3), pad(&r.name, 32), slo, pad(&pct(r.mean_error_rate), 9), pad(&ms(r.peak_p99_ms), 10), pad(&format!("${}", loc(r.monthly_cost)), 10), dim(r.top_bottleneck.as_deref().unwrap_or("—"))));
            }
            out.log(&dim("peak p99: the worst second's p99 incl. failures, as timeouts (fluid engine)"));
            out.log("");
            0
        }
        "breaking-point" => {
            let spec = load(&pos(0))?;
            let mut slo = JMap::new();
            if let Some(p) = f.num("p99").filter(|_| truthy_flag(f, "p99")) {
                slo.insert("maxP99Ms".into(), num(p));
            }
            if let Some(e) = f.num("errors").filter(|_| truthy_flag(f, "errors")) {
                slo.insert("maxErrorRate".into(), num(e));
            }
            let r = crate::sim::headless::breaking_point(&spec, &BreakingOptions { slo: Some(Value::Object(slo)), ..Default::default() })?;
            if json {
                out.log(&pretty(&to_json(&r)));
                return Ok(Some(0));
            }
            out.log(&format!("\nSustains {} within SLO (errors ≤ {}, p99 ≤ {}).", bold(&format!("{} req/s", loc(r.max_rps))), pct(r.slo.max_error_rate), ms(r.slo.max_p99_ms)));
            if let Some(l) = &r.limited_by {
                out.log(&format!("Limited by {} — {}", yellow(l), dim(r.note.as_deref().unwrap_or(""))));
            }
            out.log("");
            0
        }
        "import-terraform" => {
            let doc: Value = serde_json::from_str(&read(&pos(0))?).map_err(|e| e.to_string())?;
            let r = crate::convert::terraform::import_terraform(&doc, f.get("name").as_deref())?;
            imported(&r, f, out, "resources", "Not modelled (no request path)")?;
            0
        }
        "import-k8s" => {
            let mut docs = vec![];
            for p in &f.pos {
                docs.extend(yaml_documents(&read(p)?)?);
            }
            let r = crate::convert::kubernetes::import_kubernetes(&docs, f.get("name").as_deref())?;
            imported(&r, f, out, "objects", "Not modelled")?;
            0
        }
        _ => return Ok(None),
    }))
}

/// opt.x is truthy: a flag given a value (an empty string or "0" still counts, as `opt.p99 ?` does)
pub(super) fn truthy_flag(f: &Flags, k: &str) -> bool {
    f.opt.get(k).map(|v| v.as_deref() != Some("")).unwrap_or(false)
}

fn num(x: f64) -> Value {
    serde_json::Number::from_f64(x).map(Value::Number).unwrap_or(Value::Null)
}

fn imported(r: &crate::convert::ImportResult, f: &Flags, out: &mut Out, what: &str, skipped: &str) -> Result<(), String> {
    let yaml = crate::yaml_out::spec_to_yaml(&r.spec);
    if let Some(o) = f.get("out") {
        write(&o, &yaml)?;
    }
    if f.has("json") {
        out.log(&pretty(&to_json(r)));
        return Ok(());
    }
    if !f.has("out") {
        out.log(&yaml);
    }
    let comps = r.spec.get("components").and_then(|c| c.as_array()).map(|c| c.len()).unwrap_or(1);
    out.err(&format!("{}{}", bold(&format!("\nImported {} components from {} {}", comps - 1, r.mapped.len(), what)), f.get("out").map(|o| format!(" → {}", o)).unwrap_or_default()));
    if !r.assumptions.is_empty() {
        out.err(&format!("{}\n{}", yellow("Assumptions — review these:"), r.assumptions.iter().map(|a| format!("  • {}", a)).collect::<Vec<_>>().join("\n")));
    }
    if !r.skipped.is_empty() {
        out.err(&dim(&format!("{}: {}", skipped, r.skipped.join(", "))));
    }
    Ok(())
}

/// a scenario file with --rps, --duration and --traffic laid over it
pub(super) fn scenario_from(path: Option<&str>, f: &Flags, out: &mut Out) -> Result<Value, String> {
    let mut base = match path {
        Some(p) => match load(p)? {
            Value::Object(o) => o,
            _ => JMap::new(),
        },
        None => JMap::new(),
    };
    if truthy_flag(f, "rps") {
        base.insert("rps".into(), num(f.num("rps").unwrap_or(f64::NAN)));
    }
    if truthy_flag(f, "duration") {
        base.insert("duration".into(), num(f.num("duration").unwrap_or(f64::NAN)));
    }
    if let Some(t) = f.get("traffic").filter(|_| truthy_flag(f, "traffic")) {
        let max = if truthy_flag(f, "duration") { f.num("duration").unwrap_or(3600.0) } else { 3600.0 };
        let t = crate::traffic_csv::parse_traffic_csv(&read(&t)?, Some(max), false)?;
        let last = t.traffic.last().map(|k| k.at).unwrap_or(0.0);
        base.insert("traffic".into(), json!(t.traffic.iter().map(|k| json!({ "at": num(k.at), "rps": num(k.rps) })).collect::<Vec<_>>()));
        base.insert("duration".into(), num(last));
        if t.compression > 1.01 {
            out.err(&format!("traffic compressed {}× to fit {}s", js_to_fixed(t.compression, 1), js_num(last)));
        }
    }
    Ok(Value::Object(base))
}

pub(super) fn variants_file(path: &str) -> Result<(Vec<Value>, Option<Value>), String> {
    match load(path)? {
        Value::Array(a) => Ok((a, None)),
        Value::Object(o) => {
            let v = match o.get("variants") {
                Some(Value::Array(a)) => a.clone(),
                _ => return Err("Cannot read properties of undefined (reading 'map')".into()),
            };
            Ok((v, o.get("scenario").cloned()))
        }
        _ => Err("Cannot read properties of undefined (reading 'map')".into()),
    }
}

fn g<'a>(v: &'a Value, path: &[&str]) -> &'a Value {
    let mut x = v;
    for k in path {
        x = x.get(*k).unwrap_or(&Value::Null);
    }
    x
}
fn gn(v: &Value, path: &[&str]) -> f64 {
    g(v, path).as_f64().unwrap_or(f64::NAN)
}
fn gs(v: &Value, path: &[&str]) -> String {
    match g(v, path) {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        x => x.to_string(),
    }
}

fn print_result(r: &Value, out: &mut Out) {
    let ok = gn(r, &["summary", "sloCompliance"]) >= 0.99;
    let s = |k: &str| gn(r, &["summary", k]);
    out.log(&format!("\n{} {} {} {}", bold(&gs(r, &["architecture"])), dim("·"), gs(r, &["scenario"]), dim(&format!("· {}s simulated", js_num(s("durationS"))))));
    let met = if ok { green(&format!("met {} of the time", pct(s("sloCompliance")))) } else { red(&format!("met only {} of the time ({}s in breach)", pct(s("sloCompliance")), js_num(s("sloBreachSeconds")))) };
    out.log(&format!("  SLO (errors ≤ {}, p99 ≤ {}): {}", pct(gn(r, &["slo", "maxErrorRate"])), ms(gn(r, &["slo", "maxP99Ms"])), met));
    out.log(&format!("  errors  mean {}  peak {}   {}", pct(s("meanErrorRate")), pct(s("peakErrorRate")), dim(&format!("{} of {} requests failed", loc(s("failedRequests")), loc(s("requests"))))));
    // the two engines' per-second p99 are different quantities: the fluid engine's reads as a timeout
    // once 1% of a second's requests fail, the discrete-event engine's is of the successful answers
    let des = gs(r, &["engine"]) == "des";
    out.log(&format!("  p99     mean {}  peak {}   {}", ms(s("meanP99Ms")), ms(s("peakP99Ms")), dim(&format!("{} · worst moment at t={}s", if des { "answers" } else { "incl. failures, as timeouts" }, js_num(s("worstMomentS"))))));
    let run = |k: &str| match g(r, &["summary", k]) {
        Value::Number(x) => ms(x.as_f64().unwrap_or(f64::NAN)),
        _ => "—".into(),
    };
    out.log(&format!("  p99 run answers {}  incl. failures {}   {}", run("p99AnswersMs"), run("p99WithFailuresMs"), dim("over the whole run; failures at the time they took to fail")));
    out.log(&format!("  cost    ${}/h  {}", js_to_fixed(s("meanCostPerHour"), 2), dim(&format!("≈ ${}/month", loc(js_round(s("meanCostPerHour") * 730.0))))));
    let bn = g(r, &["bottlenecks"]).as_array().cloned().unwrap_or_default();
    if !bn.is_empty() {
        out.log(&format!("\n  {}", bold("Bottlenecks")));
        for b in &bn {
            out.log(&format!("  {} peak {} dropped {} {}", yellow(&pad(&gs(b, &["id"]), 14)), pad(&pct(gn(b, &["peakUtil"])), 7), pad(&loc(gn(b, &["droppedTotal"])), 8), dim(&gs(b, &["note"]))));
        }
    }
    let ev = g(r, &["events"]).as_array().cloned().unwrap_or_default();
    if !ev.is_empty() {
        out.log(&format!("\n  {}", bold("Events")));
        for e in ev.iter().take(20) {
            out.log(&format!("  {} {}", dim(&pad(&format!("t={}s", js_num(gn(e, &["t"]))), 9)), gs(e, &["what"])));
        }
    }
    out.log("");
}

fn print_des(r: &crate::sim::des::DesResult, out: &mut Out) {
    let v = to_json(r);
    print_result(&v, out);
    let s = |k: &str| gn(&v, &["summary", k]);
    if !r.failures.is_empty() {
        out.log(&format!("  {}", bold("Why requests failed (where each failure started)")));
        for f in &r.failures {
            out.log(&format!("  {} {} {} {}", yellow(&pad(&f.id, 14)), pad(&pct(f.share), 7), pad(&f.reason, 32), dim(&format!("{} requests", loc(f.requests)))));
        }
        out.log("");
    }
    out.log(&format!("  {}  p50 {}  p90 {}  p99 {}  p99.9 {}", bold("Latency (discrete-event, successful requests)"), ms(s("p50Ms")), ms(s("p90Ms")), ms(s("p99Ms")), ms(s("p999Ms"))));
    out.log(&format!("  {}\n", dim(&format!("seed {} · {} events in {} ms", js_num(gn(&v, &["seed"])), loc(s("events")), js_num(s("wallMs"))))));
}

#[allow(dead_code)]
fn _unused(_: &SimResult) {}

// ---- trace: sampled requests through one component ----

/// a discrete-event run's sampled requests through one component (`simulate --trace`, the
/// trace_request tool)
pub struct Traced {
    pub component: String,
    pub failed_only: bool,
    pub seed: f64,
    pub duration_s: f64,
    /// requests that began before this were not followed
    pub from_s: f64,
    pub requests: f64,
    pub failed_requests: f64,
    /// followed requests that went through it, and those of them that failed
    pub seen: f64,
    pub seen_failed: f64,
    /// how many of its sampled requests there were to pick from
    pub sampled: usize,
    pub journeys: Vec<crate::sim::trace::Journey>,
}

/// the id each component reaches the journeys under: the spec's own
fn component_ids(spec: &Value) -> Vec<String> {
    spec.get("components").and_then(|c| c.as_array()).map(|a| a.iter().filter_map(|c| c.get("id").and_then(|i| i.as_str()).map(String::from)).collect()).unwrap_or_default()
}

/// run the scenario on the discrete-event engine following a sample of requests, and pick `count`
/// of those through `component` (the failed ones only, if asked), spread over the run
pub fn trace_request(spec: &Value, sc: &Value, seed: f64, component: &str, failed_only: bool, count: usize) -> Result<Traced, String> {
    let ids = component_ids(spec);
    if !ids.is_empty() && !ids.iter().any(|i| i == component) {
        return Err(format!("no component \"{}\" in the architecture (its components: {})", component, ids.join(", ")));
    }
    let count = count.clamp(1, 20);
    // the first seconds start cold: follow requests from 2 s in, unless the run is short
    let from_s = if sc.get("duration").and_then(|d| d.as_f64()).map_or(true, |d| d >= 8.0) { 2.0 } else { 0.0 };
    let tc = crate::sim::trace::TraceConfig { per_node: count.max(12), from_s, ..Default::default() };
    let cfg = crate::sim::des::DesConfig { seed, trace: Some(tc), ..Default::default() };
    let r = crate::sim::des::simulate_des(spec, sc, &cfg)?;
    let report = r.trace.ok_or("the run kept no trace")?;
    let n = report.by_node.get(component);
    let list: Vec<usize> = n.map(|n| if failed_only { n.failed.clone() } else { n.all.clone() }).unwrap_or_default();
    let take = count.min(list.len());
    // spread over the run: the sample is in the order the requests began
    let journeys = (0..take).map(|k| report.journeys[list[k * list.len() / take]].clone()).collect();
    Ok(Traced {
        component: component.to_string(),
        failed_only,
        seed,
        duration_s: r.summary.duration_s,
        from_s,
        requests: r.summary.requests,
        failed_requests: r.summary.failed_requests,
        seen: n.map_or(0.0, |n| n.seen),
        seen_failed: n.map_or(0.0, |n| n.seen_failed),
        sampled: list.len(),
        journeys,
    })
}

impl Traced {
    fn none_note(&self) -> Option<String> {
        if !self.journeys.is_empty() {
            return None;
        }
        Some(if self.seen == 0.0 {
            format!("no followed request reached {}: is traffic flowing to it?", self.component)
        } else {
            format!("none of the {} followed requests through {} failed", loc(self.seen), self.component)
        })
    }

    /// the run, the journeys with their verdict and their path as lines, and how to read them
    pub fn to_json(&self) -> Value {
        let id = |s: &str| s.to_string();
        let journeys: Vec<Value> = self
            .journeys
            .iter()
            .map(|j| {
                let mut v = to_json(j);
                if let Value::Object(o) = &mut v {
                    o.insert("verdict".into(), json!(crate::sim::journey::journey_verdict(j, &id)));
                    o.insert("lines".into(), json!(crate::sim::journey::journey_lines(j, &id, Some(&self.component))));
                }
                v
            })
            .collect();
        let mut o = JMap::new();
        o.insert("component".into(), json!(self.component));
        o.insert("shown".into(), json!(if self.failed_only { "failed" } else { "all" }));
        o.insert("run".into(), json!({ "engine": "des", "seed": num(self.seed), "durationS": num(self.duration_s), "followedFromS": num(self.from_s), "requests": num(self.requests), "failedRequests": num(self.failed_requests) }));
        o.insert("through".into(), json!({ "followed": num(self.seen), "failed": num(self.seen_failed), "sampled": self.sampled }));
        if let Some(n) = self.none_note() {
            o.insert("note".into(), json!(n));
        }
        o.insert("journeys".into(), json!(journeys));
        o.insert("legend".into(), json!("Each line is one request, hop by hop: ─12ms─▶ is the network on the way and the component's own work; ══ 800ms queue ══▶ means it waited that long for a worker first; ✕ marks where it failed and why (a timeout says the caller's deadline); retries, fan-out parts and failovers branch below the hop that made them; times are ms after the request began"));
        Value::Object(o)
    }
}

fn print_trace(t: &Traced, out: &mut Out) {
    let id = |s: &str| s.to_string();
    out.log(&format!("\n{} {}", bold(&format!("Requests through {}", t.component)), dim(&format!("· discrete-event run, {}s simulated, seed {}", js_num(t.duration_s), js_num(t.seed)))));
    let failed = if t.requests > 0.0 { pct(t.failed_requests / t.requests) } else { "0%".into() };
    out.log(&format!("  {} requests, {} failed · {} followed requests went through {}, {} of them failed", loc(t.requests), failed, loc(t.seen), t.component, loc(t.seen_failed)));
    if let Some(n) = t.none_note() {
        out.log(&format!("  {}\n", yellow(&n)));
        return;
    }
    out.log(&dim(&format!("  {} of the {} {} sampled, from {}s in", t.journeys.len(), t.sampled, if t.failed_only { "failed requests" } else { "requests" }, js_num(t.from_s))));
    out.log("");
    for j in &t.journeys {
        let v = crate::sim::journey::journey_verdict(j, &id);
        out.log(&format!("{}  {}", if j.ok { green(&v) } else { red(&v) }, dim(&format!("began {} s in{}", js_to_fixed(j.at_s, 1), if j.truncated { " · cut at 64 hops" } else { "" }))));
        for row in crate::sim::journey::journey_rows(j, &id, Some(&t.component)) {
            out.log(&row.iter().map(|r| match r.c {
                "focus" => bold(&r.t),
                "arrow" | "dim" => dim(&r.t),
                "q" => yellow(&r.t),
                "bad" => red(&r.t),
                "ok" => green(&r.t),
                _ => r.t.clone(),
            }).collect::<String>());
        }
        out.log("");
    }
    out.log(&dim("─12ms─▶ network and its own work · ══ queue ══▶ waited for a worker first · ✕ where it failed"));
    out.log("");
}

// ---- validate ----

pub struct Validated {
    pub ok: bool,
    /// (level, message)
    pub issues: Vec<(&'static str, String)>,
    pub spec: Option<Value>,
}

impl Validated {
    fn to_json(&self) -> Value {
        let mut o = JMap::new();
        o.insert("ok".into(), json!(self.ok));
        o.insert("issues".into(), json!(self.issues.iter().map(|(l, m)| json!({ "level": l, "message": m })).collect::<Vec<_>>()));
        if let Some(s) = &self.spec {
            o.insert("spec".into(), s.clone());
        }
        Value::Object(o)
    }
}

const COMPONENT_KEYS: [&str; 60] = ["id", "kind", "name", "tier", "instances", "runtime", "hitRate", "limit", "batching", "retries", "retryPolicy", "timeoutMs", "breaker", "fallback", "routing", "stallRate", "stallMs", "fanout", "queueS", "autoscale", "warmupS", "writePolicy", "workingSetGb", "skew", "shards", "hotKeyShare", "ttlS", "healthCheckS", "partitions", "threads", "bulkhead", "bulkheadWaitMs", "provisioned", "prefixes", "hotRowShare", "failoverS", "burst", "maxReceives", "visibilityS", "maxConnections", "connectionS", "everyS", "batch", "batchS", "refreshS", "recall", "vectorsM", "retrieval", "edgeShare", "cpuMs", "cpuLimitMs", "lowPriorityShare", "priorityReserve", "ejectAfter", "ejectForS", "maxEjectedPercent", "capacity", "latencyMs", "costPerHour", ""];

/// the spec as the schema returns it: its keys in schema order, unknown keys dropped, "a -> b" as a pair
pub fn canonical_spec(v: &Value) -> Value {
    let o = v.as_object().cloned().unwrap_or_default();
    let mut s = JMap::new();
    s.insert("version".into(), json!(1));
    for k in ["name", "description", "pricing", "commitment"] {
        if let Some(x) = o.get(k) {
            s.insert(k.into(), x.clone());
        }
    }
    let comps: Vec<Value> = o
        .get("components")
        .and_then(|c| c.as_array())
        .map(|a| {
            a.iter()
                .map(|c| {
                    let c = c.as_object().cloned().unwrap_or_default();
                    let mut m = JMap::new();
                    for k in COMPONENT_KEYS.iter().filter(|k| !k.is_empty()) {
                        if let Some(x) = c.get(*k) {
                            if *k == "autoscale" {
                                let a = x.as_object().cloned().unwrap_or_default();
                                let mut am = JMap::new();
                                for ak in ["min", "max", "targetUtil", "warmupS", "cooldownS"] {
                                    if let Some(y) = a.get(ak) {
                                        am.insert(ak.into(), y.clone());
                                    }
                                }
                                m.insert(k.to_string(), Value::Object(am));
                            } else {
                                m.insert(k.to_string(), x.clone());
                            }
                        }
                    }
                    Value::Object(m)
                })
                .collect()
        })
        .unwrap_or_default();
    s.insert("components".into(), Value::Array(comps));
    let conns: Vec<Value> = o
        .get("connections")
        .and_then(|c| c.as_array())
        .map(|a| {
            a.iter()
                .map(|c| match c {
                    Value::String(x) => {
                        let p: Vec<&str> = x.split("->").map(|y| y.trim()).collect();
                        json!(p)
                    }
                    Value::Object(m) => {
                        let mut n = JMap::new();
                        for k in ["from", "to", "latencyMs", "calls", "carries", "replication", "reconnect"] {
                            if let Some(y) = m.get(k) {
                                n.insert(k.into(), y.clone());
                            }
                        }
                        Value::Object(n)
                    }
                    x => x.clone(),
                })
                .collect()
        })
        .unwrap_or_default();
    s.insert("connections".into(), Value::Array(conns));
    if let Some(Value::Array(zs)) = o.get("zones") {
        let zones: Vec<Value> = zs
            .iter()
            .map(|z| {
                let z = z.as_object().cloned().unwrap_or_default();
                let mut n = JMap::new();
                for k in ["id", "label", "members"] {
                    if let Some(y) = z.get(k) {
                        n.insert(k.into(), y.clone());
                    }
                }
                Value::Object(n)
            })
            .collect();
        s.insert("zones".into(), Value::Array(zones));
    }
    // sections on the board (a labelled frame around components): kept for the app, ignored by the engines
    if let Some(Value::Array(ss)) = o.get("sections") {
        let sections: Vec<Value> = ss
            .iter()
            .map(|x| {
                let x = x.as_object().cloned().unwrap_or_default();
                let mut n = JMap::new();
                for k in ["label", "members"] {
                    if let Some(y) = x.get(k) {
                        n.insert(k.into(), y.clone());
                    }
                }
                Value::Object(n)
            })
            .collect();
        s.insert("sections".into(), Value::Array(sections));
    }
    // notes on the board: kept for the app, ignored by the engines
    if let Some(Value::Array(ns)) = o.get("notes") {
        s.insert("notes".into(), Value::Array(ns.clone()));
    }
    Value::Object(s)
}

/// Levenshtein distance over UTF-16 units
fn distance(a: &str, b: &str) -> usize {
    let a: Vec<u16> = a.encode_utf16().collect();
    let b: Vec<u16> = b.encode_utf16().collect();
    let mut d = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for (i, row) in d.iter_mut().enumerate() {
        row[0] = i;
    }
    for j in 1..=b.len() {
        d[0][j] = j;
    }
    for i in 1..=a.len() {
        for j in 1..=b.len() {
            d[i][j] = (d[i - 1][j] + 1).min(d[i][j - 1] + 1).min(d[i - 1][j - 1] + if a[i - 1] == b[j - 1] { 0 } else { 1 });
        }
    }
    d[a.len()][b.len()]
}

fn show(v: &Value) -> String {
    match v {
        Value::String(s) => format!("\"{}\"", s),
        x => crate::convert::js_stringify(x),
    }
}

/// a schema error in words: which component, which field, what it was, what it should be
fn describe_issue(i: &Issue, input: &Value) -> String {
    let path: Vec<String> = i.path.iter().map(|p| match p {
        Value::String(s) => s.clone(),
        x => js_num(x.as_f64().unwrap_or(f64::NAN)),
    }).collect();
    let head = i.path.first();
    let idx = i.path.get(1).and_then(|x| x.as_u64());
    let field = path.iter().skip(2).cloned().collect::<Vec<_>>().join(".");
    let mut value: Option<&Value> = Some(input);
    for p in &i.path {
        value = match (value, p) {
            (Some(Value::Object(o)), Value::String(k)) => o.get(k),
            (Some(Value::Array(a)), Value::Number(n)) => n.as_u64().and_then(|k| a.get(k as usize)),
            _ => None,
        };
    }
    if head.and_then(|h| h.as_str()) == Some("components") {
        if let Some(idx) = idx {
            let id = input.get("components").and_then(|c| c.get(idx as usize)).and_then(|c| c.get("id"));
            let who = match id {
                Some(Value::String(s)) => format!("component \"{}\"", s),
                _ => format!("component #{}", idx + 1),
            };
            if field.is_empty() {
                return format!("{}: {}", who, i.message);
            }
            if i.code == "invalid_value" {
                if let (Some(vals), Some(Value::String(v))) = (&i.values, value) {
                    let options: Vec<String> = vals.iter().map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).collect();
                    let mut near: Vec<(usize, &String)> = options.iter().map(|o| (distance(&v.to_lowercase(), &o.to_lowercase()), o)).collect();
                    near.sort_by_key(|x| x.0);
                    let hint = near.first().filter(|n| n.0 <= 3).map(|n| format!(" — did you mean \"{}\"?", n.1)).unwrap_or_default();
                    return format!("{}: {} {} is not valid{} (one of {})", who, field, show(&Value::String(v.clone())), hint, options.join(", "));
                }
            }
            if i.code == "too_small" {
                if let Some(m) = i.minimum {
                    return format!("{}: {} must be at least {}{}", who, field, js_num(m), value.map(|v| format!(" (it is {})", show(v))).unwrap_or_default());
                }
            }
            if i.code == "too_big" {
                if let Some(m) = i.maximum {
                    return format!("{}: {} must be at most {}{}", who, field, js_num(m), value.map(|v| format!(" (it is {})", show(v))).unwrap_or_default());
                }
            }
            if i.code == "invalid_type" && value.is_none() {
                return format!("{}: {} is missing", who, field);
            }
            return format!("{}: {}: {}", who, field, i.message);
        }
    }
    if head.and_then(|h| h.as_str()) == Some("connections") {
        if let Some(idx) = idx {
            let c = input.get("connections").and_then(|c| c.get(idx as usize));
            return format!("connection {}: write it as \"from -> to\", [\"from\", \"to\"] or {{ from, to }}", c.map(show).unwrap_or_else(|| "undefined".into()));
        }
    }
    if head.and_then(|h| h.as_str()) == Some("components") && i.code == "too_small" {
        return "the spec needs at least one component".into();
    }
    let p = path.join(".");
    format!("{}: {}", if p.is_empty() { "spec" } else { &p }, i.message)
}

/// schema errors plus architectural lint (things that will silently misbehave in the simulation)
pub fn validate(input: &Value) -> Validated {
    let (arch, issues) = check_architecture(input);
    let arch = match arch {
        Some(a) => a,
        None => return Validated { ok: false, issues: issues.iter().map(|i| ("error", describe_issue(i, input))).collect(), spec: None },
    };
    let spec = canonical_spec(input);
    let mut out: Vec<(&'static str, String)> = vec![];
    let comps = &arch.components;
    let id = |c: &JMap<String, Value>| c.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let kind = |c: &JMap<String, Value>| c.get("kind").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let mut ids: IndexMap<String, usize> = IndexMap::new();
    for (i, c) in comps.iter().enumerate() {
        ids.insert(id(c), i);
    }
    let mut seen = std::collections::HashSet::new();
    for c in comps {
        if !seen.insert(id(c)) {
            out.push(("error", format!("duplicate component id \"{}\"", id(c))));
        }
    }
    let mut outs: IndexMap<String, Vec<String>> = IndexMap::new();
    let mut into: IndexMap<String, Vec<String>> = IndexMap::new();
    for (a, b, _) in &arch.connections {
        if !ids.contains_key(a) {
            out.push(("error", format!("connection from unknown component \"{}\"", a)));
        }
        if !ids.contains_key(b) {
            out.push(("error", format!("connection to unknown component \"{}\"", b)));
        }
        if a == b {
            out.push(("error", format!("\"{}\" is connected to itself", a)));
        }
        outs.entry(a.clone()).or_default().push(b.clone());
        into.entry(b.clone()).or_default().push(a.clone());
    }
    if !comps.iter().any(|c| kind(c) == "client") {
        out.push(("error", "no traffic source: add a component with kind \"client\"".into()));
    }
    let empty = vec![];
    for c in comps {
        let cid = id(c);
        let k = kind(c);
        let kids = outs.get(&cid).unwrap_or(&empty);
        let parents_ids = into.get(&cid).unwrap_or(&empty);
        let parents: Vec<Option<String>> = parents_ids.iter().map(|p| ids.get(p).map(|i| kind(&comps[*i]))).collect();
        if (k == "lb" || k == "gateway" || k == "queue" || k == "stream" || k == "dns") && kids.is_empty() {
            out.push(("error", format!("{} \"{}\" has nothing behind it — every request fails", k, cid)));
        }
        // leaves: both engines answer at these and send nothing on, so a link out of one is dead
        if !kids.is_empty() && matches!(k.as_str(), "llmapi" | "external" | "kv" | "storage" | "archive" | "search" | "vector") {
            let what = if k == "llmapi" || k == "external" { "a third-party API: it answers itself and does not call your components" } else { "a data store: it answers itself and calls nothing" };
            out.push(("warning", format!("{} \"{}\" is {} — its link{} to {} carr{} no traffic", k, cid, what, if kids.len() > 1 { "s" } else { "" }, kids.iter().map(|x| format!("\"{}\"", x)).collect::<Vec<_>>().join(", "), if kids.len() > 1 { "y" } else { "ies" })));
        }
        if (k == "cache" || k == "cdn") && kids.is_empty() {
            out.push(("warning", format!("{} \"{}\" has no origin — every miss fails", k, cid)));
        }
        let fanned = parents_ids.iter().any(|p| ids.get(p).and_then(|i| comps[*i].get("fanout")).and_then(|x| x.as_f64()).unwrap_or(1.0) > 1.0);
        let inst = c.get("instances").and_then(|x| x.as_f64()).unwrap_or(1.0);
        if inst > 1.0 && k != "llm" && !crate::sim::catalog::clustered(&k) && !fanned && !parents.iter().any(|p| matches!(p.as_deref(), Some("lb" | "gateway" | "queue" | "stream"))) {
            out.push(("warning", format!("\"{}\" has {} instances but no lb/gateway/queue in front — only one receives traffic", cid, js_num(inst))));
        }
        if k == "replica" && !parents.iter().any(|p| p.as_deref() == Some("db")) {
            out.push(("warning", format!("replica \"{}\" is not connected from a db — it will be treated as a plain server", cid)));
        }
        if k != "client" && parents_ids.is_empty() {
            out.push(("warning", format!("\"{}\" receives no traffic (nothing connects to it)", cid)));
        }
        let t = |key: &str| c.get(key).and_then(|x| x.as_bool()).unwrap_or(false);
        if t("fallback") && !t("breaker") {
            out.push(("warning", format!("\"{}\" has fallback without breaker — fallback only applies while a breaker is open", cid)));
        }
        if c.get("bulkheadWaitMs").and_then(|x| x.as_f64()).unwrap_or(0.0) > 0.0 && c.get("bulkhead").is_none() {
            out.push(("warning", format!("\"{}\" has bulkheadWaitMs without bulkhead — the wait only applies to calls past a bulkhead", cid)));
        }
    }
    for (zid, _, members) in &arch.zones {
        for m in members {
            if !ids.contains_key(m) {
                out.push(("error", format!("zone \"{}\" lists unknown member \"{}\"", zid, m)));
            }
        }
    }
    for (label, members) in &arch.sections {
        for m in members {
            if !ids.contains_key(m) {
                out.push(("warning", format!("section \"{}\" lists unknown member \"{}\"", label, m)));
            }
        }
    }
    Validated { ok: !out.iter().any(|i| i.0 == "error"), issues: out, spec: Some(spec) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_link_out_of_a_leaf_is_flagged() {
        let v = validate(&json!({ "components": [{ "id": "users", "kind": "client" }, { "id": "pay", "kind": "external" }, { "id": "app", "kind": "server" }, { "id": "kv", "kind": "kv" }], "connections": ["users -> pay", "pay -> app", "users -> kv", "kv -> app"] }));
        assert!(v.ok);
        let msgs: Vec<&str> = v.issues.iter().map(|i| i.1.as_str()).collect();
        assert!(msgs.contains(&"external \"pay\" is a third-party API: it answers itself and does not call your components — its link to \"app\" carries no traffic"), "{:?}", msgs);
        assert!(msgs.iter().any(|m| m.starts_with("kv \"kv\" is a data store")), "{:?}", msgs);
    }

    #[test]
    fn sections_round_trip_and_an_unknown_member_is_only_a_warning() {
        let spec = json!({ "components": [{ "id": "users", "kind": "client" }, { "id": "api", "kind": "server" }], "connections": ["users -> api"], "sections": [{ "label": "front", "members": ["users", "api", "gone"] }] });
        let canon = canonical_spec(&spec);
        assert_eq!(canon["sections"], json!([{ "label": "front", "members": ["users", "api", "gone"] }]));
        let (arch, issues) = check_architecture(&spec);
        assert!(issues.is_empty());
        assert_eq!(crate::sim::spec::to_value(&arch.unwrap())["sections"], spec["sections"]);
        let v = validate(&spec);
        assert!(v.ok);
        assert!(v.issues.iter().any(|i| i.0 == "warning" && i.1 == "section \"front\" lists unknown member \"gone\""), "{:?}", v.issues);
        let (_, bad) = check_architecture(&json!({ "components": [{ "id": "users", "kind": "client" }], "connections": [], "sections": [{ "members": [1] }] }));
        assert_eq!(bad.len(), 2);
    }
}
