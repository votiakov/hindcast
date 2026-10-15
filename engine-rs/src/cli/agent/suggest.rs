//! "What should we change?" (agent/suggest.ts): candidates from the history itself — capacity for the
//! services that ran out of it, cuts for the ones that idled — every one backtested and judged, the
//! savings that pass tried together, and (Kubernetes) the replicas that survive losing a node.

use super::verify::{draws_for, judge, slice_last};
use super::workspace::{seconds, Workspace};
use crate::cli::reports::{arr, g, inf, n, s};
use crate::math::{js_num, js_round};
use serde_json::{json, Map as JMap, Value};

const SATURATED: f64 = 0.85;

fn r1(x: f64) -> f64 {
    js_round(x * 10.0) / 10.0
}
fn r2(x: f64) -> f64 {
    js_round(x * 100.0) / 100.0
}
fn num(x: f64) -> Value {
    serde_json::Number::from_f64(x).map(Value::Number).unwrap_or(Value::Null)
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
fn to_json<T: serde::Serialize>(x: &T) -> Value {
    serde_json::to_value(x).unwrap_or(Value::Null)
}

struct Ctx<'a> {
    mv: &'a Value,
    m: &'a crate::model::Model,
    d: &'a crate::dataset::Dataset,
    cal: Option<&'a Value>,
    gate: f64,
    before: (f64, Option<String>),
    draws: Option<f64>,
    notes: Vec<String>,
    /// the history replayed at another load (launch day), or as it was
    load: Option<crate::backtest::LoadOpts>,
}

fn breaking(m: &crate::model::Model, plan: &crate::types::Plan) -> (f64, Option<String>) {
    let b = crate::accuracy::model_breaking_point(m, Some(plan), None, None, None);
    (b.rps, b.limited_by)
}

fn evaluate(c: &mut Ctx, list: &[Value]) -> Result<Vec<Value>, String> {
    if list.is_empty() {
        return Ok(vec![]);
    }
    let draws = match c.draws {
        Some(d) => d,
        None => {
            let (dr, note) = draws_for(c.m, c.d, list.len() + 1, 12.0, 25_000.0);
            if let Some(nt) = note {
                if !c.notes.contains(&nt) {
                    c.notes.push(nt);
                }
            }
            dr
        }
    };
    let r = crate::backtest::backtest(c.m, c.d, list, &crate::backtest::BacktestOptions { draws: Some(draws), load: c.load.clone(), ..Default::default() })?;
    let mut rv = to_json(&r);
    rv.as_object_mut().unwrap().insert("accuracy".into(), g(c.mv, &["accuracy"]).clone());
    let base = crate::backtest::base_plan(c.m, None);
    let mut out = vec![];
    for (i, st) in arr(&rv, &["strategies"]).iter().enumerate() {
        let applied = crate::strategy::apply_strategy(c.m, &base, &crate::strategy::parse_strategy(&list[i])?)?;
        let j = judge(c.mv, c.m, &rv, st, &list[i], c.cal, c.gate, c.before.clone(), breaking(c.m, &applied.plan), None)?;
        out.push(json!({
            "name": g(&j, &["name"]),
            "change": list[i],
            "verdict": g(&j, &["verdict"]),
            "confidence": g(&j, &["confidence", "level"]),
            "monthlyDelta": g(&j, &["cost", "monthlyDelta", "p50"]),
            "costBasis": g(&j, &["cost", "basis"]),
            "minutesOutOfSloDelta": g(&j, &["reliability", "minutesOutOfSloDelta", "p50"]),
            "failedRequestsDelta": g(&j, &["reliability", "failedRequestsDelta", "p50"]),
            "summary": g(&j, &["summary"]),
            "caveats": arr(&j, &["confidence", "warnings"]).into_iter().take(2).cloned().collect::<Vec<_>>(),
        }));
    }
    Ok(out)
}

pub fn suggest_changes(ws: &Workspace, o: &Value) -> Result<Value, String> {
    let mv = ws.read_json("model.json")?;
    let m: crate::model::Model = serde_json::from_value(mv.clone()).map_err(|e| format!("model: {}", e))?;
    let mut dv = ws.read_json("dataset.json")?;
    if let Some(l) = o.get("last").and_then(|x| x.as_str()) {
        let k = (seconds(l)? / dv["stepS"].as_f64().unwrap_or(1.0)).ceil() as usize;
        if (k as f64) < dv["n"].as_f64().unwrap_or(0.0) {
            dv = slice_last(&dv, k);
        }
    }
    let d: crate::dataset::Dataset = serde_json::from_value(dv.clone()).map_err(|e| format!("dataset: {}", e))?;
    let cal = if ws.has("calibration.json") { Some(ws.read_json("calibration.json")?) } else { None };
    let goal = o.get("goal").and_then(|x| x.as_str()).unwrap_or("both").to_string();
    let idle = o.get("idleBelow").and_then(|x| x.as_f64()).unwrap_or(0.35);
    let load = o.get("traffic").filter(|t| t.get("scale").is_some() || t.get("peakRps").is_some()).map(|t| crate::backtest::LoadOpts { scale: t.get("scale").and_then(|x| x.as_f64()), peak_rps: t.get("peakRps").and_then(|x| x.as_f64()) });
    let as_built = to_json(&crate::backtest::backtest(&m, &d, &[], &crate::backtest::BacktestOptions { draws: Some(1.0), load: load.clone(), ..Default::default() })?.baseline);
    // services the replay OOM-kills at this load
    let oom_killed: Vec<String> = arr(&as_built, &["events"]).iter().filter_map(|e| s(e, &["what"]).split_once(": OOM-killed").map(|(id, _)| id.to_string())).collect();
    let peak = g(&as_built, &["peakUtil"]).as_object().cloned().unwrap_or_default();
    let pk = |id: &str| peak.get(id).and_then(|x| x.as_f64()).unwrap_or(0.0);
    let svc = |id: &str| g(&mv, &["services", id]).clone();

    let mut fixes: Vec<Value> = vec![];
    let mut savings: Vec<Value> = vec![];
    let mut seen: indexmap::IndexSet<String> = indexmap::IndexSet::new();
    let mut add = |list: &mut Vec<Value>, st: Value| {
        let key = crate::convert::js_stringify(&st["changes"]);
        if seen.insert(key) {
            list.push(st);
        }
    };
    let saturated: Vec<(String, f64)> = peak.iter().filter(|(id, u)| u.as_f64().unwrap_or(0.0) >= SATURATED && !svc(id).is_null() && inf(&svc(id), &["capacity", "perReplicaRps"]).is_finite()).map(|(k, u)| (k.clone(), u.as_f64().unwrap_or(0.0))).collect();
    if goal != "cost" {
        for (id, _) in &saturated {
            let sv = svc(id);
            let hosted = s(&sv, &["hostedBy"]);
            let host = if hosted.is_empty() { id.clone() } else { hosted.clone() };
            let h = svc(&host);
            if h.is_null() || s(&h, &["kind"]) == "external" {
                continue;
            }
            let via = if hosted.is_empty() { String::new() } else { format!(" ({} runs inside {})", id, host) };
            let r = js_round(n(&h, &["replicas"])).max(1.0);
            add(&mut fixes, json!({ "name": format!("{}: {} → {} replicas{}", host, js_num(r), js_num(r + 1.0), via), "changes": [{ "service": host, "replicas": num(r + 1.0) }] }));
            if r >= 2.0 {
                add(&mut fixes, json!({ "name": format!("{}: {} → {} replicas{}", host, js_num(r), js_num(r * 2.0), via), "changes": [{ "service": host, "replicas": num(r * 2.0) }] }));
            }
            let cpu_limit = g(&h, &["cpuLimit"]).as_f64().filter(|x| *x != 0.0);
            if s(&sv, &["capacity", "limit"]) == "cpu" {
                if let Some(cl) = cpu_limit {
                    add(&mut fixes, json!({ "name": format!("{}: CPU {} → {} per replica", host, js_num(cl), js_num(r2(cl * 2.0))), "changes": [{ "service": host, "cpu": num(r2(cl * 2.0)) }] }));
                    let mx = (r * 3.0).max(r + 2.0);
                    add(&mut fixes, json!({ "name": format!("{}: autoscale {}–{} on 60% CPU", host, js_num(r), js_num(mx)), "changes": [{ "service": host, "autoscale": { "min": num(r), "max": num(mx), "targetCpu": 0.6 } }] }));
                }
            }
        }
    }
    if goal != "reliability" {
        for (id, sv) in g(&mv, &["services"]).as_object().cloned().unwrap_or_default() {
            if truthy(g(&sv, &["hostedBy"])) || s(&sv, &["kind"]) == "external" || n(&sv, &["cost", "perReplicaHour"]) <= 0.0 || s(&sv, &["fit", "status"]) == "cost-only" {
                continue;
            }
            let inside: Vec<f64> = g(&mv, &["services"]).as_object().map(|all| all.values().filter(|x| s(x, &["hostedBy"]) == id).map(|x| pk(&s(x, &["id"]))).collect()).unwrap_or_default();
            let busiest = inside.iter().fold(pk(&id), |a, b| a.max(*b));
            if busiest >= idle {
                continue;
            }
            let r = js_round(n(&sv, &["replicas"])).max(1.0);
            if r >= 2.0 {
                add(&mut savings, json!({ "name": format!("{}: {} → {} replicas", id, js_num(r), js_num(r - 1.0)), "changes": [{ "service": id, "replicas": num(r - 1.0) }] }));
            }
            if let Some(cl) = g(&sv, &["cpuLimit"]).as_f64().filter(|x| *x != 0.0) {
                if cl >= 0.5 && s(&sv, &["capacity", "limit"]) != "concurrency" {
                    add(&mut savings, json!({ "name": format!("{}: CPU {} → {} per replica", id, js_num(cl), js_num(r2(cl / 2.0))), "changes": [{ "service": id, "cpu": num(r2(cl / 2.0)) }] }));
                }
            }
            if s(&sv, &["cost", "arch"]) != "arm" {
                add(&mut savings, json!({ "name": format!("{} on Graviton", id), "changes": [{ "service": id, "arch": "arm" }] }));
            }
        }
    }
    // memory: limits far above the working set are paid for and never used; limits the working set
    // came close to are an OOM kill waiting for a busier day
    let mib = |gb: f64| js_round(gb * 1024.0);
    for (id, sv) in g(&mv, &["services"]).as_object().cloned().unwrap_or_default() {
        let mem = g(&sv, &["memory"]);
        let limit = g(mem, &["limit"]).as_f64().filter(|x| *x != 0.0);
        let mp = n(mem, &["peak"]);
        if truthy(g(&sv, &["hostedBy"])) || limit.is_none() || !(mp > 0.0) {
            continue;
        }
        let limit = limit.unwrap();
        if goal != "reliability" && mp / limit < 0.5 && n(&sv, &["cost", "perReplicaHour"]) > 0.0 {
            let to = (((mp + n(mem, &["spike"])) * 1.3 * 1024.0) / 64.0).ceil() * 64.0;
            if to < mib(limit) {
                add(&mut savings, json!({ "name": format!("{}: memory {} → {} MiB per replica (peak {} MiB)", id, js_num(mib(limit)), js_num(to), js_num(mib(mp))), "changes": [{ "service": id, "memoryGb": num(to / 1024.0) }] }));
            }
        }
        let leak = n(mem, &["leak"]);
        if goal != "cost" && leak > 0.0 && oom_killed.contains(&id) {
            // a leak only waits: more memory moves the kill later, by what the extra holds
            let to = ((limit * 2.0 * 1024.0) / 64.0).ceil() * 64.0;
            let reqs = js_round(((to / 1024.0 - n(mem, &["base"]) - n(mem, &["spike"])) / leak).max(0.0));
            add(&mut fixes, json!({ "name": format!("{}: memory {} → {} MiB per replica (it leaks: OOM-killed at this load; the kill moves to ~{} requests per container)", id, js_num(mib(limit)), js_num(to), crate::math::js_locale(reqs)), "changes": [{ "service": id, "memoryGb": num(to / 1024.0) }] }));
            let r = js_round(n(&sv, &["replicas"])).max(1.0);
            add(&mut fixes, json!({ "name": format!("{}: {} → {} replicas (it leaks: each container serves half the requests, so it takes twice as long to reach its limit)", id, js_num(r), js_num(r * 2.0)), "changes": [{ "service": id, "replicas": num(r * 2.0) }] }));
        } else if goal != "cost" && mp / limit >= 0.9 {
            let to = ((mp * 1.5 * 1024.0) / 64.0).ceil() * 64.0;
            add(&mut fixes, json!({ "name": format!("{}: memory {} → {} MiB per replica (the history peaked at {}% of the limit)", id, js_num(mib(limit)), js_num(to), js_num(js_round((mp / limit) * 100.0))), "changes": [{ "service": id, "memoryGb": num(to / 1024.0) }] }));
        }
    }

    let gate = o.get("gateMinutes").and_then(|x| x.as_f64()).unwrap_or(0.5);
    let base = crate::backtest::base_plan(&m, None);
    let before = breaking(&m, &base);
    let mut c = Ctx { mv: &mv, m: &m, d: &d, cal: cal.as_ref(), gate, before, draws: o.get("draws").and_then(|x| x.as_f64()), notes: vec![], load: load.clone() };
    if let Some(l) = &load {
        c.notes.push(format!("every candidate is judged on the history replayed at {}", match (l.scale, l.peak_rps) { (Some(x), _) => format!("{}× its load", js_num(x)), (_, Some(p)) => format!("a busiest moment of {} req/s", js_num(p)), _ => "its own load".into() }));
    }
    if savings.iter().any(|x| arr(x, &["changes"]).iter().any(|ch| ch.get("memoryGb").map(|v| !v.is_null()).unwrap_or(false))) {
        c.notes.push("memory cuts are judged on the working set the history showed: a heap sized to the old limit (JVM -Xmx or MaxRAMPercentage, GOMEMLIMIT, Node --max-old-space-size) can grow into the new one — set it below the new limit with the change".into());
    }
    super::progress(&format!("backtesting {} fixes", fixes.len()), 0.0, 3.0);
    let fix_results = evaluate(&mut c, &fixes)?;
    super::progress(&format!("backtesting {} savings", savings.len()), 1.0, 3.0);
    let save_results = evaluate(&mut c, &savings)?;
    super::progress("trying the safe savings together", 2.0, 3.0);

    // the savings that pass, together
    let mut safe: Vec<&Value> = save_results.iter().filter(|x| s(x, &["verdict"]) == "pass" && n(x, &["monthlyDelta"]) < 0.0).collect();
    let mut combined: Option<Value> = None;
    if safe.len() >= 2 {
        let mut by_service: indexmap::IndexMap<String, JMap<String, Value>> = indexmap::IndexMap::new();
        let mut sorted = safe.clone();
        sorted.sort_by(|a, b| n(a, &["monthlyDelta"]).partial_cmp(&n(b, &["monthlyDelta"])).unwrap_or(std::cmp::Ordering::Equal));
        for x in sorted {
            for ch in arr(x, &["change", "changes"]) {
                let key = crate::cli::agent::sources_str(ch.get("service"));
                let cur = by_service.entry(key.clone()).or_insert_with(|| {
                    let mut m = JMap::new();
                    m.insert("service".into(), ch.get("service").cloned().unwrap_or(Value::Null));
                    m
                });
                if let Some(o) = ch.as_object() {
                    for (k, v) in o {
                        if k != "service" && !cur.contains_key(k) {
                            cur.insert(k.clone(), v.clone());
                        }
                    }
                }
            }
        }
        let all = json!({ "name": format!("All safe savings together ({})", safe.len()), "changes": by_service.into_values().map(Value::Object).collect::<Vec<_>>() });
        combined = evaluate(&mut c, &[all])?.into_iter().next();
    }
    safe.sort_by(|a, b| n(a, &["monthlyDelta"]).partial_cmp(&n(b, &["monthlyDelta"])).unwrap_or(std::cmp::Ordering::Equal));

    // ---- losing a node (Kubernetes)
    let mut resilience: Option<Value> = None;
    let has_pods = g(&mv, &["services"]).as_object().map(|x| x.values().any(|s| truthy(g(s, &["pods"])))).unwrap_or(false);
    if goal != "cost" && has_pods {
        super::progress("losing each node at the busiest moment", 2.0, 3.0);
        let now = to_json(&crate::resilience::node_loss(&m, &d, &crate::resilience::NodeLossOptions { draws: Some(6.0), ..Default::default() })?);
        let spof: Vec<Value> = arr(&now, &["singlePointsOfFailure"]).iter().map(|x| g(x, &["service"]).clone()).collect();
        if !g(&now, &["survives"]).as_bool().unwrap_or(false) {
            let failing: Vec<&Value> = arr(&now, &["results"]).into_iter().filter(|x| s(x, &["verdict"]) == "fails").collect();
            let mut changes: indexmap::IndexMap<String, Value> = indexmap::IndexMap::new();
            let mut on_path: indexmap::IndexSet<String> = indexmap::IndexSet::new();
            for e in g(&mv, &["endpoints"]).as_object().map(|x| x.values().cloned().collect::<Vec<_>>()).unwrap_or_default() {
                if let Some(v) = e.get("visits").and_then(|v| v.as_object()) {
                    for (k, x) in v {
                        if x.as_f64().unwrap_or(0.0) > 0.0 {
                            on_path.insert(k.clone());
                        }
                    }
                }
            }
            for id in on_path.clone() {
                let h = s(&svc(&id), &["hostedBy"]);
                if !h.is_empty() {
                    on_path.insert(h);
                }
            }
            let nodes = n(&now, &["nodes"]);
            for x in &failing {
                for l in arr(x, &["lost"]) {
                    let ls = s(l, &["service"]);
                    let sv = svc(&ls);
                    if sv.is_null() || (s(&sv, &["kind"]) == "external" && !truthy(g(&sv, &["pods"]))) || !on_path.contains(&ls) || changes.contains_key(&ls) {
                        continue;
                    }
                    let k = inf(&sv, &["capacity", "perReplicaRps"]);
                    let of = n(l, &["of"]);
                    let down = g(l, &["down"]).as_bool().unwrap_or(false);
                    let peak_rps = pk(&ls) * (if k.is_finite() { k } else { 0.0 }) * of;
                    let need = if k.is_finite() && k > 0.0 { (peak_rps / (k * 0.85)).ceil().max(1.0) } else { 1.0 };
                    let mut r = (if down { 2.0 } else { of }).max(2.0);
                    while r - (r / nodes).ceil() < need && r < 64.0 {
                        r += 1.0;
                    }
                    let crowded = n(l, &["pods"]) > (of / nodes).ceil();
                    let hpa = g(&sv, &["hpa"]);
                    if !hpa.is_null() && (down || r != of || crowded) {
                        let mut a = JMap::new();
                        a.insert("min".into(), num(r.max(n(hpa, &["min"]))));
                        a.insert("max".into(), num(n(hpa, &["max"]).max(r)));
                        if truthy(g(hpa, &["targetCpu"])) {
                            a.insert("targetCpu".into(), g(hpa, &["targetCpu"]).clone());
                        }
                        changes.insert(ls.clone(), json!({ "service": ls, "autoscale": Value::Object(a), "spread": "even" }));
                    } else if down || r != of || crowded {
                        let mut ch = JMap::new();
                        ch.insert("service".into(), json!(ls));
                        if r != of {
                            ch.insert("replicas".into(), num(r));
                        }
                        ch.insert("spread".into(), json!("even"));
                        changes.insert(ls.clone(), Value::Object(ch));
                    }
                }
            }
            let fix = json!({ "name": "Survive a node failure", "description": format!("replicas for what one node takes down, spread evenly over the {} nodes", js_num(nodes)), "changes": changes.values().cloned().collect::<Vec<_>>() });
            let after = if changes.is_empty() { None } else { Some(to_json(&crate::resilience::node_loss(&m, &d, &crate::resilience::NodeLossOptions { draws: Some(6.0), strategy: Some(fix.clone()), ..Default::default() })?)) };
            let cost = if changes.is_empty() { 0.0 } else { to_json(&crate::backtest::backtest(&m, &d, &[fix.clone()], &crate::backtest::BacktestOptions { draws: Some(1.0), ..Default::default() })?).pointer("/strategies/0/delta/monthly/p50").and_then(|x| x.as_f64()).unwrap_or(0.0) };
            let f0 = failing[0];
            let mut notes = vec![json!("spread: even is topologySpreadConstraints on kubernetes.io/hostname with maxSkew 1 (or a preferred podAntiAffinity)")];
            for id in changes.keys() {
                if matches!(s(&svc(id), &["kind"]).as_str(), "db" | "cache" | "queue") {
                    notes.push(json!(format!("{} holds data: a second replica only survives a node with replication (a primary and a replica, or a cluster mode) — the replay treats its replicas as interchangeable", id)));
                }
            }
            resilience = Some(json!({
                "asBuilt": { "survives": false, "worst": { "node": g(f0, &["node"]), "minutesOutOfSlo": g(f0, &["minutesOutOfSlo"]), "failedRequests": g(f0, &["failedRequests"]), "down": arr(f0, &["lost"]).iter().filter(|l| g(l, &["down"]).as_bool().unwrap_or(false)).map(|l| g(l, &["service"]).clone()).collect::<Vec<_>>() } },
                "singlePointsOfFailure": spof,
                "fix": match &after {
                    Some(a) => {
                        let r0 = arr(a, &["results"]).first().cloned().cloned();
                        json!({ "change": fix, "survives": g(a, &["survives"]), "worstAfter": r0.map(|r| json!({ "node": g(&r, &["node"]), "minutesOutOfSlo": g(&r, &["minutesOutOfSlo"]), "verdict": g(&r, &["verdict"]), "worst": g(&r, &["worst"]) })).unwrap_or(Value::Null), "monthlyDelta": num(r2(cost)) })
                    }
                    None => Value::Null,
                },
                "notes": notes,
            }));
        } else {
            resilience = Some(json!({ "asBuilt": { "survives": true }, "singlePointsOfFailure": spof }));
        }
    }

    let minutes = n(&as_built, &["summary", "minutesOutOfSlo", "p50"]);
    let failed_base = n(&as_built, &["summary", "failedRequests", "p50"]);
    let helps = |f: &Value| n(f, &["minutesOutOfSloDelta"]) < -0.5 || (failed_base > 0.0 && n(f, &["failedRequestsDelta"]) < -0.1 * failed_base);
    let mut helpful: Vec<Value> = fix_results.iter().filter(|f| helps(f)).cloned().collect();
    helpful.sort_by(|a, b| {
        let k = |x: &Value| (n(x, &["minutesOutOfSloDelta"]), n(x, &["failedRequestsDelta"]), n(x, &["monthlyDelta"]));
        let (x, y) = (k(a), k(b));
        (x.0 - y.0).partial_cmp(&0.0).unwrap().then((x.1 - y.1).partial_cmp(&0.0).unwrap()).then((x.2 - y.2).partial_cmp(&0.0).unwrap())
    });
    let mut passing: Vec<Value> = save_results.iter().filter(|x| s(x, &["verdict"]) == "pass" && n(x, &["monthlyDelta"]) < 0.0).cloned().collect();
    passing.sort_by(|a, b| n(a, &["monthlyDelta"]).partial_cmp(&n(b, &["monthlyDelta"])).unwrap_or(std::cmp::Ordering::Equal));
    let mut rejected: Vec<Value> = vec![];
    for f in &fix_results {
        if !helpful.contains(f) {
            rejected.push(json!({ "name": g(f, &["name"]), "verdict": g(f, &["verdict"]), "summary": g(f, &["summary"]) }));
        }
    }
    for x in &save_results {
        if !(s(x, &["verdict"]) == "pass" && n(x, &["monthlyDelta"]) < 0.0) {
            rejected.push(json!({ "name": g(x, &["name"]), "verdict": g(x, &["verdict"]), "summary": g(x, &["summary"]) }));
        }
    }
    let mut notes: Vec<Value> = c.notes.iter().map(|x| json!(x)).collect();
    if minutes < 0.5 && goal != "cost" {
        notes.push(json!("the system stayed within its SLO over this history: there was nothing to fix"));
    }
    if saturated.is_empty() && goal != "cost" {
        notes.push(json!("no service came near its capacity in this history"));
    }
    notes.push(json!("candidates are generated from the history (saturated services get capacity, idle ones get cuts); verify_change anything else you have in mind"));
    let mut out = JMap::new();
    out.insert("asBuilt".into(), json!({ "minutesOutOfSlo": num(r1(minutes)), "monthly": num(r2(n(&as_built, &["summary", "monthly", "p50"]))), "failedRequests": num(js_round(failed_base)) }));
    out.insert("saturated".into(), json!(saturated.iter().map(|(id, u)| json!({ "service": id, "historyPeakUtil": num(r2(*u)), "limit": g(&svc(id), &["capacity", "limit"]), "hostedBy": match g(&svc(id), &["hostedBy"]) { Value::Null => Value::Null, x => x.clone() } })).collect::<Vec<_>>()));
    out.insert("fixes".into(), json!(helpful));
    out.insert("savings".into(), json!(passing));
    out.insert("combinedSavings".into(), combined.unwrap_or(Value::Null));
    if let Some(r) = resilience {
        out.insert("nodeLoss".into(), r);
    }
    out.insert("rejected".into(), json!(rejected));
    out.insert("notes".into(), json!(notes));
    out.insert("next".into(), json!("verify_change the one you would ship, for its full evidence and the app link"));
    Ok(Value::Object(out))
}
