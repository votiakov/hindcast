//! Connecting is probing (agent/connect.ts): every source is asked what it holds before anything is
//! collected; and read_cluster, a read-only `kubectl get` against a named context.

use super::sources::{probe_jaeger, probe_prometheus, probe_tempo, suggest_renames};
use super::workspace::{now_s, parse_sources, Workspace};
use serde_json::{json, Map as JMap, Value};

fn obj(v: &Value) -> JMap<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

pub fn connect_telemetry(ws: &Workspace, input: &Value) -> Result<Value, String> {
    let cur = obj(&ws.sources()?);
    let inp = obj(input);
    let mut merged = cur.clone();
    for (k, v) in &inp {
        if k != "system" && !v.is_null() {
            merged.insert(k.clone(), v.clone());
        }
    }
    let mut sys = obj(cur.get("system").unwrap_or(&Value::Null));
    for (k, v) in obj(inp.get("system").unwrap_or(&Value::Null)) {
        sys.insert(k, v);
    }
    merged.insert("system".into(), Value::Object(sys));
    let mut next = obj(&parse_sources(&Value::Object(merged)));
    let now = now_s();
    let mut problems: Vec<String> = vec![];
    let mut prom_report: Option<Value> = None;
    let mut traces_report: Option<Value> = None;
    let mut files_report: Option<Value> = None;
    let mut bill_report: Option<Value> = None;

    if let Some(p) = next.get("prometheus").cloned() {
        let url = p.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string();
        match probe_prometheus(&p, now) {
            Ok(r) => {
                if r.get("presets").and_then(|x| x.as_array()).map(|a| a.is_empty()).unwrap_or(true) {
                    problems.push("Prometheus has none of the metrics Hindcast reads (OpenTelemetry span metrics or HTTP server metrics, plus container metrics)".into());
                }
                prom_report = Some(r);
            }
            Err(e) => {
                problems.push(format!("Prometheus at {}: {}", url, e));
                prom_report = Some(json!({ "url": url, "ok": false, "error": e }));
            }
        }
    } else {
        problems.push("no Prometheus: give prometheus.url (request rates, latency, CPU and limits come from it)".into());
    }

    let jaeger = next.get("jaeger").cloned();
    let tempo = next.get("tempo").cloned();
    if jaeger.is_some() || tempo.is_some() {
        let url = jaeger.as_ref().or(tempo.as_ref()).and_then(|x| x.get("url")).and_then(|x| x.as_str()).unwrap_or("").to_string();
        let r = match &jaeger {
            Some(j) => probe_jaeger(j, now),
            None => probe_tempo(tempo.as_ref().unwrap(), now),
        };
        match r {
            Ok(r) => traces_report = Some(r),
            Err(e) => {
                problems.push(format!("traces at {}: {}", url, e));
                traces_report = Some(json!({ "ok": false, "error": e, "url": url }));
            }
        }
    } else if let Some(Value::Array(pats)) = next.get("traceFiles").cloned().filter(|x| x.as_array().map(|a| !a.is_empty()).unwrap_or(false)) {
        let cwd = crate::cli::files::cwd();
        let files: usize = pats.iter().map(|p| crate::cli::files::glob(p.as_str().unwrap_or(""), &cwd).len()).sum();
        files_report = Some(json!({ "patterns": pats, "files": files }));
        if files == 0 {
            problems.push(format!("no trace files match {}", pats.iter().map(|p| p.as_str().unwrap_or("").to_string()).collect::<Vec<_>>().join(", ")));
        }
    }
    // without traces, who calls whom comes from a topology file or the metrics: not a problem, a loss
    let mut calls_report: Option<Value> = None;
    let mut no_file = false;
    if traces_report.is_none() && files_report.is_none() {
        let file = next.get("topologyFile").and_then(|x| x.as_str()).map(String::from);
        let from: Vec<String> = prom_report.as_ref().and_then(|p| p.get("calls")).and_then(|c| c.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
        // span metrics name calls only where their preset is used
        let chosen: Vec<String> = next.get("prometheus").and_then(|p| p.get("presets")).and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
        let from: Vec<String> = from.into_iter().filter(|k| k != "spanmetrics" || chosen.is_empty() || chosen.iter().any(|p| p == "otel-spanmetrics")).collect();
        let said = |k: &str| match k {
            "istio" => "Istio metrics (istio_requests_total)",
            "linkerd" => "Linkerd metrics (response_total)",
            "servicegraph" => "the OpenTelemetry service graph (traces_service_graph_request_total)",
            _ => "span metrics: client spans matched to the servers that answer them",
        };
        let how = match &file {
            Some(f) => {
                if !std::path::Path::new(f).exists() {
                    problems.push(format!("topology file {} does not exist", f));
                    no_file = true;
                }
                format!("the topology file {}", f)
            }
            None if !from.is_empty() => from.iter().map(|k| said(k)).collect::<Vec<_>>().join(", else "),
            None => "nowhere: no metric here names both ends of a call, so each service with request metrics is its own entry and the others are read against the entry traffic (a topologyFile can name the calls)".into(),
        };
        calls_report = Some(json!({
            "from": how,
            "lost": "no traces: each endpoint's own path and measured self times (self time is estimated as a service's latency less its callees'). Connect Jaeger or Tempo, or give traceFiles, for them",
        }));
    }

    if let Some(b) = next.get("bill") {
        let f = b.get("cur").or(b.get("gcp")).and_then(|x| x.as_str()).map(String::from);
        if let Some(f) = f {
            let exists = std::path::Path::new(&f).exists();
            bill_report = Some(json!({ "file": f, "exists": exists }));
            if !exists {
                problems.push(format!("bill file {} does not exist", f));
            }
        }
    }

    // container metrics name services differently from traces: map them
    let mut suggested = JMap::new();
    let trace_svcs: Vec<String> = traces_report.as_ref().and_then(|t| t.get("services")).and_then(|s| s.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    if let Some(p) = prom_report.as_ref().filter(|p| p.get("presets").is_some()) {
        suggested = suggest_renames(p, &trace_svcs);
        let given = inp.get("system").and_then(|s| s.get("rename")).and_then(|r| r.as_object()).cloned().unwrap_or_default();
        let applied: JMap<String, Value> = suggested.iter().filter(|(k, _)| !given.get(*k).map(|v| truthy(v)).unwrap_or(false)).map(|(k, v)| (k.clone(), v.clone())).collect();
        if !applied.is_empty() {
            let mut sys = obj(next.get("system").unwrap_or(&Value::Null));
            let mut r = applied.clone();
            for (k, v) in obj(sys.get("rename").unwrap_or(&Value::Null)) {
                r.insert(k, v);
            }
            sys.insert("rename".into(), Value::Object(r));
            next.insert("system".into(), Value::Object(sys));
        }
    }
    // keep the Kubernetes metrics to the namespaces the traced services run in
    let mut scoped: Option<Vec<String>> = None;
    let prom_has_ns = next.get("prometheus").and_then(|p| p.get("namespaces")).and_then(|n| n.as_array()).map(|a| !a.is_empty()).unwrap_or(false);
    if next.get("prometheus").is_some() && !prom_has_ns {
        if let Some(wns) = prom_report.as_ref().and_then(|p| p.get("workloadNamespaces")).and_then(|w| w.as_object()) {
            let mut traced: indexmap::IndexSet<String> = trace_svcs.iter().cloned().collect();
            // without traces, the services the ingress routes to stand in for the traced ones
            let ingress: &[&str] = if trace_svcs.is_empty() { &["ingress-nginx"] } else { &[] };
            for p in ["otel-spanmetrics", "http-server", "http-server-legacy", "istio", "linkerd"].iter().chain(ingress) {
                if let Some(a) = prom_report.as_ref().and_then(|r| r.get("services")).and_then(|s| s.get(p)).and_then(|x| x.as_array()) {
                    traced.extend(a.iter().filter_map(|x| x.as_str().map(String::from)));
                }
            }
            let rename = next.get("system").and_then(|s| s.get("rename")).and_then(|r| r.as_object()).cloned().unwrap_or_default();
            let mut hit: indexmap::IndexSet<String> = indexmap::IndexSet::new();
            for (w, nss) in wns {
                let renamed = rename.get(w).and_then(|x| x.as_str()).unwrap_or("");
                if traced.contains(w) || traced.contains(renamed) {
                    for n in nss.as_array().cloned().unwrap_or_default() {
                        hit.insert(n.as_str().unwrap_or("").to_string());
                    }
                }
            }
            if !hit.is_empty() {
                let mut v: Vec<String> = hit.into_iter().collect();
                v.sort();
                let mut p = obj(next.get("prometheus").unwrap());
                p.insert("namespaces".into(), json!(v));
                next.insert("prometheus".into(), Value::Object(p));
                scoped = Some(v);
            }
        }
    }
    let mut sys = obj(next.get("system").unwrap_or(&Value::Null));
    let has_entry = sys.get("entry").and_then(|e| e.as_array()).map(|a| !a.is_empty()).unwrap_or(false);
    if let Some(e) = traces_report.as_ref().and_then(|t| t.get("entry")).filter(|e| e.as_array().map(|a| !a.is_empty()).unwrap_or(false)) {
        if !has_entry {
            sys.insert("entry".into(), e.clone());
        }
    }
    if let Some(c) = traces_report.as_ref().and_then(|t| t.get("clientsOnly")).filter(|e| e.as_array().map(|a| !a.is_empty()).unwrap_or(false)) {
        if sys.get("ignore").map(|x| x.is_null()).unwrap_or(true) {
            sys.insert("ignore".into(), c.clone());
        }
    }
    next.insert("system".into(), Value::Object(sys.clone()));
    ws.save_sources(&Value::Object(next.clone()))?;
    let ready = !no_file && next.get("prometheus").is_some() && prom_report.as_ref().and_then(|p| p.get("presets")).and_then(|x| x.as_array()).map(|a| !a.is_empty()).unwrap_or(false);
    let on_nodes = prom_report.as_ref().and_then(|p| p.get("presets")).and_then(|x| x.as_array()).map(|a| a.iter().any(|x| x == "kubernetes")).unwrap_or(false);
    let mut out = JMap::new();
    out.insert("workspace".into(), json!(ws.dir_str()));
    out.insert("ready".into(), json!(ready));
    out.insert("system".into(), Value::Object(sys));
    if let Some(p) = prom_report {
        out.insert("prometheus".into(), p);
    }
    out.insert("traces".into(), traces_report.or(files_report).unwrap_or(Value::Null));
    if let Some(c) = calls_report {
        out.insert("calls".into(), c);
    }
    out.insert("bill".into(), bill_report.unwrap_or(json!(if on_nodes {
        "none — each service will be priced as its requests' share of a node, at the node size's on-demand list price (AWS Fargate list prices where there are no node metrics)"
    } else {
        "none — services will be priced at AWS Fargate list prices from their CPU and memory limits"
    })));
    out.insert("renamed".into(), Value::Object(suggested));
    if let Some(s) = scoped {
        out.insert("namespaces".into(), json!(format!("Kubernetes metrics kept to {} — where the traced services run (connect again with prometheus.namespaces to change)", s.join(", "))));
    }
    out.insert("problems".into(), json!(problems));
    out.insert("next".into(), json!(if ready { "collect_telemetry (choose how much history with `last`, e.g. \"7d\")" } else { "fix the problems above and connect again" }));
    Ok(Value::Object(out))
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().map(|x| x != 0.0 && !x.is_nan()).unwrap_or(false),
        _ => true,
    }
}

/// a read-only snapshot of a cluster's workloads, against an explicitly named context
pub fn read_cluster(ws: &Workspace, o: &Value) -> Result<Value, String> {
    let context = o.get("context").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if context.is_empty() {
        return Err("name the kube context explicitly (read_cluster never uses the current context)".into());
    }
    let namespace = o.get("namespace").and_then(|x| x.as_str()).map(String::from);
    let selector = o.get("selector").and_then(|x| x.as_str()).map(String::from);
    let kubectl = std::env::var("HINDCAST_KUBECTL").or_else(|_| std::env::var("BOTTLENECK_KUBECTL")).unwrap_or_else(|_| "kubectl".into());
    let mut args: Vec<String> = vec!["--context".into(), context.clone()];
    match &namespace {
        Some(n) => args.extend(["-n".into(), n.clone()]),
        None => args.push("--all-namespaces".into()),
    }
    args.extend(["get".into(), "deployments,statefulsets,horizontalpodautoscalers".into()]);
    if let Some(s) = &selector {
        args.extend(["-l".into(), s.clone()]);
    }
    args.extend(["-o".into(), "json".into(), "--request-timeout=20s".into()]);
    let command = format!("{} {}", kubectl, args.join(" "));
    let run = std::process::Command::new(&kubectl).args(&args).output().map_err(|e| format!("spawn {} {}", kubectl, if e.kind() == std::io::ErrorKind::NotFound { "ENOENT".to_string() } else { e.to_string() }))?;
    if !run.status.success() {
        return Err(format!("Command failed: {}\n{}", command, String::from_utf8_lossy(&run.stderr)));
    }
    let stdout = String::from_utf8_lossy(&run.stdout).to_string();
    let doc: Value = serde_json::from_str(&stdout).map_err(|e| e.to_string())?;
    ws.ensure("cluster");
    let stamp = super::workspace::iso_full(now_s())[..19].replace([':', 'T'], "-");
    let ctx_safe: String = {
        let mut o = String::new();
        let mut run = false;
        for c in context.chars() {
            if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' {
                o.push(c);
                run = false;
            } else if !run {
                o.push('_');
                run = true;
            }
        }
        o
    };
    let name = format!("{}-{}-{}.json", stamp, ctx_safe, namespace.clone().unwrap_or_else(|| "all".into()));
    let file = std::path::Path::new(&ws.path("cluster")).join(&name).to_string_lossy().to_string();
    ws.write_json(&format!("cluster/{}", name), &doc, true)?;
    let docs = crate::cli::util::yaml_documents(&stdout).unwrap_or_else(|_| vec![doc.clone()]);
    let workloads: Vec<Value> = crate::config_diff::read_workloads(&docs).into_values().map(|w| serde_json::to_value(w).unwrap_or(Value::Null)).collect();
    let mut src = obj(&ws.sources()?);
    let mut kube = JMap::new();
    kube.insert("context".into(), json!(context));
    if let Some(n) = &namespace {
        kube.insert("namespace".into(), json!(n));
    }
    src.insert("kube".into(), Value::Object(kube));
    ws.save_sources(&Value::Object(src))?;
    Ok(json!({
        "context": context,
        "namespace": namespace.unwrap_or_else(|| "all".into()),
        "objects": doc.get("items").and_then(|i| i.as_array()).map(|a| a.len()).unwrap_or(0),
        "workloads": workloads,
        "snapshot": file,
        "command": command,
        "next": "edit manifests, then verify_change with { cluster: { head: \"<path to edited manifests>\" } } to backtest them against this snapshot",
    }))
}
