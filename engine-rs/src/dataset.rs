//! The telemetry dataset (src/backtest/dataset.ts): everything learned from real files, on one regular
//! time grid. Missing values are null, never 0: "no data" and "no traffic" stay distinguishable.

use crate::model::{num, Hpa, Placement, Slo};
use crate::types::{Map, Num};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServiceSeries {
    /// the order the series were first seen in (an importer's); written in that order, the rest after
    #[serde(skip)]
    pub order: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rps: Option<Vec<Num>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done_rps: Option<Vec<Num>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_rate: Option<Vec<Num>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p50_ms: Option<Vec<Num>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p95_ms: Option<Vec<Num>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p99_ms: Option<Vec<Num>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mean_ms: Option<Vec<Num>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub self_mean_ms: Option<Vec<Num>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub self_p99_ms: Option<Vec<Num>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_cores: Option<Vec<Num>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_limit_cores: Option<Vec<Num>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replicas: Option<Vec<Num>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub net_tx_bps: Option<Vec<Num>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub net_rx_bps: Option<Vec<Num>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_bytes: Option<Vec<Num>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_max_bytes: Option<Vec<Num>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_limit_bytes: Option<Vec<Num>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_request_cores: Option<Vec<Num>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_request_bytes: Option<Vec<Num>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_throttled: Option<Vec<Num>>,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClusterSeries {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cluster_nodes: Option<Vec<Num>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cluster_node_cpu: Option<Vec<Num>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cluster_node_memory_bytes: Option<Vec<Num>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cluster_requested_cpu: Option<Vec<Num>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cluster_requested_memory_bytes: Option<Vec<Num>>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct EndpointSeries {
    #[serde(skip)]
    pub order: Vec<String>,
    #[serde(default)]
    pub service: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rps: Option<Vec<Num>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_rate: Option<Vec<Num>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p50_ms: Option<Vec<Num>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p99_ms: Option<Vec<Num>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mean_ms: Option<Vec<Num>>,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServiceShape {
    #[serde(deserialize_with = "num", default)]
    pub spans: f64,
    #[serde(deserialize_with = "num", default)]
    pub self_mean_ms: f64,
    #[serde(deserialize_with = "num", default)]
    pub self_p50_ms: f64,
    #[serde(deserialize_with = "num", default)]
    pub self_p99_ms: f64,
    #[serde(deserialize_with = "num", default)]
    pub mean_ms: f64,
    #[serde(deserialize_with = "num", default)]
    pub p99_ms: f64,
    #[serde(default)]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_spans_per_visit: Option<f64>,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct EndpointShape {
    #[serde(default)]
    pub service: String,
    #[serde(deserialize_with = "num", default)]
    pub traces: f64,
    #[serde(default)]
    pub calls: Map<f64>,
    #[serde(default)]
    pub visits: Map<f64>,
    #[serde(default)]
    pub critical_ms: Map<f64>,
    #[serde(deserialize_with = "num", default)]
    pub mean_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p50_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p90_ms: Option<f64>,
    #[serde(deserialize_with = "num", default)]
    pub p99_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub low_mean_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub low_p50_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub low_p90_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub low_p99_ms: Option<f64>,
    #[serde(default)]
    pub bytes: Map<f64>,
    #[serde(deserialize_with = "num", default)]
    pub error_rate: f64,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Topology {
    #[serde(default)]
    pub services: Map<ServiceShape>,
    #[serde(default)]
    pub edges: Value,
    #[serde(default)]
    pub endpoints: Map<EndpointShape>,
    #[serde(deserialize_with = "num", default)]
    pub start: f64,
    #[serde(deserialize_with = "num", default)]
    pub end: f64,
    #[serde(deserialize_with = "num", default)]
    pub traces: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sampling: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate_corrected: Option<Map<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sampling_check: Option<f64>,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct BillComponent {
    #[serde(deserialize_with = "num", default)]
    pub total: f64,
    #[serde(default)]
    pub by_category: Map<f64>,
    #[serde(default)]
    pub usage: Map<f64>,
    #[serde(default)]
    pub skus: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub series: Option<Vec<Num>>,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Bill {
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub currency: String,
    #[serde(deserialize_with = "num", default)]
    pub start: f64,
    #[serde(deserialize_with = "num", default)]
    pub end: f64,
    #[serde(deserialize_with = "num", default)]
    pub total: f64,
    pub components: Map<BillComponent>,
    #[serde(deserialize_with = "num", default)]
    pub unattributed: f64,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServiceHint {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub servers: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub per_replica_rps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arch: Option<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClusterHint {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_price_hour: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub autoscaled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provision_s: Option<f64>,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct EndpointHint {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slo: Option<Slo>,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Hints {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slo: Option<Slo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hosted_by: Option<Map<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub services: Option<Map<ServiceHint>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cluster: Option<ClusterHint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoints: Option<Map<EndpointHint>>,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Dataset {
    #[serde(default = "one")]
    pub version: f64,
    #[serde(default)]
    pub name: String,
    #[serde(deserialize_with = "num", default)]
    pub start: f64,
    #[serde(deserialize_with = "num", default)]
    pub step_s: f64,
    #[serde(deserialize_with = "num", default)]
    pub n: f64,
    #[serde(default)]
    pub services: Map<ServiceSeries>,
    #[serde(default)]
    pub endpoints: Map<EndpointSeries>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cluster: Option<ClusterSeries>,
    #[serde(default)]
    pub sources: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topology: Option<Topology>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bill: Option<Bill>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placement: Option<Map<Placement>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hints: Option<Hints>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pods_by_node: Option<Map<Map<f64>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_zones: Option<Map<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hpa: Option<Map<Hpa>>,
}
fn one() -> f64 {
    1.0
}

/// mean of the non-null, finite values
pub fn mean_of(a: Option<&Vec<Num>>) -> Option<f64> {
    let a = a?;
    let (mut s, mut k) = (0.0, 0usize);
    for v in a.iter().flatten() {
        if v.is_finite() {
            s += v;
            k += 1;
        }
    }
    if k > 0 {
        Some(s / k as f64)
    } else {
        None
    }
}

fn write_series<S: serde::Serializer>(s: S, head: Option<(&str, &String)>, all: &[(&'static str, &Option<Vec<Num>>)], order: &[String]) -> Result<S::Ok, S::Error> {
    use serde::ser::SerializeMap;
    let mut m = s.serialize_map(None)?;
    if let Some((k, v)) = head {
        m.serialize_entry(k, v)?;
    }
    for name in order {
        if let Some((k, Some(v))) = all.iter().find(|(k, _)| *k == name.as_str()) {
            m.serialize_entry(k, v)?;
        }
    }
    for (k, v) in all {
        if let Some(v) = v {
            if !order.iter().any(|o| o == k) {
                m.serialize_entry(k, v)?;
            }
        }
    }
    m.end()
}

impl Serialize for ServiceSeries {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let all = [
            ("rps", &self.rps),
            ("doneRps", &self.done_rps),
            ("errorRate", &self.error_rate),
            ("p50Ms", &self.p50_ms),
            ("p95Ms", &self.p95_ms),
            ("p99Ms", &self.p99_ms),
            ("meanMs", &self.mean_ms),
            ("selfMeanMs", &self.self_mean_ms),
            ("selfP99Ms", &self.self_p99_ms),
            ("cpuCores", &self.cpu_cores),
            ("cpuLimitCores", &self.cpu_limit_cores),
            ("replicas", &self.replicas),
            ("netTxBps", &self.net_tx_bps),
            ("netRxBps", &self.net_rx_bps),
            ("memoryBytes", &self.memory_bytes),
            ("memoryMaxBytes", &self.memory_max_bytes),
            ("memoryLimitBytes", &self.memory_limit_bytes),
            ("cpuRequestCores", &self.cpu_request_cores),
            ("memoryRequestBytes", &self.memory_request_bytes),
            ("cpuThrottled", &self.cpu_throttled),
        ];
        write_series(s, None, &all, &self.order)
    }
}

impl Serialize for EndpointSeries {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let all = [
            ("rps", &self.rps),
            ("errorRate", &self.error_rate),
            ("p50Ms", &self.p50_ms),
            ("p99Ms", &self.p99_ms),
            ("meanMs", &self.mean_ms),
        ];
        write_series(s, Some(("service", &self.service)), &all, &self.order)
    }
}
