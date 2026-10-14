//! Raw (time, value) points per series, averaged into grid buckets (src/backtest/dataset.ts
//! DatasetBuilder). Points keep the order they arrived in, so the sums match the TypeScript ones.

use crate::dataset::{ClusterSeries, Dataset, EndpointSeries, ServiceSeries};
use crate::types::{Map, Num};
use indexmap::{IndexMap, IndexSet};

type Points = IndexMap<u64, (f64, f64)>;

fn add(p: &mut Points, t: f64, v: f64) {
    let e = p.entry(t.to_bits()).or_insert((0.0, 0.0));
    e.0 += v;
    e.1 += 1.0;
}

#[derive(Default)]
pub struct DatasetBuilder {
    svc: IndexMap<String, IndexMap<String, Points>>,
    ep: IndexMap<String, (String, IndexMap<String, Points>)>,
    cl: IndexMap<String, Points>,
    pub sources: Vec<String>,
    pub min_t: f64,
    pub max_t: f64,
    /// (service, metric) measured at the edge: those replace what span metrics or traces said
    edge: IndexSet<String>,
    pub edge_services: IndexSet<String>,
}

pub const SERVICE_METRICS: [&str; 20] = ["rps", "doneRps", "errorRate", "p50Ms", "p95Ms", "p99Ms", "meanMs", "selfMeanMs", "selfP99Ms", "cpuCores", "cpuLimitCores", "replicas", "netTxBps", "netRxBps", "memoryBytes", "memoryMaxBytes", "memoryLimitBytes", "cpuRequestCores", "memoryRequestBytes", "cpuThrottled"];
pub const CLUSTER_METRICS: [&str; 5] = ["clusterNodes", "clusterNodeCpu", "clusterNodeMemoryBytes", "clusterRequestedCpu", "clusterRequestedMemoryBytes"];

impl DatasetBuilder {
    pub fn new() -> Self {
        DatasetBuilder { min_t: f64::INFINITY, max_t: f64::NEG_INFINITY, ..Default::default() }
    }

    pub fn add_service(&mut self, service: &str, metric: &str, t: f64, v: f64, edge: bool) {
        if !v.is_finite() || !t.is_finite() {
            return;
        }
        let key = format!("{}\u{0}{}", service, metric);
        if edge && !self.edge.contains(&key) {
            self.edge.insert(key);
            self.edge_services.insert(service.to_string());
            if let Some(m) = self.svc.get_mut(service) {
                m.shift_remove(metric);
            }
        } else if !edge && self.edge.contains(&key) {
            return;
        }
        let m = self.svc.entry(service.to_string()).or_default();
        add(m.entry(metric.to_string()).or_default(), t, v);
        self.min_t = self.min_t.min(t);
        self.max_t = self.max_t.max(t);
    }

    pub fn add_cluster(&mut self, metric: &str, t: f64, v: f64) {
        if !v.is_finite() || !t.is_finite() {
            return;
        }
        add(self.cl.entry(metric.to_string()).or_default(), t, v);
    }

    pub fn add_endpoint(&mut self, endpoint: &str, service: &str, metric: &str, t: f64, v: f64) {
        if !v.is_finite() || !t.is_finite() {
            return;
        }
        let e = self.ep.entry(endpoint.to_string()).or_insert_with(|| (service.to_string(), IndexMap::new()));
        add(e.1.entry(metric.to_string()).or_default(), t, v);
        self.min_t = self.min_t.min(t);
        self.max_t = self.max_t.max(t);
    }

    pub fn services(&self) -> Vec<String> {
        self.svc.keys().cloned().collect()
    }

    pub fn has_service(&self, service: &str, metric: &str) -> bool {
        self.svc.get(service).map(|m| m.contains_key(metric)).unwrap_or(false)
    }

    pub fn has(&self, metric: &str) -> bool {
        self.svc.values().any(|m| m.contains_key(metric))
    }

    pub fn build(&self, name: &str, step_s: Option<f64>, start: Option<f64>, end: Option<f64>) -> Result<Dataset, String> {
        if !self.min_t.is_finite() {
            return Err("no data points were imported".into());
        }
        let mut times: Vec<f64> = vec![];
        let mut seen = std::collections::HashSet::new();
        for m in self.svc.values() {
            for s in m.values() {
                for t in s.keys() {
                    if seen.insert(*t) {
                        times.push(f64::from_bits(*t));
                    }
                }
            }
        }
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mut native = f64::INFINITY;
        for i in 1..times.len() {
            if times[i] - times[i - 1] > 0.0 {
                native = native.min(times[i] - times[i - 1]);
            }
        }
        let step = step_s.unwrap_or(if native.is_finite() { native.max(1.0) } else { 60.0 });
        let start = (start.unwrap_or(self.min_t) / step).floor() * step;
        let end = end.unwrap_or(self.max_t);
        let n = (((end - start) / step).floor() + 1.0).max(1.0) as usize;
        let grid = |src: &Points| -> Vec<Num> {
            let mut acc = vec![(0.0, 0.0); n];
            for (t, p) in src {
                let i = ((f64::from_bits(*t) - start) / step).floor();
                if i < 0.0 || i >= n as f64 {
                    continue;
                }
                let a = &mut acc[i as usize];
                a.0 += p.0;
                a.1 += p.1;
            }
            acc.into_iter().map(|a| if a.1 != 0.0 { Some(a.0 / a.1) } else { None }).collect()
        };
        let mut services: Map<ServiceSeries> = Map::new();
        for (id, m) in &self.svc {
            let mut o = ServiceSeries::default();
            for (metric, pts) in m {
                set_service(&mut o, metric, grid(pts));
            }
            services.insert(id.clone(), o);
        }
        let mut endpoints: Map<EndpointSeries> = Map::new();
        for (id, (service, m)) in &self.ep {
            let mut o = EndpointSeries { service: service.clone(), ..Default::default() };
            for (metric, pts) in m {
                let g = Some(grid(pts));
                match metric.as_str() {
                    "rps" => o.rps = g,
                    "errorRate" => o.error_rate = g,
                    "p50Ms" => o.p50_ms = g,
                    "p99Ms" => o.p99_ms = g,
                    "meanMs" => o.mean_ms = g,
                    _ => {}
                }
            }
            endpoints.insert(id.clone(), o);
        }
        let cluster = if self.cl.is_empty() {
            None
        } else {
            let mut o = ClusterSeries::default();
            for (metric, pts) in &self.cl {
                let g = Some(grid(pts));
                match metric.as_str() {
                    "clusterNodes" => o.cluster_nodes = g,
                    "clusterNodeCpu" => o.cluster_node_cpu = g,
                    "clusterNodeMemoryBytes" => o.cluster_node_memory_bytes = g,
                    "clusterRequestedCpu" => o.cluster_requested_cpu = g,
                    "clusterRequestedMemoryBytes" => o.cluster_requested_memory_bytes = g,
                    _ => {}
                }
            }
            Some(o)
        };
        Ok(Dataset { version: 1.0, name: name.to_string(), start, step_s: step, n: n as f64, services, endpoints, cluster, sources: self.sources.clone(), ..Default::default() })
    }
}

/// a service series by its metric name
pub fn set_service(o: &mut ServiceSeries, metric: &str, v: Vec<Num>) {
    let v = Some(v);
    match metric {
        "rps" => o.rps = v,
        "doneRps" => o.done_rps = v,
        "errorRate" => o.error_rate = v,
        "p50Ms" => o.p50_ms = v,
        "p95Ms" => o.p95_ms = v,
        "p99Ms" => o.p99_ms = v,
        "meanMs" => o.mean_ms = v,
        "selfMeanMs" => o.self_mean_ms = v,
        "selfP99Ms" => o.self_p99_ms = v,
        "cpuCores" => o.cpu_cores = v,
        "cpuLimitCores" => o.cpu_limit_cores = v,
        "replicas" => o.replicas = v,
        "netTxBps" => o.net_tx_bps = v,
        "netRxBps" => o.net_rx_bps = v,
        "memoryBytes" => o.memory_bytes = v,
        "memoryMaxBytes" => o.memory_max_bytes = v,
        "memoryLimitBytes" => o.memory_limit_bytes = v,
        "cpuRequestCores" => o.cpu_request_cores = v,
        "memoryRequestBytes" => o.memory_request_bytes = v,
        "cpuThrottled" => o.cpu_throttled = v,
        _ => {}
    }
}
