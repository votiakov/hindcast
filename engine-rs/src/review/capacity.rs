//! The capacity review a platform team does by hand (agent/review.ts): headroom, busier days, losing
//! a node, the limits that bind, the fixes and savings that pass; the data, the five lines a lead
//! reads first, and one Markdown report.

use super::json::{arr, g, inf, iso, n, num, r1, s, template_str, to_json, truthy};
use crate::math::{js_locale, js_num, js_round, js_to_fixed};
use serde_json::{json, Map as JMap, Value};

/// what the review computed, and the suggest_changes answer it was built on (the app links each fix
/// and saving to its change)
pub struct Review {
    pub out: JMap<String, Value>,
    pub suggested: Value,
}

/// The capacity review on a calibrated model (`mv` as JSON, `m` parsed) and its history (`dv`, `d`):
/// `cal` is the calibration report where there is one, `calibrate_options` the options the model was
/// calibrated with (asked for only when the history is long enough to be split in thirds).
#[allow(clippy::too_many_arguments)]
pub fn review(mv: &Value, m: &crate::model::Model, dv: &Value, d: &crate::dataset::Dataset, cal: Option<&Value>, draws: f64, calibrate_options: &dyn Fn() -> Result<crate::calibrate::CalibrateOptions, String>) -> Result<Review, String> {
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
    let nodes = if has_pods { Some(to_json(&crate::resilience::node_loss(&m, &d, &crate::resilience::NodeLossOptions { draws: Some(draws.min(8.0)), grpc_calls: super::judge::grpc_calls(&mv), ..Default::default() })?)) } else { None };
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
    let sug = super::with_progress(None, || super::suggest::suggest(mv, m, d, cal, &json!({ "draws": draws })))?;
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
    // nothing carries load: no endpoint, so the replays below have no traffic in them
    if m.endpoints.is_empty() {
        out.insert("noTraffic".into(), json!(true));
    }
    out.insert("history".into(), json!({ "from": iso(n(&dv, &["start"])), "to": iso(n(&dv, &["start"]) + n(&dv, &["n"]) * n(&dv, &["stepS"])), "peakRps": num(r1(peak)) }));
    out.insert("slo".into(), g(&mv, &["slo"]).clone());
    // a headroom set by a service the model doesn't explain is a guess: say so where it is read
    let limit_fit = head.limited_by.as_ref().map(|id| s(&mv, &["services", id, "fit", "status"])).unwrap_or_default();
    // one with no latency metric: its limit is read from CPU, which is said instead
    let cpu_alone = head.limited_by.as_ref().map(|id| arr(&mv, &["provenance", "latency", "without"]).iter().any(|x| x.as_str() == Some(id.as_str()))).unwrap_or(false);
    let mut headroom = json!({ "rps": num(r1(head.rps)), "limitedBy": head.limited_by, "overPeak": if peak > 0.0 { num(js_round((head.rps / peak) * 100.0) / 100.0) } else { Value::Null }, "limitTrusted": cpu_alone || !matches!(limit_fit.as_str(), "poor" | "unexplained") });
    if cpu_alone {
        headroom["limitFromCpu"] = json!(true);
    }
    if let Some(why) = &head.at_any_load {
        headroom["atAnyLoad"] = json!(why);
    }
    out.insert("headroom".into(), headroom);
    out.insert("stability".into(), stability(calibrate_options, d, m, &head)?);
    out.insert("today".into(), today);
    out.insert("trust".into(), trust(&mv));
    out.insert("busier".into(), json!(busier));
    out.insert(
        "nodeLoss".into(),
        match &nodes {
            Some(nl) => {
                let r0 = arr(nl, &["results"]).first().cloned().cloned();
                // the same, if callers' connections stay broken after the lost services are back: the
                // node whose loss it hurts most
                let stuck = arr(nl, &["results"]).iter().filter(|r| !g(r, &["ifCallersStayBroken"]).is_null()).max_by(|a, b| n(a, &["ifCallersStayBroken", "minutesOutOfSlo"]).partial_cmp(&n(b, &["ifCallersStayBroken", "minutesOutOfSlo"])).unwrap_or(std::cmp::Ordering::Equal)).map(|r| {
                    let x = g(r, &["ifCallersStayBroken"]);
                    json!({ "node": g(r, &["node"]), "minutesOutOfSlo": g(x, &["minutesOutOfSlo"]), "failedRequests": g(x, &["failedRequests"]), "answer": { "minutesOutOfSlo": g(r, &["minutesOutOfSlo"]), "failedRequests": g(r, &["failedRequests"]) }, "reconnectS": g(x, &["reconnectS"]), "calls": g(x, &["calls"]), "verdict": g(x, &["verdict"]), "cutShort": g(x, &["cutShort"]).as_bool().unwrap_or(false) })
                });
                let mut o = json!({
                    "survives": g(nl, &["survives"]),
                    "worst": r0.map(|r| json!({ "node": g(&r, &["node"]), "minutesOutOfSlo": g(&r, &["minutesOutOfSlo"]), "failedRequests": g(&r, &["failedRequests"]), "down": arr(&r, &["lost"]).iter().filter(|l| g(l, &["down"]).as_bool().unwrap_or(false)).map(|l| g(l, &["service"]).clone()).collect::<Vec<_>>() })).unwrap_or(Value::Null),
                    "singlePointsOfFailure": arr(nl, &["singlePointsOfFailure"]).iter().map(|x| g(x, &["service"]).clone()).collect::<Vec<_>>(),
                    "fix": match g(&sug, &["nodeLoss", "fix"]) { Value::Null => Value::Null, x => x.clone() },
                });
                if let Some(x) = stuck {
                    o["ifCallersStayBroken"] = x;
                }
                o
            }
            None => Value::Null,
        },
    );
    let grpc = grpc_restarts(&mv);
    if !grpc.is_empty() {
        out.insert("restartRisks".into(), json!(grpc));
    }
    out.insert("throttled".into(), json!(throttled));
    out.insert("memoryNearLimit".into(), json!(memory));
    out.insert("fixes".into(), json!(arr(&sug, &["fixes"]).iter().take(5).map(|f| json!({ "name": g(f, &["name"]), "minutesOutOfSloDelta": g(f, &["minutesOutOfSloDelta"]), "failedRequestsDelta": g(f, &["failedRequestsDelta"]), "monthlyDelta": g(f, &["monthlyDelta"]), "verdict": g(f, &["verdict"]), "confidence": g(f, &["confidence"]) })).collect::<Vec<_>>()));
    out.insert("savings".into(), json!(arr(&sug, &["savings"]).iter().take(8).map(|x| json!({ "name": g(x, &["name"]), "monthlyDelta": g(x, &["monthlyDelta"]), "verdict": g(x, &["verdict"]) })).collect::<Vec<_>>()));
    out.insert("nodePool".into(), pool);
    out.insert("commitment".into(), commitment(&mv, &dv));
    let cs = g(&sug, &["combinedSavings"]);
    out.insert("combinedSavings".into(), if cs.is_null() { Value::Null } else { json!({ "name": g(cs, &["name"]), "monthlyDelta": g(cs, &["monthlyDelta"]), "verdict": g(cs, &["verdict"]) }) });
    to_replayed_peak(&mut out, d);
    Ok(Review { out, suggested: sug })
}

/// The history replayed here may be shorter than the one the model was calibrated on (the demo's,
/// the app's): every ratio is then to the replayed history's busiest moment, the one the busier days
/// scale and the chart draws, and the calibration history's is said once, in a note under the
/// history line. Otherwise the headroom reads against one peak and "holds to 2×" against another.
fn to_replayed_peak(out: &mut JMap<String, Value>, d: &crate::dataset::Dataset) {
    let open_peak = r1((0..d.n.max(0.0) as usize).map(|i| traffic_at(d, i)).fold(0.0, f64::max));
    let cal_peak = n(&Value::Object(out.clone()), &["history", "peakRps"]);
    if open_peak > 0.0 && cal_peak.is_finite() && (cal_peak - open_peak).abs() > 0.02 * cal_peak {
        let head = n(&Value::Object(out.clone()), &["headroom", "rps"]);
        let any = !g(&Value::Object(out.clone()), &["headroom", "atAnyLoad"]).is_null();
        if let Some(h) = out.get_mut("history") {
            h["peakRps"] = num(open_peak);
        }
        if let Some(h) = out.get_mut("headroom") {
            h["overPeak"] = num(js_round((head / open_peak) * 100.0) / 100.0);
        }
        let mut said = format!("The model was calibrated on a longer history, whose busiest moment was {} req/s; this one peaks at {} req/s, and every ratio here is to {}.", js_num(cal_peak), js_num(open_peak), js_num(open_peak));
        if !any && head < cal_peak {
            said.push_str(&format!(" The headroom, {} req/s, is below the {} req/s the model was calibrated on: that busiest moment was past what the system serves within SLO.", js_num(head), js_num(cal_peak)));
        }
        out.insert("calibrated".into(), json!({ "peakRps": num(cal_peak), "said": said }));
    }
}

pub fn review_markdown(r: &Value) -> String {
    let usd = |x: f64| format!("{}${}/month", if x < 0.0 { "−" } else { "+" }, js_locale(js_round(x).abs()));
    let mut l: Vec<String> = vec![
        format!("# Capacity review — {}", s(r, &["system"])),
        String::new(),
        format!("History {} – {} UTC, busiest moment {} req/s. SLO: p99 ≤ {} ms, errors ≤ {}%.", when(&s(r, &["history", "from"])), when(&s(r, &["history", "to"])), js_num(n(r, &["history", "peakRps"])), js_num(n(r, &["slo", "p99Ms"])), js_to_fixed(n(r, &["slo", "errorRate"]) * 100.0, 1)),
        String::new(),
    ];
    if let Some(said) = g(r, &["calibrated", "said"]).as_str() {
        l.push(said.to_string());
        l.push(String::new());
    }
    if !g(r, &["today"]).is_null() {
        l.push("## Summary".into());
        l.push(String::new());
        l.extend(summary_lines(r, false));
        l.push(String::new());
    }
    let no_traffic = g(r, &["noTraffic"]).as_bool().unwrap_or(false);
    if no_traffic {
        l.push("No service has request metrics, so there is no traffic to replay: headroom, busier days and losing a node can't be read; cost still can.".into());
        l.push(String::new());
    } else {
        l.push("## Headroom".into());
        l.push(String::new());
        let over = g(r, &["headroom", "overPeak"]);
        match g(r, &["headroom", "atAnyLoad"]).as_str() {
            Some(why) => l.push(format!("**Out of SLO at any load** — {}. That is no capacity limit: the model misses the SLO with almost no traffic, so fix or explain that first.", why)),
            None => l.push(format!("Within SLO up to **{} req/s**{}; {}.", js_num(n(r, &["headroom", "rps"])), if truthy(over) { format!(" — {}× the busiest moment", js_num(n(r, &["headroom", "overPeak"]))) } else { String::new() }, match g(r, &["headroom", "limitedBy"]) { Value::Null => "nothing saturates in the range searched".to_string(), x => format!("{} saturates first", s(x, &[])) })),
        }
        l.push(String::new());
        let st = g(r, &["stability"]);
        if !arr(st, &["windows"]).is_empty() {
            let ws: Vec<String> = arr(st, &["windows"]).iter().map(|w| format!("{} – {}: {}", when(&s(w, &["from"])), when(&s(w, &["to"])), if w.get("atAnyLoad").is_some() { "out of SLO at any load".to_string() } else { match g(w, &["limitedBy"]) { Value::Null => format!("more than {} req/s", js_num(n(w, &["rps"]))), x => format!("{} req/s, {} first", js_num(n(w, &["rps"])), s(x, &[])) } })).collect();
            l.push(match uncertain(r) {
                Some(u) => format!("**Uncertain:** {} Each third of the history's traffic, calibrated alone: {}.", u, ws.join("; ")),
                None => format!("Each third of the history's traffic, calibrated alone, agrees: {}.", ws.join("; ")),
            });
            l.push(String::new());
        }
        let t = g(r, &["today"]);
        if !t.is_null() {
            l.push(format!("- **The recorded day, replayed:** {}", if g(t, &["holds"]).as_bool().unwrap_or(false) { "holds".to_string() } else { format!("{} min out of SLO, {} failed requests — {}", js_num(n(t, &["minutesOutOfSlo"])), js_locale(n(t, &["failedRequests"])), s(t, &["worst"])) }));
        }
        for b in arr(r, &["busier"]) {
            l.push(format!("- **{}× today's traffic:** {}", js_num(n(b, &["scale"])), if g(b, &["holds"]).as_bool().unwrap_or(false) { "holds".to_string() } else { format!("{} min out of SLO, {} failed requests — {}", js_num(n(b, &["minutesOutOfSlo"])), js_locale(n(b, &["failedRequests"])), s(b, &["worst"])) }));
        }
        l.push(String::new());
    }
    let nl = g(r, &["nodeLoss"]);
    if !nl.is_null() && !no_traffic {
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
        let sb = g(nl, &["ifCallersStayBroken"]);
        if !sb.is_null() {
            l.push(String::new());
            l.push(stuck_line(sb));
        }
        let fx = g(nl, &["fix"]);
        if !fx.is_null() {
            l.push(String::new());
            let items: Vec<String> = arr(fx, &["change", "changes"]).iter().map(|c| format!("{}{}", s(c, &["service"]), if truthy(g(c, &["replicas"])) { format!(" → {}", js_num(n(c, &["replicas"]))) } else { String::new() })).collect();
            l.push(format!("Fix, backtested: {}, spread over the nodes — {}, {}.", items.join(", "), if g(fx, &["survives"]).as_bool().unwrap_or(false) { "survives every node" } else { "still fails a node" }, usd(n(fx, &["monthlyDelta"]))));
        }
        l.push(String::new());
    }
    let rr = arr(r, &["restartRisks"]);
    if !rr.is_empty() {
        l.push("## Risks the replay doesn't time".into());
        l.push(String::new());
        let callers = |x: &Value| arr(x, &["callers"]).iter().map(|c| s(c, &[])).collect::<Vec<_>>().join(", ");
        if let [x] = rr.as_slice() {
            l.push(format!("{}. {} runs one replica; {} call{} it over gRPC.", cap(&restart_said(&[s(x, &["service"])])), s(x, &["service"]), callers(x), if arr(x, &["callers"]).len() == 1 { "s" } else { "" }));
        } else {
            l.push("A restart of any of these single-replica services may leave callers' gRPC channels broken; check keepalive/reconnect settings — the replay times only the platform's recovery:".into());
            l.push(String::new());
            for x in rr {
                l.push(format!("- **{}**, called over gRPC by {}", s(x, &["service"]), callers(x)));
            }
        }
        l.push(String::new());
    }
    let th = arr(r, &["throttled"]);
    let mem = arr(r, &["memoryNearLimit"]);
    if !th.is_empty() || !mem.is_empty() {
        l.push("## Limits that bind".into());
        l.push(String::new());
        for t in th {
            l.push(format!("- **{}** is held back by its CPU quota: throttling takes over at {}% of its {}-core limit ({} req/s per replica)", s(t, &["service"]), js_num(js_round(n(t, &["kneeShareOfLimit"]) * 100.0)), template_str(t.get("cpuLimit")), js_num(n(t, &["perReplicaRps"]))));
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
        } else if !auto && n(p, &["wouldFit"]) == nodes {
            // a low fill reads as over-provisioned; say why the pool still can't shrink
            l.push(String::new());
            l.push(format!("It can't shrink: {} nodes is the fewest that hold the busiest moment's requests with one node to spare for losing one.", js_num(nodes)));
        } else if !auto {
            l.push(String::new());
            l.push(format!("It has no node to spare: {} nodes would hold the busiest moment's requests with one to spare for losing one.", js_num(n(p, &["wouldFit"]))));
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
    // no latency metric: the fit has nothing to be scored on, and capacity rests on CPU alone
    let blind: Vec<String> = arr(mv, &["provenance", "latency", "without"]).iter().map(|x| s(x, &[])).collect();
    // marked by calibration (capacity.cpuAlone); models from before the mark: no latency metric and an unexplained fit
    let cpu_only: Vec<&String> = svcs.iter().filter(|(id, sv)| g(sv, &["capacity", "cpuAlone"]).as_bool() == Some(true) || (blind.contains(*id) && fit(sv) == "unexplained")).map(|(id, _)| id).collect();
    let modelled: Vec<(&String, &Value)> = svcs.iter().filter(|(id, sv)| fit(sv) != "cost-only" && !cpu_only.contains(id)).collect();
    let good = modelled.iter().filter(|(_, sv)| matches!(fit(sv).as_str(), "good" | "fair")).count();
    let poor: Vec<&String> = modelled.iter().filter(|(_, sv)| matches!(fit(sv).as_str(), "poor" | "unexplained")).map(|(id, _)| *id).collect();
    // the p99 check on held-back history, the one number that says how the whole model predicts
    let held = arr(mv, &["accuracy"]).iter().rev().flat_map(|a| arr(a, &["checks"])).find(|c| s(c, &["metric"]) == "p99").map(|c| json!({ "error": num(js_round(n(c, &["error"]) * 100.0) / 100.0), "pass": g(c, &["pass"]) })).unwrap_or(Value::Null);
    // services fitted on one of several configurations; those whose latest was too short to fit
    let mixed: Vec<&String> = svcs.iter().filter(|(_, sv)| !g(sv, &["fit", "regime"]).is_null()).map(|(id, _)| id).collect();
    let older: Vec<Value> = svcs.iter().filter(|(_, sv)| !g(sv, &["fit", "regime", "latest"]).is_null()).map(|(id, sv)| json!({ "service": id, "latest": g(sv, &["fit", "regime", "latest"]), "fittedHours": g(sv, &["fit", "regime", "busyHours"]) })).collect();
    let mut t = json!({ "services": modelled.len(), "fit": good, "untrusted": poor, "heldOutP99": held });
    if !cpu_only.is_empty() {
        t["cpuOnly"] = json!(cpu_only);
    }
    if let Some(w) = g(mv, &["provenance", "said"]).as_str() {
        t["withoutTraces"] = json!(w);
    }
    if !mixed.is_empty() {
        t["configurations"] = json!({ "mixed": mixed, "fittedOnOlder": older });
    }
    t
}

/// a gRPC call into a service that runs one replica: when it restarts, a client's channel can stay
/// broken long after the pod is back — something the replay, which times the platform, can't see
fn grpc_restarts(mv: &Value) -> Vec<Value> {
    let mut by: indexmap::IndexMap<String, Vec<String>> = indexmap::IndexMap::new();
    for c in arr(mv, &["provenance", "grpc", "calls"]) {
        let at = |k: usize| c.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
        let (a, b) = (at(0), at(1));
        let to = g(mv, &["services", &b]);
        if to.is_null() || truthy(g(to, &["hostedBy"])) || n(to, &["replicas"]) > 1.0 {
            continue;
        }
        let callers = by.entry(b).or_default();
        if !callers.contains(&a) {
            callers.push(a);
        }
    }
    by.into_iter().map(|(svc, callers)| json!({ "service": svc, "callers": callers })).collect()
}

/// the node-loss sensitivity, worded: what it assumed, and that it is an assumption
fn stuck_line(sb: &Value) -> String {
    let end = |c: &Value, k: usize| c.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let calls: Vec<String> = arr(sb, &["calls"]).iter().map(|c| format!("{} → {}", end(c, 0), end(c, 1))).collect();
    let secs = n(sb, &["reconnectS"]);
    let source = if secs == crate::resilience::REFERENCE_RECONNECT_S { format!(" (as measured on the reference cluster: the frontend's channel to cart stayed broken {} s after cart was back, until the frontend restarted — one observation on one cluster)", js_num(secs)) } else { String::new() };
    format!(
        "If callers' connections stay broken until they restart{}, losing **{}** costs {} min out of SLO and {} failed requests, against {} min and {} in the answer: {} keep failing for {} s after the replacement is up{}. An assumption, not part of the answer above.",
        source,
        s(sb, &["node"]),
        js_num(n(sb, &["minutesOutOfSlo"])),
        js_locale(n(sb, &["failedRequests"])),
        js_num(n(sb, &["answer", "minutesOutOfSlo"])),
        js_locale(n(sb, &["answer", "failedRequests"])),
        calls.join(", "),
        js_num(secs),
        if g(sb, &["cutShort"]).as_bool().unwrap_or(false) { " (the history ends before they would reconnect, so this undercounts)" } else { "" }
    )
}

fn cap(x: &str) -> String {
    let mut c = x.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

fn restart_said(svcs: &[String]) -> String {
    let who = match svcs.len() {
        1 => svcs[0].clone(),
        k if k <= 3 => format!("{} or {}", svcs[..k - 1].join(", "), svcs[k - 1]),
        k => format!("{} or {} other single-replica services (listed below)", svcs[..2].join(", "), k - 2),
    };
    format!("a restart of {} may leave callers' gRPC channels broken; check keepalive/reconnect settings — the replay times only the platform's recovery", who)
}

/// headroom recomputed on thirds of the history's traffic, each calibrated on its own: how much the
/// answer depends on the window collected
fn stability(calibrate_options: &dyn Fn() -> Result<crate::calibrate::CalibrateOptions, String>, d: &crate::dataset::Dataset, m: &crate::model::Model, whole: &crate::accuracy::BreakingPoint) -> Result<Value, String> {
    let n_b = d.n.max(0.0) as usize;
    let at = |i: usize| traffic_at(d, i);
    let busy: Vec<usize> = (0..n_b).filter(|&i| at(i) > 0.0).collect();
    let hosted: crate::types::Map<String> = m.services.iter().filter_map(|(id, s)| s.hosted_by.clone().map(|h| (id.clone(), h))).collect();
    let configurations = crate::regimes::system_configurations(&crate::regimes::detect_all(d, &hosted), n_b);
    // too little traffic to split: thirds of it would not calibrate
    if busy.len() < 3 * crate::regimes::MIN_BUSY_BUCKETS {
        return Ok(json!({ "windows": [], "configurations": configurations }));
    }
    let mut opts = calibrate_options()?;
    opts.bootstrap = Some(0.0);
    let mut windows = vec![];
    for k in 0..3 {
        let part = &busy[k * busy.len() / 3..(k + 1) * busy.len() / 3];
        let (a, b) = (part[0], part[part.len() - 1] + 1);
        let sub = crate::accuracy::slice_dataset(d, a, b);
        let sm = crate::calibrate::calibrate(&sub, &opts);
        let bp = crate::accuracy::model_breaking_point(&sm, Some(&crate::backtest::base_plan(&sm, None)), None, None, None);
        let mut w = json!({ "from": iso(d.start + a as f64 * d.step_s), "to": iso(d.start + b as f64 * d.step_s), "rps": num(r1(bp.rps)), "limitedBy": bp.limited_by });
        if let Some(why) = bp.at_any_load {
            w["atAnyLoad"] = json!(why);
        }
        windows.push(w);
    }
    // (headroom, nothing saturated below it)
    let mut rs: Vec<(f64, bool)> = windows.iter().map(|w| (n(w, &["rps"]), w["limitedBy"].is_null() && w.get("atAnyLoad").is_none())).collect();
    rs.push((r1(whole.rps), whole.limited_by.is_none() && whole.at_any_load.is_none()));
    let (lo, hi) = (rs.iter().map(|x| x.0).fold(f64::INFINITY, f64::min), rs.iter().map(|x| x.0).fold(0.0, f64::max));
    let open = rs.iter().any(|x| x.0 == hi && x.1);
    // half again from the lowest to the highest, or some windows with no headroom at all and some with
    let uncertain = hi > 0.0 && (lo <= 0.0 || hi > lo * UNCERTAIN_SPREAD);
    Ok(json!({ "windows": windows, "low": num(lo), "high": num(hi), "highOpen": open, "uncertain": uncertain, "configurations": configurations }))
}

/// the history's traffic in bucket `i`: its endpoints' requests, or (no endpoints) its busiest service's
pub fn traffic_at(d: &crate::dataset::Dataset, i: usize) -> f64 {
    let eps: f64 = d.endpoints.values().filter_map(|e| e.rps.as_ref().and_then(|v| v.get(i).copied().flatten())).sum();
    if !d.endpoints.is_empty() {
        eps
    } else {
        d.services.values().filter_map(|s| s.rps.as_ref().and_then(|v| v.get(i).copied().flatten())).fold(0.0, f64::max)
    }
}

/// the spread of sub-window headrooms above which the headroom is called uncertain
const UNCERTAIN_SPREAD: f64 = 1.5;

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

/// the summary as (label, sentence) pairs, for the app: its sentences point at the app, not the agent
/// tools (Markdown emphasis kept)
pub fn summary(r: &Value) -> Vec<Value> {
    summary_lines(r, true)
        .iter()
        .filter_map(|l| {
            let (label, text) = l.strip_prefix("- **")?.split_once(":** ")?;
            Some(json!({ "label": label, "text": text }))
        })
        .collect()
}

/// five lines a CTO reads first: risk, headroom, cost, the one change, how far to trust it; `app`
/// words the next steps for the app rather than the agent tools
fn summary_lines(r: &Value, app: bool) -> Vec<String> {
    let mut l = vec![];
    if g(r, &["noTraffic"]).as_bool().unwrap_or(false) {
        // no load to replay: what can still be read is cost and where the pods run
        l.push("- **Risk:** unknown — no service has request metrics, so there is no traffic to replay (ingress-nginx, a service mesh or HTTP server metrics would give it).".into());
        l.push("- **Headroom:** unknown, for the same reason.".into());
        let p = g(r, &["nodePool"]);
        let fixed = !p.is_null() && !g(p, &["autoscaled"]).as_bool().unwrap_or(false);
        let monthly = if fixed { n(p, &["nodes"]) * n(p, &["monthlyPerNode"]) } else { n(r, &["today", "monthly"]) };
        l.push(format!("- **Cost:** {}.", if monthly > 0.0 { format!("about **{}/month** as run", usd_plain(monthly)) } else { "no price".to_string() }));
        if let Some(w) = g(r, &["trust", "withoutTraces"]).as_str() {
            l.push(format!("- **Trust:** {}.", cap(w)));
        }
        return l;
    }
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
            if g(r, &["headroom", "limitFromCpu"]).as_bool().unwrap_or(false) {
                format!(" Its limit is read from CPU alone: {} has no latency metric.", s(x, &[]))
            } else if g(r, &["headroom", "limitTrusted"]).as_bool().unwrap_or(true) {
                String::new()
            } else {
                format!(" Treat it as a guess: the model does not explain {} well.", s(x, &[]))
            }
        ),
    });
    if let Some(u) = uncertain(r) {
        l.push(format!("- **Headroom uncertain:** {}", u));
    }
    let p = g(r, &["nodePool"]);
    // a fixed pool is paid for whole, whatever the pods on it use
    let fixed = !p.is_null() && !g(p, &["autoscaled"]).as_bool().unwrap_or(false);
    let monthly = if fixed { n(p, &["nodes"]) * n(p, &["monthlyPerNode"]) } else { n(today, &["monthly"]) };
    let mut cost = if monthly > 0.0 { format!("about **{}/month** as run", usd_plain(monthly)) } else { if app { "no price — the model has neither a bill nor list prices".to_string() } else { "no price — connect the bill (`connect_telemetry` with `bill`) or a pricing profile".to_string() } };
    if !p.is_null() {
        cost.push_str(&format!(", on {} node{} {}% full at the busiest moment", js_num(n(p, &["nodes"])), if n(p, &["nodes"]) == 1.0 { "" } else { "s" }, js_num(js_round(n(p, &["peakFill"]) * 100.0))));
    }
    let cm = g(r, &["commitment"]);
    if let Some(best) = arr(cm, &["options"]).iter().map(|o| n(o, &["savesMonthly"])).fold(None, |a: Option<f64>, x| Some(a.map_or(x, |a| a.max(x)))) {
        cost.push_str(&format!("; a commitment on the always-on floor saves up to {}/month", usd_plain(best)));
    }
    if let Some(sv) = arr(r, &["savings"]).first() {
        cost.push_str(&format!("; the best saving that passes: {} ({})", s(sv, &["name"]), usd_signed(n(sv, &["monthlyDelta"]))));
        // over-provisioned by how much: every saving that passes, applied at once and backtested again
        let cs = g(r, &["combinedSavings"]);
        if !cs.is_null() && s(cs, &["verdict"]) == "pass" && (n(cs, &["monthlyDelta"]) - n(sv, &["monthlyDelta"])).abs() >= 1.0 {
            cost.push_str(&format!("; all of them together pass too ({})", usd_signed(n(cs, &["monthlyDelta"]))));
        }
    }
    l.push(format!("- **Cost:** {}.", cost));
    let risky = !g(today, &["holds"]).as_bool().unwrap_or(true) || first_fail.is_some() || node_fails;
    let fix = arr(r, &["fixes"]).first().cloned();
    let node_fix = g(nl, &["fix"]);
    // a fix whose own backtest isn't a confident pass is said with that, where the decision is read
    let caveat = match &fix {
        Some(f) if risky => {
            let (v, c) = (s(f, &["verdict"]), s(f, &["confidence"]));
            if (!v.is_empty() && v != "pass") || c == "low" {
                format!(" Its own backtest is {}{}: load-test it before relying on it.", if v.is_empty() { "unproven".to_string() } else { v }, if c.is_empty() { String::new() } else { format!(" at {} confidence", c) })
            } else {
                String::new()
            }
        }
        _ => String::new(),
    };
    let one = match (risky, fix, arr(r, &["savings"]).first()) {
        (true, Some(f), _) => format!("{} — {}, {}.{}", s(f, &["name"]), gain(f), cost_word(n(f, &["monthlyDelta"]), !p.is_null()), caveat),
        (true, None, _) if !node_fix.is_null() && g(node_fix, &["survives"]).as_bool().unwrap_or(false) => format!(
            "run {} spread over the nodes, so losing one leaves a replica of each — {}.",
            arr(node_fix, &["change", "changes"]).iter().map(|c| format!("{}{}", s(c, &["service"]), if truthy(g(c, &["replicas"])) { format!(" × {}", js_num(n(c, &["replicas"]))) } else { String::new() })).collect::<Vec<_>>().join(", "),
            cost_word(n(node_fix, &["monthlyDelta"]), !p.is_null())
        ),
        (_, _, Some(sv)) => format!("{} — {}, {}.", s(sv, &["name"]), usd_signed(n(sv, &["monthlyDelta"])), s(sv, &["verdict"])),
        (true, None, None) => "no single change passed the backtest; see the limits below.".to_string(),
        (false, _, None) => "nothing — no fix is needed and no saving passed.".to_string(),
    };
    l.push(format!("- **Do this:** {}{}", one, if one.starts_with("no") || one.starts_with("nothing") { "" } else if app { " Its full backtest is linked below." } else { " Run `verify_change` on it before it ships." }));
    let rr: Vec<String> = arr(r, &["restartRisks"]).iter().map(|x| s(x, &["service"])).collect();
    if !rr.is_empty() {
        l.push(format!("- **Also check:** {}.", restart_said(&rr)));
    }
    let t = g(r, &["trust"]);
    if !t.is_null() {
        let un: Vec<String> = arr(t, &["untrusted"]).iter().map(|x| s(x, &[])).collect();
        let h = g(t, &["heldOutP99"]);
        let held = if h.is_null() {
            if app { " Its predictions were not checked on held-back history.".to_string() } else { " Its predictions were not checked on held-back history (see calibrate_model's warnings).".to_string() }
        } else {
            format!(" On history it was not fitted to, its p99 was off by {}% ({}).", js_num(js_round(n(h, &["error"]) * 100.0)), if g(h, &["pass"]).as_bool().unwrap_or(false) { "inside the 20% tolerance" } else { "outside the 20% tolerance: read every number as directional" })
        };
        let cpu: Vec<String> = arr(t, &["cpuOnly"]).iter().map(|x| s(x, &[])).collect();
        let missing = g(t, &["withoutTraces"]).as_str().map(|w| format!(" {}.", cap(w))).unwrap_or_default();
        l.push(format!(
            "- **Trust:** {} of {} services fit the history well{}{}.{}{}{}",
            js_num(n(t, &["fit"])),
            js_num(n(t, &["services"])),
            if un.is_empty() { String::new() } else { format!("; not explained: {} — numbers that rest on them are guesses", un.join(", ")) },
            // the line without traces names them already
            if cpu.is_empty() || !missing.is_empty() { String::new() } else { format!("; {} from CPU, throttling and memory alone (no latency metric)", cpu.join(", ")) },
            missing,
            held,
            configurations_said(t)
        ));
    }
    l
}

/// "25–409 req/s depending on the window; …" where the sub-windows disagree
fn uncertain(r: &Value) -> Option<String> {
    let st = g(r, &["stability"]);
    if !g(st, &["uncertain"]).as_bool().unwrap_or(false) {
        return None;
    }
    let (lo, hi) = (n(st, &["low"]), n(st, &["high"]));
    let top = if g(st, &["highOpen"]).as_bool().unwrap_or(false) { format!("more than {}", js_num(hi)) } else { js_num(hi) };
    let k = n(st, &["configurations"]);
    let mixes = if k > 1.0 { format!("; the window mixes {} configurations", js_num(k)) } else { String::new() };
    // the headline already says none: the range is what the parts of the history say beside it
    if lo <= 0.0 && g(r, &["headroom", "atAnyLoad"]).is_string() {
        return Some(format!("none on the whole history, as above, but {} req/s on a third of its traffic calibrated alone: what is out of SLO at any load depends on the window{}.", if top.starts_with("more") { top } else { format!("up to {}", top) }, mixes));
    }
    let range = if lo <= 0.0 { format!("from none (a window out of SLO at any load) to {} req/s", top) } else if top.starts_with("more") { format!("from {} to {} req/s", js_num(lo), top) } else { format!("{}–{} req/s", js_num(lo), top) };
    Some(format!("{} depending on the window (the whole history, and each third of its traffic calibrated alone){}.", range, mixes))
}

/// which configuration the fits rest on, where the history holds several
fn configurations_said(t: &Value) -> String {
    let c = g(t, &["configurations"]);
    if c.is_null() {
        return String::new();
    }
    let mixed: Vec<String> = arr(c, &["mixed"]).iter().map(|x| s(x, &[])).collect();
    let older: Vec<String> = arr(c, &["fittedOnOlder"])
        .iter()
        .map(|o| format!("{}, whose latest ({} since {}) has {} h of traffic: fitted on the one with {} h", s(o, &["service"]), arr(o, &["latest", "differs"]).iter().map(|x| s(x, &[])).collect::<Vec<_>>().join(", "), crate::regimes::when(n(o, &["latest", "since"])), js_num(n(o, &["latest", "busyHours"])), js_num(n(o, &["fittedHours"]))))
        .collect();
    format!(
        " The history holds more than one configuration of {}; each is fitted on its latest{}.",
        mixed.join(", "),
        if older.is_empty() { String::new() } else { format!(", except {}", older.join("; ")) }
    )
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

/// The review for the app (the Backtest tab's Review), on the model and history it has open: the same
/// data as review_capacity, plus the summary as (label, sentence) pairs worded for the app, the
/// history's traffic to draw the headroom over, the change behind each fix and saving (so each opens
/// as its full backtest) and the Markdown report.
pub fn for_app(mv: &Value, dv: &Value, draws: f64) -> Result<Value, String> {
    let m: crate::model::Model = serde_json::from_value(mv.clone()).map_err(|e| format!("model: {}", e))?;
    let d: crate::dataset::Dataset = serde_json::from_value(dv.clone()).map_err(|e| format!("dataset: {}", e))?;
    // as calibrate_model calibrates: the model's own SLO and timeout, list prices where there is no bill
    let opts = || -> Result<crate::calibrate::CalibrateOptions, String> {
        Ok(crate::calibrate::CalibrateOptions { slo: Some(m.slo.clone()), timeout_ms: Some(m.timeout_ms).filter(|t| *t != 0.0), list_prices: Some(json!(true)), ..Default::default() })
    };
    let Review { mut out, suggested } = review(mv, &m, dv, &d, None, draws, &opts)?;
    // copied out of the app and passed on to people, not agents: the next step in their words
    let md = review_markdown(&Value::Object(out.clone()))
        .replace(" Run `verify_change` on it before it ships.", " Backtest it before it ships: Hindcast's Backtest tab (+ test a change), or `hindcast verify-change` in CI.")
        .replace("`verify_change` the one you ship for its full evidence.", "backtest the change you ship for its full evidence.");
    let r = Value::Object(out.clone());
    out.insert("summary".into(), json!(summary(&r)));
    // each fix and saving with its change and how far its verdict can be trusted
    for (key, n_max) in [("fixes", 5), ("savings", 8)] {
        let from = arr(&suggested, &[key]);
        if let Some(Value::Array(list)) = out.get_mut(key) {
            for (x, f) in list.iter_mut().zip(from.iter().take(n_max)) {
                x["change"] = g(f, &["change"]).clone();
                x["confidence"] = g(f, &["confidence"]).clone();
                x["verdict"] = g(f, &["verdict"]).clone();
                // a saving's own difference in time out of SLO and failed requests (fixes carry theirs)
                for k in ["minutesOutOfSloDelta", "failedRequestsDelta"] {
                    if x.get(k).is_none() {
                        x[k] = g(f, &[k]).clone();
                    }
                }
                x["summary"] = g(f, &["summary"]).clone();
            }
        }
    }
    if let Some(cs) = out.get_mut("combinedSavings").filter(|x| !x.is_null()) {
        for k in ["change", "minutesOutOfSloDelta", "failedRequestsDelta", "confidence"] {
            cs[k] = g(&suggested, &["combinedSavings", k]).clone();
        }
    }
    // the stuck-caller sensitivity, worded as the report words it: an assumption
    if let Some(sb) = out.get_mut("nodeLoss").and_then(|nl| nl.get_mut("ifCallersStayBroken")).filter(|x| !x.is_null()) {
        sb["said"] = json!(stuck_line(sb));
    }
    if g(&r, &["commitment"]).is_null() {
        out.insert("commitmentAbsent".into(), json!(commitment_absent(mv)));
    }
    // the history open in the app, which may be shorter than the one the model was calibrated on (whose
    // busiest moment history.peakRps is)
    let rps: Vec<f64> = (0..d.n.max(0.0) as usize).map(|i| traffic_at(&d, i)).collect();
    let peak = rps.iter().fold(0.0, |a: f64, x| a.max(*x));
    out.insert("traffic".into(), json!({ "start": num(d.start), "stepS": num(d.step_s), "rps": rps.iter().map(|x| num(*x)).collect::<Vec<_>>(), "peakRps": num(r1(peak)) }));
    out.insert("markdown".into(), json!(md));
    Ok(Value::Object(out))
}

/// why there is no commitment to read: the same conditions commitment() checks, said
fn commitment_absent(mv: &Value) -> String {
    let c = g(mv, &["cluster"]);
    if !c.is_null() {
        return if s(c, &["node", "source"]) == "hint" { "the node price is a placeholder (no instance type was seen), so a discount on it would be too".into() } else { "the history has no node count to find the always-on floor in".into() };
    }
    let svcs = g(mv, &["services"]).as_object().cloned().unwrap_or_default();
    if svcs.values().any(|sv| s(sv, &["cost", "source"]) == "bill") {
        "costs come from the bill, which may already carry discounts — what a commitment saves is read off the bill, not a list price".into()
    } else {
        "no list-priced capacity runs all the time in this history".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uncertain_headroom_agrees_with_the_headline() {
        let st = json!({ "uncertain": true, "low": 0, "high": 512, "highOpen": false, "configurations": 1 });
        // the headline says none to read: the range doesn't say "none" again as if it were news
        let none = json!({ "headroom": { "atAnyLoad": "GET /slow", "rps": 0 }, "stability": st });
        assert_eq!(uncertain(&none).unwrap(), "none on the whole history, as above, but up to 512 req/s on a third of its traffic calibrated alone: what is out of SLO at any load depends on the window.");
        // a headline with a number: the window with none is said as a window
        let some = json!({ "headroom": { "rps": 300, "limitedBy": "api" }, "stability": st });
        assert_eq!(uncertain(&some).unwrap(), "from none (a window out of SLO at any load) to 512 req/s depending on the window (the whole history, and each third of its traffic calibrated alone).");
        let both = json!({ "headroom": { "rps": 300, "limitedBy": "api" }, "stability": { "uncertain": true, "low": 120, "high": 512, "configurations": 2 } });
        assert_eq!(uncertain(&both).unwrap(), "120–512 req/s depending on the window (the whole history, and each third of its traffic calibrated alone); the window mixes 2 configurations.");
    }
}
