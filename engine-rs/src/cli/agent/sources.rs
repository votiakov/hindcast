//! Talking to live telemetry, read-only (agent/sources.ts): what a Prometheus holds and for how long,
//! which services a Jaeger or Tempo knows, and traces fetched spread over a window.

use super::workspace::{api, auth_headers, get_json, iso};
use crate::import::traces::{parse_value, Span};
use crate::math::{js_num, js_round};
use indexmap::{IndexMap, IndexSet};
use serde_json::{json, Map as JMap, Value};

/// the metric each preset needs, and the label that names services in it
pub const PRESET_SIGNATURE: [(&str, &str, &str); 6] = [
    ("otel-spanmetrics", "traces_span_metrics_calls_total", "service_name"),
    ("http-server", "http_server_request_duration_seconds_count", "service_name"),
    ("spring", "http_server_requests_seconds_count", "job"),
    ("ingress-nginx", "nginx_ingress_controller_requests", "exported_service"),
    ("cadvisor", "container_spec_cpu_quota", "container_label_com_docker_compose_service"),
    ("kubernetes", "kube_pod_info", "pod"),
];

const NEAR_MISSES: [(&str, &str); 4] = [
    ("calls_total", "spanmetrics from an older collector (calls_total): rename with a recording rule to traces_span_metrics_calls_total"),
    ("traces_spanmetrics_calls_total", "spanmetrics from the old spanmetrics processor: rename with a recording rule to traces_span_metrics_calls_total"),
    ("http_server_duration_milliseconds_count", "OpenTelemetry HTTP metrics under the pre-1.0 name (milliseconds): the http-server preset expects http_server_request_duration_seconds"),
    ("nginx_ingress_controller_nginx_process_requests_total", "ingress-nginx without per-request metrics: requests to an Ingress without a host are only counted with --metrics-per-undefined-host=true (controller.extraArgs in the Helm chart)"),
];

const LOOKBACKS_H: [f64; 8] = [0.0, 1.0, 6.0, 24.0, 72.0, 168.0, 336.0, 720.0];

fn strs(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}

/// String(x) of a JSON scalar, and "" for what is missing
fn js_str(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => js_num(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

/// probe a Prometheus: presets, services, near misses, and when requests flowed
pub fn probe_prometheus(cfg: &Value, now: f64) -> Result<Value, String> {
    let url = cfg.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let h = auth_headers(Some(cfg))?;
    let selector = cfg.get("selector").and_then(|x| x.as_str()).filter(|x| !x.is_empty()).map(String::from);
    // url, ok, presets, nearMisses, services, warnings, then what is learned later
    let mut out = JMap::new();
    out.insert("url".into(), json!(url));
    out.insert("ok".into(), json!(false));
    out.insert("presets".into(), json!([]));
    out.insert("nearMisses".into(), json!([]));
    out.insert("services".into(), json!({}));
    out.insert("warnings".into(), json!([]));
    let mut presets: Vec<String> = vec![];
    let mut near: Vec<String> = vec![];
    let mut services = JMap::new();
    let mut warnings: Vec<String> = vec![];
    let mut version: Option<Value> = None;
    let mut wns: Option<Value> = None;
    let mut data: Option<Value> = None;
    match get_json(&api(&url, "api/v1/status/buildinfo", &[]), &h, 10_000) {
        Ok(b) => version = Some(b.get("data").and_then(|d| d.get("version")).cloned().unwrap_or(Value::Null)),
        Err(e) => {
            let u: Vec<u16> = e.encode_utf16().collect();
            let cut = String::from_utf16_lossy(&u[..u.len().min(80)]);
            warnings.push(format!("buildinfo unavailable ({}) — fine for Thanos/Mimir/managed Prometheus", cut));
        }
    }
    let start = js_num(now - 30.0 * 86400.0);
    let mut names: Vec<&str> = PRESET_SIGNATURE.iter().map(|p| p.1).collect();
    names.extend(NEAR_MISSES.iter().map(|n| n.0));
    let found = get_json(&api(&url, "api/v1/label/__name__/values", &[("match[]", format!("{{__name__=~\"{}\"}}", names.join("|"))), ("start", start.clone()), ("end", js_num(now))]), &h, 30_000).map_err(|e| {
        // the two ways a first connection usually fails, with what to try
        if e.contains("answered 404") {
            format!("{} — is Prometheus served under a path (e.g. {}/prometheus)? Give the URL that /api/v1/query sits under", e, url.trim_end_matches('/'))
        } else if e.contains("answered 401") || e.contains("answered 403") {
            format!("{} — it wants credentials: put a token in an environment variable and name it with prometheus.tokenEnv (quickstart: --token-env)", e)
        } else if e.starts_with("fetch failed") {
            format!("{} — is it reachable from here? In a cluster: kubectl port-forward svc/<prometheus> 9090, then http://localhost:9090", e)
        } else {
            e
        }
    })?;
    let ok = found.get("status").and_then(|x| x.as_str()) == Some("success");
    let have: IndexSet<String> = strs(found.get("data").unwrap_or(&Value::Null)).into_iter().collect();
    for (id, metric, label) in PRESET_SIGNATURE {
        if !have.contains(metric) {
            continue;
        }
        let m = match &selector {
            Some(s) => format!("{}{{{}}}", metric, s),
            None => metric.to_string(),
        };
        let vals = get_json(&api(&url, &format!("api/v1/label/{}/values", label), &[("match[]", m), ("start", start.clone()), ("end", js_num(now))]), &h, 30_000)?;
        let mut svcs: Vec<String> = strs(vals.get("data").unwrap_or(&Value::Null)).into_iter().filter(|v| !v.is_empty() && v != "POD").collect();
        if svcs.is_empty() {
            warnings.push(format!("{} exists but has no \"{}\" label{} — the {} preset can't name services", metric, label, selector.as_ref().map(|s| format!(" under {}", s)).unwrap_or_default(), id));
            continue;
        }
        presets.push(id.to_string());
        svcs.sort();
        services.insert(id.into(), json!(svcs));
        if id == "kubernetes" {
            let sel = [selector.clone().unwrap_or_default(), "pod!=\"\"".to_string()].iter().filter(|x| !x.is_empty()).cloned().collect::<Vec<_>>().join(",");
            let q = format!("group by (namespace, workload) (label_replace(last_over_time(kube_pod_info{{{}}}[1d]), \"workload\", \"$1$2$3\", \"pod\", \"{}\"))", sel, crate::prom_export::workload_re());
            let w = get_json(&api(&url, "api/v1/query", &[("query", q), ("time", js_num(now))]), &h, 30_000).ok();
            let mut ns: IndexMap<String, Vec<String>> = IndexMap::new();
            for r in w.as_ref().and_then(|w| w.get("data")).and_then(|d| d.get("result")).and_then(|r| r.as_array()).cloned().unwrap_or_default() {
                let name = js_str(r.get("metric").and_then(|m| m.get("workload")));
                if !name.is_empty() {
                    ns.entry(name).or_default().push(js_str(r.get("metric").and_then(|m| m.get("namespace"))));
                }
            }
            if !ns.is_empty() {
                let mut keys: Vec<String> = ns.keys().cloned().collect();
                keys.sort();
                services.insert(id.into(), json!(keys));
                wns = Some(json!(ns));
            }
        }
    }
    for (n, why) in NEAR_MISSES {
        if have.contains(n) && !(n.starts_with("nginx_ingress") && have.contains("nginx_ingress_controller_requests")) {
            near.push(format!("{}: {}", n, why));
        }
    }
    if presets.is_empty() {
        warnings.push("no metric any preset reads was found in the last 30 days".into());
    }
    // when requests flowed: traffic at a few lookbacks, then bisected to ~1% of the gap
    let main = presets.iter().find(|p| matches!(p.as_str(), "otel-spanmetrics" | "http-server" | "spring")).cloned();
    if let Some(main) = main {
        let m = PRESET_SIGNATURE.iter().find(|p| p.0 == main).unwrap().1;
        let sel = selector.as_ref().map(|s| format!("{{{}}}", s)).unwrap_or_default();
        let traffic = |t: f64| -> Result<f64, String> {
            let r = get_json(&api(&url, "api/v1/query", &[("query", format!("sum(increase({}{}[10m]))", m, sel)), ("time", js_num(t))]), &h, 30_000)?;
            let v = r.get("data").and_then(|d| d.get("result")).and_then(|x| x.get(0)).and_then(|x| x.get("value")).and_then(|x| x.get(1));
            Ok(match v {
                None | Some(Value::Null) => 0.0,
                x => crate::import::js_number_of(x),
            })
        };
        let mut probes: Vec<Value> = vec![];
        let mut active: Vec<f64> = vec![];
        for h_ago in LOOKBACKS_H {
            let t = now - h_ago * 3600.0;
            let n = traffic(t)?;
            probes.push(json!({ "at": iso(t), "requests10m": js_round(n) }));
            if n > 0.0 {
                active.push(t);
            }
        }
        if !active.is_empty() {
            let edge = |on0: f64, off0: f64| -> Result<f64, String> {
                let k = 48.0;
                let mut last = on0;
                for j in 1..48 {
                    let t = on0 + ((off0 - on0) * j as f64) / k;
                    if traffic(t)? > 0.0 {
                        last = t;
                    }
                }
                let mut next = last + (off0 - on0) / k;
                if (next - off0).signum() == (off0 - on0).signum() && next != off0 {
                    next = off0;
                }
                let (mut on, mut off) = (last, next);
                for _ in 0..8 {
                    let mid = (on + off) / 2.0;
                    if traffic(mid)? > 0.0 {
                        on = mid;
                    } else {
                        off = mid;
                    }
                }
                Ok(on)
            };
            let newest_active = active.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            let mut newer: Vec<f64> = LOOKBACKS_H.iter().map(|x| now - x * 3600.0).filter(|t| *t > newest_active).collect();
            newer.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let newest = match newer.first() {
                Some(t) => edge(newest_active, *t)?,
                None => newest_active,
            };
            let oldest_active = active.iter().copied().fold(f64::INFINITY, f64::min);
            let mut older: Vec<f64> = LOOKBACKS_H.iter().map(|x| now - x * 3600.0).filter(|t| *t < oldest_active).collect();
            older.sort_by(|a, b| b.partial_cmp(a).unwrap());
            let oldest = match older.first() {
                Some(t) => edge(oldest_active, *t)?,
                None => oldest_active,
            } - 600.0;
            data = Some(json!({ "newest": iso(newest), "oldestFound": iso(oldest), "hoursFound": js_round((newest - oldest) / 360.0) / 10.0, "probes": probes }));
            if now - newest > 3600.0 {
                warnings.push(format!("no requests in the last hour — the system is idle or no longer instrumented; the newest traffic is around {}", iso(newest)));
            }
            if active.len() < LOOKBACKS_H.iter().filter(|x| now - *x * 3600.0 >= oldest).count() {
                warnings.push("traffic comes and goes inside the window (idle stretches between busy ones)".into());
            }
        } else {
            warnings.push(format!("{} shows no requests in the last 30 days", m));
        }
    }
    out.insert("ok".into(), json!(ok));
    out.insert("presets".into(), json!(presets));
    out.insert("nearMisses".into(), json!(near));
    out.insert("services".into(), Value::Object(services));
    out.insert("warnings".into(), json!(warnings));
    if let Some(v) = version {
        if !v.is_null() {
            out.insert("version".into(), v);
        }
    }
    if let Some(w) = wns {
        out.insert("workloadNamespaces".into(), w);
    }
    if let Some(d) = data {
        out.insert("data".into(), d);
    }
    Ok(Value::Object(out))
}

/// exact match, else a name containing the other ("shop-frontend" ↔ "frontend")
pub fn suggest_renames(probe: &Value, trace_services: &[String]) -> JMap<String, Value> {
    let svc = |p: &str| strs(probe.get("services").and_then(|s| s.get(p)).unwrap_or(&Value::Null));
    let mut canonical: IndexSet<String> = IndexSet::new();
    canonical.extend(svc("otel-spanmetrics"));
    canonical.extend(svc("http-server"));
    canonical.extend(trace_services.iter().cloned());
    let mut out = JMap::new();
    for preset in ["ingress-nginx", "cadvisor", "kubernetes"] {
        let containers: IndexSet<String> = svc(preset).into_iter().collect();
        for raw in &containers {
            if canonical.contains(raw) {
                continue;
            }
            let hits: Vec<&String> = canonical.iter().filter(|c| !containers.contains(*c) && (raw.ends_with(&format!("-{}", c)) || raw.starts_with(&format!("{}-", c)) || raw.ends_with(&format!("_{}", c)))).collect();
            if hits.len() == 1 {
                out.insert(raw.clone(), json!(hits[0]));
            }
        }
    }
    out
}

fn esc_alt(x: &str) -> String {
    let mut o = String::new();
    for c in x.chars() {
        if ".*+?^${}()|[]\\\"".contains(c) {
            o.push_str("\\\\");
        }
        o.push(c);
    }
    o
}

/// entry-service requests per slice of [start, end]
pub fn traffic_by_slice(cfg: &Value, presets: &[String], entry: &[String], start: f64, end: f64, slices: usize) -> Result<Option<Vec<f64>>, String> {
    let width = ((end - start) / slices as f64).floor().max(1.0);
    let m = entry.iter().map(|e| esc_alt(e)).collect::<Vec<_>>().join("|");
    let selector = cfg.get("selector").and_then(|x| x.as_str()).filter(|x| !x.is_empty()).map(String::from);
    let join = |parts: Vec<String>| parts.into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(",");
    let sel = join(vec![selector.clone().unwrap_or_default(), format!("service_name=~\"{}\"", m)]);
    let win = format!("{}s", js_num(width));
    let has = |p: &str| presets.iter().any(|x| x == p);
    let query = if has("otel-spanmetrics") {
        format!("sum(increase(traces_span_metrics_calls_total{{span_kind=\"SPAN_KIND_SERVER\",{}}}[{}]))", sel, win)
    } else if has("http-server") {
        format!("sum(increase(http_server_request_duration_seconds_count{{{}}}[{}]))", sel, win)
    } else if has("spring") {
        format!("sum(increase(http_server_requests_seconds_count{{{}}}[{}]))", join(vec![selector.unwrap_or_default(), format!("job=~\"{}\"", m)]), win)
    } else {
        return Ok(None);
    };
    let url = cfg.get("url").and_then(|x| x.as_str()).unwrap_or("");
    let u = api(url, "api/v1/query_range", &[("query", query), ("start", js_num(start + width)), ("end", js_num(start + width * slices as f64)), ("step", format!("{}s", js_num(width)))]);
    let r = get_json(&u, &auth_headers(Some(cfg))?, 30_000)?;
    let mut out = vec![0.0; slices];
    for p in r.get("data").and_then(|d| d.get("result")).and_then(|x| x.get(0)).and_then(|x| x.get("values")).and_then(|x| x.as_array()).cloned().unwrap_or_default() {
        let t = crate::import::js_number_of(p.get(0));
        let v = crate::import::js_number_of(p.get(1));
        let k = js_round((t - start) / width) - 1.0;
        if k >= 0.0 && (k as usize) < slices && v.is_finite() {
            out[k as usize] = v;
        }
    }
    Ok(Some(out))
}

/// entry services, client-only services and the call edges of a set of spans
pub fn shape_of(spans: &[Span]) -> (Vec<String>, Vec<String>, Vec<String>) {
    let by_id: std::collections::HashMap<&str, &Span> = spans.iter().map(|s| (s.span_id.as_str(), s)).collect();
    let mut server: IndexSet<String> = IndexSet::new();
    let mut roots: IndexSet<String> = IndexSet::new();
    let mut edges: IndexSet<String> = IndexSet::new();
    let mut entry: IndexSet<String> = IndexSet::new();
    let mut rootless: IndexMap<&str, usize> = IndexMap::new();
    let has_root: IndexSet<&str> = spans.iter().filter(|s| s.parent_id.is_none()).map(|s| s.trace_id.as_str()).collect();
    for (i, s) in spans.iter().enumerate() {
        if s.kind == "server" || s.kind == "consumer" {
            server.insert(s.service.to_string());
        }
        match &s.parent_id {
            None => {
                roots.insert(s.service.to_string());
            }
            Some(p) if !by_id.contains_key(p.as_str()) && !has_root.contains(s.trace_id.as_str()) => {
                let better = match rootless.get(s.trace_id.as_str()) {
                    None => true,
                    Some(&c) => s.start < spans[c].start,
                };
                if better {
                    rootless.insert(s.trace_id.as_str(), i);
                }
            }
            _ => {}
        }
    }
    let stand_ins: IndexSet<usize> = rootless.values().copied().collect();
    for &i in &stand_ins {
        roots.insert(spans[i].service.to_string());
    }
    let clients_only: Vec<String> = roots.iter().filter(|s| !server.contains(*s)).cloned().collect();
    for (i, s) in spans.iter().enumerate() {
        let p = s.parent_id.as_ref().and_then(|p| by_id.get(p.as_str()));
        if let Some(p) = p {
            if *p.service != *s.service {
                edges.insert(format!("{} → {}", p.service, s.service));
            }
        }
        if s.kind != "server" {
            continue;
        }
        if s.parent_id.is_none() || stand_ins.contains(&i) || p.map(|p| clients_only.iter().any(|c| *c == *p.service)).unwrap_or(false) {
            entry.insert(s.service.to_string());
        }
    }
    let mut e: Vec<String> = entry.into_iter().collect();
    e.sort();
    let mut c = clients_only;
    c.sort();
    let mut ed: Vec<String> = edges.into_iter().collect();
    ed.sort();
    (e, c, ed)
}

fn trace_probe(kind: &str, url: &str) -> JMap<String, Value> {
    let mut o = JMap::new();
    o.insert("kind".into(), json!(kind));
    o.insert("url".into(), json!(url));
    o.insert("ok".into(), json!(false));
    for k in ["services", "entry", "clientsOnly", "edges", "warnings"] {
        o.insert(k.into(), json!([]));
    }
    o
}

fn assign_shape(o: &mut JMap<String, Value>, spans: &[Span]) {
    let (e, c, ed) = shape_of(spans);
    o.insert("entry".into(), json!(e));
    o.insert("clientsOnly".into(), json!(c));
    o.insert("edges".into(), json!(ed));
}

fn jaeger_traces(url: &str, h: &[(String, String)], q: &[(&str, String)]) -> Result<Value, String> {
    get_json(&api(url, "api/traces", q), h, 60_000)
}

pub fn probe_jaeger(cfg: &Value, now: f64) -> Result<Value, String> {
    let url = cfg.get("url").and_then(|x| x.as_str()).unwrap_or("");
    let h = auth_headers(Some(cfg))?;
    let mut out = trace_probe("jaeger", url);
    let s = get_json(&api(url, "api/services", &[]), &h, 10_000)?;
    out.insert("ok".into(), json!(true));
    let mut services: Vec<String> = strs(s.get("data").unwrap_or(&Value::Null)).into_iter().filter(|x| !x.starts_with("jaeger")).collect();
    services.sort();
    out.insert("services".into(), json!(services));
    let mut warnings: Vec<String> = vec![];
    if services.is_empty() {
        warnings.push("Jaeger knows no services yet".into());
    }
    let mut spans: Vec<Span> = vec![];
    for svc in services.iter().take(25) {
        let r = jaeger_traces(url, &h, &[("service", svc.clone()), ("limit", "20".into()), ("start", js_num(((now - 7.0 * 86400.0) * 1e6).floor())), ("end", js_num((now * 1e6).floor()))])?;
        parse_value(&r, &mut spans);
    }
    assign_shape(&mut out, &spans);
    if spans.is_empty() {
        warnings.push("no traces in the last 7 days".into());
    }
    out.insert("warnings".into(), json!(warnings));
    Ok(Value::Object(out))
}

fn tempo_search(url: &str, h: &[(String, String)], start: f64, end: f64, limit: usize, service: Option<&str>) -> Result<Vec<String>, String> {
    let mut q: Vec<(&str, String)> = vec![("start", js_num(start.floor())), ("end", js_num(end.ceil())), ("limit", limit.to_string())];
    if let Some(s) = service {
        q.push(("q", format!("{{ resource.service.name = \"{}\" }}", s)));
    }
    let r = get_json(&api(url, "api/search", &q), h, 60_000)?;
    Ok(r.get("traces").and_then(|t| t.as_array()).map(|a| a.iter().map(|t| js_str(t.get("traceID"))).collect()).unwrap_or_default())
}

pub fn probe_tempo(cfg: &Value, now: f64) -> Result<Value, String> {
    let url = cfg.get("url").and_then(|x| x.as_str()).unwrap_or("");
    let h = auth_headers(Some(cfg))?;
    let mut out = trace_probe("tempo", url);
    let v = get_json(&api(url, "api/search/tag/service.name/values", &[]), &h, 10_000)?;
    out.insert("ok".into(), json!(true));
    let mut services: Vec<String> = v.get("tagValues").and_then(|t| t.as_array()).map(|a| a.iter().map(|x| if x.is_string() { js_str(Some(x)) } else { js_str(x.get("value")) }).collect()).unwrap_or_default();
    services.sort();
    out.insert("services".into(), json!(services));
    let mut spans: Vec<Span> = vec![];
    let ids = tempo_search(url, &h, now - 86400.0, now, 40, None)?;
    let mut hh = h.clone();
    hh.push(("Accept".into(), "application/json".into()));
    for id in ids.iter().take(40) {
        let doc = get_json(&api(url, &format!("api/traces/{}", id), &[]), &hh, 30_000)?;
        parse_value(&doc, &mut spans);
    }
    assign_shape(&mut out, &spans);
    let mut warnings: Vec<String> = vec![];
    if spans.is_empty() {
        warnings.push("no traces in the last 24 hours".into());
    }
    out.insert("warnings".into(), json!(warnings));
    Ok(Value::Object(out))
}

pub struct Fetched {
    pub lines: Vec<String>,
    pub traces: usize,
    pub requests: usize,
    pub kind: &'static str,
}

/// traces over [start, end], spread evenly (or by traffic): one Jaeger or OTLP document per line
pub fn fetch_traces(jaeger: Option<&Value>, tempo: Option<&Value>, entry: &[String], start: f64, end: f64, max_traces: Option<f64>, slices: Option<usize>, weights: Option<&[f64]>) -> Result<Fetched, String> {
    let max = max_traces.unwrap_or(3000.0);
    let slices = match weights {
        Some(w) => w.len(),
        None => (slices.unwrap_or(48).min(((end - start) / 60.0).floor().max(0.0) as usize)).max(1),
    };
    let w: Vec<f64> = match weights {
        Some(w) if w.iter().any(|x| *x > 0.0) => w.to_vec(),
        _ => vec![1.0; slices],
    };
    let total: f64 = w.iter().sum();
    let ne = entry.len().max(1) as f64;
    let quota: Vec<usize> = w.iter().map(|x| if *x > 0.0 { ((max * x) / total / ne).ceil().max(2.0) as usize } else { 0 }).collect();
    let mut seen: IndexSet<String> = IndexSet::new();
    let mut lines: Vec<String> = vec![];
    let mut requests = 0;
    if let Some(j) = jaeger {
        let url = j.get("url").and_then(|x| x.as_str()).unwrap_or("");
        let h = auth_headers(Some(j))?;
        for k in 0..slices {
            let s = start + ((end - start) * k as f64) / slices as f64;
            let e = start + ((end - start) * (k + 1) as f64) / slices as f64;
            if quota[k] == 0 {
                continue;
            }
            for svc in entry {
                requests += 1;
                let r = jaeger_traces(url, &h, &[("service", svc.clone()), ("limit", quota[k].to_string()), ("start", js_num((s * 1e6).floor())), ("end", js_num((e * 1e6).floor()))])?;
                let fresh: Vec<Value> = r.get("data").and_then(|d| d.as_array()).cloned().unwrap_or_default().into_iter().filter(|t| !seen.contains(&js_str(t.get("traceID")))).collect();
                for t in &fresh {
                    seen.insert(js_str(t.get("traceID")));
                }
                if !fresh.is_empty() {
                    lines.push(crate::convert::js_stringify(&json!({ "data": fresh })));
                }
            }
        }
        return Ok(Fetched { lines, traces: seen.len(), requests, kind: "jaeger" });
    }
    if let Some(t) = tempo {
        let url = t.get("url").and_then(|x| x.as_str()).unwrap_or("");
        let h = auth_headers(Some(t))?;
        let mut ids: Vec<String> = vec![];
        for k in 0..slices {
            let s = start + ((end - start) * k as f64) / slices as f64;
            let e = start + ((end - start) * (k + 1) as f64) / slices as f64;
            if quota[k] == 0 {
                continue;
            }
            for svc in entry {
                requests += 1;
                for id in tempo_search(url, &h, s, e, quota[k], Some(svc))? {
                    if seen.insert(id.clone()) {
                        ids.push(id);
                    }
                }
            }
        }
        let mut hh = h.clone();
        hh.push(("Accept".into(), "application/json".into()));
        for id in &ids {
            let doc = get_json(&api(url, &format!("api/traces/{}", id), &[]), &hh, 30_000)?;
            requests += 1;
            lines.push(crate::convert::js_stringify(&doc));
        }
        return Ok(Fetched { lines, traces: ids.len(), requests, kind: "tempo" });
    }
    Err("no trace source: connect Jaeger or Tempo, or give trace files".into())
}
