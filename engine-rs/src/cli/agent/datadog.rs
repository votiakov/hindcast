//! Datadog as the metrics source, read-only: the same signals the Prometheus presets read (request
//! rates, errors, latency, CPU and its limits, memory, replicas, throttling) from Datadog's public
//! Metrics API, and who calls whom from its APM service dependencies.
//!
//! Endpoints used (all GET, all read-only):
//! - `/api/v1/metrics?from=` — the actively reporting metric names: which presets can work.
//! - `/api/v1/query?from=&to=&query=` — timeseries points. A response is `{ status, res_type,
//!   from_date, to_date, query, series: [{ metric, scope, tag_set, pointlist: [[ms, value|null]], … }] }`;
//!   errors are `{ errors: [..] }` with 400/403/429.
//! - `/api/v1/service_dependencies?env=&start=&end=` — `{ service: { calls: [callees] } }`: who calls
//!   whom, without counts.
//!
//! Every answer is converted into the Prometheus query_range shape (`data.result[].metric/values`)
//! and imported by the same manifest path as a Prometheus export, so the model is built the same way.
//!
//! What the documentation does not pin down, and how it is handled here:
//! - Points per query: the docs give a limit of 350 points per time range (graphing functions) and of
//!   1,500 (the rollup page); past it Datadog coarsens the rollup on its own. Each query here asks for an
//!   explicit `.rollup(…, step)` over windows of at most 300 points, so neither limit is reached.
//! - Rate limits: a 429 carries `X-RateLimit-Reset` (seconds until the limit resets). The client waits
//!   that long (at most 60 s; 1, 2, 4… s when the header is missing) and tries again, five times.
//! - `.rollup(step)` on a distribution's percentile (`p99:trace.<span>{…}`): the docs allow a rollup with
//!   the time alone; that it applies to distribution percentiles is assumed, not confirmed.
//! - A group-by tag a series lacks: whether Datadog leaves it out of `tag_set` or writes `N/A` is not
//!   documented; both are read as missing.
//! - The ingress-nginx integration's tag names (`service`, `status`) follow the controller's Prometheus
//!   labels; the docs do not list them.
//! - `/api/v1/service_dependencies` over a window longer than its default hour: assumed to work.
//! Tested only against a mock built from the documented shapes (test/cli-fixtures/mock-datadog.mjs);
//! no live Datadog account was used.

use super::workspace::iso;
use crate::math::{js_num, js_round};
use indexmap::{IndexMap, IndexSet};
use serde_json::{json, Map as JMap, Value};
use std::collections::BTreeMap;

/// the Datadog sites, each served at https://api.<site>
pub const SITES: [&str; 7] = ["datadoghq.com", "us3.datadoghq.com", "us5.datadoghq.com", "datadoghq.eu", "ap1.datadoghq.com", "ap2.datadoghq.com", "ddog-gov.com"];
pub const PRESETS: [&str; 3] = ["datadog-apm", "datadog-kubernetes", "datadog-ingress-nginx"];
/// the most points one query asks for (under both documented limits, 350 and 1,500)
pub const MAX_POINTS: f64 = 300.0;
const RETRIES: u32 = 5;
const MONTH: f64 = 30.0 * 86400.0;
/// the coarse rollup the probe reads 30 days at (120 points)
const COARSE: f64 = 21600.0;

fn s(v: Option<&Value>) -> Option<String> {
    v.and_then(|x| x.as_str()).filter(|x| !x.is_empty()).map(String::from)
}

fn strs(v: Option<&Value>) -> Vec<String> {
    v.and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}

/// where the API is: `url` as given, else https://api.<site>
pub fn api_base(cfg: &Value) -> Result<String, String> {
    if let Some(u) = s(cfg.get("url")) {
        return Ok(u.trim_end_matches('/').to_string());
    }
    let site = s(cfg.get("site")).ok_or("datadog needs a site (datadoghq.com, datadoghq.eu, us3.datadoghq.com, …) or a url")?;
    let site = site.trim().trim_start_matches("https://").trim_start_matches("app.").trim_start_matches("api.").trim_end_matches('/').to_lowercase();
    if !SITES.contains(&site.as_str()) {
        return Err(format!("unknown Datadog site \"{}\": one of {} (or give datadog.url for a proxy)", site, SITES.join(", ")));
    }
    Ok(format!("https://api.{}", site))
}

/// the env var names the keys are read from: names only, the values never leave the environment
pub fn key_envs(cfg: &Value) -> (String, String) {
    (s(cfg.get("apiKeyEnv")).unwrap_or_else(|| "DD_API_KEY".into()), s(cfg.get("appKeyEnv")).unwrap_or_else(|| "DD_APP_KEY".into()))
}

/// how long to wait before retrying a 429: what X-RateLimit-Reset says (at most a minute), else 1, 2, 4… s
pub fn backoff_s(attempt: u32, reset: Option<&str>) -> f64 {
    match reset.and_then(|r| r.trim().parse::<f64>().ok()).filter(|r| r.is_finite() && *r >= 0.0) {
        Some(r) => r.min(60.0),
        None => 2f64.powi(attempt as i32).min(30.0),
    }
}

/// windows of at most `max_points` buckets of `step` covering [start, end]
pub fn chunks(start: f64, end: f64, step: f64, max_points: f64) -> Vec<(f64, f64)> {
    let mut out = vec![];
    let width = (max_points * step).max(step);
    let mut t0 = start;
    while t0 < end {
        let t1 = end.min(t0 + width);
        out.push((t0, t1));
        t0 = t1;
    }
    if out.is_empty() {
        out.push((start, end));
    }
    out
}

pub struct Client {
    base: String,
    headers: Vec<(String, String)>,
    /// waits between retries (a test passes one that does not sleep)
    pub sleep: fn(f64),
}

fn real_sleep(s: f64) {
    std::thread::sleep(std::time::Duration::from_millis((s * 1000.0) as u64));
}

/// an answer's error list, joined; what follows the status in an error
fn errors_of(body: &str) -> String {
    match serde_json::from_str::<Value>(body) {
        Ok(v) => match v.get("errors").and_then(|e| e.as_array()) {
            Some(a) => a.iter().map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).collect::<Vec<_>>().join("; "),
            None => v.get("error").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        },
        Err(_) => {
            let t: Vec<u16> = body.encode_utf16().collect();
            String::from_utf16_lossy(&t[..t.len().min(200)])
        }
    }
}

impl Client {
    pub fn new(cfg: &Value) -> Result<Client, String> {
        let base = api_base(cfg)?;
        let (api, app) = key_envs(cfg);
        // the error names the variable, never a value
        let env = |name: &str, field: &str, flag: &str| std::env::var(name).ok().filter(|v| !v.is_empty()).ok_or_else(|| format!("env var {} is not set: it holds the Datadog {} key (name another variable with datadog.{} (quickstart: {}))", name, if field == "apiKeyEnv" { "API" } else { "application" }, field, flag));
        let headers = vec![
            ("DD-API-KEY".to_string(), env(&api, "apiKeyEnv", "--dd-api-key-env")?),
            ("DD-APPLICATION-KEY".to_string(), env(&app, "appKeyEnv", "--dd-app-key-env")?),
            ("Accept".to_string(), "application/json".to_string()),
        ];
        Ok(Client { base, headers, sleep: real_sleep })
    }
    #[cfg(test)]
    pub fn at(base: &str) -> Client {
        Client { base: base.into(), headers: vec![], sleep: |_| {} }
    }
    pub fn base(&self) -> &str {
        &self.base
    }

    /// GET a path with query parameters: the JSON, retrying a 429 after the back-off
    pub fn get(&self, path: &str, q: &[(&str, String)]) -> Result<Value, String> {
        let url = super::workspace::api(&self.base, path, q);
        let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(std::time::Duration::from_secs(60))).build().into();
        let mut attempt = 0;
        loop {
            let mut req = agent.get(&url);
            for (k, v) in &self.headers {
                req = req.header(k.as_str(), v.as_str());
            }
            let mut resp = match req.call() {
                Ok(r) => r,
                Err(ureq::Error::Timeout(_)) => return Err(format!("{}{} did not answer within 60 s", self.base, path)),
                Err(e) => return Err(format!("fetch failed: {}{} ({})", self.base, path, e)),
            };
            let status = resp.status().as_u16();
            let reset = resp.headers().get("x-ratelimit-reset").and_then(|h| h.to_str().ok()).map(String::from);
            let body = resp.body_mut().with_config().limit(crate::cli::http::BODY_LIMIT).read_to_string().map_err(|e| crate::cli::http::body_error(&url, &e))?;
            if status == 429 && attempt < RETRIES {
                let wait = backoff_s(attempt, reset.as_deref());
                super::progress(&format!("Datadog rate limit reached: waiting {} s, then trying again", js_num(wait)), 0.0, 0.0);
                (self.sleep)(wait);
                attempt += 1;
                continue;
            }
            if !(200..300).contains(&status) {
                let why = errors_of(&body);
                let hint = match status {
                    403 => " — the application key needs the metrics_read, timeseries_query and apm_read permissions (and the API key must belong to the same organisation and site)",
                    401 => " — check the API key and that it belongs to this site",
                    429 => " — still rate limited after 5 tries: collect a shorter window or a coarser step, or ask Datadog for a higher limit",
                    _ => "",
                };
                return Err(format!("{} answered {}: {}{}", path, status, if why.is_empty() { "(no message)".to_string() } else { why }, hint));
            }
            return serde_json::from_str(&body).map_err(|e| format!("{}: not JSON ({})", path, e));
        }
    }

    /// one timeseries query over [from, to]
    pub fn query(&self, q: &str, from: f64, to: f64) -> Result<Vec<Series>, String> {
        let v = self.get("api/v1/query", &[("from", js_num(from.floor())), ("to", js_num(to.ceil())), ("query", q.to_string())])?;
        parse_query(&v)
    }

    /// a query over a long window, in windows of at most MAX_POINTS buckets, merged per tag set
    pub fn query_range(&self, q: &str, start: f64, end: f64, step: f64) -> Result<Vec<Series>, String> {
        let mut acc: IndexMap<String, (IndexMap<String, String>, BTreeMap<i64, f64>)> = IndexMap::new();
        for (a, b) in chunks(start, end, step, MAX_POINTS) {
            for s in self.query(q, a, b)? {
                let key = s.tags.iter().map(|(k, v)| format!("{}:{}", k, v)).collect::<Vec<_>>().join(",");
                let e = acc.entry(key).or_insert_with(|| (s.tags.clone(), BTreeMap::new()));
                for (t, v) in s.points {
                    e.1.insert(t.round() as i64, v);
                }
            }
        }
        Ok(acc.into_values().map(|(tags, p)| Series { tags, points: p.into_iter().map(|(t, v)| (t as f64, v)).collect() }).collect())
    }
}

/// one series: its group-by tags and its (epoch seconds, value) points
#[derive(Clone, Debug, PartialEq)]
pub struct Series {
    pub tags: IndexMap<String, String>,
    pub points: Vec<(f64, f64)>,
}

/// a /api/v1/query answer: its series, tags from tag_set (else scope), points in seconds, nulls dropped
pub fn parse_query(v: &Value) -> Result<Vec<Series>, String> {
    if v.get("status").and_then(|x| x.as_str()) == Some("error") {
        return Err(format!("Datadog could not run the query: {}", v.get("error").and_then(|x| x.as_str()).unwrap_or("(no message)")));
    }
    let series = v.get("series").and_then(|x| x.as_array()).ok_or("not a Datadog query answer (expected series)")?;
    let mut out = vec![];
    for x in series {
        let mut tags: IndexMap<String, String> = IndexMap::new();
        let tag_set = strs(x.get("tag_set"));
        let list: Vec<String> = if tag_set.is_empty() { x.get("scope").and_then(|s| s.as_str()).unwrap_or("").split(',').map(|t| t.trim().to_string()).collect() } else { tag_set };
        for t in list {
            // a value can hold colons (resource names do): the key is up to the first
            if let Some((k, val)) = t.split_once(':') {
                if !val.is_empty() && val != "N/A" {
                    tags.insert(k.to_string(), val.to_string());
                }
            }
        }
        let points: Vec<(f64, f64)> = x
            .get("pointlist")
            .and_then(|p| p.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|p| {
                        let t = p.get(0)?.as_f64()?;
                        let v = p.get(1)?.as_f64()?;
                        // pointlist times are milliseconds
                        Some((t / 1000.0, v))
                    })
                    .filter(|(_, v)| v.is_finite())
                    .collect()
            })
            .unwrap_or_default();
        out.push(Series { tags, points });
    }
    Ok(out)
}

/// a span name that is a client's call (a database, a cache, a queue's producer, an HTTP or gRPC
/// client): its trace metrics count calls made, not requests served
pub fn client_span(name: &str) -> bool {
    const CLIENTS: [&str; 22] = ["redis", "mysql", "postgres", "postgresql", "pg", "mongodb", "mongo", "sql", "cassandra", "elasticsearch", "opensearch", "memcached", "dynamodb", "aws", "sqs", "sns", "s3", "kafka.produce", "rabbitmq.publish", "http.client", "grpc.client", "net.client"];
    let n = name.to_lowercase();
    n.contains("client") || n.ends_with(".query") || n.ends_with(".command") || CLIENTS.iter().any(|c| n == *c || n.starts_with(&format!("{}.", c)))
}

/// the filter of every query: the configured scope, and the APM env where there is one
fn filter(cfg: &Value, env: Option<&str>) -> String {
    let mut parts: Vec<String> = vec![];
    if let Some(sc) = s(cfg.get("scope")) {
        parts.push(sc);
    }
    if let Some(e) = env {
        parts.push(format!("env:{}", e));
    }
    if parts.is_empty() {
        "*".into()
    } else {
        parts.join(",")
    }
}

/// a workload's name from a Kubernetes series' tags (a Deployment's, else a StatefulSet's)
fn workload(tags: &IndexMap<String, String>) -> Option<String> {
    tags.get("kube_deployment").or(tags.get("kube_stateful_set")).cloned()
}

fn in_namespaces(tags: &IndexMap<String, String>, ns: &[String]) -> bool {
    ns.is_empty() || tags.get("kube_namespace").map(|n| ns.contains(n)).unwrap_or(false)
}

const K8S_BY: &str = "kube_namespace,kube_deployment,kube_stateful_set";

/// a Kubernetes signal: the metric read, the one read where it is missing, and the scale to the
/// dataset's unit
struct K8s {
    signal: &'static str,
    metrics: [&'static str; 2],
    scale: [f64; 2],
}

/// CPU in nanocores (kubernetes.cpu.usage.total, container.cpu.usage, container.cpu.limit), limits in
/// cores (kubernetes.cpu.limits), memory in bytes
const K8S_SIGNALS: [K8s; 7] = [
    K8s { signal: "cpuCores", metrics: ["kubernetes.cpu.usage.total", "container.cpu.usage"], scale: [1e-9, 1e-9] },
    K8s { signal: "cpuLimitCores", metrics: ["kubernetes.cpu.limits", "container.cpu.limit"], scale: [1.0, 1e-9] },
    K8s { signal: "cpuRequestCores", metrics: ["kubernetes.cpu.requests", "kubernetes.cpu.requests"], scale: [1.0, 1.0] },
    K8s { signal: "memoryBytes", metrics: ["kubernetes.memory.usage", "container.memory.usage"], scale: [1.0, 1.0] },
    K8s { signal: "memoryLimitBytes", metrics: ["kubernetes.memory.limits", "container.memory.limit"], scale: [1.0, 1.0] },
    K8s { signal: "memoryRequestBytes", metrics: ["kubernetes.memory.requests", "kubernetes.memory.requests"], scale: [1.0, 1.0] },
    K8s { signal: "netTxBps", metrics: ["kubernetes.network.tx_bytes", "kubernetes.network.tx_bytes"], scale: [1.0, 1.0] },
];
const REPLICAS: [(&str, &str); 2] = [("kubernetes_state.deployment.replicas_available", "kube_deployment"), ("kubernetes_state.statefulset.replicas_ready", "kube_stateful_set")];
const THROTTLED: (&str, &str) = ("kubernetes.cpu.cfs.throttled.periods", "kubernetes.cpu.cfs.periods");
const INGRESS: &str = "nginx_ingress.controller.requests";

fn k8s_metric(have: &IndexSet<String>, k: &K8s) -> Option<(&'static str, f64)> {
    (0..2).find(|i| have.contains(k.metrics[*i])).map(|i| (k.metrics[i], k.scale[i]))
}

/// probe Datadog: which presets its metrics support, the services and workloads they name, when
/// requests flowed, whether service dependencies answer, and what is missing
pub fn probe(cfg: &Value, now: f64) -> Result<Value, String> {
    let c = Client::new(cfg)?;
    let mut warnings: Vec<String> = vec![];
    let mut missing: Vec<String> = vec![];
    let list = c.get("api/v1/metrics", &[("from", js_num((now - MONTH).floor()))]).map_err(|e| {
        if e.starts_with("fetch failed") {
            format!("{} — is {} reachable from here?", e, c.base())
        } else {
            e
        }
    })?;
    let have: IndexSet<String> = strs(list.get("metrics")).into_iter().collect();
    let chosen = strs(cfg.get("presets"));
    let want = |p: &str| chosen.is_empty() || chosen.iter().any(|x| x == p);
    let mut presets: Vec<String> = vec![];
    let mut services = JMap::new();
    let mut metrics = JMap::new();
    let mut out = JMap::new();
    out.insert("url".into(), json!(c.base()));
    out.insert("ok".into(), json!(true));

    // ---- APM: the trace metrics of each span name that serves requests
    let mut spans: Vec<String> = have.iter().filter_map(|m| m.strip_prefix("trace.").and_then(|r| r.strip_suffix(".hits"))).filter(|n| !n.ends_with(".by_http_status") && !n.contains(".hits.")).map(String::from).collect();
    spans.sort();
    let clients: Vec<String> = spans.iter().filter(|n| client_span(n)).cloned().collect();
    let servers: Vec<String> = spans.iter().filter(|n| !client_span(n)).cloned().collect();
    let mut traffic: BTreeMap<i64, f64> = BTreeMap::new();
    let mut apm = JMap::new();
    if want("datadog-apm") && !servers.is_empty() {
        // per span, service and env: the requests over 30 days in 6 h buckets
        let mut by: IndexMap<(String, String, String), f64> = IndexMap::new();
        let mut series: Vec<(String, Series)> = vec![];
        for sp in &servers {
            for x in c.query(&format!("sum:trace.{}.hits{{{}}} by {{service,env}}.as_count().rollup(sum, {})", sp, filter(cfg, None), js_num(COARSE)), now - MONTH, now)? {
                let (svc, env) = (x.tags.get("service").cloned().unwrap_or_default(), x.tags.get("env").cloned().unwrap_or_default());
                if svc.is_empty() {
                    continue;
                }
                *by.entry((sp.clone(), svc, env)).or_insert(0.0) += x.points.iter().map(|p| p.1).sum::<f64>();
                series.push((sp.clone(), x));
            }
        }
        let mut envs: IndexMap<String, f64> = IndexMap::new();
        for ((_, _, e), v) in &by {
            *envs.entry(e.clone()).or_insert(0.0) += v;
        }
        envs.sort_by(|a, _, b, _| a.cmp(b));
        let env = match s(cfg.get("env")) {
            Some(e) => {
                if !envs.contains_key(&e) && !envs.is_empty() {
                    warnings.push(format!("no trace metrics in env \"{}\" (the envs found: {})", e, envs.keys().cloned().collect::<Vec<_>>().join(", ")));
                }
                Some(e)
            }
            None => {
                let busiest = envs.iter().filter(|(e, _)| !e.is_empty()).fold(None::<(&String, f64)>, |m, (e, v)| if m.map(|m| *v > m.1).unwrap_or(true) { Some((e, *v)) } else { m }).map(|x| x.0.clone());
                if envs.keys().filter(|e| !e.is_empty()).count() > 1 {
                    warnings.push(format!("trace metrics from several APM envs ({}): reading {}, the busiest — give datadog.env to choose", envs.keys().filter(|e| !e.is_empty()).cloned().collect::<Vec<_>>().join(", "), busiest.clone().unwrap_or_default()));
                }
                busiest
            }
        };
        // each service's primary operation: the span name with the most requests in the env
        let mut primary: IndexMap<String, (String, f64)> = IndexMap::new();
        for ((sp, svc, e), v) in &by {
            if env.as_ref().map(|x| x == e).unwrap_or(true) && *v > 0.0 && primary.get(svc).map(|p| *v > p.1).unwrap_or(true) {
                primary.insert(svc.clone(), (sp.clone(), *v));
            }
        }
        primary.sort_keys();
        for (sp, x) in &series {
            let svc = x.tags.get("service").cloned().unwrap_or_default();
            let e = x.tags.get("env").cloned().unwrap_or_default();
            if env.as_ref().map(|v| *v == e).unwrap_or(true) && primary.get(&svc).map(|p| p.0 == *sp).unwrap_or(false) {
                for (t, v) in &x.points {
                    *traffic.entry(t.round() as i64).or_insert(0.0) += v;
                }
            }
        }
        if !primary.is_empty() {
            presets.push("datadog-apm".into());
            services.insert("datadog-apm".into(), json!(primary.keys().collect::<Vec<_>>()));
            let mut sp: IndexMap<String, Vec<String>> = IndexMap::new();
            for (svc, (span, _)) in &primary {
                sp.entry(span.clone()).or_default().push(svc.clone());
            }
            sp.sort_keys();
            let dist: Vec<&String> = sp.keys().filter(|x| have.contains(&format!("trace.{}", x))).collect();
            let no_dist: Vec<String> = sp.keys().filter(|x| !have.contains(&format!("trace.{}", x))).cloned().collect();
            metrics.insert("rps".into(), json!(sp.keys().map(|x| format!("trace.{}.hits", x)).collect::<Vec<_>>()));
            metrics.insert("errorRate".into(), json!(sp.keys().map(|x| format!("trace.{}.errors / .hits", x)).collect::<Vec<_>>()));
            if !dist.is_empty() {
                metrics.insert("p99Ms".into(), json!(dist.iter().map(|x| format!("p99:trace.{}", x)).collect::<Vec<_>>()));
            }
            metrics.insert("meanMs".into(), json!(sp.keys().map(|x| if have.contains(&format!("trace.{}", x)) { format!("avg:trace.{}", x) } else { format!("trace.{}.duration / .hits", x) }).collect::<Vec<_>>()));
            if !no_dist.is_empty() {
                missing.push(format!("p99 latency for {}: no latency distribution (trace.{}) — the mean comes from the legacy trace.<span>.duration, and p99 is unknown", no_dist.iter().map(|x| sp[x].join(", ")).collect::<Vec<_>>().join(", "), no_dist.join(", trace.")));
            }
            apm.insert("env".into(), json!(env));
            apm.insert("envs".into(), json!(envs.keys().filter(|e| !e.is_empty()).collect::<Vec<_>>()));
            apm.insert("spans".into(), json!(sp));
            if !clients.is_empty() {
                apm.insert("clientSpans".into(), json!(clients));
            }
        } else {
            warnings.push(format!("trace metrics exist ({}) but count no requests in the last 30 days{}", servers.iter().map(|x| format!("trace.{}.hits", x)).collect::<Vec<_>>().join(", "), env.as_ref().map(|e| format!(" in env {}", e)).unwrap_or_default()));
        }
    }
    if !presets.iter().any(|p| p == "datadog-apm") && want("datadog-apm") {
        missing.push("APM trace metrics (trace.<span>.hits): request rates, errors and latency per service — without them only the ingress's requests, if any, say how much traffic there was".into());
    }

    // ---- Kubernetes: the Agent's kubelet and kube-state metrics (the container check's where kubelet's are missing)
    let mut wns: IndexMap<String, Vec<String>> = IndexMap::new();
    if want("datadog-kubernetes") {
        if let Some((cpu, _)) = k8s_metric(&have, &K8S_SIGNALS[0]) {
            for x in c.query(&format!("sum:{}{{{}}} by {{{}}}.rollup(avg, 3600)", cpu, filter(cfg, None), K8S_BY), now - 86400.0, now)? {
                if let Some(w) = workload(&x.tags) {
                    let e = wns.entry(w).or_default();
                    let n = x.tags.get("kube_namespace").cloned().unwrap_or_default();
                    if !e.contains(&n) {
                        e.push(n);
                    }
                }
            }
            if wns.is_empty() {
                warnings.push(format!("{} exists but no series carries kube_deployment or kube_stateful_set in the last day — the datadog-kubernetes preset can't name workloads", cpu));
            } else {
                wns.sort_keys();
                presets.push("datadog-kubernetes".into());
                services.insert("datadog-kubernetes".into(), json!(wns.keys().collect::<Vec<_>>()));
                for k in &K8S_SIGNALS {
                    match k8s_metric(&have, k) {
                        Some((m, _)) => {
                            metrics.insert(k.signal.into(), json!(m));
                        }
                        None => missing.push(match k.signal {
                            "cpuLimitCores" => "CPU limits (kubernetes.cpu.limits): capacity can't come from CPU, and resizes can't be priced".to_string(),
                            "memoryLimitBytes" => "memory limits (kubernetes.memory.limits): no OOM headroom".to_string(),
                            "memoryBytes" => "memory use (kubernetes.memory.usage)".to_string(),
                            "cpuRequestCores" => "CPU requests (kubernetes.cpu.requests)".to_string(),
                            "memoryRequestBytes" => "memory requests (kubernetes.memory.requests)".to_string(),
                            "netTxBps" => "network traffic (kubernetes.network.tx_bytes)".to_string(),
                            x => format!("{} ({})", x, k.metrics[0]),
                        }),
                    }
                }
                let reps: Vec<&str> = REPLICAS.iter().filter(|r| have.contains(r.0)).map(|r| r.0).collect();
                if reps.is_empty() {
                    missing.push("replicas (kubernetes_state.deployment.replicas_available): per-replica capacity is unknown".into());
                } else {
                    metrics.insert("replicas".into(), json!(reps));
                }
                if have.contains(THROTTLED.0) && have.contains(THROTTLED.1) {
                    metrics.insert("cpuThrottled".into(), json!(format!("{} / {}", THROTTLED.0, THROTTLED.1)));
                } else {
                    missing.push(format!("CPU throttling ({} and {}){}", THROTTLED.0, THROTTLED.1, if have.contains("container.cpu.throttled.periods") { ": container.cpu.throttled.periods is there, but without a count of all periods to divide it by" } else { "" }));
                }
            }
        } else {
            missing.push("container metrics (kubernetes.cpu.usage.total or container.cpu.usage): CPU, memory and their limits — without them capacity can't come from CPU".into());
        }
    }

    // ---- ingress-nginx: what the controller counted per Service
    if want("datadog-ingress-nginx") && have.contains(INGRESS) {
        let mut svcs: IndexSet<String> = IndexSet::new();
        for x in c.query(&format!("sum:{}{{{}}} by {{service}}.as_count().rollup(sum, {})", INGRESS, filter(cfg, None), js_num(COARSE)), now - MONTH, now)? {
            if let Some(svc) = x.tags.get("service").filter(|_| x.points.iter().any(|p| p.1 > 0.0)) {
                svcs.insert(svc.clone());
                if !presets.iter().any(|p| p == "datadog-apm") {
                    for (t, v) in &x.points {
                        *traffic.entry(t.round() as i64).or_insert(0.0) += v;
                    }
                }
            }
        }
        if !svcs.is_empty() {
            svcs.sort();
            presets.push("datadog-ingress-nginx".into());
            services.insert("datadog-ingress-nginx".into(), json!(svcs));
            metrics.insert("ingressRps".into(), json!(INGRESS));
        }
    }
    if presets.is_empty() {
        warnings.push("no metric any Datadog preset reads was found in the last 30 days".into());
    }

    // ---- when requests flowed: the 6 h buckets with requests, the edges refined to 5 minutes
    let busy: Vec<i64> = traffic.iter().filter(|(_, v)| **v > 0.0).map(|(t, _)| *t).collect();
    if let (Some(&first), Some(&last)) = (busy.first(), busy.last()) {
        let apm_env = apm.get("env").and_then(|e| e.as_str()).map(String::from);
        let fine = |a: f64, b: f64| -> Result<Vec<f64>, String> {
            let mut ts: Vec<f64> = vec![];
            let mut qs: Vec<String> = vec![];
            if let Some(sp) = apm.get("spans").and_then(|x| x.as_object()) {
                for (span, svcs) in sp {
                    let names: IndexSet<String> = strs(Some(svcs)).into_iter().collect();
                    qs.push(format!("sum:trace.{}.hits{{{}}} by {{service}}.as_count().rollup(sum, 300)|{}", span, filter(cfg, apm_env.as_deref()), names.into_iter().collect::<Vec<_>>().join(",")));
                }
            } else {
                qs.push(format!("sum:{}{{{}}}.as_count().rollup(sum, 300)|", INGRESS, filter(cfg, None)));
            }
            for q in qs {
                let (q, keep) = q.split_once('|').unwrap();
                let keep: Vec<&str> = keep.split(',').filter(|x| !x.is_empty()).collect();
                for x in c.query(q, a, b)? {
                    if keep.is_empty() || x.tags.get("service").map(|s| keep.contains(&s.as_str())).unwrap_or(false) {
                        ts.extend(x.points.iter().filter(|p| p.1 > 0.0).map(|p| p.0));
                    }
                }
            }
            Ok(ts)
        };
        let (first, last) = (first as f64, last as f64);
        let newest = fine(last, (last + COARSE).min(now))?.into_iter().fold(f64::NAN, f64::max);
        let newest = if newest.is_finite() { (newest + 300.0).min(now) } else { (last + COARSE).min(now) };
        let oldest = fine(first, (first + COARSE).min(now))?.into_iter().fold(f64::NAN, f64::min);
        let oldest = if oldest.is_finite() { oldest } else { first };
        out.insert("data".into(), json!({ "newest": iso(newest), "oldestFound": iso(oldest), "hoursFound": js_round((newest - oldest) / 360.0) / 10.0 }));
        if now - newest > 3600.0 {
            warnings.push(format!("no requests in the last hour — the system is idle or no longer instrumented; the newest traffic is around {}", iso(newest)));
        }
        if busy.len() < ((last - first) / COARSE).round() as usize + 1 {
            warnings.push("traffic comes and goes inside the window (idle stretches between busy ones)".into());
        }
    } else if !presets.is_empty() && presets.iter().any(|p| p != "datadog-kubernetes") {
        warnings.push("no requests in the last 30 days".into());
    }

    // ---- who calls whom: APM service dependencies, in the env
    let mut calls: Vec<&str> = vec![];
    if let Some(env) = apm.get("env").and_then(|e| e.as_str()) {
        match c.get("api/v1/service_dependencies", &[("env", env.to_string()), ("start", js_num((now - 86400.0).floor())), ("end", js_num(now.floor()))]) {
            Ok(d) => {
                let n: usize = d.as_object().map(|o| o.values().map(|v| strs(v.get("calls")).len()).sum()).unwrap_or(0);
                if n > 0 {
                    calls.push("dependencies");
                    apm.insert("dependencies".into(), json!(n));
                } else {
                    warnings.push(format!("APM service dependencies name no calls in env {} over the last day", env));
                }
            }
            Err(e) => warnings.push(format!("APM service dependencies unavailable ({}): who calls whom comes from a topologyFile, else each service is its own entry", e)),
        }
    }

    out.insert("presets".into(), json!(presets));
    out.insert("metrics".into(), Value::Object(metrics));
    out.insert("services".into(), Value::Object(services));
    if !apm.is_empty() {
        out.insert("apm".into(), Value::Object(apm));
    }
    if !calls.is_empty() {
        out.insert("calls".into(), json!(calls));
    }
    if !wns.is_empty() {
        out.insert("workloadNamespaces".into(), json!(wns));
    }
    out.insert("missing".into(), json!(missing));
    out.insert("warnings".into(), json!(warnings));
    // the probe's report, in a stable order: url, ok, presets, metrics, services, apm, calls, … data last
    if let Some(d) = out.shift_remove("data") {
        out.insert("data".into(), d);
    }
    Ok(Value::Object(out))
}

/// who calls whom over the windows, from APM service dependencies (names, not counts)
pub fn read_calls(cfg: &Value, probe: &Value, parts: &[(f64, f64)], rename: &JMap<String, Value>, known: &[String]) -> Result<super::infer::Calls, String> {
    let name = |x: &str| rename.get(x).and_then(|v| v.as_str()).unwrap_or(x).to_string();
    let mut c = super::infer::Calls { from: "none".into(), edges: vec![], entry: vec![], ingress: vec![], clients: vec![], grpc: IndexSet::new(), notes: vec![], out_ms: IndexMap::new(), orphans: vec![] };
    let env = probe.get("apm").and_then(|a| a.get("env")).and_then(|e| e.as_str()).map(String::from);
    let has = strs(probe.get("calls")).iter().any(|x| x == "dependencies");
    let mut pairs: IndexSet<(String, String)> = IndexSet::new();
    if let (Some(env), true) = (env, has) {
        let client = Client::new(cfg)?;
        for (a, b) in parts {
            let d = client.get("api/v1/service_dependencies", &[("env", env.clone()), ("start", js_num(a.floor())), ("end", js_num(b.ceil()))])?;
            for (from, v) in d.as_object().cloned().unwrap_or_default() {
                for to in strs(v.get("calls")) {
                    if from != to {
                        pairs.insert((name(&from), name(&to)));
                    }
                }
            }
        }
    }
    let mut ingress: Vec<String> = strs(probe.get("services").and_then(|s| s.get("datadog-ingress-nginx"))).iter().map(|x| name(x)).collect();
    ingress.sort();
    c.ingress = ingress;
    if pairs.is_empty() {
        let mut e: IndexSet<String> = c.ingress.iter().cloned().collect();
        e.extend(known.iter().cloned());
        let mut e: Vec<String> = e.into_iter().collect();
        e.sort();
        c.entry = e;
        return Ok(c);
    }
    c.from = "datadog".into();
    for (from, to) in &pairs {
        c.edges.push(super::infer::Edge { from: from.clone(), to: to.clone(), calls: 0.0, per_request: None, grpc: false });
    }
    c.edges.sort_by(|a, b| (&a.from, &a.to).cmp(&(&b.from, &b.to)));
    // callers APM has no requests of (a load generator, a browser's RUM service): what they call takes traffic from outside
    let served: IndexSet<&String> = known.iter().collect();
    let mut clients: Vec<String> = c.edges.iter().filter(|e| !served.contains(&e.from)).map(|e| e.from.clone()).collect::<IndexSet<_>>().into_iter().collect();
    clients.sort();
    c.clients = clients;
    // the entries: what the ingress routes to, what the clients call, and services nothing calls
    let mut entry: IndexSet<String> = c.ingress.iter().cloned().collect();
    entry.extend(c.edges.iter().filter(|e| c.clients.contains(&e.from)).map(|e| e.to.clone()));
    let called: IndexSet<String> = c.edges.iter().filter(|e| !c.clients.contains(&e.from)).map(|e| e.to.clone()).collect();
    entry.extend(known.iter().filter(|s| !called.contains(*s)).cloned());
    let mut e: Vec<String> = entry.into_iter().collect();
    e.sort();
    c.entry = e;
    c.notes.push("APM service dependencies name callers and callees but not how often: each callee's requests are shared over its callers in proportion to theirs".into());
    Ok(c)
}

/// one output file: its name, the import mapping, and its series as (labels, points)
struct Out {
    file: String,
    mapping: Value,
    rows: Vec<(IndexMap<String, String>, BTreeMap<i64, f64>)>,
}

impl Out {
    fn new(file: &str, mapping: Value) -> Out {
        Out { file: file.into(), mapping, rows: vec![] }
    }
    fn add(&mut self, labels: IndexMap<String, String>, points: impl IntoIterator<Item = (f64, f64)>) {
        let pts: BTreeMap<i64, f64> = points.into_iter().filter(|(_, v)| v.is_finite()).map(|(t, v)| (t.round() as i64, v)).collect();
        if !pts.is_empty() {
            self.rows.push((labels, pts));
        }
    }
    /// the Prometheus query_range shape the import reads
    fn to_prometheus(&self) -> Value {
        let result: Vec<Value> = self
            .rows
            .iter()
            .map(|(l, p)| {
                let metric: JMap<String, Value> = l.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
                json!({ "metric": metric, "values": p.iter().map(|(t, v)| json!([*t, js_num(*v)])).collect::<Vec<_>>() })
            })
            .collect();
        json!({ "status": "success", "data": { "resultType": "matrix", "result": result } })
    }
}

fn lab(pairs: &[(&str, &str)]) -> IndexMap<String, String> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

/// numerator over denominator, point by point, where the denominator is positive
pub fn ratio(num: &[(f64, f64)], den: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let n: BTreeMap<i64, f64> = num.iter().map(|(t, v)| (t.round() as i64, *v)).collect();
    den.iter().filter(|(_, d)| *d > 0.0).map(|(t, d)| (*t, n.get(&(t.round() as i64)).copied().unwrap_or(0.0) / d)).collect()
}

fn m(metric: &str, rest: &[(&str, Value)]) -> Value {
    let mut o = JMap::new();
    o.insert("metric".into(), json!(metric));
    for (k, v) in rest {
        o.insert((*k).into(), v.clone());
    }
    Value::Object(o)
}

/// the queries of the presets over one window, as files in the Prometheus shape: what the manifest
/// imports, file name → series count
pub fn export(cfg: &Value, probe: &Value, presets: &[String], entry: &[String], a: f64, b: f64, step: f64, write: &dyn Fn(&str, &str) -> Result<(), String>) -> Result<Vec<(String, usize, Value)>, String> {
    let c = Client::new(cfg)?;
    let has = |p: &str| presets.iter().any(|x| x == p);
    let st = js_num(step);
    let mut files: Vec<Out> = vec![];
    let ns = strs(cfg.get("namespaces"));

    if has("datadog-apm") {
        let env = probe.get("apm").and_then(|x| x.get("env")).and_then(|e| e.as_str()).map(String::from);
        let f = filter(cfg, env.as_deref());
        let spans = probe.get("apm").and_then(|x| x.get("spans")).and_then(|x| x.as_object()).cloned().unwrap_or_default();
        let dist: Vec<String> = strs(probe.get("metrics").and_then(|m| m.get("p99Ms")));
        let svc = [("by", json!("service"))];
        let ep: Vec<(&str, Value)> = vec![("by", json!("service")), ("endpointBy", json!("resource_name")), ("template", json!(true))];
        let mut rps = Out::new("datadog-apm-rps.json", m("rps", &svc));
        let mut err = Out::new("datadog-apm-errors.json", m("errorRate", &[("by", json!("service")), ("unit", json!("ratio"))]));
        let mut mean = Out::new("datadog-apm-mean.json", m("meanMs", &svc));
        let mut p99 = Out::new("datadog-apm-p99.json", m("p99Ms", &svc));
        let mut ep_rps = Out::new("datadog-apm-endpoint-rps.json", m("rps", &ep));
        let mut ep_err = Out::new("datadog-apm-endpoint-errors.json", m("errorRate", &[ep.clone(), vec![("unit", json!("ratio"))]].concat()));
        let mut ep_mean = Out::new("datadog-apm-endpoint-mean.json", m("meanMs", &ep));
        let mut ep_p99 = Out::new("datadog-apm-endpoint-p99.json", m("p99Ms", &ep));
        for (span, svcs) in &spans {
            let svcs: Vec<String> = strs(Some(svcs));
            let ent: Vec<&String> = svcs.iter().filter(|s| entry.contains(s)).collect();
            let has_dist = dist.iter().any(|d| d == &format!("p99:trace.{}", span));
            for (by, endpoints) in [("service", false), ("service,resource_name", true)] {
                if endpoints && ent.is_empty() {
                    continue;
                }
                let keep = |t: &IndexMap<String, String>| t.get("service").map(|s| if endpoints { ent.iter().any(|e| *e == s) } else { svcs.contains(s) }).unwrap_or(false) && (!endpoints || t.contains_key("resource_name"));
                let labels = |t: &IndexMap<String, String>| if endpoints { lab(&[("service", &t["service"]), ("resource_name", &t["resource_name"])]) } else { lab(&[("service", &t["service"])]) };
                let key = |t: &IndexMap<String, String>| labels(t).values().cloned().collect::<Vec<_>>().join("\u{1}");
                let hits = c.query_range(&format!("sum:trace.{}.hits{{{}}} by {{{}}}.as_count().rollup(sum, {})", span, f, by, st), a, b, step)?;
                let errors = c.query_range(&format!("sum:trace.{}.errors{{{}}} by {{{}}}.as_count().rollup(sum, {})", span, f, by, st), a, b, step)?;
                let errs: IndexMap<String, Vec<(f64, f64)>> = errors.iter().filter(|x| keep(&x.tags)).map(|x| (key(&x.tags), x.points.clone())).collect();
                let hit_of: IndexMap<String, Vec<(f64, f64)>> = hits.iter().filter(|x| keep(&x.tags)).map(|x| (key(&x.tags), x.points.clone())).collect();
                let (r, e) = if endpoints { (&mut ep_rps, &mut ep_err) } else { (&mut rps, &mut err) };
                for x in hits.iter().filter(|x| keep(&x.tags)) {
                    // counts per bucket → requests per second
                    r.add(labels(&x.tags), x.points.iter().map(|(t, v)| (*t, v / step)));
                    e.add(labels(&x.tags), ratio(errs.get(&key(&x.tags)).map(|v| v.as_slice()).unwrap_or(&[]), &x.points));
                }
                let (mn, pp) = if endpoints { (&mut ep_mean, &mut ep_p99) } else { (&mut mean, &mut p99) };
                if has_dist {
                    // the latency distribution is in seconds
                    for x in c.query_range(&format!("avg:trace.{}{{{}}} by {{{}}}.rollup(avg, {})", span, f, by, st), a, b, step)?.iter().filter(|x| keep(&x.tags)) {
                        mn.add(labels(&x.tags), x.points.iter().map(|(t, v)| (*t, v * 1000.0)));
                    }
                    for x in c.query_range(&format!("p99:trace.{}{{{}}} by {{{}}}.rollup({})", span, f, by, st), a, b, step)?.iter().filter(|x| keep(&x.tags)) {
                        pp.add(labels(&x.tags), x.points.iter().map(|(t, v)| (*t, v * 1000.0)));
                    }
                } else {
                    // legacy: the total time of the spans in each bucket (seconds) over their count
                    for x in c.query_range(&format!("sum:trace.{}.duration{{{}}} by {{{}}}.rollup(sum, {})", span, f, by, st), a, b, step)?.iter().filter(|x| keep(&x.tags)) {
                        if let Some(h) = hit_of.get(&key(&x.tags)) {
                            mn.add(labels(&x.tags), ratio(&x.points, h).into_iter().map(|(t, v)| (t, v * 1000.0)));
                        }
                    }
                }
            }
        }
        files.extend([rps, err, mean, p99]);
        if !entry.is_empty() {
            files.extend([ep_rps, ep_err, ep_mean, ep_p99]);
        }
    }

    if has("datadog-kubernetes") {
        let f = filter(cfg, None);
        let have: IndexSet<String> = strs(probe.get("metrics").and_then(|m| m.get("replicas"))).into_iter().collect();
        let wl = [("by", json!("workload"))];
        // one series per workload, summed over its pods (or the largest pod's, for limits and requests)
        let per_workload = |q: &str, scale: f64, max_pod: bool| -> Result<Vec<(IndexMap<String, String>, Vec<(f64, f64)>)>, String> {
            let mut acc: IndexMap<String, BTreeMap<i64, f64>> = IndexMap::new();
            for x in c.query_range(q, a, b, step)? {
                let Some(w) = workload(&x.tags) else { continue };
                if !in_namespaces(&x.tags, &ns) {
                    continue;
                }
                let e = acc.entry(w).or_default();
                for (t, v) in x.points {
                    let k = t.round() as i64;
                    let v = v * scale;
                    let cur = e.get(&k).copied();
                    e.insert(k, match cur {
                        Some(c) if max_pod => c.max(v),
                        Some(c) => c + v,
                        None => v,
                    });
                }
            }
            acc.sort_keys();
            Ok(acc.into_iter().map(|(w, p)| (lab(&[("workload", &w)]), p.into_iter().map(|(t, v)| (t as f64, v)).collect())).collect())
        };
        let have_all: Vec<String> = probe.get("metrics").and_then(|m| m.as_object()).map(|o| o.values().flat_map(|v| match v {
            Value::String(s) => vec![s.clone()],
            v => strs(Some(v)),
        }).collect()).unwrap_or_default();
        for k in &K8S_SIGNALS {
            let pick = (0..2).find(|i| have_all.iter().any(|h| h == k.metrics[*i])).map(|i| (k.metrics[i], k.scale[i]));
            let Some((metric, scale)) = pick else { continue };
            let file = match k.signal {
                "cpuCores" => "cpu",
                "cpuLimitCores" => "cpu-limit",
                "cpuRequestCores" => "cpu-request",
                "memoryBytes" => "memory",
                "memoryLimitBytes" => "memory-limit",
                "memoryRequestBytes" => "memory-request",
                _ => "net-tx",
            };
            let pod = k.signal.contains("Limit") || k.signal.contains("Request");
            let q = if pod { format!("sum:{}{{{}}} by {{{},pod_name}}.rollup(avg, {})", metric, f, K8S_BY, st) } else { format!("sum:{}{{{}}} by {{{}}}.rollup(avg, {})", metric, f, K8S_BY, st) };
            let mut o = Out::new(&format!("datadog-kubernetes-{}.json", file), m(k.signal, &wl));
            for (l, p) in per_workload(&q, scale, pod)? {
                o.add(l, p);
            }
            files.push(o);
            if k.signal == "memoryBytes" {
                // the largest pod's peak in each bucket
                let mut o = Out::new("datadog-kubernetes-memory-max.json", m("memoryMaxBytes", &wl));
                for (l, p) in per_workload(&format!("sum:{}{{{}}} by {{{},pod_name}}.rollup(max, {})", metric, f, K8S_BY, st), scale, true)? {
                    o.add(l, p);
                }
                files.push(o);
            }
        }
        let mut reps = Out::new("datadog-kubernetes-replicas.json", m("replicas", &wl));
        for (metric, _) in REPLICAS.iter().filter(|r| have.contains(r.0)) {
            for (l, p) in per_workload(&format!("sum:{}{{{}}} by {{{}}}.rollup(avg, {})", metric, f, K8S_BY, st), 1.0, false)? {
                reps.add(l, p);
            }
        }
        if !have.is_empty() {
            files.push(reps);
        }
        if have_all.iter().any(|h| h.starts_with(THROTTLED.0)) {
            let num = per_workload(&format!("sum:{}{{{}}} by {{{}}}.rollup(sum, {})", THROTTLED.0, f, K8S_BY, st), 1.0, false)?;
            let den = per_workload(&format!("sum:{}{{{}}} by {{{}}}.rollup(sum, {})", THROTTLED.1, f, K8S_BY, st), 1.0, false)?;
            let mut o = Out::new("datadog-kubernetes-throttled.json", m("cpuThrottled", &[("by", json!("workload")), ("unit", json!("ratio"))]));
            for (l, d) in den {
                let n = num.iter().find(|x| x.0 == l).map(|x| x.1.clone()).unwrap_or_default();
                o.add(l, ratio(&n, &d));
            }
            files.push(o);
        }
    }

    if has("datadog-ingress-nginx") {
        let f = filter(cfg, None);
        let by = [("by", json!("service")), ("edge", json!(true))];
        let mut r = Out::new("datadog-ingress-nginx-rps.json", m("rps", &by));
        let mut e = Out::new("datadog-ingress-nginx-errors.json", m("errorRate", &[("unit", json!("ratio")), ("by", json!("service")), ("edge", json!(true))]));
        let mut all: IndexMap<String, BTreeMap<i64, f64>> = IndexMap::new();
        let mut bad: IndexMap<String, BTreeMap<i64, f64>> = IndexMap::new();
        for x in c.query_range(&format!("sum:{}{{{}}} by {{service,status}}.as_count().rollup(sum, {})", INGRESS, f, st), a, b, step)? {
            let Some(svc) = x.tags.get("service").cloned() else { continue };
            // 5xx, and 499 (the client gave up), as the Prometheus preset counts them
            let failed = x.tags.get("status").map(|s| s.starts_with('5') || s == "499").unwrap_or(false);
            for (t, v) in &x.points {
                *all.entry(svc.clone()).or_default().entry(t.round() as i64).or_insert(0.0) += v;
                if failed {
                    *bad.entry(svc.clone()).or_default().entry(t.round() as i64).or_insert(0.0) += v;
                }
            }
        }
        all.sort_keys();
        for (svc, p) in &all {
            let pts: Vec<(f64, f64)> = p.iter().map(|(t, v)| (*t as f64, *v)).collect();
            r.add(lab(&[("service", svc)]), pts.iter().map(|(t, v)| (*t, v / step)));
            let bp: Vec<(f64, f64)> = bad.get(svc).map(|b| b.iter().map(|(t, v)| (*t as f64, *v)).collect()).unwrap_or_default();
            e.add(lab(&[("service", svc)]), ratio(&bp, &pts));
        }
        files.extend([r, e]);
    }

    let mut out = vec![];
    for o in files {
        write(&o.file, &crate::convert::js_stringify(&o.to_prometheus()))?;
        out.push((o.file.clone(), o.rows.len(), o.mapping.clone()));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn sites_and_urls() {
        assert_eq!(api_base(&json!({ "site": "datadoghq.eu" })).unwrap(), "https://api.datadoghq.eu");
        assert_eq!(api_base(&json!({ "site": "app.us3.datadoghq.com" })).unwrap(), "https://api.us3.datadoghq.com");
        assert_eq!(api_base(&json!({ "url": "http://127.0.0.1:19690/shop/" })).unwrap(), "http://127.0.0.1:19690/shop");
        assert!(api_base(&json!({ "site": "datadoghq.cmo" })).unwrap_err().contains("unknown Datadog site"));
        assert_eq!(key_envs(&json!({})), ("DD_API_KEY".to_string(), "DD_APP_KEY".to_string()));
    }

    #[test]
    fn a_missing_key_is_named_by_its_variable() {
        let e = Client::new(&json!({ "site": "datadoghq.com", "apiKeyEnv": "HINDCAST_TEST_NO_SUCH_KEY", "appKeyEnv": "HINDCAST_TEST_NO_SUCH_KEY" })).err().unwrap();
        assert!(e.contains("env var HINDCAST_TEST_NO_SUCH_KEY is not set"));
    }

    #[test]
    fn parses_the_documented_answer() {
        // the response example of GET /api/v1/query, and a grouped series with a colon in a tag value
        let v = json!({
            "status": "ok", "res_type": "time_series", "from_date": 1681683300000u64, "to_date": 1681683300000u64,
            "query": "system.cpu.idle{host:foo,env:test}",
            "series": [
                { "aggr": "avg", "display_name": "system.cpu.idle", "end": 1681683300000u64, "expression": "system.cpu.idle{host:foo,env:test}", "interval": 1000, "length": 1, "metric": "system.cpu.idle",
                  "pointlist": [[1681683300000u64, 77.62145685254418]], "query_index": 0, "scope": "host:foo,env:test", "start": 1681683300000u64, "tag_set": [],
                  "unit": [{ "family": "time", "name": "minute", "plural": "minutes", "scale_factor": 60, "short_name": "min" }] },
                { "metric": "trace.http.request.hits", "scope": "resource_name:GET /a:b,service:web", "tag_set": ["resource_name:GET /a:b", "service:web", "kube_deployment:N/A"],
                  "pointlist": [[1000000, 3.0], [1060000, null], [1120000, 5.0]] }
            ]
        });
        let s = parse_query(&v).unwrap();
        assert_eq!(s[0].tags, lab(&[("host", "foo"), ("env", "test")]));
        assert_eq!(s[0].points, vec![(1681683300.0, 77.62145685254418)]);
        assert_eq!(s[1].tags, lab(&[("resource_name", "GET /a:b"), ("service", "web")]));
        assert_eq!(s[1].points, vec![(1000.0, 3.0), (1120.0, 5.0)]);
        assert!(parse_query(&json!({ "status": "error", "error": "Rule parse error" })).unwrap_err().contains("Rule parse error"));
        assert!(parse_query(&json!({ "errors": ["Bad Request"] })).is_err());
    }

    #[test]
    fn windows_stay_under_the_point_limit() {
        // a day at 60 s is 1,440 points: five windows of at most 300
        let w = chunks(0.0, 86400.0, 60.0, MAX_POINTS);
        assert_eq!(w.len(), 5);
        assert_eq!(w[0], (0.0, 18000.0));
        assert_eq!(w[4], (72000.0, 86400.0));
        assert!(w.iter().all(|(a, b)| (b - a) / 60.0 <= MAX_POINTS));
        assert!(w.windows(2).all(|p| p[0].1 == p[1].0));
        assert_eq!(chunks(10.0, 10.0, 60.0, MAX_POINTS), vec![(10.0, 10.0)]);
    }

    #[test]
    fn backoff_follows_the_reset_header() {
        assert_eq!(backoff_s(0, Some("7")), 7.0);
        assert_eq!(backoff_s(3, Some("500")), 60.0);
        assert_eq!(backoff_s(0, None), 1.0);
        assert_eq!(backoff_s(2, Some("soon")), 4.0);
        assert_eq!(backoff_s(9, None), 30.0);
    }

    #[test]
    fn ratios_and_spans() {
        assert_eq!(ratio(&[(0.0, 1.0)], &[(0.0, 4.0), (60.0, 2.0), (120.0, 0.0)]), vec![(0.0, 0.25), (60.0, 0.0)]);
        for c in ["postgres.query", "redis.command", "http.client.request", "grpc.client", "kafka.produce", "aws.sqs"] {
            assert!(client_span(c), "{}", c);
        }
        for s in ["http.request", "grpc.server", "servlet.request", "rack.request", "kafka.consume", "web.request"] {
            assert!(!client_span(s), "{}", s);
        }
    }

    /// a server answering each connection with the next canned response; the requests it saw
    fn serve(responses: Vec<String>) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = format!("http://{}", l.local_addr().unwrap());
        let seen = std::sync::Arc::new(std::sync::Mutex::new(vec![]));
        let s2 = seen.clone();
        std::thread::spawn(move || {
            for r in responses {
                let (mut sock, _) = l.accept().unwrap();
                let mut buf = [0u8; 8192];
                let n = sock.read(&mut buf).unwrap();
                s2.lock().unwrap().push(String::from_utf8_lossy(&buf[..n]).lines().next().unwrap_or("").to_string());
                sock.write_all(r.as_bytes()).unwrap();
            }
        });
        (addr, seen)
    }

    fn http(status: &str, extra: &str, body: &str) -> String {
        format!("HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{}\r\n{}", status, body.len(), extra, body)
    }

    #[test]
    fn a_429_is_retried_after_the_reset() {
        let ok = r#"{"status":"ok","series":[{"metric":"m","tag_set":["service:web"],"pointlist":[[60000,2.0]]}]}"#;
        let (base, seen) = serve(vec![http("429 Too Many Requests", "X-RateLimit-Reset: 0\r\n", r#"{"errors":["Too many requests"]}"#), http("200 OK", "", ok)]);
        let c = Client::at(&base);
        let s = c.query("sum:m{*} by {service}", 0.0, 120.0).unwrap();
        assert_eq!(s[0].points, vec![(60.0, 2.0)]);
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert!(seen[0].starts_with("GET /api/v1/query?from=0&to=120&query=sum%3Am%7B*%7D+by+%7Bservice%7D"));
    }

    #[test]
    fn a_429_that_persists_is_an_error_and_others_say_why() {
        let r: Vec<String> = (0..=RETRIES).map(|_| http("429 Too Many Requests", "", r#"{"errors":["Too many requests"]}"#)).collect();
        let (base, _) = serve(r);
        let e = Client::at(&base).get("api/v1/query", &[]).unwrap_err();
        assert!(e.contains("answered 429") && e.contains("still rate limited"), "{}", e);
        let (base, _) = serve(vec![http("403 Forbidden", "", r#"{"errors":["Forbidden"]}"#)]);
        let e = Client::at(&base).get("api/v1/metrics", &[]).unwrap_err();
        assert!(e.starts_with("api/v1/metrics answered 403: Forbidden — the application key needs"), "{}", e);
    }

    #[test]
    fn long_windows_are_split_and_merged() {
        // two windows of 300 points: each answers its own range, the series are joined per tag set
        let a = r#"{"status":"ok","series":[{"metric":"m","tag_set":["service:web"],"pointlist":[[0,1.0],[18000000,2.0]]}]}"#;
        let b = r#"{"status":"ok","series":[{"metric":"m","tag_set":["service:web"],"pointlist":[[18000000,2.0],[19000000,3.0]]},{"metric":"m","tag_set":["service:api"],"pointlist":[[19000000,4.0]]}]}"#;
        let (base, seen) = serve(vec![http("200 OK", "", a), http("200 OK", "", b)]);
        let s = Client::at(&base).query_range("sum:m{*} by {service}", 0.0, 20000.0, 60.0).unwrap();
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].points, vec![(0.0, 1.0), (18000.0, 2.0), (19000.0, 3.0)]);
        assert_eq!(s[1].tags, lab(&[("service", "api")]));
        let seen = seen.lock().unwrap();
        assert!(seen[0].contains("from=0&to=18000&"));
        assert!(seen[1].contains("from=18000&to=20000&"));
    }

    #[test]
    fn files_are_in_the_prometheus_shape() {
        let mut o = Out::new("x.json", m("rps", &[("by", json!("service"))]));
        o.add(lab(&[("service", "web")]), vec![(60.0, 0.5), (120.0, f64::NAN)]);
        o.add(lab(&[("service", "empty")]), vec![]);
        let v = o.to_prometheus();
        assert_eq!(v, json!({ "status": "success", "data": { "resultType": "matrix", "result": [{ "metric": { "service": "web" }, "values": [[60, "0.5"]] }] } }));
        let mut b = crate::import::builder::DatasetBuilder::default();
        let map: crate::import::metrics::SeriesMapping = serde_json::from_value(o.mapping.clone()).unwrap();
        assert_eq!(crate::import::metrics::import_prometheus(&mut b, &v, &map).unwrap(), 1.0);
    }
}
