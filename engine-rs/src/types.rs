//! The plan, traffic and result shapes of src/backtest/engine.ts, field for field. Maps keep their
//! insertion order: the replay sums over services and endpoints in that order, as the TypeScript
//! engine does, so both give the same numbers.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

pub type Map<T> = IndexMap<String, T>;
/// a series value that may be missing (`null` in JSON)
pub type Num = Option<f64>;

/// a required number that JSON may carry as null (NaN written out) or leave out: JavaScript
/// arithmetic reads null as 0, so the replay does too
fn num<'de, D: serde::Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    Ok(Option::<f64>::deserialize(d)?.unwrap_or(0.0))
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AutoscalePolicy {
    #[serde(default, deserialize_with = "num")]
    pub min: f64,
    #[serde(default, deserialize_with = "num")]
    pub max: f64,
    #[serde(default, deserialize_with = "num")]
    pub target: f64,
    #[serde(default, deserialize_with = "num")]
    pub warmup_s: f64,
    #[serde(default, deserialize_with = "num")]
    pub cooldown_s: f64,
    #[serde(default, deserialize_with = "num")]
    pub interval_s: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metric_window_s: Option<f64>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Fault {
    #[serde(default, deserialize_with = "num")]
    pub at: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<f64>,
    pub service: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capacity: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub down: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_rate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_scale_out: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warmup_factor: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replicas_lost: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// only this caller's calls to the service are hit (`errorRate` of them fail, all when unset): a
    /// client whose connection to it stays broken. The service itself, and its other callers, are untouched
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caller: Option<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Cpu {
    #[serde(default, deserialize_with = "num")]
    pub base: f64,
    #[serde(default, deserialize_with = "num")]
    pub per_req: f64,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    #[serde(default, deserialize_with = "num")]
    pub base: f64,
    #[serde(default, deserialize_with = "num")]
    pub per_req: f64,
    #[serde(default, deserialize_with = "num")]
    pub spike: f64,
    #[serde(default, deserialize_with = "num")]
    pub limit: f64,
    pub peak: Option<f64>,
    pub seen_to: Option<f64>,
    /// GB a container gains per request it serves until it restarts (a leak)
    #[serde(default, deserialize_with = "num")]
    pub leak: f64,
}

/// a JIT runtime's warm-up (a JVM, .NET): a pod that starts serves each request at `cold`× its warm
/// CPU cost until it has done `core_s` core-seconds of compilation. The compiler gets the CPU the
/// requests leave idle under the pod's limit, and `share` of the limit when they take it all: a
/// saturated pod barely warms, and stays slow because it is slow
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Warmup {
    pub runtime: String,
    #[serde(default, deserialize_with = "num")]
    pub cold: f64,
    #[serde(default, deserialize_with = "num")]
    pub core_s: f64,
    #[serde(default, deserialize_with = "num")]
    pub share: f64,
    /// "calibrated" from a pod start in the history, or "assumed" (the runtime's defaults)
    #[serde(default)]
    pub source: String,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Requests {
    #[serde(default, deserialize_with = "num")]
    pub cpu: f64,
    #[serde(default, deserialize_with = "num")]
    pub memory_gb: f64,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Cache {
    #[serde(default, deserialize_with = "num")]
    pub hit_rate: f64,
    #[serde(default, deserialize_with = "num")]
    pub latency_ms: f64,
    #[serde(default, deserialize_with = "num")]
    pub cost_per_hour: f64,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ServicePlan {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hosted_by: Option<String>,
    pub replicas: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_replicas: Option<Vec<Num>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub autoscale: Option<AutoscalePolicy>,
    #[serde(default, deserialize_with = "num")]
    pub per_replica_rps: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overloaded_rps: Option<f64>,
    #[serde(default, deserialize_with = "num")]
    pub servers: f64,
    #[serde(default, deserialize_with = "num")]
    pub self_mean: f64,
    #[serde(default, deserialize_with = "num")]
    pub self_p99: f64,
    #[serde(default, deserialize_with = "num")]
    pub tail: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variability: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load_exponent: Option<f64>,
    pub cpu: Option<Cpu>,
    pub cpu_limit: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory: Option<Memory>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requests: Option<Requests>,
    #[serde(default, deserialize_with = "num")]
    pub replica_hour: f64,
    #[serde(default, deserialize_with = "num")]
    pub per_request: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache: Option<Cache>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    /// a JIT runtime: pods that start during the replay (scale-outs, restarts, replacements) start cold
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warmup: Option<Warmup>,
    /// the change replaces the pods (a new pod template): they all start at the beginning of the replay
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub restart: bool,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Stall {
    pub service: String,
    #[serde(default, deserialize_with = "num")]
    pub limit: f64,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Retries {
    #[serde(default, deserialize_with = "num")]
    pub attempts: f64,
    #[serde(default, deserialize_with = "num")]
    pub budget: f64,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EndpointPlan {
    pub id: String,
    pub service: String,
    pub visits: Map<f64>,
    pub calls: Map<f64>,
    pub weights: Map<f64>,
    #[serde(default, deserialize_with = "num")]
    pub overhead_ms: f64,
    #[serde(default, deserialize_with = "num")]
    pub base_excess_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_p50_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_p90_ms: Option<f64>,
    #[serde(default, deserialize_with = "num")]
    pub tail: f64,
    #[serde(default, deserialize_with = "num")]
    pub error_rate: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_slope: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stalls: Option<Vec<Stall>>,
    pub bytes: Map<f64>,
    #[serde(default, deserialize_with = "num")]
    pub egress_bytes: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retries: Option<Retries>,
    #[serde(default, deserialize_with = "num")]
    pub timeout_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slo: Option<crate::model::Slo>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    #[serde(default, deserialize_with = "num")]
    pub cpu: f64,
    #[serde(default, deserialize_with = "num")]
    pub memory_gb: f64,
    #[serde(default, deserialize_with = "num")]
    pub per_hour: f64,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Others {
    #[serde(default, deserialize_with = "num")]
    pub cpu: f64,
    #[serde(default, deserialize_with = "num")]
    pub memory_gb: f64,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClusterPlan {
    pub node: Node,
    #[serde(default, deserialize_with = "num")]
    pub nodes: f64,
    pub autoscaled: bool,
    #[serde(default, deserialize_with = "num")]
    pub min_nodes: f64,
    #[serde(default, deserialize_with = "num")]
    pub max_nodes: f64,
    #[serde(default, deserialize_with = "num")]
    pub packing: f64,
    pub other: Others,
    #[serde(default, deserialize_with = "num")]
    pub scale_down_s: f64,
    #[serde(default, deserialize_with = "num")]
    pub provision_s: f64,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    #[serde(default, deserialize_with = "num")]
    pub cross_zone_gb: f64,
    #[serde(default, deserialize_with = "num")]
    pub cross_region_gb: f64,
    #[serde(default, deserialize_with = "num")]
    pub internet_gb: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub services: Map<ServicePlan>,
    pub endpoints: Map<EndpointPlan>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cluster: Option<ClusterPlan>,
    pub transfer: Transfer,
    #[serde(default, deserialize_with = "num")]
    pub unattributed_per_hour: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slo: Option<crate::model::Slo>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Traffic {
    #[serde(default, deserialize_with = "num")]
    pub start: f64,
    #[serde(default, deserialize_with = "num")]
    pub step_s: f64,
    #[serde(default, deserialize_with = "num")]
    pub n: f64,
    pub endpoints: Map<Vec<Num>>,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Opts {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub substep_s: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub faults: Option<Vec<Fault>>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ServiceTrace {
    pub rps: Vec<f64>,
    pub util: Vec<f64>,
    pub replicas: Vec<f64>,
    pub wait_ms: Vec<f64>,
    pub self_mean_ms: Vec<f64>,
    pub self_p99_ms: Vec<f64>,
    pub backlog: Vec<f64>,
    pub cpu_cores: Vec<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oom_down: Option<Vec<f64>>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EndpointTrace {
    pub rps: Vec<f64>,
    pub error_rate: Vec<f64>,
    pub mean_ms: Vec<f64>,
    pub p99_ms: Vec<f64>,
    pub p50_ms: Vec<f64>,
    pub cost: Vec<f64>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Costs {
    pub compute: Vec<f64>,
    pub requests: Vec<f64>,
    pub transfer: Vec<f64>,
    pub other: Vec<f64>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Event {
    pub t: f64,
    pub what: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClusterTrace {
    pub nodes: Vec<f64>,
    pub requested_cpu: Vec<f64>,
    pub requested_memory_gb: Vec<f64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub t: Vec<f64>,
    pub rps: Vec<f64>,
    pub error_rate: Vec<f64>,
    pub p99_ms: Vec<f64>,
    pub cost_per_hour: Vec<f64>,
    pub cost: Costs,
    pub services: Map<ServiceTrace>,
    pub endpoints: Map<EndpointTrace>,
    pub events: Vec<Event>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cluster: Option<ClusterTrace>,
}
