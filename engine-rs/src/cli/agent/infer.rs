//! Who calls whom without traces. Read from metrics that name both ends of a call — a service mesh
//! (Istio, Linkerd), the OpenTelemetry service graph, or span metrics' client spans matched to the
//! servers that answer them — or from a topology file. Where nothing names the calls, each service with
//! request metrics is its own entry and the others are read against the entry traffic. Which services
//! serve gRPC comes from metric labels, traced or not.

use super::workspace::{api, auth_headers, get_json};
use crate::math::{js_num, js_round};
use indexmap::{IndexMap, IndexSet};
use serde_json::{json, Map as JMap, Value};

pub struct Edge {
    pub from: String,
    pub to: String,
    /// calls over the window
    pub calls: f64,
    /// calls per request of the caller, where the topology file gives it
    pub per_request: Option<f64>,
    pub grpc: bool,
}

pub struct Calls {
    /// istio, linkerd, servicegraph, spanmetrics, file or none
    pub from: String,
    pub edges: Vec<Edge>,
    pub entry: Vec<String>,
    /// entry services the ingress counted
    pub ingress: Vec<String>,
    /// callers that serve nothing: gateways, load generators, "unknown"
    pub clients: Vec<String>,
    /// services the topology file says serve gRPC
    pub grpc: IndexSet<String>,
    pub notes: Vec<String>,
    /// per caller, ms per second spent waiting on its outgoing calls, on the dataset's grid
    pub out_ms: IndexMap<String, Vec<Option<f64>>>,
    /// servers with traffic that no metric names a caller of, where the entries are known
    pub orphans: Vec<String>,
}

pub struct Prom {
    url: String,
    h: Vec<(String, String)>,
    sel: String,
    ns: Vec<String>,
    rename: JMap<String, Value>,
}

impl Prom {
    pub fn new(cfg: &Value, rename: &JMap<String, Value>) -> Result<Prom, String> {
        Ok(Prom {
            url: cfg.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            h: auth_headers(Some(cfg))?,
            sel: cfg.get("selector").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            ns: cfg.get("namespaces").and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default(),
            rename: rename.clone(),
        })
    }
    fn query(&self, expr: &str, at: f64) -> Vec<Value> {
        get_json(&api(&self.url, "api/v1/query", &[("query", expr.to_string()), ("time", js_num(at))]), &self.h, 60_000)
            .ok()
            .and_then(|r| r.get("data").and_then(|d| d.get("result")).and_then(|r| r.as_array()).cloned())
            .unwrap_or_default()
    }
    /// `{a, b}` matchers with the connection's selector (and a namespace matcher on `ns_label`)
    fn matchers(&self, extra: &[&str], ns_label: Option<&str>) -> String {
        let mut m: Vec<String> = extra.iter().filter(|x| !x.is_empty()).map(|x| x.to_string()).collect();
        if let (Some(l), false) = (ns_label, self.ns.is_empty()) {
            m.push(format!("{}=~\"{}\"", l, self.ns.join("|")));
        }
        if !self.sel.is_empty() {
            m.push(self.sel.clone());
        }
        format!("{{{}}}", m.join(","))
    }
    /// a counter's increase over each window, summed: one row per label set
    fn increase(&self, metric: &str, sel: &str, by: &str, agg: Option<&str>, parts: &[(f64, f64)]) -> Vec<(JMap<String, Value>, f64)> {
        let mut out: IndexMap<String, (JMap<String, Value>, f64)> = IndexMap::new();
        for (a, b) in parts {
            let inner = format!("sum by ({}) (increase({}{}[{}s]))", by, metric, sel, js_num((b - a).round().max(60.0)));
            let expr = match agg {
                Some(a) => a.replace("$", &inner),
                None => inner,
            };
            for r in self.query(&expr, *b) {
                let m = r.get("metric").and_then(|m| m.as_object()).cloned().unwrap_or_default();
                let v = crate::import::js_number_of(r.get("value").and_then(|v| v.get(1)));
                if !v.is_finite() || v <= 0.0 {
                    continue;
                }
                let e = out.entry(crate::convert::js_stringify(&Value::Object(m.clone()))).or_insert((m, 0.0));
                e.1 += v;
            }
        }
        out.into_values().collect()
    }
    fn name(&self, raw: &str) -> String {
        self.rename.get(raw).and_then(|x| x.as_str()).unwrap_or(raw).to_string()
    }
}

fn label(m: &JMap<String, Value>, k: &str) -> String {
    m.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

/// "pkg.CartService/GetCart", "POST /oteldemo.CartService/AddItem", "Currency/Convert" → "cart/getcart":
/// an RPC named the way gRPC names it, so a client span and the server span answering it meet
pub fn rpc_key(name: &str) -> Option<String> {
    let mut n = name.trim();
    if let Some((verb, rest)) = n.split_once(' ') {
        if verb == "POST" {
            n = rest.trim();
        } else {
            return None;
        }
    }
    let n = n.trim_start_matches('/');
    let (svc, method) = n.split_once('/')?;
    let svc = svc.rsplit('.').next().unwrap_or(svc);
    let word = |s: &str| !s.is_empty() && s.chars().next().map(|c| c.is_ascii_uppercase()).unwrap_or(false) && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !word(svc) || !word(method) {
        return None;
    }
    let base = svc.strip_suffix("Service").filter(|b| !b.is_empty()).unwrap_or(svc);
    Some(format!("{}/{}", base.to_lowercase(), method.to_lowercase()))
}

/// a monitoring or tracing UI behind the same ingress as the system: not where its users come in
fn observability(svc: &str) -> bool {
    const TOOLS: [&str; 10] = ["jaeger", "grafana", "prometheus", "alertmanager", "kibana", "tempo", "loki", "kiali", "argocd", "opensearch"];
    svc.split(['-', '_', '.']).any(|w| TOOLS.contains(&w))
}

/// a pod's workload, from its name
fn workload_of(pod: &str) -> String {
    match regex_lite::Regex::new(&crate::prom_export::workload_re()).ok().and_then(|re| re.captures(pod).map(|c| (1..=3).find_map(|k| c.get(k)).map(|m| m.as_str().to_string()))) {
        Some(Some(w)) => w,
        _ => pod.to_string(),
    }
}

/// the topology file: `entry`, `calls` (caller → [callees] or { callee: calls per request }), `grpc`
fn read_file(path: &str, p: &Prom) -> Result<Calls, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("topology file {}: {}", path, e))?;
    let v = crate::cli::util::parse_yaml(&text).map_err(|e| format!("topology file {}: {}", path, e))?;
    let names = |x: Option<&Value>| -> Vec<String> { x.and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|s| p.name(s))).collect()).unwrap_or_default() };
    let mut edges = vec![];
    for (from, to) in v.get("calls").and_then(|c| c.as_object()).cloned().unwrap_or_default() {
        let from = p.name(&from);
        match to {
            Value::Array(a) => {
                for t in a.iter().filter_map(|x| x.as_str()) {
                    edges.push(Edge { from: from.clone(), to: p.name(t), calls: 0.0, per_request: None, grpc: false });
                }
            }
            Value::Object(o) => {
                for (t, k) in o {
                    edges.push(Edge { from: from.clone(), to: p.name(&t), calls: 0.0, per_request: k.as_f64().filter(|k| *k > 0.0), grpc: false });
                }
            }
            Value::String(t) => edges.push(Edge { from: from.clone(), to: p.name(&t), calls: 0.0, per_request: None, grpc: false }),
            _ => return Err(format!("topology file {}: calls.{} lists the services it calls, or maps each to calls per request", path, from)),
        }
    }
    if edges.is_empty() && v.get("entry").is_none() {
        return Err(format!("topology file {}: give `calls` (caller: [callees]) and, optionally, `entry` and `grpc`", path));
    }
    Ok(Calls { from: "file".into(), edges, entry: names(v.get("entry")), ingress: vec![], clients: vec![], grpc: names(v.get("grpc")).into_iter().collect(), notes: vec![], out_ms: IndexMap::new(), orphans: vec![] })
}

/// who calls whom over the windows, from the first source that names any call
pub fn read_calls(p: &Prom, presets: &[String], sources: &[String], parts: &[(f64, f64)], file: Option<&str>, known: &[String]) -> Result<Calls, String> {
    let has = |x: &str| sources.iter().any(|s| s == x);
    let mut c = match file {
        Some(f) => read_file(f, p)?,
        None => Calls { from: "none".into(), edges: vec![], entry: vec![], ingress: vec![], clients: vec![], grpc: IndexSet::new(), notes: vec![], out_ms: IndexMap::new(), orphans: vec![] },
    };
    // services the source saw answering requests
    let mut servers: IndexSet<String> = IndexSet::new();
    if file.is_none() {
        if has("istio") {
            // both proxies report a meshed call: the larger count, not the sum
            let rows = p.increase("istio_requests_total", &p.matchers(&[], Some("destination_workload_namespace")), "source_workload, destination_workload, request_protocol, reporter", Some("max by (source_workload, destination_workload, request_protocol) ($)"), parts);
            for (m, v) in rows {
                let (from, to) = (label(&m, "source_workload"), label(&m, "destination_workload"));
                if to.is_empty() || to == "unknown" {
                    continue;
                }
                servers.insert(p.name(&to));
                c.edges.push(Edge { from: if from.is_empty() { "unknown".into() } else { p.name(&from) }, to: p.name(&to), calls: v, per_request: None, grpc: label(&m, "request_protocol") == "grpc" });
            }
            if !c.edges.is_empty() {
                c.from = "istio".into();
            }
        }
        if c.edges.is_empty() && has("linkerd") {
            let wl = |m: &JMap<String, Value>, d: &str, s: &str| { let x = label(m, d); if x.is_empty() { label(m, s) } else { x } };
            for (m, v) in p.increase("response_total", &p.matchers(&["direction=\"outbound\""], Some("namespace")), "deployment, statefulset, dst_deployment, dst_statefulset, grpc_status", None, parts) {
                let (from, to) = (wl(&m, "deployment", "statefulset"), wl(&m, "dst_deployment", "dst_statefulset"));
                if from.is_empty() || to.is_empty() {
                    continue;
                }
                c.edges.push(Edge { from: p.name(&from), to: p.name(&to), calls: v, per_request: None, grpc: !label(&m, "grpc_status").is_empty() });
            }
            for (m, _) in p.increase("response_total", &p.matchers(&["direction=\"inbound\""], Some("namespace")), "deployment, statefulset", None, parts) {
                let w = wl(&m, "deployment", "statefulset");
                if !w.is_empty() {
                    servers.insert(p.name(&w));
                }
            }
            if !c.edges.is_empty() {
                c.from = "linkerd".into();
            }
        }
        if c.edges.is_empty() && has("servicegraph") {
            for (m, v) in p.increase("traces_service_graph_request_total", &p.matchers(&[], None), "client, server", None, parts) {
                let (from, to) = (label(&m, "client"), label(&m, "server"));
                if to.is_empty() {
                    continue;
                }
                servers.insert(p.name(&to));
                c.edges.push(Edge { from: if from.is_empty() { "unknown".into() } else { p.name(&from) }, to: p.name(&to), calls: v, per_request: None, grpc: false });
            }
            if !c.edges.is_empty() {
                c.from = "servicegraph".into();
            }
        }
        if c.edges.is_empty() && has("spanmetrics") && presets.iter().any(|x| x == "otel-spanmetrics") {
            // a client span names the RPC it calls; the service whose server spans carry that name answers it
            let mut answers: IndexMap<String, IndexSet<String>> = IndexMap::new();
            for (m, _) in p.increase("traces_span_metrics_calls_total", &p.matchers(&["span_kind=\"SPAN_KIND_SERVER\""], None), "service_name, span_name", None, parts) {
                let svc = p.name(&label(&m, "service_name"));
                servers.insert(svc.clone());
                if let Some(k) = rpc_key(&label(&m, "span_name")) {
                    answers.entry(k).or_default().insert(svc);
                }
            }
            let mut unmatched: IndexMap<String, IndexSet<String>> = IndexMap::new();
            let mut acc: IndexMap<(String, String), f64> = IndexMap::new();
            for (m, v) in p.increase("traces_span_metrics_calls_total", &p.matchers(&["span_kind=\"SPAN_KIND_CLIENT\""], None), "service_name, span_name", None, parts) {
                let (from, name) = (p.name(&label(&m, "service_name")), label(&m, "span_name"));
                let to = rpc_key(&name).and_then(|k| answers.get(&k)).map(|s| s.iter().filter(|x| **x != from).cloned().collect::<Vec<_>>()).unwrap_or_default();
                if to.len() == 1 {
                    *acc.entry((from, to[0].clone())).or_insert(0.0) += v;
                } else {
                    unmatched.entry(from).or_default().insert(name);
                }
            }
            for ((from, to), v) in acc {
                c.edges.push(Edge { from, to, calls: v, per_request: None, grpc: true });
            }
            if !c.edges.is_empty() {
                c.from = "spanmetrics".into();
                for (svc, names) in unmatched {
                    let mut l: Vec<String> = names.into_iter().collect();
                    l.sort();
                    c.notes.push(format!("{} makes calls no server's span names answer ({}): they are not in the topology", svc, l.iter().take(4).map(|x| format!("\"{}\"", x)).collect::<Vec<_>>().join(", ")));
                }
            }
        }
    }
    c.edges.sort_by(|a, b| (&a.from, &a.to).cmp(&(&b.from, &b.to)));
    let mut ops: Vec<String> = vec![];
    if presets.iter().any(|x| x == "ingress-nginx") {
        for (m, _) in p.increase("nginx_ingress_controller_requests", &p.matchers(&["exported_service!=\"\""], Some("exported_namespace")), "exported_service", None, parts) {
            let s = p.name(&label(&m, "exported_service"));
            if observability(&s) {
                if !ops.contains(&s) {
                    ops.push(s);
                }
            } else if !c.ingress.contains(&s) {
                c.ingress.push(s);
            }
        }
        c.ingress.sort();
        if !ops.is_empty() {
            ops.sort();
            c.notes.push(format!("the ingress also routes to {}: observability tools, not taken as entries (system.entry names the entries outright)", ops.join(", ")));
        }
    }
    // callers that never answer a request: whatever they call takes traffic from outside
    if c.from != "file" {
        let called: Vec<String> = c.edges.iter().map(|e| e.to.clone()).collect();
        servers.extend(called);
        let mut clients: IndexSet<String> = c.edges.iter().filter(|e| !servers.contains(&e.from)).map(|e| e.from.clone()).collect();
        clients.sort();
        c.clients = clients.into_iter().collect();
    } else {
        // a file without entries: the services nothing in it calls
        servers.extend(c.edges.iter().flat_map(|e| [e.from.clone(), e.to.clone()]));
    }
    if c.entry.is_empty() {
        let mut entry: IndexSet<String> = c.ingress.iter().cloned().collect();
        if c.from == "none" {
            entry.extend(known.iter().cloned());
        } else {
            entry.extend(c.edges.iter().filter(|e| c.clients.contains(&e.from)).map(|e| e.to.clone()));
            // a server no other server calls: its traffic comes from outside — unless the entries are
            // known, when it is more likely called by something no metric names
            let outside: Vec<String> = servers.iter().filter(|s| !observability(s) && !entry.contains(*s) && !c.edges.iter().any(|e| e.to == **s && !c.clients.contains(&e.from) && e.from != **s)).cloned().collect();
            if entry.is_empty() {
                entry.extend(outside);
            } else {
                let mut o = outside;
                o.sort();
                c.orphans = o;
            }
        }
        let mut e: Vec<String> = entry.into_iter().filter(|s| !observability(s)).collect();
        e.sort();
        c.entry = e;
    }
    Ok(c)
}

/// per caller, the time its outgoing calls took (ms per second) on the dataset's grid: what the source
/// that named the calls measured from the caller's side
pub fn outbound_ms(p: &Prom, from: &str, parts: &[(f64, f64)], start: f64, step: f64, n: usize, window: &str) -> IndexMap<String, Vec<Option<f64>>> {
    let (q, by) = match from {
        "spanmetrics" => (format!("sum by (service_name) (rate(traces_span_metrics_duration_milliseconds_sum{}[{}]))", p.matchers(&["span_kind=\"SPAN_KIND_CLIENT\""], None), window), "service_name"),
        "istio" => (format!("sum by (source_workload) (rate(istio_request_duration_milliseconds_sum{}[{}]))", p.matchers(&["reporter=\"source\""], Some("source_workload_namespace")), window), "source_workload"),
        "linkerd" => (format!("sum by (workload) (label_replace(label_replace(rate(response_latency_ms_sum{}[{}]), \"workload\", \"$1\", \"deployment\", \"(.+)\"), \"workload\", \"$1\", \"statefulset\", \"(.+)\"))", p.matchers(&["direction=\"outbound\""], Some("namespace")), window), "workload"),
        "servicegraph" => (format!("sum by (client) (rate(traces_service_graph_request_client_seconds_sum{}[{}])) * 1000", p.matchers(&[], None), window), "client"),
        _ => return IndexMap::new(),
    };
    let mut acc: IndexMap<String, Vec<(f64, f64)>> = IndexMap::new();
    for (a, b) in parts {
        // Prometheus answers at most 11,000 points a query
        let mut t0 = *a;
        while t0 < *b {
            let t1 = b.min(t0 + 10_000.0 * step);
            let u = api(&p.url, "api/v1/query_range", &[("query", q.clone()), ("start", js_num(t0)), ("end", js_num(t1)), ("step", format!("{}s", js_num(step)))]);
            let rows = get_json(&u, &p.h, 60_000).ok().and_then(|r| r.get("data").and_then(|d| d.get("result")).and_then(|r| r.as_array()).cloned()).unwrap_or_default();
            for r in rows {
                let svc = p.name(&r.get("metric").and_then(|m| m.get(by)).and_then(|x| x.as_str()).unwrap_or(""));
                if svc.is_empty() {
                    continue;
                }
                let e = acc.entry(svc).or_insert_with(|| vec![(0.0, 0.0); n]);
                for v in r.get("values").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
                    let (t, x) = (crate::import::js_number_of(v.get(0)), crate::import::js_number_of(v.get(1)));
                    let i = ((t - start) / step).floor();
                    if x.is_finite() && i >= 0.0 && (i as usize) < n {
                        e[i as usize].0 += x;
                        e[i as usize].1 += 1.0;
                    }
                }
            }
            t0 = t1 + step;
        }
    }
    acc.into_iter().map(|(k, v)| (k, v.into_iter().map(|(s, c)| if c > 0.0 { Some(s / c) } else { None }).collect())).collect()
}

/// services that serve gRPC, and how that was read
pub fn grpc_servers(p: &Prom, presets: &[String], grpc_metrics: &[String], parts: &[(f64, f64)]) -> (IndexSet<String>, Vec<String>) {
    let mut out: IndexSet<String> = IndexSet::new();
    let mut how: Vec<String> = vec![];
    let (a, b) = (parts[0].0, parts[parts.len() - 1].1);
    let w = format!("{}s", js_num((b - a).round().max(60.0)));
    let rows = |expr: String| p.query(&expr, b);
    if presets.iter().any(|x| x == "otel-spanmetrics") {
        let before = out.len();
        for r in rows(format!("group by (service_name, span_name) (last_over_time(traces_span_metrics_calls_total{}[{}]))", p.matchers(&["span_kind=\"SPAN_KIND_SERVER\""], None), w)) {
            let m = r.get("metric").and_then(|m| m.as_object()).cloned().unwrap_or_default();
            if rpc_key(&label(&m, "span_name")).is_some() {
                out.insert(p.name(&label(&m, "service_name")));
            }
        }
        if out.len() > before {
            how.push("span names of the form package.Service/Method".into());
        }
    }
    for metric in grpc_metrics {
        let before = out.len();
        if metric.starts_with("grpc_server") {
            for r in rows(format!("group by (namespace, pod) (last_over_time({}{}[{}]))", metric, p.matchers(&["pod!=\"\""], Some("namespace")), w)) {
                let m = r.get("metric").and_then(|m| m.as_object()).cloned().unwrap_or_default();
                out.insert(p.name(&workload_of(&label(&m, "pod"))));
            }
        } else {
            for r in rows(format!("group by (service_name) (last_over_time({}{}[{}]))", metric, p.matchers(&["rpc_system=\"grpc\""], None), w)) {
                let m = r.get("metric").and_then(|m| m.as_object()).cloned().unwrap_or_default();
                let s = label(&m, "service_name");
                if !s.is_empty() {
                    out.insert(p.name(&s));
                }
            }
        }
        if out.len() > before {
            how.push(metric.clone());
        }
    }
    out.shift_remove("");
    (out, how)
}

/// the self time given a service on the path with no latency metric, in ms
const UNMEASURED_MS: f64 = 0.05;

fn series(d: &Value, svc: &str, k: &str) -> Option<Vec<Option<f64>>> {
    d.get("services").and_then(|s| s.get(svc)).and_then(|s| s.get(k)).and_then(|a| a.as_array()).map(|a| a.iter().map(|x| x.as_f64()).collect())
}

fn to_series(v: &[Option<f64>]) -> Value {
    Value::Array(v.iter().map(|x| x.map(|x| json!(x)).unwrap_or(Value::Null)).collect())
}

/// weighted by each bucket's requests: the service's average over the window
fn weighted(v: &[Option<f64>], w: &[Option<f64>]) -> f64 {
    let (mut s, mut n) = (0.0, 0.0);
    for (i, x) in v.iter().enumerate() {
        if let Some(x) = x {
            let k = w.get(i).copied().flatten().unwrap_or(0.0).max(1e-9);
            s += x * k;
            n += k;
        }
    }
    if n > 0.0 {
        s / n
    } else {
        0.0
    }
}

pub struct Applied {
    pub provenance: Value,
    pub warnings: Vec<String>,
}

/// the dataset's topology from the calls read: shapes per service, a path per entry endpoint, self time
/// as each service's latency less its callees'; where no call is named, the services without request
/// metrics are read against the entry traffic
pub fn apply(d: &mut Value, c: &Calls) -> Applied {
    let step = d["stepS"].as_f64().unwrap_or(60.0);
    let n = d["n"].as_f64().unwrap_or(0.0) as usize;
    let start = d["start"].as_f64().unwrap_or(0.0);
    let svcs: Vec<String> = d["services"].as_object().map(|s| s.keys().cloned().collect()).unwrap_or_default();
    let mut warnings: Vec<String> = vec![];
    let total = |d: &Value, s: &str| series(d, s, "rps").map(|v| v.iter().flatten().sum::<f64>() * step).unwrap_or(0.0);
    let has_rps = |d: &Value, s: &str| series(d, s, "rps").map(|v| v.iter().any(|x| x.is_some())).unwrap_or(false);

    // calls between services both in the system, each as calls per request of its caller
    let mut left_out: IndexSet<String> = IndexSet::new();
    let mut edges: Vec<(String, String, f64, bool)> = vec![];
    for e in &c.edges {
        if e.from == e.to || c.clients.contains(&e.from) {
            continue;
        }
        if !svcs.contains(&e.to) || !svcs.contains(&e.from) {
            left_out.insert(if svcs.contains(&e.to) { e.from.clone() } else { e.to.clone() });
            continue;
        }
        let ratio = match e.per_request {
            Some(k) => k,
            None if e.calls > 0.0 && total(d, &e.from) > 0.0 => e.calls / total(d, &e.from),
            None => {
                // a file edge without a count: the callee's requests shared over its callers'
                let callers: f64 = c.edges.iter().filter(|x| x.to == e.to && x.from != x.to).map(|x| total(d, &x.from)).sum();
                if callers > 0.0 && total(d, &e.to) > 0.0 {
                    total(d, &e.to) / callers
                } else {
                    1.0
                }
            }
        };
        edges.push((e.from.clone(), e.to.clone(), ratio, e.grpc || c.grpc.contains(&e.to)));
    }
    // a callee serves no more than it served: client calls that failed before reaching it, or were
    // retried, would otherwise load it in the replay with requests it never saw
    let callees: IndexSet<String> = edges.iter().map(|e| e.1.clone()).collect();
    for b in &callees {
        let served = total(d, b);
        let implied: f64 = edges.iter().filter(|e| e.1 == *b).map(|e| e.2 * total(d, &e.0)).sum();
        if served > 0.0 && implied > served * 1.1 {
            let k = served / implied;
            for e in edges.iter_mut().filter(|e| e.1 == *b) {
                e.2 *= k;
            }
            warnings.push(format!("{}: its callers' metrics count {}× the requests it served (calls that failed before reaching it, or retries) — calls into it scaled to what it served", b, crate::math::js_to_fixed(1.0 / k, 1)));
        }
    }
    if !left_out.is_empty() {
        let mut l: Vec<String> = left_out.into_iter().collect();
        l.sort();
        warnings.push(format!("calls to or from {} left out of the topology: no metrics name them in this system (another namespace, or excluded)", l.join(", ")));
    }

    let mut entry: Vec<String> = c.entry.iter().filter(|e| svcs.contains(*e) && has_rps(d, e)).cloned().collect();
    // carried by the entry traffic, in proportion to their own requests
    let entry_total: f64 = entry.iter().map(|e| total(d, e)).sum();
    let hung: Vec<(String, f64)> = c.orphans.iter().filter(|o| svcs.contains(*o) && has_rps(d, o) && !entry.contains(*o) && entry_total > 0.0).map(|o| (o.clone(), total(d, o) / entry_total)).collect();
    if !hung.is_empty() {
        warnings.push(format!(
            "{}: no metric names who calls {} — carried by the entry traffic ({}) in proportion to {} own requests",
            list(&hung.iter().map(|h| h.0.clone()).collect::<Vec<_>>()),
            if hung.len() == 1 { "it" } else { "them" },
            list(&entry),
            if hung.len() == 1 { "its" } else { "their" }
        ));
    }
    let dropped: Vec<String> = c.entry.iter().filter(|e| !entry.contains(*e)).cloned().collect();
    if !dropped.is_empty() {
        warnings.push(format!("{}: named as an entry but without request metrics here — not modelled as one", dropped.join(", ")));
    }
    // where no call is named, the services without request metrics carry the entry traffic
    let mut against: Vec<String> = vec![];
    if c.from == "none" {
        // a service with request metrics nothing names a caller of is its own entry
        for id in &svcs {
            if !entry.contains(id) && has_rps(d, id) {
                entry.push(id.clone());
            }
        }
        entry.sort();
        for id in &svcs {
            if entry.is_empty() || entry.contains(id) || has_rps(d, id) {
                continue;
            }
            if series(d, id, "cpuCores").map(|v| v.iter().any(|x| x.is_some())).unwrap_or(false) {
                against.push(id.clone());
            }
        }
    }

    // one path per entry service, shared by its endpoints: calls per request, followed down the graph
    let mut paths: IndexMap<String, (IndexMap<String, f64>, IndexMap<String, f64>)> = IndexMap::new();
    for e in &entry {
        let mut visits: IndexMap<String, f64> = IndexMap::new();
        let mut calls: IndexMap<String, f64> = IndexMap::new();
        visits.insert(e.clone(), 1.0);
        let mut queue: std::collections::VecDeque<(String, f64, usize)> = std::collections::VecDeque::from([(e.clone(), 1.0, 0)]);
        for (o, k) in &hung {
            *calls.entry(format!("{}>{}", e, o)).or_insert(0.0) += k;
            *visits.entry(o.clone()).or_insert(0.0) += k;
            queue.push_back((o.clone(), *k, 1));
        }
        while let Some((a, va, depth)) = queue.pop_front() {
            if depth >= 8 || va < 1e-6 {
                continue;
            }
            for (from, to, k, _) in edges.iter().filter(|x| x.0 == a) {
                let x = va * k;
                *calls.entry(format!("{}>{}", from, to)).or_insert(0.0) += x;
                *visits.entry(to.clone()).or_insert(0.0) += x;
                queue.push_back((to.clone(), x, depth + 1));
            }
        }
        // read against the entry traffic: one call per entry request, as the engine follows calls
        for a in &against {
            visits.insert(a.clone(), 1.0);
            calls.insert(format!("{}>{}", e, a), 1.0);
        }
        paths.insert(e.clone(), (visits, calls));
    }
    // on a path but without request metrics: the requests the paths send it, for its CPU to be read against
    let entry_rps: Vec<(String, Vec<Option<f64>>)> = entry.iter().map(|e| (e.clone(), series(d, e, "rps").unwrap_or_default())).collect();
    let mut nodes: IndexSet<String> = IndexSet::new();
    for (v, _) in paths.values() {
        nodes.extend(v.keys().cloned());
    }
    let mut implied: Vec<String> = vec![];
    for id in &nodes {
        if has_rps(d, id) || !svcs.contains(id) {
            continue;
        }
        let load: Vec<Option<f64>> = (0..n)
            .map(|i| {
                let xs: Vec<f64> = entry_rps.iter().filter_map(|(e, r)| paths[e].0.get(id).and_then(|v| r.get(i).copied().flatten().map(|x| x * v))).collect();
                if xs.is_empty() {
                    None
                } else {
                    Some(xs.iter().sum())
                }
            })
            .collect();
        d["services"][id]["rps"] = to_series(&load);
        if !against.contains(id) {
            implied.push(id.clone());
        }
    }

    // self time: a service's latency less what its calls spend in its callees, as if made one after another
    let mut no_latency: Vec<String> = vec![];
    let mut shapes = JMap::new();
    for id in &nodes {
        let rps = series(d, id, "rps").unwrap_or_default();
        let mean = series(d, id, "meanMs");
        let p99 = series(d, id, "p99Ms");
        let own_p99 = p99.clone();
        let (mut self_mean, mut self_p99): (Vec<Option<f64>>, Vec<Option<f64>>) = (vec![None; n], vec![None; n]);
        if mean.is_some() || p99.is_some() {
            let out: Vec<(f64, Option<Vec<Option<f64>>>)> = edges.iter().filter(|e| e.0 == *id).map(|e| (e.2, series(d, &e.1, "meanMs"))).collect();
            // the caller's own measure of its calls where there is one (it counts calls to services no
            // metric names too), else its callees' latency times calls per request
            let waited = c.out_ms.get(id);
            for i in 0..n {
                let own = waited.and_then(|w| w.get(i).copied().flatten()).zip(rps.get(i).copied().flatten().filter(|r| *r > 0.0)).map(|(w, r)| w / r);
                let below: f64 = own.unwrap_or_else(|| out.iter().map(|(k, m)| k * m.as_ref().and_then(|m| m.get(i).copied().flatten()).unwrap_or(0.0)).sum());
                let m = mean.as_ref().and_then(|m| m.get(i).copied().flatten());
                self_mean[i] = m.map(|m| (m - below).max(0.1 * m));
                self_p99[i] = p99.as_ref().and_then(|p| p.get(i).copied().flatten()).map(|p| (p - below).max(self_mean[i].unwrap_or(0.0)).max(0.1 * p));
            }
            if self_mean.iter().any(|x| x.is_some()) {
                d["services"][id]["selfMeanMs"] = to_series(&self_mean);
            }
            if self_p99.iter().any(|x| x.is_some()) {
                d["services"][id]["selfP99Ms"] = to_series(&self_p99);
            }
        } else {
            no_latency.push(id.clone());
        }
        let calls_in: f64 = c.edges.iter().filter(|e| e.to == *id).map(|e| e.calls).sum();
        let spans = if rps.iter().any(|x| x.is_some()) { total(d, id) } else { calls_in };
        // unmeasured: a nominal self time keeps the service on the request path, so its queue counts
        let sm = Some(weighted(&self_mean, &rps)).filter(|x| *x > 0.0).unwrap_or(UNMEASURED_MS);
        shapes.insert(
            id.clone(),
            json!({
                "spans": js_round(spans),
                "selfMeanMs": sm,
                "selfP50Ms": sm,
                "selfP99Ms": Some(weighted(&self_p99, &rps)).filter(|x| *x > 0.0).unwrap_or(sm),
                "meanMs": mean.as_ref().map(|m| weighted(m, &rps)).unwrap_or(0.0),
                "p99Ms": own_p99.as_ref().map(|p| weighted(p, &rps)).unwrap_or(0.0),
                "kind": "server",
            }),
        );
    }

    // each entry's endpoints, on its path
    let mut endpoints = JMap::new();
    let mut synthetic: Vec<String> = vec![];
    let mut merged: Vec<String> = vec![];
    for e in &entry {
        let (visits, calls) = &paths[e];
        let critical: JMap<String, Value> = visits.iter().map(|(s, v)| (s.clone(), json!(v * shapes.get(s).and_then(|x| x["selfMeanMs"].as_f64()).unwrap_or(0.0)))).collect();
        let mut ids: Vec<String> = d["endpoints"].as_object().map(|x| x.iter().filter(|(_, ep)| ep["service"].as_str() == Some(e.as_str())).map(|(k, _)| k.clone()).collect()).unwrap_or_default();
        // endpoints with rates but no latency of their own share one path: they are one endpoint here
        let timed = |ep: &Value| ["p99Ms", "meanMs"].iter().any(|k| ep.get(*k).and_then(|v| v.as_array()).map(|a| a.iter().any(|x| !x.is_null())).unwrap_or(false));
        if !ids.is_empty() && !ids.iter().any(|id| timed(&d["endpoints"][id])) && series(d, e, "rps").is_some() {
            if let Some(o) = d["endpoints"].as_object_mut() {
                for id in &ids {
                    o.shift_remove(id);
                }
            }
            merged.push(format!("{} ({})", e, ids.len()));
            ids.clear();
        }
        if ids.is_empty() {
            // no endpoint-level metrics: the service's requests as one endpoint
            let id = format!("{} (all requests)", e);
            let mut ep = JMap::new();
            ep.insert("service".into(), json!(e));
            for k in ["rps", "errorRate", "p50Ms", "p99Ms", "meanMs"] {
                if let Some(v) = d["services"][e].get(k).filter(|v| v.is_array()) {
                    ep.insert(k.into(), v.clone());
                }
            }
            if !d["endpoints"].is_object() {
                d["endpoints"] = json!({});
            }
            d["endpoints"][&id] = Value::Object(ep);
            synthetic.push(id.clone());
            ids.push(id);
        }
        for id in ids {
            let ep = d["endpoints"][&id].clone();
            let w = ep.get("rps").and_then(|v| v.as_array()).map(|a| a.iter().map(|x| x.as_f64()).collect::<Vec<_>>()).unwrap_or_default();
            let avg = |k: &str| ep.get(k).and_then(|v| v.as_array()).map(|a| weighted(&a.iter().map(|x| x.as_f64()).collect::<Vec<_>>(), &w)).unwrap_or(0.0);
            endpoints.insert(
                id,
                json!({
                    "service": e,
                    "traces": 0,
                    "calls": calls.iter().map(|(k, v)| (k.clone(), json!(v))).collect::<JMap<String, Value>>(),
                    "visits": visits.iter().map(|(k, v)| (k.clone(), json!(v))).collect::<JMap<String, Value>>(),
                    "criticalMs": critical,
                    "meanMs": avg("meanMs"),
                    "p99Ms": avg("p99Ms"),
                    "bytes": {},
                    "errorRate": avg("errorRate"),
                }),
            );
        }
    }
    let window = n as f64 * step;
    let edge_list: Vec<Value> = edges
        .iter()
        .map(|(a, b, _, g)| {
            let calls: f64 = c.edges.iter().filter(|e| e.from == *a && e.to == *b).map(|e| e.calls).sum();
            let mut o = json!({ "from": a, "to": b, "callsPerS": if window > 0.0 { calls / window } else { 0.0 }, "bytesPerCall": null });
            if *g {
                o["grpc"] = json!(true);
            }
            o
        })
        .collect();
    d["topology"] = json!({ "services": shapes, "edges": edge_list, "endpoints": endpoints, "start": start, "end": start + window, "traces": 0 });

    let said = match c.from.as_str() {
        "istio" => "istio metrics",
        "linkerd" => "Linkerd metrics",
        "servicegraph" => "the OpenTelemetry service graph",
        "spanmetrics" => "span metrics (client spans matched to the servers that answer them)",
        "file" => "the topology file",
        _ => "",
    };
    let per_endpoint = d["endpoints"].as_object().map(|x| x.iter().any(|(k, ep)| !synthetic.contains(k) && ep.get("p99Ms").map(|v| v.is_array()).unwrap_or(false))).unwrap_or(false);
    let any_latency = nodes.iter().any(|s| !no_latency.contains(s));
    let latency = if !any_latency {
        "no latency metric: latency answers are unavailable — capacity comes from CPU, throttling and memory".to_string()
    } else {
        let mut l = if per_endpoint { "latency per endpoint, but each endpoint's path is its service's average".to_string() } else { "no per-endpoint latency".to_string() };
        if !no_latency.is_empty() {
            l.push_str(&format!("; no latency metric for {} (capacity from CPU, throttling and memory)", list(&no_latency)));
        }
        l
    };
    let topology = if entry.is_empty() {
        "no request metrics for any service, so no traffic to replay — ingress-nginx, a service mesh or HTTP server metrics would give it".to_string()
    } else if c.from == "none" {
        if against.is_empty() {
            "no calls named in the metrics — each service with request metrics is its own entry".to_string()
        } else {
            format!("no calls named in the metrics — {} read against the entry traffic", list(&against))
        }
    } else {
        format!("topology from {}", said)
    };
    let mut prov = json!({
        "traces": false,
        "topology": { "from": c.from, "said": topology, "entry": entry, "edges": edges.len() },
        "latency": { "said": latency, "perEndpoint": per_endpoint, "without": no_latency },
    });
    if !c.ingress.is_empty() {
        prov["topology"]["ingress"] = json!(c.ingress);
    }
    if !against.is_empty() {
        prov["topology"]["readAgainstEntry"] = json!(against);
    }
    if !hung.is_empty() {
        prov["topology"]["callersUnknown"] = json!(hung.iter().map(|h| h.0.clone()).collect::<Vec<_>>());
    }
    if !synthetic.is_empty() {
        prov["topology"]["wholeServiceEndpoints"] = json!(synthetic);
    }
    if !c.notes.is_empty() {
        prov["topology"]["notes"] = json!(c.notes);
    }
    // what the review says before anything else: what is missing, and what stands in for it
    prov["said"] = json!(if entry.is_empty() { format!("no traces: {}", topology) } else { format!("no traces: {}; {}", topology, latency) });
    if entry.is_empty() {
        prov["noTraffic"] = json!(true);
    }
    if !against.is_empty() {
        warnings.push(format!("{}: no request metrics and no calls named — their CPU and memory are read against the entry traffic ({}), as if every request passed through them. If one serves no requests (a batch job, a client), connect_telemetry with system.exclude", list(&against), list(&entry)));
    }
    if !implied.is_empty() {
        warnings.push(format!("{}: no request metrics — {} CPU and memory are read against the requests the topology sends {}", list(&implied), if implied.len() == 1 { "its" } else { "their" }, if implied.len() == 1 { "it" } else { "them" }));
    }
    if !merged.is_empty() {
        warnings.push(format!("endpoint rates without endpoint latency for {}: each service is modelled as one endpoint, its requests together", merged.join(", ")));
    }
    for nt in &c.notes {
        warnings.push(nt.clone());
    }
    Applied { provenance: prov, warnings }
}

fn list(xs: &[String]) -> String {
    match xs.len() {
        0 => String::new(),
        1..=4 => xs.join(", "),
        k => format!("{} and {} more", xs[..3].join(", "), k - 3),
    }
}

/// gRPC calls in whichever topology the dataset has: edges into a service that serves gRPC
pub fn grpc_provenance(d: &Value, servers: &IndexSet<String>, how: &[String]) -> Option<Value> {
    let edges = d.get("topology").and_then(|t| t.get("edges")).and_then(|e| e.as_array()).cloned().unwrap_or_default();
    let mut calls: Vec<Value> = vec![];
    let mut seen: IndexSet<(String, String)> = IndexSet::new();
    for e in &edges {
        let (a, b) = (e["from"].as_str().unwrap_or("").to_string(), e["to"].as_str().unwrap_or("").to_string());
        if a.is_empty() || a == b || !(e["grpc"].as_bool().unwrap_or(false) || servers.contains(&b)) {
            continue;
        }
        if seen.insert((a.clone(), b.clone())) {
            calls.push(json!([a, b]));
        }
    }
    if calls.is_empty() && servers.is_empty() {
        return None;
    }
    let mut s: Vec<String> = servers.iter().cloned().collect();
    s.sort();
    let mut how: Vec<String> = how.to_vec();
    if edges.iter().any(|e| e["grpc"].as_bool().unwrap_or(false)) && how.is_empty() {
        how.push("the call metrics' protocol".into());
    }
    Some(json!({ "servers": s, "calls": calls, "from": how }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rpc_names_meet() {
        assert_eq!(rpc_key("grpc.oteldemo.CartService/GetCart"), Some("cart/getcart".into()));
        assert_eq!(rpc_key("POST /oteldemo.CartService/GetCart"), Some("cart/getcart".into()));
        assert_eq!(rpc_key("oteldemo.CurrencyService/Convert"), rpc_key("Currency/Convert"));
        assert_eq!(rpc_key("/oteldemo.RecommendationService/ListRecommendations"), Some("recommendation/listrecommendations".into()));
        assert_eq!(rpc_key("GET /api/cart"), None);
        assert_eq!(rpc_key("POST /send_order_confirmation"), None);
        assert_eq!(rpc_key("HTTP POST"), None);
        assert_eq!(rpc_key("HGET"), None);
    }

    #[test]
    fn a_file_without_entries_starts_where_nothing_calls() {
        let f = std::env::temp_dir().join(format!("hindcast-topology-{}.yaml", std::process::id()));
        std::fs::write(&f, "calls:\n  web: [api]\n  api: { db: 2 }\ngrpc: [api]\n").unwrap();
        let p = Prom::new(&json!({ "url": "http://127.0.0.1:9" }), &JMap::new()).unwrap();
        let c = read_calls(&p, &[], &[], &[(0.0, 3600.0)], f.to_str(), &[]).unwrap();
        let _ = std::fs::remove_file(&f);
        assert_eq!(c.from, "file");
        assert_eq!(c.entry, vec!["web".to_string()]);
        assert_eq!(c.edges.iter().map(|e| (e.from.as_str(), e.to.as_str(), e.per_request)).collect::<Vec<_>>(), vec![("api", "db", Some(2.0)), ("web", "api", None)]);
        assert!(c.grpc.contains("api"));
    }

    #[test]
    fn pods_name_workloads() {
        assert_eq!(workload_of("cart-7d9f8b6c5d-x2x4z"), "cart");
        assert_eq!(workload_of("valkey-0"), "valkey");
    }

    #[test]
    fn paths_follow_calls() {
        let mut d = json!({
            "stepS": 60, "n": 3, "start": 0,
            "services": {
                "web": { "rps": [10, 10, 10], "meanMs": [50, 50, 50], "p99Ms": [100, 100, 100] },
                "api": { "rps": [20, 20, 20], "meanMs": [10, 10, 10], "p99Ms": [30, 30, 30] },
                "db": { "rps": [20, 20, 20], "meanMs": [2, 2, 2] }
            },
            "endpoints": {}
        });
        let c = Calls {
            from: "istio".into(),
            edges: vec![
                Edge { from: "gw".into(), to: "web".into(), calls: 1800.0, per_request: None, grpc: false },
                Edge { from: "web".into(), to: "api".into(), calls: 3600.0, per_request: None, grpc: true },
                Edge { from: "api".into(), to: "db".into(), calls: 3600.0, per_request: None, grpc: false },
            ],
            entry: vec!["web".into()],
            ingress: vec![],
            clients: vec!["gw".into()],
            grpc: IndexSet::new(),
            notes: vec![],
            out_ms: IndexMap::new(),
            orphans: vec![],
        };
        let a = apply(&mut d, &c);
        let ep = &d["topology"]["endpoints"]["web (all requests)"];
        assert_eq!(ep["visits"]["api"], json!(2.0));
        assert_eq!(ep["visits"]["db"], json!(2.0));
        // 50 ms less 2 calls × 10 ms; api: 10 less 1 × 2
        assert_eq!(d["services"]["web"]["selfMeanMs"][0], json!(30.0));
        assert_eq!(d["services"]["api"]["selfMeanMs"][0], json!(8.0));
        assert_eq!(d["endpoints"]["web (all requests)"]["rps"], json!([10, 10, 10]));
        assert_eq!(a.provenance["said"], json!("no traces: topology from istio metrics; no per-endpoint latency"));
        let g = grpc_provenance(&d, &IndexSet::new(), &[]).unwrap();
        assert_eq!(g["calls"], json!([["web", "api"]]));
    }

    #[test]
    fn without_calls_the_rest_follow_the_entry() {
        let mut d = json!({
            "stepS": 60, "n": 2, "start": 0,
            "services": {
                "web": { "rps": [10, 20], "meanMs": [40, 60], "p99Ms": [90, 120] },
                "worker": { "cpuCores": [0.1, 0.2] }
            },
            "endpoints": {}
        });
        let c = Calls { from: "none".into(), edges: vec![], entry: vec!["web".into()], ingress: vec!["web".into()], clients: vec![], grpc: IndexSet::new(), notes: vec![], out_ms: IndexMap::new(), orphans: vec![] };
        let a = apply(&mut d, &c);
        assert_eq!(d["services"]["worker"]["rps"], json!([10.0, 20.0]));
        assert_eq!(d["topology"]["endpoints"]["web (all requests)"]["visits"]["worker"], json!(1.0));
        assert!(a.provenance["said"].as_str().unwrap().contains("worker read against the entry traffic"));
    }
}
