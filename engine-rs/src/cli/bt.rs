//! The backtesting commands (cli/backtest.ts): import, calibrate, backtest, headroom, accuracy, outage.

use super::files::{cwd, relative, DiskFiles};
use super::reports::{self, arr, g, inf, n, s};
use super::util::*;
use crate::math::{js_num, js_round, js_to_fixed};
use serde_json::{json, Map as JMap, Value};

/// pad to n UTF-16 units without cutting (String.prototype.padEnd)
fn pad_end(x: &str, n: usize) -> String {
    let len = x.encode_utf16().count();
    if len >= n {
        x.to_string()
    } else {
        format!("{}{}", x, " ".repeat(n - len))
    }
}

fn read_json(path: &str) -> Result<Value, String> {
    serde_json::from_str(&read(path)?).map_err(|e| e.to_string())
}
fn read_any(path: &str) -> Result<Value, String> {
    if path.ends_with(".json") {
        read_json(path)
    } else {
        parse_yaml(&read(path)?)
    }
}
fn model_of(v: &Value) -> Result<crate::model::Model, String> {
    serde_json::from_value(v.clone()).map_err(|e| format!("model: {}", e))
}
fn dataset_of(v: &Value) -> Result<crate::dataset::Dataset, String> {
    serde_json::from_value(v.clone()).map_err(|e| format!("dataset: {}", e))
}

/// "14d", "6h" → seconds
fn duration(x: &str) -> Result<f64, String> {
    let bad = || format!("bad duration \"{}\" (e.g. 14d, 6h)", x);
    let unit = x.chars().last().ok_or_else(bad)?;
    let f = match unit {
        's' => 1.0,
        'm' => 60.0,
        'h' => 3600.0,
        'd' => 86400.0,
        'w' => 604800.0,
        _ => return Err(bad()),
    };
    let num = &x[..x.len() - 1];
    let ok = match num.split_once('.') {
        Some((a, b)) => !a.is_empty() && a.bytes().all(|c| c.is_ascii_digit()) && !b.is_empty() && b.bytes().all(|c| c.is_ascii_digit()),
        None => !num.is_empty() && num.bytes().all(|c| c.is_ascii_digit()),
    };
    if !ok {
        return Err(bad());
    }
    Ok(crate::import::js_parse_float(num) * f)
}

fn last_window(d: crate::dataset::Dataset, span: &str) -> Result<crate::dataset::Dataset, String> {
    let buckets = (duration(span)? / d.step_s).ceil();
    if buckets >= d.n {
        return Ok(d);
    }
    let n0 = d.n as usize;
    Ok(crate::accuracy::slice_dataset(&d, n0 - buckets as usize, n0))
}

fn print_accuracy(m: &Value, out: &mut Out) {
    let acc = arr(m, &["accuracy"]);
    if acc.is_empty() {
        out.log(&yellow("  no accuracy record yet — `hindcast calibrate --holdout 0.3` measures one"));
        return;
    }
    for a in acc {
        out.log(&format!("  {} {}", bold(if s(a, &["method"]) == "reference" { "checked against recorded runs" } else { "holdout" }), dim(&s(a, &["label"]))));
        for l in reports::accuracy_lines(a) {
            out.log(&format!(
                "  {}",
                if let Some(rest) = l.strip_prefix("PASS") {
                    green("PASS") + rest
                } else if let Some(rest) = l.strip_prefix("MISS") {
                    red("MISS") + rest
                } else {
                    dim(&l)
                }
            ));
        }
    }
}

fn print_model(m: &Value, out: &mut Out) {
    out.log(&format!("\n{} {}", bold(&s(m, &["name"])), dim(&format!("· fitted on {} buckets of {}s", js_num(n(m, &["fittedOn", "buckets"])), js_num(n(m, &["fittedOn", "stepS"]))))));
    if let Some(svcs) = g(m, &["services"]).as_object() {
        for sv in svcs.values() {
            let status = match s(sv, &["fit", "status"]).as_str() {
                "good" => green("good"),
                "fair" => yellow("fair"),
                "poor" => red("poor"),
                "unexplained" => red("UNEXPLAINED"),
                "cost-only" => dim("cost only"),
                _ => "undefined".into(),
            };
            let per = inf(sv, &["capacity", "perReplicaRps"]);
            let band = arr(sv, &["capacity", "band"]);
            let cap = if per.is_finite() {
                format!("{} req/s/replica{}", js_to_fixed(per, 1), if band.len() >= 2 { dim(&format!(" ({}–{})", js_to_fixed(band[0].as_f64().unwrap_or(f64::NAN), 1), js_to_fixed(band[1].as_f64().unwrap_or(f64::NAN), 1))) } else { String::new() })
            } else {
                dim("no limit seen")
            };
            let lim = match s(sv, &["capacity", "limit"]).as_str() {
                "cpu" => "CPU".to_string(),
                "concurrency" => format!("{} at a time", js_num(n(sv, &["capacity", "servers"]))),
                _ => String::new(),
            };
            let cost = if s(sv, &["cost", "source"]) == "bill" { dim(&format!("${}/replica-h", js_to_fixed(n(sv, &["cost", "perReplicaHour"]), 4))) } else { String::new() };
            out.log(&format!("  {} {} {} {} {}", pad_end(&s(sv, &["id"]), 24), pad_end(&status, 20), cap, dim(&lim), cost));
            for note in arr(sv, &["fit", "notes"]) {
                out.log(&format!("  {} {}", pad_end("", 24), dim(&s(note, &[]))));
            }
        }
    }
    if let Some(eps) = g(m, &["endpoints"]).as_object() {
        for e in eps.values() {
            let notes: Vec<String> = arr(e, &["fit", "notes"]).iter().map(|x| s(x, &[])).collect();
            out.log(&format!("  {} {}", bold(&s(e, &["id"])), dim(&format!("{}% of traffic · {}", js_to_fixed(n(e, &["share"]) * 100.0, 0), notes.join("; ")))));
        }
    }
    print_accuracy(m, out);
    out.log("");
}

/// one line: how well this model predicted runs it never saw
fn accuracy_line(acc: &[&Value]) -> String {
    let checks: Vec<(&Value, String)> = acc.iter().flat_map(|a| arr(a, &["checks"]).into_iter().map(move |c| (c, s(a, &["method"])))).filter(|(c, _)| s(c, &["metric"]) != "errors").collect();
    if checks.is_empty() {
        return yellow("  model accuracy: not measured yet (hindcast calibrate --holdout 0.3)");
    }
    let parts: Vec<String> = checks
        .iter()
        .map(|(c, method)| {
            let e = format!("{}%", js_to_fixed(n(c, &["error"]) * 100.0, 0));
            format!("{}{} {}", s(c, &["metric"]), if method == "holdout" { " (holdout)" } else { "" }, if g(c, &["pass"]).as_bool().unwrap_or(false) { green(&e) } else { red(&e) })
        })
        .collect();
    format!("  {} {} {}", bold("model accuracy"), parts.join(&dim(" · ")), dim("— hindcast accuracy <model> for details"))
}

fn print_backtest(r: &Value, out: &mut Out) {
    let fd = |x: f64| format!("{}${}", if x < 0.0 { "−" } else { "+" }, js_to_fixed(x.abs(), if x.abs() < 100.0 { 2 } else { 0 }));
    out.log(&format!("\n{} {}", bold(&format!("Backtest — {}", s(r, &["model"]))), dim(&format!("· {} h of history · {} draws", js_to_fixed((n(r, &["window", "end"]) - n(r, &["window", "start"])) / 3600.0, 1), js_num(n(r, &["draws"]))))));
    let b = g(r, &["baseline", "summary"]);
    out.log(&format!("  {} ${}/month   {} min out of SLO   {} failed", bold(&pad_end("As built", 30)), js_to_fixed(n(b, &["monthly", "p50"]), 0), js_num(js_round(n(b, &["minutesOutOfSlo", "p50"]))), loc(js_round(n(b, &["failedRequests", "p50"])))));
    for k in arr(r, &["ranking"]) {
        let name = s(k, &["name"]);
        let st = arr(r, &["strategies"]).into_iter().find(|x| s(x, &["name"]) == name).unwrap_or(&Value::Null);
        let good = n(k, &["minutesOutOfSloDelta"]) <= 0.5;
        let nm = pad_end(&s(st, &["name"]), 30);
        let (lo, hi) = (n(st, &["delta", "monthly", "lo"]), n(st, &["delta", "monthly", "hi"]));
        out.log(&format!(
            "  {} {}/month {}   {} min out of SLO   {} failed",
            if good { green(&nm) } else { yellow(&nm) },
            fd(n(st, &["delta", "monthly", "p50"])),
            if (hi - lo).abs() > 0.005 { dim(&format!("({} … {})", fd(lo), fd(hi))) } else { String::new() },
            js_num(js_round(n(st, &["summary", "minutesOutOfSlo", "p50"]))),
            loc(js_round(n(st, &["summary", "failedRequests", "p50"])))
        ));
        out.log(&format!("  {} {}", pad_end("", 30), dim(&reports::headline(st, g(r, &["baseline"])))));
    }
    out.log(&format!("\n{}\n", accuracy_line(&arr(r, &["accuracy"]))));
}

/// the result as JavaScript holds it: the model's accuracy record rides along
fn result_json(r: &crate::backtest::BacktestResult, model: &Value) -> Value {
    let mut v = to_json(r);
    if let Value::Object(o) = &mut v {
        o.insert("accuracy".into(), g(model, &["accuracy"]).clone());
    }
    v
}

pub fn command(cmd: &str, f: &Flags, out: &mut Out) -> Result<Option<i32>, String> {
    let json = f.has("json");
    let pos = |i: usize| f.pos.get(i).cloned().unwrap_or_else(|| "undefined".into());
    let tf = |k: &str| super::sim::truthy_flag(f, k);
    Ok(Some(match cmd {
        "import" => {
            let t0 = std::time::Instant::now();
            let manifest = parse_yaml(&read(&pos(0))?)?;
            let mut fs = DiskFiles::for_manifest(&pos(0));
            let (dataset, log) = crate::import::manifest::import_bundle(&manifest, &mut fs)?;
            let default_out = {
                let p = pos(0);
                let dir = std::path::Path::new(&p).parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default();
                if dir.is_empty() { "dataset.json".to_string() } else { format!("{}/dataset.json", dir) }
            };
            let out_path = if tf("out") { f.get("out").unwrap() } else { default_out };
            let dv = to_json(&dataset);
            write(&out_path, &crate::convert::js_stringify(&dv))?;
            let logv = to_json(&log);
            if json {
                out.log(&pretty(&json!({ "log": logv, "out": out_path })));
                return Ok(Some(0));
            }
            let here = cwd();
            for l in &log {
                out.log(&format!("  {} {} {}{}", green("✓"), l.what, dim(&relative(&here, &l.file)), l.points.map(|p| dim(&format!(" · {} points", loc(p)))).unwrap_or_default()));
            }
            let d = &dv;
            let svc = g(d, &["services"]).as_object().map(|m| m.len()).unwrap_or(0);
            let eps = g(d, &["endpoints"]).as_object().map(|m| m.len()).unwrap_or(0);
            let (nb, step) = (n(d, &["n"]), n(d, &["stepS"]));
            let bill = if g(d, &["bill"]).is_null() { String::new() } else { format!(", bill ${}", js_to_fixed(n(d, &["bill", "total"]), 2)) };
            out.log(&format!("\n{}: {} services, {} endpoints, {} buckets of {}s ({} h){} {}\n", bold(&s(d, &["name"])), svc, eps, js_num(nb), js_num(step), js_to_fixed((nb * step) / 3600.0, 1), bill, dim(&format!("→ {} in {} ms", out_path, t0.elapsed().as_millis()))));
            0
        }
        "calibrate" => {
            let dv = read_json(&pos(0))?;
            let d = dataset_of(&dv)?;
            let mut o = crate::calibrate::CalibrateOptions::default();
            if tf("p99") || tf("errors") {
                let p99 = if tf("p99") { f.num("p99").unwrap() } else { d.hints.as_ref().and_then(|h| h.slo.as_ref()).map(|x| x.p99_ms).unwrap_or(500.0) };
                let err = if tf("errors") { f.num("errors").unwrap() } else { d.hints.as_ref().and_then(|h| h.slo.as_ref()).map(|x| x.error_rate).unwrap_or(0.01) };
                o.slo = Some(crate::model::Slo { p99_ms: p99, error_rate: err });
            }
            if tf("timeout") {
                o.timeout_ms = f.num("timeout");
            }
            let m = crate::calibrate::calibrate(&d, &o);
            let mut mv = to_json(&m);
            if tf("holdout") {
                let rec = crate::accuracy::holdout_accuracy(&d, &o, f.num("holdout"), None);
                if let Some(Value::Array(a)) = mv.get_mut("accuracy") {
                    a.push(to_json(&rec));
                }
            }
            let out_path = if tf("out") {
                f.get("out").unwrap()
            } else {
                let p = pos(0);
                let a = if let Some(x) = p.strip_suffix("dataset.json") { format!("{}model.json", x) } else if let Some(x) = p.strip_suffix("dataset") { format!("{}model.json", x) } else { p };
                if a.ends_with("model.json") {
                    a
                } else if let Some(x) = a.strip_suffix(".json") {
                    format!("{}.model.json", x)
                } else {
                    a
                }
            };
            write(&out_path, &pretty_indent(&mv, 1))?;
            if json {
                out.log(&pretty(&mv));
                return Ok(Some(0));
            }
            print_model(&mv, out);
            out.log(&dim(&format!("  model written to {}\n", out_path)));
            0
        }
        "backtest" => {
            let mv = read_json(&pos(0))?;
            let m = model_of(&mv)?;
            let mut d = dataset_of(&read_json(&pos(1))?)?;
            if tf("last") {
                d = last_window(d, &f.get("last").unwrap())?;
            }
            let strategies: Vec<Value> = f.pos.iter().skip(2).map(|p| read_any(p)).collect::<Result<_, _>>()?;
            let load = if tf("scale") || tf("peak") { Some(crate::backtest::LoadOpts { scale: if tf("scale") { f.num("scale") } else { None }, peak_rps: if tf("peak") { f.num("peak") } else { None } }) } else { None };
            let o = crate::backtest::BacktestOptions { draws: if tf("draws") { f.num("draws") } else { None }, load, ..Default::default() };
            let r = crate::backtest::backtest(&m, &d, &strategies, &o)?;
            let rv = result_json(&r, &mv);
            if !g(&rv, &["load"]).is_null() && !json {
                out.log(&dim(&format!("  history replayed at {}× its load (busiest moment {} req/s)", js_to_fixed(n(&rv, &["load", "factor"]), 2), js_num(js_round(n(&rv, &["load", "peakRps"]))))));
            }
            let mut written = vec![];
            if tf("md") {
                write(&f.get("md").unwrap(), &reports::backtest_markdown(&rv, &mv))?;
                written.push(f.get("md").unwrap());
            }
            if tf("html") {
                write(&f.get("html").unwrap(), &reports::backtest_html(&rv, &mv))?;
                written.push(f.get("html").unwrap());
            }
            if tf("comment") {
                write(&f.get("comment").unwrap(), &reports::pr_comment(&rv, if tf("title") { f.get("title") } else { None }.as_deref(), if tf("run-url") { f.get("run-url") } else { None }.as_deref()))?;
                written.push(f.get("comment").unwrap());
            }
            if tf("out") {
                write(&f.get("out").unwrap(), &crate::convert::js_stringify(&rv))?;
                written.push(f.get("out").unwrap());
            }
            if tf("card") {
                let idx = f.num("card-strategy").unwrap_or(0.0);
                write(&f.get("card").unwrap(), &crate::convert::js_stringify(&reports::card_data(&rv, idx as usize, 240)))?;
                written.push(f.get("card").unwrap());
            }
            if json {
                out.log(&pretty(&rv));
                return Ok(Some(0));
            }
            print_backtest(&rv, out);
            for w in written {
                out.log(&dim(&format!("  written {}", w)));
            }
            // exit 2 when a strategy adds time out of SLO (CI gate)
            let gate = match f.opt.get("gate") {
                None => None,
                Some(None) => Some(0.5),
                Some(Some(v)) if v.is_empty() => None,
                Some(Some(v)) => Some(crate::import::js_number(v)),
            };
            match gate {
                Some(t) if arr(&rv, &["strategies"]).iter().any(|x| n(x, &["delta", "minutesOutOfSlo", "p50"]) > t) => 2,
                _ => 0,
            }
        }
        "headroom" => {
            let mv = read_json(&pos(0))?;
            let m = model_of(&mv)?;
            let base = crate::backtest::base_plan(&m, None);
            let plan = match f.pos.get(1) {
                Some(p) => crate::strategy::apply_strategy(&m, &base, &crate::strategy::parse_strategy(&read_any(p)?)?)?.plan,
                None => base,
            };
            let bp = crate::accuracy::model_breaking_point(&m, Some(&plan), None, None, None);
            let bv = to_json(&bp);
            if json {
                out.log(&pretty(&bv));
                return Ok(Some(0));
            }
            let lim = match g(&bv, &["limitedBy"]).as_str() {
                Some(l) if l.starts_with("errors") => format!(", then {} cross the error SLO", yellow(l)),
                Some(l) if !l.is_empty() => format!(", then {} saturates", yellow(l)),
                _ => String::new(),
            };
            out.log(&format!("\nSustains {} with today's endpoint mix within SLO (p99 ≤ {} ms, errors ≤ {}%){}.\n", bold(&format!("{} req/s", js_to_fixed(n(&bv, &["rps"]), 1))), js_num(n(&mv, &["slo", "p99Ms"])), js_to_fixed(n(&mv, &["slo", "errorRate"]) * 100.0, 1), lim));
            print_accuracy(&mv, out);
            out.log("");
            0
        }
        "accuracy" => {
            let mv = read_json(&pos(0))?;
            if json {
                out.log(&pretty(g(&mv, &["accuracy"])));
                return Ok(Some(0));
            }
            out.log(&format!("\n{}", bold(&s(&mv, &["name"]))));
            print_accuracy(&mv, out);
            out.log("");
            0
        }
        "outage" => {
            let outages: Vec<Value> = serde_json::from_str(include_str!("outages.json")).map_err(|e| e.to_string())?;
            let which = f.pos.get(1).cloned().unwrap_or_default();
            if which.is_empty() || which == "list" {
                for o in &outages {
                    out.log(&format!("  {} {}\n  {} {}", bold(&pad_end(&s(o, &["id"]), 24)), s(o, &["title"]), pad_end("", 24), dim(&s(o, &["what"]))));
                }
                return Ok(Some(0));
            }
            let mv = read_json(&pos(0))?;
            let m = model_of(&mv)?;
            let ov = outages.iter().find(|o| s(o, &["id"]) == which).cloned().ok_or_else(|| format!("no outage \"{}\" — try `outage <model> list`", which))?;
            let outage: crate::resilience::Outage = serde_json::from_value(ov.clone()).map_err(|e| e.to_string())?;
            let mut roles: crate::types::Map<Vec<String>> = crate::types::Map::new();
            for kv in f.get("role").filter(|_| tf("role")).unwrap_or_default().split(',').filter(|x| !x.is_empty()) {
                let mut it = kv.splitn(2, '=');
                let r = it.next().unwrap_or("").to_string();
                let v = it.next().unwrap_or("");
                roles.insert(r, v.split('+').map(String::from).collect());
            }
            let strategies: Vec<Value> = f.pos.iter().skip(2).map(|p| read_any(p)).collect::<Result<_, _>>()?;
            let (replay, result) = crate::resilience::replay_outage(&m, &outage, &strategies, if tf("rps") { f.num("rps") } else { None }, &roles, None)?;
            let rv = result_json(&result, &mv);
            if tf("md") {
                write(&f.get("md").unwrap(), &reports::backtest_markdown(&rv, &mv))?;
            }
            if tf("html") {
                write(&f.get("html").unwrap(), &reports::backtest_html(&rv, &mv))?;
            }
            let pv = to_json(&replay);
            if json {
                let mut o = JMap::new();
                o.insert("roles".into(), g(&pv, &["roles"]).clone());
                o.insert("warnings".into(), g(&pv, &["warnings"]).clone());
                o.insert("result".into(), rv);
                out.log(&pretty(&Value::Object(o)));
                return Ok(Some(0));
            }
            out.log(&format!("\n{}\n{}", bold(&s(&ov, &["title"])), dim(&s(&ov, &["what"]))));
            for t in arr(&ov, &["timeline"]) {
                out.log(&format!("  {} {}", dim(&pad_end(&s(t, &["at"]), 12)), s(t, &["text"])));
            }
            out.log(&format!("\n  replayed against {} at {} req/s normal load{}", bold(&s(&mv, &["name"])), js_to_fixed(n(&pv, &["baseRps"]), 1), if tf("rps") { "" } else { " (p90 of its history)" }));
            if let Some(roles) = g(&pv, &["roles"]).as_object() {
                for (r, svcs) in roles {
                    let list: Vec<String> = svcs.as_array().map(|a| a.iter().map(|x| s(x, &[])).collect()).unwrap_or_default();
                    out.log(&format!("  {} {}", dim(&pad_end(&format!("{}:", r), 14)), if list.is_empty() { yellow("nothing in this model") } else { list.join(", ") }));
                }
            }
            for w in arr(&pv, &["warnings"]) {
                out.log(&yellow(&format!("  {}", s(w, &[]))));
            }
            let verdict = |x: &Value| {
                let m = n(x, &["summary", "minutesOutOfSlo", "p50"]);
                if m < 1.0 {
                    green("survives")
                } else {
                    red(&format!("{} min out of SLO, {} failed requests", js_num(js_round(m)), loc(js_round(n(x, &["summary", "failedRequests", "p50"])))))
                }
            };
            out.log(&format!("\n  {} {}   {}", pad_end("As built", 30), verdict(g(&rv, &["baseline"])), dim(&s(&rv, &["baseline", "worst", "why"]))));
            for st in arr(&rv, &["strategies"]) {
                out.log(&format!("  {} {}", pad_end(&s(st, &["name"]), 30), verdict(st)));
            }
            let assumptions: Vec<String> = arr(&ov, &["assumptions"]).iter().map(|x| s(x, &[])).collect();
            let sources: Vec<String> = arr(&ov, &["sources"]).iter().map(|x| s(x, &["url"])).collect();
            out.log(&dim(&format!("\n  assumptions: {}\n  source: {}", assumptions.join(" "), sources.join(" "))));
            out.log(&format!("{}\n", accuracy_line(&arr(&mv, &["accuracy"]))));
            0
        }
        _ => return Ok(None),
    }))
}
