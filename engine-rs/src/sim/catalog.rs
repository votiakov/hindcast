//! The component catalogue's numbers (src/sim/catalog.ts, pricing.ts): capacity, latency and price per
//! kind, sizes, runtimes, and the pricing profiles' prices. The words (labels, descriptions, SKU names,
//! sources) stay with the app.

use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AutoscaleSpec {
    pub min: f64,
    pub max: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_util: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warmup_s: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cooldown_s: Option<f64>,
}

/// a component's data as the app holds it (SystemNodeData)
#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct NodeData {
    pub kind: String,
    #[serde(default)]
    pub name: String,
    #[serde(default = "tier_s")]
    pub tier: String,
    #[serde(default = "yes")]
    pub alive: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hit_rate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instances: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub down: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retries: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_policy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub breaker: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub routing: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fanout: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stall_rate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stall_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub batching: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capacity: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_per_hour: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_s: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub degraded: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub autoscale: Option<AutoscaleSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warmup_s: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flushes: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fault_rate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fault_latency_ms: Option<f64>,
}
fn tier_s() -> String {
    "S".into()
}
fn yes() -> bool {
    true
}

pub struct KindSpec {
    pub capacity: f64,
    pub base_latency_ms: f64,
    pub cost_per_hour: f64,
    pub cost_per_request: Option<f64>,
    pub queue_s: Option<f64>,
    pub tiered: bool,
    pub scalable: bool,
}

pub fn spec(kind: &str) -> KindSpec {
    let k = |capacity: f64, base_latency_ms: f64, cost_per_hour: f64, tiered: bool| KindSpec { capacity, base_latency_ms, cost_per_hour, cost_per_request: None, queue_s: None, tiered, scalable: false };
    match kind {
        "client" => k(f64::INFINITY, 0.0, 0.0, false),
        "cdn" => k(100000.0, 5.0, 0.08, false),
        "lb" => k(20000.0, 1.0, 0.05, true),
        "gateway" => k(20000.0, 3.0, 0.08, false),
        "server" => KindSpec { scalable: true, ..k(250.0, 25.0, 0.1, true) },
        "worker" => KindSpec { scalable: true, ..k(100.0, 80.0, 0.08, true) },
        "function" => KindSpec { cost_per_request: Some(0.6 / 1_000_000.0), ..k(3000.0, 35.0, 0.0, false) },
        "cache" => k(20000.0, 1.0, 0.15, true),
        "db" => k(1000.0, 10.0, 0.4, true),
        "replica" => k(1000.0, 10.0, 0.35, true),
        "storage" => k(50000.0, 40.0, 0.03, false),
        "queue" => k(50000.0, 3.0, 0.06, false),
        "llm" => KindSpec { queue_s: Some(3.0), scalable: true, ..k(6.0, 800.0, 4.0, false) },
        "llmapi" => KindSpec { cost_per_request: Some(0.002), ..k(100.0, 1500.0, 0.0, false) },
        _ => k(250.0, 25.0, 0.1, true),
    }
}

pub fn tier(t: &str) -> (f64, f64) {
    match t {
        "M" => (2.0, 2.2),
        "L" => (4.0, 4.8),
        _ => (1.0, 1.0),
    }
}

/// throughput, latency, cold start (ms), memory (MB) relative to Node.js
pub fn runtime(r: &str) -> (f64, f64, f64, f64) {
    match r {
        "python" => (0.45, 1.6, 350.0, 256.0),
        "java" => (1.5, 0.8, 1800.0, 512.0),
        "go" => (2.5, 0.5, 80.0, 128.0),
        "rust" => (3.5, 0.35, 40.0, 128.0),
        _ => (1.0, 1.0, 250.0, 256.0),
    }
}

pub const FN_PER_REQUEST: f64 = 0.2 / 1_000_000.0;
pub const FN_PER_GB_SECOND: f64 = 0.0000166667;
pub const BATCHING_CAPACITY: f64 = 4.0;
pub const BATCHING_LATENCY_MS: f64 = 400.0;
pub const QUEUE_MAX_BACKLOG: f64 = 200_000.0;
pub const CACHE_WARMUP_S: f64 = 20.0;

/// a pricing profile's numbers for one kind
#[derive(Default, Clone, Copy)]
pub struct KindPricing {
    /// hourly per tier S, M, L
    pub tiers: Option<[f64; 3]>,
    pub fixed: Option<f64>,
    pub per_request: Option<f64>,
}

pub fn kind_pricing(profile: &str, kind: &str) -> Option<KindPricing> {
    let tiers = |s: f64, m: f64, l: f64| Some(KindPricing { tiers: Some([s, m, l]), ..Default::default() });
    let per = |p: f64| Some(KindPricing { per_request: Some(p), ..Default::default() });
    match profile {
        "aws-us-east-1" => match kind {
            "server" | "worker" => tiers(0.0816, 0.1632, 0.3264),
            "db" | "replica" => tiers(0.239, 0.478, 0.956),
            "cache" => tiers(0.219, 0.438, 0.876),
            "llm" => Some(KindPricing { fixed: Some(0.8048), ..Default::default() }),
            "lb" => Some(KindPricing { fixed: Some(0.0225), per_request: Some(0.008 / 100_000.0), ..Default::default() }),
            "gateway" => per(1.0 / 1_000_000.0),
            "cdn" => per(1.0 / 1_000_000.0 + 0.085 * (10.0 / 1_048_576.0)),
            "storage" => per(0.4 / 1_000_000.0),
            "queue" => per(1.2 / 1_000_000.0),
            "function" => per(0.2 / 1_000_000.0),
            "llmapi" => per(0.15 / 1_000_000.0 * 1000.0 + 0.6 / 1_000_000.0 * 300.0),
            _ => None,
        },
        "gcp-us-central1" => match kind {
            "server" | "worker" => tiers(0.0898, 0.1796, 0.3592),
            "db" | "replica" => tiers(0.1946, 0.3892, 0.7784),
            "cache" => tiers(0.27, 0.54, 1.196),
            "llm" => Some(KindPricing { fixed: Some(0.7068), ..Default::default() }),
            "lb" => Some(KindPricing { fixed: Some(0.025), per_request: Some(0.008 * (10.0 / 1_048_576.0)), ..Default::default() }),
            "gateway" => per(3.0 / 1_000_000.0),
            "cdn" => per(0.75 / 1_000_000.0 + 0.08 * (10.0 / 1_048_576.0)),
            "storage" => per(0.4 / 1_000_000.0),
            "queue" => per(0.11 / 1_000_000.0),
            "function" => per(0.4 / 1_000_000.0),
            "llmapi" => per(0.15 / 1_000_000.0 * 1000.0 + 0.6 / 1_000_000.0 * 300.0),
            _ => None,
        },
        _ => None,
    }
}

fn tier_index(t: &str) -> usize {
    match t {
        "M" => 1,
        "L" => 2,
        _ => 0,
    }
}

/// hit-rate multiplier of a cache that went cold at `cold_at` (None = warm)
pub fn cache_warmth(cold_at: Option<f64>, now: f64, warmup_s: Option<f64>) -> f64 {
    match cold_at {
        None => 1.0,
        Some(c) => 1.0 - (-(now - c).max(0.0) / warmup_s.unwrap_or(CACHE_WARMUP_S).max(0.1)).exp(),
    }
}

pub fn instances_up(d: &NodeData) -> f64 {
    (d.instances.unwrap_or(1.0) - d.down.unwrap_or(0.0)).max(0.0)
}

pub fn is_up(d: &NodeData) -> bool {
    d.alive && instances_up(d) > 0.0
}

/// capacity in req/s; `reachable` = instances that actually receive traffic
pub fn capacity_of(d: &NodeData, reachable: Option<f64>) -> f64 {
    let sp = spec(&d.kind);
    let reachable = reachable.unwrap_or_else(|| instances_up(d));
    let cap = if d.kind == "function" || d.kind == "llmapi" || d.kind == "gateway" {
        d.limit.unwrap_or(sp.capacity)
    } else {
        let t = if sp.tiered { tier(&d.tier).0 } else { 1.0 };
        let batch = if d.kind == "llm" && d.batching == Some(true) { BATCHING_CAPACITY } else { 1.0 };
        let rt = d.runtime.as_deref().filter(|r| !r.is_empty()).map(|r| runtime(r).0).unwrap_or(1.0);
        d.capacity.unwrap_or(sp.capacity) * t * batch * rt * (if sp.scalable { reachable.max(1.0) } else { 1.0 })
    };
    cap * d.degraded.unwrap_or(1.0)
}

/// capacity of one healthy instance (for autoscaling decisions)
pub fn per_instance_capacity(d: &NodeData) -> f64 {
    let one = NodeData { instances: Some(1.0), down: Some(0.0), degraded: Some(1.0), ..d.clone() };
    capacity_of(&one, Some(1.0))
}

pub fn base_latency_of(d: &NodeData) -> f64 {
    let rt = d.runtime.as_deref().filter(|r| !r.is_empty()).map(|r| runtime(r).1).unwrap_or(1.0);
    d.latency_ms.unwrap_or(spec(&d.kind).base_latency_ms) * rt + (if d.kind == "llm" && d.batching == Some(true) { BATCHING_LATENCY_MS } else { 0.0 })
}

/// serverless $ per request: flat catalogue price, or memory × duration when a runtime is chosen
pub fn fn_cost_per_request(d: &NodeData, profile: &str) -> f64 {
    let has_rt = d.runtime.as_deref().map(|r| !r.is_empty()).unwrap_or(false);
    if !has_rt && kind_pricing(profile, "function").is_none() {
        return spec(&d.kind).cost_per_request.unwrap_or(0.0);
    }
    let (_, _, _, mem) = runtime(d.runtime.as_deref().unwrap_or("node"));
    FN_PER_REQUEST + FN_PER_GB_SECOND * (mem / 1024.0) * (base_latency_of(d) / 1000.0)
}

/// fixed hourly cost under a pricing profile (usage cost is added by the engine)
pub fn cost_of(d: &NodeData, profile: &str) -> f64 {
    let sp = spec(&d.kind);
    let n = d.instances.unwrap_or(1.0);
    let p = if d.cost_per_hour.is_none() { kind_pricing(profile, &d.kind) } else { None };
    if let Some(p) = p {
        if let Some(t) = p.tiers {
            return t[if sp.tiered { tier_index(&d.tier) } else { 0 }] * n;
        }
        if let Some(f) = p.fixed {
            return f * n;
        }
        if p.per_request.is_some() {
            return 0.0;
        }
    }
    let t = if sp.tiered { tier(&d.tier).1 } else { 1.0 };
    d.cost_per_hour.unwrap_or(sp.cost_per_hour) * t * n
}

/// $ per request for usage-billed components
pub fn request_price(d: &NodeData, profile: &str) -> f64 {
    if d.kind == "function" {
        return fn_cost_per_request(d, profile);
    }
    if let Some(p) = kind_pricing(profile, &d.kind).and_then(|p| p.per_request) {
        return p;
    }
    spec(&d.kind).cost_per_request.unwrap_or(0.0)
}

pub fn default_data(kind: &str, name: &str) -> NodeData {
    let mut d = NodeData { kind: kind.into(), name: name.into(), tier: "S".into(), alive: true, ..Default::default() };
    if spec(kind).scalable {
        d.instances = Some(1.0);
        d.down = Some(0.0);
    }
    match kind {
        "cache" => d.hit_rate = Some(0.85),
        "cdn" => d.hit_rate = Some(0.6),
        "gateway" => d.limit = Some(1500.0),
        "function" => d.limit = Some(3000.0),
        "llmapi" => d.limit = Some(100.0),
        _ => {}
    }
    d
}
