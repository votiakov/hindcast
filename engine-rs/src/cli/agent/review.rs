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
    super::progress("headroom", 0.0, 5.0);
    let head = crate::accuracy::model_breaking_point(&m, Some(&crate::backtest::base_plan(&m, None)), None, None, None);
    let peak = g(&mv, &["traffic", "peak"]).as_f64().unwrap_or(0.0);
    super::progress("busier days", 1.0, 5.0);
    // the recorded day itself, replayed: whether it already broke the SLO, and what it costs a month
    let base = to_json(&crate::backtest::backtest(&m, &d, &[], &crate::backtest::BacktestOptions { draws: Some(draws), ..Default::default() })?.baseline);
    let today = {
        let mo = n(&base, &["summary", "minutesOutOfSlo", "p50"]);
        json!({ "minutesOutOfSlo": num(r1(mo)), "failedRequests": num(js_round(n(&base, &["summary", "failedRequests", "p50"]))), "worst": g(&base, &["worst", "why"]), "holds": mo <= 0.5, "monthly": num(js_round(n(&base, &["summary", "monthly", "p50"]))) })
    };
    let busier: Vec<Value> = [1.5, 2.0]
        .iter()
        .map(|scale| -> Result<Value, String> {
            let r = to_json(&crate::backtest::backtest(&m, &d, &[], &crate::backtest::BacktestOptions { draws: Some(draws), load: Some(crate::backtest::LoadOpts { scale: Some(*scale), peak_rps: None }), ..Default::default() })?);
            let b = g(&r, &["baseline"]);
            let mo = n(b, &["summary", "minutesOutOfSlo", "p50"]);
            Ok(json!({ "scale": num(*scale), "minutesOutOfSlo": num(r1(mo)), "failedRequests": num(js_round(n(b, &["summary", "failedRequests", "p50"]))), "worst": g(b, &["worst", "why"]), "holds": mo <= 0.5 }))
        })
        .collect::<Result<_, _>>()?;
    super::progress("losing a node", 2.0, 5.0);
    let has_pods = g(&mv, &["services"]).as_object().map(|x| x.values().any(|s| truthy(g(s, &["pods"])))).unwrap_or(false);
    let nodes = if has_pods { Some(to_json(&crate::resilience::node_loss(&m, &d, &crate::resilience::NodeLossOptions { draws: Some(draws.min(8.0)), ..Default::default() })?)) } else { None };
    let svcs: Vec<Value> = g(&mv, &["services"]).as_object().map(|x| x.values().cloned().collect()).unwrap_or_default();
    let throttled: Vec<Value> = svcs.iter().filter(|s| truthy(g(s, &["capacity", "throttle"]))).map(|x| json!({ "service": g(x, &["id"]), "kneeShareOfLimit": num(js_round(n(x, &["capacity", "throttle", "knee"]) * 100.0) / 100.0), "cpuLimit": g(x, &["cpuLimit"]), "perReplicaRps": num(r1(inf(x, &["capacity", "perReplicaRps"]))) })).collect();
    let memory: Vec<Value> = svcs
        .iter()
        .filter(|x| truthy(g(x, &["memory", "limit"])) && (n(x, &["memory", "peak"]) / n(x, &["memory", "limit"]) >= 0.75 || g(x, &["memory", "leak"]).as_f64().unwrap_or(0.0) > 0.0))
        .map(|x| {
            let mut o = json!({ "service": g(x, &["id"]), "peakMiB": num(js_round(n(x, &["memory", "peak"]) * 1024.0)), "limitMiB": num(js_round(n(x, &["memory", "limit"]) * 1024.0)), "share": num(js_round((n(x, &["memory", "peak"]) / n(x, &["memory", "limit"])) * 100.0) / 100.0) });
            // a leak: after how many requests per container it reaches its limit
            let leak = g(x, &["memory", "leak"]).as_f64().unwrap_or(0.0);
            if leak > 0.0 {
                o["leakMiBPer1000"] = num(js_round(leak * 1024.0 * 1000.0 * 10.0) / 10.0);
                o["requestsToLimit"] = num(js_round(((n(x, &["memory", "limit"]) - n(x, &["memory", "base"]) - n(x, &["memory", "spike"])) / leak).max(0.0)));
            }
            o
        })
        .collect();
    super::progress("fixes and savings", 3.0, 5.0);
    // suggest_changes reports no phases of its own here
    let sug = super::with_progress(None, || super::suggest::suggest_changes(ws, &json!({ "draws": draws })))?;
    let c = g(&mv, &["cluster"]);
    let mut pool = Value::Null;
    if !c.is_null() {
        let cl = g(&base, &["cluster"]);
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
    // a headroom set by a service the model doesn't explain is a guess: say so where it is read
    let limit_fit = head.limited_by.as_ref().map(|id| s(&mv, &["services", id, "fit", "status"])).unwrap_or_default();
    let mut headroom = json!({ "rps": num(r1(head.rps)), "limitedBy": head.limited_by, "overPeak": if peak > 0.0 { num(js_round((head.rps / peak) * 100.0) / 100.0) } else { Value::Null }, "limitTrusted": !matches!(limit_fit.as_str(), "poor" | "unexplained") });
    if let Some(why) = &head.at_any_load {
        headroom["atAnyLoad"] = json!(why);
    }
    out.insert("headroom".into(), headroom);
    out.insert("today".into(), today);
    out.insert("trust".into(), trust(&mv));
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
    out.insert("fixes".into(), json!(arr(&sug, &["fixes"]).iter().take(5).map(|f| json!({ "name": g(f, &["name"]), "minutesOutOfSloDelta": g(f, &["minutesOutOfSloDelta"]), "failedRequestsDelta": g(f, &["failedRequestsDelta"]), "monthlyDelta": g(f, &["monthlyDelta"]) })).collect::<Vec<_>>()));
    out.insert("savings".into(), json!(arr(&sug, &["savings"]).iter().take(8).map(|x| json!({ "name": g(x, &["name"]), "monthlyDelta": g(x, &["monthlyDelta"]), "verdict": g(x, &["verdict"]) })).collect::<Vec<_>>()));
    out.insert("nodePool".into(), pool);
    out.insert("commitment".into(), commitment(&mv, &dv));
    let cs = g(&sug, &["combinedSavings"]);
    out.insert("combinedSavings".into(), if cs.is_null() { Value::Null } else { json!({ "name": g(cs, &["name"]), "monthlyDelta": g(cs, &["monthlyDelta"]), "verdict": g(cs, &["verdict"]) }) });
    super::progress("writing the report", 4.0, 5.0);
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
        format!("History {} – {} UTC, busiest moment {} req/s. SLO: p99 ≤ {} ms, errors ≤ {}%.", when(&s(r, &["history", "from"])), when(&s(r, &["history", "to"])), js_num(n(r, &["history", "peakRps"])), js_num(n(r, &["slo", "p99Ms"])), js_to_fixed(n(r, &["slo", "errorRate"]) * 100.0, 1)),
        String::new(),
    ];
    if !g(r, &["today"]).is_null() {
        l.push("## Summary".into());
        l.push(String::new());
        l.extend(summary_lines(r));
        l.push(String::new());
    }
    l.push("## Headroom".into());
    l.push(String::new());
    let over = g(r, &["headroom", "overPeak"]);
    match g(r, &["headroom", "atAnyLoad"]).as_str() {
        Some(why) => l.push(format!("**Out of SLO at any load** — {}. That is no capacity limit: the model misses the SLO with almost no traffic, so fix or explain that first.", why)),
        None => l.push(format!("Within SLO up to **{} req/s**{}; {}.", js_num(n(r, &["headroom", "rps"])), if truthy(over) { format!(" — {}× the busiest moment", js_num(n(r, &["headroom", "overPeak"]))) } else { String::new() }, match g(r, &["headroom", "limitedBy"]) { Value::Null => "nothing saturates in the range searched".to_string(), x => format!("{} saturates first", s(x, &[])) })),
    }
    l.push(String::new());
    let t = g(r, &["today"]);
    if !t.is_null() {
        l.push(format!("- **The recorded day, replayed:** {}", if g(t, &["holds"]).as_bool().unwrap_or(false) { "holds".to_string() } else { format!("{} min out of SLO, {} failed requests — {}", js_num(n(t, &["minutesOutOfSlo"])), js_locale(n(t, &["failedRequests"])), s(t, &["worst"])) }));
    }
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
            l.push(if !w.is_null() && n(w, &["failedRequests"]) > 0.0 {
                format!("Stays within SLO when any one node is lost. The worst, **{}**, still fails {} requests while its pods come back elsewhere.", s(w, &["node"]), js_locale(n(w, &["failedRequests"])))
            } else {
                "Stays within SLO when any one node is lost.".into()
            });
        } else if !w.is_null() {
            let down: Vec<String> = arr(w, &["down"]).iter().map(|x| s(x, &[])).collect();
            l.push(format!("Losing **{}** fails {} more requests{}{}.", s(w, &["node"]), js_locale(n(w, &["failedRequests"])), minutes_added(n(w, &["minutesOutOfSlo"])), if down.is_empty() { String::new() } else { format!(": {} {} no replica left", down.join(", "), if down.len() == 1 { "has" } else { "have" }) }));
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
            if x.get("leakMiBPer1000").is_some() {
                l.push(format!(
                    "- **{}** leaks: its memory grows +{} MiB per 1,000 requests it serves, reaching its {} MiB limit after about {} requests per container — then it is OOM-killed and restarts. A busier day gets there sooner; a restart before then, a higher limit or fixing the leak avoids it",
                    s(x, &["service"]),
                    js_num(n(x, &["leakMiBPer1000"])),
                    js_num(n(x, &["limitMiB"])),
                    crate::math::js_locale(n(x, &["requestsToLimit"]))
                ));
            } else {
                l.push(format!("- **{}** peaked at {} MiB of its {} MiB memory limit ({}%)", s(x, &["service"]), js_num(n(x, &["peakMiB"])), js_num(n(x, &["limitMiB"])), js_num(js_round(n(x, &["share"]) * 100.0))));
            }
        }
        l.push(String::new());
    }
    let fixes = arr(r, &["fixes"]);
    if !fixes.is_empty() {
        l.push("## Fixes that pass".into());
        l.push(String::new());
        let pool = !g(r, &["nodePool"]).is_null();
        for f in fixes {
            l.push(format!("- {}: {}, {}", s(f, &["name"]), gain(f), cost_word(n(f, &["monthlyDelta"]), pool)));
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
    let cm = g(r, &["commitment"]);
    if !cm.is_null() {
        l.push("## Commitment".into());
        l.push(String::new());
        l.push(format!(
            "The history never ran fewer than **{} {}** ({}/month on demand): capacity that is always on, which a commitment discounts. {}.",
            js_num(n(cm, &["floor"])),
            s(cm, &["unit"]),
            usd_plain(n(cm, &["onDemandMonthly"])),
            arr(cm, &["options"]).iter().map(|o| format!("{} saves about **{}/month**", s(o, &["term"]), usd_plain(n(o, &["savesMonthly"])))).collect::<Vec<_>>().join("; ")
        ));
        l.push(String::new());
        l.push(format!("{} Commit to the floor, not the peak: what runs above it stays on demand.", s(cm, &["basis"])));
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

/// how far the model can be read: services that fit, and those it doesn't explain
fn trust(mv: &Value) -> Value {
    let svcs = g(mv, &["services"]).as_object().cloned().unwrap_or_default();
    let fit = |sv: &Value| s(sv, &["fit", "status"]);
    let modelled: Vec<(&String, &Value)> = svcs.iter().filter(|(_, sv)| fit(sv) != "cost-only").collect();
    let good = modelled.iter().filter(|(_, sv)| matches!(fit(sv).as_str(), "good" | "fair")).count();
    let poor: Vec<&String> = modelled.iter().filter(|(_, sv)| matches!(fit(sv).as_str(), "poor" | "unexplained")).map(|(id, _)| *id).collect();
    // the p99 check on held-back history, the one number that says how the whole model predicts
    let held = arr(mv, &["accuracy"]).iter().rev().flat_map(|a| arr(a, &["checks"])).find(|c| s(c, &["metric"]) == "p99").map(|c| json!({ "error": num(js_round(n(c, &["error"]) * 100.0) / 100.0), "pass": g(c, &["pass"]) })).unwrap_or(Value::Null);
    json!({ "services": modelled.len(), "fit": good, "untrusted": poor, "heldOutP99": held })
}

/// "14 Oct 2026 14:22" from an ISO time
fn when(iso: &str) -> String {
    const MON: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let (date, time) = (iso.get(..10).unwrap_or(iso), iso.get(11..16).unwrap_or(""));
    let p: Vec<&str> = date.split('-').collect();
    match (p.first(), p.get(1).and_then(|m| m.parse::<usize>().ok()), p.get(2)) {
        (Some(y), Some(mo), Some(dd)) if (1..=12).contains(&mo) => format!("{} {} {} {}", dd.trim_start_matches('0'), MON[mo - 1], y, time),
        _ => iso.to_string(),
    }
}

/// five lines a CTO reads first: risk, headroom, cost, the one change, how far to trust it
fn summary_lines(r: &Value) -> Vec<String> {
    let mut l = vec![];
    let today = g(r, &["today"]);
    let busier = arr(r, &["busier"]);
    let nl = g(r, &["nodeLoss"]);
    let first_fail = busier.iter().find(|b| !g(b, &["holds"]).as_bool().unwrap_or(true));
    let node_fails = !nl.is_null() && !g(nl, &["survives"]).as_bool().unwrap_or(true);
    let node_cost = || format!("losing **{}** at the busiest moment fails {} more requests{}", s(nl, &["worst", "node"]), js_locale(n(nl, &["worst", "failedRequests"])), minutes_added(n(nl, &["worst", "minutesOutOfSlo"])));
    let and_node = || if node_fails { format!(" And {}.", node_cost()) } else { String::new() };
    let risk = if !today.is_null() && !g(today, &["holds"]).as_bool().unwrap_or(true) {
        format!("**High.** The recorded day itself spent {} min out of SLO ({} failed requests); worst moment: {}.{}", js_num(n(today, &["minutesOutOfSlo"])), js_locale(n(today, &["failedRequests"])), s(today, &["worst"]), and_node())
    } else if let Some(b) = first_fail {
        format!("**Medium.** The recorded day held, but a {}× day spends {} min out of SLO — {}.{}", js_num(n(b, &["scale"])), js_num(n(b, &["minutesOutOfSlo"])), s(b, &["worst"]), and_node())
    } else if node_fails {
        format!("**Medium.** Traffic holds to 2×, but {}.", node_cost())
    } else {
        format!("**Low.** The recorded day held, and so do 1.5× and 2× days{}.", if nl.is_null() { "" } else { " and the loss of any one node" })
    };
    // a verdict from a model that mostly doesn't fit is said with that, not after it
    let t = g(r, &["trust"]);
    let shaky = !t.is_null() && n(t, &["fit"]) * 2.0 < n(t, &["services"]);
    l.push(format!("- **Risk:** {}{}", risk, if shaky { " Read it with the trust line below: most of the model doesn't fit the history yet." } else { "" }));
    let over = g(r, &["headroom", "overPeak"]);
    let over_s = if truthy(over) { format!(", {}× the busiest moment ({} req/s)", js_num(n(r, &["headroom", "overPeak"])), js_num(n(r, &["history", "peakRps"]))) } else { String::new() };
    l.push(match g(r, &["headroom", "limitedBy"]) {
        _ if g(r, &["headroom", "atAnyLoad"]).is_string() => format!("- **Headroom:** none to read — out of SLO at any load: {}. Not a capacity limit; fix or explain that first.", s(r, &["headroom", "atAnyLoad"])),
        // nothing gave out before the search's ceiling
        Value::Null => format!("- **Headroom:** more than {} req/s within SLO{} — nothing saturates in the range searched.", js_num(n(r, &["headroom", "rps"])), over_s),
        x => format!(
            "- **Headroom:** {} req/s within SLO{}; {} saturates first.{}",
            js_num(n(r, &["headroom", "rps"])),
            over_s,
            s(x, &[]),
            if g(r, &["headroom", "limitTrusted"]).as_bool().unwrap_or(true) { String::new() } else { format!(" Treat it as a guess: the model does not explain {} well.", s(x, &[])) }
        ),
    });
    let p = g(r, &["nodePool"]);
    // a fixed pool is paid for whole, whatever the pods on it use
    let fixed = !p.is_null() && !g(p, &["autoscaled"]).as_bool().unwrap_or(false);
    let monthly = if fixed { n(p, &["nodes"]) * n(p, &["monthlyPerNode"]) } else { n(today, &["monthly"]) };
    let mut cost = if monthly > 0.0 { format!("about **{}/month** as run", usd_plain(monthly)) } else { "no price — connect the bill (`connect_telemetry` with `bill`) or a pricing profile".to_string() };
    if !p.is_null() {
        cost.push_str(&format!(", on {} node{} {}% full at the busiest moment", js_num(n(p, &["nodes"])), if n(p, &["nodes"]) == 1.0 { "" } else { "s" }, js_num(js_round(n(p, &["peakFill"]) * 100.0))));
    }
    let cm = g(r, &["commitment"]);
    if let Some(best) = arr(cm, &["options"]).iter().map(|o| n(o, &["savesMonthly"])).fold(None, |a: Option<f64>, x| Some(a.map_or(x, |a| a.max(x)))) {
        cost.push_str(&format!("; a commitment on the always-on floor saves up to {}/month", usd_plain(best)));
    }
    if let Some(sv) = arr(r, &["savings"]).first() {
        cost.push_str(&format!("; the best saving that passes: {} ({})", s(sv, &["name"]), usd_signed(n(sv, &["monthlyDelta"]))));
    }
    l.push(format!("- **Cost:** {}.", cost));
    let risky = !g(today, &["holds"]).as_bool().unwrap_or(true) || first_fail.is_some() || node_fails;
    let fix = arr(r, &["fixes"]).first().cloned();
    let node_fix = g(nl, &["fix"]);
    let one = match (risky, fix, arr(r, &["savings"]).first()) {
        (true, Some(f), _) => format!("{} — {}, {}.", s(f, &["name"]), gain(f), cost_word(n(f, &["monthlyDelta"]), !p.is_null())),
        (true, None, _) if !node_fix.is_null() && g(node_fix, &["survives"]).as_bool().unwrap_or(false) => format!(
            "run {} spread over the nodes, so losing one leaves a replica of each — {}.",
            arr(node_fix, &["change", "changes"]).iter().map(|c| format!("{}{}", s(c, &["service"]), if truthy(g(c, &["replicas"])) { format!(" × {}", js_num(n(c, &["replicas"]))) } else { String::new() })).collect::<Vec<_>>().join(", "),
            cost_word(n(node_fix, &["monthlyDelta"]), !p.is_null())
        ),
        (_, _, Some(sv)) => format!("{} — {}, {}.", s(sv, &["name"]), usd_signed(n(sv, &["monthlyDelta"])), s(sv, &["verdict"])),
        (true, None, None) => "no single change passed the backtest; see the limits below.".to_string(),
        (false, _, None) => "nothing — no fix is needed and no saving passed.".to_string(),
    };
    l.push(format!("- **Do this:** {}{}", one, if one.starts_with("no") || one.starts_with("nothing") { "" } else { " Run `verify_change` on it before it ships." }));
    let t = g(r, &["trust"]);
    if !t.is_null() {
        let un: Vec<String> = arr(t, &["untrusted"]).iter().map(|x| s(x, &[])).collect();
        let h = g(t, &["heldOutP99"]);
        let held = if h.is_null() {
            " Its predictions were not checked on held-back history (see calibrate_model's warnings).".to_string()
        } else {
            format!(" On history it was not fitted to, it predicts p99 within {}% ({}).", js_num(js_round(n(h, &["error"]) * 100.0)), if g(h, &["pass"]).as_bool().unwrap_or(false) { "inside the 20% tolerance" } else { "outside the 20% tolerance: read every number as directional" })
        };
        l.push(format!("- **Trust:** {} of {} services fit the history well{}.{}", js_num(n(t, &["fit"])), js_num(n(t, &["services"])), if un.is_empty() { String::new() } else { format!("; not explained: {} — numbers that rest on them are guesses", un.join(", ")) }, held));
    }
    l
}

/// the minutes a failure adds out of SLO; none where the history was already out of it then
fn minutes_added(m: f64) -> String {
    if m > 0.0 {
        format!(" and {} min out of SLO", js_num(m))
    } else {
        " — more than the error budget allows, though no minutes are added: the history was already out of SLO then".into()
    }
}

/// what a fix gives back: minutes out of SLO, or failed requests where the minutes don't move
fn gain(f: &Value) -> String {
    let (m, fr) = (-n(f, &["minutesOutOfSloDelta"]), -n(f, &["failedRequestsDelta"]));
    match (m >= 0.5, fr >= 1.0) {
        (true, true) => format!("{} fewer minutes out of SLO and {} fewer failed requests", js_num(m), js_locale(js_round(fr))),
        (true, false) => format!("{} fewer minutes out of SLO", js_num(m)),
        (false, true) => format!("{} fewer failed requests (the minutes out of SLO stay)", js_locale(js_round(fr))),
        _ => "no measurable gain".into(),
    }
}

/// a fix's money: on a fixed pool, a change that adds no node adds no cost
fn cost_word(x: f64, pool: bool) -> String {
    if x.abs() < 0.5 {
        if pool { "no added cost (it fits on the nodes already running)".into() } else { "no added cost".into() }
    } else {
        usd_signed(x)
    }
}

fn usd_signed(x: f64) -> String {
    format!("{}${}/month", if x < 0.0 { "−" } else { "+" }, js_locale(js_round(x).abs()))
}

fn usd_plain(x: f64) -> String {
    format!("${}", js_locale(js_round(x)))
}

/// how much to commit to: the floor the history always ran (nodes on a cluster, else replicas of
/// list-priced services), priced at the published 1- and 3-year rates; nothing when costs come from
/// a bill, which may already carry discounts
fn commitment(mv: &Value, dv: &Value) -> Value {
    let floor_of = |series: &Value| arr(series, &[]).iter().filter_map(|x| x.as_f64()).fold(f64::INFINITY, f64::min);
    let c = g(mv, &["cluster"]);
    if !c.is_null() && s(c, &["node", "source"]) != "hint" {
        let floor = floor_of(g(dv, &["cluster", "clusterNodes"]));
        let ph = n(c, &["node", "perHour"]);
        if floor.is_finite() && floor >= 1.0 && ph > 0.0 {
            let od = floor * ph * 730.0;
            // EC2 m6i reserved, no upfront: $0.064 / $0.044 against $0.096 (instances.vantage.sh)
            return json!({ "floor": num(floor), "unit": if floor == 1.0 { "node" } else { "nodes" }, "onDemandMonthly": num(js_round(od)), "options": [
                { "term": "1-year reserved (no upfront)", "savesMonthly": num(js_round(od * (1.0 - 0.064 / 0.096))) },
                { "term": "3-year reserved (no upfront)", "savesMonthly": num(js_round(od * (1.0 - 0.044 / 0.096))) },
            ], "basis": "Nodes priced as EC2 m6i on demand; reserved m6i is 33% / 54% off (no upfront)." });
        }
        return Value::Null;
    }
    // services priced at Fargate list prices: a Compute Savings Plan, 1 year no upfront, is ~20% off
    let mut od = 0.0;
    let mut floor = 0.0;
    for (id, sv) in g(mv, &["services"]).as_object().cloned().unwrap_or_default() {
        if s(&sv, &["cost", "source"]) != "pricing" {
            continue;
        }
        let f = floor_of(g(dv, &["services", &id, "replicas"]));
        if f.is_finite() && f > 0.0 {
            od += f * n(&sv, &["cost", "perReplicaHour"]) * 730.0;
            floor += f;
        }
    }
    if od < 1.0 {
        return Value::Null;
    }
    json!({ "floor": num(floor), "unit": "replicas", "onDemandMonthly": num(js_round(od)), "options": [
        { "term": "a 1-year Compute Savings Plan (no upfront)", "savesMonthly": num(js_round(od * 0.2)) },
    ], "basis": "Services priced at AWS Fargate list prices; a 1-year Compute Savings Plan, no upfront, is about 20% off on Fargate." })
}
