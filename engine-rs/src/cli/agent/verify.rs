//! The verdicts an agent acts on (agent/verify.ts): calibrate_model with its trust report, model_status,
//! verify_change (strategies, manifest diffs, Terraform plans, edited manifests against the live
//! snapshot), and verify_design. Every answer says how far to trust it.

use super::workspace::{iso, iso_full, now_s, seconds, Workspace};
use crate::cli::reports::{arr, g, inf, n, s};
use crate::math::{js_locale, js_num, js_round, js_to_fixed};
use serde_json::{json, Map as JMap, Value};
use std::path::Path;

use crate::review::json::{num, r1, r2, to_json, truthy};
use crate::review::judge::LIMIT_SEEN;

fn pct(x: f64) -> String {
    format!("{}%", js_num(js_round(x * 100.0)))
}

fn model_of(v: &Value) -> Result<crate::model::Model, String> {
    serde_json::from_value(v.clone()).map_err(|e| format!("model: {}", e))
}
fn dataset_of(v: &Value) -> Result<crate::dataset::Dataset, String> {
    serde_json::from_value(v.clone()).map_err(|e| format!("dataset: {}", e))
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
    // no latency metric: nothing to fit latency on, so the fit can't be scored — capacity rests on CPU
    let blind: Vec<String> = arr(m, &["provenance", "latency", "without"]).iter().map(|x| s(x, &[])).collect();
    // marked by calibration (capacity.cpuAlone); models from before the mark: no latency metric and an unexplained fit
    let cpu_alone = |id: &str| g(m, &["services", id, "capacity", "cpuAlone"]).as_bool() == Some(true);
    let cpu_only: Vec<String> = svcs.iter().filter(|x| cpu_alone(&s(x, &["service"])) || (blind.contains(&s(x, &["service"])) && s(x, &["fit"]) == "unexplained")).map(|x| s(x, &["service"])).collect();
    let untrusted: Vec<String> = svcs.iter().filter(|x| matches!(s(x, &["fit"]).as_str(), "poor" | "unexplained") && !cpu_only.contains(&s(x, &["service"]))).map(|x| format!("{}: fit {} — {}", s(x, &["service"]), s(x, &["fit"]), why_untrusted(arr(x, &["notes"])))).collect();
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
    if !cpu_only.is_empty() {
        t["cpuOnly"] = json!(cpu_only);
    }
    if let Some(said) = g(m, &["provenance", "said"]).as_str() {
        t["withoutTraces"] = json!(said);
    }
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
    // where the topology and latency came from, for every answer read off this model
    if let Some(p) = dv.get("provenance").filter(|p| !p.is_null()) {
        mv["provenance"] = p.clone();
    }
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
            } else if ws.sources().map(|s| s.get("datadog").is_some()).unwrap_or(false) {
                "accuracy not measured: the data has no p99 latency per endpoint. Datadog's latency distribution (trace.<span>, with percentiles) gives it; the legacy trace.<span>.duration gives only a mean".to_string()
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
    if src.get("prometheus").is_some() || src.get("datadog").is_some() {
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

pub use crate::review::judge::{draws_for, judge, slice_last};
use crate::review::judge::breaking;

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
    let mv = ws.read_json("model.json")?;
    let m = model_of(&mv)?;
    let d = dataset_of(&ws.read_json("dataset.json")?)?;
    let strategy = match a.get("strategy") {
        Some(Value::String(t)) => Some(crate::cli::util::parse_yaml(t)?),
        Some(Value::Null) | None => None,
        Some(x) => Some(x.clone()),
    };
    let load = a.get("traffic").filter(|x| !x.is_null()).map(|t| crate::backtest::LoadOpts { scale: t.get("scale").and_then(|x| x.as_f64()), peak_rps: t.get("peakRps").and_then(|x| x.as_f64()) });
    let o = crate::resilience::NodeLossOptions { strategy, load, recover_s: a.get("recoverS").and_then(|x| x.as_f64()), zones: a.get("zones").and_then(|x| x.as_bool()), grpc_calls: grpc_calls(&mv), ..Default::default() };
    Ok(to_json(&crate::resilience::node_loss(&m, &d, &o)?))
}

/// the calls collection found made over gRPC (model provenance.grpc.calls), as (caller, callee)
pub use crate::review::judge::grpc_calls;

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

#[cfg(test)]
mod tests {
    use super::*;

    /// judge a change to api, a service with no latency metric, run at `after` of its capacity where
    /// the history peaked at 50%
    fn judged(cpu_alone: bool, after: f64) -> Value {
        let mv = json!({
            "services": { "api": { "capacity": { "limit": "cpu", "servers": 32, "perReplicaRps": 100, "cpuAlone": cpu_alone }, "fit": { "status": "unexplained", "notes": [] }, "cost": { "source": "nodes" } } },
            "accuracy": [{ "method": "holdout", "checks": [] }],
            "traffic": { "peak": 50 },
        });
        let m: crate::model::Model = serde_json::from_str(include_str!("../../../../reference/shop/model.json")).unwrap();
        let r = json!({ "window": { "start": 0, "end": 7 * 86400 }, "baseline": { "peakUtil": { "api": 0.5 }, "summary": {} } });
        let st = json!({ "peakUtil": { "api": after }, "delta": { "minutesOutOfSlo": { "p50": 0, "lo": 0, "hi": 0 }, "monthly": { "p50": -12 } } });
        let spec = json!({ "name": "api cpu", "changes": [{ "service": "api", "cpu": 0.5 }] });
        judge(&mv, &m, &r, &st, &spec, None, 1.0, (100.0, None), (100.0, None), None).unwrap()
    }

    fn reasons(v: &Value) -> String {
        arr(v, &["reasons"]).iter().map(|x| s(x, &[])).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn cpu_alone_is_medium_at_most_and_low_past_the_peak() {
        // within the history's peak: medium, and the reasons say why
        let v = judged(true, 0.52);
        assert_eq!(s(&v, &["confidence", "level"]), "medium");
        assert_eq!(s(&v, &["verdict"]), "pass");
        assert!(reasons(&v).contains("confidence medium at most: api has no latency metric"), "{}", reasons(&v));
        assert_eq!(g(arr(&v, &["confidence", "services"])[0], &["cpuOnly"]), &json!(true));
        // past it: low, and the verdict can't pass
        let v = judged(true, 0.8);
        assert_eq!(s(&v, &["confidence", "level"]), "low");
        assert_eq!(s(&v, &["verdict"]), "inconclusive");
        assert!(reasons(&v).contains("past the history's peak of 50%"), "{}", reasons(&v));
        // an unexplained fit that is not CPU-only stays low however gently it is changed
        assert_eq!(s(&judged(false, 0.52), &["confidence", "level"]), "low");
    }
}
