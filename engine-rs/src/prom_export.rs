//! Standard Prometheus queries for the metrics Hindcast needs, grouped in presets that match common
//! setups (src/backtest/import/promExport.ts). The export runs them against a Prometheus URL and
//! writes one query_range JSON per query plus the `metrics:` block of an import manifest.

use serde_json::{json, Map as JMap, Value};

const SAFE: &str = "[bcdfghjklmnpqrstvwxz2456789]";

/// a pod's owning workload from its name (Deployment, StatefulSet, DaemonSet / Job pods)
pub fn workload_re() -> String {
    format!("^(?:(.+)-{s}{{6,10}}-{s}{{5}}|(.+)-[0-9]+|(.+)-{s}{{5}})$", s = SAFE)
}
fn workload(expr: &str) -> String {
    format!("label_replace({}, \"workload\", \"$1$2$3\", \"pod\", \"{}\")", expr, workload_re())
}
/// a regex alternative escaped as promExport.ts escapes it (`\\\\$&` for metacharacters and quotes)
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
fn ns_matcher(namespaces: &[String]) -> String {
    if namespaces.is_empty() {
        String::new()
    } else {
        format!("namespace=~\"{}\"", namespaces.iter().map(|n| esc_alt(n)).collect::<Vec<_>>().join("|"))
    }
}
fn entry_matcher(entry: &[String]) -> String {
    format!("service_name=~\"{}\"", entry.iter().map(|e| esc_alt(e)).collect::<Vec<_>>().join("|"))
}
fn join(parts: &[&str]) -> String {
    parts.iter().filter(|x| !x.is_empty()).cloned().collect::<Vec<_>>().join(",")
}

const SERVER: &str = "span_kind=\"SPAN_KIND_SERVER\"";
const WORKERS: &str = "unless on (node) kube_node_role{role=~\"control-plane|master\"}";

pub const PRESET_IDS: [&str; 8] = ["otel-spanmetrics", "http-server", "spring", "ingress-nginx", "istio", "linkerd", "cadvisor", "kubernetes"];

#[derive(Clone, Debug)]
pub struct Query {
    pub file: String,
    pub query: String,
    /// the import manifest's mapping, keys in the order the preset writes them
    pub mapping: Value,
}

fn q(file: &str, query: String, mapping: Value) -> Query {
    Query { file: file.into(), query, mapping }
}

/// mapping objects as the presets spell them: { metric, ...rest } in that order
fn m(metric: &str, rest: &[(&'static str, Value)]) -> Value {
    let mut o = JMap::new();
    o.insert("metric".into(), json!(metric));
    for (k, v) in rest {
        o.insert((*k).into(), v.clone());
    }
    Value::Object(o)
}

pub struct Opts {
    pub window: String,
    pub selector: String,
    pub entry: Vec<String>,
    pub namespaces: Vec<String>,
}

fn preset(id: &str, o: &Opts) -> Option<Vec<Query>> {
    let w = &o.window;
    let sel = o.selector.as_str();
    let entry = &o.entry;
    Some(match id {
        "otel-spanmetrics" => {
            let s = join(&[SERVER, sel]);
            let mut v = vec![
                q("rps.json", format!("sum by (service_name) (rate(traces_span_metrics_calls_total{{{s}}}[{w}]))"), m("rps", &[("by", json!("service_name"))])),
                q("errors.json", format!("(sum by (service_name) (rate(traces_span_metrics_calls_total{{{s},status_code=\"STATUS_CODE_ERROR\"}}[{w}])) or sum by (service_name) (rate(traces_span_metrics_calls_total{{{s}}}[{w}])) * 0) / sum by (service_name) (rate(traces_span_metrics_calls_total{{{s}}}[{w}]))"), m("errorRate", &[("by", json!("service_name")), ("unit", json!("ratio"))])),
                q("p50.json", format!("histogram_quantile(0.5, sum by (service_name, le) (rate(traces_span_metrics_duration_milliseconds_bucket{{{s}}}[{w}])))"), m("p50Ms", &[("by", json!("service_name")), ("unit", json!("ms"))])),
                q("p99.json", format!("histogram_quantile(0.99, sum by (service_name, le) (rate(traces_span_metrics_duration_milliseconds_bucket{{{s}}}[{w}])))"), m("p99Ms", &[("by", json!("service_name")), ("unit", json!("ms"))])),
                q("mean.json", format!("sum by (service_name) (rate(traces_span_metrics_duration_milliseconds_sum{{{s}}}[{w}])) / sum by (service_name) (rate(traces_span_metrics_duration_milliseconds_count{{{s}}}[{w}]))"), m("meanMs", &[("by", json!("service_name")), ("unit", json!("ms"))])),
            ];
            if !entry.is_empty() {
                let se = format!("{},{}", s, entry_matcher(entry));
                let ep = |extra: &[(&'static str, Value)]| -> Vec<(&'static str, Value)> {
                    let mut x: Vec<(&'static str, Value)> = extra.to_vec();
                    x.extend([("by", json!("service_name")), ("endpointBy", json!("span_name")), ("template", json!(true))]);
                    x
                };
                v.push(q("endpoint-rps.json", format!("sum by (service_name, span_name) (rate(traces_span_metrics_calls_total{{{se}}}[{w}]))"), m("rps", &ep(&[]))));
                let mut e = ep(&[("unit", json!("ratio"))]);
                e.push(("combine", json!("ratio")));
                v.push(q("endpoint-errors.json", format!("label_replace(sum by (service_name, span_name) (rate(traces_span_metrics_calls_total{{{se},status_code=\"STATUS_CODE_ERROR\"}}[{w}])), \"part\", \"num\", \"\", \"\") or label_replace(sum by (service_name, span_name) (rate(traces_span_metrics_calls_total{{{se}}}[{w}])), \"part\", \"den\", \"\", \"\")"), m("errorRate", &e)));
                let mut l = ep(&[("unit", json!("ms"))]);
                l.push(("combine", json!("histogram")));
                v.push(q("endpoint-latency.json", format!("sum by (service_name, span_name, le) (rate(traces_span_metrics_duration_milliseconds_bucket{{{se}}}[{w}]))"), m("p99Ms", &l)));
                let mut mm = ep(&[("unit", json!("ms"))]);
                mm.push(("combine", json!("ratio")));
                v.push(q("endpoint-mean.json", format!("label_replace(sum by (service_name, span_name) (rate(traces_span_metrics_duration_milliseconds_sum{{{se}}}[{w}])), \"part\", \"num\", \"\", \"\") or label_replace(sum by (service_name, span_name) (rate(traces_span_metrics_duration_milliseconds_count{{{se}}}[{w}])), \"part\", \"den\", \"\", \"\")"), m("meanMs", &mm)));
            }
            v
        }
        "http-server" => {
            let s = if sel.is_empty() { String::new() } else { format!("{{{}}}", sel) };
            let se = if sel.is_empty() { String::new() } else { format!("{},", sel) };
            let es = if entry.is_empty() { s.clone() } else { format!("{{{}}}", join(&[sel, &entry_matcher(entry)])) };
            let tpl: Vec<(&'static str, Value)> = if entry.is_empty() { vec![] } else { vec![("template", json!(true))] };
            let ep = |unit: Option<&str>| -> Vec<(&'static str, Value)> {
                let mut x: Vec<(&'static str, Value)> = vec![("by", json!("service_name")), ("endpointBy", json!("http_route")), ("methodBy", json!("http_request_method"))];
                if let Some(u) = unit {
                    x.push(("unit", json!(u)));
                }
                x.extend(tpl.iter().cloned());
                x
            };
            vec![
                q("rps.json", format!("sum by (service_name) (rate(http_server_request_duration_seconds_count{s}[{w}]))"), m("rps", &[("by", json!("service_name"))])),
                q("errors.json", format!("sum by (service_name) (rate(http_server_request_duration_seconds_count{{{se}http_response_status_code=~\"5..\"}}[{w}])) / sum by (service_name) (rate(http_server_request_duration_seconds_count{s}[{w}]))"), m("errorRate", &[("by", json!("service_name")), ("unit", json!("ratio"))])),
                q("p99.json", format!("histogram_quantile(0.99, sum by (service_name, le) (rate(http_server_request_duration_seconds_bucket{s}[{w}])))"), m("p99Ms", &[("by", json!("service_name")), ("unit", json!("s"))])),
                q("endpoint-rps.json", format!("sum by (service_name, http_route, http_request_method) (rate(http_server_request_duration_seconds_count{es}[{w}]))"), m("rps", &ep(None))),
                q("endpoint-p99.json", format!("histogram_quantile(0.99, sum by (service_name, http_route, http_request_method, le) (rate(http_server_request_duration_seconds_bucket{es}[{w}])))"), m("p99Ms", &ep(Some("s")))),
                q("endpoint-mean.json", format!("sum by (service_name, http_route, http_request_method) (rate(http_server_request_duration_seconds_sum{es}[{w}])) / sum by (service_name, http_route, http_request_method) (rate(http_server_request_duration_seconds_count{es}[{w}]))"), m("meanMs", &ep(Some("s")))),
            ]
        }
        "spring" => {
            let base = join(&["uri!~\"/actuator.*\"", &ns_matcher(&o.namespaces), sel]);
            let by = "application, job";
            let se = if entry.is_empty() { base.clone() } else { format!("{},application=~\"{}\"", base, entry.iter().map(|e| esc_alt(e)).collect::<Vec<_>>().join("|")) };
            let ep = |pre: &[(&'static str, Value)], post: &[(&'static str, Value)]| -> Vec<(&'static str, Value)> {
                let mut x: Vec<(&'static str, Value)> = pre.to_vec();
                x.extend([("by", json!("application")), ("endpointBy", json!("uri")), ("methodBy", json!("method")), ("template", json!(true))]);
                x.extend(post.iter().cloned());
                x
            };
            let mut v = vec![
                q("rps.json", format!("sum by ({by}) (rate(http_server_requests_seconds_count{{{base}}}[{w}]))"), m("rps", &[("by", json!("application"))])),
                q("errors.json", format!("(sum by ({by}) (rate(http_server_requests_seconds_count{{{base},status=~\"5..\"}}[{w}])) or sum by ({by}) (rate(http_server_requests_seconds_count{{{base}}}[{w}])) * 0) / sum by ({by}) (rate(http_server_requests_seconds_count{{{base}}}[{w}]))"), m("errorRate", &[("unit", json!("ratio")), ("by", json!("application"))])),
                q("p99.json", format!("histogram_quantile(0.99, sum by ({by}, le) (rate(http_server_requests_seconds_bucket{{{base}}}[{w}])))"), m("p99Ms", &[("unit", json!("s")), ("by", json!("application"))])),
                q("mean.json", format!("sum by ({by}) (rate(http_server_requests_seconds_sum{{{base}}}[{w}])) / sum by ({by}) (rate(http_server_requests_seconds_count{{{base}}}[{w}]))"), m("meanMs", &[("unit", json!("s")), ("by", json!("application"))])),
            ];
            if !entry.is_empty() {
                v.push(q("endpoint-rps.json", format!("sum by ({by}, uri, method) (rate(http_server_requests_seconds_count{{{se}}}[{w}]))"), m("rps", &ep(&[], &[]))));
                v.push(q("endpoint-latency.json", format!("sum by ({by}, uri, method, le) (rate(http_server_requests_seconds_bucket{{{se}}}[{w}]))"), m("p99Ms", &ep(&[("unit", json!("s"))], &[("combine", json!("histogram"))]))));
                v.push(q("endpoint-mean.json", format!("label_replace(sum by ({by}, uri, method) (rate(http_server_requests_seconds_sum{{{se}}}[{w}])), \"part\", \"num\", \"\", \"\") or label_replace(sum by ({by}, uri, method) (rate(http_server_requests_seconds_count{{{se}}}[{w}])), \"part\", \"den\", \"\", \"\")"), m("meanMs", &ep(&[("unit", json!("s"))], &[("combine", json!("ratio"))]))));
            }
            v
        }
        "ingress-nginx" => {
            let ns = if o.namespaces.is_empty() { String::new() } else { ns_matcher(&o.namespaces).replacen("namespace=", "exported_namespace=", 1) };
            let s = join(&["exported_service!=\"\"", &ns, sel]);
            let by = "exported_service";
            let mm = |extra: &[(&'static str, Value)]| -> Vec<(&'static str, Value)> {
                let mut x: Vec<(&'static str, Value)> = extra.to_vec();
                x.extend([("by", json!(by)), ("edge", json!(true))]);
                x
            };
            vec![
                q("rps.json", format!("sum by ({by}) (rate(nginx_ingress_controller_requests{{{s}}}[{w}]))"), m("rps", &mm(&[]))),
                q("errors.json", format!("(sum by ({by}) (rate(nginx_ingress_controller_requests{{{s},status=~\"5..|499\"}}[{w}])) or sum by ({by}) (rate(nginx_ingress_controller_requests{{{s}}}[{w}])) * 0) / sum by ({by}) (rate(nginx_ingress_controller_requests{{{s}}}[{w}]))"), m("errorRate", &mm(&[("unit", json!("ratio"))]))),
                q("p99.json", format!("histogram_quantile(0.99, sum by ({by}, le) (rate(nginx_ingress_controller_request_duration_seconds_bucket{{{s}}}[{w}])))"), m("p99Ms", &mm(&[("unit", json!("s"))]))),
                q("mean.json", format!("sum by ({by}) (rate(nginx_ingress_controller_request_duration_seconds_sum{{{s}}}[{w}])) / sum by ({by}) (rate(nginx_ingress_controller_request_duration_seconds_count{{{s}}}[{w}]))"), m("meanMs", &mm(&[("unit", json!("s"))]))),
            ]
        }
        "istio" => {
            // what each workload served, as its own sidecar saw it; gRPC errors ride on a 200
            let ns = if o.namespaces.is_empty() { String::new() } else { ns_matcher(&o.namespaces).replacen("namespace=", "destination_workload_namespace=", 1) };
            let s = join(&["reporter=\"destination\"", &ns, sel]);
            let by = "destination_workload";
            let b = |extra: &[(&'static str, Value)]| -> Vec<(&'static str, Value)> {
                let mut x: Vec<(&'static str, Value)> = extra.to_vec();
                x.push(("by", json!(by)));
                x
            };
            let all = format!("sum by ({by}) (rate(istio_requests_total{{{s}}}[{w}]))");
            vec![
                q("rps.json", all.clone(), m("rps", &b(&[]))),
                q("errors.json", format!("((sum by ({by}) (rate(istio_requests_total{{{s},response_code=~\"5..\"}}[{w}])) or {all} * 0) + (sum by ({by}) (rate(istio_requests_total{{{s},response_code!~\"5..\",grpc_response_status=~\"2|4|8|12|13|14\"}}[{w}])) or {all} * 0)) / {all}"), m("errorRate", &b(&[("unit", json!("ratio"))]))),
                q("p99.json", format!("histogram_quantile(0.99, sum by ({by}, le) (rate(istio_request_duration_milliseconds_bucket{{{s}}}[{w}])))"), m("p99Ms", &b(&[("unit", json!("ms"))]))),
                q("mean.json", format!("sum by ({by}) (rate(istio_request_duration_milliseconds_sum{{{s}}}[{w}])) / sum by ({by}) (rate(istio_request_duration_milliseconds_count{{{s}}}[{w}]))"), m("meanMs", &b(&[("unit", json!("ms"))]))),
            ]
        }
        "linkerd" => {
            // inbound: what each workload's proxy served (Deployments and StatefulSets alike)
            let s = join(&["direction=\"inbound\"", &ns_matcher(&o.namespaces), sel]);
            let wl = |expr: &str| format!("label_replace(label_replace({}, \"workload\", \"$1\", \"deployment\", \"(.+)\"), \"workload\", \"$1\", \"statefulset\", \"(.+)\")", expr);
            let b = |extra: &[(&'static str, Value)]| -> Vec<(&'static str, Value)> {
                let mut x: Vec<(&'static str, Value)> = extra.to_vec();
                x.push(("by", json!("workload")));
                x
            };
            let all = format!("sum by (workload) ({})", wl(&format!("rate(response_total{{{s}}}[{w}])")));
            vec![
                q("rps.json", all.clone(), m("rps", &b(&[]))),
                q("errors.json", format!("(sum by (workload) ({}) or {all} * 0) / {all}", wl(&format!("rate(response_total{{{s},classification=\"failure\"}}[{w}])"))), m("errorRate", &b(&[("unit", json!("ratio"))]))),
                q("p99.json", format!("histogram_quantile(0.99, sum by (workload, le) ({}))", wl(&format!("rate(response_latency_ms_bucket{{{s}}}[{w}])"))), m("p99Ms", &b(&[("unit", json!("ms"))]))),
                q("mean.json", format!("sum by (workload) ({}) / sum by (workload) ({})", wl(&format!("rate(response_latency_ms_sum{{{s}}}[{w}])")), wl(&format!("rate(response_latency_ms_count{{{s}}}[{w}])"))), m("meanMs", &b(&[("unit", json!("ms"))]))),
            ]
        }
        "cadvisor" => {
            let by = "container_label_com_docker_compose_service";
            let s = if sel.is_empty() { String::new() } else { format!("{{{}}}", sel) };
            let b = [("by", json!(by))];
            vec![
                q("cpu.json", format!("sum by ({by}) (rate(container_cpu_usage_seconds_total{s}[{w}]))"), m("cpuCores", &b)),
                q("cpu-limit.json", format!("max by ({by}) (container_spec_cpu_quota{s} / container_spec_cpu_period{s})"), m("cpuLimitCores", &b)),
                q("replicas.json", format!("count by ({by}) (container_memory_working_set_bytes{s})"), m("replicas", &b)),
                q("net-tx.json", format!("sum by ({by}) (rate(container_network_transmit_bytes_total{s}[{w}]))"), m("netTxBps", &b)),
                q("memory.json", format!("sum by ({by}) (container_memory_working_set_bytes{s})"), m("memoryBytes", &b)),
                q("memory-max.json", format!("max by ({by}) (max_over_time(container_memory_working_set_bytes{s}[{w}]))"), m("memoryMaxBytes", &b)),
                q("memory-limit.json", format!("max by ({by}) (container_spec_memory_limit_bytes{s} > 0 < 2^50)"), m("memoryLimitBytes", &b)),
            ]
        }
        "kubernetes" => {
            let pod = join(&["pod!=\"\"", &ns_matcher(&o.namespaces), sel]);
            let ctr = ["container!=\"\"", "container!=\"POD\"", &pod].join(",");
            let pod_sum = |metric: &str, resource: &str| format!("sum by (namespace, pod, workload) ({})", workload(&format!("{}{{resource=\"{}\",{}}}", metric, resource, pod)));
            let per_pod = |metric: &str| pod_sum(metric, "cpu");
            let b = [("by", json!("workload"))];
            vec![
                q("cpu.json", format!("sum by (workload) ({})", workload(&format!("rate(container_cpu_usage_seconds_total{{{ctr}}}[{w}])"))), m("cpuCores", &b)),
                q("cpu-limit.json", format!("max by (workload) ({}) or max by (workload) ({})", per_pod("kube_pod_container_resource_limits"), per_pod("kube_pod_container_resource_requests")), m("cpuLimitCores", &b)),
                q("replicas.json", format!("count by (workload) ({})", workload(&format!("kube_pod_status_ready{{condition=\"true\",{pod}}} == 1"))), m("replicas", &b)),
                q("net-tx.json", format!("sum by (workload) ({})", workload(&format!("rate(container_network_transmit_bytes_total{{{pod}}}[{w}])"))), m("netTxBps", &b)),
                q("memory.json", format!("sum by (workload) ({})", workload(&format!("container_memory_working_set_bytes{{{ctr}}}"))), m("memoryBytes", &b)),
                q("memory-max.json", format!("max by (workload) ({})", workload(&format!("max_over_time(container_memory_working_set_bytes{{{ctr}}}[{w}])"))), m("memoryMaxBytes", &b)),
                q("memory-limit.json", format!("max by (workload) ({})", workload(&format!("kube_pod_container_resource_limits{{resource=\"memory\",{pod}}}"))), m("memoryLimitBytes", &b)),
                q("cpu-request.json", format!("max by (workload) ({})", pod_sum("kube_pod_container_resource_requests", "cpu")), m("cpuRequestCores", &b)),
                q("memory-request.json", format!("max by (workload) ({})", pod_sum("kube_pod_container_resource_requests", "memory")), m("memoryRequestBytes", &b)),
                q("cluster-nodes.json", format!("count(kube_node_info {WORKERS})"), m("clusterNodes", &[])),
                q("cluster-node-cpu.json", format!("avg(kube_node_status_allocatable{{resource=\"cpu\"}} {WORKERS})"), m("clusterNodeCpu", &[])),
                q("cluster-node-memory.json", format!("avg(kube_node_status_allocatable{{resource=\"memory\"}} {WORKERS})"), m("clusterNodeMemoryBytes", &[])),
                q("cluster-requested-cpu.json", format!("sum((kube_pod_container_resource_requests{{resource=\"cpu\"}} {WORKERS}) and on (namespace, pod) (kube_pod_status_phase{{phase=\"Running\"}} == 1))"), m("clusterRequestedCpu", &[])),
                q("cluster-requested-memory.json", format!("sum((kube_pod_container_resource_requests{{resource=\"memory\"}} {WORKERS}) and on (namespace, pod) (kube_pod_status_phase{{phase=\"Running\"}} == 1))"), m("clusterRequestedMemoryBytes", &[])),
                q("throttled.json", format!("sum by (workload) ({}) / sum by (workload) ({})", workload(&format!("rate(container_cpu_cfs_throttled_periods_total{{{ctr}}}[{w}])")), workload(&format!("rate(container_cpu_cfs_periods_total{{{ctr}}}[{w}])"))), m("cpuThrottled", &[("by", json!("workload")), ("unit", json!("ratio"))])),
            ]
        }
        _ => return None,
    })
}

#[derive(Clone, Debug)]
pub struct PlanItem {
    pub preset: String,
    pub query: Query,
}

/// the queries of the named presets, each file named <preset>-<file>
pub fn export_plan(presets: &[String], o: &Opts) -> Result<Vec<PlanItem>, String> {
    let mut out = vec![];
    for p in presets {
        let qs = preset(p, o).ok_or_else(|| format!("unknown preset \"{}\" — one of {}", p, PRESET_IDS.join(", ")))?;
        for mut q in qs {
            q.file = format!("{}-{}", p, q.file);
            out.push(PlanItem { preset: p.clone(), query: q });
        }
    }
    Ok(out)
}

/// pods per node per workload, at one instant: which replicas a node failure takes with it
pub fn pods_by_node_query(namespaces: &[String]) -> String {
    format!("count by (workload, node) ({})", workload(&format!("kube_pod_info{{{}}}", join(&["pod!=\"\"", "node!=\"\"", &ns_matcher(namespaces)]))))
}

/// the zone of a node from its provider id: AWS aws:///us-east-1a/i-…, GCP gce://project/us-central1-a/name
pub fn zone_of_provider_id(id: Option<&str>) -> Option<String> {
    let id = id?;
    let aws = regex_lite::Regex::new(r"^aws:///([a-z]{2}-[a-z]+-\d[a-z])/").ok()?;
    if let Some(c) = aws.captures(id) {
        return Some(c[1].to_string());
    }
    let gce = regex_lite::Regex::new(r"^gce://[^/]+/([a-z]+-[a-z]+\d-[a-z])/").ok()?;
    gce.captures(id).map(|c| c[1].to_string())
}

/// the `metrics:` block of an import manifest for an export plan
pub fn manifest_metrics(plan: &[PlanItem], dir: &str) -> Vec<Value> {
    plan.iter()
        .map(|p| {
            let mut o = JMap::new();
            o.insert("prometheus".into(), json!(format!("{}/{}", dir, p.query.file)));
            if let Value::Object(mm) = &p.query.mapping {
                for (k, v) in mm {
                    o.insert(k.clone(), v.clone());
                }
            }
            Value::Object(o)
        })
        .collect()
}

/// application/x-www-form-urlencoded, as URLSearchParams writes it
pub fn form_encode(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => o.push(b as char),
            b' ' => o.push('+'),
            _ => o.push_str(&format!("%{:02X}", b)),
        }
    }
    o
}
