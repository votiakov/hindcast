//! One collection (agent/collect.ts): Prometheus over a window, traces spread over the same window, the
//! bill if there is one, the import manifest written and imported into `dataset.json`; what each
//! service ended up with is reported.

use super::sources::{fetch_traces, probe_jaeger, probe_prometheus, probe_tempo, shape_of, traffic_by_slice};
use super::workspace::{auth_headers, iso, now_s, seconds, Workspace};
use crate::cli::files::{cwd, relative, resolve, DiskFiles};
use crate::math::{js_num, js_round, js_to_fixed};
use serde_json::{json, Map as JMap, Value};
use std::path::Path;

const STEPS: [f64; 8] = [30.0, 60.0, 120.0, 300.0, 600.0, 900.0, 1800.0, 3600.0];
const KEY_METRICS: [&str; 7] = ["rps", "errorRate", "p99Ms", "cpuCores", "cpuLimitCores", "replicas", "memoryBytes"];

/// workloads that watch a system rather than serve it (tracing, metrics, logs, dashboards), as their
/// charts and operators name them: left out of the collected history unless system.include keeps one
const OBSERVABILITY: [&str; 26] = [
    "jaeger", "zipkin", "tempo", "otel-collector", "opentelemetry-collector", "otelcol", "otel-agent", "opentelemetry-operator", "prometheus", "alertmanager", "pushgateway", "grafana", "loki", "promtail", "kube-state-metrics", "thanos", "mimir", "cortex", "victoria-metrics", "vmagent", "vmalert", "pyroscope", "fluent-bit", "fluentd", "datadog-agent", "datadog-cluster-agent",
];

/// a workload's name read as observability tooling: one of OBSERVABILITY as a run of its dash- or
/// underscore-separated words ("jaeger-query", "kube-prometheus-stack-operator", "monitoring-grafana"),
/// or an exporter ("node-exporter", "redis-exporter")
pub fn observability(name: &str) -> bool {
    let words = |s: &str| s.to_lowercase().split(['-', '_', '.']).filter(|w| !w.is_empty()).map(String::from).collect::<Vec<_>>();
    let w = words(name);
    w.last().map(|l| l == "exporter").unwrap_or(false) || OBSERVABILITY.iter().any(|o| w.windows(words(o).len()).any(|run| run == words(o).as_slice()))
}

/// the services of a history that are observability tooling, less those system.include keeps
fn observability_in<'a>(services: impl Iterator<Item = &'a String>, include: &[String]) -> Vec<String> {
    let mut v: Vec<String> = services.filter(|id| observability(id) && !include.contains(id)).cloned().collect();
    v.sort();
    v.dedup();
    v
}

/// what leaving them out says, and how to keep one
pub fn observability_said(left: &[String]) -> String {
    format!("left out as observability tooling, not part of the system: {}. To count one in, connect_telemetry with system.include [\"{}\"] (quickstart: --include {})", left.join(", "), left[0], left[0])
}

/// a window bound: epoch seconds (or ms), or a timestamp read as Date.parse reads it (UTC where no zone is given)
fn to_epoch(v: &Value) -> f64 {
    match v {
        Value::Number(n) => {
            let x = n.as_f64().unwrap_or(f64::NAN);
            if x > 1e12 {
                x / 1000.0
            } else {
                x
            }
        }
        Value::String(s) => crate::accuracy::parse_iso_ms(s).map(|ms| ms as f64 / 1000.0).unwrap_or(f64::NAN),
        _ => f64::NAN,
    }
}

fn strs(v: Option<&Value>) -> Option<Vec<String>> {
    v.and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
}

fn query_prom(url: &str, h: &[(String, String)], expr: &str, at: f64) -> Result<Vec<Value>, String> {
    let u = format!("{}/api/v1/query?query={}&time={}", url.trim_end_matches('/'), encode_uri_component(expr), js_num(at));
    let (_, body) = crate::cli::http::get(&u, h)?;
    let j: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(j.get("data").and_then(|d| d.get("result")).and_then(|r| r.as_array()).cloned().unwrap_or_default())
}

/// encodeURIComponent
pub(crate) fn encode_uri_component(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => o.push(b as char),
            _ => o.push_str(&format!("%{:02X}", b)),
        }
    }
    o
}

fn sval(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        None | Some(Value::Null) => "undefined".into(),
        Some(x) => crate::convert::js_stringify(x),
    }
}

/// the HorizontalPodAutoscalers kube-state-metrics knows at one instant, by the workload they scale
pub fn hpa_specs(url: &str, h: &[(String, String)], at: f64, namespaces: &[String]) -> JMap<String, Value> {
    let ns = if namespaces.is_empty() { String::new() } else { format!("{{namespace=~\"{}\"}}", namespaces.join("|")) };
    let q = |expr: &str| query_prom(url, h, expr, at).unwrap_or_default();
    let key = |m: &Value| format!("{}/{}", sval(m.get("namespace")), sval(m.get("horizontalpodautoscaler")));
    let target: indexmap::IndexMap<String, String> = q(&format!("kube_horizontalpodautoscaler_info{}", ns)).iter().map(|r| (key(&r["metric"]), sval(r["metric"].get("scaletargetref_name")))).collect();
    let num = |r: &Value| crate::import::js_number_of(r.get("value").and_then(|v| v.get(1)));
    let min: indexmap::IndexMap<String, f64> = q(&format!("kube_horizontalpodautoscaler_spec_min_replicas{}", ns)).iter().map(|r| (key(&r["metric"]), num(r))).collect();
    let max: indexmap::IndexMap<String, f64> = q(&format!("kube_horizontalpodautoscaler_spec_max_replicas{}", ns)).iter().map(|r| (key(&r["metric"]), num(r))).collect();
    let cpu_q = if ns.is_empty() { "kube_horizontalpodautoscaler_spec_target_metric{metric_name=\"cpu\",metric_target_type=\"utilization\"}".to_string() } else { format!("kube_horizontalpodautoscaler_spec_target_metric{}", ns.replacen('}', ",metric_name=\"cpu\",metric_target_type=\"utilization\"}", 1)) };
    let cpu: indexmap::IndexMap<String, f64> = q(&cpu_q).iter().map(|r| (key(&r["metric"]), num(r))).collect();
    let mut out = JMap::new();
    for (k, w) in &target {
        if w.is_empty() || w == "undefined" || !max.contains_key(k) {
            continue;
        }
        let mut o = JMap::new();
        o.insert("min".into(), crate::cli::util::to_json(&min.get(k).copied().unwrap_or(1.0)));
        o.insert("max".into(), crate::cli::util::to_json(&max[k]));
        if let Some(c) = cpu.get(k) {
            o.insert("targetCpu".into(), crate::cli::util::to_json(&(c / 100.0)));
        }
        out.insert(w.clone(), Value::Object(o));
    }
    out
}

pub fn coverage_of(d: &Value) -> Vec<Value> {
    let topo = d.get("topology").and_then(|t| t.get("services")).and_then(|s| s.as_object()).cloned().unwrap_or_default();
    let inferred = d.get("provenance").and_then(|p| p.get("traces")).and_then(|t| t.as_bool()) == Some(false);
    let virtual_: Vec<String> = topo.iter().filter(|(_, s)| s.get("kind").and_then(|k| k.as_str()) != Some("server")).map(|(k, _)| k.clone()).collect();
    d.get("services")
        .and_then(|s| s.as_object())
        .map(|svcs| {
            svcs.iter()
                .map(|(id, s)| {
                    let has: Vec<&str> = KEY_METRICS.iter().copied().filter(|m| s.get(*m).and_then(|v| v.as_array()).map(|a| a.iter().any(|x| !x.is_null())).unwrap_or(false)).collect();
                    let rps = s.get("rps").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                    let mut h: Vec<Value> = has.iter().map(|x| json!(x)).collect();
                    if topo.contains_key(id) {
                        h.push(json!(if inferred { "calls (inferred)" } else { "traces" }));
                    }
                    let missing: Vec<&str> = if virtual_.contains(id) { vec![] } else { KEY_METRICS.iter().copied().filter(|m| !has.contains(m)).collect() };
                    let filled = if rps.is_empty() { 0.0 } else { js_round((rps.iter().filter(|v| !v.is_null()).count() as f64 / rps.len() as f64) * 100.0) / 100.0 };
                    json!({ "service": id, "has": h, "missing": missing, "filled": crate::cli::util::to_json(&filled) })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// services whose workloads run only in namespaces outside the ones chosen: request metrics (span metrics, HTTP
/// server metrics) carry no namespace, so another team's app on the same Prometheus shows up beside this one
/// unless it is left out by where its pods run. Services with no workload found are kept.
fn outside_namespaces(workload_namespaces: &Value, chosen: &[String], rename: &JMap<String, Value>) -> Vec<String> {
    if chosen.is_empty() {
        return vec![];
    }
    let mut out: Vec<String> = workload_namespaces
        .as_object()
        .map(|w| w.iter().filter(|(_, ns)| strs(Some(*ns)).map(|n| !n.is_empty() && !n.iter().any(|x| chosen.contains(x))).unwrap_or(false)).map(|(id, _)| rename.get(id).and_then(|x| x.as_str()).unwrap_or(id).to_string()).collect())
        .unwrap_or_default();
    out.sort();
    out
}

/// the services with request metrics in a metrics probe (Prometheus or Datadog), counted on the preset that sees most
pub(crate) fn metered_services(probe: &Value) -> usize {
    ["otel-spanmetrics", "http-server", "http-server-legacy", "spring", "datadog-apm"].iter().map(|k| strs(probe.get("services").and_then(|s| s.get(*k))).unwrap_or_default().len()).max().unwrap_or(0)
}

/// why a trace probe (probe_jaeger, probe_tempo) can't give the topology, if it can't: it found no service requests
/// enter through, or it knows under half of the services with request metrics — one service exporting traces and
/// the rest not, where a topology from the traces would leave the rest uncalled. Then who calls whom is read from
/// the metrics, as without traces.
pub(crate) fn traces_unusable(shape: &Value, metered: usize) -> Option<String> {
    let kind = if shape.get("kind").and_then(|k| k.as_str()) == Some("tempo") { "Tempo" } else { "Jaeger" };
    let services = strs(shape.get("services")).unwrap_or_default();
    if strs(shape.get("entry")).map(|e| e.is_empty()).unwrap_or(true) {
        Some(empty_traces_said(kind, &services))
    } else if services.len() * 2 < metered {
        Some(partial_traces_said(kind, &services, metered))
    } else {
        None
    }
}

/// the warning when a connected Jaeger or Tempo holds no traces to read the topology from
fn empty_traces_said(kind: &str, services: &[String]) -> String {
    format!(
        "{} has no traces of this system before the window's end ({}): who calls whom is read from the metrics instead, as without traces. Check that the services export traces to it and that its retention covers the window",
        kind,
        if services.is_empty() { "it knows no services".to_string() } else { format!("only {}, which start no requests", services.join(", ")) }
    )
}

/// the warning when a connected Jaeger or Tempo traces under half of the services the metrics see
fn partial_traces_said(kind: &str, services: &[String], metered: usize) -> String {
    format!(
        "{} traces {} of the {} services with request metrics ({}): a topology from it would leave the rest uncalled, so who calls whom is read from the metrics instead, as without traces. Check that every service exports traces to it, or give system.entry to use the traces anyway",
        kind,
        services.len(),
        metered,
        services.join(", ")
    )
}

/// groups of services that call each other and never anyone outside the group: two systems (another team's
/// app on the same Prometheus) read as one, whose SLO, headroom and risks would then mix. None for one group.
/// `namespaces` is the probe's workloadNamespaces (workload → namespaces).
fn separate_systems(d: &Value, namespaces: &Value, source: &str) -> Option<String> {
    let edges = d.get("topology").and_then(|t| t.get("edges")).and_then(|e| e.as_array())?;
    let known = d.get("services").and_then(|s| s.as_object())?;
    let ids: Vec<String> = known.keys().cloned().collect();
    let mut group: Vec<usize> = (0..ids.len()).collect();
    fn root(g: &mut Vec<usize>, mut i: usize) -> usize {
        while g[i] != i {
            g[i] = g[g[i]];
            i = g[i];
        }
        i
    }
    let mut linked = vec![false; ids.len()];
    for e in edges {
        let (a, b) = (ids.iter().position(|x| *x == sval(e.get("from"))), ids.iter().position(|x| *x == sval(e.get("to"))));
        if let (Some(a), Some(b)) = (a, b) {
            if a == b {
                continue;
            }
            let (ra, rb) = (root(&mut group, a), root(&mut group, b));
            group[ra] = rb;
            linked[a] = true;
            linked[b] = true;
        }
    }
    let mut groups: Vec<Vec<String>> = vec![];
    let mut of: Vec<usize> = vec![];
    for i in (0..ids.len()).filter(|i| linked[*i]) {
        let r = root(&mut group, i);
        match of.iter().position(|x| *x == r) {
            Some(k) => groups[k].push(ids[i].clone()),
            None => {
                of.push(r);
                groups.push(vec![ids[i].clone()]);
            }
        }
    }
    if groups.len() < 2 {
        return None;
    }
    groups.sort_by(|a, b| b.len().cmp(&a.len()));
    let ns_of = |g: &[String]| -> Vec<String> {
        let mut v: Vec<String> = g.iter().flat_map(|id| strs(namespaces.get(id)).unwrap_or_default()).collect();
        v.sort();
        v.dedup();
        v
    };
    let said: Vec<String> = groups
        .iter()
        .map(|g| {
            let names = if g.len() > 4 { format!("{} and {} more", g[..3].join(", "), g.len() - 3) } else { g.join(", ") };
            let ns = ns_of(g);
            if ns.is_empty() { names } else { format!("{} (namespace {})", names, ns.join(", ")) }
        })
        .collect();
    // one namespace per group, a different one each: the namespace is the way to pick one
    let by_ns: Vec<Vec<String>> = groups.iter().map(|g| ns_of(g)).collect();
    let apart = by_ns.iter().all(|n| n.len() == 1) && {
        let mut all: Vec<&String> = by_ns.iter().map(|n| &n[0]).collect();
        all.sort();
        all.dedup();
        all.len() == by_ns.len()
    };
    let how = if apart {
        format!("collect one at a time: connect_telemetry with {}.namespaces [\"{}\"] (quickstart: --namespace {})", source, by_ns[0][0], by_ns[0][0])
    } else {
        "if one of them is another system, connect_telemetry with system.exclude for its services (quickstart: --exclude)".to_string()
    };
    Some(format!(
        "the history holds {} groups of services that never call each other: {}. Read as one system, their SLO, headroom and risks mix — {}",
        groups.len(),
        said.join("; "),
        how
    ))
}

pub fn collect(ws: &Workspace, o: &Value) -> Result<Value, String> {
    let mut src = ws.sources()?.as_object().cloned().unwrap_or_default();
    // the metrics come from Prometheus, or from Datadog where that is what is connected
    let dd = if src.get("prometheus").is_none() { src.get("datadog").cloned() } else { None };
    let prom = match &dd {
        Some(_) => json!({}),
        None => src.get("prometheus").cloned().ok_or("no Prometheus connected — call connect_telemetry with prometheus.url first")?,
    };
    let prom_url = prom.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let mut warnings: Vec<String> = vec![];
    let now = now_s();
    let probe = match &dd {
        Some(d) => super::datadog::probe(d, now)?,
        None => probe_prometheus(&prom, now)?,
    };
    let probe_presets = strs(probe.get("presets")).unwrap_or_default();
    if probe_presets.is_empty() {
        return Err(match &dd {
            Some(_) => format!("Datadog at {} has none of the metrics the presets read. {}", probe["url"].as_str().unwrap_or(""), strs(probe.get("missing")).unwrap_or_default().join("; ")),
            None => format!("Prometheus at {} has none of the metrics the presets read. {}", prom_url, strs(probe.get("nearMisses")).unwrap_or_default().join(" ")),
        });
    }
    let presets = strs(dd.as_ref().unwrap_or(&prom).get("presets")).filter(|p| !p.is_empty()).unwrap_or(probe_presets);

    // ---- window and step
    let windows: Option<Vec<(f64, f64)>> = o.get("windows").and_then(|w| w.as_array()).filter(|a| !a.is_empty()).map(|a| {
        let mut v: Vec<(f64, f64)> = a.iter().map(|w| (to_epoch(&w["start"]), to_epoch(&w["end"]))).collect();
        v.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        v
    });
    if let Some(ws_) = &windows {
        for (a, b) in ws_ {
            if !(b > a) {
                return Err(format!("empty window {} … {}", iso(*a), iso(*b)));
            }
        }
    }
    let newest = probe.get("data").and_then(|d| d.get("newest")).and_then(|x| x.as_str()).and_then(crate::accuracy::parse_iso_ms).map(|ms| ms as f64 / 1000.0);
    let oldest_found = probe.get("data").and_then(|d| d.get("oldestFound")).and_then(|x| x.as_str()).and_then(crate::accuracy::parse_iso_ms).map(|ms| ms as f64 / 1000.0);
    let mut end = match &windows {
        Some(w) => w[w.len() - 1].1,
        None => match o.get("end").filter(|x| !x.is_null()) {
            Some(e) => to_epoch(e),
            None => now,
        },
    };
    if windows.is_none() && o.get("end").map(|x| x.is_null()).unwrap_or(true) {
        if let Some(nw) = newest.filter(|n| *n < now - 3600.0) {
            end = nw;
            warnings.push(format!("no request metrics in the last hour: the window ends at the newest data, {}", iso(end)));
        }
    }
    let last = o.get("last").and_then(|x| x.as_str()).map(String::from);
    let mut start = match &windows {
        Some(w) => w[0].0,
        None => match o.get("start").filter(|x| !x.is_null()) {
            Some(s) => to_epoch(s),
            None => end - seconds(last.as_deref().unwrap_or("24h"))?,
        },
    };
    if windows.is_none() && o.get("start").map(|x| x.is_null()).unwrap_or(true) && last.is_none() {
        if let Some(of) = oldest_found {
            start = start.max(of);
        }
    }
    if !(end > start) {
        return Err(format!("empty window {} … {}", iso(start), iso(end)));
    }
    let parts: Vec<(f64, f64)> = windows.clone().unwrap_or_else(|| vec![(start, end)]);
    let covered: f64 = parts.iter().map(|(a, b)| b - a).sum();
    let step_s = o.get("stepS").and_then(|x| x.as_f64()).unwrap_or_else(|| {
        let s = STEPS.iter().copied().find(|s| (end - start) / s <= 20_160.0).unwrap_or(3600.0);
        // the Agent's checks run every 15 s and trace stats flush every 10 s: a minute keeps every Datadog bucket filled
        if dd.is_some() { s.max(60.0) } else { s }
    });
    let rate_window = format!("{}s", js_num(step_s.max(60.0)));
    super::progress(&match &windows {
        Some(w) => format!("{} windows, {} … {}, in {} s buckets", w.len(), iso(start), iso(end), js_num(step_s)),
        None => format!("window {} … {} in {} s buckets", iso(start), iso(end), js_num(step_s)),
    }, 0.0, 4.0);

    // ---- traces first: they say which services requests enter through
    let tel = ws.path("telemetry");
    let _ = std::fs::remove_dir_all(&tel);
    ws.ensure("telemetry/metrics");
    ws.ensure("telemetry/traces");
    let mut trace_files: Vec<String> = vec![];
    let mut trace_note = String::new();
    let system = src.get("system").cloned().unwrap_or(json!({}));
    let mut entry: Option<Vec<String>> = strs(system.get("entry"));
    let mut ignore: Option<Vec<String>> = strs(system.get("ignore"));
    let jaeger = src.get("jaeger").cloned();
    let tempo = src.get("tempo").cloned();
    let rename_map = system.get("rename").and_then(|r| r.as_object()).cloned().unwrap_or_default();
    let rename_of = |x: &str| rename_map.get(x).and_then(|v| v.as_str()).unwrap_or(x).to_string();
    let outside = outside_namespaces(&probe["workloadNamespaces"], &strs(dd.as_ref().unwrap_or(&prom).get("namespaces")).unwrap_or_default(), &rename_map);
    let infer_prom = super::infer::Prom::new(&prom, &rename_map)?;
    let mut inferred: Option<super::infer::Calls> = None;
    // a trace backend that holds no traces of this system (retention ran out, or nothing exports to it)
    // says nothing about who calls whom: the metrics are read for it, as without traces
    let mut traced = jaeger.is_some() || tempo.is_some();
    if traced && entry.as_ref().map(|e| e.is_empty()).unwrap_or(true) {
        let shape = match &jaeger {
            Some(j) => probe_jaeger(j, end)?,
            None => probe_tempo(tempo.as_ref().unwrap(), end)?,
        };
        match traces_unusable(&shape, metered_services(&probe)) {
            Some(why) => {
                traced = false;
                warnings.push(why);
            }
            None => {
                entry = strs(shape.get("entry"));
                if ignore.is_none() {
                    ignore = strs(shape.get("clientsOnly"));
                }
            }
        }
    }
    if traced {
        let kind = if jaeger.is_some() { "jaeger" } else { "tempo" };
        let ent = entry.clone().unwrap_or_default();
        super::progress("fetching traces", 1.0, 4.0);
        let (mut traces, mut requests) = (0usize, 0usize);
        let max_traces = o.get("maxTraces").and_then(|x| x.as_f64()).unwrap_or(3000.0);
        for (k, (a, b)) in parts.iter().enumerate() {
            let slices = (((b - a) / 60.0).floor() as usize).clamp(1, 96);
            let weights = traffic_by_slice(&prom, &presets, &ent, *a, *b, slices).ok().flatten();
            let got = fetch_traces(jaeger.as_ref(), tempo.as_ref(), &ent, *a, *b, Some(js_round((max_traces * (b - a)) / covered).max(50.0)), Some(slices), weights.as_deref())?;
            let f = Path::new(&tel).join("traces").join(if parts.len() > 1 { format!("{}-w{}.jsonl", kind, k) } else { format!("{}.jsonl", kind) }).to_string_lossy().to_string();
            std::fs::write(&f, got.lines.join("\n") + "\n").map_err(|e| e.to_string())?;
            trace_files.push(f);
            traces += got.traces;
            requests += got.requests;
        }
        trace_note = format!("{} traces from {} through {} ({} queries)", crate::math::js_locale(traces as f64), kind, ent.join(", "), requests);
        if traces < 50 {
            warnings.push(format!("only {} traces in the window — topology and self times rest on few requests", traces));
        }
    } else if let Some(pats) = strs(src.get("traceFiles")).filter(|p| !p.is_empty()) {
        let here = cwd();
        trace_files = pats.iter().flat_map(|p| crate::cli::files::glob(p, &here)).map(|p| resolve(&here, &p).to_string_lossy().to_string()).collect();
        if trace_files.is_empty() {
            return Err(format!("no trace files match {}", pats.join(", ")));
        }
        if entry.as_ref().map(|e| e.is_empty()).unwrap_or(true) || ignore.is_none() {
            let mut spans = vec![];
            for f in trace_files.iter().take(3) {
                if f.ends_with(".jsonl") || f.ends_with(".ndjson") {
                    let text = std::fs::read_to_string(f).unwrap_or_default();
                    for (n, line) in text.split('\n').enumerate() {
                        if n > 2000 {
                            break;
                        }
                        if !line.trim().is_empty() {
                            crate::import::traces::parse_trace_lines(std::iter::once(line), &mut spans)?;
                        }
                    }
                } else {
                    crate::import::traces::parse_trace_file(&std::fs::read_to_string(f).unwrap_or_default(), &mut spans)?;
                }
            }
            let (e, c, _) = shape_of(&spans);
            if entry.is_none() {
                entry = Some(e);
            }
            if ignore.is_none() {
                ignore = Some(c);
            }
        }
        trace_note = format!("{} trace file(s)", trace_files.len());
    } else {
        // no traces: the calls the metrics name, read before the export so the entry's endpoints are queried
        super::progress("reading calls from the metrics (no traces)", 1.0, 4.0);
        let known: Vec<String> = ["otel-spanmetrics", "http-server", "http-server-legacy", "spring"].iter().flat_map(|k| strs(probe.get("services").and_then(|s| s.get(*k))).unwrap_or_default()).map(|x| rename_of(&x)).filter(|x| !outside.contains(x)).collect();
        // workloads a client span's peer address can name (a database with no request metrics of its own)
        let workloads: Vec<String> = ["kubernetes", "cadvisor"].iter().flat_map(|k| strs(probe.get("services").and_then(|s| s.get(*k))).unwrap_or_default()).map(|x| rename_of(&x)).collect();
        let mut c = match &dd {
            Some(d) => {
                let known: Vec<String> = strs(probe.get("services").and_then(|s| s.get("datadog-apm"))).unwrap_or_default().iter().map(|x| rename_of(x)).filter(|x| !outside.contains(x)).collect();
                match src.get("topologyFile").and_then(|x| x.as_str()) {
                    // a topology file names the calls as it does with Prometheus (no metric is queried for them)
                    Some(f) => super::infer::read_calls(&infer_prom, &[], &[], &parts, Some(f), &known, &[])?,
                    None => super::datadog::read_calls(d, &probe, &parts, &rename_map, &known)?,
                }
            }
            None => super::infer::read_calls(&infer_prom, &presets, &super::infer::chosen_calls(&strs(probe.get("calls")).unwrap_or_default(), &prom), &parts, src.get("topologyFile").and_then(|x| x.as_str()), &known, &workloads)?,
        };
        match entry.as_ref().filter(|e| !e.is_empty()) {
            Some(e) => c.entry = e.clone(),
            None => entry = Some(c.entry.clone()),
        }
        inferred = Some(c);
    }

    // ---- metrics
    super::progress(if dd.is_some() { "querying Datadog" } else { "querying Prometheus" }, 2.0, 4.0);
    let po = crate::prom_export::Opts {
        window: rate_window.clone(),
        selector: prom.get("selector").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        entry: entry.clone().unwrap_or_default(),
        namespaces: strs(prom.get("namespaces")).unwrap_or_default(),
    };
    let plan = if dd.is_some() { vec![] } else { crate::prom_export::export_plan(&presets, &po)? };
    let dir_of = |k: usize| if parts.len() > 1 { Path::new(&tel).join("metrics").join(format!("w{}", k)).to_string_lossy().to_string() } else { Path::new(&tel).join("metrics").to_string_lossy().to_string() };
    let h = auth_headers(Some(&prom))?;
    let mut exported: Vec<(String, usize)> = vec![];
    let mut dd_metrics: Vec<Value> = vec![];
    for (k, (a, b)) in parts.iter().enumerate() {
        let Some(d) = &dd else { continue };
        let dir = dir_of(k);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let got = super::datadog::export(d, &probe, &presets, &entry.clone().unwrap_or_default(), *a, *b, step_s, &|file, body| std::fs::write(Path::new(&dir).join(file), body).map_err(|e| e.to_string()))?;
        for (f, n, mapping) in got {
            match exported.iter_mut().find(|x| x.0 == f) {
                Some(e) => e.1 = e.1.max(n),
                None => {
                    exported.push((f.clone(), n));
                    let mut o = JMap::new();
                    o.insert("prometheus".into(), json!(format!("{}/{}", if parts.len() > 1 { "metrics/*" } else { "metrics" }, f)));
                    for (k, v) in mapping.as_object().cloned().unwrap_or_default() {
                        o.insert(k, v);
                    }
                    dd_metrics.push(Value::Object(o));
                }
            }
        }
    }
    for (k, (a, b)) in parts.iter().enumerate() {
        if dd.is_some() {
            break;
        }
        let dir = dir_of(k);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let got = crate::cli::bt::run_export(&prom_url, &plan, *a, *b, step_s, &|file, body| std::fs::write(Path::new(&dir).join(file), body).map_err(|e| e.to_string()), &h)?;
        for (f, n) in got {
            match exported.iter_mut().find(|x| x.0 == f) {
                Some(e) => e.1 = e.1.max(n),
                None => exported.push((f, n)),
            }
        }
    }
    let empty: Vec<String> = exported.iter().filter(|e| e.1 == 0).map(|e| e.0.clone()).collect();
    let endpoint_series = exported.iter().any(|e| e.0.contains("endpoint-rps") && e.1 > 0);
    let ent = entry.clone().unwrap_or_default();
    if !endpoint_series && !ent.is_empty() && inferred.is_none() {
        warnings.push(format!("no endpoint-level request metrics for {}: endpoint rates come from the traces, scaled by the measured sampling share", ent.join(", ")));
    }
    let mut raw_urls: Option<String> = None;
    if let Some(ep) = plan.iter().find(|p| p.query.file.ends_with("endpoint-rps.json")) {
        if let Ok(text) = std::fs::read_to_string(Path::new(&dir_of(0)).join(&ep.query.file)) {
            if let Ok(doc) = serde_json::from_str::<Value>(&text) {
                let names: Vec<(String, String)> = doc.get("data").and_then(|d| d.get("result")).and_then(|r| r.as_array()).cloned().unwrap_or_default().iter().map(|r| {
                    let m = &r["metric"];
                    let svc = m.get("service_name").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    let name = m.get("span_name").or(m.get("http_route")).and_then(|x| x.as_str()).unwrap_or("").to_string();
                    (svc, name)
                }).collect();
                let templates: indexmap::IndexSet<String> = names.iter().map(|(s, n)| format!("{} {}", s, crate::import::traces::template_path(n))).collect();
                if names.len() >= 30 && names.len() >= 3 * templates.len() {
                    raw_urls = Some(format!("{} span-name series for {} endpoints", names.len(), templates.len()));
                }
            }
        }
    }
    let metrics_plan: Vec<crate::prom_export::PlanItem> = if raw_urls.is_some() {
        plan.iter().filter(|p| !["endpoint-latency.json", "endpoint-mean.json", "endpoint-p50.json", "endpoint-p99.json"].iter().any(|s| p.query.file.ends_with(s))).cloned().collect()
    } else {
        plan.clone()
    };
    if let Some(r) = &raw_urls {
        let instead = if inferred.is_some() { "and with no traces each of those services is modelled as one endpoint" } else { "so it comes from the traces' call paths instead" };
        warnings.push(format!("span names on {} carry raw URLs ({}): per-endpoint latency from span metrics is unusable, {}. Naming server spans by route (http.route) fixes it at the source", ent.join(","), r, instead));
    }

    // ---- manifest
    let tel_path = std::path::PathBuf::from(&tel);
    let rel = |p: &str| if Path::new(p).is_absolute() { relative(&tel_path, p) } else { p.to_string() };
    let mut manifest = JMap::new();
    manifest.insert("name".into(), system.get("name").cloned().unwrap_or(json!("my system")));
    manifest.insert("step".into(), json!(format!("{}s", js_num(step_s))));
    // the grid is the collection window: a span with a skewed clock can't stretch the history
    manifest.insert("window".into(), json!({ "start": iso(parts[0].0), "end": iso(parts[parts.len() - 1].1) }));
    if let Some(r) = system.get("rename").and_then(|r| r.as_object()).filter(|r| !r.is_empty()) {
        manifest.insert("rename".into(), Value::Object(r.clone()));
    }
    manifest.insert("metrics".into(), Value::Array(if dd.is_some() { dd_metrics } else { crate::prom_export::manifest_metrics(&metrics_plan, if parts.len() > 1 { "metrics/*" } else { "metrics" }) }));
    let traces_v = if trace_files.is_empty() {
        json!([])
    } else {
        let file = if trace_files.len() == 1 {
            rel(&trace_files[0])
        } else {
            let r = rel(&trace_files[0]);
            match r.rfind('/') {
                Some(i) => format!("{}/*", &r[..i]),
                None => "*".into(),
            }
        };
        let mut t = JMap::new();
        t.insert("file".into(), json!(file));
        if let Some(ig) = ignore.as_ref().filter(|i| !i.is_empty()) {
            t.insert("ignore".into(), json!(ig));
        }
        t.insert("series".into(), json!({ "rps": false, "latency": false, "endpoints": !endpoint_series }));
        json!([Value::Object(t)])
    };
    manifest.insert("traces".into(), traces_v);
    let here = cwd();
    let billing = match src.get("bill") {
        Some(b) if b.get("cur").and_then(|x| x.as_str()).is_some() => {
            let mut x = JMap::new();
            x.insert("cur".into(), json!(resolve(&here, b["cur"].as_str().unwrap()).to_string_lossy()));
            if let Some(t) = b.get("tag").filter(|t| t.as_str().map(|s| !s.is_empty()).unwrap_or(false)) {
                x.insert("tag".into(), t.clone());
            }
            if let Some(r) = b.get("resources").filter(|r| !r.is_null()) {
                x.insert("resources".into(), r.clone());
            }
            json!([Value::Object(x)])
        }
        Some(b) if b.get("gcp").and_then(|x| x.as_str()).is_some() => {
            let mut x = JMap::new();
            x.insert("gcp".into(), json!(resolve(&here, b["gcp"].as_str().unwrap()).to_string_lossy()));
            if let Some(t) = b.get("tag").filter(|t| t.as_str().map(|s| !s.is_empty()).unwrap_or(false)) {
                x.insert("tag".into(), t.clone());
            }
            json!([Value::Object(x)])
        }
        _ => json!([]),
    };
    manifest.insert("billing".into(), billing);
    if let Some(p) = system.get("placement").filter(|p| !p.is_null()) {
        manifest.insert("placement".into(), p.clone());
    }
    let mut model = JMap::new();
    for k in ["slo", "timeoutMs", "hostedBy"] {
        if let Some(v) = system.get(k).filter(|v| !v.is_null() && v.as_f64() != Some(0.0)) {
            model.insert(k.into(), v.clone());
        }
    }
    manifest.insert("model".into(), Value::Object(model));
    let manifest_path = Path::new(&tel).join("hindcast.import.yaml").to_string_lossy().to_string();
    let manifest_v = Value::Object(manifest);
    std::fs::write(&manifest_path, format!("# Written by Hindcast collect_telemetry, {}: {}\n{}", iso(now), parts.iter().map(|(a, b)| format!("{} … {}", iso(*a), iso(*b))).collect::<Vec<_>>().join(", "), crate::yaml_out::to_yaml(&manifest_v))).map_err(|e| e.to_string())?;

    // ---- import
    super::progress("importing", 3.0, 4.0);
    let mut fs = DiskFiles::for_manifest(&manifest_path);
    let (dataset, log) = crate::import::manifest::import_bundle(&manifest_v, &mut fs).map_err(|e| {
        if e != "no data points were imported" {
            return e;
        }
        // nothing came back for the window: say which window, when traffic last flowed, and what to try
        let seen = match newest {
            Some(nw) => format!("; the newest requests the probe found are around {}", iso(nw)),
            None => "; the probe found no requests in the last 30 days either".to_string(),
        };
        format!(
            "no data points were imported: the source returned no samples for {} … {}{}. Collect a window when the system served traffic (`last`, e.g. \"7d\", or `start` and `end`; quickstart: --last 7d, or --start and --end), and check that the services and namespaces connect_telemetry kept are the ones that serve it",
            iso(start),
            iso(end),
            seen
        )
    })?;
    for l in log.iter().filter(|l| l.what.contains(": endpoint mix taken from the ")) {
        warnings.push(format!("{}. Span metrics of a service with several replicas, exported without a label per replica, jump between the replicas' counters and rate() reads each drop as a reset", l.what));
    }
    let mut d = crate::cli::util::to_json(&dataset);
    let rename = system.get("rename").and_then(|r| r.as_object()).cloned().unwrap_or_default();
    if !outside.is_empty() {
        let gone: Vec<&String> = outside.iter().filter(|id| d["services"].get(id.as_str()).is_some()).collect();
        if !gone.is_empty() {
            warnings.push(format!(
                "left out {}: their workloads run outside the namespaces collected ({}), though their request metrics are in the same Prometheus",
                gone.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", "),
                strs(dd.as_ref().unwrap_or(&prom).get("namespaces")).unwrap_or_default().join(", ")
            ));
        }
    }
    let excluded = strs(system.get("exclude")).unwrap_or_default();
    let watching: Vec<String> = observability_in(d["services"].as_object().map(|s| s.keys().filter(|id| !excluded.contains(*id) && !outside.contains(*id)).collect::<Vec<_>>()).unwrap_or_default().into_iter(), &strs(system.get("include")).unwrap_or_default());
    if !watching.is_empty() {
        warnings.push(observability_said(&watching));
    }
    let dropped: Vec<String> = excluded.into_iter().chain(outside.iter().cloned()).chain(watching.iter().cloned()).collect();
    for id in dropped.iter().cloned() {
        if let Some(Value::Object(s)) = d.get_mut("services") {
            s.shift_remove(&id);
        }
        if let Some(Value::Object(c)) = d.get_mut("bill").and_then(|b| b.get_mut("components")) {
            c.shift_remove(&id);
        }
        if let Some(Value::Object(e)) = d.get_mut("endpoints") {
            e.retain(|_, x| x.get("service").and_then(|s| s.as_str()) != Some(id.as_str()));
        }
    }
    if presets.iter().any(|p| p == "kubernetes") {
        let ns = strs(prom.get("namespaces")).unwrap_or_default();
        match query_prom(&prom_url, &h, &crate::prom_export::pods_by_node_query(&ns), end) {
            Ok(rows) => {
                let mut by: JMap<String, Value> = JMap::new();
                for r in rows {
                    let w = sval(r["metric"].get("workload"));
                    let id = rename.get(&w).and_then(|x| x.as_str()).map(String::from).unwrap_or(w);
                    if d["services"].get(&id).is_none() {
                        continue;
                    }
                    let node = sval(r["metric"].get("node"));
                    let v = crate::import::js_number_of(r.get("value").and_then(|x| x.get(1)));
                    if let Value::Object(m) = by.entry(id).or_insert(json!({})) {
                        m.insert(node, crate::cli::util::to_json(&v));
                    }
                }
                if !by.is_empty() {
                    d["podsByNode"] = Value::Object(by);
                }
                let ni = query_prom(&prom_url, &h, "kube_node_info", end).unwrap_or_default();
                let mut zones = JMap::new();
                for r in ni {
                    let z = crate::prom_export::zone_of_provider_id(r["metric"].get("provider_id").and_then(|x| x.as_str()));
                    if let (Some(z), Some(node)) = (z, r["metric"].get("node").and_then(|x| x.as_str()).filter(|n| !n.is_empty())) {
                        zones.insert(node.to_string(), json!(z));
                    }
                }
                if !zones.is_empty() {
                    d["nodeZones"] = Value::Object(zones);
                }
                let mut hpa = hpa_specs(&prom_url, &h, end, &ns);
                let gone: Vec<String> = hpa.keys().filter(|id| d["services"].get(rename.get(*id).and_then(|x| x.as_str()).unwrap_or(id)).is_none()).cloned().collect();
                for g in gone {
                    hpa.shift_remove(&g);
                }
                if !hpa.is_empty() {
                    d["hpa"] = Value::Object(hpa.into_iter().map(|(k, v)| (rename.get(&k).and_then(|x| x.as_str()).map(String::from).unwrap_or(k), v)).collect());
                }
            }
            Err(_) => warnings.push("could not read which node each pod runs on (kube_pod_info): node-loss checks are unavailable".into()),
        }
    }
    if let Some(topo) = d.get("topology").cloned().filter(|t| !t.is_null()) {
        let hosted = system.get("hostedBy").and_then(|h| h.as_object()).cloned().unwrap_or_default();
        let tsvc = topo.get("services").and_then(|s| s.as_object()).cloned().unwrap_or_default();
        let mut traced: indexmap::IndexSet<String> = tsvc.keys().cloned().collect();
        traced.extend(hosted.keys().cloned());
        let edges = topo.get("edges").and_then(|e| e.as_array()).cloned().unwrap_or_default();
        let named: indexmap::IndexSet<String> = edges.iter().flat_map(|e| [sval(e.get("from")), sval(e.get("to"))]).collect();
        let loose: Vec<String> = d["services"].as_object().map(|s| s.keys().filter(|id| !traced.contains(*id) && !named.contains(*id)).cloned().collect()).unwrap_or_default();
        for (id, shape) in &tsvc {
            let has_cpu = d["services"].get(id).and_then(|s| s.get("cpuCores")).and_then(|c| c.as_array()).map(|a| a.iter().any(|v| !v.is_null())).unwrap_or(false);
            if hosted.get(id).map(|v| !v.is_null() && v.as_str() != Some("")).unwrap_or(false) || has_cpu || watching.contains(id) {
                continue;
            }
            let mut callers: indexmap::IndexSet<String> = indexmap::IndexSet::new();
            for e in edges.iter().filter(|e| sval(e.get("to")) == *id) {
                callers.insert(sval(e.get("from")));
            }
            let kind = shape.get("kind").and_then(|k| k.as_str()).unwrap_or("");
            if callers.len() == 1 && kind != "server" {
                let c = callers.first().unwrap();
                warnings.push(format!("{} ({}) is traced but has no container metrics: a managed service, or running inside {}'s process. If it runs inside {}, connect_telemetry with system.hostedBy {{ \"{}\": \"{}\" }} so it scales with it", id, kind, c, c, id, c));
            }
        }
        if !loose.is_empty() {
            warnings.push(format!("in the metrics but in no trace: {}. If they belong to another system, connect_telemetry with system.exclude; if they are part of this one (load balancers, databases), they are priced but not modelled for latency", loose.join(", ")));
        }
    }
    // without traces, the topology the metrics give; with or without, the gRPC calls in it
    let mut prov = json!({ "traces": inferred.is_none() });
    if let Some(c) = inferred.as_mut() {
        c.out_ms = super::infer::outbound_ms(&infer_prom, &c.from, &parts, d["start"].as_f64().unwrap_or(0.0), d["stepS"].as_f64().unwrap_or(step_s), d["n"].as_f64().unwrap_or(0.0) as usize, &rate_window);
    }
    if let Some(c) = &inferred {
        let a = super::infer::apply(&mut d, c);
        warnings.insert(0, format!("{} — Jaeger or Tempo (or trace files) would give each endpoint its own path and measured self times", a.provenance["said"].as_str().unwrap_or("")));
        warnings.extend(a.warnings);
        prov = a.provenance;
    }
    let (grpc, grpc_how) = super::infer::grpc_servers(&infer_prom, &presets, &strs(probe.get("grpcMetrics")).unwrap_or_default(), &parts);
    if let Some(g) = super::infer::grpc_provenance(&d, &grpc, &grpc_how) {
        prov["grpc"] = g;
    }
    if inferred.is_some() || prov.get("grpc").is_some() {
        d["provenance"] = prov.clone();
    }
    if let Some(w) = separate_systems(&d, &probe["workloadNamespaces"], if dd.is_some() { "datadog" } else { "prometheus" }) {
        warnings.insert(0, w);
    }
    ws.write_json("dataset.json", &d, false)?;
    let _ = std::fs::remove_file(ws.path("model.json"));
    let _ = std::fs::remove_file(ws.path("calibration.json"));
    let mut sys = system.as_object().cloned().unwrap_or_default();
    match &entry {
        Some(e) => {
            sys.insert("entry".into(), json!(e));
        }
        None => {
            sys.shift_remove("entry");
        }
    }
    if let Some(ig) = ignore.as_ref().filter(|i| !i.is_empty()) {
        sys.insert("ignore".into(), json!(ig));
    }
    src.insert("system".into(), Value::Object(sys));
    ws.save_sources(&Value::Object(src))?;

    let coverage = coverage_of(&d);
    for c in &coverage {
        let has = |k: &str| c["has"].as_array().map(|a| a.iter().any(|x| x == k)).unwrap_or(false);
        let missing = |k: &str| c["missing"].as_array().map(|a| a.iter().any(|x| x == k)).unwrap_or(false);
        if missing("cpuLimitCores") && has("cpuCores") {
            warnings.push(format!("{}: CPU use but no CPU limit — capacity can't come from CPU, and resize strategies can't be priced", c["service"].as_str().unwrap_or("")));
        }
    }
    if d.get("bill").map(|b| b.is_null()).unwrap_or(true) {
        warnings.push(if d.get("cluster").map(|c| !c.is_null()).unwrap_or(false) {
            "no bill: calibrate_model prices each service as its requests' share of a node, at the node size's on-demand list price".into()
        } else {
            "no bill: calibrate_model prices services at AWS Fargate list prices from their CPU and memory limits".into()
        });
    }
    let (ds, dn, dstep) = (d["start"].as_f64().unwrap_or(0.0), d["n"].as_f64().unwrap_or(0.0), d["stepS"].as_f64().unwrap_or(0.0));
    let mut out = JMap::new();
    out.insert("window".into(), json!({ "start": iso(ds), "end": iso(ds + dn * dstep), "stepS": crate::cli::util::to_json(&dstep), "buckets": crate::cli::util::to_json(&dn), "hours": crate::cli::util::to_json(&(js_round((dn * dstep) / 360.0) / 10.0)) }));
    out.insert("presets".into(), json!(presets));
    match &entry {
        Some(e) => {
            out.insert("entry".into(), json!(e));
        }
        None => {}
    }
    out.insert("ignored".into(), json!(ignore.clone().unwrap_or_default()));
    if !watching.is_empty() {
        out.insert("observability".into(), json!(watching));
    }
    out.insert("traces".into(), if trace_note.is_empty() { Value::Null } else { json!(trace_note) });
    if inferred.is_some() {
        out.insert("withoutTraces".into(), prov.clone());
    }
    out.insert("services".into(), json!(d["services"].as_object().map(|s| s.len()).unwrap_or(0)));
    out.insert("endpoints".into(), json!(d["endpoints"].as_object().map(|s| s.keys().cloned().collect::<Vec<_>>()).unwrap_or_default()));
    out.insert("coverage".into(), json!(coverage));
    out.insert("emptyQueries".into(), json!(empty));
    out.insert("imported".into(), json!(log.iter().map(|l| format!("{}{}", l.what, l.points.map(|p| format!(" ({} points)", crate::math::js_locale(p))).unwrap_or_default())).collect::<Vec<_>>()));
    out.insert("bill".into(), if d.get("bill").map(|b| b.is_null()).unwrap_or(true) { Value::Null } else { json!(format!("${} over the bill window", js_to_fixed(d["bill"]["total"].as_f64().unwrap_or(0.0), 2))) });
    out.insert("warnings".into(), json!(warnings));
    out.insert("files".into(), json!({ "manifest": manifest_path, "dataset": ws.path("dataset.json") }));
    out.insert("next".into(), json!("calibrate_model"));
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observability_tooling_is_recognised_by_name() {
        for w in ["jaeger", "jaeger-query", "otel-collector", "opentelemetry-collector", "otelcol-contrib", "prometheus", "kube-prometheus-stack-operator", "prometheus-kube-prometheus-prometheus", "monitoring-grafana", "alertmanager-main", "tempo", "loki", "promtail", "kube-state-metrics", "node-exporter", "prometheus-node-exporter", "redis-exporter", "fluent-bit", "datadog-agent"] {
            assert!(observability(w), "{}", w);
        }
        for w in ["frontend", "cart", "checkout", "api-gateway", "otel-demo-frontend", "export-service", "exporter-api", "metrics-api", "logging-proxy", "flagd", "grafanalytics"] {
            assert!(!observability(w), "{}", w);
        }
        let ids: Vec<String> = ["frontend", "jaeger", "otel-collector", "grafana"].iter().map(|x| x.to_string()).collect();
        assert_eq!(observability_in(ids.iter(), &["grafana".to_string()]), vec!["jaeger".to_string(), "otel-collector".to_string()]);
        assert_eq!(
            observability_said(&["jaeger".to_string(), "otel-collector".to_string()]),
            "left out as observability tooling, not part of the system: jaeger, otel-collector. To count one in, connect_telemetry with system.include [\"jaeger\"] (quickstart: --include jaeger)"
        );
    }

    fn dataset(services: &[&str], edges: &[(&str, &str)]) -> Value {
        json!({
            "services": services.iter().map(|s| (s.to_string(), json!({}))).collect::<JMap<String, Value>>(),
            "topology": { "edges": edges.iter().map(|(a, b)| json!({ "from": a, "to": b })).collect::<Vec<_>>() },
        })
    }

    #[test]
    fn two_apps_on_one_prometheus_are_named_apart() {
        let d = dataset(&["frontend", "cart", "checkout", "api-gateway", "vets", "jaeger"], &[("frontend", "cart"), ("frontend", "checkout"), ("api-gateway", "vets")]);
        let ns = json!({ "frontend": ["shop"], "cart": ["shop"], "checkout": ["shop"], "api-gateway": ["petclinic"], "vets": ["petclinic"], "jaeger": ["shop"] });
        let w = separate_systems(&d, &ns, "prometheus").unwrap();
        assert!(w.starts_with("the history holds 2 groups of services that never call each other: frontend, cart, checkout (namespace shop); api-gateway, vets (namespace petclinic)."), "{}", w);
        assert!(w.ends_with("prometheus.namespaces [\"shop\"] (quickstart: --namespace shop)"), "{}", w);
        // a service no edge names (jaeger) is not a system of its own
        assert!(!w.contains("jaeger"));
    }

    #[test]
    fn one_connected_system_says_nothing() {
        let d = dataset(&["frontend", "cart", "currency"], &[("frontend", "cart"), ("cart", "currency")]);
        assert_eq!(separate_systems(&d, &Value::Null, "prometheus"), None);
    }

    #[test]
    fn groups_sharing_a_namespace_are_told_to_exclude() {
        let d = dataset(&["a", "b", "c", "d", "e", "f", "g"], &[("a", "b"), ("b", "c"), ("c", "d"), ("d", "e"), ("f", "g")]);
        let w = separate_systems(&d, &Value::Null, "prometheus").unwrap();
        assert!(w.contains(": a, b, c and 2 more; f, g."), "{}", w);
        assert!(w.contains("system.exclude"), "{}", w);
    }

    #[test]
    fn a_trace_backend_with_a_corner_of_the_system_is_not_its_topology() {
        let probe = json!({ "services": { "otel-spanmetrics": ["ad", "cart", "checkout", "frontend", "quote"], "kubernetes": ["ad", "cart"] } });
        assert_eq!(metered_services(&probe), 5);
        let one = json!({ "kind": "jaeger", "services": ["frontend"], "entry": ["frontend"] });
        assert!(traces_unusable(&one, 5).unwrap().starts_with("Jaeger traces 1 of the 5 services with request metrics (frontend): "));
        let most = json!({ "kind": "tempo", "services": ["ad", "cart", "frontend"], "entry": ["frontend"] });
        assert_eq!(traces_unusable(&most, 5), None);
        let none = json!({ "kind": "tempo", "services": [], "entry": [] });
        assert!(traces_unusable(&none, 5).unwrap().starts_with("Tempo has no traces of this system"));
    }

    #[test]
    fn services_running_outside_the_chosen_namespaces_are_left_out() {
        let wns = json!({ "frontend": ["shop"], "api-gateway": ["petclinic"], "shop-worker": ["shop", "petclinic"], "coredns": ["kube-system"] });
        let rename: JMap<String, Value> = [("coredns".to_string(), json!("dns"))].into_iter().collect();
        assert_eq!(outside_namespaces(&wns, &["shop".to_string()], &rename), vec!["api-gateway".to_string(), "dns".to_string()]);
        assert!(outside_namespaces(&wns, &[], &rename).is_empty());
    }

    #[test]
    fn empty_trace_backend_says_what_it_falls_back_to() {
        assert_eq!(
            empty_traces_said("Jaeger", &[]),
            "Jaeger has no traces of this system before the window's end (it knows no services): who calls whom is read from the metrics instead, as without traces. Check that the services export traces to it and that its retention covers the window"
        );
    }
}
