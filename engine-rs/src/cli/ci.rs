//! `hindcast verify-change`: the agent tool verify_change on files named on the command line, for a CI
//! check (the GitHub Action in action.yml). Same strategies, verdicts and confidence as the tool; writes
//! the pull-request comment, the job's outputs, and exits 2 when the verdict is one the check fails on.

use super::reports::{self, arr, g, n, s};
use super::util::*;
use crate::cli::agent::verify::{verify_with, Verified};
use crate::cli::agent::workspace::Workspace;
use crate::math::js_num;
use serde_json::{json, Map as JMap, Value};
use std::path::Path;

pub const USAGE: &str = "hindcast verify-change --model model.json --dataset dataset.json (--base <dir> --head <dir> | --terraform-plan plan.json | <strategy.yaml …>)
    [--last 14d] [--draws 30] [--gate-minutes 0.5] [--p99 500] [--errors 0.01] [--scale 2 | --peak 400]
    [--comment comment.md] [--json result.json] [--md report.md] [--html report.html] [--outputs $GITHUB_OUTPUT]
    [--title \"Hindcast backtest\"] [--comment-key <key>] [--run-url <url>] [--fail-on fail|inconclusive|never]";

fn required(f: &Flags, k: &str) -> Result<String, String> {
    match f.opt.get(k) {
        Some(Some(v)) => Ok(v.clone()),
        _ => Err(format!("--{} <file> is required\n{}", k, USAGE)),
    }
}

fn value(f: &Flags, k: &str) -> Option<String> {
    f.opt.get(k).cloned().flatten().filter(|v| !v.is_empty())
}

fn number(f: &Flags, k: &str) -> Result<Option<f64>, String> {
    match value(f, k) {
        None => Ok(None),
        Some(v) => {
            let x = crate::import::js_number(&v);
            if x.is_finite() {
                Ok(Some(x))
            } else {
                Err(format!("--{}: not a number: {}", k, v))
            }
        }
    }
}

/// the worst confidence level over the results
fn confidence(out: &Value) -> String {
    let levels: Vec<String> = arr(out, &["results"]).iter().map(|x| s(x, &["confidence", "level"])).collect();
    for l in ["low", "medium", "high"] {
        if levels.iter().any(|x| x == l) {
            return l.into();
        }
    }
    String::new()
}

pub fn command(cmd: &str, f: &Flags, out: &mut Out) -> Result<Option<i32>, String> {
    if cmd != "verify-change" {
        return Ok(None);
    }
    if f.has("help") {
        out.log(USAGE);
        return Ok(Some(0));
    }
    let fail_on = value(f, "fail-on").unwrap_or_else(|| "fail".into());
    if !["fail", "inconclusive", "never"].contains(&fail_on.as_str()) {
        return Err(format!("--fail-on: one of fail, inconclusive, never (not \"{}\")", fail_on));
    }
    let model_path = required(f, "model")?;
    let mut mv = load(&model_path)?;
    let dv = load(&required(f, "dataset")?)?;
    // SLO overrides: the system's and every endpoint's
    let (p99, errors) = (number(f, "p99")?, number(f, "errors")?);
    if p99.is_some() || errors.is_some() {
        let set = |slo: &mut Value| {
            if !slo.is_object() {
                *slo = json!({});
            }
            if let Some(p) = p99 {
                slo["p99Ms"] = json!(p);
            }
            if let Some(e) = errors {
                slo["errorRate"] = json!(e);
            }
        };
        set(&mut mv["slo"]);
        if let Some(eps) = mv.get_mut("endpoints").and_then(|e| e.as_object_mut()) {
            for e in eps.values_mut() {
                set(&mut e["slo"]);
            }
        }
    }
    let model_dir = Path::new(&model_path).parent().map(|p| p.to_string_lossy().to_string()).filter(|p| !p.is_empty()).unwrap_or_else(|| ".".into());
    let cal = match value(f, "calibration") {
        Some(p) => Some(load(&p)?),
        None => {
            let sib = format!("{}/calibration.json", model_dir);
            if Path::new(&sib).exists() {
                Some(load(&sib)?)
            } else {
                None
            }
        }
    };
    let mut inputs: Vec<Value> = vec![];
    match (value(f, "base"), value(f, "head")) {
        (Some(b), Some(h)) => inputs.push(json!({ "kubernetes": { "base": b, "head": h } })),
        (None, None) => {}
        _ => return Err("--base and --head go together: the manifests before and after the change".into()),
    }
    if let Some(p) = value(f, "terraform-plan") {
        inputs.push(json!({ "terraformPlan": p }));
    }
    for p in &f.pos {
        inputs.push(json!({ "strategy": load(p)? }));
    }
    if inputs.is_empty() {
        return Err(format!("nothing to verify: give --base/--head manifests, --terraform-plan, or strategy files\n{}", USAGE));
    }
    let mut o = JMap::new();
    if let Some(l) = value(f, "last") {
        o.insert("last".into(), json!(l));
    }
    if let Some(d) = number(f, "draws")? {
        o.insert("draws".into(), json!(d));
    }
    if let Some(gm) = number(f, "gate-minutes")? {
        o.insert("gateMinutes".into(), json!(gm));
    }
    let (scale, peak) = (number(f, "scale")?, number(f, "peak")?);
    if scale.is_some() || peak.is_some() {
        let mut t = JMap::new();
        if let Some(x) = scale {
            t.insert("scale".into(), json!(x));
        }
        if let Some(x) = peak {
            t.insert("peakRps".into(), json!(x));
        }
        o.insert("traffic".into(), Value::Object(t));
    }
    let ws = Workspace::new(Some(&model_dir));
    let Verified { out: res, rv, mv, .. } = verify_with(&ws, mv, dv, cal, &inputs, &Value::Object(o))?;
    let title = value(f, "title");
    let run_url = value(f, "run-url");
    let verdict = s(&res, &["verdict"]);
    let level = confidence(&res);
    let mut written = vec![];
    if let Some(p) = value(f, "comment") {
        write(&p, &reports::verify_comment(&res, &rv, &reports::comment_marker(value(f, "comment-key").as_deref()), title.as_deref(), run_url.as_deref()))?;
        written.push(p);
    }
    if let Some(p) = value(f, "json") {
        write(&p, &pretty(&res))?;
        written.push(p);
    }
    if !rv.is_null() {
        if let Some(p) = value(f, "md") {
            write(&p, &reports::verify_markdown(&res, &rv, &mv, title.as_deref()))?;
            written.push(p);
        }
        if let Some(p) = value(f, "html") {
            write(&p, &reports::verify_html(&res, &rv, &mv))?;
            written.push(p);
        }
    }
    let failed = match fail_on.as_str() {
        "fail" => verdict == "fail",
        "inconclusive" => verdict == "fail" || verdict == "inconclusive",
        _ => false,
    };
    if let Some(p) = value(f, "outputs") {
        let first = arr(&res, &["results"]).first().cloned().cloned().unwrap_or(Value::Null);
        let mut lines = vec![format!("verdict={}", verdict), format!("confidence={}", level), format!("gate={}", if failed { "failed" } else { "passed" })];
        if !first.is_null() {
            lines.push(format!("monthly-delta={}", js_num(n(&first, &["cost", "monthlyDelta", "p50"]))));
            lines.push(format!("minutes-out-of-slo-delta={}", js_num(n(&first, &["reliability", "minutesOutOfSloDelta", "p50"]))));
            lines.push(format!("failed-requests-delta={}", js_num(n(&first, &["reliability", "failedRequestsDelta", "p50"]))));
        }
        lines.push(format!("marker={}", reports::comment_marker(value(f, "comment-key").as_deref())));
        use std::io::Write;
        let mut fh = std::fs::OpenOptions::new().create(true).append(true).open(&p).map_err(|e| format!("{}: {}", p, e))?;
        writeln!(fh, "{}", lines.join("\n")).map_err(|e| format!("{}: {}", p, e))?;
    }
    if f.has("print-json") {
        out.log(&pretty(&res));
    } else {
        let paint = |v: &str| match v {
            "pass" => green(v),
            "fail" => red(v),
            "inconclusive" => yellow(v),
            _ => dim(v),
        };
        out.log(&format!("{} {}{}", bold("verdict"), paint(&verdict), if level.is_empty() { String::new() } else { format!(" · confidence {}", level) }));
        for x in arr(&res, &["results"]) {
            out.log(&format!("  {} {}: {}", paint(&s(x, &["verdict"])), s(x, &["name"]), s(x, &["summary"])));
        }
        for note in arr(&res, &["notes"]) {
            out.log(&dim(&format!("  {}", s(note, &[]))));
        }
        if written.is_empty() {
            out.log(&dim("  why, how far to trust it and the worst moment: add --md report.md, --html report.html or --comment pr.md"));
        }
        for w in written {
            out.log(&dim(&format!("  written {}", w)));
        }
        if !g(&res, &["gate"]).is_null() {
            out.log(&dim(&format!("  {}; this check fails on: {}", s(&res, &["gate"]), fail_on)));
        }
    }
    Ok(Some(if failed { 2 } else { 0 }))
}
