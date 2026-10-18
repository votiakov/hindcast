//! check_drift: has the system changed since the model was calibrated? A recent window (collected
//! from the workspace's connection into drift/, or a dataset file) read against the calibration
//! (crate::drift). The answer is kept as drift.json, which model_status and verify_change read.

use super::workspace::{iso, now_s, Workspace};
use crate::cli::reports::{arr, g, n, s};
use crate::math::js_num;
use crate::review::json::{num, r1, r2, to_json};
use serde_json::{json, Map as JMap, Value};

/// a drift check this old is stale: the system can drift within days (reference/k8s, round 6)
pub const STALE_S: f64 = 86400.0;

fn window_of(d: &Value) -> (f64, f64) {
    let st = n(d, &["start"]);
    (st, st + n(d, &["n"]) * n(d, &["stepS"]))
}

/// the endpoint mix's distance between two windows: half the summed differences of each endpoint's
/// share of the requests (0 the same mix, 1 none in common)
fn mix_shift(a: &Value, b: &Value) -> Option<f64> {
    let shares = |d: &Value| -> Option<indexmap::IndexMap<String, f64>> {
        let eps = d.get("endpoints")?.as_object()?;
        let tot: Vec<(String, f64)> = eps.iter().map(|(k, e)| (k.clone(), arr(e, &["rps"]).iter().filter_map(|x| x.as_f64()).sum::<f64>())).collect();
        let all: f64 = tot.iter().map(|x| x.1).sum();
        if !(all > 0.0) {
            return None;
        }
        Some(tot.into_iter().map(|(k, v)| (k, v / all)).collect())
    };
    let (sa, sb) = (shares(a)?, shares(b)?);
    let mut keys: Vec<&String> = sa.keys().collect();
    keys.extend(sb.keys().filter(|k| !sa.contains_key(*k)));
    Some(keys.iter().map(|k| (sa.get(*k).copied().unwrap_or(0.0) - sb.get(*k).copied().unwrap_or(0.0)).abs()).sum::<f64>() / 2.0)
}

fn pct(x: f64) -> String {
    format!("{}%", js_num(crate::math::js_round(x * 100.0)))
}

/// every number to 3 decimals: the medians and changes keep more than they mean
fn rounded(v: &Value) -> Value {
    match v {
        Value::Number(x) if x.is_f64() => num(crate::math::js_round(x.as_f64().unwrap_or(f64::NAN) * 1000.0) / 1000.0),
        Value::Array(a) => Value::Array(a.iter().map(rounded).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), rounded(x))).collect()),
        x => x.clone(),
    }
}

pub fn check_drift(ws: &Workspace, o: &Value) -> Result<Value, String> {
    let mv = ws.read_json("model.json")?;
    let m: crate::model::Model = serde_json::from_value(mv.clone()).map_err(|e| format!("model: {}", e))?;
    let fitted = g(&mv, &["fittedOn"]).clone();
    let (fs, fe) = (n(&fitted, &["start"]), n(&fitted, &["end"]));
    let mut notes: Vec<String> = vec![];
    // the recent window: a file, or collected from the connection into its own directory
    let (rv, from) = match o.get("dataset").and_then(|x| x.as_str()) {
        Some(p) => (serde_json::from_str::<Value>(&std::fs::read_to_string(p).map_err(|e| format!("{}: {}", p, e))?).map_err(|e| format!("{}: {}", p, e))?, format!("the dataset {}", p)),
        None => {
            let src = ws.sources()?;
            if src.get("prometheus").is_none() && src.get("datadog").is_none() {
                return Err("no recent window: connect_telemetry so check_drift can collect one, or give dataset: <a dataset file of recent telemetry>".into());
            }
            let last = o.get("last").and_then(|x| x.as_str()).unwrap_or("6h").to_string();
            let sub = Workspace { dir: ws.dir.join("drift") };
            sub.save_sources(&src)?;
            super::collect::collect(&sub, &json!({ "last": last }))?;
            (sub.read_json("dataset.json")?, format!("the last {}, collected into drift/dataset.json", last))
        }
    };
    let recent: crate::dataset::Dataset = serde_json::from_value(rv.clone()).map_err(|e| format!("dataset: {}", e))?;
    let (rs, re) = window_of(&rv);
    // the data the model was fitted on, where the workspace still holds it
    let cv = if ws.has("dataset.json") { Some(ws.read_json("dataset.json")?) } else { None };
    let cv = cv.filter(|d| {
        let (a, b) = window_of(d);
        a < fe && b > fs
    });
    if cv.is_none() {
        notes.push("the data the model was fitted on is not in the workspace: the recent window is read against the model's CPU per request alone, so the comparison is not at matching load and there is no self time or memory to compare".into());
    }
    let cal: Option<crate::dataset::Dataset> = match &cv {
        Some(d) => Some(serde_json::from_value(d.clone()).map_err(|e| format!("dataset: {}", e))?),
        None => None,
    };
    if rs < fe {
        notes.push(format!("the recent window starts before the calibration's ends: {} h of it is history the model was fitted on, so it can't show what changed since", js_num(r1((fe.min(re) - rs) / 3600.0))));
    }
    if let Some(sh) = cv.as_ref().and_then(|c| mix_shift(c, &rv)).filter(|x| *x >= 0.1) {
        notes.push(format!("the endpoint mix differs between the windows by {} of the requests: a service's CPU per request is an average over what it serves, so part of a change can be the mix", pct(sh)));
    }
    let threshold = o.get("threshold").and_then(|x| x.as_f64());
    let report = crate::drift::drift(&m, cal.as_ref(), &recent, &crate::drift::DriftOptions { threshold, seed: None });
    let verdict = if !report.drifted.is_empty() {
        "drifted"
    } else if report.services.iter().any(|x| x.verdict == "matches") {
        "matches"
    } else if report.services.is_empty() {
        notes.push("no service in the model has a CPU per request to compare: that takes CPU metrics per service and CPU that follows load in the calibration".into());
        "nothing to compare"
    } else {
        "not enough recent load to tell"
    };
    let now = now_s();
    let mut out = JMap::new();
    out.insert("verdict".into(), json!(verdict));
    out.insert("checkedAt".into(), json!(iso(now)));
    out.insert("model".into(), json!({ "name": g(&mv, &["name"]), "fittedOn": { "start": iso(fs), "end": iso(fe) } }));
    out.insert("recent".into(), json!({ "start": iso(rs), "end": iso(re), "hours": num(r1((re - rs) / 3600.0)), "from": from }));
    out.insert("comparedWith".into(), json!(report.against));
    out.insert("threshold".into(), json!(format!("±{}: a change in CPU per request is drift past this, where it is worth {} millicores or more per replica and its 10–90% range leaves out no change. Back-to-back recordings of the same system differed by up to 23% (reference/k8s, the shop)", pct(report.threshold), js_num(crate::drift::MIN_MILLICORES))));
    let rv_report = to_json(&report);
    out.insert(
        "drifted".into(),
        Value::Array(report.services.iter().filter(|x| x.verdict == "drifted").map(|x| json!({ "service": x.service, "change": num(r2(x.change.unwrap_or(f64::NAN))), "said": x.said })).collect()),
    );
    out.insert("services".into(), rounded(g(&rv_report, &["services"])));
    if !report.skipped.is_empty() {
        out.insert("skipped".into(), json!(report.skipped));
    }
    out.insert("notes".into(), json!(notes));
    out.insert(
        "next".into(),
        json!(if verdict == "drifted" { "collect_telemetry, then calibrate_model: the model is fitted on a system that has since changed, and verify_change says so until it is recalibrated" } else { "verify_change" }),
    );
    let out = Value::Object(out);
    ws.write_json("drift.json", &out, true)?;
    Ok(out)
}

/// the workspace's last drift check, where it is of this model (a check of an earlier calibration says
/// nothing about this one): when it ran, how old it is, and what it found drifted
pub fn last_check(ws: &Workspace, mv: &Value) -> Option<Value> {
    if !ws.has("drift.json") {
        return None;
    }
    let d = ws.read_json("drift.json").ok()?;
    let fitted = g(mv, &["fittedOn"]);
    if s(&d, &["model", "fittedOn", "start"]) != iso(n(fitted, &["start"])) || s(&d, &["model", "fittedOn", "end"]) != iso(n(fitted, &["end"])) {
        return None;
    }
    let at = crate::accuracy::parse_iso_ms(&s(&d, &["checkedAt"])).map(|ms| ms as f64 / 1000.0)?;
    let age = now_s() - at;
    Some(json!({ "checkedAt": g(&d, &["checkedAt"]), "hoursAgo": num(r1(age / 3600.0)), "stale": age > STALE_S, "verdict": g(&d, &["verdict"]), "drifted": g(&d, &["drifted"]) }))
}

/// what model_status says of the last drift check, as a warning where there is one
pub fn status_warning(check: Option<&Value>, mv: &Value) -> Option<String> {
    let model_age = now_s() - n(mv, &["fittedOn", "end"]);
    match check {
        None if model_age > STALE_S => Some(format!("the model's history ends {} days ago and nothing has compared it with recent telemetry since: check_drift before trusting a verdict", js_num(r1(model_age / 86400.0)))),
        None => None,
        Some(c) if !arr(c, &["drifted"]).is_empty() => Some(format!(
            "the last drift check ({} h ago) found the system changed since calibration: {}. Recalibrate (collect_telemetry, calibrate_model) before trusting a verdict",
            js_num(n(c, &["hoursAgo"])),
            arr(c, &["drifted"]).iter().map(|x| format!("{} now costs {} CPU per request", s(x, &["service"]), crate::drift::change_words(n(x, &["change"])))).collect::<Vec<_>>().join(", ")
        )),
        Some(c) if c["stale"].as_bool() == Some(true) && model_age > STALE_S => Some(format!("the last drift check is {} days old: check_drift again before trusting a verdict", js_num(r1(n(c, &["hoursAgo"]) / 24.0)))),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// a dataset of one service, api, on 2 replicas: `n` minutes from `start`, load rising, CPU at
    /// `per_req` core-seconds per request over 20 millicores per replica
    fn dataset(start: f64, n: usize, per_req: f64) -> Value {
        let load: Vec<f64> = (0..n).map(|i| 40.0 + i as f64 * 1.5).collect();
        let wobble = |i: usize| 1.0 + 0.03 * ((i * 7 % 11) as f64 / 11.0 - 0.5);
        json!({ "version": 1, "name": "d", "start": start, "stepS": 60, "n": n, "endpoints": {}, "services": { "api": {
            "rps": load, "replicas": vec![2.0; n], "cpuCores": load.iter().enumerate().map(|(i, l)| 0.04 + l * per_req * wobble(i)).collect::<Vec<_>>(),
        } } })
    }

    fn model(start: f64, end: f64) -> Value {
        json!({ "version": 1, "name": "t", "timeoutMs": 5000, "slo": { "p99Ms": 500, "errorRate": 0.01 }, "endpoints": {}, "transfer": {}, "unattributedPerHour": 0, "accuracy": [],
            "fittedOn": { "start": start, "end": end, "stepS": 60, "buckets": (end - start) / 60.0 },
            "services": { "api": { "id": "api", "kind": "service", "replicas": 2, "cpuLimit": 1, "cpu": { "base": 0.02, "perReq": 0.002, "r2": 0.9 }, "capacity": { "limit": "cpu", "servers": 1, "perReplicaRps": 400 }, "self": { "mean": 2, "p99": 5 }, "tail": 2, "cost": { "perReplicaHour": 0, "perRequest": 0, "cpuShare": 0.8, "arch": "x86", "source": "none" }, "fit": { "status": "good", "notes": [] } } } })
    }

    #[test]
    fn a_check_is_kept_read_back_for_its_model_and_forgotten_once_recalibrated() {
        let dir = std::env::temp_dir().join(format!("hindcast-drift-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let ws = Workspace { dir: dir.clone() };
        let t0 = 1_790_000_000.0;
        let mv = model(t0, t0 + 3600.0);
        ws.write_json("model.json", &mv, false).unwrap();
        ws.write_json("dataset.json", &dataset(t0, 60, 0.002), false).unwrap();
        let recent = dir.join("recent.json");
        std::fs::write(&recent, crate::convert::js_stringify(&dataset(t0 + 86400.0 * 4.0, 60, 0.0013))).unwrap();
        // no recent window: nothing connected, no file
        assert!(check_drift(&ws, &json!({})).unwrap_err().starts_with("no recent window: connect_telemetry"));
        let out = check_drift(&ws, &json!({ "dataset": recent.to_string_lossy() })).unwrap();
        assert_eq!(out["verdict"], "drifted", "{}", crate::cli::util::pretty(&out));
        assert_eq!(out["drifted"][0]["service"], "api");
        assert_eq!(out["drifted"][0]["change"], json!(-0.35));
        assert!(ws.has("drift.json"));
        let c = last_check(&ws, &mv).unwrap();
        assert_eq!(c["drifted"][0]["service"], "api");
        assert_eq!(status_warning(Some(&c), &mv).unwrap(), "the last drift check (0 h ago) found the system changed since calibration: api now costs 35% less CPU per request. Recalibrate (collect_telemetry, calibrate_model) before trusting a verdict");
        // a model fitted since: the check was of another one
        assert!(last_check(&ws, &model(t0, t0 + 7200.0)).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
