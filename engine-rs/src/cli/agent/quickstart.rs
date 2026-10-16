//! `hindcast quickstart --prometheus <url> | --datadog <site> [--jaeger <url> | --tempo <url>] [--last 24h]`: the first
//! answer in one command. It runs the agent tools a newcomer would run by hand — connect, collect,
//! calibrate, review_capacity — prints each phase as it goes, and ends on the capacity review's
//! summary, the report's path and what to ask next. Traces are optional: without them, who calls whom
//! comes from the metrics (or a topology file) and the review says what that costs. Read-only towards
//! the user's systems, as the tools are.

use super::workspace::Workspace;
use crate::cli::util::{pretty, Flags, Out};
use serde_json::{json, Map as JMap, Value};
use std::io::Write;
use std::time::Instant;

pub const USAGE: &str = "hindcast quickstart --prometheus <url> | --datadog <site> [--dd-env prod] [--dd-api-key-env DD_API_KEY] [--dd-app-key-env DD_APP_KEY] [--jaeger <url> | --tempo <url> | --topology calls.yaml] [--last 24h] [--name \"my system\"] [--namespace shop] [--exclude jaeger,otel-collector] [--p99 500] [--errors 0.01] [--token-env PROM_TOKEN] [--workspace .hindcast] [--json]";

fn say(s: &str) {
    let e = std::io::stderr();
    let mut e = e.lock();
    let _ = writeln!(e, "{}", s);
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}

/// one phase: its name, the tool's answer, the time it took, said on stderr
fn phase(k: usize, name: &str, run: impl FnOnce() -> Result<Value, String>) -> Result<Value, String> {
    say(&format!("[{}/4] {} …", k, name));
    let t0 = Instant::now();
    // the tools' own phases, indented under this one
    let hook: Box<dyn FnMut(&str, f64, f64)> = Box::new(|m: &str, _: f64, _: f64| say(&format!("      {}", m)));
    let r = super::with_progress(Some(hook), run);
    let secs = t0.elapsed().as_secs_f64();
    match &r {
        Ok(_) => say(&format!("      done in {:.1} s", secs)),
        Err(e) => say(&format!("      failed after {:.1} s: {}", secs, e)),
    }
    r
}

/// the capacity review's five summary lines (risk, headroom, cost, the change, trust), as plain text
pub fn summary_lines(markdown: &str) -> Vec<String> {
    markdown.lines().skip_while(|l| !l.starts_with("## Summary")).skip(1).take_while(|l| !l.starts_with("## ")).filter(|l| !l.trim().is_empty()).map(|l| l.replace("**", "")).collect()
}

pub fn quickstart(f: &Flags, out: &mut Out) -> Result<i32, String> {
    if f.has("help") || f.has("h") {
        out.log(&format!("{}\n\nConnects to Prometheus or Datadog (and Jaeger or Tempo), collects the history, calibrates a model of the system from it and writes a capacity review: risk, headroom, cost, the one change to make, and how far to trust it. Traces are optional: without them, who calls whom is read from service-mesh, service-graph or span metrics (--calls picks one where several exist), or from --topology (a file of `calls: {{ caller: [callees] }}`), and the review says what is missing. With --datadog, the API and application keys are read from DD_API_KEY and DD_APP_KEY (or the variables --dd-api-key-env and --dd-app-key-env name), and who calls whom from APM service dependencies. Read-only towards your systems; everything is written under the workspace (default ./.hindcast).", USAGE));
        return Ok(0);
    }
    let datadog = f.get("datadog").filter(|u| u != "true");
    let prom = match &datadog {
        // a site, or an API base given as a URL (a proxy; the tests' mock)
        Some(d) => {
            if d.contains("://") {
                d.clone()
            } else {
                super::datadog::api_base(&json!({ "site": d }))?
            }
        }
        None => f.get("prometheus").filter(|u| u != "true").ok_or_else(|| format!("quickstart needs your Prometheus: {}", USAGE))?,
    };
    let mut connect = JMap::new();
    let mut p = JMap::new();
    if let Some(d) = &datadog {
        p.insert(if d.contains("://") { "url" } else { "site" }.into(), json!(d));
        for (flag, key) in [("dd-api-key-env", "apiKeyEnv"), ("dd-app-key-env", "appKeyEnv"), ("dd-env", "env")] {
            if let Some(v) = f.get(flag).filter(|v| v != "true") {
                p.insert(key.into(), json!(v));
            }
        }
    } else {
        p.insert("url".into(), json!(prom));
        if let Some(t) = f.get("token-env") {
            p.insert("tokenEnv".into(), json!(t));
        }
    }
    if let Some(ns) = f.get("namespace") {
        p.insert("namespaces".into(), json!(ns.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect::<Vec<_>>()));
    }
    if let Some(c) = f.get("calls").filter(|c| c != "true" && datadog.is_none()) {
        p.insert("calls".into(), json!(c.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect::<Vec<_>>()));
    }
    let source = if datadog.is_some() { "datadog" } else { "prometheus" };
    connect.insert(source.into(), Value::Object(p));
    if let Some(j) = f.get("jaeger") {
        connect.insert("jaeger".into(), json!({ "url": j }));
    } else if let Some(t) = f.get("tempo") {
        connect.insert("tempo".into(), json!({ "url": t }));
    }
    if let Some(t) = f.get("topology").filter(|t| t != "true") {
        connect.insert("topologyFile".into(), json!(t));
    }
    let mut system = JMap::new();
    if let Some(name) = f.get("name") {
        system.insert("name".into(), json!(name));
    }
    if let Some(x) = f.get("exclude") {
        system.insert("exclude".into(), json!(x.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect::<Vec<_>>()));
    }
    let mut slo = JMap::new();
    if let Some(x) = f.num("p99") {
        slo.insert("p99Ms".into(), json!(x));
    }
    if let Some(x) = f.num("errors") {
        slo.insert("errorRate".into(), json!(x));
    }
    if !slo.is_empty() {
        system.insert("slo".into(), Value::Object(slo));
    }
    if !system.is_empty() {
        connect.insert("system".into(), Value::Object(system));
    }
    let wsdir = f.get("workspace");
    if let Some(w) = &wsdir {
        connect.insert("workspace".into(), json!(w));
    }
    let with_ws = |mut o: JMap<String, Value>| {
        if let Some(w) = &wsdir {
            o.insert("workspace".into(), json!(w));
        }
        Value::Object(o)
    };
    let ws = Workspace::new(wsdir.as_deref());
    let t0 = Instant::now();
    say(&format!("Hindcast quickstart — workspace {} (read-only towards {} and traces)", ws.dir_str(), if datadog.is_some() { "Datadog" } else { "Prometheus" }));

    let c = phase(1, &format!("connecting to {}", if datadog.is_some() { format!("Datadog at {}", prom) } else { prom.clone() }), || super::run_tool("connect_telemetry", &Value::Object(connect.clone())))?;
    // the tools name their JSON arguments; here they are flags
    let problems: Vec<String> = strs(&c["problems"])
        .iter()
        .map(|p| p.replace("prometheus.tokenEnv (quickstart: --token-env)", "--token-env").replace("datadog.apiKeyEnv (quickstart: --dd-api-key-env)", "--dd-api-key-env").replace("datadog.appKeyEnv (quickstart: --dd-app-key-env)", "--dd-app-key-env"))
        .collect();
    if !c["ready"].as_bool().unwrap_or(false) {
        say("");
        for p in &problems {
            say(&format!("  ✗ {}", p));
        }
        let near = strs(&c[source]["nearMisses"]);
        for n in &near {
            say(&format!("  · {}", n));
        }
        for m in strs(&c[source]["missing"]) {
            say(&format!("  · missing: {}", m));
        }
        return Err("not ready: fix the problems above and run quickstart again (docs/agents.md, \"connect_telemetry\", says what each source needs)".into());
    }
    let presets = strs(&c[source]["presets"]).join(", ");
    let hours = c[source]["data"]["hoursFound"].as_f64();
    say(&format!("      metrics: {}{}", presets, hours.map(|h| format!("; {} h of request history found", crate::math::js_num((h * 10.0).round() / 10.0))).unwrap_or_default()));
    if c["traces"].is_null() {
        let from = c["calls"]["from"].as_str().unwrap_or("the metrics").replace("a topologyFile", "--topology");
        say(&match from.strip_prefix("nowhere: ") {
            Some(rest) => format!("      no traces, and {}", rest),
            None => format!("      no traces: who calls whom from {}", from),
        });
    } else {
        say(&format!("      traces: {} services, entering through {}", strs(&c["traces"]["services"]).len(), strs(&c["traces"]["entry"]).join(", ")));
    }
    for m in strs(&c[source]["missing"]) {
        say(&format!("      missing: {}", m));
    }
    for p in &problems {
        say(&format!("      ! {}", p));
    }

    let mut co = JMap::new();
    let span = match (f.get("start").filter(|x| x != "true"), f.get("end").filter(|x| x != "true")) {
        (Some(a), Some(b)) => {
            co.insert("start".into(), json!(a));
            co.insert("end".into(), json!(b));
            format!("{} … {}", a, b)
        }
        _ => {
            if let Some(l) = f.get("last") {
                co.insert("last".into(), json!(l));
            }
            format!("{} of history", f.get("last").unwrap_or_else(|| "the last 24 h".into()))
        }
    };
    let col = phase(2, &format!("collecting {}", span), || super::run_tool("collect_telemetry", &with_ws(co.clone())))?;
    let num = |v: &Value| crate::math::js_num(v.as_f64().unwrap_or(0.0));
    say(&format!("      {} services, {} endpoints, {} h in {} s buckets; {}", num(&col["services"]), col["endpoints"].as_array().map(|a| a.len()).unwrap_or(0), num(&col["window"]["hours"]), num(&col["window"]["stepS"]), col["traces"].as_str().map(String::from).or_else(|| col["withoutTraces"]["said"].as_str().map(String::from)).unwrap_or_else(|| "no traces".into())));
    let mut warnings = strs(&col["warnings"]);

    let cal = phase(3, "calibrating the model", || super::run_tool("calibrate_model", &with_ws(JMap::new())))?;
    warnings.extend(strs(&cal["warnings"]));
    let trust = &cal["trust"];
    say(&format!(
        "      {} trusted, {} extrapolated, {} not explained{}{}",
        strs(&trust["trusted"]).len(),
        strs(&trust["caution"]).len(),
        strs(&trust["untrusted"]).len(),
        if strs(&trust["cpuOnly"]).is_empty() { String::new() } else { format!(", {} from CPU alone (no latency metric)", strs(&trust["cpuOnly"]).len()) },
        if strs(&trust["costOnly"]).is_empty() { String::new() } else { format!(", {} cost only", strs(&trust["costOnly"]).len()) }
    ));
    // a history that holds several configurations: which one each service is fitted on
    for r in strs(&trust["regimes"]) {
        say(&format!("      {}", r));
    }

    let rev = phase(4, "reviewing capacity", || super::run_tool("review_capacity", &with_ws(JMap::new())))?;
    say(&format!("Done in {:.0} s.", t0.elapsed().as_secs_f64()));

    if f.has("json") {
        out.log(&pretty(&json!({ "connect": c, "collect": col, "calibrate": cal, "review": rev })));
        return Ok(0);
    }
    // the review's summary, then the warnings worth acting on, then the next questions
    let md = rev["markdown"].as_str().unwrap_or("");
    out.log("");
    out.log(&format!("Capacity review — {}", rev["system"].as_str().unwrap_or("")));
    out.log("");
    for l in summary_lines(md) {
        out.log(&l);
    }
    out.log("");
    out.log(&format!("Full report: {}", rev["report"].as_str().unwrap_or("")));
    if !warnings.is_empty() {
        out.log("");
        out.log("Worth fixing in the telemetry (each makes the model more exact):");
        for w in warnings.iter().take(5) {
            out.log(&format!("  - {}", w));
            if w.contains("system.exclude") {
                out.log("    (here: run quickstart again with --exclude <those services>)");
            }
        }
    }
    let ws_arg = wsdir.as_ref().map(|w| format!(",\"workspace\":\"{}\"", w)).unwrap_or_default();
    out.log("");
    out.log("Next:");
    out.log(&format!("  hindcast agent verify_change '{{\"changes\":[{{\"kubernetes\":{{\"base\":\"k8s/\",\"head\":\"k8s-edited/\"}}}}]{}}}'   a manifest change, before it ships", ws_arg));
    out.log(&format!("  hindcast agent suggest_changes '{{\"traffic\":{{\"scale\":2}}{}}}'   what to change before a 2× day", ws_arg));
    out.log(&format!("  hindcast agent check_node_loss{}   losing each node at the busiest moment", if ws_arg.is_empty() { String::new() } else { format!(" '{{{}}}'", &ws_arg[1..]) }));
    out.log("  hindcast agent setup                          give the same tools to Claude Code, Cursor or VS Code (MCP)");
    Ok(0)
}
