//! A change judged on its backtest (agent/verify.ts): the verdict an agent acts on, how far to trust it
//! and why, and the one-line headline a backtest is read by.

use super::json::{arr, g, inf, iso, n, num, r1, r2, s, to_json, truthy, when_utc as when};
use crate::math::{js_locale, js_num, js_round, js_to_fixed};
use serde_json::{json, Map as JMap, Value};

fn pct(x: f64) -> String {
    format!("{}%", js_num(js_round(x * 100.0)))
}
fn money(x: f64) -> String {
    format!("{}${}", if x < 0.0 { "−" } else { "+" }, js_to_fixed(x.abs(), if x.abs() < 100.0 { 2 } else { 0 }))
}
fn range(x: &Value, f: &dyn Fn(f64) -> f64) -> Value {
    json!({ "p50": num(f(n(x, &["p50"]))), "lo": num(f(n(x, &["lo"]))), "hi": num(f(n(x, &["hi"]))) })
}

/// the share of capacity at which the history counts as having reached a service's limit
pub const LIMIT_SEEN: f64 = 0.85;

/// The accuracy checks a verdict rests on are p99 and the breaking point: minutes out of SLO are
/// counted from the replay's latency, and where it crosses the SLO from the capacity behind the
/// breaking point (cost is stated beside the verdict, not in it; failed requests are informational).
/// A miss on one of them beyond this, on data the model never saw, leaves confidence low: off by more
/// than half (two and a half times the p99 target of 20%, over three times the breaking point's 15%)
/// the replay can't be trusted to say where the SLO is crossed. A smaller miss leaves it medium
pub const LARGE_MISS: f64 = 0.5;
/// …and for latency, only where the miss is large against the SLO too: a typical miss (the error times
/// the measured p99) of at least this share of the SLO's p99 can move a bucket across it. A model off
/// by 58% on 9 ms latencies under a 500 ms SLO misses by 5 ms, which no minute out of SLO turns on
pub const MISS_OF_SLO: f64 = 0.1;

/// an accuracy check that leaves confidence low (LARGE_MISS), read against an SLO of `slo_p99_ms`
pub fn large_miss(c: &Value, slo_p99_ms: f64) -> bool {
    let e = n(c, &["error"]);
    match s(c, &["metric"]).as_str() {
        "breaking-point" => e > LARGE_MISS,
        "p99" => e > LARGE_MISS && !(e * n(c, &["measured"]) < MISS_OF_SLO * slo_p99_ms),
        _ => false,
    }
}

/// a change also fails when the requests it fails beyond the as-built replay exceed this share of the
/// SLO's error budget over the replayed window (its requests × the SLO's error rate). At 1 the change
/// alone spends the whole budget: a burn rate of 1, which by itself exhausts the budget over any
/// period that looks like this window. The minutes can't see it on a day already out of SLO at its
/// peak (no minute there can be added), but the requests that fail inside those minutes still count
/// against the SLO. check_node_loss gates the same way, on the budget over the outage
pub const BUDGET_GATE: f64 = 1.0;

/// the SLO's error budget over a backtest's replayed window, in requests (NaN without a request count)
pub fn window_budget(r: &Value) -> f64 {
    let b = n(r, &["baseline", "summary", "requests", "p50"]) * n(r, &["slo", "errorRate"]);
    if b.is_finite() {
        b.max(1.0)
    } else {
        f64::NAN
    }
}

/// the gate a change is judged on, in words
pub fn gate_words(gate: f64, r: &Value) -> String {
    let b = window_budget(r);
    if !b.is_finite() {
        return format!("fails if it adds more than {} min out of SLO over the window", js_num(gate));
    }
    format!("fails if it adds more than {} min out of SLO over the window, or more failed requests than the SLO's error budget over it ({})", js_num(gate), budget_words(r, b * BUDGET_GATE))
}

/// the budget a change's failed requests are held to, e.g. "1% of 2,103,000 requests: 21,030"
fn budget_words(r: &Value, allowed: f64) -> String {
    format!("{}% of {} requests: {}", js_num(r2(n(r, &["slo", "errorRate"]) * 100.0)), js_locale(js_round(n(r, &["baseline", "summary", "requests", "p50"]))), js_locale(js_round(allowed)))
}

/// one-sentence verdict, e.g. "saves $410/month; on Sep 14 at 12:03 UTC it would have caused 9 minutes out of SLO (…)"
pub fn headline(st: &Value, base: &Value) -> String {
    let dm = n(st, &["delta", "monthly", "p50"]);
    let m = if dm.abs() < 1.0 {
        "costs the same".to_string()
    } else if dm < 0.0 {
        format!("saves ${}/month", js_locale(js_round(-dm)))
    } else {
        format!("costs ${}/month more", js_locale(js_round(dm)))
    };
    let base_inc = arr(base, &["incidents"]);
    let new_inc: Vec<&Value> = arr(st, &["incidents"]).into_iter().filter(|i| !base_inc.iter().any(|b| n(b, &["start"]) < n(i, &["end"]) && n(i, &["start"]) < n(b, &["end"]))).collect();
    if !new_inc.is_empty() {
        let mut w = new_inc[0];
        for i in &new_inc[1..] {
            let c = n(i, &["minutes"]) - n(w, &["minutes"]);
            if c > 0.0 || (c == 0.0 && n(i, &["peakP99Ms"]) > n(w, &["peakP99Ms"])) {
                w = i;
            }
        }
        let wm = n(w, &["minutes"]);
        let total = crate::backtest::js_max(wm, std::iter::once(n(st, &["delta", "minutesOutOfSlo", "p50"])));
        let mn = |x: f64| {
            let k = js_round(x).max(1.0);
            format!("{} minute{}", js_num(k), if k == 1.0 { "" } else { "s" })
        };
        if total < wm + 0.5 {
            return format!("{}; on {} it would have caused {} out of SLO ({})", m, when(n(w, &["start"])), mn(wm), s(w, &["why"]));
        }
        return format!("{}; it would have caused {} out of SLO, the longest new incident starting {} ({})", m, mn(total), when(n(w, &["start"])), s(w, &["why"]));
    }
    let ds = n(st, &["delta", "minutesOutOfSlo", "p50"]);
    let failed = failed_change(st, base);
    if ds < -0.5 {
        let k = js_round(-ds);
        return format!("{} and removes {} minute{} out of SLO from the history{}", m, js_num(k), if k == 1.0 { "" } else { "s" }, failed.map(|f| format!(", with {}", f)).unwrap_or_default());
    }
    if ds > 0.5 {
        let k = js_round(ds);
        return format!("{} and adds {} minute{} out of SLO{}", m, js_num(k), if k == 1.0 { "" } else { "s" }, failed.map(|f| format!(", with {}", f)).unwrap_or_default());
    }
    match failed {
        // the minutes out of SLO can stay put while far fewer (or more) requests fail inside them
        Some(f) => format!("{}, with no change in time out of SLO but {}", m, f),
        None => format!("{}, with no change in time out of SLO", m),
    }
}

/// a change in failed requests worth a word in the headline: at least 100 and a tenth of what failed
/// as built, e.g. "12,400 fewer failed requests (38% fewer)"
fn failed_change(st: &Value, base: &Value) -> Option<String> {
    let d = js_round(n(st, &["delta", "failedRequests", "p50"]));
    let was = n(base, &["summary", "failedRequests", "p50"]);
    if d.abs() < 100.0 || d.abs() < 0.1 * was {
        return None;
    }
    let word = if d < 0.0 { "fewer" } else { "more" };
    let pct = js_round(d.abs() / was * 100.0);
    let share = if was < 1.0 {
        String::new()
    } else if d < 0.0 && d.abs() >= was - 0.5 {
        " (all of them)".to_string()
    } else if d < 0.0 && pct >= 100.0 {
        " (over 99% fewer)".to_string()
    } else if d > 0.0 && pct >= 1000.0 {
        // past 10× a percentage reads as noise: say what failed as built instead
        format!(" (from {} as built)", js_locale(js_round(was)))
    } else {
        format!(" ({}% {})", js_num(pct), word)
    };
    Some(format!("{} {} failed requests{}", js_locale(d.abs()), word, share))
}

/// capacity draws that fit a time budget: one replay of the history timed
/// (in wasm there is no clock to time it with: the draws asked for)
#[cfg(target_arch = "wasm32")]
pub fn draws_for(_m: &crate::model::Model, _d: &crate::dataset::Dataset, _plans: usize, requested: f64, _budget_ms: f64) -> (f64, Option<String>) {
    (requested, None)
}
#[cfg(not(target_arch = "wasm32"))]
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

/// the load a plan sustains once its pods are warm: a change's restart (pods starting cold) is said apart
pub fn breaking(m: &crate::model::Model, plan: &crate::types::Plan) -> (f64, Option<String>) {
    let mut warm = plan.clone();
    for s in warm.services.values_mut() {
        s.restart = false;
    }
    let b = crate::accuracy::model_breaking_point(m, Some(&warm), None, None, None);
    (b.rps, b.limited_by)
}

/// the load a change sustains from the moment it rolls out, its restarted pods still cold (None: it
/// restarts nothing that starts cold)
fn breaking_cold(m: &crate::model::Model, spec: &Value) -> Option<f64> {
    let mut plan = crate::strategy::apply_strategy(m, &crate::backtest::base_plan(m, None), &crate::strategy::parse_strategy(spec).ok()?).ok()?.plan;
    if !plan.services.values().any(|s| s.restart && s.warmup.is_some()) {
        return None;
    }
    // held cold: the ramp to the breaking point must not warm them on its way up
    for s in plan.services.values_mut() {
        if let (true, Some(w)) = (s.restart, s.warmup.as_mut()) {
            w.core_s = f64::INFINITY;
        }
    }
    Some(crate::accuracy::model_breaking_point(m, Some(&plan), None, None, None).rps)
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
                let mut x = json!({ "service": id, "touched": t, "fit": s(&sv, &["fit", "status"]), "historyPeakUtil": num(r2(hp)), "predictedPeakUtil": num(r2(pp)), "basis": basis });
                // no latency metric: a known, labelled basis, not a fit that failed
                if g(&sv, &["capacity", "cpuAlone"]).as_bool().unwrap_or(false) {
                    x["cpuOnly"] = json!(true);
                }
                services.push((x, relevant));
            }
        }
    }
    let services: Vec<Value> = services.into_iter().map(|x| x.0).collect();
    let mut warnings: Vec<String> = vec![];
    let mut level = "high";
    // the first warning that took it to low, the one a low-confidence pass is explained by
    let mut low_why: Option<String> = None;
    let lower = |to: &'static str, why: String, warnings: &mut Vec<String>, level: &mut &'static str, low_why: &mut Option<String>| {
        if to == "low" && low_why.is_none() {
            *low_why = Some(why.clone());
        }
        warnings.push(why);
        if to == "low" || *level == "high" {
            *level = to;
        }
    };
    // why a service with no latency metric holds confidence where it does, said in the reasons too
    let mut cpu_said: Vec<(&'static str, String)> = vec![];
    for x in &services {
        let (pu, hpu) = (n(x, &["predictedPeakUtil"]), n(x, &["historyPeakUtil"]));
        let fit = s(x, &["fit"]);
        let touched_x = g(x, &["touched"]).as_bool().unwrap_or(false);
        let svc = s(x, &["service"]);
        let harder = pu > hpu.max(0.3) * 1.1;
        let poor = fit == "poor" || fit == "unexplained";
        let basis = s(x, &["basis"]);
        if g(x, &["cpuOnly"]).as_bool().unwrap_or(false) {
            // capacity from CPU alone: medium at most, low once the change runs it past the history's
            // peak, where CPU per request is extrapolated (10% over the peak allowed as noise)
            let (to, why) = if pu > hpu * 1.1 {
                ("low", format!("{} has no latency metric, so its capacity is read from CPU alone, and this change runs it at {} of that capacity, past the history's peak of {}: CPU per request there is extrapolated", svc, pct(pu), pct(hpu)))
            } else {
                ("medium", format!("{} has no latency metric, so its capacity is read from CPU alone: its CPU limit is known, but not how its latency grows near it (the change keeps it at {} of capacity, within the history's {})", svc, pct(pu), pct(hpu)))
            };
            lower(to, why.clone(), &mut warnings, &mut level, &mut low_why);
            cpu_said.push((to, why));
        } else if poor && (touched_x || harder) {
            lower("low", format!("{}: the model fits it {}, and this change {}", svc, if fit == "poor" { "poorly" } else { "not at all" }, if touched_x { "changes it" } else { "pushes it harder than the history did" }), &mut warnings, &mut level, &mut low_why);
        } else if poor && pu > 0.6 {
            lower("medium", format!("{} fits {} and runs near its limit; the change leaves it as it was, so the comparison holds better than the absolute numbers", svc, if fit == "poor" { "poorly" } else { "not at all" }), &mut warnings, &mut level, &mut low_why);
        } else if basis == "beyond anything the history showed" && pu >= 0.8 {
            lower("low", format!("{} would run at {} of a capacity the history never tested (peak {}): the outcome rests on an extrapolated limit", svc, pct(pu), pct(hpu)), &mut warnings, &mut level, &mut low_why);
        } else if basis == "beyond anything the history showed" {
            lower("medium", format!("{} would run at {} of capacity, past the history's {}: its capacity there is extrapolated", svc, pct(pu), pct(hpu)), &mut warnings, &mut level, &mut low_why);
        } else if fit == "fair" && touched_x {
            lower("medium", format!("{}: fair fit (latency reproduced within 30%)", svc), &mut warnings, &mut level, &mut low_why);
        }
    }
    let missed: Vec<(&Value, String)> = arr(mv, &["accuracy"]).iter().flat_map(|a| arr(a, &["checks"]).into_iter().map(move |c| (c, s(a, &["method"])))).filter(|(c, _)| !g(c, &["pass"]).as_bool().unwrap_or(false) && s(c, &["metric"]) != "errors").collect();
    let said = |x: &[&(&Value, String)]| x.iter().map(|(c, me)| format!("{} ({}, off by {})", s(c, &["metric"]), me, pct(n(c, &["error"])))).collect::<Vec<_>>().join(", ");
    let (large, small): (Vec<_>, Vec<_>) = missed.iter().partition(|(c, _)| large_miss(c, n(r, &["slo", "p99Ms"])));
    if !large.is_empty() {
        lower("low", format!("the model missed {} on data it never saw: off by more than half on what the verdict is counted from (latency, the breaking point), so a replay can't be trusted to place the SLO's edge", said(&large)), &mut warnings, &mut level, &mut low_why);
    }
    if !small.is_empty() {
        lower("medium", format!("the model missed {} on data it never saw", said(&small)), &mut warnings, &mut level, &mut low_why);
    }
    if arr(mv, &["accuracy"]).is_empty() {
        lower("medium", "the model's accuracy was never measured".into(), &mut warnings, &mut level, &mut low_why);
    }
    let hours = (n(r, &["window", "end"]) - n(r, &["window", "start"])) / 3600.0;
    if hours < 24.0 {
        lower("medium", format!("only {} h of history: daily and weekly peaks may be missing", js_num(r1(hours))), &mut warnings, &mut level, &mut low_why);
    }
    // notes on the cost: warnings that don't lower confidence
    let mut cost_notes: Vec<String> = vec![];
    if cost_basis.contains("none") && n(st, &["delta", "monthly", "p50"]).abs() < 0.005 {
        cost_notes.push("the changed services have no price (no bill, no CPU limit): the cost delta reads $0".into());
    }
    if cost_basis.contains("pricing") {
        cost_notes.push("costs are AWS Fargate list prices, not your bill: discounts and Savings Plans are not in them".into());
    }
    warnings.extend(cost_notes.iter().cloned());
    // ---- verdict
    let (p50, lo, hi) = (n(dm, &["p50"]), n(dm, &["lo"]), n(dm, &["hi"]));
    // the requests it fails beyond as built, against the error budget over the window
    let allowed = window_budget(r) * BUDGET_GATE;
    let (fd, fd_hi) = (n(st, &["delta", "failedRequests", "p50"]), n(st, &["delta", "failedRequests", "hi"]));
    let fails = p50 > gate || fd > allowed;
    let doubt = hi > gate || fd_hi > allowed;
    let mut verdict = if fails { "fail" } else if doubt || level == "low" { "inconclusive" } else { "pass" };
    let base = g(r, &["baseline"]);
    let mut reasons: Vec<String> = vec![headline(st, base)];
    if p50 > gate {
        reasons.push(format!("adds {} min out of SLO (10–90%: {} … {})", js_num(r1(p50)), js_num(r1(lo)), js_num(r1(hi))));
    } else if hi > gate {
        reasons.push(format!("no added time out of SLO at the median, but {} min in the worst 10% of capacity draws", js_num(r1(hi))));
    }
    let fb = n(base, &["summary", "failedRequests", "p50"]);
    if fd > allowed {
        reasons.push(format!(
            "fails {} more requests than as built{}, more than the SLO's error budget over the whole window ({}){}",
            js_locale(js_round(fd)),
            if fb >= 1.0 { format!(" (+{}% of {})", js_num(js_round(fd / fb * 100.0)), js_locale(js_round(fb))) } else { String::new() },
            budget_words(r, allowed),
            if p50 > gate {
                String::new()
            } else if p50 < 0.05 {
                ": it fails on them even though it adds no time out of SLO, because the window was already out of SLO where they fail".to_string()
            } else {
                format!(": it fails on them even though it adds only {} min out of SLO, because the window was already out of SLO where they fail", js_num(r1(p50)))
            }
        ));
    } else if fd_hi > allowed && !fails {
        reasons.push(format!("fails no more requests than the error budget allows at the median, but {} more in the worst 10% of capacity draws, past the window's budget ({})", js_locale(js_round(fd_hi)), budget_words(r, allowed)));
    }
    if verdict == "inconclusive" && level == "low" && !doubt {
        reasons.push(format!("the backtest passes, but confidence is low ({}) — load-test before trusting it", low_why.clone().or_else(|| warnings.first().cloned()).unwrap_or_else(|| "undefined".into())));
    }
    for (to, why) in &cpu_said {
        if !reasons.iter().any(|r| r.contains(why.as_str())) {
            reasons.push(format!("confidence {}: {}", if *to == "low" { "low" } else { "medium at most" }, why));
        }
    }
    for (why, assumed) in warmup_reasons(mv, st, spec) {
        reasons.push(why.clone());
        if let Some(a) = assumed {
            lower("medium", a, &mut warnings, &mut level, &mut low_why);
        }
    }
    if fb > 0.0 && fd.abs() > 0.1 * fb && !(fd > allowed) {
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
    // the replay rolls the change out at its first moment; at a busier one the restarted pods meet it cold.
    // Kept as a reason to withhold a pass, not only a warning: tried as a warning (2026-10-17), it turned
    // one hedge right and one into a wrong pass, on a rollout that met load (PetClinic normal-cust125)
    if let Some(cold) = breaking_cold(m, spec).filter(|c| *c < after.0 * 0.9) {
        if cold < peak && verdict == "pass" {
            verdict = "inconclusive";
            reasons.push(format!("while its restarted pods are still cold the system sustains {} req/s, below the peak it has to serve ({}): rolled out at a busy moment, it would not warm up. Roll it out when traffic is low, or warm the pods before they take traffic", js_num(r1(cold)), js_num(r1(peak))));
        } else {
            reasons.push(format!("while its restarted pods are still cold the system sustains {} req/s ({} once warm)", js_num(r1(cold)), js_num(r1(after.0))));
        }
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
        o.insert("leans".into(), json!(if fails { "fail" } else { "pass" }));
    }
    o.insert("summary".into(), json!(headline(st, base)));
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
    let mut confidence = json!({ "level": level, "services": services, "warnings": warnings });
    // the one warning that set the level, said first where someone decides on the verdict: the first
    // that took it to low, or else the first that lowered it at all
    let because = if level == "low" { low_why } else { warnings.iter().find(|w| !cost_notes.contains(w)).cloned() };
    if let Some(b) = because.filter(|_| level != "high") {
        confidence["because"] = json!(b);
    }
    o.insert("confidence".into(), confidence);
    o.insert("notes".into(), g(st, &["notes"]).clone());
    o.insert("howToRead".into(), json!(format!("{}/month; {}; confidence {}", money(n(st, &["delta", "monthly", "p50"])), match verdict { "pass" => "safe on this history", "fail" => "would have broken the SLO", _ => "not proven either way" }, level)));
    Ok(Value::Object(o))
}

/// "125m", "1.5 cores"
fn cores(x: f64) -> String {
    if x < 1.0 {
        format!("{}m", js_num(js_round(x * 1000.0)))
    } else {
        format!("{} core{}", js_num(x), if x == 1.0 { "" } else { "s" })
    }
}

/// what a JIT runtime's warm-up did in the replay, for each service the change touches whose pods
/// start cold: the reason, and the warning when its warm-up is assumed and mattered (cold for minutes)
fn warmup_reasons(mv: &Value, st: &Value, spec: &Value) -> Vec<(String, Option<String>)> {
    let mut out = vec![];
    let events = arr(st, &["events"]);
    for c in arr(spec, &["changes"]) {
        let svc = s(c, &["service"]);
        if svc.is_empty() {
            continue;
        }
        let w: Option<crate::types::Warmup> = match g(mv, &["services", &svc, "warmup"]) {
            Value::Null => c.get("runtime").and_then(|r| r.as_str()).and_then(crate::model::assumed_warmup),
            x => serde_json::from_value(x.clone()).ok(),
        };
        let w = match w {
            Some(w) => w,
            None => continue,
        };
        let mine = |e: &&Value| s(e, &["what"]).starts_with(&format!("{}: ", svc));
        let starts: Vec<&Value> = events.iter().copied().filter(mine).filter(|e| s(e, &["what"]).contains(" cold (a ")).collect();
        if starts.is_empty() {
            continue;
        }
        let warm: Vec<&Value> = events.iter().copied().filter(mine).filter(|e| s(e, &["what"]).starts_with(&format!("{}: warm", svc))).collect();
        let label = crate::model::runtime_label(&w.runtime);
        let restarted = starts.iter().any(|e| s(e, &["what"]).contains("restart"));
        let source = if w.source == "calibrated" { "calibrated on a pod start in the history" } else { "assumed" };
        // minutes the first cohort stayed cold: until its warm event, or the end of the window
        let first = n(starts[0], &["t"]);
        let cold_min = match warm.first() {
            Some(e) => (n(e, &["t"]) - first) / 60.0,
            None => f64::INFINITY,
        };
        let outcome = match warm.first() {
            Some(_) if starts.len() == 1 => format!("in the replay it is warm {} min after it starts", js_num(r1(cold_min))),
            Some(_) => format!("in the replay {} cold starts, the first warm after {} min", starts.len(), js_num(r1(cold_min))),
            None => format!(
                "in the replay it never warms up — its requests leave the compiler too little of its CPU, so it stays slow because it is slow{}",
                if w.share > 0.0 { format!(" ({}% of the limit when they take it all)", js_num(js_round(w.share * 100.0))) } else { String::new() }
            ),
        };
        let what = if restarted {
            match c.get("cpu").and_then(|x| x.as_f64()) {
                Some(cpu) => format!("{} restarts on its new {} CPU limit", svc, cores(cpu)),
                None => format!("{} restarts with the change", svc),
            }
        } else {
            format!("{}: the pods its autoscaler adds start cold", svc)
        };
        let why = format!(
            "{} and a {} needs ~{} core-seconds of JIT compilation to warm up ({}): until then a request costs ×{} its warm CPU; {}",
            what,
            label,
            js_num(w.core_s),
            source,
            js_num(w.cold),
            outcome
        );
        let assumed = (w.source != "calibrated" && cold_min >= 2.0).then(|| {
            format!(
                "{}'s warm-up is assumed, not measured on it: the {} defaults (×{} CPU while cold, {} core-seconds of compilation, {}% of the limit for the compiler under load), fitted on one Spring Boot service; nothing in the history shows one of its pods starting",
                svc,
                label,
                js_num(w.cold),
                js_num(w.core_s),
                js_num(js_round(w.share * 100.0))
            )
        });
        out.push((why, assumed));
    }
    out
}

pub fn grpc_calls(mv: &Value) -> Option<Vec<(String, String)>> {
    let v: Vec<(String, String)> = arr(mv, &["provenance", "grpc", "calls"])
        .iter()
        .filter_map(|c| Some((c.get(0)?.as_str()?.to_string(), c.get(1)?.as_str()?.to_string())))
        .collect();
    (!v.is_empty()).then_some(v)
}


#[cfg(test)]
mod tests {
    use super::*;

    fn st(dm: f64, ds: f64, df: f64) -> Value {
        json!({ "delta": { "monthly": { "p50": dm }, "minutesOutOfSlo": { "p50": ds }, "failedRequests": { "p50": df } }, "incidents": [] })
    }

    #[test]
    fn a_warm_up_measured_in_the_history_replaces_the_assumed_one() {
        let st = json!({ "events": [
            { "t": 0.0, "what": "api: 1 pod restarts cold (a JVM) — requests cost ×5 CPU until ~36 core-seconds of JIT compilation are done, with 0.1 cores" },
            { "t": 300.0, "what": "api: warm — 1 pod finished JIT compilation 5 min after starting; requests back at their warm CPU cost" },
        ] });
        let spec = json!({ "changes": [{ "service": "api", "cpu": 0.125 }] });
        let mv = |source: &str| json!({ "services": { "api": { "warmup": { "runtime": "jvm", "cold": 5.0, "coreS": 36.0, "share": 0.06, "source": source } } } });
        let measured = warmup_reasons(&mv("calibrated"), &st, &spec);
        assert_eq!(measured.len(), 1);
        assert!(measured[0].0.contains("~36 core-seconds of JIT compilation to warm up (calibrated on a pod start in the history)"), "{}", measured[0].0);
        assert!(measured[0].1.is_none());
        let assumed = warmup_reasons(&mv("assumed"), &st, &spec);
        assert!(assumed[0].0.contains("(assumed)") && assumed[0].1.as_deref().unwrap().contains("assumed, not measured on it"));
    }

    #[test]
    fn a_large_change_in_failed_requests_is_in_the_headline() {
        let base = json!({ "summary": { "failedRequests": { "p50": 32000.0 } }, "incidents": [] });
        assert_eq!(headline(&st(0.0, 0.0, -12400.0), &base), "costs the same, with no change in time out of SLO but 12,400 fewer failed requests (39% fewer)");
        assert_eq!(headline(&st(120.0, -3.0, 5000.0), &base), "costs $120/month more and removes 3 minutes out of SLO from the history, with 5,000 more failed requests (16% more)");
        // small against what failed as built, or a handful: not worth a word
        assert_eq!(headline(&st(0.0, 0.0, -2000.0), &base), "costs the same, with no change in time out of SLO");
        assert_eq!(headline(&st(0.0, 0.0, -31990.0), &base), "costs the same, with no change in time out of SLO but 31,990 fewer failed requests (over 99% fewer)");
        assert_eq!(headline(&st(0.0, 0.0, -32000.0), &base), "costs the same, with no change in time out of SLO but 32,000 fewer failed requests (all of them)");
        assert_eq!(headline(&st(0.0, 15.0, 400000.0), &base), "costs the same and adds 15 minutes out of SLO, with 400,000 more failed requests (from 32,000 as built)");
        assert_eq!(headline(&st(-15.0, 1.0, 0.0), &base), "saves $15/month and adds 1 minute out of SLO");
        let few = json!({ "summary": { "failedRequests": { "p50": 50.0 } }, "incidents": [] });
        assert_eq!(headline(&st(0.0, 0.0, -40.0), &few), "costs the same, with no change in time out of SLO");
    }
}
