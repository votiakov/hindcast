//! The calibrated model and the dataset (src/backtest/model.ts, dataset.ts): the fields the backtest
//! reads, the rest carried through untouched.

use crate::types::{Map, Num};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

/// a required number JSON may carry as null or leave out: null reads as 0, as JavaScript arithmetic does
pub fn num<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    Ok(Option::<f64>::deserialize(d)?.unwrap_or(0.0))
}
/// JSON has no Infinity: an unbounded capacity is written as null (reviveModel)
fn inf<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    Ok(Option::<f64>::deserialize(d)?.unwrap_or(f64::INFINITY))
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Slo {
    #[serde(deserialize_with = "num", default)]
    pub p99_ms: f64,
    #[serde(deserialize_with = "num", default)]
    pub error_rate: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Capacity {
    pub limit: String,
    #[serde(deserialize_with = "num", default)]
    pub servers: f64,
    #[serde(deserialize_with = "inf", default)]
    pub per_replica_rps: f64,
    pub samples: Option<Vec<f64>>,
    pub overloaded_rps: Option<f64>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MemoryModel {
    #[serde(deserialize_with = "num", default)]
    pub base: f64,
    #[serde(deserialize_with = "num", default)]
    pub per_req: f64,
    #[serde(deserialize_with = "num", default)]
    pub spike: f64,
    #[serde(deserialize_with = "num", default)]
    pub peak: f64,
    pub limit: Option<f64>,
    pub seen_to: Option<f64>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CpuModel {
    #[serde(deserialize_with = "num", default)]
    pub base: f64,
    #[serde(deserialize_with = "num", default)]
    pub per_req: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Requests {
    #[serde(deserialize_with = "num", default)]
    pub cpu: f64,
    #[serde(deserialize_with = "num", default)]
    pub memory_gb: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SelfTime {
    #[serde(deserialize_with = "num", default)]
    pub mean: f64,
    #[serde(deserialize_with = "num", default)]
    pub p99: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CostModel {
    #[serde(deserialize_with = "num", default)]
    pub per_replica_hour: f64,
    #[serde(deserialize_with = "num", default)]
    pub per_request: f64,
    #[serde(deserialize_with = "num", default)]
    pub cpu_share: f64,
    pub arch: String,
    pub source: String,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct Placement {
    pub zone: Option<String>,
    pub region: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ServiceModel {
    pub hosted_by: Option<String>,
    #[serde(deserialize_with = "num", default)]
    pub replicas: f64,
    pub cpu_limit: Option<f64>,
    pub memory_gb: Option<f64>,
    pub memory: Option<MemoryModel>,
    pub requests: Option<Requests>,
    pub pods: Option<Map<f64>>,
    pub cpu: Option<CpuModel>,
    pub capacity: Capacity,
    #[serde(rename = "self")]
    pub self_time: SelfTime,
    #[serde(deserialize_with = "num", default)]
    pub tail: f64,
    pub variability: Option<f64>,
    pub load_exponent: Option<f64>,
    pub cost: CostModel,
    pub placement: Option<Placement>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Stall {
    pub service: String,
    #[serde(deserialize_with = "num", default)]
    pub limit: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EndpointModel {
    pub service: String,
    #[serde(deserialize_with = "num", default)]
    pub share: f64,
    pub visits: Map<f64>,
    pub calls: Map<f64>,
    pub weights: Map<f64>,
    #[serde(deserialize_with = "num", default)]
    pub overhead_ms: f64,
    #[serde(deserialize_with = "num", default)]
    pub base_excess_ms: f64,
    pub base_p50_ms: Option<f64>,
    pub base_p90_ms: Option<f64>,
    #[serde(deserialize_with = "num", default)]
    pub tail: f64,
    #[serde(deserialize_with = "num", default)]
    pub error_rate: f64,
    pub error_slope: Option<f64>,
    pub stalls: Option<Vec<Stall>>,
    pub bytes: Map<f64>,
    #[serde(deserialize_with = "num", default)]
    pub egress_bytes: f64,
    pub slo: Slo,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NodeModel {
    #[serde(deserialize_with = "num", default)]
    pub cpu: f64,
    #[serde(deserialize_with = "num", default)]
    pub memory_gb: f64,
    #[serde(deserialize_with = "num", default)]
    pub per_hour: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OtherRequests {
    #[serde(deserialize_with = "num", default)]
    pub cpu: f64,
    #[serde(deserialize_with = "num", default)]
    pub memory_gb: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClusterModel {
    pub node: NodeModel,
    #[serde(deserialize_with = "num", default)]
    pub nodes: f64,
    #[serde(deserialize_with = "num", default)]
    pub max_nodes: f64,
    pub autoscaled: bool,
    #[serde(deserialize_with = "num", default)]
    pub packing: f64,
    pub other: OtherRequests,
    pub provision_s: Option<f64>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub name: String,
    #[serde(deserialize_with = "num", default)]
    pub timeout_ms: f64,
    pub slo: Slo,
    pub services: Map<ServiceModel>,
    pub endpoints: Map<EndpointModel>,
    pub transfer: crate::types::Transfer,
    #[serde(deserialize_with = "num", default)]
    pub unattributed_per_hour: f64,
    /// left on the JavaScript side (it may hold Infinity, which JSON values can't): the result
    /// carries a null in its place for the caller to fill
    #[serde(skip)]
    pub accuracy: Value,
    pub cluster: Option<ClusterModel>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct EndpointSeries {
    pub service: Option<String>,
    pub rps: Option<Vec<Num>>,
    pub error_rate: Option<Vec<Num>>,
    pub p99_ms: Option<Vec<Num>>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServiceSeries {
    pub rps: Option<Vec<Num>>,
    pub replicas: Option<Vec<Num>>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BillComponent {
    pub series: Option<Vec<Num>>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Bill {
    #[serde(deserialize_with = "num", default)]
    pub start: f64,
    #[serde(deserialize_with = "num", default)]
    pub end: f64,
    pub components: Map<BillComponent>,
    #[serde(deserialize_with = "num", default)]
    pub unattributed: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Dataset {
    #[serde(deserialize_with = "num", default)]
    pub start: f64,
    #[serde(deserialize_with = "num", default)]
    pub step_s: f64,
    #[serde(deserialize_with = "num", default)]
    pub n: f64,
    pub services: Map<ServiceSeries>,
    pub endpoints: Map<EndpointSeries>,
    pub bill: Option<Bill>,
}
