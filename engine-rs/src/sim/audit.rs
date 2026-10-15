//! Failure audit (src/sim/audit.ts) — "what breaks first, and what it costs". The architecture runs at
//! its expected load, then the same minute replays once per thing that can go wrong: every component
//! dying (one instance of a fleet, or the whole thing), every zone going dark, every dependency turning
//! slow or erroring, every cache going cold, a traffic surge, and the load ramp to the breaking point.
//! Each incident is graded by what users saw; for the serious ones, candidate fixes are generated,
//! verified by re-running the same incident, and priced.

use super::catalog::spec as kind_spec;
use super::headless::{breaking_point_parsed, load_curve_parsed, simulate_parsed, BreakingOptions, CurvePoint, SimOptions, SimResult, SloOut};
use super::spec::{apply_variant, parse_scenario, Architecture};
use crate::backtest::{js_max, js_sort_by};
use crate::math::{js_num, js_round, js_to_fixed};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map as JMap, Value};

const FAULT_AT: f64 = 10.0;
const CLEAR_AT: f64 = 40.0;
const END: f64 = 60.0;
const TIERS: [&str; 3] = ["S", "M", "L"];

fn sev_rank(s: &str) -> f64 {
    match s {
        "critical" => 3.0,
        "major" => 2.0,
        "minor" => 1.0,
        _ => 0.0,
    }
}

fn r3(n: f64) -> f64 {
    js_round(n * 1000.0) / 1000.0
}

fn label_of(kind: &str) -> &'static str {
    match kind {
        "client" => "Users",
        "cdn" => "CDN",
        "lb" => "Load Balancer",
        "gateway" => "API Gateway",
        "server" => "API Server",
        "worker" => "Worker",
        "function" => "Serverless Fn",
        "cache" => "Cache",
        "db" => "Database",
        "replica" => "Read Replica",
        "storage" => "Object Storage",
        "queue" => "Queue",
        "llm" => "GPU Inference",
        "llmapi" => "LLM Provider API",
        "external" => "External API",
        "kv" => "Key-Value Store",
        "dns" => "DNS",
        "stream" => "Stream",
        "search" => "Search Index",
        "vector" => "Vector Database",
        "archive" => "Archive Storage",
        _ => "Component",
    }
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuditOptions {
    pub rps: Option<f64>,
    pub read_ratio: Option<f64>,
    pub slo: Option<Value>,
    pub incident_cost_per_minute: Option<f64>,
    pub fixes: Option<bool>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Impact {
    pub error_rate: f64,
    pub peak_error_rate: f64,
    pub peak_p99_ms: f64,
    pub failed_requests: f64,
    pub breach_s: f64,
    pub self_heal_s: Option<f64>,
    pub recovery_s: Option<f64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct After {
    pub severity: String,
    pub error_rate: f64,
    pub peak_p99_ms: f64,
    pub failed_requests: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Fix {
    pub title: String,
    pub why: String,
    pub changes: Vec<Value>,
    pub monthly_delta: f64,
    pub after: After,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub id: String,
    pub kind: String,
    pub target: String,
    pub title: String,
    pub severity: String,
    pub impact: Impact,
    pub blast_radius: Vec<String>,
    pub explanation: String,
    pub cost_at_risk: Option<f64>,
    pub fixes: Vec<Fix>,
    pub scenario: Value,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Load {
    pub rps: f64,
    pub read_ratio: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Baseline {
    pub error_rate: f64,
    pub p99_ms: f64,
    pub cost_per_hour: f64,
    pub monthly: f64,
    pub meets_slo: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Headroom {
    pub max_rps: f64,
    pub limited_by: Option<String>,
    pub note: Option<String>,
    pub ratio: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuditResult {
    pub architecture: String,
    pub load: Load,
    pub slo: SloOut,
    pub baseline: Baseline,
    pub headroom: Headroom,
    pub score: f64,
    /// what the design's structure promises in a year: redundancy vs single points of failure
    pub availability: super::availability::Availability,
    pub survived: f64,
    pub total: f64,
    pub findings: Vec<Finding>,
    pub curve: Vec<CurvePoint>,
    pub wall_ms: f64,
}

struct Incident {
    id: String,
    kind: &'static str,
    target: String,
    title: String,
    events: Vec<Value>,
    traffic: Option<Vec<(f64, f64)>>,
}

struct Cand {
    title: String,
    why: String,
    changes: Vec<Value>,
}

fn avg(xs: &[f64]) -> f64 {
    if xs.is_empty() {
        0.0
    } else {
        xs.iter().fold(0.0, |s, x| s + x) / xs.len() as f64
    }
}

/// $/month from $/h; differences under $5 are simulation noise (autoscaled fleets), not a cost
fn monthly(per_hour: f64) -> f64 {
    if (per_hour * 730.0).abs() < 5.0 {
        0.0
    } else {
        js_round(per_hour * 730.0)
    }
}

fn get_str<'a>(c: &'a JMap<String, Value>, k: &str) -> Option<&'a str> {
    c.get(k).and_then(|x| x.as_str())
}
fn get_num(c: &JMap<String, Value>, k: &str) -> Option<f64> {
    c.get(k).and_then(|x| x.as_f64())
}

fn measure(r: &SimResult, slo: (f64, f64), base: &SimResult) -> Impact {
    let ok = |x: &super::headless::Point| x.error_rate <= slo.0 && x.p99_ms <= slo.1;
    // incidents are judged relative to normal: a design already out of SLO only counts what got worse
    let bt = &base.timeline;
    let base_err = avg(&bt[bt.len().saturating_sub(10)..].iter().map(|x| x.error_rate).collect::<Vec<_>>());
    let during: Vec<&super::headless::Point> = r.timeline.iter().filter(|x| x.t > FAULT_AT && x.t <= CLEAR_AT).collect();
    let after: Vec<&super::headless::Point> = r.timeline.iter().filter(|x| x.t > CLEAR_AT).collect();
    let window: Vec<&super::headless::Point> = r.timeline.iter().filter(|x| x.t > FAULT_AT).collect();
    let mut self_heal = None;
    match during.iter().position(|x| !ok(x)) {
        None => self_heal = Some(0.0),
        Some(first) => {
            let mut i = first;
            while i + 2 < during.len() {
                if ok(during[i]) && ok(during[i + 1]) && ok(during[i + 2]) {
                    self_heal = Some(js_round(during[i].t - FAULT_AT));
                    break;
                }
                i += 1;
            }
        }
    }
    let mut recovery = None;
    let mut i = 0;
    while i + 2 < after.len() {
        if ok(after[i]) && ok(after[i + 1]) && ok(after[i + 2]) {
            recovery = Some(js_round(after[i].t - CLEAR_AT));
            break;
        }
        i += 1;
    }
    Impact {
        error_rate: r3((avg(&during.iter().map(|x| x.error_rate).collect::<Vec<_>>()) - base_err).max(0.0)),
        peak_error_rate: r3(js_max(0.0, window.iter().map(|x| x.error_rate))),
        peak_p99_ms: js_round(js_max(0.0, window.iter().map(|x| x.p99_ms))),
        failed_requests: js_round(window.iter().fold(0.0, |s, x| s + x.rps * (x.error_rate - base_err).max(0.0))),
        breach_s: window.iter().filter(|x| !ok(x)).count() as f64,
        self_heal_s: self_heal,
        recovery_s: recovery,
    }
}

fn grade(i: &Impact, kind: &str) -> &'static str {
    let persistent = kind != "cold-cache" && kind != "surge";
    if i.recovery_s.is_none() && i.breach_s > 3.0 {
        return "critical"; // never came back
    }
    if i.error_rate >= 0.25 {
        return "critical";
    }
    if i.breach_s == 0.0 {
        return "ok";
    }
    // healing on its own within a few seconds (failover, autoscaling) is a blip, not an outage
    if persistent && matches!(i.self_heal_s, Some(s) if s <= 8.0) && i.error_rate < 0.05 {
        return "minor";
    }
    if i.breach_s <= 3.0 {
        return "minor";
    }
    "major"
}

fn blast(r: &SimResult, target: &str) -> Vec<String> {
    let mut v: Vec<(&String, &super::headless::ComponentReport)> = r.components.iter().filter(|(id, c)| *id != target && c.kind != "client" && (c.dropped_total > 0.0 || c.peak_util >= 0.95)).collect();
    js_sort_by(&mut v, |a, b| b.1.dropped_total - a.1.dropped_total);
    v.into_iter().map(|(id, _)| id.clone()).collect()
}

fn explain_incident(inc: &Incident, i: &Impact, r: &SimResult, sev: &str, nm: &dyn Fn(&str) -> String) -> String {
    let pct = |x: f64| format!("{}%", js_to_fixed(x * 100.0, if x < 0.01 { 2 } else { 1 }));
    let mut parts: Vec<String> = vec![];
    if sev == "ok" {
        parts.push(format!("Absorbed: users stayed within SLO{}.", if i.peak_p99_ms != 0.0 { format!(" (p99 peaked at {} ms)", js_num(i.peak_p99_ms)) } else { String::new() }));
    } else {
        parts.push(format!(
            "{} of requests failed while it lasted (peak {}), p99 up to {}.",
            pct(i.error_rate),
            pct(i.peak_error_rate),
            if i.peak_p99_ms >= 1000.0 { format!("{} s", js_to_fixed(i.peak_p99_ms / 1000.0, 1)) } else { format!("{} ms", js_num(i.peak_p99_ms)) }
        ));
        if inc.kind == "surge" {
            if let Some(h) = i.self_heal_s.filter(|h| *h > 24.0) {
                parts.push(format!("Back within SLO {} s after the surge ended.", js_num(h - 24.0)));
            }
        } else if let Some(h) = i.self_heal_s.filter(|h| *h > 0.0) {
            parts.push(if inc.kind == "cold-cache" { format!("Recovered in {} s as the cache re-warmed.", js_num(h)) } else { format!("Healed by itself after {} s.", js_num(h)) });
        }
        match i.recovery_s {
            None => parts.push("Did not recover after the fault was cleared — a metastable failure: the system stays overloaded by its own retries or backlog.".into()),
            Some(rs) if rs > 3.0 => parts.push(format!("Took {} s to recover after the fault was cleared.", js_num(rs))),
            _ => {}
        }
    }
    let top = r.bottlenecks.iter().find(|b| b.id != inc.target && b.note.as_ref().map(|n| !n.starts_with("Scaling out")).unwrap_or(false));
    if sev != "ok" {
        if let Some(t) = top {
            parts.push(format!("Knock-on: {} — {}", nm(&t.id), t.note.clone().unwrap()));
        }
    }
    parts.join(" ")
}

fn unique_id(a: &Architecture, base: &str) -> String {
    let mut id = base.to_string();
    let mut i = 2;
    while a.components.iter().any(|c| get_str(c, "id") == Some(id.as_str())) {
        id = format!("{}-{}", base, i);
        i += 1;
    }
    id
}

fn set(id: &str, fields: Value) -> Value {
    json!({ "op": "set", "id": id, "fields": fields })
}

fn capacity_fixes(c: Option<&JMap<String, Value>>, nm: &dyn Fn(&str) -> String) -> Vec<Cand> {
    let c = match c {
        Some(c) => c,
        None => return vec![],
    };
    let kind = get_str(c, "kind").unwrap_or("server");
    let id = get_str(c, "id").unwrap_or("");
    let mut out = vec![];
    if kind_spec(kind).scalable {
        let n = get_num(c, "instances").unwrap_or(1.0);
        out.push(Cand { title: format!("Scale {} to {} instances", nm(id), js_num(n * 2.0)), why: "Double the fleet.".into(), changes: vec![set(id, json!({ "instances": n * 2.0 }))] });
    }
    if kind_spec(kind).tiered {
        let i = TIERS.iter().position(|t| Some(*t) == get_str(c, "tier").or(Some("S"))).unwrap_or(0);
        if i < TIERS.len() - 1 {
            out.push(Cand { title: format!("Size {} up to {}", nm(id), TIERS[i + 1]), why: "Bigger instance class: about twice the throughput.".into(), changes: vec![set(id, json!({ "tier": TIERS[i + 1] }))] });
        }
    }
    if kind == "gateway" || kind == "function" || kind == "llmapi" || kind == "kv" {
        let lim = js_round(get_num(c, "limit").unwrap_or(kind_spec(kind).capacity) * 2.0);
        out.push(Cand { title: format!("Raise {} limit to {}/s", nm(id), js_num(lim)), why: "The limit, not the hardware, is what fails first.".into(), changes: vec![set(id, json!({ "limit": lim }))] });
    }
    out
}

fn autoscale_fix(c: Option<&JMap<String, Value>>, nm: &dyn Fn(&str) -> String) -> Vec<Cand> {
    let c = match c {
        Some(c) => c,
        None => return vec![],
    };
    let kind = get_str(c, "kind").unwrap_or("server");
    if !kind_spec(kind).scalable || c.get("autoscale").map(|v| !v.is_null()).unwrap_or(false) {
        return vec![];
    }
    let id = get_str(c, "id").unwrap_or("");
    let n = get_num(c, "instances").unwrap_or(1.0);
    vec![Cand {
        title: format!("Autoscale {} ({}–{}, 15 s warm-up)", nm(id), js_num(n), js_num(n * 4.0)),
        why: "Pay for the surge only while it lasts — as long as capacity arrives fast enough.".into(),
        changes: vec![set(id, json!({ "autoscale": { "min": n, "max": n * 4.0, "warmupS": 15, "cooldownS": 60 } }))],
    }]
}

fn candidate_fixes(inc: &Incident, a: &Architecture, nm: &dyn Fn(&str) -> String) -> Vec<Cand> {
    let by_id = |id: &str| a.components.iter().find(|c| get_str(c, "id") == Some(id));
    let parents = |id: &str| a.connections.iter().filter(|(_, b, _)| b == id).map(|(x, _, _)| x.clone()).collect::<Vec<_>>();
    let children = |id: &str| a.connections.iter().filter(|(x, _, _)| x == id).map(|(_, b, _)| b.clone()).collect::<Vec<_>>();
    let c = by_id(&inc.target);
    let mut out: Vec<Cand> = vec![];
    if inc.kind == "surge" {
        let mut v = capacity_fixes(c, nm);
        v.extend(autoscale_fix(c, nm));
        return v;
    }
    let c = match c {
        Some(c) => c,
        None => return out,
    };
    let kind = get_str(c, "kind").unwrap_or("server");
    let id = get_str(c, "id").unwrap_or("").to_string();
    let ps = parents(&id);
    let ks = children(&id);
    if inc.kind == "component" || inc.kind == "instance" {
        if kind_spec(kind).scalable {
            let fed = ps.iter().any(|p| matches!(by_id(p).and_then(|x| get_str(x, "kind")), Some("lb") | Some("gateway") | Some("queue") | Some("stream")));
            let n = get_num(c, "instances").unwrap_or(1.0);
            if fed {
                out.push(Cand { title: format!("Run {} × {}", js_num(n + 1.0), nm(&id)), why: "One more instance than the load needs (N+1): losing one leaves enough capacity.".into(), changes: vec![set(&id, json!({ "instances": n + 1.0 }))] });
            } else {
                let lb = unique_id(a, &format!("{}-lb", id));
                let mut changes = vec![json!({ "op": "add", "component": { "id": lb, "kind": "lb", "name": format!("{}-lb", nm(&id)) } })];
                for p in &ps {
                    changes.push(json!({ "op": "disconnect", "from": p, "to": id }));
                    changes.push(json!({ "op": "connect", "from": p, "to": lb }));
                }
                changes.push(json!({ "op": "connect", "from": lb, "to": id }));
                changes.push(set(&id, json!({ "instances": (n + 1.0).max(2.0) })));
                out.push(Cand { title: format!("Put {} behind a load balancer with {} instances", nm(&id), js_num((n + 1.0).max(2.0))), why: "Without a load balancer callers know one address; with one, a dead instance is routed around.".into(), changes });
            }
        } else if kind == "db" {
            let has_replica = ks.iter().any(|k| by_id(k).and_then(|x| get_str(x, "kind")) == Some("replica"));
            if !has_replica {
                let rep = unique_id(a, &format!("{}-replica", id));
                let mut comp = json!({ "id": rep, "kind": "replica", "name": format!("{}-replica", nm(&id)) });
                if let Some(t) = c.get("tier") {
                    comp["tier"] = t.clone();
                }
                // a replica per shard: it has to hold (and serve) everything the primary does
                if let Some(sh) = c.get("shards") {
                    comp["shards"] = sh.clone();
                }
                out.push(Cand { title: format!("Add a read replica to {}", nm(&id)), why: "A replica serves reads and is promoted to primary in seconds when the primary dies.".into(), changes: vec![json!({ "op": "add", "component": comp }), json!({ "op": "connect", "from": id, "to": rep })] });
            }
        } else if (kind == "cache" || kind == "cdn") && !ks.is_empty() {
            // callers bypass a dead cache and go straight to its origin
            let mut changes = vec![];
            for p in &ps {
                changes.push(set(p, json!({ "routing": "failover" })));
                let pc = children(p);
                for k in &ks {
                    if !pc.contains(k) {
                        changes.push(json!({ "op": "connect", "from": p, "to": k }));
                    }
                }
            }
            out.push(Cand { title: format!("Bypass {} when it is down", nm(&id)), why: "Callers fail over to the origin instead of failing — the cache is an optimisation, not a dependency.".into(), changes });
        } else if kind != "client" {
            let twin = unique_id(a, &format!("{}-b", id));
            // { ...rest, id: twin, name }: id moves to the end, a name keeps its place
            let mut comp = c.clone();
            comp.shift_remove("id");
            comp.insert("id".into(), json!(twin));
            comp.insert("name".into(), json!(format!("{}-standby", nm(&id))));
            let mut changes = vec![json!({ "op": "add", "component": Value::Object(comp) })];
            for p in &ps {
                changes.push(json!({ "op": "connect", "from": p, "to": twin }));
                changes.push(set(p, json!({ "routing": "failover" })));
            }
            for k in &ks {
                changes.push(json!({ "op": "connect", "from": twin, "to": k }));
            }
            out.push(Cand { title: format!("Run a standby {}", nm(&id)), why: format!("A second {} that callers fail over to.", label_of(kind).to_lowercase()), changes });
        }
    }
    if inc.kind == "zone" {
        // a DNS name in front: users keep failing until its checks notice and its caches expire
        for d in a.components.iter().filter(|c| get_str(c, "kind") == Some("dns")) {
            if get_num(d, "ttlS").unwrap_or(60.0) > 5.0 || get_num(d, "healthCheckS").unwrap_or(30.0) > 10.0 {
                let id = get_str(d, "id").unwrap_or("").to_string();
                out.push(Cand { title: format!("Shorter TTL (5 s) and faster health checks (10 s) on {}", nm(&id)), why: "Failover through DNS waits for the health checks, then for every cached answer to expire.".into(), changes: vec![set(&id, json!({ "ttlS": 5, "healthCheckS": 10 }))] });
            }
        }
        if let Some(z) = a.zones.iter().find(|z| z.0 == inc.target) {
            for m in &z.2 {
                if let Some(mc) = by_id(m) {
                    if kind_spec(get_str(mc, "kind").unwrap_or("")).scalable {
                        out.push(Cand { title: format!("Add {} capacity outside {}", nm(m), inc.target), why: "Instances outside the failed zone keep serving.".into(), changes: vec![set(m, json!({ "instances": get_num(mc, "instances").unwrap_or(1.0) * 2.0 }))] });
                    }
                }
            }
        }
    }
    if inc.kind == "slow" || inc.kind == "errors" {
        for p in &ps {
            if by_id(p).is_none() {
                continue;
            }
            let fields = if inc.kind == "slow" { json!({ "timeoutMs": 200, "breaker": true, "fallback": true }) } else { json!({ "retries": 2, "retryPolicy": "budget", "breaker": true, "fallback": true }) };
            out.push(Cand {
                title: if inc.kind == "slow" { format!("Timeout + circuit breaker with fallback on {} → {}", p, id) } else { format!("Retry budget + circuit breaker with fallback on {}", p) },
                why: if inc.kind == "slow" { "Give up quickly on the slow dependency and serve a degraded answer instead of tying up workers.".into() } else { "Retry the occasional failure (within a 10 % budget so retries cannot snowball), cut off a dependency that keeps failing.".into() },
                changes: vec![set(p, fields)],
            });
            // a thread-per-request caller with other dependencies: the slow one must not take every thread
            if inc.kind == "slow" {
                let pc = by_id(p).unwrap();
                let calls = a.connections.iter().filter(|(f, _, _)| f == p).count() as f64;
                if let (Some(t), true) = (get_num(pc, "threads"), calls > 1.0) {
                    if get_num(pc, "bulkhead").is_none() {
                        let b = (t / calls).floor().max(5.0);
                        out.push(Cand { title: format!("Bulkhead of {} threads per dependency on {}", js_num(b), nm(p)), why: format!("{} holds a thread while it waits: without a limit the slow dependency takes all of them, and calls to the others fail too.", nm(p)), changes: vec![set(p, json!({ "bulkhead": b }))] });
                        out.push(Cand {
                            title: format!("Bulkhead ({} per dependency) + timeout + breaker with fallback on {}", js_num(b), nm(p)),
                            why: format!("The slow dependency gets at most {} of {}'s threads, the rest keep serving; its own calls give up after 200 ms and are answered by a fallback while the breaker is open.", js_num(b), nm(p)),
                            changes: vec![set(p, json!({ "bulkhead": b, "timeoutMs": 200, "breaker": true, "fallback": true }))],
                        });
                    }
                }
            }
            if inc.kind == "errors" {
                out.push(Cand { title: format!("2 retries with backoff on {}", nm(p)), why: "Most transient errors succeed on a second try; backoff with jitter spreads the extra load.".into(), changes: vec![set(p, json!({ "retries": 2, "retryPolicy": "backoff" }))] });
                out.push(Cand { title: format!("Retry budget on {}", nm(p)), why: "Transient errors are retried; a 10 % budget stops retries from multiplying load.".into(), changes: vec![set(p, json!({ "retries": 2, "retryPolicy": "budget" }))] });
            }
        }
    }
    if inc.kind == "hot-key" {
        // the hot key's reads answered from memory: a cache between the callers and the database
        let cache = unique_id(a, &format!("{}-cache", id));
        let mut changes = vec![json!({ "op": "add", "component": { "id": cache, "kind": "cache", "name": format!("{}-cache", nm(&id)) } })];
        for p in &ps {
            changes.push(json!({ "op": "disconnect", "from": p, "to": id }));
            changes.push(json!({ "op": "connect", "from": p, "to": cache }));
        }
        changes.push(json!({ "op": "connect", "from": cache, "to": id }));
        out.push(Cand { title: format!("Cache in front of {}", nm(&id)), why: "A hot key is one key: more shards cannot split it, but a cache answers its reads from memory.".into(), changes });
        for f in capacity_fixes(Some(c), nm) {
            out.push(Cand { why: format!("{} Every shard grows, so the hot one does too.", f.why), ..f });
        }
    }
    if inc.kind == "cold-cache" {
        for k in &ks {
            for f in capacity_fixes(by_id(k), nm) {
                out.push(Cand { why: format!("{} The origin must survive the misses of a cold cache.", f.why), ..f });
            }
        }
        out.push(Cand { title: format!("Warm {} faster", nm(&id)), why: "Pre-warm on restart (load hot keys) so the stampede is short.".into(), changes: vec![set(&id, json!({ "warmupS": 5 }))] });
    }
    out
}

fn now_ms() -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        js_sys::Date::now()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
    }
}

pub fn audit(input: &Architecture, o: &AuditOptions, progress: &mut dyn FnMut(f64, f64, &str)) -> Result<AuditResult, String> {
    let t0 = now_ms();
    let slo = (o.slo.as_ref().and_then(|s| s.get("maxErrorRate")).and_then(|x| x.as_f64()).unwrap_or(0.01), o.slo.as_ref().and_then(|s| s.get("maxP99Ms")).and_then(|x| x.as_f64()).unwrap_or(300.0));
    let slo_v = json!({ "maxErrorRate": slo.0, "maxP99Ms": slo.1 });
    let read_ratio = o.read_ratio.unwrap_or(0.8);
    let bo = BreakingOptions { read_ratio: Some(read_ratio), slo: Some(slo_v.clone()), hold_s: None, max_rps: None, cfg: None };
    let bp0 = breaking_point_parsed(input, &bo);
    let rps = o.rps.unwrap_or_else(|| js_round(bp0.max_rps * 0.5).max(10.0));
    let so = SimOptions::default();
    let sim = |a: &Architecture, sc: Value| -> Result<SimResult, String> { Ok(simulate_parsed(a, &parse_scenario(&sc)?, &so)) };
    // autoscaled fleets are audited at the size they settle at for this load, not at their minimum
    let mut spec = input.clone();
    let autoscaled = input.components.iter().any(|c| c.get("autoscale").map(|v| !v.is_null()).unwrap_or(false));
    if autoscaled {
        let warm = sim(input, json!({ "duration": 120, "rps": rps, "readRatio": read_ratio, "slo": slo_v }))?;
        for c in spec.components.iter_mut() {
            let id = get_str(c, "id").unwrap_or("").to_string();
            if c.get("autoscale").map(|v| !v.is_null()).unwrap_or(false) {
                if let Some(n) = warm.components.get(&id).and_then(|x| x.instances).filter(|n| *n != 0.0) {
                    c.insert("instances".into(), json!(n));
                }
            }
        }
    }
    let bp = if autoscaled { breaking_point_parsed(&spec, &bo) } else { bp0 };
    let name_of = |id: &str| -> String { spec.components.iter().find(|c| get_str(c, "id") == Some(id)).and_then(|c| get_str(c, "name")).unwrap_or(id).to_string() };
    let nm: &dyn Fn(&str) -> String = &name_of;

    let scenario_for = |inc: &Incident| -> Value {
        let mut s = json!({ "name": inc.title, "duration": END, "readRatio": read_ratio, "slo": slo_v });
        match &inc.traffic {
            Some(t) => s["traffic"] = Value::Array(t.iter().map(|(at, r)| json!({ "at": at, "rps": r })).collect()),
            None => s["rps"] = json!(rps),
        }
        s["events"] = json!(inc.events);
        s
    };
    let base = sim(&spec, json!({ "name": "expected load", "duration": 30, "rps": rps, "readRatio": read_ratio, "slo": slo_v }))?;
    let base_cost = base.summary.mean_cost_per_hour;
    let bt = &base.timeline[base.timeline.len().saturating_sub(10)..];
    let berr = avg(&bt.iter().map(|x| x.error_rate).collect::<Vec<_>>());
    let bp99 = avg(&bt.iter().map(|x| x.p99_ms).collect::<Vec<_>>());
    let baseline = Baseline { error_rate: r3(berr), p99_ms: js_round(bp99), cost_per_hour: r3(base_cost), monthly: js_round(base_cost * 730.0), meets_slo: berr <= slo.0 && bp99 <= slo.1 };

    // ---- the incident catalogue ----
    let mut incidents: Vec<Incident> = vec![];
    let fault = |action: Value, restore: Value| vec![json!({ "at": FAULT_AT, "action": action }), json!({ "at": CLEAR_AT, "action": restore })];
    for c in &spec.components {
        let kind = get_str(c, "kind").unwrap_or("server");
        if kind == "client" {
            continue;
        }
        let id = get_str(c, "id").unwrap_or("").to_string();
        let n = get_num(c, "instances").or(c.get("autoscale").and_then(|a| a.get("min")).and_then(|x| x.as_f64())).unwrap_or(1.0);
        if kind_spec(kind).scalable && n > 1.0 {
            incidents.push(Incident { id: format!("instance:{}", id), kind: "instance", target: id.clone(), title: format!("one {} instance dies", nm(&id)), events: fault(json!({ "type": "kill-id", "id": id }), json!({ "type": "revive-id", "id": id })), traffic: None });
        } else {
            incidents.push(Incident { id: format!("component:{}", id), kind: "component", target: id.clone(), title: format!("{} goes down", nm(&id)), events: fault(json!({ "type": "kill-id", "id": id }), json!({ "type": "revive-id", "id": id })), traffic: None });
        }
        if kind == "cache" || kind == "cdn" {
            incidents.push(Incident { id: format!("cold:{}", id), kind: "cold-cache", target: id.clone(), title: format!("{} restarts cold", nm(&id)), events: vec![json!({ "at": FAULT_AT, "action": { "type": "flush-cache", "id": id } })], traffic: None });
        }
        if kind == "kv" || kind == "storage" || (kind == "db" && get_num(c, "shards").unwrap_or(1.0) > 1.0) {
            incidents.push(Incident { id: format!("hot:{}", id), kind: "hot-key", target: id.clone(), title: format!("{}: 30% of traffic on one key", nm(&id)), events: fault(json!({ "type": "hot-key", "id": id, "share": 0.3 }), json!({ "type": "hot-key", "id": id, "share": 0 })), traffic: None });
        }
        if kind != "lb" && kind != "queue" && kind != "stream" && kind != "dns" {
            incidents.push(Incident { id: format!("slow:{}", id), kind: "slow", target: id.clone(), title: format!("{} turns slow (+250 ms)", nm(&id)), events: fault(json!({ "type": "inject-latency", "id": id, "ms": 250 }), json!({ "type": "restore", "id": id })), traffic: None });
            // a caller that holds a thread while it waits: a dependency that stalls for seconds is what
            // exhausts its pool, and takes down calls that never touch it
            let held = spec.connections.iter().filter(|(_, t, _)| *t == id).any(|(f, _, _)| spec.components.iter().any(|x| get_str(x, "id") == Some(f.as_str()) && get_num(x, "threads").is_some()));
            if held {
                incidents.push(Incident { id: format!("stall:{}", id), kind: "slow", target: id.clone(), title: format!("{} stalls (+2 s)", nm(&id)), events: fault(json!({ "type": "inject-latency", "id": id, "ms": 2000 }), json!({ "type": "restore", "id": id })), traffic: None });
            }
        }
        if kind != "lb" && kind != "queue" && kind != "stream" && kind != "dns" && kind != "cdn" {
            incidents.push(Incident { id: format!("errors:{}", id), kind: "errors", target: id.clone(), title: format!("{} fails 20% of requests", nm(&id)), events: fault(json!({ "type": "inject-errors", "id": id, "rate": 0.2 }), json!({ "type": "restore", "id": id })), traffic: None });
        }
    }
    for z in &spec.zones {
        incidents.push(Incident { id: format!("zone:{}", z.0), kind: "zone", target: z.0.clone(), title: format!("zone {} goes dark", z.1.clone().unwrap_or_else(|| z.0.clone())), events: fault(json!({ "type": "fail-zone", "id": z.0 }), json!({ "type": "restore-zone", "id": z.0 })), traffic: None });
    }
    incidents.push(Incident {
        id: "surge".into(),
        kind: "surge",
        target: bp.limited_by.clone().unwrap_or_else(|| "traffic".into()),
        title: "traffic surges 3× for 20 s".into(),
        events: vec![],
        traffic: Some(vec![(0.0, rps), (FAULT_AT, rps), (FAULT_AT + 2.0, rps * 3.0), (FAULT_AT + 22.0, rps * 3.0), (FAULT_AT + 24.0, rps), (END, rps)]),
    });

    let total = (incidents.len() + 1) as f64;
    let mut done = 0.0;
    let mut findings: Vec<Finding> = vec![];
    let fixes_on = o.fixes != Some(false);
    for inc in &incidents {
        let r = sim(&spec, scenario_for(inc))?;
        let impact = measure(&r, slo, &base);
        let severity = grade(&impact, inc.kind);
        let mut f = Finding {
            id: inc.id.clone(),
            kind: inc.kind.into(),
            target: inc.target.clone(),
            title: inc.title.clone(),
            severity: severity.into(),
            blast_radius: blast(&r, &inc.target),
            explanation: explain_incident(inc, &impact, &r, severity, nm),
            // failed requests expressed as minutes of full outage, priced
            cost_at_risk: o.incident_cost_per_minute.filter(|x| *x != 0.0).map(|c| js_round((impact.failed_requests / (rps * 60.0)) * c)),
            fixes: vec![],
            scenario: scenario_for(inc),
            impact,
        };
        if fixes_on && sev_rank(severity) >= 2.0 {
            for cand in candidate_fixes(inc, &spec, nm) {
                let variant = match apply_variant(&spec, &json!({ "name": cand.title, "changes": cand.changes })) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let after = measure(&sim(&variant, scenario_for(inc))?, slo, &base);
                let sev_after = grade(&after, inc.kind);
                let better = sev_rank(sev_after) < sev_rank(severity) || after.failed_requests < f.impact.failed_requests * 0.5;
                if !better {
                    continue;
                }
                let cost = sim(&variant, json!({ "duration": 20, "rps": rps, "readRatio": read_ratio, "slo": slo_v }))?.summary.mean_cost_per_hour;
                f.fixes.push(Fix { title: cand.title, why: cand.why, changes: cand.changes, monthly_delta: monthly(cost - base_cost), after: After { severity: sev_after.into(), error_rate: after.error_rate, peak_p99_ms: after.peak_p99_ms, failed_requests: after.failed_requests } });
            }
            js_sort_by(&mut f.fixes, |a, b| {
                let d = sev_rank(&a.after.severity) - sev_rank(&b.after.severity);
                if d != 0.0 {
                    d
                } else {
                    a.monthly_delta - b.monthly_delta
                }
            });
            f.fixes.truncate(3);
        }
        findings.push(f);
        done += 1.0;
        progress(done, total, &inc.title);
    }

    // ---- headroom ----
    let ratio = bp.max_rps / rps.max(1.0);
    let headroom_sev = if ratio < 1.0 { "critical" } else if ratio < 1.5 { "major" } else if ratio < 2.0 { "minor" } else { "ok" };
    let mut headroom = Finding {
        id: "headroom".into(),
        kind: "headroom".into(),
        target: bp.limited_by.clone().unwrap_or_else(|| "—".into()),
        title: format!("load ramps past {} req/s", js_num(js_round(bp.max_rps))),
        severity: headroom_sev.into(),
        impact: Impact { error_rate: 0.0, peak_error_rate: 0.0, peak_p99_ms: 0.0, failed_requests: 0.0, breach_s: 0.0, self_heal_s: None, recovery_s: None },
        blast_radius: bp.limited_by.iter().cloned().collect(),
        explanation: match &bp.limited_by {
            Some(l) => format!(
                "Sustains {} req/s within SLO — {}× the expected {} req/s. {} gives out first{}",
                js_num(js_round(bp.max_rps)),
                js_to_fixed(ratio, 1),
                js_num(rps),
                nm(l),
                bp.note.as_ref().map(|n| format!(": {}", n)).unwrap_or_else(|| ".".into())
            ),
            None => format!("Sustains at least {} req/s — no limit found.", js_num(js_round(bp.max_rps))),
        },
        cost_at_risk: None,
        fixes: vec![],
        scenario: json!({ "duration": 30, "rps": js_round(bp.first_failing_rps.unwrap_or(bp.max_rps * 1.2)), "readRatio": read_ratio, "slo": slo_v }),
    };
    if fixes_on && sev_rank(headroom_sev) >= 2.0 {
        if let Some(l) = &bp.limited_by {
            let c = spec.components.iter().find(|c| get_str(c, "id") == Some(l.as_str()));
            for cand in capacity_fixes(c, nm) {
                let variant = match apply_variant(&spec, &json!({ "name": cand.title, "changes": cand.changes })) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let bp2 = breaking_point_parsed(&variant, &bo);
                let r2 = bp2.max_rps / rps.max(1.0);
                if r2 <= ratio * 1.1 {
                    continue;
                }
                let cost = sim(&variant, json!({ "duration": 20, "rps": rps, "readRatio": read_ratio, "slo": slo_v }))?.summary.mean_cost_per_hour;
                headroom.fixes.push(Fix {
                    why: format!("{} Sustains {} req/s ({}×){}.", cand.why, js_num(js_round(bp2.max_rps)), js_to_fixed(r2, 1), bp2.limited_by.as_ref().map(|x| format!(", then {} is next", nm(x))).unwrap_or_default()),
                    title: cand.title,
                    changes: cand.changes,
                    monthly_delta: monthly(cost - base_cost),
                    after: After { severity: if r2 < 1.0 { "critical" } else if r2 < 1.5 { "major" } else if r2 < 2.0 { "minor" } else { "ok" }.into(), error_rate: 0.0, peak_p99_ms: 0.0, failed_requests: 0.0 },
                });
            }
            js_sort_by(&mut headroom.fixes, |a, b| a.monthly_delta - b.monthly_delta);
        }
    }
    findings.push(headroom);
    done += 1.0;
    progress(done, total, "breaking point");

    js_sort_by(&mut findings, |a, b| {
        let d = sev_rank(&b.severity) - sev_rank(&a.severity);
        if d != 0.0 {
            d
        } else {
            b.impact.failed_requests - a.impact.failed_requests
        }
    });
    let curve = load_curve_parsed(&spec, (rps * 1.5).max(bp.max_rps * 2.0), Some(20.0), Some(read_ratio), None, None);
    let graded: Vec<&Finding> = findings.iter().filter(|f| f.kind != "headroom").collect();
    let survived = graded.iter().filter(|f| f.severity == "ok" || f.severity == "minor").count() as f64;
    let score = js_round((100.0 * graded.iter().fold(0.0, |s, f| s + (1.0 - sev_rank(&f.severity) / 3.0))) / (graded.len() as f64).max(1.0));
    let total_graded = graded.len() as f64;
    Ok(AuditResult {
        architecture: spec.name.clone().unwrap_or_else(|| "architecture".into()),
        load: Load { rps, read_ratio },
        slo: SloOut { max_error_rate: slo.0, max_p99_ms: slo.1 },
        baseline,
        headroom: Headroom { max_rps: bp.max_rps, limited_by: bp.limited_by.clone(), note: bp.note.clone(), ratio: r3(ratio) },
        score,
        availability: super::availability::availability(&spec, read_ratio),
        survived,
        total: total_graded,
        findings,
        curve,
        wall_ms: now_ms() - t0,
    })
}
