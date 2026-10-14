//! The calibrated model (src/backtest/model.ts), read and written in the same JSON shape.

use crate::types::Map;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

/// a required number JSON may carry as null or leave out: null reads as 0, as JavaScript arithmetic does
pub fn num<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    Ok(Option::<f64>::deserialize(d)?.unwrap_or(0.0))
}
/// JSON has no Infinity: an unbounded capacity is written as null (reviveModel)
fn inf<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    Ok(Option::<f64>::deserialize(d)?.unwrap_or(f64::INFINITY))
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Slo {
    #[serde(deserialize_with = "num", default)]
    pub p99_ms: f64,
    #[serde(deserialize_with = "num", default)]
    pub error_rate: f64,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct FitQuality {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_mape: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p99_mape: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_mape: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_r2: Option<f64>,
    #[serde(deserialize_with = "num", default)]
    pub samples: f64,
    #[serde(default)]
    pub notes: Vec<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Throttle {
    pub knee: f64,
    pub at_zero: f64,
    pub growth: f64,
    pub r2: f64,
    pub seen_to: f64,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Capacity {
    pub limit: String,
    #[serde(deserialize_with = "num", default)]
    pub servers: f64,
    #[serde(deserialize_with = "inf", default)]
    pub per_replica_rps: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub band: Option<[f64; 2]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub samples: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overloaded_rps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub throttle: Option<Throttle>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MemoryModel {
    #[serde(deserialize_with = "num", default)]
    pub base: f64,
    #[serde(deserialize_with = "num", default)]
    pub per_req: f64,
    #[serde(deserialize_with = "num", default)]
    pub spike: f64,
    /// null where NaN was written out
    #[serde(default)]
    pub peak: Option<f64>,
    pub limit: Option<f64>,
    #[serde(deserialize_with = "num", default)]
    pub r2: f64,
    #[serde(default)]
    pub seen_to: Option<f64>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CpuModel {
    #[serde(deserialize_with = "num", default)]
    pub base: f64,
    #[serde(deserialize_with = "num", default)]
    pub per_req: f64,
    #[serde(deserialize_with = "num", default)]
    pub r2: f64,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Requests {
    #[serde(deserialize_with = "num", default)]
    pub cpu: f64,
    #[serde(deserialize_with = "num", default)]
    pub memory_gb: f64,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Hpa {
    pub min: f64,
    pub max: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_cpu: Option<f64>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SelfTime {
    #[serde(deserialize_with = "num", default)]
    pub mean: f64,
    #[serde(deserialize_with = "num", default)]
    pub p99: f64,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
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

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
pub struct Placement {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ServiceModel {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hosted_by: Option<String>,
    #[serde(deserialize_with = "num", default)]
    pub replicas: f64,
    pub cpu_limit: Option<f64>,
    pub memory_gb: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory: Option<MemoryModel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requests: Option<Requests>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pods: Option<Map<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hpa: Option<Hpa>,
    pub cpu: Option<CpuModel>,
    pub capacity: Capacity,
    #[serde(rename = "self")]
    pub self_time: SelfTime,
    #[serde(deserialize_with = "num", default)]
    pub tail: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variability: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load_exponent: Option<f64>,
    pub cost: CostModel,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placement: Option<Placement>,
    #[serde(default)]
    pub fit: FitQuality,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Stall {
    pub service: String,
    #[serde(deserialize_with = "num", default)]
    pub limit: f64,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EndpointModel {
    #[serde(default)]
    pub id: String,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_p50_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_p90_ms: Option<f64>,
    #[serde(deserialize_with = "num", default)]
    pub tail: f64,
    #[serde(deserialize_with = "num", default)]
    pub error_rate: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_slope: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stalls: Option<Vec<Stall>>,
    pub bytes: Map<f64>,
    #[serde(deserialize_with = "num", default)]
    pub egress_bytes: f64,
    pub slo: Slo,
    #[serde(default)]
    pub fit: FitQuality,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NodeModel {
    #[serde(deserialize_with = "num", default)]
    pub cpu: f64,
    #[serde(deserialize_with = "num", default)]
    pub memory_gb: f64,
    #[serde(deserialize_with = "num", default)]
    pub per_hour: f64,
    #[serde(default)]
    pub source: String,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OtherRequests {
    #[serde(deserialize_with = "num", default)]
    pub cpu: f64,
    #[serde(deserialize_with = "num", default)]
    pub memory_gb: f64,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClusterModel {
    pub node: NodeModel,
    #[serde(deserialize_with = "num", default)]
    pub nodes: f64,
    #[serde(deserialize_with = "num", default)]
    pub min_nodes: f64,
    #[serde(deserialize_with = "num", default)]
    pub max_nodes: f64,
    pub autoscaled: bool,
    #[serde(deserialize_with = "num", default)]
    pub packing: f64,
    pub other: OtherRequests,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provision_s: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zones: Option<Map<String>>,
    #[serde(default)]
    pub notes: Vec<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FittedOn {
    pub start: f64,
    pub end: f64,
    pub step_s: f64,
    pub buckets: f64,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrafficSummary {
    pub mean: f64,
    pub p90: f64,
    pub peak: f64,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TransferPrices {
    #[serde(deserialize_with = "num", default)]
    pub cross_zone_gb: f64,
    #[serde(deserialize_with = "num", default)]
    pub cross_region_gb: f64,
    #[serde(deserialize_with = "num", default)]
    pub internet_gb: f64,
    #[serde(default)]
    pub source: String,
}

impl TransferPrices {
    pub fn aws() -> Self {
        TransferPrices {
            cross_zone_gb: 0.01,
            cross_region_gb: 0.02,
            internet_gb: 0.09,
            source: "https://aws.amazon.com/ec2/pricing/on-demand/#Data_Transfer (us-east-1: $0.01/GB each way between AZs, $0.02/GB between regions, $0.09/GB out to the internet, first 10 TB)".into(),
        }
    }
    pub fn plan(&self) -> crate::types::Transfer {
        crate::types::Transfer { cross_zone_gb: self.cross_zone_gb, cross_region_gb: self.cross_region_gb, internet_gb: self.internet_gb, source: Some(self.source.clone()) }
    }
}

/// the accuracy records stay as they were written (they may hold Infinity, which JSON values can't):
/// skipped on the way in from JavaScript, written back as an empty list by calibration
#[derive(Clone, Debug, Default)]
pub struct Accuracy(pub Value);
impl Serialize for Accuracy {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match &self.0 {
            Value::Null => Vec::<Value>::new().serialize(s),
            v => v.serialize(s),
        }
    }
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    #[serde(default = "one")]
    pub version: f64,
    pub name: String,
    #[serde(deserialize_with = "num", default)]
    pub timeout_ms: f64,
    pub slo: Slo,
    pub services: Map<ServiceModel>,
    pub endpoints: Map<EndpointModel>,
    pub transfer: TransferPrices,
    #[serde(deserialize_with = "num", default)]
    pub unattributed_per_hour: f64,
    #[serde(skip_deserializing)]
    pub accuracy: Accuracy,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fitted_on: Option<FittedOn>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub traffic: Option<TrafficSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cluster: Option<ClusterModel>,
}
fn one() -> f64 {
    1.0
}
