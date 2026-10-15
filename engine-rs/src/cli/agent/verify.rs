//! The verdicts an agent acts on (agent/verify.ts): calibrate_model with its trust report, model_status,
//! verify_change (strategies, manifest diffs, Terraform plans, edited manifests against the live
//! snapshot), and verify_design. Every answer says how far to trust it.

use super::workspace::{iso, iso_full, now_s, seconds, Workspace};
use crate::cli::reports::{arr, g, inf, n, s};
use crate::math::{js_locale, js_num, js_round, js_to_fixed};
use serde_json::{json, Map as JMap, Value};
use std::path::Path;

fn r1(x: f64) -> f64 {
    js_round(x * 10.0) / 10.0
}
fn r2(x: f64) -> f64 {
    js_round(x * 100.0) / 100.0
}
fn pct(x: f64) -> String {
    format!("{}%", js_num(js_round(x * 100.0)))
}
fn money(x: f64) -> String {
    format!("{}${}", if x < 0.0 { "−" } else { "+" }, js_to_fixed(x.abs(), if x.abs() < 100.0 { 2 } else { 0 }))
}
fn num(x: f64) -> Value {
    serde_json::Number::from_f64(x).map(Value::Number).unwrap_or(Value::Null)
}
fn range(x: &Value, f: &dyn Fn(f64) -> f64) -> Value {
    json!({ "p50": num(f(n(x, &["p50"]))), "lo": num(f(n(x, &["lo"]))), "hi": num(f(n(x, &["hi"]))) })
}
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(x) => x.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(false),
        Value::String(x) => !x.is_empty(),
        _ => true,
    }
}

const LIMIT_SEEN: f64 = 0.85;

fn model_of(v: &Value) -> Result<crate::model::Model, String> {
    serde_json::from_value(v.clone()).map_err(|e| format!("model: {}", e))
}
fn dataset_of(v: &Value) -> Result<crate::dataset::Dataset, String> {
    serde_json::from_value(v.clone()).map_err(|e| format!("dataset: {}", e))
}
fn to_json<T: serde::Serialize>(x: &T) -> Value {
    serde_json::to_value(x).unwrap_or(Value::Null)
}

// ---- calibrate

fn trust_of(m: &Value, id: &str, peak: Option<f64>) -> Value {
    let sv = g(m, &["services", id]);
    let cap = inf(sv, &["capacity", "perReplicaRps"]);
    let cap = if cap.is_finite() { Some(cap) } else { None };
    let basis = if s(sv, &["kind"]) == "external" {
        "not modelled"
    } else if cap.is_none() {
        "no limit seen"
    } else if peak.unwrap_or(0.0) >= LIMIT_SEEN || truthy(g(sv, &["capacity", "overloadedRps"])) {
        "limit seen in history"
    } else {
        "extrapolated"
    };
    let band = arr(sv, &["capacity", "band"]);
    let limit = match s(sv, &["capacity", "limit"]).as_str() {
        "cpu" => "CPU".to_string(),
        "concurrency" => format!("{} at a time (lock / pool)", js_num(n(sv, &["capacity", "servers"]))),
        _ => "none seen".to_string(),
    };
    let hosted = s(sv, &["hostedBy"]);
    let cost = if !hosted.is_empty() {
        format!("runs inside {}, billed with it", hosted)
    } else if s(sv, &["cost", "source"]) == "bill" {
        format!("${}/replica-hour from the bill", js_to_fixed(n(sv, &["cost", "perReplicaHour"]), 4))
    } else if s(sv, &["cost", "source"]) == "pricing" {
        format!("${}/replica-hour at list price", js_to_fixed(n(sv, &["cost", "perReplicaHour"]), 4))
    } else if s(sv, &["cost", "source"]) == "nodes" {
        format!("${}/replica-hour, its requests' share of a node", js_to_fixed(n(sv, &["cost", "perReplicaHour"]), 4))
    } else {
        "no price".to_string()
    };
    json!({
        "service": id,
        "fit": s(sv, &["fit", "status"]),
        "capacityPerReplica": cap.map(|c| num(r2(c))).unwrap_or(Value::Null),
        "band": if band.len() >= 2 { json!([num(r2(band[0].as_f64().unwrap_or(f64::NAN))), num(r2(band[1].as_f64().unwrap_or(f64::NAN)))]) } else { Value::Null },
        "limit": limit,
        "replicas": g(sv, &["replicas"]),
        "historyPeakUtil": peak.map(|p| num(r2(p))).unwrap_or(Value::Null),
        "basis": basis,
        "cost": cost,
        "notes": g(sv, &["fit", "notes"]),
    })
}

pub fn accuracy_of(m: &Value) -> Value {
    Value::Array(
        arr(m, &["accuracy"])
            .iter()
            .map(|a| {
                json!({
                    "method": if s(a, &["method"]) == "reference" { "recorded runs the model never saw" } else { "holdout: the last part of the history, held back" },
                    "label": g(a, &["label"]),
                    "checks": arr(a, &["checks"]).iter().map(|c| json!({ "metric": g(c, &["metric"]), "predicted": num(r2(n(c, &["predicted"]))), "measured": num(r2(n(c, &["measured"]))), "error": pct(n(c, &["error"])), "tolerance": pct(inf(c, &["tolerance"])), "pass": g(c, &["pass"]), "note": g(c, &["note"]) })).collect::<Vec<_>>(),
                })
            })
            .collect(),
    )
}

/// services whose history holds more than one configuration: which one each is fitted on, and why
pub fn regime_lines(m: &Value) -> Vec<String> {
    let mut out = vec![];
    for (id, sv) in g(m, &["services"]).as_object().cloned().unwrap_or_default() {
        let r = g(&sv, &["fit", "regime"]);
        if r.is_null() {
            continue;
        }
        let settings: Vec<String> = g(r, &["settings"]).as_object().map(|o| o.iter().map(|(k, v)| crate::regimes::setting_label(k, v.as_f64().unwrap_or(f64::NAN))).collect()).unwrap_or_default();
        let l = g(r, &["latest"]);
        out.push(if l.is_null() {
            format!("{}: {} configurations in the history; fitted on the latest ({}), {} h of traffic", id, js_num(n(r, &["configurations"])), settings.join(", "), js_num(n(r, &["busyHours"])))
        } else {
            format!(
                "{}: {} configurations in the history; fitted on the one with the most traffic ({}, {} h), as the latest ({} since {}) has {} h, under the {} h needed",
                id,
                js_num(n(r, &["configurations"])),
                settings.join(", "),
                js_num(n(r, &["busyHours"])),
                arr(l, &["differs"]).iter().map(|x| s(x, &[])).collect::<Vec<_>>().join(", "),
                crate::regimes::when(n(l, &["since"])),
                js_num(n(l, &["busyHours"])),
                js_num(crate::regimes::MIN_BUSY_S / 3600.0)
            )
        });
    }
    out
}

/// the note that says why a fit is poor: capacity read two ways, the replay missing, CPU not following
/// load — before whatever note happens to come first
fn why_untrusted(notes: Vec<&Value>) -> String {
    let texts: Vec<String> = notes.iter().map(|n| s(n, &[])).collect();
    ["read the limit differently", "reproduces its self time", "barely follows load"].iter().find_map(|k| texts.iter().find(|t| t.contains(k)).cloned()).or_else(|| texts.first().cloned()).unwrap_or_default()
}

fn summary(m: &Value, cal: &Value, warnings: &[String]) -> Value {
    let svcs = arr(cal, &["services"]);
    let ok = |x: &&&Value| matches!(s(x, &["fit"]).as_str(), "good" | "fair");
    let trusted: Vec<String> = svcs.iter().filter(ok).filter(|x| s(x, &["basis"]) != "extrapolated").map(|x| s(x, &["service"])).collect();
    let caution: Vec<String> = svcs.iter().filter(ok).filter(|x| s(x, &["basis"]) == "extrapolated").map(|x| format!("{}: capacity extrapolated (history peaked at {} of it)", s(x, &["service"]), pct(g(x, &["historyPeakUtil"]).as_f64().unwrap_or(0.0)))).collect();
    let untrusted: Vec<String> = svcs.iter().filter(|x| matches!(s(x, &["fit"]).as_str(), "poor" | "unexplained")).map(|x| format!("{}: fit {} — {}", s(x, &["service"]), s(x, &["fit"]), why_untrusted(arr(x, &["notes"])))).collect();
    let cost_only: Vec<String> = svcs.iter().filter(|x| s(x, &["fit"]) == "cost-only").map(|x| s(x, &["service"])).collect();
    let mut o = JMap::new();
    o.insert("model".into(), g(m, &["name"]).clone());
    o.insert("fittedOn".into(), g(cal, &["fittedOn"]).clone());
    o.insert("slo".into(), g(m, &["slo"]).clone());
    if let Some(t) = m.get("traffic") {
        // req/s to two decimals: the model keeps the full precision
        let rounded = t.as_object().map(|t| Value::Object(t.iter().map(|(k, v)| (k.clone(), v.as_f64().map(|x| num(r2(x))).unwrap_or_else(|| v.clone()))).collect())).unwrap_or_else(|| t.clone());
        o.insert("traffic".into(), rounded);
    }
    o.insert("services".into(), g(cal, &["services"]).clone());
    o.insert(
        "endpoints".into(),
        Value::Array(g(m, &["endpoints"]).as_object().map(|e| e.values().map(|e| json!({ "endpoint": g(e, &["id"]), "share": num(r2(n(e, &["share"]))), "slo": g(e, &["slo"]), "fit": g(e, &["fit", "status"]) })).collect()).unwrap_or_default()),
    );
    o.insert("accuracy".into(), accuracy_of(m));
    let mut t = json!({ "trusted": trusted, "caution": caution, "untrusted": untrusted, "costOnly": cost_only });
    let regimes = regime_lines(m);
    if !regimes.is_empty() {
        t["regimes"] = json!(regimes);
    }
    o.insert("trust".into(), t);
    o.insert("warnings".into(), json!(warnings));
    o.insert("files".into(), json!({ "model": "model.json", "calibration": "calibration.json" }));
    o.insert("next".into(), json!("verify_change"));
    Value::Object(o)
}

/// the options calibrate_model fits with: the call's, else the workspace's system settings
pub fn calibrate_options(ws: &Workspace, o: &Value) -> Result<crate::calibrate::CalibrateOptions, String> {
    let src = ws.sources()?;
    let slo = o.get("slo").filter(|x| !x.is_null()).or_else(|| src.get("system").and_then(|s| s.get("slo")).filter(|x| !x.is_null())).cloned();
    let timeout = o.get("timeoutMs").and_then(|x| x.as_f64()).or_else(|| src.get("system").and_then(|s| s.get("timeoutMs")).and_then(|x| x.as_f64())).filter(|t| *t != 0.0);
    let mut opts = crate::calibrate::CalibrateOptions::default();
    if let Some(sl) = &slo {
        opts.slo = serde_json::from_value(sl.clone()).ok();
    }
    opts.timeout_ms = timeout;
    opts.list_prices = Some(o.get("listPrices").cloned().filter(|x| !x.is_null()).unwrap_or(json!(true)));
    Ok(opts)
}

pub fn calibrate_model(ws: &Workspace, o: &Value) -> Result<Value, String> {
    let dv = ws.read_json("dataset.json")?;
    let d = dataset_of(&dv)?;
    super::progress(&format!("fitting {} services on {} buckets", d.services.len(), js_num(d.n)), 0.0, 3.0);
    let opts = calibrate_options(ws, o)?;
    let m = crate::calibrate::calibrate(&d, &opts);
    let mut mv = to_json(&m);
    let mut warnings: Vec<String> = vec![];
    let holdout = o.get("holdout").and_then(|x| x.as_f64()).unwrap_or(0.3);
    super::progress("measuring accuracy on the held-back requests", 1.0, 3.0);
    if holdout > 0.0 && d.n >= 30.0 {
        let rec = crate::accuracy::holdout_accuracy(&d, &opts, Some(holdout), None);
        if rec.checks.is_empty() {
            // an empty accuracy list reads as "fine"; say it was not measured, and why
            let ep_latency = d.endpoints.values().any(|e| e.p99_ms.as_ref().map(|v| v.iter().any(|x| x.is_some())).unwrap_or(false));
            warnings.push(if ep_latency {
                "accuracy not measured: the held-back part of the history has no end-to-end latency to compare with — trust the fit notes per service, and verify one change against a real rollout".to_string()
            } else {
                "accuracy not measured: the data has no end-to-end latency per endpoint (span names that carry raw URLs are dropped). Name server spans by route (http.route), or give request logs, so the model can be checked on held-back history".to_string()
            });
        }
        if let Some(Value::Array(a)) = mv.get_mut("accuracy") {
            a.push(to_json(&rec));
        }
    } else if holdout > 0.0 {
        warnings.push(format!("only {} buckets of history: too short to hold any back and measure accuracy", js_num(d.n)));
    }
    ws.write_json("model.json", &mv, true)?;
    super::progress("replaying the history for the trust report", 2.0, 3.0);
    // replay the history once: how close each service came to its fitted capacity
    let replay = crate::backtest::backtest(&m, &d, &[], &crate::backtest::BacktestOptions { draws: Some(1.0), ..Default::default() })?;
    let rv = to_json(&replay);
    let peak = g(&rv, &["baseline", "peakUtil"]).clone();
    let fitted = g(&mv, &["fittedOn"]);
    let cal = json!({
        "model": g(&mv, &["name"]),
        "fittedOn": { "start": iso(n(fitted, &["start"])), "end": iso(n(fitted, &["end"])), "hours": num(r1((n(fitted, &["end"]) - n(fitted, &["start"])) / 3600.0)), "stepS": g(fitted, &["stepS"]) },
        "services": g(&mv, &["services"]).as_object().map(|svcs| svcs.keys().map(|id| trust_of(&mv, id, peak.get(id).and_then(|x| x.as_f64()))).collect::<Vec<_>>()).unwrap_or_default(),
        "historyPeakUtil": peak.as_object().map(|p| p.iter().map(|(k, v)| (k.clone(), num(r2(v.as_f64().unwrap_or(f64::NAN))))).collect::<JMap<String, Value>>()).unwrap_or_default(),
        "traffic": mv.get("traffic").cloned().unwrap_or(Value::Null),
    });
    let mut cal = cal;
    if mv.get("traffic").is_none() {
        cal.as_object_mut().unwrap().shift_remove("traffic");
    }
    ws.write_json("calibration.json", &cal, true)?;
    Ok(summary(&mv, &cal, &warnings))
}

// ---- status

pub fn model_status(ws: &Workspace) -> Result<Value, String> {
    let src = ws.sources()?;
    let now = now_s();
    let mut out = JMap::new();
    out.insert("workspace".into(), json!(ws.dir_str()));
    out.insert("sources".into(), src.clone());
    let mut warnings: Vec<String> = vec![];
    let mut next = "connect_telemetry";
    if src.get("prometheus").is_some() {
        next = "collect_telemetry";
    }
    if ws.has("dataset.json") {
        let d = ws.read_json("dataset.json")?;
        let (st, nn, step) = (n(&d, &["start"]), n(&d, &["n"]), n(&d, &["stepS"]));
        let end = st + nn * step;
        let mtime = std::fs::metadata(ws.path("dataset.json")).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as f64).unwrap_or(0.0);
        out.insert(
            "dataset".into(),
            json!({ "window": { "start": iso(st), "end": iso(end), "hours": num(r1((nn * step) / 3600.0)), "stepS": num(step) }, "services": d["services"].as_object().map(|x| x.len()).unwrap_or(0), "endpoints": d["endpoints"].as_object().map(|x| x.len()).unwrap_or(0), "bill": d.get("bill").map(|b| !b.is_null()).unwrap_or(false), "collectedHoursAgo": num(r1((now - mtime / 1000.0) / 3600.0)) }),
        );
        if now - end > 7.0 * 86400.0 {
            warnings.push(format!("the history ends {} days ago: collect again before trusting it for today's traffic", js_num(js_round((now - end) / 86400.0))));
        }
        next = "calibrate_model";
    }
    if ws.has("model.json") {
        let m = ws.read_json("model.json")?;
        let model = if ws.has("calibration.json") { summary(&m, &ws.read_json("calibration.json")?, &[]) } else { json!({ "model": g(&m, &["name"]), "accuracy": accuracy_of(&m) }) };
        out.insert("model".into(), model);
        next = "verify_change";
        let misses: Vec<String> = arr(&m, &["accuracy"]).iter().flat_map(|a| arr(a, &["checks"])).filter(|c| !g(c, &["pass"]).as_bool().unwrap_or(false) && s(c, &["metric"]) != "errors").map(|c| s(c, &["metric"])).collect();
        if arr(&m, &["accuracy"]).is_empty() {
            warnings.push("accuracy not measured: calibrate_model with holdout > 0 on a longer history".into());
        }
        if !misses.is_empty() {
            warnings.push(format!("the model missed {} on data it never saw — treat those numbers as rough", misses.join(", ")));
        }
    }
    let rd = ws.path("reports");
    if Path::new(&rd).exists() {
        let mut names: Vec<String> = std::fs::read_dir(&rd).map(|r| r.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect()).unwrap_or_default();
        names.sort();
        let k = names.len().saturating_sub(10);
        out.insert("reports".into(), json!(names[k..].to_vec()));
    }
    out.insert("warnings".into(), json!(warnings));
    out.insert("next".into(), json!(next));
    Ok(Value::Object(out))
}

// ---- verify a change

/// manifests from a directory, a file, or YAML text
fn read_yaml_texts(p: &str) -> Result<Vec<String>, String> {
    let looks_yaml = p.contains('\n') && p.split('\n').any(|l| { let t = l.trim_start(); t.starts_with("apiVersion") || t.starts_with("kind") || t.starts_with("---") });
    if looks_yaml {
        return Ok(vec![p.to_string()]);
    }
    let path = Path::new(p);
    if !path.exists() {
        return Err(format!("{}: no such file or directory", p));
    }
    if !path.is_dir() {
        return Ok(vec![std::fs::read_to_string(p).map_err(|e| e.to_string())?]);
    }
    let mut names: Vec<String> = std::fs::read_dir(p).map_err(|e| e.to_string())?.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
    names.sort();
    let mut out = vec![];
    for f in names {
        let full = format!("{}/{}", p.trim_end_matches('/'), f);
        if Path::new(&full).is_dir() {
            out.extend(read_yaml_texts(&full)?);
        } else if f.ends_with(".yaml") || f.ends_with(".yml") || f.ends_with(".json") {
            out.push(std::fs::read_to_string(&full).map_err(|e| e.to_string())?);
        }
    }
    Ok(out)
}

fn workloads_of(texts: &[String]) -> Result<indexmap::IndexMap<String, crate::config_diff::WorkloadConfig>, String> {
    let mut docs = vec![];
    for t in texts {
        docs.extend(crate::cli::util::yaml_documents(t)?);
    }
    Ok(crate::config_diff::read_workloads(&docs))
}

fn latest_snapshot(ws: &Workspace) -> Result<String, String> {
    let dir = ws.path("cluster");
    let mut files: Vec<String> = if Path::new(&dir).exists() { std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|f| f.ends_with(".json")).collect() } else { vec![] };
    files.sort();
    match files.last() {
        Some(f) => Ok(format!("{}/{}", dir, f)),
        None => Err("no cluster snapshot: call read_cluster first".into()),
    }
}

pub fn strategies_from(ws: &Workspace, inputs: &[Value], m: &Value) -> Result<(Vec<Value>, Vec<String>), String> {
    let known: indexmap::IndexSet<String> = g(m, &["services"]).as_object().map(|x| x.keys().cloned().collect()).unwrap_or_default();
    let mut strategies = vec![];
    let mut notes: Vec<String> = vec![];
    for c in inputs {
        if let Some(st) = c.get("strategy") {
            let raw = match st {
                Value::String(t) => crate::cli::util::parse_yaml(t)?,
                x => x.clone(),
            };
            let sp = crate::strategy::normalize_strategy(&raw).map_err(|e| super::explain_schema_error(&e))?;
            for ch in arr(&sp, &["changes"]) {
                if let Some(svc) = ch.get("service").and_then(|x| x.as_str()) {
                    if !known.contains(svc) {
                        return Err(format!("strategy \"{}\": no service \"{}\" in the model (services: {})", s(&sp, &["name"]), svc, known.iter().cloned().collect::<Vec<_>>().join(", ")));
                    }
                }
            }
            strategies.push(sp);
        } else if let Some(k) = c.get("kubernetes") {
            let r = crate::config_diff::strategy_from_diff(&workloads_of(&read_yaml_texts(&s(k, &["base"]))?)?, &workloads_of(&read_yaml_texts(&s(k, &["head"]))?)?, None, Some(&known));
            notes.extend(r.ignored.iter().map(|x| format!("kubernetes diff: {}", x)));
            match r.strategy {
                Some(st) => strategies.push(st),
                None => notes.push("kubernetes diff: nothing the model can backtest changed (replicas, CPU/memory limits, HPAs, arch)".into()),
            }
        } else if let Some(t) = c.get("terraformPlan") {
            let plan = match t {
                Value::String(p) => serde_json::from_str(&std::fs::read_to_string(p).map_err(|_| format!("ENOENT: no such file or directory, open '{}'", p))?).map_err(|e| e.to_string())?,
                x => x.clone(),
            };
            let r = crate::terraform_diff::strategy_from_terraform_plan(&plan, None, Some(&known));
            notes.extend(r.mapped.iter().map(|x| format!("terraform: {}", x)));
            notes.extend(r.ignored.iter().map(|x| format!("terraform: {}", x)));
            match r.strategy {
                Some(st) => strategies.push(st),
                None => notes.push("terraform plan: nothing the model can backtest changed".into()),
            }
        } else if let Some(cl) = c.get("cluster") {
            let snap = match cl.get("snapshot").and_then(|x| x.as_str()) {
                Some(x) => x.to_string(),
                None => latest_snapshot(ws)?,
            };
            let base: Value = serde_json::from_str(&std::fs::read_to_string(&snap).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            let r = crate::config_diff::strategy_from_diff(&workloads_of(&[crate::convert::js_stringify(&base)])?, &workloads_of(&read_yaml_texts(&s(cl, &["head"]))?)?, None, Some(&known));
            notes.push(format!("compared with the live cluster snapshot {}", snap));
            notes.extend(r.ignored.iter().map(|x| format!("cluster diff: {}", x)));
            match r.strategy {
                Some(st) => strategies.push(st),
                None => notes.push("cluster diff: nothing the model can backtest changed".into()),
            }
        }
    }
    Ok((strategies, notes))
}

/// capacity draws that fit a time budget: one replay of the history timed
pub fn draws_for(m: &crate::model::Model, d: &crate::dataset::Dataset, plans: usize, requested: f64, budget_ms: f64) -> (f64, Option<String>) {
    let t0 = std::time::Instant::now();
    let obs = crate::backtest::observed_replicas(d, m);
    crate::engine::run_plan(&crate::backtest::base_plan(m, Some(&obs)), &crate::backtest::traffic_of(d, m), &Default::default());
    let one = (t0.elapsed().as_secs_f64() * 1000.0).max(1.0);
    let threads = std::thread::available_parallelism().map(|x| x.get()).unwrap_or(1) as f64;
    let fit = ((budget_ms * (threads * 0.8).max(1.0)) / (plans as f64 * one)).floor();
    let draws = requested.min(fit).max(3.0);
    if draws < requested {
        (draws, Some(format!("{} capacity draws instead of {}: one replay of this {}-bucket history takes {} ms, so the bands are coarser (the medians are not affected). Pass draws to override, or last to shorten the history", js_num(draws), js_num(requested), js_num(d.n), js_num(js_round(one)))))
    } else {
        (draws, None)
    }
}

/// the last `buckets` of a dataset: the series cut, everything else kept
pub fn slice_last(d: &Value, buckets: usize) -> Value {
    let nn = d["n"].as_f64().unwrap_or(0.0) as usize;
    let k = nn - buckets;
    let cut = |v: &Value| -> Value {
        match v {
            Value::Array(a) => Value::Array(a.iter().skip(k).cloned().collect()),
            x => x.clone(),
        }
    };
    let mut out = d.clone();
    let o = out.as_object_mut().unwrap();
    o.insert("start".into(), num(d["start"].as_f64().unwrap_or(0.0) + k as f64 * d["stepS"].as_f64().unwrap_or(0.0)));
    o.insert("n".into(), json!(buckets));
    for key in ["services", "endpoints"] {
        if let Some(m) = d.get(key).and_then(|x| x.as_object()) {
            o.insert(key.into(), Value::Object(m.iter().map(|(id, sv)| (id.clone(), Value::Object(sv.as_object().map(|x| x.iter().map(|(mk, v)| (mk.clone(), cut(v))).collect()).unwrap_or_default()))).collect()));
        }
    }
    if let Some(c) = d.get("cluster").and_then(|x| x.as_object()) {
        o.insert("cluster".into(), Value::Object(c.iter().map(|(mk, v)| (mk.clone(), cut(v))).collect()));
    }
    out
}

fn breaking(m: &crate::model::Model, plan: &crate::types::Plan) -> (f64, Option<String>) {
    let b = crate::accuracy::model_breaking_point(m, Some(plan), None, None, None);
    (b.rps, b.limited_by)
}

#[allow(clippy::too_many_arguments)]
pub fn judge(mv: &Value, m: &crate::model::Model, r: &Value, st: &Value, spec: &Value, cal: Option<&Value>, gate: f64, before: (f64, Option<String>), after: (f64, Option<String>), d: Option<&crate::dataset::Dataset>) -> Result<Value, String> {
    let dm = g(st, &["delta", "minutesOutOfSlo"]);
    let mut touched: indexmap::IndexSet<String> = indexmap::IndexSet::new();
    for c in arr(spec, &["changes"]) {
        if let Some(svc) = c.get("service").and_then(|x| x.as_str()) {
            touched.insert(svc.to_string());
        }
    }
    let hist_peak = cal.map(|c| g(c, &["historyPeakUtil"]).clone()).unwrap_or_else(|| g(r, &["baseline", "peakUtil"]).clone());
    let mut cost_basis: indexmap::IndexSet<String> = indexmap::IndexSet::new();
    for id in &touched {
        let src = g(mv, &["services", id, "cost", "source"]);
        cost_basis.insert(if src.is_null() { "none".into() } else { s(src, &[]) });
    }
    let svc_of = |id: &str| g(mv, &["services", id]).clone();
    // ---- how far to trust it
    let mut services: Vec<(Value, bool)> = vec![];
    if let Some(pu) = g(st, &["peakUtil"]).as_object() {
        for (id, ppv) in pu {
            let sv = svc_of(id);
            if sv.is_null() || !inf(&sv, &["capacity", "perReplicaRps"]).is_finite() {
                continue;
            }
            let pp = ppv.as_f64().unwrap_or(f64::NAN);
            let hp = hist_peak.get(id).and_then(|x| x.as_f64()).unwrap_or(0.0);
            let host = s(&sv, &["hostedBy"]);
            let t = touched.contains(id) || (!host.is_empty() && touched.contains(&host));
            let relevant = t || pp > 0.6 || pp > hp.max(0.2) * 1.25;
            let basis = if pp <= hp.max(0.3) * 1.1 { "within what the history showed" } else if hp >= LIMIT_SEEN || truthy(g(&sv, &["capacity", "overloadedRps"])) { "near a limit the history reached" } else { "beyond anything the history showed" };
            if relevant {
                services.push((json!({ "service": id, "touched": t, "fit": s(&sv, &["fit", "status"]), "historyPeakUtil": num(r2(hp)), "predictedPeakUtil": num(r2(pp)), "basis": basis }), relevant));
            }
        }
    }
    let services: Vec<Value> = services.into_iter().map(|x| x.0).collect();
    let mut warnings: Vec<String> = vec![];
    let mut level = "high";
    let lower = |to: &'static str, why: String, warnings: &mut Vec<String>, level: &mut &'static str| {
        warnings.push(why);
        if to == "low" || *level == "high" {
            *level = to;
        }
    };
    for x in &services {
        let (pu, hpu) = (n(x, &["predictedPeakUtil"]), n(x, &["historyPeakUtil"]));
        let fit = s(x, &["fit"]);
        let touched_x = g(x, &["touched"]).as_bool().unwrap_or(false);
        let svc = s(x, &["service"]);
        let harder = pu > hpu.max(0.3) * 1.1;
        let poor = fit == "poor" || fit == "unexplained";
        let basis = s(x, &["basis"]);
        if poor && (touched_x || harder) {
            lower("low", format!("{}: the model fits it {}, and this change {}", svc, if fit == "poor" { "poorly" } else { "not at all" }, if touched_x { "changes it" } else { "pushes it harder than the history did" }), &mut warnings, &mut level);
        } else if poor && pu > 0.6 {
            lower("medium", format!("{} fits {} and runs near its limit; the change leaves it as it was, so the comparison holds better than the absolute numbers", svc, if fit == "poor" { "poorly" } else { "not at all" }), &mut warnings, &mut level);
        } else if basis == "beyond anything the history showed" && pu >= 0.8 {
            lower("low", format!("{} would run at {} of a capacity the history never tested (peak {}): the outcome rests on an extrapolated limit", svc, pct(pu), pct(hpu)), &mut warnings, &mut level);
        } else if basis == "beyond anything the history showed" {
            lower("medium", format!("{} would run at {} of capacity, past the history's {}: its capacity there is extrapolated", svc, pct(pu), pct(hpu)), &mut warnings, &mut level);
        } else if fit == "fair" && touched_x {
            lower("medium", format!("{}: fair fit (latency reproduced within 30%)", svc), &mut warnings, &mut level);
        }
    }
    let misses: Vec<String> = arr(mv, &["accuracy"]).iter().flat_map(|a| arr(a, &["checks"]).into_iter().map(move |c| (c, s(a, &["method"])))).filter(|(c, _)| !g(c, &["pass"]).as_bool().unwrap_or(false) && s(c, &["metric"]) != "errors").map(|(c, me)| format!("{} ({}, off by {})", s(c, &["metric"]), me, pct(n(c, &["error"])))).collect();
    if !misses.is_empty() {
        lower("medium", format!("the model missed {} on data it never saw", misses.join(", ")), &mut warnings, &mut level);
    }
    if arr(mv, &["accuracy"]).is_empty() {
        lower("medium", "the model's accuracy was never measured".into(), &mut warnings, &mut level);
    }
    let hours = (n(r, &["window", "end"]) - n(r, &["window", "start"])) / 3600.0;
    if hours < 24.0 {
        lower("medium", format!("only {} h of history: daily and weekly peaks may be missing", js_num(r1(hours))), &mut warnings, &mut level);
    }
    if cost_basis.contains("none") && n(st, &["delta", "monthly", "p50"]).abs() < 0.005 {
        warnings.push("the changed services have no price (no bill, no CPU limit): the cost delta reads $0".into());
    }
    if cost_basis.contains("pricing") {
        warnings.push("costs are AWS Fargate list prices, not your bill: discounts and Savings Plans are not in them".into());
    }
    // ---- verdict
    let (p50, lo, hi) = (n(dm, &["p50"]), n(dm, &["lo"]), n(dm, &["hi"]));
    let mut verdict = if p50 > gate { "fail" } else if hi > gate || level == "low" { "inconclusive" } else { "pass" };
    let base = g(r, &["baseline"]);
    let mut reasons: Vec<String> = vec![crate::cli::reports::headline(st, base)];
    if p50 > gate {
        reasons.push(format!("adds {} min out of SLO (10–90%: {} … {})", js_num(r1(p50)), js_num(r1(lo)), js_num(r1(hi))));
    } else if hi > gate {
        reasons.push(format!("no added time out of SLO at the median, but {} min in the worst 10% of capacity draws", js_num(r1(hi))));
    }
    if verdict == "inconclusive" && level == "low" && hi <= gate {
        reasons.push(format!("the backtest passes, but confidence is low ({}) — load-test before trusting it", warnings.first().cloned().unwrap_or_else(|| "undefined".into())));
    }
    let fb = n(base, &["summary", "failedRequests", "p50"]);
    let fd = n(st, &["delta", "failedRequests", "p50"]);
    if fb > 0.0 && fd.abs() > 0.1 * fb {
        reasons.push(format!(
            "{} {} failed requests ({}{}% of {}){}",
            if fd < 0.0 { "cuts" } else { "adds" },
            js_locale(js_round(fd.abs())),
            if fd < 0.0 { "−" } else { "+" },
            js_num(js_round((fd.abs() / fb) * 100.0)),
            js_locale(js_round(fb)),
            if p50.abs() <= 0.5 { ", though the minutes out of SLO stay the same: something else breaks the SLO in those minutes" } else { "" }
        ));
    }
    if truthy(g(st, &["worst", "service"])) && n(st, &["summary", "peakP99Ms", "p50"]) > n(r, &["slo", "p99Ms"]) {
        reasons.push(format!("worst at {}: {}", iso(n(st, &["worst", "t"])), s(st, &["worst", "why"])));
    }
    let mut worse = vec![];
    if let Some(eps) = g(st, &["endpoints"]).as_object() {
        for (id, e) in eps {
            let was = g(base, &["endpoints", id, "minutesOutOfSlo"]).as_f64().unwrap_or(0.0);
            if n(e, &["minutesOutOfSlo"]) > was + gate {
                worse.push(json!({ "endpoint": id, "minutesOutOfSlo": num(r1(n(e, &["minutesOutOfSlo"]))), "asBuilt": num(r1(was)), "slo": g(e, &["slo"]) }));
            }
        }
    }
    if !worse.is_empty() {
        reasons.push(format!("worse for {} against their own SLOs", worse.iter().map(|w| s(w, &["endpoint"])).collect::<Vec<_>>().join(", ")));
    }
    let cb = g(base, &["cluster"]);
    let ca = g(st, &["cluster"]);
    if !cb.is_null() && !ca.is_null() {
        let fill = |c: &Value, nodes: f64| (n(c, &["peakRequestedCpu"]) / (nodes * n(c, &["nodeCpu"]))).max(n(c, &["peakRequestedMemoryGb"]) / (nodes * n(c, &["nodeMemoryGb"])));
        let freed = n(cb, &["peakRequestedCpu"]) - n(ca, &["peakRequestedCpu"]);
        let freed_mem = n(cb, &["peakRequestedMemoryGb"]) - n(ca, &["peakRequestedMemoryGb"]);
        let auto = g(ca, &["autoscaled"]).as_bool().unwrap_or(false);
        if auto && (n(ca, &["meanNodes"]) - n(cb, &["meanNodes"])).abs() >= 0.05 {
            reasons.push(format!("nodes: {} → {} on average (peak {} → {}), ${}/month {} in node spend", js_num(r1(n(cb, &["meanNodes"]))), js_num(r1(n(ca, &["meanNodes"]))), js_num(n(cb, &["peakNodes"])), js_num(n(ca, &["peakNodes"])), js_num(js_round(((n(ca, &["meanNodes"]) - n(cb, &["meanNodes"])) * n(ca, &["nodeHour"]) * 730.0).abs())), if n(ca, &["meanNodes"]) < n(cb, &["meanNodes"]) { "less" } else { "more" }));
        } else if !auto && (freed > 0.01 || freed_mem > 0.01) {
            reasons.push(format!("frees {} cores and {} MiB of requests, but the node pool is fixed at {}: node spend doesn't change until the pool shrinks. At the peak every pod's requests would fill {}% of it ({}% before)", js_num(r2(freed.max(0.0))), js_num(js_round(freed_mem.max(0.0) * 1024.0)), js_num(n(ca, &["peakNodes"])), js_num(js_round(fill(ca, n(ca, &["peakNodes"])) * 100.0)), js_num(js_round(fill(cb, n(cb, &["peakNodes"])) * 100.0))));
        } else if !auto && fill(ca, n(ca, &["peakNodes"])) > 1.0 {
            reasons.push(format!("pods would request {} cores and {} GiB at the peak, more than the {} fixed nodes hold: some would stay Pending", js_num(r1(n(ca, &["peakRequestedCpu"]))), js_num(r1(n(ca, &["peakRequestedMemoryGb"]))), js_num(n(ca, &["peakNodes"]))));
            if verdict == "pass" {
                verdict = "inconclusive";
            }
        }
    }
    // losing a node: does the change leave a service on one node, and what does losing the busiest node cost
    let mut node_loss_check: Option<Value> = None;
    if let Some(d) = d {
        if g(mv, &["services"]).as_object().map(|x| x.values().any(|s| truthy(g(s, &["pods"])))).unwrap_or(false) {
            let was = crate::resilience::pods_per_node(m, None)?;
            let now = crate::resilience::pods_per_node(m, Some(spec))?;
            let new_single: Vec<String> = touched.iter().filter(|id| was.get(*id).map(|w| w.len() > 1).unwrap_or(false) && now.get(*id).map(|w| w.len() == 1).unwrap_or(false)).cloned().collect();
            let mut weight: indexmap::IndexMap<String, f64> = indexmap::IndexMap::new();
            for id in &touched {
                if let Some(per) = now.get(id) {
                    let total: f64 = per.values().sum();
                    for (node, k) in per {
                        *weight.entry(node.clone()).or_insert(0.0) += k / total.max(1.0);
                    }
                }
            }
            let mut best: Option<(&String, f64)> = None;
            for (k, v) in &weight {
                if best.map(|b| *v > b.1).unwrap_or(true) {
                    best = Some((k, *v));
                }
            }
            if let Some((node, _)) = best {
                let node = node.clone();
                let opts = |strategy: Option<Value>| crate::resilience::NodeLossOptions { nodes: Some(vec![node.clone()]), draws: Some(4.0), strategy, ..Default::default() };
                let a = to_json(&crate::resilience::node_loss(m, d, &opts(None))?);
                let b = to_json(&crate::resilience::node_loss(m, d, &opts(Some(spec.clone())))?);
                let (at, bt) = (g(&a, &["results", "0", "total"]).clone(), g(&b, &["results", "0", "total"]).clone());
                let at = if at.is_null() { arr(&a, &["results"]).first().map(|x| g(x, &["total"]).clone()).unwrap_or(Value::Null) } else { at };
                let bt = if bt.is_null() { arr(&b, &["results"]).first().map(|x| g(x, &["total"]).clone()).unwrap_or(Value::Null) } else { bt };
                if !new_single.is_empty() {
                    reasons.push(format!("{} would run on one node: losing {} takes {} down", new_single.join(", "), node, if new_single.len() == 1 { "it" } else { "them" }));
                }
                let (am, bm) = (n(&at, &["minutesOutOfSlo"]), n(&bt, &["minutesOutOfSlo"]));
                if bm > am + gate {
                    reasons.push(format!("losing {} at the busiest moment: {} min out of SLO as built, {} with the change ({} failed requests)", node, js_num(r1(am)), js_num(r1(bm)), js_locale(js_round(n(&bt, &["failedRequests"])))));
                } else if am > gate && bm < am - gate {
                    reasons.push(format!("losing {} at the busiest moment: {} → {} min out of SLO", node, js_num(r1(am)), js_num(r1(bm))));
                }
                node_loss_check = Some(json!({ "node": node, "asBuilt": at, "withChange": bt, "newSinglePoints": new_single }));
            }
        }
    }
    let peak = if !g(r, &["peakRps"]).is_null() { n(r, &["peakRps"]) } else { g(mv, &["traffic", "peak"]).as_f64().unwrap_or(0.0) };
    let of = if !g(r, &["load"]).is_null() { format!("the replayed traffic peaks at {}", js_num(r1(peak))) } else { format!("the history peaked at {}", js_num(r1(peak))) };
    if after.0 < before.0 * 0.9 {
        reasons.push(format!("headroom drops from {} to {} req/s ({})", js_num(r1(before.0)), js_num(r1(after.0)), of));
    }
    if after.0 < before.0 * 0.9 && after.0 < peak && verdict == "pass" {
        verdict = "inconclusive";
        reasons.push(format!("after the change the system sustains {} req/s, below the peak it has to serve ({})", js_num(r1(after.0)), js_num(r1(peak))));
    }
    let basis = cost_basis.iter().map(|b| match b.as_str() {
        "bill" => "your bill",
        "pricing" => "list price",
        "nodes" => "node share at list price",
        _ => "unpriced",
    }).collect::<Vec<_>>().join(", ");
    let mut o = JMap::new();
    o.insert("name".into(), g(st, &["name"]).clone());
    o.insert("verdict".into(), json!(verdict));
    // which way an inconclusive verdict leans: what the median replay says, before confidence
    if verdict == "inconclusive" {
        o.insert("leans".into(), json!(if p50 > gate { "fail" } else { "pass" }));
    }
    o.insert("summary".into(), json!(crate::cli::reports::headline(st, base)));
    o.insert("reasons".into(), json!(reasons));
    o.insert("change".into(), spec.clone());
    o.insert("cost".into(), json!({ "monthlyDelta": range(g(st, &["delta", "monthly"]), &r2), "monthly": num(r2(n(st, &["summary", "monthly", "p50"]))), "basis": if basis.is_empty() { "unchanged services".to_string() } else { basis } }));
    o.insert(
        "reliability".into(),
        json!({
            "minutesOutOfSloDelta": range(dm, &r1),
            "minutesOutOfSlo": num(r1(n(st, &["summary", "minutesOutOfSlo", "p50"]))),
            "failedRequestsDelta": range(g(st, &["delta", "failedRequests"]), &js_round),
            "errorBudgetUsed": { "asBuilt": pct(n(base, &["summary", "errorBudgetUsed", "p50"])), "after": pct(n(st, &["summary", "errorBudgetUsed", "p50"])) },
            "peakP99Ms": num(js_round(n(st, &["summary", "peakP99Ms", "p50"]))),
            "worst": { "at": iso(n(st, &["worst", "t"])), "p99Ms": num(js_round(n(st, &["worst", "p99Ms"]))), "errorRate": num(r2(n(st, &["worst", "errorRate"]))), "why": s(st, &["worst", "why"]) },
            "incidents": arr(st, &["incidents"]).iter().take(5).map(|x| json!({ "start": iso(n(x, &["start"])), "minutes": num(r1(n(x, &["minutes"]))), "peakP99Ms": num(js_round(n(x, &["peakP99Ms"]))), "why": s(x, &["why"]) })).collect::<Vec<_>>(),
            "endpointsWorse": worse,
        }),
    );
    if let Some(nl) = node_loss_check {
        o.insert("nodeLoss".into(), nl);
    }
    o.insert("headroom".into(), json!({ "beforeRps": num(r1(before.0)), "afterRps": num(r1(after.0)), "limitedBy": after.1, "historyPeakRps": g(mv, &["traffic", "peak"]).as_f64().map(|p| num(r1(p))).unwrap_or(Value::Null), "replayedPeakRps": num(r1(peak)) }));
    o.insert("confidence".into(), json!({ "level": level, "services": services, "warnings": warnings }));
    o.insert("notes".into(), g(st, &["notes"]).clone());
    o.insert("howToRead".into(), json!(format!("{}/month; {}; confidence {}", money(n(st, &["delta", "monthly", "p50"])), match verdict { "pass" => "safe on this history", "fail" => "would have broken the SLO", _ => "not proven either way" }, level)));
    Ok(Value::Object(o))
}

pub fn verify_change(ws: &Workspace, inputs: &[Value], o: &Value) -> Result<Value, String> {
    let mv = ws.read_json("model.json")?;
    let m = model_of(&mv)?;
    let mut dv = ws.read_json("dataset.json")?;
    if let Some(w) = o.get("window").filter(|x| !x.is_null()) {
        let t = |v: &Value| match v {
            Value::Number(x) => {
                let x = x.as_f64().unwrap_or(f64::NAN);
                if x > 1e12 {
                    x / 1000.0
                } else {
                    x
                }
            }
            Value::String(x) => crate::accuracy::parse_iso_ms(x).map(|ms| ms as f64 / 1000.0).unwrap_or(f64::NAN),
            _ => f64::NAN,
        };
        let (st, nn, step) = (dv["start"].as_f64().unwrap_or(0.0), dv["n"].as_f64().unwrap_or(0.0), dv["stepS"].as_f64().unwrap_or(1.0));
        let a = st.max(t(&w["start"]));
        let b = (st + nn * step).min(t(&w["end"]));
        if !(b > a) {
            return Err(format!("window {} … {} is outside the history ({} … {})", iso(t(&w["start"])), iso(t(&w["end"])), iso(st), iso(st + nn * step)));
        }
        let d = dataset_of(&dv)?;
        let sliced = crate::accuracy::slice_dataset(&d, ((a - st) / step).floor() as usize, ((b - st) / step).ceil() as usize);
        dv = to_json(&sliced);
    }
    if let Some(l) = o.get("last").and_then(|x| x.as_str()) {
        let buckets = (seconds(l)? / dv["stepS"].as_f64().unwrap_or(1.0)).ceil() as usize;
        if (buckets as f64) < dv["n"].as_f64().unwrap_or(0.0) {
            dv = slice_last(&dv, buckets);
        }
    }
    let d = dataset_of(&dv)?;
    let cal = if ws.has("calibration.json") { Some(ws.read_json("calibration.json")?) } else { None };
    let (strategies, mut notes) = strategies_from(ws, inputs, &mv)?;
    if strategies.is_empty() {
        return Ok(json!({ "verdict": "nothing to verify", "notes": notes, "results": [] }));
    }
    let gate = o.get("gateMinutes").and_then(|x| x.as_f64()).unwrap_or(0.5);
    let draws = match o.get("draws").and_then(|x| x.as_f64()) {
        Some(x) => x,
        None => {
            let (dr, note) = draws_for(&m, &d, strategies.len() + 1, 30.0, 40_000.0);
            if let Some(nt) = note {
                notes.push(nt);
            }
            dr
        }
    };
    let load = o.get("traffic").filter(|t| t.get("scale").is_some() || t.get("peakRps").is_some()).map(|t| crate::backtest::LoadOpts { scale: t.get("scale").and_then(|x| x.as_f64()), peak_rps: t.get("peakRps").and_then(|x| x.as_f64()) });
    let r = crate::backtest::backtest(&m, &d, &strategies, &crate::backtest::BacktestOptions { draws: Some(draws), load, ..Default::default() })?;
    let mut rv = to_json(&r);
    rv.as_object_mut().unwrap().insert("accuracy".into(), g(&mv, &["accuracy"]).clone());
    if !g(&rv, &["load"]).is_null() {
        notes.push(format!("the history replayed at {}× its load (busiest moment {} req/s): the as-built system and every change see the same traffic, with the history's own daily shape, spikes and endpoint mix", js_num(r2(n(&rv, &["load", "factor"]))), js_num(js_round(n(&rv, &["load", "peakRps"])))));
        let varied: Vec<String> = m.services.keys().filter(|id| {
            let mut set: indexmap::IndexSet<u64> = indexmap::IndexSet::new();
            for v in dv["services"].get(id.as_str()).and_then(|s| s.get("replicas")).and_then(|r| r.as_array()).cloned().unwrap_or_default() {
                if let Some(x) = v.as_f64() {
                    set.insert(x.to_bits());
                }
            }
            set.len() > 1
        }).cloned().collect();
        if !varied.is_empty() {
            notes.push(format!("{}: the as-built replay keeps the replica counts the history had, which an autoscaler would have raised under more load", varied.join(", ")));
        }
    }
    let base = crate::backtest::base_plan(&m, None);
    let before = breaking(&m, &base);
    let mut results = vec![];
    for (i, st) in arr(&rv, &["strategies"]).iter().enumerate() {
        let spec = &strategies[i];
        let applied = crate::strategy::apply_strategy(&m, &base, &crate::strategy::parse_strategy(spec)?)?;
        let after = breaking(&m, &applied.plan);
        results.push(judge(&mv, &m, &rv, st, spec, cal.as_ref(), gate, before.clone(), after, Some(&d))?);
    }
    let mut reports: Option<Value> = None;
    if o.get("report").and_then(|x| x.as_bool()) != Some(false) {
        ws.ensure("reports");
        let name0 = s(&strategies[0], &["name"]).to_lowercase();
        let mut slug_name = String::new();
        let mut run = false;
        for c in name0.chars() {
            if c.is_ascii_lowercase() || c.is_ascii_digit() {
                slug_name.push(c);
                run = false;
            } else if !run {
                slug_name.push('-');
                run = true;
            }
        }
        let slug_name: String = slug_name.chars().take(40).collect();
        let slug = format!("{}-{}", iso_full(now_s())[..19].replace([':', 'T'], "-"), slug_name);
        let rd = ws.path("reports");
        let html = format!("{}/{}.html", rd, slug);
        let md = format!("{}/{}.md", rd, slug);
        let bundle = format!("{}/{}.hindcast.json", rd, slug);
        std::fs::write(&html, crate::cli::reports::backtest_html(&rv, &mv)).map_err(|e| e.to_string())?;
        std::fs::write(&md, crate::cli::reports::backtest_markdown(&rv, &mv)).map_err(|e| e.to_string())?;
        std::fs::write(format!("{}/{}.strategies.yaml", rd, slug), strategies.iter().map(crate::yaml_out::to_yaml).collect::<Vec<_>>().join("---\n")).map_err(|e| e.to_string())?;
        let stamp = iso_full(now_s())[..16].replacen('T', " ", 1);
        let b = json!({ "name": g(&mv, &["name"]), "source": format!("verified by an agent, {} UTC", stamp), "dataset": dv, "model": mv, "strategies": strategies.iter().map(crate::yaml_out::to_yaml).collect::<Vec<_>>() });
        std::fs::write(&bundle, crate::convert::js_stringify(&b)).map_err(|e| e.to_string())?;
        reports = Some(json!({ "html": html, "markdown": md, "bundle": bundle }));
    }
    let worst = if results.iter().any(|x| s(x, &["verdict"]) == "fail") { "fail" } else if results.iter().any(|x| s(x, &["verdict"]) == "inconclusive") { "inconclusive" } else { "pass" };
    let fitted = g(&mv, &["fittedOn"]);
    let bsum = g(&rv, &["baseline", "summary"]);
    let mut out = JMap::new();
    out.insert("verdict".into(), json!(worst));
    out.insert("model".into(), json!({ "name": g(&mv, &["name"]), "fittedOn": { "start": iso(n(fitted, &["start"])), "end": iso(n(fitted, &["end"])) }, "ageDays": num(r1((now_s() - n(fitted, &["end"])) / 86400.0)), "accuracy": accuracy_of(&mv) }));
    out.insert("window".into(), json!({ "start": iso(n(&rv, &["window", "start"])), "end": iso(n(&rv, &["window", "end"])), "hours": num(r1((n(&rv, &["window", "end"]) - n(&rv, &["window", "start"])) / 3600.0)) }));
    out.insert("slo".into(), g(&rv, &["slo"]).clone());
    out.insert("gate".into(), json!(format!("fails if it adds more than {} min out of SLO over the window", js_num(gate))));
    out.insert("asBuilt".into(), json!({ "monthly": num(r2(n(bsum, &["monthly", "p50"]))), "minutesOutOfSlo": num(r1(n(bsum, &["minutesOutOfSlo", "p50"]))), "failedRequests": num(js_round(n(bsum, &["failedRequests", "p50"]))) }));
    out.insert("results".into(), json!(results));
    out.insert("ranking".into(), g(&rv, &["ranking"]).clone());
    out.insert("notes".into(), json!(notes));
    if let Some(rp) = reports {
        out.insert("reports".into(), rp);
    }
    Ok(Value::Object(out))
}

pub fn find_headroom(ws: &Workspace, a: &Value) -> Result<Value, String> {
    let mv = ws.read_json("model.json")?;
    let m = model_of(&mv)?;
    let base = crate::backtest::base_plan(&m, None);
    let now = crate::accuracy::model_breaking_point(&m, Some(&base), None, None, None);
    let mut out = JMap::new();
    let mut built = json!({ "rps": num(r1(now.rps)), "limitedBy": now.limited_by });
    if let Some(why) = &now.at_any_load {
        built["atAnyLoad"] = json!(why);
    }
    out.insert("asBuilt".into(), built);
    if let Some(p) = mv.get("traffic").and_then(|t| t.get("peak")) {
        out.insert("historyPeakRps".into(), p.clone());
    }
    out.insert("slo".into(), g(&mv, &["slo"]).clone());
    if let Some(st) = a.get("strategy").filter(|x| truthy(x)) {
        let spec = match st {
            Value::String(t) => crate::cli::util::parse_yaml(t)?,
            x => x.clone(),
        };
        let applied = crate::strategy::apply_strategy(&m, &base, &crate::strategy::parse_strategy(&spec)?)?;
        let after = breaking(&m, &applied.plan);
        out.insert("withStrategy".into(), json!({ "rps": num(r1(after.0)), "limitedBy": after.1 }));
    }
    Ok(Value::Object(out))
}

pub fn check_node_loss(ws: &Workspace, a: &Value) -> Result<Value, String> {
    let m = model_of(&ws.read_json("model.json")?)?;
    let d = dataset_of(&ws.read_json("dataset.json")?)?;
    let strategy = match a.get("strategy") {
        Some(Value::String(t)) => Some(crate::cli::util::parse_yaml(t)?),
        Some(Value::Null) | None => None,
        Some(x) => Some(x.clone()),
    };
    let load = a.get("traffic").filter(|x| !x.is_null()).map(|t| crate::backtest::LoadOpts { scale: t.get("scale").and_then(|x| x.as_f64()), peak_rps: t.get("peakRps").and_then(|x| x.as_f64()) });
    let o = crate::resilience::NodeLossOptions { strategy, load, recover_s: a.get("recoverS").and_then(|x| x.as_f64()), zones: a.get("zones").and_then(|x| x.as_bool()), ..Default::default() };
    Ok(to_json(&crate::resilience::node_loss(&m, &d, &o)?))
}

pub fn verify_design(a: &Value) -> Result<Value, String> {
    let input = match a.get("spec") {
        Some(Value::String(t)) => crate::cli::util::parse_yaml(t)?,
        Some(x) => x.clone(),
        None => Value::Null,
    };
    let v = crate::cli::sim::validate(&input);
    let errors = v.issues.iter().filter(|i| i.0 == "error").count();
    if !v.ok || errors > 0 {
        return Ok(json!({ "verdict": "fail", "problems": v.issues.iter().map(|i| format!("{}: {}", i.0, i.1)).collect::<Vec<_>>(), "findings": [], "next": "fix the spec and call verify_design again" }));
    }
    let arch = crate::sim::spec::parse_architecture(&input)?;
    let slo = a.get("slo").cloned().filter(|x| !x.is_null());
    let ao = crate::sim::audit::AuditOptions { rps: a.get("rps").and_then(|x| x.as_f64()), slo, incident_cost_per_minute: a.get("incidentCostPerMinute").and_then(|x| x.as_f64()), ..Default::default() };
    let r = to_json(&crate::sim::audit::audit(&arch, &ao, &mut |_, _, _| {})?);
    let mut problems: Vec<String> = v.issues.iter().map(|i| format!("{}: {}", i.0, i.1)).collect();
    let meets = g(&r, &["baseline", "meetsSlo"]).as_bool().unwrap_or(false);
    if !meets {
        problems.push(format!("at {} req/s it already misses the SLO: {}% errors, p99 {} ms", js_num(n(&r, &["load", "rps"])), js_to_fixed(n(&r, &["baseline", "errorRate"]) * 100.0, 2), js_num(js_round(n(&r, &["baseline", "p99Ms"])))));
    }
    let budget = a.get("budgetMonthly").and_then(|x| x.as_f64());
    let monthly = n(&r, &["baseline", "monthly"]);
    if let Some(b) = budget.filter(|b| monthly > *b) {
        problems.push(format!("costs ${}/month, over the ${} budget", js_locale(monthly), js_locale(b)));
    }
    if let Some(rps) = a.get("rps").and_then(|x| x.as_f64()).filter(|x| *x != 0.0) {
        if n(&r, &["headroom", "maxRps"]) < rps * 1.5 {
            problems.push(format!("headroom only {}× ({} req/s, then {})", js_to_fixed(n(&r, &["headroom", "ratio"]), 1), js_num(js_round(n(&r, &["headroom", "maxRps"]))), match g(&r, &["headroom", "limitedBy"]) { Value::Null => "nothing".to_string(), x => s(x, &[]) }));
        }
    }
    let findings = arr(&r, &["findings"]);
    let critical = findings.iter().filter(|f| s(f, &["severity"]) == "critical").count();
    let verdict = if !meets || critical > 0 || budget.map(|b| monthly > b).unwrap_or(false) { "fail" } else if findings.iter().any(|f| s(f, &["severity"]) == "major") || !problems.is_empty() { "pass with risks" } else { "pass" };
    let app = std::env::var("HINDCAST_APP_URL").or_else(|_| std::env::var("BOTTLENECK_APP_URL")).unwrap_or_else(|_| "http://localhost:5173".into());
    Ok(json!({
        "verdict": verdict,
        "architecture": g(&r, &["architecture"]),
        "load": g(&r, &["load"]),
        "slo": g(&r, &["slo"]),
        "monthly": g(&r, &["baseline", "monthly"]),
        "headroom": { "maxRps": num(js_round(n(&r, &["headroom", "maxRps"]))), "ratio": num(r1(n(&r, &["headroom", "ratio"]))), "limitedBy": g(&r, &["headroom", "limitedBy"]) },
        "resilience": { "score": g(&r, &["score"]), "survived": format!("{} of {} incidents within SLO", js_num(n(&r, &["survived"])), js_num(n(&r, &["total"]))) },
        "problems": problems,
        "findings": findings.iter().filter(|f| s(f, &["severity"]) != "ok").map(|f| json!({
            "severity": g(f, &["severity"]),
            "incident": g(f, &["title"]),
            "target": g(f, &["target"]),
            "explanation": g(f, &["explanation"]),
            "impact": { "errorRate": num(r2(n(f, &["impact", "errorRate"]))), "peakP99Ms": num(js_round(n(f, &["impact", "peakP99Ms"]))), "secondsOutOfSlo": g(f, &["impact", "breachS"]), "recoveryS": g(f, &["impact", "recoveryS"]), "blastRadius": g(f, &["blastRadius"]) },
            "fixes": arr(f, &["fixes"]).iter().map(|x| json!({ "title": g(x, &["title"]), "why": g(x, &["why"]), "monthlyDelta": g(x, &["monthlyDelta"]), "after": g(x, &["after", "severity"]), "changes": g(x, &["changes"]) })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "caveat": "A design without production history is checked against catalogue defaults: capacities and prices are typical values, not measured ones. Calibrate on telemetry (collect_telemetry → calibrate_model) for real numbers.",
        "link": format!("{}/#spec={}", app, crate::cli::design::encode_payload(v.spec.as_ref().unwrap_or(&Value::Null))),
        "next": if critical > 0 { "apply the fixes (each lists its spec changes) and call verify_design again" } else { "done, or open the link for a human to inspect" },
    }))
}
