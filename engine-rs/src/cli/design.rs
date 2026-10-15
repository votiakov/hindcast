//! analyze, optimize, audit (with its Markdown and HTML reports), catalog and link.

use super::util::*;
use crate::math::{js_num, js_round, js_to_fixed};
use serde_json::{json, Map as JMap, Value};

fn g<'a>(v: &'a Value, path: &[&str]) -> &'a Value {
    let mut x = v;
    for k in path {
        x = x.get(*k).unwrap_or(&Value::Null);
    }
    x
}
fn n(v: &Value, path: &[&str]) -> f64 {
    g(v, path).as_f64().unwrap_or(f64::NAN)
}
fn s(v: &Value, path: &[&str]) -> String {
    match g(v, path) {
        Value::String(x) => x.clone(),
        Value::Null => String::new(),
        x => crate::convert::js_stringify(x),
    }
}
/// `${x ?? '—'}`
fn or_dash(v: &Value, path: &[&str]) -> String {
    match g(v, path) {
        Value::Null => "—".into(),
        _ => s(v, path),
    }
}
fn arr<'a>(v: &'a Value, path: &[&str]) -> Vec<&'a Value> {
    g(v, path).as_array().map(|a| a.iter().collect()).unwrap_or_default()
}
fn opt_num(x: f64) -> Value {
    serde_json::Number::from_f64(x).map(Value::Number).unwrap_or(Value::Null)
}

pub fn command(cmd: &str, f: &Flags, out: &mut Out, scenario: &dyn Fn(Option<&str>, &mut Out) -> Result<Value, String>) -> Result<Option<i32>, String> {
    let json = f.has("json");
    let pos = |i: usize| f.pos.get(i).cloned().unwrap_or_else(|| "undefined".into());
    let slo_of = |f: &Flags| {
        let mut slo = JMap::new();
        if super::sim::truthy_flag(f, "p99") {
            slo.insert("maxP99Ms".into(), opt_num(f.num("p99").unwrap_or(f64::NAN)));
        }
        if super::sim::truthy_flag(f, "errors") {
            slo.insert("maxErrorRate".into(), opt_num(f.num("errors").unwrap_or(f64::NAN)));
        }
        Value::Object(slo)
    };
    Ok(Some(match cmd {
        "analyze" => {
            let spec = load(&pos(0))?;
            let sc = scenario(f.pos.get(1).map(|x| x.as_str()), out)?;
            let runs = if super::sim::truthy_flag(f, "runs") { f.num("runs").unwrap_or(20.0) } else { 20.0 };
            let seed = if super::sim::truthy_flag(f, "seed") { f.num("seed").unwrap_or(1.0) } else { 1.0 };
            let a = crate::sim::optimize::analyze(&spec, &sc, &crate::sim::optimize::AnalyzeOptions { runs: Some(runs), seed: Some(seed), des: None })?;
            let v = to_json(&a);
            if json {
                out.log(&pretty(&v));
            } else {
                print_analysis(&v, out);
            }
            0
        }
        "optimize" => {
            let spec = load(&pos(0))?;
            let sc = scenario(f.pos.get(1).map(|x| x.as_str()), out)?;
            let o = crate::sim::optimize::OptimizeOptions { allow_runtimes: Some(f.has("runtimes")), slo: Some(slo_of(f)), ..Default::default() };
            let r = crate::sim::optimize::optimize(&spec, &sc, &o)?;
            if let Some(p) = f.get("out").filter(|_| super::sim::truthy_flag(f, "out")) {
                write(&p, &crate::yaml_out::spec_to_yaml(&r.spec))?;
            }
            let mut v = to_json(&r);
            if json {
                if let Value::Object(m) = &mut v {
                    m.shift_remove("spec");
                }
                out.log(&pretty(&v));
                return Ok(Some(0));
            }
            let feasible = g(&v, &["feasible"]).as_bool().unwrap_or(false);
            out.log(&format!("\n{}  {}", if feasible { green("✓ SLO can be met") } else { red("✗ SLO cannot be met by sizing alone — change the design") }, dim(&format!("({} simulations)", js_num(n(&v, &["evaluations"]))))));
            out.log(&format!("  before  ${}/month, in SLO {} of the time", loc(n(&v, &["before", "monthly"])), pct(n(&v, &["before", "sloCompliance"]))));
            let sav = n(&v, &["monthlySavings"]);
            out.log(&format!("  after   ${}/month, in SLO {} of the time   {}", loc(n(&v, &["after", "monthly"])), pct(n(&v, &["after", "sloCompliance"])), if sav >= 0.0 { green(&format!("saves ${}/month", loc(sav))) } else { yellow(&format!("costs ${}/month more", loc(-sav))) }));
            let changes = arr(&v, &["changes"]);
            if !changes.is_empty() {
                let lines: Vec<String> = changes
                    .iter()
                    .map(|ch| {
                        if s(ch, &["op"]) == "set" {
                            let fields = g(ch, &["fields"]).as_object().map(|m| m.iter().map(|(k, x)| format!("{} → {}", k, template(x))).collect::<Vec<_>>().join(", ")).unwrap_or_default();
                            format!("  • {}: {}", s(ch, &["id"]), fields)
                        } else {
                            format!("  • {}", crate::convert::js_stringify(ch))
                        }
                    })
                    .collect();
                out.log(&format!("\n  {}\n{}", bold("Changes"), lines.join("\n")));
            }
            let log: Vec<String> = arr(&v, &["log"]).iter().map(|l| format!("  {}", dim(l.as_str().unwrap_or("")))).collect();
            out.log(&format!("\n  {}\n{}", bold("How it got there"), log.join("\n")));
            if let Some(p) = f.get("out").filter(|_| super::sim::truthy_flag(f, "out")) {
                out.log(&format!("\n  optimized spec written to {}", p));
            }
            out.log("");
            0
        }
        "audit" => {
            let spec = load(&pos(0))?;
            let arch = crate::sim::spec::parse_architecture(&spec)?;
            let o = crate::sim::audit::AuditOptions {
                rps: if super::sim::truthy_flag(f, "rps") { f.num("rps") } else { None },
                incident_cost_per_minute: if super::sim::truthy_flag(f, "cost-per-min") { f.num("cost-per-min") } else { None },
                slo: Some(slo_of(f)),
                ..Default::default()
            };
            let r = crate::sim::audit::audit(&arch, &o, &mut |_, _, _| {})?;
            let v = to_json(&r);
            if let Some(p) = f.get("md").filter(|_| super::sim::truthy_flag(f, "md")) {
                write(&p, &audit_markdown(&v))?;
            }
            if let Some(p) = f.get("html").filter(|_| super::sim::truthy_flag(f, "html")) {
                write(&p, &audit_html(&v, &today()))?;
            }
            if json {
                out.log(&pretty(&v));
                return Ok(Some(0));
            }
            print_audit(&v, out);
            for k in ["md", "html"] {
                if let Some(p) = f.get(k).filter(|_| super::sim::truthy_flag(f, k)) {
                    out.log(&dim(&format!("  report written to {}", p)));
                }
            }
            if arr(&v, &["findings"]).iter().any(|x| s(x, &["severity"]) == "critical") {
                2
            } else {
                0
            }
        }
        "link" => {
            let input = load(&pos(0))?;
            let (arch, issues) = crate::sim::spec::check_architecture(&input);
            if arch.is_none() {
                return Err(crate::sim::spec::issues_message(&issues));
            }
            let base = super::sim::canonical_spec(&input);
            let app = std::env::var("HINDCAST_APP_URL").or_else(|_| std::env::var("BOTTLENECK_APP_URL")).unwrap_or_else(|_| "http://localhost:5173".into());
            if let Some(vp) = f.pos.get(1) {
                let (variants, vsc) = super::sim::variants_file(vp)?;
                let v = variants.first().cloned().unwrap_or(Value::Null);
                let b = apply_variant(&base, &v)?;
                let mut payload = JMap::new();
                payload.insert("a".into(), json!({ "title": base.get("name").cloned().unwrap_or(json!("baseline")), "spec": base }));
                payload.insert("b".into(), json!({ "title": v.get("name").cloned().unwrap_or(Value::Null), "spec": b }));
                if let Some(sc) = vsc {
                    payload.insert("scenario".into(), sc);
                }
                out.log(&format!("{}/#compare={}", app, encode_payload(&Value::Object(payload))));
            } else {
                out.log(&format!("{}/#spec={}", app, encode_payload(&base)));
            }
            0
        }
        "catalog" => {
            let c: Value = serde_json::from_str(include_str!("catalog.json")).map_err(|e| e.to_string())?;
            out.log(&pretty(&c));
            0
        }
        _ => return Ok(None),
    }))
}

/// `${v}` in a template string
fn template(v: &Value) -> String {
    match v {
        Value::String(x) => x.clone(),
        Value::Number(x) => js_num(x.as_f64().unwrap_or(f64::NAN)),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".into(),
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { template(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn today() -> String {
    crate::accuracy::now_iso()[..10].to_string()
}

fn print_analysis(a: &Value, out: &mut Out) {
    let st = |k: &str, fmt: &dyn Fn(f64) -> String| format!("{} {}", fmt(n(a, &["metrics", k, "mean"])), dim(&format!("± {}", fmt(n(a, &["metrics", k, "ci95"])))));
    out.log(&format!("\n{} {} {} {}", bold(&s(a, &["architecture"])), dim("·"), s(a, &["scenario"]), dim(&format!("· {} runs · {} events · {} ms", js_num(n(a, &["runs"])), loc(n(a, &["events"])), js_num(n(a, &["wallMs"]))))));
    let p = n(a, &["pSloMet"]);
    out.log(&format!("  SLO met in {} of runs {}", if p >= 0.95 { green(&pct(p)) } else { red(&pct(p)) }, dim(&format!("(time-in-SLO {} ± {})", pct(n(a, &["metrics", "sloCompliance", "mean"])), pct(n(a, &["metrics", "sloCompliance", "ci95"]))))));
    out.log(&format!("  errors   {}   {}", st("errorRate", &pct), dim(&format!("peak {}", pct(n(a, &["metrics", "peakErrorRate", "mean"]))))));
    out.log(&format!("  latency  p50 {}   p99 {}   p99.9 {}", st("p50Ms", &ms), st("p99Ms", &ms), st("p999Ms", &ms)));
    let c = n(a, &["metrics", "costPerHour", "mean"]);
    out.log(&format!("  cost     ${}/h {}", js_to_fixed(c, 2), dim(&format!("≈ ${}/month", loc(js_round(c * 730.0))))));
    for b in arr(a, &["bottlenecks"]) {
        out.log(&format!("  {} top bottleneck in {} of runs {}", yellow(&pad(&s(b, &["id"]), 14)), pct(n(b, &["share"])), dim(&s(b, &["note"]))));
    }
    out.log("");
}

fn print_audit(r: &Value, out: &mut Out) {
    let sev = |x: &str| match x {
        "critical" => red("CRITICAL"),
        "major" => yellow("MAJOR   "),
        "minor" => dim("minor   "),
        _ => green("ok      "),
    };
    let score = n(r, &["score"]);
    let sc = if score >= 80.0 { green(&js_num(score)) } else if score >= 50.0 { yellow(&js_num(score)) } else { red(&js_num(score)) };
    let findings = arr(r, &["findings"]);
    out.log(&format!("\n{} {} failure audit at {} req/s {}", bold(&s(r, &["architecture"])), dim("·"), js_num(n(r, &["load", "rps"])), dim(&format!("· {} scenarios · {} ms", findings.len(), js_num(n(r, &["wallMs"]))))));
    out.log(&format!("  resilience {}/100 {}", sc, dim(&format!("— survives {} of {} incidents within SLO", js_num(n(r, &["survived"])), js_num(n(r, &["total"]))))));
    let weakest = arr(r, &["availability", "weakest"]).first().map(|w| format!(", {} the weakest link", s(w, &["name"]))).unwrap_or_default();
    out.log(&format!("  available  {} {}", avail_pct(n(r, &["availability", "estimate"])), dim(&format!("— by design, about {} of downtime a year{}", downtime(n(r, &["availability", "downtimeHoursPerYear"])), weakest))));
    out.log(&format!("  headroom   {}× {}   cost ${}/month\n", js_to_fixed(n(r, &["headroom", "ratio"]), 1), dim(&format!("({} req/s, then {})", js_num(js_round(n(r, &["headroom", "maxRps"]))), or_dash(r, &["headroom", "limitedBy"]))), loc(n(r, &["baseline", "monthly"]))));
    for f in &findings {
        out.log(&format!("  {} {} {}", sev(&s(f, &["severity"])), bold(&pad(&s(f, &["title"]), 36)), dim(&s(f, &["explanation"]))));
        let risk = n(f, &["costAtRisk"]);
        if risk.is_finite() && risk != 0.0 {
            out.log(&format!("           {}", red(&format!("${} at risk per incident", loc(risk)))));
        }
        for x in arr(f, &["fixes"]) {
            let d = n(x, &["monthlyDelta"]);
            out.log(&format!("           {} {} {}", green("fix"), s(x, &["title"]), dim(&format!("→ {}, {}${}/month", s(x, &["after", "severity"]), if d >= 0.0 { "+" } else { "−" }, loc(d.abs())))));
        }
    }
    out.log("");
}

// ---- the audit as Markdown (src/sim/auditReport.ts) ----

fn apct(x: f64) -> String {
    format!("{}%", js_to_fixed(x * 100.0, if x > 0.0 && x < 0.01 { 2 } else { 1 }))
}
fn ams(x: f64) -> String {
    if x >= 1000.0 {
        format!("{} s", js_to_fixed(x / 1000.0, 1))
    } else {
        format!("{} ms", js_num(x))
    }
}
/// downtime a year, in hours or (under one) minutes
fn downtime(hours: f64) -> String {
    if hours >= 1.0 {
        format!("{} h", js_num(hours))
    } else {
        format!("{} min", js_num(js_round(hours * 60.0)))
    }
}
/// an availability with as many decimals as its nines need: 99.5%, 99.95%, 99.995%
fn avail_pct(x: f64) -> String {
    let nines = if x >= 1.0 { 6.0 } else { -(1.0 - x).log10() };
    format!("{}%", js_to_fixed(x * 100.0, (nines.floor() as i32 - 1).clamp(1, 4) as u32 as _))
}
fn sev_name(x: &str) -> &'static str {
    match x {
        "critical" => "Critical",
        "major" => "Major",
        "minor" => "Minor",
        _ => "OK",
    }
}

fn change_text(fix: &Value) -> String {
    arr(fix, &["changes"])
        .iter()
        .map(|c| match s(c, &["op"]).as_str() {
            "set" => format!("{}: {}", s(c, &["id"]), g(c, &["fields"]).as_object().map(|m| m.iter().map(|(k, v)| format!("{} = {}", k, if v.is_object() || v.is_array() || v.is_null() { crate::convert::js_stringify(v) } else { template(v) })).collect::<Vec<_>>().join(", ")).unwrap_or_default()),
            "add" => format!("add {} ({})", s(c, &["component", "id"]), s(c, &["component", "kind"])),
            "remove" => format!("remove {}", s(c, &["id"])),
            "connect" => format!("connect {} → {}", s(c, &["from"]), s(c, &["to"])),
            "disconnect" => format!("disconnect {} → {}", s(c, &["from"]), s(c, &["to"])),
            _ => "undefined".into(),
        })
        .collect::<Vec<_>>()
        .join("; ")
}

pub fn audit_markdown(r: &Value) -> String {
    let money = |x: f64| format!("{}${}", if x < 0.0 { "−" } else { "" }, loc(x.abs()));
    let mut l: Vec<String> = vec![];
    let findings = arr(r, &["findings"]);
    let bad: Vec<&&Value> = findings.iter().filter(|f| matches!(s(f, &["severity"]).as_str(), "critical" | "major")).collect();
    l.push(format!("# Failure audit — {}", s(r, &["architecture"])));
    l.push(String::new());
    l.push(format!("At **{} req/s** ({}% reads), SLO: errors ≤ {}, p99 ≤ {}.", loc(n(r, &["load", "rps"])), js_num(js_round(n(r, &["load", "readRatio"]) * 100.0)), apct(n(r, &["slo", "maxErrorRate"])), ams(n(r, &["slo", "maxP99Ms"]))));
    l.push(String::new());
    l.push("| | |".into());
    l.push("|---|---|".into());
    l.push(format!("| Resilience score | **{}/100** — survives {} of {} incidents within SLO |", js_num(n(r, &["score"])), js_num(n(r, &["survived"])), js_num(n(r, &["total"]))));
    let weak: Vec<String> = arr(r, &["availability", "weakest"]).iter().map(|w| format!("{} ({})", s(w, &["name"]), downtime(n(w, &["downtimeHoursPerYear"])))).collect();
    l.push(format!(
        "| Availability by design | {} — about {} of downtime a year{} |",
        avail_pct(n(r, &["availability", "estimate"])),
        downtime(n(r, &["availability", "downtimeHoursPerYear"])),
        if weak.is_empty() { String::new() } else { format!("; costs the most: {}", weak.join(", ")) }
    ));
    l.push(format!("| Headroom | {}× — {} req/s, then **{}** gives out |", js_to_fixed(n(r, &["headroom", "ratio"]), 1), loc(js_round(n(r, &["headroom", "maxRps"]))), or_dash(r, &["headroom", "limitedBy"])));
    l.push(format!("| Normal operation | errors {}, p99 {}, {}/month{} |", apct(n(r, &["baseline", "errorRate"])), ams(n(r, &["baseline", "p99Ms"])), money(n(r, &["baseline", "monthly"])), if g(r, &["baseline", "meetsSlo"]).as_bool().unwrap_or(false) { "" } else { " — **already outside the SLO**" }));
    l.push(String::new());
    if !bad.is_empty() {
        l.push("## What breaks first".into());
        l.push(String::new());
        l.push("| severity | incident | users see | recovers | blast radius | best verified fix | $/month |".into());
        l.push("|---|---|---|---|---|---|---|".into());
        for f in &bad {
            let fixes = arr(f, &["fixes"]);
            let fix = fixes.first();
            let rec = match (g(f, &["impact", "recoveryS"]), g(f, &["impact", "selfHealS"])) {
                (Value::Null, _) => "**never** (metastable)".to_string(),
                (_, Value::Number(h)) if h.as_f64().unwrap_or(0.0) > 0.0 => format!("by itself in {} s", js_num(h.as_f64().unwrap())),
                (rv, _) => format!("{} s after fix", template(rv)),
            };
            let blast: Vec<String> = arr(f, &["blastRadius"]).iter().map(|b| template(b)).collect();
            l.push(format!(
                "| {} | {} | {} errors, p99 {} | {} | {} | {} | {} |",
                sev_name(&s(f, &["severity"])),
                s(f, &["title"]),
                apct(n(f, &["impact", "errorRate"])),
                ams(n(f, &["impact", "peakP99Ms"])),
                if s(f, &["kind"]) == "headroom" { "—".to_string() } else { rec },
                if blast.is_empty() { "—".to_string() } else { blast.join(", ") },
                fix.map(|x| format!("{} → {}", s(x, &["title"]), sev_name(&s(x, &["after", "severity"])).to_lowercase())).unwrap_or_else(|| "—".into()),
                fix.map(|x| money(n(x, &["monthlyDelta"]))).unwrap_or_default()
            ));
        }
        l.push(String::new());
    }
    l.push("## All incidents".into());
    l.push(String::new());
    for f in &findings {
        l.push(format!("### {}: {}", sev_name(&s(f, &["severity"])), s(f, &["title"])));
        l.push(String::new());
        l.push(s(f, &["explanation"]));
        let risk = n(f, &["costAtRisk"]);
        if risk.is_finite() && risk != 0.0 {
            l.push(format!("\n**{} at risk** per incident.", money(risk)));
        }
        let fixes = arr(f, &["fixes"]);
        if !fixes.is_empty() {
            l.push(String::new());
            l.push("Verified fixes (re-ran the same incident):".into());
            l.push(String::new());
            for x in fixes {
                let e = n(x, &["after", "errorRate"]);
                l.push(format!("- **{}** — {} After: {}{}. {}/month. `{}`", s(x, &["title"]), s(x, &["why"]), sev_name(&s(x, &["after", "severity"])).to_lowercase(), if e.is_finite() && e != 0.0 { format!(", {} errors", apct(e)) } else { String::new() }, money(n(x, &["monthlyDelta"])), change_text(x)));
            }
        }
        l.push(String::new());
    }
    l.push("---".into());
    l.push("Generated by Hindcast. Each incident: 10 s warm-up, fault at t = 10 s, cleared at t = 40 s, observed to t = 60 s. Results are directional — calibrate capacity, latency and price per component for real-system claims.".into());
    l.join("\n")
}

// ---- the audit as one HTML file (src/sim/auditHtml.ts) ----

fn esc(x: &str) -> String {
    x.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn curve_svg(r: &Value) -> String {
    let c = arr(r, &["curve"]);
    if c.len() < 2 {
        return String::new();
    }
    let (w, h) = (720.0, 200.0);
    let (pl, pr, pt, pb) = (44.0, 12.0, 12.0, 28.0);
    let max_x = n(c[c.len() - 1], &["rps"]);
    let slo = n(r, &["slo", "maxP99Ms"]);
    let top = c.iter().fold(f64::NEG_INFINITY, |a, p| crate::backtest::js_max(a, std::iter::once(n(p, &["p99Ms"]))));
    let y_max = crate::backtest::js_max(slo * 3.0, std::iter::once(top.min(slo * 6.0)));
    let x = |v: f64| pl + (v / max_x) * (w - pl - pr);
    let yl = |v: f64| h - pb - (v.min(y_max) / y_max) * (h - pt - pb);
    let ye = |v: f64| h - pb - v.min(1.0) * (h - pt - pb);
    let lat: Vec<String> = c.iter().enumerate().map(|(i, p)| format!("{}{},{}", if i > 0 { "L" } else { "M" }, js_to_fixed(x(n(p, &["rps"])), 1), js_to_fixed(yl(n(p, &["p99Ms"])), 1))).collect();
    let err = format!("M{},{} {} L{},{} Z", js_num(x(n(c[0], &["rps"]))), js_num(h - pb), c.iter().map(|p| format!("L{},{}", js_to_fixed(x(n(p, &["rps"])), 1), js_to_fixed(ye(n(p, &["errorRate"])), 1))).collect::<Vec<_>>().join(" "), js_num(x(max_x)), js_num(h - pb));
    let ticks: Vec<f64> = [0.0, 0.25, 0.5, 0.75, 1.0].iter().map(|f| js_round(max_x * f)).collect();
    let rps = n(r, &["load", "rps"]);
    let max_rps = n(r, &["headroom", "maxRps"]);
    let lim = if max_rps < max_x { format!("<line x1=\"{}\" x2=\"{}\" y1=\"{}\" y2=\"{}\" class=\"lim\"/><text x=\"{}\" y=\"{}\" class=\"t bad\">breaks at {}</text>", js_num(x(max_rps)), js_num(x(max_rps)), js_num(pt), js_num(h - pb), js_num(x(max_rps) + 4.0), js_num(pt + 24.0), loc(js_round(max_rps))) } else { String::new() };
    format!(
        "<svg viewBox=\"0 0 {w} {h}\" role=\"img\" aria-label=\"Load curve: p99 latency and error rate against request rate\">
  <line x1=\"{pl}\" x2=\"{x2}\" y1=\"{ys}\" y2=\"{ys}\" class=\"slo\"/>
  <text x=\"{x2}\" y=\"{ys4}\" text-anchor=\"end\" class=\"t\">p99 SLO {slo} ms</text>
  <path d=\"{err}\" class=\"err\"/>
  <path d=\"{lat}\" class=\"lat\"/>
  <line x1=\"{xr}\" x2=\"{xr}\" y1=\"{pt}\" y2=\"{yb}\" class=\"now\"/>
  <text x=\"{xr4}\" y=\"{pt10}\" class=\"t\">expected {rps} req/s</text>
  {lim}
  <line x1=\"{pl}\" x2=\"{x2}\" y1=\"{yb}\" y2=\"{yb}\" class=\"axis\"/>
  {ticks}
  <text x=\"{pl6}\" y=\"{ymax4}\" text-anchor=\"end\" class=\"t\">{ymaxms}</text>
  <text x=\"{pl6}\" y=\"{y0}\" text-anchor=\"end\" class=\"t\">0</text>
</svg>
<p class=\"legend\"><span class=\"k lat\"></span> p99 latency <span class=\"k err\"></span> share of requests failing (0–100%) · x: req/s, steady state</p>",
        w = js_num(w),
        h = js_num(h),
        pl = js_num(pl),
        x2 = js_num(w - pr),
        ys = js_num(yl(slo)),
        ys4 = js_num(yl(slo) - 4.0),
        slo = js_num(slo),
        err = err,
        lat = lat.join(" "),
        xr = js_num(x(rps)),
        pt = js_num(pt),
        yb = js_num(h - pb),
        xr4 = js_num(x(rps) + 4.0),
        pt10 = js_num(pt + 10.0),
        rps = loc(rps),
        lim = lim,
        ticks = ticks.iter().map(|t| format!("<text x=\"{}\" y=\"{}\" text-anchor=\"middle\" class=\"t\">{}</text>", js_num(x(*t)), js_num(h - 10.0), loc(*t))).collect::<Vec<_>>().join(""),
        pl6 = js_num(pl - 6.0),
        ymax4 = js_num(yl(y_max) + 4.0),
        ymaxms = ams(js_round(y_max)),
        y0 = js_num(yl(0.0)),
    )
}

fn html_finding(f: &Value) -> String {
    let money = |x: f64| format!("{}${}", if x < 0.0 { "−" } else if x > 0.0 { "+" } else { "" }, loc(x.abs()));
    let kind = s(f, &["kind"]);
    let sev = s(f, &["severity"]);
    let heal = g(f, &["impact", "selfHealS"]).as_f64();
    let rec = if kind == "headroom" {
        String::new()
    } else if kind == "surge" {
        match heal {
            Some(h) if h > 24.0 => format!("back within SLO {} s after the surge", js_num(h - 24.0)),
            _ => "held through the surge".into(),
        }
    } else if g(f, &["impact", "recoveryS"]).is_null() {
        "never recovers (metastable)".into()
    } else if heal.map(|h| h > 0.0).unwrap_or(false) {
        format!("heals by itself in {} s", js_num(heal.unwrap()))
    } else if sev == "ok" {
        "absorbed".into()
    } else {
        format!("recovers {} s after the fault clears", template(g(f, &["impact", "recoveryS"])))
    };
    let risk = n(f, &["costAtRisk"]);
    let blast = arr(f, &["blastRadius"]);
    let facts = if kind != "headroom" {
        format!(
            "<p class=\"facts\">peak p99 <b>{}</b> · out of SLO <b>{} s</b> · {}{}{}</p>",
            ams(n(f, &["impact", "peakP99Ms"])),
            js_num(n(f, &["impact", "breachS"])),
            rec,
            if risk.is_finite() && risk != 0.0 { format!(" · <b class=\"bad\">${}</b> at risk", loc(risk)) } else { String::new() },
            if blast.is_empty() { String::new() } else { format!(" · blast radius: {}", blast.iter().map(|b| format!("<code>{}</code>", esc(&template(b)))).collect::<Vec<_>>().join(" ")) }
        )
    } else {
        String::new()
    };
    let fixes = arr(f, &["fixes"]);
    let table = if fixes.is_empty() {
        String::new()
    } else {
        format!(
            "<table class=\"fixes\"><thead><tr><th>verified fix</th><th>after</th><th>$/month</th></tr></thead><tbody>{}</tbody></table>",
            fixes
                .iter()
                .map(|x| {
                    let e = n(x, &["after", "errorRate"]);
                    format!("<tr><td><b>{}</b><br><span>{}</span></td><td class=\"sev-{}\">{}{}</td><td class=\"num\">{}</td></tr>", esc(&s(x, &["title"])), esc(&s(x, &["why"])), s(x, &["after", "severity"]), sev_name(&s(x, &["after", "severity"])), if e.is_finite() && e != 0.0 { format!(", {}", apct(e)) } else { String::new() }, money(n(x, &["monthlyDelta"])))
                })
                .collect::<Vec<_>>()
                .join("")
        )
    };
    format!("<section class=\"f sev-{}\">\n  <h3><span class=\"sev\">{}</span> {}</h3>\n  <p>{}</p>\n  {}\n  {}\n</section>", sev, sev_name(&sev), esc(&s(f, &["title"])), esc(&s(f, &["explanation"])), facts, table)
}

pub fn audit_html(r: &Value, date: &str) -> String {
    let money = |x: f64| format!("{}${}", if x < 0.0 { "−" } else if x > 0.0 { "+" } else { "" }, loc(x.abs()));
    let findings = arr(r, &["findings"]);
    let bad: Vec<&&Value> = findings.iter().filter(|f| matches!(s(f, &["severity"]).as_str(), "critical" | "major")).collect();
    let score = n(r, &["score"]);
    let arch = esc(&s(r, &["architecture"]));
    let breaks = if bad.is_empty() {
        String::new()
    } else {
        format!(
            "<h2>What breaks first</h2><table><thead><tr><th>incident</th><th>users see</th><th>best verified fix</th><th>$/month</th></tr></thead><tbody>{}</tbody></table>",
            bad.iter()
                .map(|f| {
                    let fixes = arr(f, &["fixes"]);
                    let fix = fixes.first();
                    format!(
                        "<tr><td class=\"sev-{}\"><b>{}</b> {}</td><td>{}</td><td>{}</td><td class=\"num\">{}</td></tr>",
                        s(f, &["severity"]),
                        sev_name(&s(f, &["severity"])),
                        esc(&s(f, &["title"])),
                        if s(f, &["kind"]) == "headroom" { "—".to_string() } else { format!("{} errors, p99 {}", apct(n(f, &["impact", "errorRate"])), ams(n(f, &["impact", "peakP99Ms"]))) },
                        fix.map(|x| format!("{} → {}", esc(&s(x, &["title"])), sev_name(&s(x, &["after", "severity"])).to_lowercase())).unwrap_or_else(|| "<span>needs a design decision</span>".into()),
                        fix.map(|x| money(n(x, &["monthlyDelta"]))).unwrap_or_default()
                    )
                })
                .collect::<Vec<_>>()
                .join("")
        )
    };
    let mut html = String::from(HTML_HEAD);
    html = html.replace("{ARCH}", &arch);
    html += &format!(
        "<h1>Failure audit — {arch}</h1>
<p class=\"sub\">At {rps} req/s ({reads}% reads). SLO: errors ≤ {err}, p99 ≤ {p99}.</p>
<div class=\"kpis\">
  <div class=\"kpi\"><b class=\"{cls}\">{score}<small style=\"font-size:14px;letter-spacing:0\">/100</small></b><span>resilience — survives {surv} of {total} incidents</span></div>
  <div class=\"kpi\"><b>{avail}</b><span>availability by design — {downh} of downtime a year</span></div>
  <div class=\"kpi\"><b>{ratio}×</b><span>headroom — {maxrps} req/s, then {lim}</span></div>
  <div class=\"kpi\"><b>${monthly}</b><span>per month at this load{outside}</span></div>
</div>
<h2>Load curve</h2>
{curve}
{breaks}
<h2>Every incident</h2>
{findings}
<footer>Generated by Hindcast on {date}. Each incident: 10 s warm-up, fault at t = 10 s, cleared at t = 40 s, observed to t = 60 s; fixes were verified by re-running the same incident. Results are directional — calibrate capacity, latency and price per component before making claims about a real system.</footer>
</main>
</body>
</html>",
        arch = arch,
        rps = loc(n(r, &["load", "rps"])),
        reads = js_num(js_round(n(r, &["load", "readRatio"]) * 100.0)),
        err = apct(n(r, &["slo", "maxErrorRate"])),
        p99 = ams(n(r, &["slo", "maxP99Ms"])),
        cls = if score >= 80.0 { "good" } else if score >= 50.0 { "warn" } else { "bad" },
        score = js_num(score),
        surv = js_num(n(r, &["survived"])),
        total = js_num(n(r, &["total"])),
        avail = avail_pct(n(r, &["availability", "estimate"])),
        downh = downtime(n(r, &["availability", "downtimeHoursPerYear"])),
        ratio = js_to_fixed(n(r, &["headroom", "ratio"]), 1),
        maxrps = loc(js_round(n(r, &["headroom", "maxRps"]))),
        lim = esc(&or_dash(r, &["headroom", "limitedBy"])),
        monthly = loc(n(r, &["baseline", "monthly"])),
        outside = if g(r, &["baseline", "meetsSlo"]).as_bool().unwrap_or(false) { "" } else { " — <span class=\"bad\">already outside the SLO</span>" },
        curve = curve_svg(r),
        breaks = breaks,
        findings = findings.iter().map(|f| html_finding(f)).collect::<Vec<_>>().join("\n"),
        date = date,
    );
    html
}

const HTML_HEAD: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Failure audit — {ARCH}</title>
<style>
:root { --bg:#f7f7f4; --fg:#1b1b19; --mut:#66665f; --line:#dcdcd5; --bad:#c4232b; --warn:#9a6100; --ok:#1d7a3b; --acc:#1f4fd1; --tint:#fbeaea; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --fg:#e6e6e1; --mut:#9a9a92; --line:#2a2f37; --bad:#ff6b6b; --warn:#e3a33a; --ok:#4cc38a; --acc:#7aa2ff; --tint:#3a1a1c; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
main { max-width: 820px; margin: 0 auto; padding: 40px 20px 64px; }
h1 { font-size: 28px; line-height: 1.2; margin: 0 0 6px; letter-spacing: -0.3px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 1px; color: var(--mut); margin: 36px 0 10px; border-bottom: 1px solid var(--line); padding-bottom: 6px; }
h3 { font-size: 16px; margin: 0 0 4px; }
.sub { color: var(--mut); margin: 0 0 24px; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.kpi { padding: 14px 4px; }
.kpi b { display: block; font: 600 30px/1.1 ui-monospace, Menlo, monospace; letter-spacing: -1px; }
.kpi span { color: var(--mut); font-size: 13px; }
.bad { color: var(--bad); } .warn { color: var(--warn); } .good { color: var(--ok); }
svg { width: 100%; height: auto; display: block; }
svg .lat { fill: none; stroke: var(--warn); stroke-width: 2; }
svg .err { fill: var(--tint); stroke: var(--bad); stroke-width: 1; }
svg .slo { stroke: var(--warn); stroke-dasharray: 4 4; opacity: .6; }
svg .now { stroke: var(--fg); opacity: .6; } svg .lim { stroke: var(--bad); stroke-dasharray: 3 3; }
svg .axis { stroke: var(--line); } svg .t { fill: var(--mut); font: 11px ui-monospace, Menlo, monospace; } svg .t.bad { fill: var(--bad); }
.legend { color: var(--mut); font-size: 12px; } .k { display: inline-block; width: 14px; height: 3px; vertical-align: middle; margin: 0 4px 0 10px; } .k.lat { background: var(--warn); } .k.err { background: var(--bad); }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; font-weight: 600; color: var(--mut); font-size: 12px; text-transform: uppercase; letter-spacing: .6px; border-bottom: 1px solid var(--line); padding: 6px 8px 6px 0; }
td { border-bottom: 1px solid var(--line); padding: 8px 8px 8px 0; vertical-align: top; }
td span { color: var(--mut); font-size: 13px; } .num { text-align: right; font-family: ui-monospace, Menlo, monospace; white-space: nowrap; }
.f { padding: 14px 0 14px 14px; border-left: 3px solid var(--line); margin: 0 0 4px; }
.f.sev-critical { border-left-color: var(--bad); } .f.sev-major { border-left-color: var(--warn); } .f.sev-ok { border-left-color: var(--ok); }
.f p { margin: 4px 0; } .facts { color: var(--mut); font-size: 13px; }
.sev { font: 700 11px ui-monospace, Menlo, monospace; text-transform: uppercase; letter-spacing: .5px; margin-right: 6px; }
.sev-critical .sev, td.sev-critical { color: var(--bad); } .sev-major .sev, td.sev-major { color: var(--warn); } .sev-ok .sev, td.sev-ok { color: var(--ok); } .sev-minor .sev { color: var(--mut); }
.fixes { margin-top: 8px; } code { font: 12px ui-monospace, Menlo, monospace; border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }
footer { margin-top: 40px; color: var(--mut); font-size: 12px; border-top: 1px solid var(--line); padding-top: 12px; }
@media print { body { background: #fff; } .f { break-inside: avoid; } }
</style>
</head>
<body>
<main>
"#;

#[allow(dead_code)]
fn _j() -> Value {
    json!(null)
}

/// base64url of the UTF-8 JSON, unpadded (src/spec/convert.ts encodePayload)
pub fn encode_payload(v: &Value) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let bytes = crate::convert::js_stringify(v).into_bytes();
    let mut out = String::new();
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..c.len() + 1 {
            out.push(A[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

/// a variant applied to a (canonical) spec: a replacement spec, or its changes in order
pub(crate) fn apply_variant(base: &Value, v: &Value) -> Result<Value, String> {
    if let Some(spec) = v.get("spec").filter(|x| !x.is_null()) {
        let (a, issues) = crate::sim::spec::check_architecture(spec);
        if a.is_none() {
            return Err(crate::sim::spec::issues_message(&issues));
        }
        return Ok(super::sim::canonical_spec(spec));
    }
    let mut spec = base.clone();
    let empty = vec![];
    for ch in v.get("changes").and_then(|c| c.as_array()).unwrap_or(&empty) {
        let comps = spec["components"].as_array().cloned().unwrap_or_default();
        let find = |id: &str| comps.iter().position(|c| c.get("id").and_then(|x| x.as_str()) == Some(id)).ok_or_else(|| format!("change refers to unknown component \"{}\"", id));
        let st = |k: &str| ch.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
        match st("op").as_str() {
            "set" => {
                let i = find(&st("id"))?;
                if let (Some(Value::Object(c)), Some(Value::Object(fields))) = (spec["components"].get_mut(i), ch.get("fields")) {
                    for (k, x) in fields {
                        if k != "id" && k != "kind" {
                            c.insert(k.clone(), x.clone());
                        }
                    }
                }
            }
            "add" => {
                let comp = ch.get("component").cloned().unwrap_or(Value::Null);
                let id = comp.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                if comps.iter().any(|c| c.get("id").and_then(|x| x.as_str()) == Some(id.as_str())) {
                    return Err(format!("component \"{}\" already exists", id));
                }
                if let Some(Value::Array(a)) = spec.get_mut("components") {
                    a.push(comp);
                }
                if let Some(z) = ch.get("zone").and_then(|x| x.as_str()) {
                    let zones = spec.get_mut("zones").and_then(|x| x.as_array_mut());
                    let zone = zones.and_then(|zs| zs.iter_mut().find(|x| x.get("id").and_then(|y| y.as_str()) == Some(z)));
                    match zone.and_then(|x| x.get_mut("members")).and_then(|m| m.as_array_mut()) {
                        Some(m) => m.push(json!(id)),
                        None => return Err(format!("change places \"{}\" in unknown zone \"{}\"", id, z)),
                    }
                }
            }
            "remove" => {
                let id = st("id");
                find(&id)?;
                let ends = |c: &Value| match c {
                    Value::Array(a) => a.iter().any(|x| x.as_str() == Some(id.as_str())),
                    x => x.get("from").and_then(|y| y.as_str()) == Some(id.as_str()) || x.get("to").and_then(|y| y.as_str()) == Some(id.as_str()),
                };
                if let Some(Value::Array(a)) = spec.get_mut("components") {
                    a.retain(|c| c.get("id").and_then(|x| x.as_str()) != Some(id.as_str()));
                }
                if let Some(Value::Array(a)) = spec.get_mut("connections") {
                    a.retain(|c| !ends(c));
                }
                if let Some(Value::Array(zs)) = spec.get_mut("zones") {
                    for z in zs {
                        if let Some(Value::Array(m)) = z.get_mut("members") {
                            m.retain(|x| x.as_str() != Some(id.as_str()));
                        }
                    }
                }
            }
            "connect" => {
                find(&st("from"))?;
                find(&st("to"))?;
                let (from, to) = (st("from"), st("to"));
                let mut props = JMap::new();
                for k in ["latencyMs", "calls", "carries", "replication"] {
                    if let Some(v) = ch.get(k).filter(|v| !v.is_null() && v.as_str() != Some("async")) {
                        props.insert(k.into(), v.clone());
                    }
                }
                if let Some(Value::Array(a)) = spec.get_mut("connections") {
                    // connecting an existing pair sets its link properties
                    a.retain(|c| match c {
                        Value::Array(p) => !(p.first().and_then(|x| x.as_str()) == Some(from.as_str()) && p.get(1).and_then(|x| x.as_str()) == Some(to.as_str())),
                        x => !(x.get("from").and_then(|y| y.as_str()) == Some(from.as_str()) && x.get("to").and_then(|y| y.as_str()) == Some(to.as_str())),
                    });
                    if props.is_empty() {
                        a.push(json!([from, to]));
                    } else {
                        let mut o = JMap::new();
                        o.insert("from".into(), json!(from));
                        o.insert("to".into(), json!(to));
                        o.extend(props);
                        a.push(Value::Object(o));
                    }
                }
            }
            "disconnect" => {
                let (from, to) = (st("from"), st("to"));
                if let Some(Value::Array(a)) = spec.get_mut("connections") {
                    a.retain(|c| match c {
                        Value::Array(p) => !(p.first().and_then(|x| x.as_str()) == Some(from.as_str()) && p.get(1).and_then(|x| x.as_str()) == Some(to.as_str())),
                        x => !(x.get("from").and_then(|y| y.as_str()) == Some(from.as_str()) && x.get("to").and_then(|y| y.as_str()) == Some(to.as_str())),
                    });
                }
            }
            _ => {}
        }
    }
    let (a, issues) = crate::sim::spec::check_architecture(&spec);
    if a.is_none() {
        return Err(crate::sim::spec::issues_message(&issues));
    }
    Ok(super::sim::canonical_spec(&spec))
}
