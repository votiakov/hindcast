//! The capacity review a platform team does by hand (agent/review.ts): headroom, busier days, losing
//! a node, the limits that bind, the fixes and savings that pass; one Markdown report and the data.

use super::workspace::{iso, iso_full, now_s, Workspace};
use crate::cli::reports::{arr, g, inf, n, s};
use crate::math::{js_locale, js_num, js_round, js_to_fixed};
use serde_json::{json, Map as JMap, Value};

fn r1(x: f64) -> f64 {
    js_round(x * 10.0) / 10.0
}
fn num(x: f64) -> Value {
    serde_json::Number::from_f64(x).map(Value::Number).unwrap_or(Value::Null)
}
fn to_json<T: serde::Serialize>(x: &T) -> Value {
    serde_json::to_value(x).unwrap_or(Value::Null)
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

pub fn review_capacity(ws: &Workspace, o: &Value) -> Result<Value, String> {
    let mv = ws.read_json("model.json")?;
    let m: crate::model::Model = serde_json::from_value(mv.clone()).map_err(|e| format!("model: {}", e))?;
    let dv = ws.read_json("dataset.json")?;
    let d: crate::dataset::Dataset = serde_json::from_value(dv.clone()).map_err(|e| format!("dataset: {}", e))?;
    let draws = o.get("draws").and_then(|x| x.as_f64()).unwrap_or(12.0);
    let head = crate::accuracy::model_breaking_point(&m, Some(&crate::backtest::base_plan(&m, None)), None, None, None);
    let peak = g(&mv, &["traffic", "peak"]).as_f64().unwrap_or(0.0);
    let busier: Vec<Value> = [1.5, 2.0]
        .iter()
        .map(|scale| -> Result<Value, String> {
            let r = to_json(&crate::backtest::backtest(&m, &d, &[], &crate::backtest::BacktestOptions { draws: Some(draws), load: Some(crate::backtest::LoadOpts { scale: Some(*scale), peak_rps: None }), ..Default::default() })?);
            let b = g(&r, &["baseline"]);
            let mo = n(b, &["summary", "minutesOutOfSlo", "p50"]);
            Ok(json!({ "scale": num(*scale), "minutesOutOfSlo": num(r1(mo)), "failedRequests": num(js_round(n(b, &["summary", "failedRequests", "p50"]))), "worst": g(b, &["worst", "why"]), "holds": mo <= 0.5 }))
        })
        .collect::<Result<_, _>>()?;
    let has_pods = g(&mv, &["services"]).as_object().map(|x| x.values().any(|s| truthy(g(s, &["pods"])))).unwrap_or(false);
    let nodes = if has_pods { Some(to_json(&crate::resilience::node_loss(&m, &d, &crate::resilience::NodeLossOptions { draws: Some(draws.min(8.0)), ..Default::default() })?)) } else { None };
    let svcs: Vec<Value> = g(&mv, &["services"]).as_object().map(|x| x.values().cloned().collect()).unwrap_or_default();
    let throttled: Vec<Value> = svcs.iter().filter(|s| truthy(g(s, &["capacity", "throttle"]))).map(|x| json!({ "service": g(x, &["id"]), "kneeShareOfLimit": num(js_round(n(x, &["capacity", "throttle", "knee"]) * 100.0) / 100.0), "cpuLimit": g(x, &["cpuLimit"]), "perReplicaRps": num(r1(inf(x, &["capacity", "perReplicaRps"]))) })).collect();
    let memory: Vec<Value> = svcs
        .iter()
        .filter(|x| truthy(g(x, &["memory", "limit"])) && n(x, &["memory", "peak"]) / n(x, &["memory", "limit"]) >= 0.75)
        .map(|x| json!({ "service": g(x, &["id"]), "peakMiB": num(js_round(n(x, &["memory", "peak"]) * 1024.0)), "limitMiB": num(js_round(n(x, &["memory", "limit"]) * 1024.0)), "share": num(js_round((n(x, &["memory", "peak"]) / n(x, &["memory", "limit"])) * 100.0) / 100.0) }))
        .collect();
    let sug = super::suggest::suggest_changes(ws, &json!({ "draws": draws }))?;
    let c = g(&mv, &["cluster"]);
    let mut pool = Value::Null;
    if !c.is_null() {
        let ab = to_json(&crate::backtest::backtest(&m, &d, &[], &crate::backtest::BacktestOptions { draws: Some(1.0), ..Default::default() })?.baseline);
        let cl = g(&ab, &["cluster"]);
        if !cl.is_null() {
            let (ncpu, nmem) = (n(c, &["node", "cpu"]), n(c, &["node", "memoryGb"]));
            let pn = n(cl, &["peakNodes"]);
            let fill = (n(cl, &["peakRequestedCpu"]) / (pn * ncpu)).max(n(cl, &["peakRequestedMemoryGb"]) / (pn * nmem));
            let need = ((n(cl, &["peakRequestedCpu"]) / ncpu).max(n(cl, &["peakRequestedMemoryGb"]) / nmem) - 1e-9).ceil().max(1.0) + 1.0;
            pool = json!({ "nodes": num(pn), "autoscaled": g(c, &["autoscaled"]), "node": { "cpu": num(ncpu), "memoryGb": num(js_round(nmem * 10.0) / 10.0), "perHour": g(c, &["node", "perHour"]) }, "peakFill": num(js_round(fill * 100.0) / 100.0), "wouldFit": num(need), "monthlyPerNode": num(js_round(n(c, &["node", "perHour"]) * 730.0)) });
        }
    }
    let mut out = JMap::new();
    out.insert("system".into(), g(&mv, &["name"]).clone());
    out.insert("history".into(), json!({ "from": iso(n(&dv, &["start"])), "to": iso(n(&dv, &["start"]) + n(&dv, &["n"]) * n(&dv, &["stepS"])), "peakRps": num(r1(peak)) }));
    out.insert("slo".into(), g(&mv, &["slo"]).clone());
    out.insert("headroom".into(), json!({ "rps": num(r1(head.rps)), "limitedBy": head.limited_by, "overPeak": if peak > 0.0 { num(js_round((head.rps / peak) * 100.0) / 100.0) } else { Value::Null } }));
    out.insert("busier".into(), json!(busier));
    out.insert(
        "nodeLoss".into(),
        match &nodes {
            Some(nl) => {
                let r0 = arr(nl, &["results"]).first().cloned().cloned();
                json!({
                    "survives": g(nl, &["survives"]),
                    "worst": r0.map(|r| json!({ "node": g(&r, &["node"]), "minutesOutOfSlo": g(&r, &["minutesOutOfSlo"]), "failedRequests": g(&r, &["failedRequests"]), "down": arr(&r, &["lost"]).iter().filter(|l| g(l, &["down"]).as_bool().unwrap_or(false)).map(|l| g(l, &["service"]).clone()).collect::<Vec<_>>() })).unwrap_or(Value::Null),
                    "singlePointsOfFailure": arr(nl, &["singlePointsOfFailure"]).iter().map(|x| g(x, &["service"]).clone()).collect::<Vec<_>>(),
                    "fix": match g(&sug, &["nodeLoss", "fix"]) { Value::Null => Value::Null, x => x.clone() },
                })
            }
            None => Value::Null,
        },
    );
    out.insert("throttled".into(), json!(throttled));
    out.insert("memoryNearLimit".into(), json!(memory));
    out.insert("fixes".into(), json!(arr(&sug, &["fixes"]).iter().take(5).map(|f| json!({ "name": g(f, &["name"]), "minutesOutOfSloDelta": g(f, &["minutesOutOfSloDelta"]), "monthlyDelta": g(f, &["monthlyDelta"]) })).collect::<Vec<_>>()));
    out.insert("savings".into(), json!(arr(&sug, &["savings"]).iter().take(8).map(|x| json!({ "name": g(x, &["name"]), "monthlyDelta": g(x, &["monthlyDelta"]), "verdict": g(x, &["verdict"]) })).collect::<Vec<_>>()));
    out.insert("nodePool".into(), pool);
    let cs = g(&sug, &["combinedSavings"]);
    out.insert("combinedSavings".into(), if cs.is_null() { Value::Null } else { json!({ "name": g(cs, &["name"]), "monthlyDelta": g(cs, &["monthlyDelta"]), "verdict": g(cs, &["verdict"]) }) });
    let out_v = Value::Object(out.clone());
    let md = review_markdown(&out_v);
    ws.ensure("reports");
    let file = format!("{}/capacity-review-{}.md", ws.path("reports"), &iso_full(now_s())[..10]);
    std::fs::write(&file, &md).map_err(|e| e.to_string())?;
    out.insert("report".into(), json!(file));
    out.insert("markdown".into(), json!(md));
    Ok(Value::Object(out))
}

pub fn review_markdown(r: &Value) -> String {
    let usd = |x: f64| format!("{}${}/month", if x < 0.0 { "−" } else { "+" }, js_locale(js_round(x).abs()));
    let mut l: Vec<String> = vec![
        format!("# Capacity review — {}", s(r, &["system"])),
        String::new(),
        format!("History {} … {}, busiest moment {} req/s. SLO: p99 ≤ {} ms, errors ≤ {}%.", s(r, &["history", "from"]), s(r, &["history", "to"]), js_num(n(r, &["history", "peakRps"])), js_num(n(r, &["slo", "p99Ms"])), js_to_fixed(n(r, &["slo", "errorRate"]) * 100.0, 1)),
        String::new(),
    ];
    l.push("## Headroom".into());
    l.push(String::new());
    let over = g(r, &["headroom", "overPeak"]);
    l.push(format!("Within SLO up to **{} req/s**{}; {} saturates first.", js_num(n(r, &["headroom", "rps"])), if truthy(over) { format!(" — {}× the busiest moment", js_num(n(r, &["headroom", "overPeak"]))) } else { String::new() }, match g(r, &["headroom", "limitedBy"]) { Value::Null => "nothing".to_string(), x => s(x, &[]) }));
    l.push(String::new());
    for b in arr(r, &["busier"]) {
        l.push(format!("- **{}× today's traffic:** {}", js_num(n(b, &["scale"])), if g(b, &["holds"]).as_bool().unwrap_or(false) { "holds".to_string() } else { format!("{} min out of SLO, {} failed requests — {}", js_num(n(b, &["minutesOutOfSlo"])), js_locale(n(b, &["failedRequests"])), s(b, &["worst"])) }));
    }
    l.push(String::new());
    let nl = g(r, &["nodeLoss"]);
    if !nl.is_null() {
        l.push("## Losing a node at the busiest moment".into());
        l.push(String::new());
        let w = g(nl, &["worst"]);
        if g(nl, &["survives"]).as_bool().unwrap_or(false) {
            l.push("Survives the loss of any one node.".into());
        } else if !w.is_null() {
            let down: Vec<String> = arr(w, &["down"]).iter().map(|x| s(x, &[])).collect();
            l.push(format!("Losing **{}** costs {} min out of SLO and {} failed requests{}.", s(w, &["node"]), js_num(n(w, &["minutesOutOfSlo"])), js_locale(n(w, &["failedRequests"])), if down.is_empty() { String::new() } else { format!(": {} {} no replica left", down.join(", "), if down.len() == 1 { "has" } else { "have" }) }));
        }
        let spof: Vec<String> = arr(nl, &["singlePointsOfFailure"]).iter().map(|x| s(x, &[])).collect();
        if !spof.is_empty() {
            l.push(String::new());
            l.push(format!("Single points of failure (every replica on one node): {}.", spof.join(", ")));
        }
        let fx = g(nl, &["fix"]);
        if !fx.is_null() {
            l.push(String::new());
            let items: Vec<String> = arr(fx, &["change", "changes"]).iter().map(|c| format!("{}{}", s(c, &["service"]), if truthy(g(c, &["replicas"])) { format!(" → {}", js_num(n(c, &["replicas"]))) } else { String::new() })).collect();
            l.push(format!("Fix, backtested: {}, spread over the nodes — {}, {}.", items.join(", "), if g(fx, &["survives"]).as_bool().unwrap_or(false) { "survives every node" } else { "still fails a node" }, usd(n(fx, &["monthlyDelta"]))));
        }
        l.push(String::new());
    }
    let th = arr(r, &["throttled"]);
    let mem = arr(r, &["memoryNearLimit"]);
    if !th.is_empty() || !mem.is_empty() {
        l.push("## Limits that bind".into());
        l.push(String::new());
        for t in th {
            l.push(format!("- **{}** is held back by its CPU quota: throttling takes over at {}% of its {}-core limit ({} req/s per replica)", s(t, &["service"]), js_num(js_round(n(t, &["kneeShareOfLimit"]) * 100.0)), crate::cli::agent::sources_str(t.get("cpuLimit")), js_num(n(t, &["perReplicaRps"]))));
        }
        for x in mem {
            l.push(format!("- **{}** peaked at {} MiB of its {} MiB memory limit ({}%)", s(x, &["service"]), js_num(n(x, &["peakMiB"])), js_num(n(x, &["limitMiB"])), js_num(js_round(n(x, &["share"]) * 100.0))));
        }
        l.push(String::new());
    }
    let fixes = arr(r, &["fixes"]);
    if !fixes.is_empty() {
        l.push("## Fixes that pass".into());
        l.push(String::new());
        for f in fixes {
            l.push(format!("- {}: {} min out of SLO, {}", s(f, &["name"]), js_num(n(f, &["minutesOutOfSloDelta"])), usd(n(f, &["monthlyDelta"]))));
        }
        l.push(String::new());
    }
    let p = g(r, &["nodePool"]);
    if !p.is_null() {
        let nodes = n(p, &["nodes"]);
        let auto = g(p, &["autoscaled"]).as_bool().unwrap_or(false);
        l.push("## Node pool".into());
        l.push(String::new());
        l.push(format!("{} node{} of {} cores and {} GiB, {}. At the busiest moment every pod's requests fill **{}%** of it.", js_num(nodes), if nodes == 1.0 { "" } else { "s" }, js_num(n(p, &["node", "cpu"])), js_num(n(p, &["node", "memoryGb"])), if auto { "autoscaled" } else { "a fixed pool" }, js_num(js_round(n(p, &["peakFill"]) * 100.0))));
        if !auto && n(p, &["wouldFit"]) < nodes {
            l.push(String::new());
            l.push(format!("Request cuts save nothing on a fixed pool. {} nodes would hold the busiest moment's requests with one node to spare, about ${}/month less — check it with node loss before shrinking.", js_num(n(p, &["wouldFit"])), js_locale((nodes - n(p, &["wouldFit"])) * n(p, &["monthlyPerNode"]))));
        }
        l.push(String::new());
    }
    let sav = arr(r, &["savings"]);
    if !sav.is_empty() {
        l.push("## Savings that pass".into());
        l.push(String::new());
        for x in sav {
            l.push(format!("- {}: {}", s(x, &["name"]), usd(n(x, &["monthlyDelta"]))));
        }
        let cs = g(r, &["combinedSavings"]);
        if !cs.is_null() {
            l.push(format!("- **All of them together:** {}, {}", usd(n(cs, &["monthlyDelta"])), s(cs, &["verdict"])));
        }
        l.push(String::new());
    }
    l.push("Every number is a replay of the recorded history through the calibrated model; `verify_change` the one you ship for its full evidence.".into());
    l.join("\n") + "\n"
}
