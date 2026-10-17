//! plan_load_test: the load test an inconclusive verdict asks for. From the calibrated model and a change
//! (verify_change's inputs) or a list of services: which services need evidence and up to what request
//! rate, through which entry endpoints (the recorded mix, by who calls whom), a step-load k6 script that
//! stops itself at the SLO, and the calls that read the test back in. Nothing is run: the script is a file.

use super::workspace::{iso, Workspace};
use crate::cli::reports::{arr, g, inf, n, s};
use crate::math::{js_locale, js_num, js_round};
use crate::review::json::{num, r1, r2};
use crate::review::judge::LIMIT_SEEN;
use serde_json::{json, Map as JMap, Value};

/// the share of its capacity a service is driven to when nothing asks for more: past LIMIT_SEEN the
/// history counts as having reached its limit, so a little past it settles the extrapolation
pub const TOP: f64 = 0.9;
/// how far past what the change needs the test goes by default: the replay's own share is a model's
pub const MARGIN: f64 = 1.1;
/// the ramp from one step to the next, seconds; the first ramp (from nothing to the history's peak) is a minute
const RAMP_S: f64 = 30.0;
const FIRST_RAMP_S: f64 = 60.0;
const METHODS: [&str; 7] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

fn pct(x: f64) -> String {
    format!("{}%", js_num(js_round(x * 100.0)))
}

/// a verdict's reason that asks for a load test names the tool that designs it (the agent's answers
/// only: the app words its own)
pub fn point_to_plan(out: &mut Value) {
    for r in out.get_mut("results").and_then(|r| r.as_array_mut()).into_iter().flatten() {
        for x in r.get_mut("reasons").and_then(|x| x.as_array_mut()).into_iter().flatten() {
            if let Some(t) = x.as_str().filter(|t| t.ends_with("load-test before trusting it")) {
                *x = json!(format!("{}: plan_load_test with the same changes designs that test", t));
            }
        }
    }
}

/// a confidence warning that holds a verdict at low (judge.rs words them): the ones a pass is withheld for
pub fn holds_low(w: &str) -> bool {
    w.contains("a capacity the history never tested") || w.contains(", and this change ") || w.contains("past the history's peak of") || w.contains("off by more than half")
}

/// an endpoint's HTTP method and path from its id ("frontend GET /api/cart"): None for an RPC name
fn http_of(id: &str, service: &str) -> Option<(String, String, bool)> {
    let rest = id.strip_prefix(service).map(|r| r.trim_start()).filter(|r| !r.is_empty()).unwrap_or(id);
    let (first, tail) = rest.split_once(' ').unwrap_or((rest, ""));
    if METHODS.contains(&first.to_uppercase().as_str()) {
        let p = tail.trim();
        return p.starts_with('/').then(|| (first.to_uppercase(), p.to_string(), false));
    }
    // a route without a method: requested as a GET, and said so
    rest.starts_with('/').then(|| ("GET".to_string(), rest.trim().to_string(), true))
}

/// the {placeholders} of a path, in order, once each
fn placeholders(path: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let mut rest = path;
    while let Some(a) = rest.find('{') {
        match rest[a..].find('}') {
            Some(b) => {
                let k = rest[a + 1..a + b].to_string();
                if !k.is_empty() && !out.contains(&k) {
                    out.push(k);
                }
                rest = &rest[a + b + 1..];
            }
            None => break,
        }
    }
    out
}

struct Target {
    service: String,
    util: f64,
    history: Option<f64>,
    predicted: Option<f64>,
    why: String,
    cpu_only: bool,
}

struct Entry {
    id: String,
    method: String,
    path: String,
    assumed_get: bool,
    /// a service's traffic without routes (no traces: "web (all requests)"): the script takes its paths from ROUTES
    routes: bool,
    share: f64,
    visits: JMap<String, Value>,
}

fn slug(x: &str) -> String {
    let mut out = String::new();
    for c in x.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').chars().take(40).collect()
}

fn minutes(s: f64) -> String {
    let m = r1(s / 60.0);
    format!("{} min", js_num(m))
}

pub fn plan_load_test(ws: &Workspace, o: &Value) -> Result<Value, String> {
    let mv = ws.read_json("model.json")?;
    let dv = ws.read_json("dataset.json")?;
    let cal = if ws.has("calibration.json") { Some(ws.read_json("calibration.json")?) } else { None };
    let changes: Vec<Value> = arr(o, &["changes"]).into_iter().cloned().collect();
    let asked: Vec<Value> = arr(o, &["services"]).into_iter().cloned().collect();
    if changes.is_empty() && asked.is_empty() {
        return Err("give changes (as verify_change takes them) or services ([{ service, utilization? }]): what the load test has to answer".into());
    }
    let margin = o.get("margin").and_then(|x| x.as_f64()).unwrap_or(MARGIN);
    let slo = g(&mv, &["slo"]).clone();
    let (slo_p99, slo_err) = (n(&slo, &["p99Ms"]), n(&slo, &["errorRate"]));
    let step_s = n(&dv, &["stepS"]);
    let known: Vec<String> = g(&mv, &["services"]).as_object().map(|x| x.keys().cloned().collect()).unwrap_or_default();
    let mut notes: Vec<String> = vec![];
    let mut targets: Vec<Target> = vec![];
    let add = |t: Target, targets: &mut Vec<Target>| match targets.iter_mut().find(|x| x.service == t.service) {
        Some(x) if t.util > x.util => *x = t,
        Some(_) => {}
        None => targets.push(t),
    };

    // ---- what the verdict rests on: the services a change runs past what the history showed
    let mut verdicts: Vec<Value> = vec![];
    let mut addressed: Vec<String> = vec![];
    let mut others: Vec<String> = vec![];
    if !changes.is_empty() {
        let mut vo = JMap::new();
        // a stacked change is planned on top of its baseline, as verify_change judges it
        for k in ["last", "window", "traffic", "gateMinutes", "baseline"] {
            if let Some(x) = o.get(k).filter(|x| !x.is_null()) {
                vo.insert(k.into(), x.clone());
            }
        }
        // the shares a service runs at are the replay's medians: a few capacity draws give them
        vo.insert("draws".into(), json!(o.get("draws").and_then(|x| x.as_f64()).unwrap_or(8.0)));
        let v = super::verify::verify_with(ws, mv.clone(), dv.clone(), cal.clone(), &changes, &Value::Object(vo))?;
        notes.extend(arr(&v.out, &["notes"]).iter().map(|x| s(x, &[])));
        for r in arr(&v.out, &["results"]) {
            let warnings: Vec<String> = arr(r, &["confidence", "warnings"]).iter().map(|x| s(x, &[])).collect();
            for x in arr(r, &["confidence", "services"]) {
                let svc = s(x, &["service"]);
                let (pu, hp) = (n(x, &["predictedPeakUtil"]), n(x, &["historyPeakUtil"]));
                let cpu_only = g(x, &["cpuOnly"]).as_bool().unwrap_or(false);
                // the rules confidence is lowered by for capacity the history never showed (judge.rs)
                let need = if cpu_only { pu > hp * 1.1 } else { s(x, &["basis"]) == "beyond anything the history showed" };
                if !need {
                    continue;
                }
                let said: Vec<&String> = warnings.iter().filter(|w| w.starts_with(&format!("{} ", svc)) && (w.contains("never tested") || w.contains("past the history's"))).collect();
                addressed.extend(said.iter().map(|w| w.to_string()));
                add(
                    Target { service: svc.clone(), util: (pu * margin).min(if cpu_only { 1.0 } else { TOP }).max(hp), history: Some(hp), predicted: Some(pu), why: said.first().map(|w| w.to_string()).unwrap_or_else(|| format!("{} would run at {} of capacity, past the history's {}", svc, pct(pu), pct(hp))), cpu_only },
                    &mut targets,
                );
            }
            for w in warnings {
                if !addressed.contains(&w) && !others.contains(&w) {
                    others.push(w);
                }
            }
            verdicts.push(json!({ "name": g(r, &["name"]), "verdict": g(r, &["verdict"]), "leans": g(r, &["leans"]), "confidence": g(r, &["confidence", "level"]), "doubt": arr(r, &["reasons"]).iter().any(|x| s(x, &[]).contains("worst 10% of capacity draws")) }));
        }
        others.retain(|w| !addressed.contains(w));
    }
    let hist_peak = |id: &str| cal.as_ref().and_then(|c| g(c, &["historyPeakUtil", id]).as_f64());
    for a in &asked {
        let svc = s(a, &["service"]);
        if !known.contains(&svc) {
            return Err(format!("no service \"{}\" in the model (services: {})", svc, known.join(", ")));
        }
        let cpu_only = g(&mv, &["services", &svc, "capacity", "cpuAlone"]).as_bool().unwrap_or(false);
        let u = a.get("utilization").and_then(|x| x.as_f64()).unwrap_or(TOP);
        add(Target { service: svc.clone(), util: u, history: hist_peak(&svc), predicted: None, why: format!("asked for: {} to {} of its modelled capacity", svc, pct(u)), cpu_only }, &mut targets);
    }
    // a service with no capacity limit in the model has nothing to drive it towards
    targets.retain(|t| {
        let ok = inf(&mv, &["services", &t.service, "capacity", "perReplicaRps"]).is_finite();
        if !ok {
            notes.push(format!("{}: the model has no capacity limit for it, so there is no share of one to drive it to", t.service));
        }
        ok
    });
    let mut out = JMap::new();
    out.insert("model".into(), g(&mv, &["name"]).clone());
    if !verdicts.is_empty() {
        out.insert("verdicts".into(), json!(verdicts));
    }
    if targets.is_empty() {
        out.insert("needed".into(), json!(false));
        out.insert(
            "why".into(),
            json!(if changes.is_empty() { "none of the services asked for can be driven towards a limit".to_string() } else { "no service runs past what the history showed, so a load test has no new load to reach; what holds confidence where it is is in otherWarnings".to_string() }),
        );
        if !others.is_empty() {
            out.insert("otherWarnings".into(), json!(others));
        }
        out.insert("notes".into(), json!(notes));
        return Ok(Value::Object(out));
    }

    // ---- the entry endpoints that reach them, in the recorded mix
    let recorded = o.get("mix").and_then(|x| x.as_str()) == Some("recorded");
    let mut entries: Vec<Entry> = vec![];
    let mut not_http: Vec<(String, JMap<String, Value>)> = vec![];
    for (id, e) in g(&mv, &["endpoints"]).as_object().cloned().unwrap_or_default() {
        let visits = g(&e, &["visits"]).as_object().cloned().unwrap_or_default();
        let reaches = targets.iter().any(|t| visits.get(&t.service).and_then(|x| x.as_f64()).unwrap_or(0.0) > 0.0);
        let share = n(&e, &["share"]);
        if !(share > 0.0) || !(recorded || reaches) {
            continue;
        }
        let svc = s(&e, &["service"]);
        match http_of(&id, &svc) {
            Some((method, path, assumed_get)) => entries.push(Entry { id, method, path, assumed_get, routes: false, share, visits }),
            None if id == format!("{} (all requests)", svc) => entries.push(Entry { id, method: "GET".into(), path: String::new(), assumed_get: false, routes: true, share, visits }),
            None => not_http.push((id, visits)),
        }
    }
    let total_share: f64 = entries.iter().map(|e| e.share).sum();
    // per entry request of the mix: requests at a service
    let per_entry = |svc: &str| -> f64 { entries.iter().map(|e| e.share / total_share * e.visits.get(svc).and_then(|x| x.as_f64()).unwrap_or(0.0)).sum() };
    targets.retain(|t| {
        let ok = total_share > 0.0 && per_entry(&t.service) > 0.0;
        if !ok {
            let via: Vec<&String> = not_http.iter().filter(|(_, v)| v.get(&t.service).and_then(|x| x.as_f64()).unwrap_or(0.0) > 0.0).map(|(id, _)| id).collect();
            notes.push(if via.is_empty() {
                format!("{}: no recorded entry endpoint reaches it, so the plan can't drive it", t.service)
            } else {
                format!("{}: reached only through {}, {}: drive {} with a client of {} own", t.service, via.iter().map(|x| x.as_str()).collect::<Vec<_>>().join(", "), if via.len() == 1 { "which is not an HTTP route" } else { "which are not HTTP routes" }, if via.len() == 1 { "it" } else { "them" }, if via.len() == 1 { "its" } else { "their" })
            });
        }
        ok
    });
    if targets.is_empty() {
        out.insert("needed".into(), json!(true));
        out.insert("planned".into(), json!(false));
        out.insert("why".into(), json!("the services that need evidence can't be reached over HTTP from the recorded entry endpoints"));
        out.insert("notes".into(), json!(notes));
        return Ok(Value::Object(out));
    }
    for (id, _) in &not_http {
        notes.push(format!("{} is not an HTTP route: left out of the script, and of the mix it drives", id));
    }

    // ---- the rates: each target at its share of capacity, on the replicas the test runs with
    let replicas_of = |svc: &str| o.get("replicas").and_then(|r| r.get(svc)).and_then(|x| x.as_f64()).unwrap_or_else(|| n(&mv, &["services", svc, "replicas"]).max(1.0));
    let cap_of = |svc: &str| inf(&mv, &["services", svc, "capacity", "perReplicaRps"]);
    let need_of = |t: &Target| t.util * cap_of(&t.service) * replicas_of(&t.service);
    let top = targets.iter().map(|t| need_of(t) / per_entry(&t.service)).fold(0.0, f64::max);
    let peak = n(&mv, &["traffic", "peak"]);
    let mut start = if peak.is_finite() { peak * total_share } else { f64::NAN };
    if !start.is_finite() {
        start = top * 0.5;
    } else if start >= top * 0.9 {
        notes.push(format!(
            "{}: the targets come at {} req/s, at or below the history's peak through these endpoints ({} req/s): fewer replicas where the test runs, or a share of capacity the history already reached. The steps start at half the top instead",
            targets.iter().map(|t| format!("{} on {} replica{}", t.service, js_num(replicas_of(&t.service)), if replicas_of(&t.service) == 1.0 { "" } else { "s" })).collect::<Vec<_>>().join(", "),
            js_num(r1(top)),
            js_num(r1(start))
        ));
        start = top * 0.5;
    }
    let k = o.get("steps").and_then(|x| x.as_f64()).unwrap_or(5.0).clamp(2.0, 12.0) as usize;
    let hold = o.get("holdS").and_then(|x| x.as_f64()).unwrap_or_else(|| (2.0 * step_s).max(120.0));
    let hold = if step_s > 0.0 { (hold / step_s).ceil() * step_s } else { hold };
    let rates: Vec<f64> = (0..k).map(|i| start + (top - start) * i as f64 / (k - 1) as f64).collect();
    let util_at = |svc: &str, rate: f64| rate * per_entry(svc) / (cap_of(svc) * replicas_of(svc));
    // every service the mix reaches, at every step: which reach their target, and which saturate on the way
    let reached: Vec<&String> = known.iter().filter(|id| cap_of(id).is_finite() && per_entry(id) > 0.0).collect();
    let mut steps = vec![];
    let mut t_at = 0.0;
    for (i, r) in rates.iter().enumerate() {
        let ramp = if i == 0 { FIRST_RAMP_S } else { RAMP_S };
        let utils: JMap<String, Value> = reached.iter().map(|id| ((*id).clone(), num(r2(util_at(id, *r))))).collect();
        steps.push(json!({ "step": i + 1, "entryRps": num(r1(*r)), "startS": num(t_at), "rampS": num(ramp), "holdS": num(hold), "utilization": utils }));
        t_at += ramp + hold;
    }
    let duration_s = t_at;
    let first_step = |svc: &str, at: f64| rates.iter().position(|r| util_at(svc, *r) >= at - 1e-9).map(|i| i + 1);
    let services: Vec<Value> = targets
        .iter()
        .map(|t| {
            let mut x = json!({
                "service": t.service,
                "why": t.why,
                "historyPeakUtil": t.history.map(|h| num(r2(h))).unwrap_or(Value::Null),
                "targetUtil": num(r2(t.util)),
                "capacityPerReplica": num(r2(cap_of(&t.service))),
                "replicas": num(replicas_of(&t.service)),
                "targetRps": num(r1(need_of(t))),
                "reachedAtStep": first_step(&t.service, t.util).map(|x| json!(x)).unwrap_or(Value::Null),
            });
            if let Some(p) = t.predicted {
                x["predictedPeakUtil"] = num(r2(p));
            }
            if t.cpu_only {
                x["cpuOnly"] = json!(true);
            }
            x
        })
        .collect();
    let is_target = |id: &str| targets.iter().any(|t| t.service == id);
    // the step the last target reaches its share at: a service saturating before it may stop the test first
    let last_needed = targets.iter().filter_map(|t| first_step(&t.service, t.util)).max().unwrap_or(k);
    let mut saturates = vec![];
    let mut also = vec![];
    for id in &reached {
        // a target saturating past its own share: the mix drives it on towards another target's
        if let Some(at) = first_step(id, 1.0).filter(|at| *at < last_needed || !is_target(id)) {
            saturates.push(json!({ "service": id, "atStep": at, "entryRps": num(r1(rates[at - 1])), "utilization": num(r2(util_at(id, rates[at - 1]))) }));
        }
        if is_target(id) {
            continue;
        }
        let (u, hp) = (util_at(id, top), hist_peak(id).unwrap_or(0.0));
        if u > hp.max(0.3) * 1.1 {
            also.push(format!("{} to {} (history {})", id, pct(u), pct(hp)));
        }
    }

    // ---- the script
    let bodies = |m: &str| matches!(m, "POST" | "PUT" | "PATCH");
    let mut params: Vec<String> = vec![];
    for e in &entries {
        for p in placeholders(&e.path) {
            if !params.contains(&p) {
                params.push(p);
            }
        }
    }
    let with_body: Vec<&Entry> = entries.iter().filter(|e| bodies(&e.method)).collect();
    let mut inputs: Vec<String> = params.iter().map(|p| format!("PARAMS[\"{}\"]: values for {{{}}} that exist where the test runs", p, p)).collect();
    inputs.extend(with_body.iter().map(|e| format!("BODIES[\"{}\"]: the JSON body it sends ('' for none)", e.id)));
    let unrouted: Vec<&Entry> = entries.iter().filter(|e| e.routes).collect();
    inputs.extend(unrouted.iter().map(|e| format!("ROUTES[\"{}\"]: GET paths that look like its traffic (the history names no routes for it)", e.id)));
    let names: Vec<String> = verdicts.iter().map(|v| s(v, &["name"])).filter(|x| !x.is_empty()).collect();
    let title = if names.is_empty() { targets.iter().map(|t| t.service.clone()).collect::<Vec<_>>().join(", ") } else { names.join(", ") };
    let base_env = o.get("baseUrlEnv").and_then(|x| x.as_str()).unwrap_or("BASE_URL").to_string();
    let auth_env = o.get("authEnv").and_then(|x| x.as_str()).unwrap_or("AUTH_HEADER").to_string();
    let q = |x: &str| crate::convert::js_stringify(&json!(x));
    let mut js: Vec<String> = vec![];
    js.push(format!("// Hindcast load-test plan: {}", title));
    for t in &targets {
        js.push(format!("// Drives {} to {} of its modelled capacity: {} req/s on {} replica{} of {} req/s.", t.service, pct(t.util), js_num(r1(need_of(t))), js_num(replicas_of(&t.service)), if replicas_of(&t.service) == 1.0 { "" } else { "s" }, js_num(r1(cap_of(&t.service)))));
    }
    js.push(format!("// {} steps from the history's peak ({} req/s at the entry) to {} req/s, each held {} s ({} in all).", k, js_num(r1(start)), js_num(r1(top)), js_num(hold), minutes(duration_s)));
    js.push(format!("// It stops itself (abortOnFail) as soon as a step's errors pass {}% or its p99 passes {} ms: the SLO.", js_num(r2(slo_err * 100.0)), js_num(slo_p99)));
    js.push("//".into());
    js.push(format!("//   {}=https://staging.example.com k6 run {}.k6.js", base_env, slug(&title)));
    js.push(format!("// {}, when set, is sent as the Authorization header. No credential is written in this file.", auth_env));
    js.push(format!("// Generated by hindcast plan_load_test from the model \"{}\". Fill in INPUTS; change the rates with plan_load_test.", s(&mv, &["name"])));
    js.push("import http from 'k6/http';".into());
    js.push("import exec from 'k6/execution';".into());
    js.push(String::new());
    js.push(format!("const BASE_URL = __ENV.{};", base_env));
    js.push(format!("const AUTH = __ENV.{};", auth_env));
    js.push(String::new());
    js.push("// ---- INPUTS: setup() refuses to start while one is missing".into());
    js.push("// values for each {placeholder} in the paths below, one picked at random per request".into());
    js.push("const PARAMS = {".into());
    for p in &params {
        js.push(format!("  {}: [],", q(p)));
    }
    js.push("};".into());
    js.push("// the JSON body of each endpoint that sends one; '' sends none".into());
    js.push("const BODIES = {".into());
    for e in &with_body {
        js.push(format!("  {}: null,", q(&e.id)));
    }
    js.push("};".into());
    if !unrouted.is_empty() {
        js.push("// paths to request for the traffic the history names no routes for (it had no traces): one picked at random per request".into());
        js.push("const ROUTES = {".into());
        for e in &unrouted {
            js.push(format!("  {}: [],", q(&e.id)));
        }
        js.push("};".into());
    }
    js.push(String::new());
    js.push("// ---- the plan: the recorded endpoint mix, and the entry rate of each step".into());
    js.push("const ENDPOINTS = {".into());
    for (i, e) in entries.iter().enumerate() {
        js.push(format!("  e{}: {{ id: {}, method: {}, path: {}, body: {}{} }},", i, q(&e.id), q(&e.method), q(&e.path), bodies(&e.method), if e.routes { ", routes: true" } else { "" }));
    }
    js.push("};".into());
    js.push("// when each step runs (seconds from the start, its ramp included) and the entry rate it holds".into());
    js.push("const STEPS = [".into());
    for st in &steps {
        js.push(format!("  {{ step: {}, from: {}, to: {}, rps: {} }},", js_num(n(st, &["step"])), js_num(n(st, &["startS"])), js_num(n(st, &["startS"]) + n(st, &["rampS"]) + n(st, &["holdS"])), js_num(n(st, &["entryRps"]))));
    }
    js.push("];".into());
    js.push(String::new());
    js.push("export const options = {".into());
    js.push("  discardResponseBodies: true,".into());
    js.push("  scenarios: {".into());
    for (i, e) in entries.iter().enumerate() {
        let sh = e.share / total_share;
        let per_min = |r: f64| js_round(r * sh * 60.0).max(1.0);
        // enough virtual users for the top rate if every request took the SLO's p99 (Little's law), five times that at most
        let vus = ((top * sh) * slo_p99.max(50.0) / 1000.0).ceil().max(2.0);
        let mut stages = vec![];
        for (j, r) in rates.iter().enumerate() {
            stages.push(format!("{{ duration: '{}s', target: {} }}", js_num(if j == 0 { FIRST_RAMP_S } else { RAMP_S }), js_num(per_min(*r))));
            stages.push(format!("{{ duration: '{}s', target: {} }}", js_num(hold), js_num(per_min(*r))));
        }
        js.push(format!("    // {}: {}% of the mix", e.id, js_num(r1(sh * 100.0))));
        js.push(format!("    e{}: {{ executor: 'ramping-arrival-rate', exec: 'hit', startRate: 0, timeUnit: '1m', preAllocatedVUs: {}, maxVUs: {}, stages: [{}] }},", i, js_num(vus), js_num((vus * 5.0).max(10.0)), stages.join(", ")));
    }
    js.push("  },".into());
    js.push("  // per step, so a step that hurts stops the test at that step; 30 s of grace at the start".into());
    js.push("  thresholds: {".into());
    for st in &steps {
        let k = js_num(n(st, &["step"]));
        js.push(format!("    'http_req_failed{{step:{}}}': [{{ threshold: 'rate<={}', abortOnFail: true, delayAbortEval: '30s' }}],", k, js_num(slo_err)));
        js.push(format!("    'http_req_duration{{step:{}}}': [{{ threshold: 'p(99)<={}', abortOnFail: true, delayAbortEval: '30s' }}],", k, js_num(slo_p99)));
    }
    js.push("  },".into());
    js.push("  summaryTrendStats: ['avg', 'p(50)', 'p(90)', 'p(99)', 'max'],".into());
    js.push("};".into());
    js.push(String::new());
    js.push("export function setup() {".into());
    js.push(format!("  if (!BASE_URL) throw new Error('set {} to the system under test, e.g. {}=https://staging.example.com');", base_env, base_env));
    js.push("  const missing = [];".into());
    js.push("  for (const e of Object.values(ENDPOINTS)) {".into());
    js.push("    const re = /\\{([^}]+)\\}/g;".into());
    js.push("    let m;".into());
    js.push("    while ((m = re.exec(e.path))) if (!(PARAMS[m[1]] || []).length) missing.push(`PARAMS[\"${m[1]}\"] (${e.id})`);".into());
    js.push("    if (e.body && BODIES[e.id] == null) missing.push(`BODIES[\"${e.id}\"]`);".into());
    if !unrouted.is_empty() {
        js.push("    if (e.routes && !(ROUTES[e.id] || []).length) missing.push(`ROUTES[\"${e.id}\"]`);".into());
    }
    js.push("  }".into());
    js.push("  if (missing.length) throw new Error(`fill in before running: ${[...new Set(missing)].join(', ')}`);".into());
    js.push("  return { t0: Date.now() };".into());
    js.push("}".into());
    js.push(String::new());
    js.push("function stepAt(s) {".into());
    js.push("  for (const x of STEPS) if (s < x.to) return x.step;".into());
    js.push("  return STEPS[STEPS.length - 1].step;".into());
    js.push("}".into());
    js.push(String::new());
    js.push("export function hit(data) {".into());
    js.push("  const e = ENDPOINTS[exec.scenario.name];".into());
    js.push("  const pick = (a) => a[Math.floor(Math.random() * a.length)];".into());
    js.push(if unrouted.is_empty() { "  const path = e.path.replace(/\\{([^}]+)\\}/g, (_, k) => encodeURIComponent(pick(PARAMS[k])));" } else { "  const path = e.routes ? pick(ROUTES[e.id]) : e.path.replace(/\\{([^}]+)\\}/g, (_, k) => encodeURIComponent(pick(PARAMS[k])));" }.into());
    js.push("  const headers = {};".into());
    js.push("  if (AUTH) headers.Authorization = AUTH;".into());
    js.push("  const body = e.body ? BODIES[e.id] : null;".into());
    js.push("  if (body) headers['Content-Type'] = 'application/json';".into());
    js.push(format!("  http.request(e.method, BASE_URL + path, body || null, {{ headers, timeout: '{}ms', tags: {{ step: String(stepAt((Date.now() - data.t0) / 1000)), endpoint: e.id }} }});", js_num((slo_p99 * 5.0).max(5000.0))));
    js.push("}".into());
    let script = js.join("\n") + "\n";
    ws.ensure("loadtests");
    let file = ws.path(&format!("loadtests/{}.k6.js", slug(&title)));
    std::fs::write(&file, &script).map_err(|e| e.to_string())?;
    if entries.iter().any(|e| e.assumed_get) {
        notes.push("some routes carry no HTTP method: the script requests them as GET".into());
    }

    // ---- where, and what it costs
    let requests = FIRST_RAMP_S * rates[0] / 2.0 + rates.iter().map(|r| r * hold).sum::<f64>() + rates.windows(2).map(|w| RAMP_S * (w[0] + w[1]) / 2.0).sum::<f64>();
    let failed = requests * slo_err;
    let month_budget = n(&mv, &["traffic", "mean"]) * 30.0 * 86400.0 * slo_err;
    let per_hour: f64 = g(&mv, &["services"]).as_object().map(|x| x.iter().map(|(id, sv)| n(sv, &["cost", "perReplicaHour"]) * replicas_of(id)).filter(|c| c.is_finite()).sum()).unwrap_or(0.0);
    let fixed: Vec<String> = targets.iter().map(|t| {
        let sv = g(&mv, &["services", &t.service]);
        let cpu = n(sv, &["cpuLimit"]);
        format!("{}: {} replica{}{}", t.service, js_num(replicas_of(&t.service)), if replicas_of(&t.service) == 1.0 { "" } else { "s" }, if cpu.is_finite() { format!(" at {} cores", js_num(cpu)) } else { String::new() })
    }).collect();
    let mut where_ = vec![
        format!("staging with production's limits: the same CPU and memory limits and replica counts ({}), on the same kind of nodes, with production-sized data. The test measures capacity per replica; a smaller box measures a different service", fixed.join("; ")),
        "hold the replica counts fixed while it runs (pause any autoscaler on these services): new pods spread the load and the share of capacity never reaches the target".into(),
        "collect_telemetry reads one Prometheus (or Datadog): staging's test is only read back if its metrics and traces land there with the same service names. Otherwise run it in production, off-peak".into(),
    ];
    let span = n(&dv, &["n"]) * step_s;
    let totals: Vec<f64> = (0..n(&dv, &["n"]) as usize).map(|i| g(&dv, &["endpoints"]).as_object().map(|e| e.values().map(|x| x.get("rps").and_then(|r| r.get(i)).and_then(|v| v.as_f64()).unwrap_or(0.0)).sum()).unwrap_or(0.0)).collect();
    if span >= 86400.0 {
        let mut by_hour = [(0.0, 0.0); 24];
        for (i, t) in totals.iter().enumerate() {
            let h = (((n(&dv, &["start"]) + i as f64 * step_s) % 86400.0) / 3600.0).floor() as usize;
            by_hour[h.min(23)].0 += t;
            by_hour[h.min(23)].1 += 1.0;
        }
        let (h, (sum, cnt)) = by_hour.iter().enumerate().filter(|(_, x)| x.1 > 0.0).min_by(|a, b| (a.1 .0 / a.1 .1).partial_cmp(&(b.1 .0 / b.1 .1)).unwrap_or(std::cmp::Ordering::Equal)).map(|(h, x)| (h, *x)).unwrap_or((0, (0.0, 1.0)));
        where_.push(format!("production, off-peak: the history is quietest around {:02}:00 UTC ({} req/s on average). Real traffic adds to the test's, so the targets come a little before the last step, and real users meet the slow steps: the thresholds stop it at the SLO, not before", h, js_num(r1(sum / cnt))));
    } else {
        where_.push(format!("production, off-peak: the history ({} h) is too short to say when traffic is lowest. Real traffic adds to the test's, and real users meet the slow steps: the thresholds stop it at the SLO, not before", js_num(r1(span / 3600.0))));
    }
    let mut cost = json!({
        "minutes": num(r1(duration_s / 60.0)),
        "requests": num(js_round(requests)),
        "failedRequestsAtMost": num(js_round(failed)),
        "words": format!(
            "{} and about {} requests; the thresholds let a step fail up to {}% of them before stopping, about {} failed requests{}. The environment itself: about ${} for the {} at the model's prices{}",
            minutes(duration_s),
            js_locale(js_round(requests)),
            js_num(r2(slo_err * 100.0)),
            js_locale(js_round(failed)),
            if month_budget.is_finite() && month_budget > 0.0 { format!(" ({} of a 30-day error budget at the history's mean traffic, if run in production)", if failed / month_budget < 0.01 { "under 1%".to_string() } else { pct(failed / month_budget) }) } else { String::new() },
            js_num(r2(per_hour * duration_s / 3600.0)),
            minutes(duration_s),
            if per_hour > 0.0 { "" } else { " (the model has no prices)" }
        ),
    });
    if !(per_hour > 0.0) {
        cost["environmentUsd"] = Value::Null;
    } else {
        cost["environmentUsd"] = num(r2(per_hour * duration_s / 3600.0));
    }

    // ---- the follow-up: read the test back in, refit, verify again
    let (d0, d1) = (n(&dv, &["start"]), n(&dv, &["start"]) + span);
    let mut collect = json!({ "windows": [{ "start": iso(d0), "end": iso(d1) }, { "start": "<when the test started, ISO 8601>", "end": format!("<that + {}>", minutes(duration_s)) }], "stepS": num(step_s) });
    let mut calibrate = json!({ "holdout": 0 });
    let mut verify = JMap::new();
    if let Some(w) = o.get("workspace").filter(|x| !x.is_null()) {
        collect["workspace"] = w.clone();
        calibrate["workspace"] = w.clone();
        verify.insert("workspace".into(), w.clone());
    }
    if !changes.is_empty() {
        verify.insert("changes".into(), json!(changes));
        for k in ["traffic", "gateMinutes", "last"] {
            if let Some(x) = o.get(k).filter(|x| !x.is_null()) {
                verify.insert(k.into(), x.clone());
            }
        }
        // the replay stays on the ordinary history: the test is what the model learns from, not what it replays
        verify.insert("window".into(), o.get("window").filter(|x| !x.is_null()).cloned().unwrap_or_else(|| json!({ "start": iso(d0), "end": iso(d1) })));
    }
    let mut expect: Vec<String> = targets
        .iter()
        .map(|t| {
            let to = match t.predicted {
                Some(p) if p <= t.util => format!(", past the {} the change needs", pct(p)),
                Some(p) => format!(", short of the {} the change needs: past {} it counts as a limit reached", pct(p), pct(LIMIT_SEEN)),
                None => String::new(),
            };
            let then = if t.cpu_only {
                "the history then holds its CPU per request at that load; with no latency metric its confidence stays medium at most".to_string()
            } else if t.util >= LIMIT_SEEN {
                "the history then counts as having reached its limit, and the \"never tested\" warning goes away".to_string()
            } else {
                "the warning that its capacity there is extrapolated goes away".to_string()
            };
            format!("{} driven to {} of its capacity (the history's peak is {}){}: {}", t.service, pct(t.util), t.history.map(pct).unwrap_or_else(|| "unknown".into()), to, then)
        })
        .collect();
    expect.push("a step that stops the test is evidence too: the history then shows where the service's latency turns, calibration refits its capacity there, and the verdict rests on a measured limit. It may turn to fail: that is what the test is for".into());
    let low_left: Vec<&String> = others.iter().filter(|w| holds_low(w)).collect();
    if !verdicts.is_empty() {
        let leans: Vec<String> = verdicts.iter().filter(|v| s(v, &["verdict"]) == "inconclusive").map(|v| format!("{} ({})", s(v, &["name"]), s(v, &["leans"]))).collect();
        if low_left.is_empty() {
            if !leans.is_empty() {
                expect.push(format!("with nothing else holding confidence low, an inconclusive verdict becomes what the replay leans to now, unless the test moves the fitted capacity: {}{}", leans.join(", "), if verdicts.iter().any(|v| g(v, &["doubt"]).as_bool().unwrap_or(false)) { ". Where the worst 10% of capacity draws fail too, a measured limit narrows the band they come from, which settles it either way" } else { "" }));
            }
        } else {
            // the test isn't aimed at them, though a fit refitted on more load can change
            expect.push(format!(
                "it stays inconclusive if {} still hold{} confidence low after the refit: the test isn't aimed at {}, though a fit can change with more load to fit on: {}",
                if low_left.len() == 1 { "this" } else { "these" },
                if low_left.len() == 1 { "s" } else { "" },
                if low_left.len() == 1 { "it" } else { "them" },
                low_left.iter().map(|x| x.as_str()).collect::<Vec<_>>().join("; ")
            ));
        }
    }
    expect.push("calibrate with holdout 0: the default holds back the last 30% of the history, which now ends in the load test, so the accuracy check would ask a model fitted on the calm part to predict the test. Its accuracy reads \"never measured\" instead (medium); the earlier calibration's accuracy still says how it did on the ordinary history".into());

    out.insert("needed".into(), json!(true));
    out.insert("services".into(), json!(services));
    out.insert("entry".into(), json!(entries.iter().map(|e| {
        let sh = e.share / total_share;
        json!({ "endpoint": e.id, "method": e.method, "path": e.path, "share": num(r2(sh)), "rps": rates.iter().map(|r| num(r1(r * sh))).collect::<Vec<_>>() })
    }).collect::<Vec<_>>()));
    out.insert("steps".into(), json!(steps));
    if !saturates.is_empty() {
        out.insert("saturatesFirst".into(), json!(saturates));
        let early = |target: bool| -> Vec<String> { saturates.iter().filter(|x| (n(x, &["atStep"]) as usize) < last_needed && is_target(&s(x, &["service"])) == target).map(|x| format!("{} (step {})", s(x, &["service"]), s(x, &["atStep"]))).collect() };
        let (on_the_way, overshoot) = (early(false), early(true));
        if on_the_way.is_empty() && overshoot.is_empty() {
            notes.push(format!("{} would reach its modelled capacity at the last step: the thresholds may stop the test there, and a limit seen is evidence too", saturates.iter().map(|x| s(x, &["service"])).collect::<Vec<_>>().join(", ")));
        }
        if !on_the_way.is_empty() {
            notes.push(format!(
                "{} sit{} on the way and would reach {} modelled capacity before the targets: the thresholds likely stop the test there. Give {} headroom where the test runs (more replicas), or read the stop as {} limit, seen",
                on_the_way.join(", "),
                if on_the_way.len() == 1 { "s" } else { "" },
                if on_the_way.len() == 1 { "its" } else { "their" },
                if on_the_way.len() == 1 { "it" } else { "them" },
                if on_the_way.len() == 1 { "its" } else { "their" }
            ));
        }
        if !overshoot.is_empty() {
            notes.push(format!("{}: the mix drives {} on past {} capacity towards another target's share, and the thresholds likely stop the test there; plan the targets one at a time (services: [one]) to take each to its own", overshoot.join(", "), if overshoot.len() == 1 { "it" } else { "them" }, if overshoot.len() == 1 { "its" } else { "their" }));
        }
    }
    if !also.is_empty() {
        out.insert("alsoDriven".into(), json!(also));
    }
    out.insert("abort".into(), json!({ "errorRate": slo["errorRate"], "p99Ms": slo["p99Ms"], "how": "k6 thresholds per step (abortOnFail): the first step whose errors or p99 pass the SLO ends the test" }));
    out.insert("script".into(), json!({ "path": file, "run": format!("{}=https://<the system under test> k6 run {}", base_env, file), "baseUrlEnv": base_env, "authEnv": auth_env, "fillIn": inputs }));
    out.insert("where".into(), json!(where_));
    out.insert("cost".into(), cost);
    out.insert(
        "followUp".into(),
        json!([
            { "tool": "collect_telemetry", "arguments": collect, "why": "the history again, with the test's window beside it (while the backend still holds the first one)" },
            { "tool": "calibrate_model", "arguments": calibrate, "why": "refit capacities and latency where the test drove them" },
            if changes.is_empty() { json!({ "tool": "verify_change", "why": "verify the change again: the services the test drove now have history at that load" }) } else { json!({ "tool": "verify_change", "arguments": Value::Object(verify), "why": "the same changes, replayed over the ordinary history only" }) },
        ]),
    );
    out.insert("expect".into(), json!(expect));
    if !others.is_empty() {
        out.insert("otherWarnings".into(), json!(others));
    }
    out.insert("notes".into(), json!(notes));
    Ok(Value::Object(out))
}

/// `hindcast loadtest plan`: the tool from a shell, read as a plan rather than JSON
pub fn command(rest: &[String], out: &mut crate::cli::util::Out) -> Result<i32, String> {
    use crate::cli::util::*;
    let f = flags(rest);
    if f.pos.first().map(|s| s.as_str()) != Some("plan") || f.has("help") || f.has("h") {
        out.log("hindcast loadtest plan [strategy.yaml …] [--base <dir> --head <dir>] [--service frontend[=0.9],…]\n                       [--workspace .hindcast] [--scale 1.3 | --peak 400] [--last 7d] [--margin 1.1] [--steps 5] [--hold 120]\n                       [--mix focused|recorded] [--out loadtest.k6.js] [--json]\n\nThe load test an inconclusive verdict asks for (plan_load_test): which services, up to what rate, through which\nendpoints; a step-load k6 script that stops at the SLO; and the calls that read it back in. Nothing is run.");
        return Ok(if f.pos.first().map(|s| s.as_str()) == Some("plan") { 0 } else { 1 });
    }
    let mut a = JMap::new();
    if let Some(w) = f.get("workspace") {
        a.insert("workspace".into(), json!(w));
    }
    let mut changes: Vec<Value> = f.pos[1..].iter().map(|p| read(p).map(|t| json!({ "strategy": t }))).collect::<Result<_, _>>()?;
    if let (Some(b), Some(h)) = (f.get("base"), f.get("head")) {
        changes.push(json!({ "kubernetes": { "base": b, "head": h } }));
    }
    if !changes.is_empty() {
        a.insert("changes".into(), json!(changes));
    }
    if let Some(list) = f.get("service") {
        let svcs: Vec<Value> = list
            .split(',')
            .filter(|x| !x.is_empty())
            .map(|x| match x.split_once('=') {
                Some((id, u)) => json!({ "service": id, "utilization": crate::import::js_number(u) }),
                None => json!({ "service": x }),
            })
            .collect();
        a.insert("services".into(), json!(svcs));
    }
    if let Some(x) = f.num("scale") {
        a.insert("traffic".into(), json!({ "scale": x }));
    } else if let Some(x) = f.num("peak") {
        a.insert("traffic".into(), json!({ "peakRps": x }));
    }
    for (flag, key) in [("margin", "margin"), ("steps", "steps"), ("hold", "holdS")] {
        if let Some(x) = f.num(flag) {
            a.insert(key.into(), json!(x));
        }
    }
    for (flag, key) in [("last", "last"), ("mix", "mix")] {
        if let Some(x) = f.get(flag) {
            a.insert(key.into(), json!(x));
        }
    }
    let r = match super::run_tool("plan_load_test", &Value::Object(a)) {
        Ok(r) => r,
        Err(e) => {
            out.err(&e);
            return Ok(1);
        }
    };
    if let (Some(dst), Some(src)) = (f.get("out"), r.get("script").and_then(|x| x.get("path")).and_then(|x| x.as_str())) {
        write(&dst, &read(src)?)?;
    }
    if f.has("json") {
        out.log(&pretty(&r));
        return Ok(0);
    }
    out.log(&plan_text(&r, f.get("out").as_deref()));
    Ok(0)
}

/// the plan as a person reads it
fn plan_text(r: &Value, copied: Option<&str>) -> String {
    use crate::cli::util::{bold, dim};
    let mut l: Vec<String> = vec![];
    for v in arr(r, &["verdicts"]) {
        l.push(format!("{}: {}{} at {} confidence", s(v, &["name"]), s(v, &["verdict"]), if g(v, &["leans"]).is_null() { String::new() } else { format!(" (leans {})", s(v, &["leans"])) }, s(v, &["confidence"])));
    }
    if g(r, &["needed"]).as_bool() == Some(false) || g(r, &["planned"]).as_bool() == Some(false) {
        l.push(format!("No load test {}: {}.", if g(r, &["needed"]).as_bool() == Some(false) { "needed" } else { "planned" }, s(r, &["why"])));
        for w in arr(r, &["otherWarnings"]) {
            l.push(format!("  - {}", s(w, &[])));
        }
        for x in arr(r, &["notes"]) {
            l.push(dim(&format!("  {}", s(x, &[]))));
        }
        return l.join("\n");
    }
    l.push(String::new());
    l.push(bold("Services that need evidence"));
    for x in arr(r, &["services"]) {
        l.push(format!(
            "  {}  to {} of capacity: {} req/s on {} × {} req/s{}",
            s(x, &["service"]),
            pct(n(x, &["targetUtil"])),
            js_num(n(x, &["targetRps"])),
            js_num(n(x, &["replicas"])),
            js_num(n(x, &["capacityPerReplica"])),
            if g(x, &["reachedAtStep"]).is_null() { String::new() } else { format!(", at step {}", s(x, &["reachedAtStep"])) }
        ));
        l.push(dim(&format!("    {}", s(x, &["why"]))));
    }
    l.push(String::new());
    l.push(bold("Steps (req/s at the entry, recorded mix)"));
    for st in arr(r, &["steps"]) {
        l.push(format!("  {}. {} req/s for {} s", s(st, &["step"]), js_num(n(st, &["entryRps"])), js_num(n(st, &["holdS"]))));
    }
    for e in arr(r, &["entry"]) {
        l.push(dim(&format!("     {} {}% ({} … {} req/s)", s(e, &["endpoint"]), js_num(js_round(n(e, &["share"]) * 100.0)), js_num(arr(e, &["rps"]).first().and_then(|x| x.as_f64()).unwrap_or(0.0)), js_num(arr(e, &["rps"]).last().and_then(|x| x.as_f64()).unwrap_or(0.0)))));
    }
    l.push(String::new());
    l.push(format!("{} {}", bold("Script:"), copied.map(String::from).unwrap_or_else(|| s(r, &["script", "path"]))));
    l.push(format!("  stops at errors > {}% or p99 > {} ms per step; run: {}", js_num(r2(n(r, &["abort", "errorRate"]) * 100.0)), js_num(n(r, &["abort", "p99Ms"])), match copied {
        Some(c) => s(r, &["script", "run"]).replace(&s(r, &["script", "path"]), c),
        None => s(r, &["script", "run"]),
    }));
    for x in arr(r, &["script", "fillIn"]) {
        l.push(format!("  fill in: {}", s(x, &[])));
    }
    l.push(format!("{} {}", bold("Cost:"), s(r, &["cost", "words"])));
    l.push(bold("Where"));
    for w in arr(r, &["where"]) {
        l.push(format!("  - {}", s(w, &[])));
    }
    l.push(bold("Then"));
    for (i, c) in arr(r, &["followUp"]).iter().enumerate() {
        l.push(format!("  {}. {} {}", i + 1, s(c, &["tool"]), if g(c, &["arguments"]).is_null() { "(with the change to answer)".to_string() } else { crate::convert::js_stringify(g(c, &["arguments"])) }));
        l.push(dim(&format!("     {}", s(c, &["why"]))));
    }
    l.push(bold("Expect"));
    for x in arr(r, &["expect"]) {
        l.push(format!("  - {}", s(x, &[])));
    }
    for x in arr(r, &["notes"]) {
        l.push(dim(&format!("  {}", s(x, &[]))));
    }
    l.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_are_read_from_endpoint_ids() {
        assert_eq!(http_of("frontend GET /api/cart", "frontend"), Some(("GET".into(), "/api/cart".into(), false)));
        assert_eq!(http_of("frontend post /api/checkout", "frontend"), Some(("POST".into(), "/api/checkout".into(), false)));
        assert_eq!(http_of("frontend /dispatch", "frontend"), Some(("GET".into(), "/dispatch".into(), true)));
        assert_eq!(http_of("cart oteldemo.CartService/GetCart", "cart"), None);
        assert_eq!(placeholders("/api/{id}/items/{item}/{id}"), vec!["id".to_string(), "item".to_string()]);
    }

    #[test]
    fn the_low_warnings_are_the_judges() {
        // worded in judge.rs: the four that hold a verdict at low confidence, and two that don't
        assert!(holds_low("frontend would run at 89% of a capacity the history never tested (peak 41%): the outcome rests on an extrapolated limit"));
        assert!(holds_low("recommendation: the model fits it poorly, and this change pushes it harder than the history did"));
        assert!(holds_low("api has no latency metric, so its capacity is read from CPU alone, and this change runs it at 95% of that capacity, past the history's peak of 60%: CPU per request there is extrapolated"));
        assert!(holds_low("the model missed p99 (holdout, off by 70%) on data it never saw: off by more than half on what the verdict is counted from (latency, the breaking point), so a replay can't be trusted to place the SLO's edge"));
        assert!(!holds_low("route would run at 41% of capacity, past the history's 14%: its capacity there is extrapolated"));
        assert!(!holds_low("only 0.6 h of history: daily and weekly peaks may be missing"));
    }

    #[test]
    fn a_reason_asking_for_a_load_test_names_the_tool() {
        let mut out = json!({ "results": [{ "reasons": ["costs the same", "the backtest passes, but confidence is low (x) — load-test before trusting it"] }] });
        point_to_plan(&mut out);
        assert_eq!(out["results"][0]["reasons"][1], "the backtest passes, but confidence is low (x) — load-test before trusting it: plan_load_test with the same changes designs that test");
        assert_eq!(out["results"][0]["reasons"][0], "costs the same");
    }

    /// the Shop's model and recorded day in a workspace of their own
    fn shop(k: &str) -> Workspace {
        let dir = std::env::temp_dir().join(format!("hindcast-loadtest-{}-{}", k, std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("model.json"), include_str!("../../../../reference/shop/model.json")).unwrap();
        std::fs::write(dir.join("dataset.json"), include_str!("../../../../reference/shop/dataset.json")).unwrap();
        Workspace::new(Some(dir.to_str().unwrap()))
    }

    #[test]
    fn a_service_is_driven_through_the_endpoints_that_reach_it() {
        let ws = shop("a");
        let p = plan_load_test(&ws, &json!({ "services": [{ "service": "recommendation" }] })).unwrap();
        assert_eq!(p["needed"], true);
        let svc = &p["services"][0];
        // 90% of 76.4 req/s on its one replica; only GET /api/recommendations reaches it, once per request
        assert_eq!(svc["targetUtil"], 0.9);
        assert!((n(svc, &["targetRps"]) - 68.8).abs() < 0.1, "{}", svc);
        assert_eq!(svc["reachedAtStep"], 5);
        let entry = arr(&p, &["entry"]);
        assert_eq!(entry.len(), 1);
        assert_eq!(entry[0]["endpoint"], "frontend GET /api/recommendations");
        // from the history's peak through it (277.9 req/s × its 12.5%) to the target, in five steps
        let steps = arr(&p, &["steps"]);
        assert_eq!(steps.len(), 5);
        assert!((n(steps[0], &["entryRps"]) - 34.7).abs() < 0.2 && (n(steps[4], &["entryRps"]) - 68.8).abs() < 0.1, "{}", p["steps"]);
        // each step holds two 30 s buckets at least
        assert!(steps.iter().all(|s| n(s, &["holdS"]) >= 120.0));
        // product-catalog takes five calls per request: past its history, nowhere near its limit
        assert!((n(steps[4], &["utilization", "product-catalog"]) - 68.75 * 5.0 / 1522.24).abs() < 0.01, "{}", steps[4]);
        let script = std::fs::read_to_string(s(&p, &["script", "path"])).unwrap();
        assert!(script.contains("abortOnFail: true") && script.contains("'http_req_duration{step:5}': [{ threshold: 'p(99)<=800'") && script.contains("rate<=0.01"), "{}", script);
        assert!(script.contains("const BASE_URL = __ENV.BASE_URL;") && script.contains("const AUTH = __ENV.AUTH_HEADER;"));
        let tools: Vec<String> = arr(&p, &["followUp"]).iter().map(|c| s(c, &["tool"])).collect();
        assert_eq!(tools, ["collect_telemetry", "calibrate_model", "verify_change"]);
        assert_eq!(p["followUp"][0]["arguments"]["windows"].as_array().unwrap().len(), 2);
        assert_eq!(p["followUp"][1]["arguments"]["holdout"], 0);
    }

    #[test]
    fn a_smaller_staging_and_an_unknown_service() {
        let ws = shop("b");
        // the replicas the test runs with set the rates, and are said where to run it
        let p = plan_load_test(&ws, &json!({ "services": [{ "service": "frontend", "utilization": 0.8 }], "replicas": { "frontend": 2 } })).unwrap();
        assert!((n(&p["services"][0], &["targetRps"]) - 0.8 * 277.83 * 2.0).abs() < 0.5, "{}", p["services"][0]);
        assert!(s(&p, &["where"]).contains("frontend: 2 replicas"));
        assert!(plan_load_test(&ws, &json!({ "services": [{ "service": "ghost" }] })).unwrap_err().contains("no service \"ghost\""));
        assert!(plan_load_test(&ws, &json!({})).is_err());
    }
}
