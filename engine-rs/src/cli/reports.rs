//! A backtest written out: the one-line verdict, the Markdown report and pull-request comment
//! (src/backtest/report.ts), the HTML report (reportHtml.ts) and the Studio card (card.ts).

use super::util::loc;
use crate::math::{js_num, js_round, js_to_fixed};
use serde_json::{json, Map as JMap, Value};

pub use crate::review::json::{arr, g, inf, n, s};
fn nums(v: &Value, path: &[&str]) -> Vec<Option<f64>> {
    arr(v, path).iter().map(|x| x.as_f64()).collect()
}

/// ISO 8601 of epoch seconds
pub use crate::review::json::iso_floor as iso;
/// "Sep 14 at 12:03 UTC"
use crate::review::json::when_utc as when;

fn money(x: f64) -> String {
    let a = x.abs();
    format!("{}${}", if x < 0.0 { "−" } else { "" }, if a >= 100.0 { loc(js_round(a)) } else { js_to_fixed(a, 2) })
}
fn signed(x: f64) -> String {
    let a = x.abs();
    format!("{}${}", if x > 0.0 { "+" } else if x < 0.0 { "−" } else { "±" }, if a >= 100.0 { loc(js_round(a)) } else { js_to_fixed(a, 2) })
}
fn range(r: &Value, f: &dyn Fn(f64) -> String) -> String {
    let (p50, lo, hi) = (f(n(r, &["p50"])), f(n(r, &["lo"])), f(n(r, &["hi"])));
    if lo == hi {
        p50
    } else {
        format!("{} ({} … {})", p50, lo, hi)
    }
}
fn mins(x: f64) -> String {
    format!("{} min", js_num(js_round(x)))
}
fn count(x: f64) -> String {
    loc(js_round(x))
}

pub use crate::review::judge::headline;

fn accuracy_block(acc: &[&Value]) -> Vec<String> {
    if acc.is_empty() {
        return vec!["_No accuracy record yet — run `hindcast accuracy` (holdout) to measure how well the model predicts this system._".into()];
    }
    let mut out = vec![];
    for a in acc {
        out.push(format!("**{}** — {}", if s(a, &["method"]) == "reference" { "Checked against recorded runs" } else { "Holdout" }, s(a, &["label"])));
        out.push(String::new());
        out.push("| check | predicted | measured | off by | target | |".into());
        out.push("|---|---|---|---|---|---|".into());
        for c in arr(a, &["checks"]) {
            let metric = s(c, &["metric"]);
            if metric == "errors" {
                continue;
            }
            let u = |x: f64| match metric.as_str() {
                "cost" => format!("${}", js_to_fixed(x, if x < 10.0 { 3 } else { 0 })),
                "breaking-point" => format!("{} req/s", js_to_fixed(x, 1)),
                _ => format!("{} ms", js_num(js_round(x))),
            };
            out.push(format!("| {} | {} | {} | {}% | ≤ {}% | {} |", metric, u(n(c, &["predicted"])), u(n(c, &["measured"])), js_to_fixed(n(c, &["error"]) * 100.0, 1), js_num(inf(c, &["tolerance"]) * 100.0), if g(c, &["pass"]).as_bool().unwrap_or(false) { "✅" } else { "⚠️" }));
        }
        out.push(String::new());
    }
    out
}

fn strategy_named<'a>(r: &'a Value, name: &str) -> &'a Value {
    arr(r, &["strategies"]).into_iter().find(|x| s(x, &["name"]) == name).unwrap_or(&Value::Null)
}

pub fn backtest_markdown(r: &Value, model: &Value) -> String {
    let hours = (n(r, &["window", "end"]) - n(r, &["window", "start"])) / 3600.0;
    let base = g(r, &["baseline"]);
    let mut l: Vec<String> = vec![];
    l.push(format!("# Backtest — {}", s(r, &["model"])));
    l.push(String::new());
    l.push(format!(
        "Replayed **{}** of real traffic ({} → {} UTC, {}s buckets) through the calibrated model, {} draws per strategy. Ranges are 10th–90th percentiles.",
        if hours >= 48.0 { format!("{} days", js_to_fixed(hours / 24.0, 1)) } else { format!("{} hours", js_to_fixed(hours, 1)) },
        &iso(n(r, &["window", "start"]))[..16],
        &iso(n(r, &["window", "end"]))[..16],
        js_num(n(r, &["window", "stepS"])),
        js_num(n(r, &["draws"]))
    ));
    l.push(String::new());
    if !g(r, &["load"]).is_null() {
        let f = js_to_fixed(n(r, &["load", "factor"]), 2);
        l.push(format!("**Load ×{}**: the history replayed at {}× its traffic (busiest moment {} req/s), the same daily shape and spikes — as built and every strategy alike.", f, f, js_num(js_round(n(r, &["load", "peakRps"])))));
        l.push(String::new());
    }
    l.push(format!("SLO: p99 ≤ {} ms and errors ≤ {}%.", js_num(n(r, &["slo", "p99Ms"])), js_to_fixed(n(r, &["slo", "errorRate"]) * 100.0, 1)));
    l.push(String::new());
    l.push("## Ranking".into());
    l.push(String::new());
    l.push("| # | strategy | $/month vs as built | minutes out of SLO | failed requests | verdict |".into());
    l.push("|---|---|---|---|---|---|".into());
    l.push(format!("| – | As built | {}/month | {} | {} | |", money(n(base, &["summary", "monthly", "p50"])), range(g(base, &["summary", "minutesOutOfSlo"]), &mins), range(g(base, &["summary", "failedRequests"]), &count)));
    for (i, k) in arr(r, &["ranking"]).iter().enumerate() {
        let st = strategy_named(r, &s(k, &["name"]));
        l.push(format!("| {} | {} | {} | {} | {} | {} |", i + 1, s(st, &["name"]), range(g(st, &["delta", "monthly"]), &signed), range(g(st, &["summary", "minutesOutOfSlo"]), &mins), range(g(st, &["summary", "failedRequests"]), &count), headline(st, base)));
    }
    l.push(String::new());
    let mut all = vec![base];
    all.extend(arr(r, &["strategies"]));
    for st in &all {
        l.push(format!("## {}", s(st, &["name"])));
        l.push(String::new());
        let desc = s(st, &["description"]);
        if !desc.is_empty() {
            l.push(desc);
            l.push(String::new());
        }
        let notes = arr(st, &["notes"]);
        for x in &notes {
            l.push(format!("- {}", s(x, &[])));
        }
        if !notes.is_empty() {
            l.push(String::new());
        }
        l.push(format!("- cost over the window {} · {}/month", range(g(st, &["summary", "cost"]), &money), money(n(st, &["summary", "monthly", "p50"]))));
        l.push(format!("- {} out of SLO, {} failed requests, {}% of the error budget", range(g(st, &["summary", "minutesOutOfSlo"]), &mins), range(g(st, &["summary", "failedRequests"]), &count), js_to_fixed(n(st, &["summary", "errorBudgetUsed", "p50"]) * 100.0, 0)));
        l.push(format!("- worst moment: {} — p99 {} ms, {}% errors; {}", when(n(st, &["worst", "t"])), js_num(js_round(n(st, &["worst", "p99Ms"]))), js_to_fixed(n(st, &["worst", "errorRate"]) * 100.0, 1), s(st, &["worst", "why"])));
        let inc = arr(st, &["incidents"]);
        if !inc.is_empty() {
            l.push(String::new());
            l.push("| from | minutes | peak p99 | peak errors | why |".into());
            l.push("|---|---|---|---|---|".into());
            for i in inc.iter().take(12) {
                l.push(format!("| {} | {} | {} ms | {}% | {} |", when(n(i, &["start"])), js_to_fixed(n(i, &["minutes"]), 1), js_num(js_round(n(i, &["peakP99Ms"]))), js_to_fixed(n(i, &["peakErrorRate"]) * 100.0, 1), s(i, &["why"])));
            }
            if inc.len() > 12 {
                l.push(format!("| … | {} more | | | |", inc.len() - 12));
            }
        }
        l.push(String::new());
    }
    l.push("## Endpoints".into());
    l.push(String::new());
    l.push("| endpoint | SLO | | requests | failed | min out of own SLO | $ per 1M requests |".into());
    l.push("|---|---|---|---|---|---|---|".into());
    if let Some(eps) = g(base, &["endpoints"]).as_object() {
        for id in eps.keys() {
            for (k, st) in all.iter().enumerate() {
                let e = g(st, &["endpoints", id]);
                if e.is_null() {
                    continue;
                }
                let cpm = n(e, &["costPerMillion"]);
                l.push(format!(
                    "| {} | {} | {} | {} | {} | {} | ${} |",
                    if k == 0 { id.clone() } else { String::new() },
                    if k == 0 { format!("p99 ≤ {} ms, err ≤ {}%", js_num(n(e, &["slo", "p99Ms"])), js_to_fixed(n(e, &["slo", "errorRate"]) * 100.0, 1)) } else { String::new() },
                    s(st, &["name"]),
                    count(n(e, &["requests"])),
                    count(n(e, &["failedRequests"])),
                    js_to_fixed(n(e, &["minutesOutOfSlo"]), 1),
                    js_to_fixed(cpm, if cpm < 10.0 { 3 } else { 2 })
                ));
            }
        }
    }
    l.push(String::new());
    l.push("## Model".into());
    l.push(String::new());
    l.push("| component | capacity / replica | limited by | replicas | $/replica-h | fit | notes |".into());
    l.push("|---|---|---|---|---|---|---|".into());
    if let Some(svcs) = g(model, &["services"]).as_object() {
        for sv in svcs.values() {
            let per = inf(sv, &["capacity", "perReplicaRps"]);
            let band = arr(sv, &["capacity", "band"]);
            let cap = if per.is_finite() { format!("{} req/s{}", js_to_fixed(per, 1), if band.len() >= 2 { format!(" ({}–{})", js_to_fixed(band[0].as_f64().unwrap_or(f64::NAN), 1), js_to_fixed(band[1].as_f64().unwrap_or(f64::NAN), 1)) } else { String::new() }) } else { "—".into() };
            let hosted = s(sv, &["hostedBy"]);
            let lim = match s(sv, &["capacity", "limit"]).as_str() {
                "none" => "—".to_string(),
                "cpu" => "CPU".to_string(),
                _ => format!("concurrency ({})", js_num(n(sv, &["capacity", "servers"]))),
            };
            let mape = sv.get("fit").and_then(|f| f.get("latencyMape"));
            let fit = format!("{}{}", s(sv, &["fit", "status"]), match mape {
                None => String::new(),
                Some(m) => format!(" · {}%", js_to_fixed(m.as_f64().unwrap_or(0.0) * 100.0, 0)),
            });
            let notes: Vec<String> = arr(sv, &["fit", "notes"]).iter().map(|x| s(x, &[])).filter(|x| !x.starts_with("replaying")).collect();
            l.push(format!(
                "| {}{} | {} | {} | {} | {} | {} | {} |",
                s(sv, &["id"]),
                if hosted.is_empty() { String::new() } else { format!(" (in {})", hosted) },
                cap,
                lim,
                if hosted.is_empty() { js_num(n(sv, &["replicas"])) } else { "—".into() },
                if s(sv, &["cost", "source"]) == "none" { "—".into() } else { format!("${}", js_to_fixed(n(sv, &["cost", "perReplicaHour"]), 4)) },
                fit,
                notes.join("; ")
            ));
        }
    }
    l.push(String::new());
    l.push("## Accuracy".into());
    l.push(String::new());
    l.extend(accuracy_block(&arr(r, &["accuracy"])));
    l.join("\n") + "\n"
}

/// "the last 14 days" of a backtest's window
fn replayed_span(r: &Value) -> String {
    let days = (n(r, &["window", "end"]) - n(r, &["window", "start"])) / 86400.0;
    let hrs = js_round(days * 24.0);
    if days >= 1.5 {
        format!("the last {} days", js_num(js_round(days)))
    } else if days >= 1.0 {
        "the last day".into()
    } else if hrs > 1.0 {
        format!("the last {} hours", js_num(hrs))
    } else {
        format!("the last {} minutes", js_num(js_round(days * 1440.0).max(1.0)))
    }
}

/// the line under a comment's verdicts: what was replayed, how many draws
fn replayed_line(r: &Value) -> String {
    let load = if g(r, &["load"]).is_null() { String::new() } else { format!(" at ×{} its load (busiest moment {} req/s)", js_to_fixed(n(r, &["load", "factor"]), 2), js_num(js_round(n(r, &["load", "peakRps"])))) };
    format!("<sub>Replayed {} of production traffic{} through the calibrated model · {} draws · ranges are 10th–90th percentiles</sub>", replayed_span(r), load, js_num(n(r, &["draws"])))
}

/// as built and each strategy: $/month, minutes out of SLO, failed requests, worst moment
fn comment_table(r: &Value) -> Vec<String> {
    let base = g(r, &["baseline"]);
    let mut l: Vec<String> = vec!["| | $/month | minutes out of SLO | failed requests | worst moment |".into(), "|---|---|---|---|---|".into()];
    let row = |st: &Value, d: bool| format!("| {} | {} | {} | {} | {} · {} |", s(st, &["name"]), if d { range(g(st, &["delta", "monthly"]), &signed) } else { money(n(st, &["summary", "monthly", "p50"])) }, range(g(st, &["summary", "minutesOutOfSlo"]), &mins), range(g(st, &["summary", "failedRequests"]), &count), when(n(st, &["worst", "t"])), s(st, &["worst", "why"]));
    l.push(row(base, false));
    for st in arr(r, &["strategies"]) {
        l.push(row(st, true));
    }
    l
}

/// the model's accuracy record, folded
fn comment_accuracy(r: &Value) -> Vec<String> {
    let mut l: Vec<String> = vec![];
    let acc = arr(r, &["accuracy"]);
    let checks: Vec<&Value> = acc.iter().flat_map(|a| arr(a, &["checks"])).filter(|c| s(c, &["metric"]) != "errors").collect();
    if !checks.is_empty() {
        l.push(format!("<details><summary>Model accuracy: {}/{} checks within target</summary>", checks.iter().filter(|c| g(c, &["pass"]).as_bool().unwrap_or(false)).count(), checks.len()));
        l.push(String::new());
        l.push("```".into());
        for a in &acc {
            l.extend(accuracy_lines(a));
        }
        l.push("```".into());
        l.push("</details>".into());
    } else {
        l.push("<sub>⚠️ No accuracy record for this model yet.</sub>".into());
    }
    l
}

/// the comment a CI check posts on a pull request
pub fn pr_comment(r: &Value, title: Option<&str>, run_url: Option<&str>) -> String {
    let base = g(r, &["baseline"]);
    let mut l: Vec<String> = vec![];
    l.push(format!("### {}", title.unwrap_or("Hindcast backtest")));
    l.push(String::new());
    for st in arr(r, &["strategies"]) {
        l.push(format!("**{}** {}.", s(st, &["name"]), headline(st, base)));
        l.push(String::new());
    }
    l.push(replayed_line(r));
    l.push(String::new());
    l.extend(comment_table(r));
    l.push(String::new());
    l.extend(comment_accuracy(r));
    l.push(String::new());
    if let Some(u) = run_url {
        l.push(format!("<sub>[Full report]({})</sub>", u));
    }
    l.join("\n") + "\n"
}

/// the hidden line that finds a check's own comment again, to update it in place
pub const COMMENT_MARKER: &str = "<!-- hindcast-verify-change -->";

fn verdict_mark(v: &str) -> &'static str {
    match v {
        "pass" => "✅",
        "fail" => "❌",
        "inconclusive" => "⚠️",
        _ => "➖",
    }
}

/// the pull-request comment and job summary of `hindcast verify-change`: verify_change's verdict and
/// confidence per change, the backtest table it was judged on, why, and how far to trust it
pub fn verify_comment(out: &Value, r: &Value, title: Option<&str>, run_url: Option<&str>) -> String {
    let verdict = s(out, &["verdict"]);
    let mut l: Vec<String> = vec![COMMENT_MARKER.into()];
    l.push(format!("### {} {}: {}", verdict_mark(&verdict), title.unwrap_or("Hindcast backtest"), verdict));
    l.push(String::new());
    let results = arr(out, &["results"]);
    if results.is_empty() {
        l.push("No change here that the model can backtest (replicas, CPU and memory limits and requests, autoscalers, CPU architecture).".into());
        l.push(String::new());
        for note in arr(out, &["notes"]) {
            l.push(format!("- {}", s(note, &[])));
        }
        if let Some(u) = run_url {
            l.push(String::new());
            l.push(format!("<sub>[Run]({})</sub>", u));
        }
        return l.join("\n") + "\n";
    }
    for x in &results {
        let v = s(x, &["verdict"]);
        let leans = if v == "inconclusive" { format!(" (leans {})", s(x, &["leans"])) } else { String::new() };
        l.push(format!("**{}** — **{}**{} · confidence **{}**", s(x, &["name"]), v, leans, s(x, &["confidence", "level"])));
        l.push(String::new());
        l.push(format!("It {}.", s(x, &["summary"])));
        l.push(String::new());
        let md = g(x, &["cost", "monthlyDelta"]);
        let dm = g(x, &["reliability", "minutesOutOfSloDelta"]);
        let fr = g(x, &["reliability", "failedRequestsDelta"]);
        let band = |r: &Value, f: &dyn Fn(f64) -> String| {
            let (p, lo, hi) = (n(r, &["p50"]), n(r, &["lo"]), n(r, &["hi"]));
            if f(lo) == f(hi) {
                f(p)
            } else {
                format!("{} ({} … {})", f(p), f(lo), f(hi))
            }
        };
        let sgn = |x: f64, k: String| if x > 0.0 { format!("+{}", k) } else if x < 0.0 { format!("−{}", k) } else { k };
        l.push(format!("- **$ / month:** {}/month ({})", band(md, &signed), s(x, &["cost", "basis"])));
        l.push(format!("- **minutes out of SLO:** {}, {} min in all with the change",band(dm, &|v| sgn(v, format!("{} min", js_num(r1(v.abs()))))), js_num(n(x, &["reliability", "minutesOutOfSlo"]))));
        l.push(format!("- **failed requests:** {}", band(fr, &|v| sgn(v, loc(js_round(v.abs()))))));
        let w = g(x, &["reliability", "worst"]);
        if !s(w, &["why"]).is_empty() {
            l.push(format!("- **worst moment:** {} — p99 {} ms, {}% errors; {}", when(crate::accuracy::parse_iso_ms(&s(w, &["at"])).map(|ms| ms as f64 / 1000.0).unwrap_or(f64::NAN)), js_num(n(w, &["p99Ms"])), js_num(js_round(n(w, &["errorRate"]) * 100.0)), s(w, &["why"])));
        }
        l.push(String::new());
        let reasons = arr(x, &["reasons"]);
        if reasons.len() > 1 {
            l.push("Why:".into());
            for r in &reasons[1..] {
                l.push(format!("- {}", s(r, &[])));
            }
            l.push(String::new());
        }
        let warns = arr(x, &["confidence", "warnings"]);
        if !warns.is_empty() {
            l.push(format!("Confidence {}:", s(x, &["confidence", "level"])));
            for w in warns {
                l.push(format!("- {}", s(w, &[])));
            }
            l.push(String::new());
        }
    }
    l.push(replayed_line(r));
    l.push(String::new());
    l.extend(comment_table(r));
    l.push(String::new());
    let slo = g(out, &["slo"]);
    l.push(format!("<sub>SLO: p99 ≤ {} ms, errors ≤ {}% · {}</sub>", js_num(n(slo, &["p99Ms"])), js_num(r1(n(slo, &["errorRate"]) * 100.0)), s(out, &["gate"])));
    l.push(String::new());
    l.extend(comment_accuracy(r));
    l.push(String::new());
    let changes: Vec<String> = results.iter().map(|x| crate::yaml_out::to_yaml(g(x, &["change"]))).collect();
    l.push("<details><summary>What was backtested</summary>".into());
    l.push(String::new());
    l.push("```yaml".into());
    l.push(changes.join("---\n").trim_end().to_string());
    l.push("```".into());
    let notes = arr(out, &["notes"]);
    if !notes.is_empty() {
        l.push(String::new());
        for note in notes {
            l.push(format!("- {}", s(note, &[])));
        }
    }
    l.push("</details>".into());
    l.push(String::new());
    if let Some(u) = run_url {
        l.push(format!("<sub>[Full report]({})</sub>", u));
    }
    l.join("\n") + "\n"
}

/// src/backtest/accuracy.ts accuracyLines, over a record's JSON
pub fn accuracy_lines(rec: &Value) -> Vec<String> {
    arr(rec, &["checks"])
        .iter()
        .filter(|c| s(c, &["metric"]) != "errors")
        .map(|c| {
            let metric = s(c, &["metric"]);
            let unit = |x: f64| match metric.as_str() {
                "cost" => format!("${}", js_to_fixed(x, if x < 10.0 { 3 } else { 0 })),
                "breaking-point" => format!("{} req/s", js_to_fixed(x, 1)),
                "errors" => js_num(js_round(x)),
                _ => format!("{} ms", js_num(js_round(x))),
            };
            let verdict = if g(c, &["pass"]).as_bool().unwrap_or(false) { "PASS" } else { "MISS" };
            let tol = c.get("tolerance");
            let target = match tol {
                Some(Value::Number(t)) if t.as_f64().map(|x| x.is_finite()).unwrap_or(false) => format!(" (target ≤ {}%)", js_num(t.as_f64().unwrap() * 100.0)),
                _ => String::new(),
            };
            format!("{} {} predicted {} vs measured {} — off by {}%{} · {}", verdict, super::util::pad(&metric, 14), unit(n(c, &["predicted"])), unit(n(c, &["measured"])), js_to_fixed(n(c, &["error"]) * 100.0, 1), target, s(c, &["note"]))
        })
        .collect()
}

// ---- the HTML report ----

fn esc(x: &str) -> String {
    x.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

const COLORS: [&str; 5] = ["#f2a93b", "#3fc1d9", "#b48cf2", "#ef7fb1", "#9bd35a"];

struct Line {
    label: String,
    color: String,
    values: Option<Vec<Option<f64>>>,
    band: Option<(Vec<Option<f64>>, Vec<Option<f64>>, Vec<Option<f64>>)>,
    dash: bool,
}

fn band(v: &Value) -> (Vec<Option<f64>>, Vec<Option<f64>>, Vec<Option<f64>>) {
    (nums(v, &["p50"]), nums(v, &["lo"]), nums(v, &["hi"]))
}

struct ChartOpts<'a> {
    unit: &'a dyn Fn(f64) -> String,
    log: bool,
    threshold: Option<(f64, &'a str)>,
    cap: Option<f64>,
}

fn chart(title: &str, t: &[f64], lines: &[Line], o: &ChartOpts) -> String {
    let (w, h, lft, rgt, top, bot) = (960.0, 200.0, 56.0, 12.0, 14.0, 24.0);
    let mut all: Vec<f64> = vec![];
    for l in lines {
        for v in l.values.iter().flatten().flatten() {
            if v.is_finite() {
                all.push(*v);
            }
        }
        if let Some(b) = &l.band {
            // `for (const v of l.band?.hi ?? [])`: a null reads as 0, which isFinite keeps
            for v in &b.2 {
                all.push(v.unwrap_or(0.0));
            }
        }
    }
    if let Some((v, _)) = o.threshold {
        all.push(v);
    }
    let max = crate::backtest::js_max(1e-9, all.iter().copied()) * 1.08;
    let max = match o.cap {
        Some(c) => if max.is_nan() { f64::NAN } else { c.min(max) },
        None => max,
    };
    let min = if o.log {
        let pos = all.iter().copied().filter(|v| *v > 0.0).fold(f64::INFINITY, f64::min);
        crate::backtest::js_max(1.0, std::iter::once(pos * 0.8))
    } else {
        0.0
    };
    let tl = t.len() as f64;
    let x = |i: f64| lft + ((w - lft - rgt) * i) / (tl - 1.0).max(1.0);
    let y = |v: f64| {
        if o.log {
            top + (h - top - bot) * (1.0 - (crate::fmath::log(min.max(v)) - crate::fmath::log(min)) / (crate::fmath::log(max) - crate::fmath::log(min)))
        } else {
            top + (h - top - bot) * (1.0 - v / max)
        }
    };
    let path = |vals: &[Option<f64>]| {
        let mut d = String::new();
        let mut pen = false;
        for (i, v) in vals.iter().enumerate() {
            match v {
                Some(v) if v.is_finite() => {
                    d += &format!("{}{},{}", if pen { "L" } else { "M" }, js_to_fixed(x(i as f64), 1), js_to_fixed(y(*v), 1));
                    pen = true;
                }
                // null or not finite: the pen lifts
                _ => pen = false,
            }
        }
        d
    };
    let pt = |i: usize, v: &Option<f64>| format!("{},{}", js_to_fixed(x(i as f64), 1), js_to_fixed(y(v.unwrap_or(0.0)), 1));
    let area = |b: &(Vec<Option<f64>>, Vec<Option<f64>>, Vec<Option<f64>>)| {
        let hi: Vec<String> = b.2.iter().enumerate().map(|(i, v)| pt(i, v)).collect();
        let mut lo: Vec<String> = b.1.iter().enumerate().map(|(i, v)| pt(i, v)).collect();
        lo.reverse();
        format!("M{}L{}Z", hi.join("L"), lo.join("L"))
    };
    let ticks: Vec<f64> = [0.0, 0.25, 0.5, 0.75, 1.0].iter().map(|f| if o.log { crate::fmath::exp(crate::fmath::log(min) + f * (crate::fmath::log(max) - crate::fmath::log(min))) } else { f * max }).collect();
    let times: Vec<usize> = [0.0, 0.25, 0.5, 0.75, 1.0].iter().map(|f| js_round(f * (tl - 1.0)) as usize).collect();
    let fmt_t = |sec: f64| iso(sec)[5..16].replacen('T', " ", 1);
    let mut svg = format!("<figure><figcaption>{}</figcaption><svg viewBox=\"0 0 {} {}\" role=\"img\" aria-label=\"{}\">\n", esc(title), js_num(w), js_num(h), esc(title));
    svg += &ticks.iter().map(|v| format!("<line x1=\"{}\" x2=\"{}\" y1=\"{}\" y2=\"{}\" class=\"grid\"/><text x=\"{}\" y=\"{}\" class=\"ax\" text-anchor=\"end\">{}</text>", js_num(lft), js_num(w - rgt), js_num(y(*v)), js_num(y(*v)), js_num(lft - 6.0), js_num(y(*v) + 4.0), (o.unit)(*v))).collect::<Vec<_>>().join("");
    svg += "\n";
    svg += &times.iter().map(|i| format!("<text x=\"{}\" y=\"{}\" class=\"ax\" text-anchor=\"middle\">{}</text>", js_num(x(*i as f64)), js_num(h - 6.0), t.get(*i).map(|s| fmt_t(*s)).unwrap_or_default())).collect::<Vec<_>>().join("");
    svg += "\n";
    if let Some((v, label)) = o.threshold {
        svg += &format!("<line x1=\"{}\" x2=\"{}\" y1=\"{}\" y2=\"{}\" class=\"slo\"/><text x=\"{}\" y=\"{}\" class=\"ax\" text-anchor=\"end\">{}</text>", js_num(lft), js_num(w - rgt), js_num(y(v)), js_num(y(v)), js_num(w - rgt), js_num(y(v) - 4.0), esc(label));
    }
    svg += "\n";
    svg += &lines.iter().filter_map(|l| l.band.as_ref().map(|b| format!("<path d=\"{}\" fill=\"{}\" opacity=\"0.14\"/>", area(b), l.color))).collect::<Vec<_>>().join("");
    svg += "\n";
    svg += &lines
        .iter()
        .map(|l| {
            let vals = l.values.clone().unwrap_or_else(|| l.band.as_ref().map(|b| b.0.clone()).unwrap_or_default());
            format!("<path d=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{}\"{}/>", path(&vals), l.color, if l.label == "measured" { "1.2" } else { "1.6" }, if l.dash { " stroke-dasharray=\"4 3\"" } else { "" })
        })
        .collect::<Vec<_>>()
        .join("");
    svg += "\n";
    svg += &format!("</svg><div class=\"legend\">{}</div></figure>", lines.iter().map(|l| format!("<span><i style=\"background:{}\"></i>{}</span>", l.color, esc(&l.label))).collect::<Vec<_>>().join(""));
    svg
}

pub fn backtest_html(r: &Value, model: &Value) -> String {
    let ms = |v: f64| if v >= 1000.0 { format!("{}s", js_to_fixed(v / 1000.0, 1)) } else { format!("{}ms", js_num(js_round(v))) };
    let pct = |v: f64| format!("{}%", js_to_fixed(v * 100.0, if v < 0.1 { 1 } else { 0 }));
    let usd = |v: f64| format!("${}", if v < 10.0 { js_to_fixed(v, 2) } else { loc(js_round(v)) });
    let t: Vec<f64> = nums(r, &["t"]).into_iter().map(|x| x.unwrap_or(0.0)).collect();
    let strategies: Vec<(&Value, &str)> = arr(r, &["strategies"]).into_iter().enumerate().map(|(i, s)| (s, COLORS[i % COLORS.len()])).collect();
    let measured = |label: &str, k: &str| Line { label: label.into(), color: "#e6edf3".into(), values: Some(nums(r, &["actual", k])), band: None, dash: false };
    let as_built = |k: &str| Line { label: "as built (model)".into(), color: "#8193a3".into(), values: None, band: Some(band(g(r, &["baseline", "series", k]))), dash: true };
    let strat = |k: &str| strategies.iter().map(|(st, c)| Line { label: s(st, &["name"]), color: (*c).into(), values: None, band: Some(band(g(st, &["series", k]))), dash: false }).collect::<Vec<_>>();
    let with = |mut a: Vec<Line>, b: Vec<Line>| {
        a.extend(b);
        a
    };
    let md = backtest_markdown(r, model);
    let base = g(r, &["baseline"]);
    let checks: Vec<&Value> = arr(r, &["accuracy"]).iter().flat_map(|a| arr(a, &["checks"])).filter(|c| s(c, &["metric"]) != "errors").collect();
    let slo_p99 = n(r, &["slo", "p99Ms"]);
    let slo_err = n(r, &["slo", "errorRate"]);
    let load = if g(r, &["load"]).is_null() { String::new() } else { format!(" · <b>load ×{}</b> (busiest moment {} req/s)", js_to_fixed(n(r, &["load", "factor"]), 2), js_num(js_round(n(r, &["load", "peakRps"])))) };
    let start = iso(n(r, &["window", "start"]))[..16].replacen('T', " ", 1);
    let end = iso(n(r, &["window", "end"]))[..16].replacen('T', " ", 1);
    let unit_cell = |c: &Value, k: &str| {
        let v = n(c, &[k]);
        match s(c, &["metric"]).as_str() {
            "cost" => usd(v),
            "breaking-point" => format!("{} req/s", js_to_fixed(v, 1)),
            _ => ms(v),
        }
    };
    let accuracy = if checks.is_empty() {
        "<p class=\"sub\">No accuracy record for this model yet.</p>".to_string()
    } else {
        format!(
            "<table><tr><th>check</th><th>predicted</th><th>measured</th><th>off by</th><th>target</th><th>what</th></tr>{}</table>",
            checks.iter().map(|c| format!("<tr><td>{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num {}\">{}%</td><td class=\"num\">≤ {}%</td><td>{}</td></tr>", s(c, &["metric"]), unit_cell(c, "predicted"), unit_cell(c, "measured"), if g(c, &["pass"]).as_bool().unwrap_or(false) { "pass" } else { "miss" }, js_to_fixed(n(c, &["error"]) * 100.0, 1), js_num(inf(c, &["tolerance"]) * 100.0), esc(&s(c, &["note"])))).collect::<Vec<_>>().join("")
        )
    };
    let charts = [
        chart("p99 latency", &t, &with(vec![measured("measured", "p99Ms"), as_built("p99Ms")], strat("p99Ms")), &ChartOpts { unit: &ms, log: true, threshold: Some((slo_p99, "SLO")), cap: None }),
        chart("Errors", &t, &with(vec![measured("measured", "errorRate"), as_built("errorRate")], strat("errorRate")), &ChartOpts { unit: &pct, log: false, threshold: Some((slo_err, "SLO")), cap: Some(1.0) }),
        chart("Cost, $/hour", &t, &with(vec![measured("measured (bill)", "costPerHour"), as_built("costPerHour")], strat("costPerHour")), &ChartOpts { unit: &usd, log: false, threshold: None, cap: None }),
        chart("Cumulative cost, $", &t, &with(vec![as_built("cumulativeCost")], strat("cumulativeCost")), &ChartOpts { unit: &usd, log: false, threshold: None, cap: None }),
        chart("Error budget used", &t, &with(vec![as_built("errorBudget")], strat("errorBudget")), &ChartOpts { unit: &pct, log: false, threshold: Some((1.0, "budget")), cap: None }),
    ];
    format!(
        "{head}<title>Backtest — {model}</title>\n{style}\n<h1><span>Hindcast · backtest on real traffic</span>{model}</h1>\n<div class=\"sub\">{start} → {end} UTC · {step}s buckets{load} · {draws} draws · bands = 10th–90th percentile · SLO p99 ≤ {p99} ms, errors ≤ {err}</div>\n{verdicts}\n{c0}\n{c1}\n{c2}\n{c3}\n{c4}\n<h2>Model accuracy</h2>\n{accuracy}\n<details><summary>Full report (Markdown)</summary><pre>{md}</pre></details>\n</main></body></html>",
        head = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n",
        model = esc(&s(r, &["model"])),
        style = HTML_STYLE,
        start = start,
        end = end,
        step = js_num(n(r, &["window", "stepS"])),
        load = load,
        draws = js_num(n(r, &["draws"])),
        p99 = js_num(slo_p99),
        err = pct(slo_err),
        verdicts = strategies.iter().map(|(st, c)| format!("<p class=\"verdict\" style=\"border-left-color:{c}\"><b style=\"color:{c}\">{}</b> {}.</p>", esc(&s(st, &["name"])), esc(&headline(st, base)), c = c)).collect::<Vec<_>>().join(""),
        c0 = charts[0],
        c1 = charts[1],
        c2 = charts[2],
        c3 = charts[3],
        c4 = charts[4],
        accuracy = accuracy,
        md = esc(&md),
    )
}

// self-contained: no font service; IBM Plex where it is installed, the system's fonts otherwise
const HTML_STYLE: &str = r#"<style>
:root{--bg:#10161d;--pane:#121a22;--line:#22303c;--grid:#18232d;--text:#c9d4de;--dim:#6e8191;--hi:#e6edf3;--amber:#f2a93b;--red:#ef5b5b;--green:#58c48a;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 "IBM Plex Sans Condensed","Arial Narrow",sans-serif}
main{max-width:1040px;margin:0 auto;padding:28px 16px 64px}h1{font:600 20px "IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace;color:var(--hi);margin:0 0 4px}h1 span{color:var(--amber);font-size:12px;letter-spacing:.14em;text-transform:uppercase;display:block;margin-bottom:6px}
h2{font:600 12px "IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace;margin:32px 0 8px;text-transform:uppercase;letter-spacing:.1em;color:var(--dim)}
.sub{color:var(--dim);font-family:"IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace;font-size:12px}figure{margin:12px 0;background:var(--pane);border:1px solid var(--line);padding:8px 8px 6px}figcaption{font:500 12px "IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace;color:var(--dim);margin-bottom:4px}svg{width:100%;height:auto;display:block}
.grid{stroke:var(--grid)}.slo{stroke:var(--red);stroke-dasharray:3 3}.ax{fill:var(--dim);font:10px "IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace}
.legend{display:flex;gap:16px;flex-wrap:wrap;color:var(--dim);font:11px "IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace}.legend i{display:inline-block;width:10px;height:2px;margin-right:6px;vertical-align:middle}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{font:500 11px "IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace;color:var(--dim)}
.num{font-family:"IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace;white-space:nowrap}.pass{color:var(--green)}.miss{color:var(--red)}
.verdict{font-size:17px;margin:12px 0;color:var(--hi);border-left:2px solid var(--amber);padding-left:12px}
details{margin-top:24px}pre{white-space:pre-wrap;font:12px "IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace;color:var(--text)}a{color:var(--amber)}
</style></head><body><main>"#;

// ---- the Studio card ----

fn down<T: Clone>(xs: &[T], k: usize, pick: &dyn Fn(&[T]) -> T) -> Vec<T> {
    if xs.len() <= k {
        return xs.to_vec();
    }
    let size = xs.len() as f64 / k as f64;
    (0..k)
        .map(|i| {
            let a = (i as f64 * size).floor() as usize;
            let b = ((a + 1) as f64).max(((i + 1) as f64 * size).floor()) as usize;
            pick(&xs[a..b.min(xs.len())])
        })
        .collect()
}
fn max_of(seg: &[f64]) -> f64 {
    crate::backtest::js_max(f64::NEG_INFINITY, seg.iter().copied())
}
fn r1(x: f64) -> f64 {
    js_round(x * 10.0) / 10.0
}
fn num_v(x: f64) -> Value {
    serde_json::Number::from_f64(x).map(Value::Number).unwrap_or(Value::Null)
}

pub fn card_data(r: &Value, index: usize, points: usize) -> Value {
    let strategies = arr(r, &["strategies"]);
    let st = strategies.get(index).copied();
    let t: Vec<f64> = nums(r, &["t"]).into_iter().map(|x| x.unwrap_or(0.0)).collect();
    let k = points.min(t.len());
    let f = |v: &Value, p: &[&str]| -> Vec<f64> { nums(v, p).into_iter().map(|x| x.unwrap_or(0.0)).collect() };
    let base_cum = f(r, &["baseline", "series", "cumulativeCost", "p50"]);
    let saved_full: Vec<f64> = match st {
        Some(st) => {
            let sc = f(st, &["series", "cumulativeCost", "p50"]);
            base_cum.iter().enumerate().map(|(i, b)| b - sc.get(i).copied().unwrap_or(f64::NAN)).collect()
        }
        None => t.iter().map(|_| 0.0).collect(),
    };
    let load = !g(r, &["load"]).is_null();
    let measured: Value = if load {
        Value::Array(down(&t, k, &|s: &[f64]| s[0]).iter().map(|_| Value::Null).collect())
    } else {
        let m = nums(r, &["actual", "p99Ms"]);
        Value::Array(
            down(&m, k, &|s: &[Option<f64>]| {
                let v: Vec<f64> = s.iter().flatten().copied().collect();
                if v.is_empty() {
                    None
                } else {
                    Some(max_of(&v))
                }
            })
            .into_iter()
            .map(|x| x.map(|x| num_v(r1(x))).unwrap_or(Value::Null))
            .collect(),
        )
    };
    let series = |v: &Value, p: &[&str]| Value::Array(down(&f(v, p), k, &max_of).into_iter().map(|x| num_v(r1(x))).collect());
    let strategy = match st {
        None => Value::Null,
        Some(st) => json!({
            "name": s(st, &["name"]),
            "headline": headline(st, g(r, &["baseline"])),
            "p50": series(st, &["series", "p99Ms", "p50"]),
            "lo": series(st, &["series", "p99Ms", "lo"]),
            "hi": series(st, &["series", "p99Ms", "hi"]),
            "monthlyDelta": num_v(js_round(n(st, &["delta", "monthly", "p50"]) * 100.0) / 100.0),
            "minutesOutOfSlo": num_v(r1(n(st, &["summary", "minutesOutOfSlo", "p50"]))),
            "minutesDelta": num_v(r1(n(st, &["delta", "minutesOutOfSlo", "p50"]))),
            "failedDelta": num_v(js_round(n(st, &["delta", "failedRequests", "p50"]))),
            "worst": { "t": g(st, &["worst", "t"]), "p99Ms": num_v(js_round(n(st, &["worst", "p99Ms"]))), "why": s(st, &["worst", "why"]) },
        }),
    };
    let mut o = JMap::new();
    o.insert("system".into(), json!(if load { format!("{} · load ×{}", s(r, &["model"]), js_num(r1(n(r, &["load", "factor"])))) } else { s(r, &["model"]) }));
    o.insert("window".into(), json!({ "start": g(r, &["window", "start"]), "end": g(r, &["window", "end"]) }));
    o.insert("slo".into(), g(r, &["slo"]).clone());
    o.insert("t".into(), Value::Array(down(&t, k, &|s: &[f64]| s[0]).into_iter().map(num_v).collect()));
    o.insert("measured".into(), measured);
    o.insert("asBuilt".into(), series(g(r, &["baseline"]), &["series", "p99Ms", "p50"]));
    o.insert("strategy".into(), strategy);
    o.insert("saved".into(), Value::Array(down(&saved_full, k, &|s: &[f64]| s[s.len() - 1]).into_iter().map(|x| num_v(js_round(x * 1000.0) / 1000.0)).collect()));
    o.insert(
        "accuracy".into(),
        Value::Array(arr(r, &["accuracy"]).iter().flat_map(|a| arr(a, &["checks"])).filter(|c| s(c, &["metric"]) != "errors").map(|c| json!({ "metric": s(c, &["metric"]), "error": num_v(js_round(n(c, &["error"]) * 1000.0) / 1000.0), "pass": g(c, &["pass"]) })).collect()),
    );
    Value::Object(o)
}
