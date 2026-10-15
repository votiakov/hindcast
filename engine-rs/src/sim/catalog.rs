//! The component catalogue's numbers (src/sim/catalog.ts, pricing.ts): capacity, latency and price per
//! kind, sizes, runtimes, and the pricing profiles' prices. The words (labels, descriptions, SKU names,
//! sources) stay with the app.

#[allow(unused_imports)]
use crate::fmath::JsMath;
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
    /// cache/cdn: "through" (writes go on to the origin, the default) or "behind" (acknowledged at the
    /// cache, flushed to the origin a few seconds later — lost if the cache dies first)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub write_policy: Option<String>,
    /// cache: the data it fronts, GB — with it, the hit rate follows from the cache's memory and `skew`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_set_gb: Option<f64>,
    /// cache: how concentrated requests are on popular keys (Zipf exponent; 1 is typical of web traffic)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skew: Option<f64>,
    /// db: horizontal partitions, each a full-size database of its own (capacity and cost × shards)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shards: Option<f64>,
    /// db: share of its traffic that goes to one key (a celebrity, a hot counter) — all of it on one shard
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hot_key_share: Option<f64>,
    /// dns: how long clients keep a cached answer, s (default 60)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttl_s: Option<f64>,
    /// stream: partitions — ingest (1,000 messages/s each) and how many consumer instances a
    /// subscriber can use in parallel
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partitions: Option<f64>,
    /// dns: how long the health checks take to notice a dead target, s (default 30)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health_check_s: Option<f64>,
    /// server/worker: threads per instance — requests in flight, waiting on calls included
    /// (thread-per-request, e.g. Tomcat's 200). None: asynchronous, waiting holds nothing
    #[serde(skip_serializing_if = "Option::is_none")]
    pub threads: Option<f64>,
    /// calls that may wait on any one dependency at once, per instance; past it a call fails fast
    /// instead of taking another thread (a bulkhead)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bulkhead: Option<f64>,
    /// function: provisioned concurrency — executions kept warm (no cold start up to it), billed
    /// by the hour whether used or not
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provisioned: Option<f64>,
    /// a network partition's side this component is on (set by the partition action): links between
    /// components on different sides are cut
    #[serde(skip_serializing_if = "Option::is_none")]
    pub side: Option<String>,
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
        // someone else's service: a payment API, the websites a crawler fetches
        "external" => k(1000.0, 200.0, 0.0, false),
        // a managed key-value store (DynamoDB on demand): no box to size — a throughput limit for the
        // table, a per-partition one for any single key, and a price per request (80/20 reads/writes)
        // a log you publish to and many subscribe to (Kinesis, Kafka): per partition, 1,000 messages/s in
        // and $0.015/h; capacity and cost are per partition
        "stream" => k(1000.0, 5.0, 0.015, false),
        // DNS with health-checked failover (Route 53): cached everywhere, so effectively free and instant
        "dns" => k(1e9, 1.0, 0.001, false),
        "kv" => KindSpec { cost_per_request: Some(0.45 / 1_000_000.0), ..k(40000.0, 5.0, 0.0, false) },
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
/// Lambda provisioned concurrency, $ per GB-second it is configured (us-east-1, x86)
pub const FN_PROVISIONED_PER_GB_S: f64 = 0.0000041667;

/// a function's provisioned concurrency, $/h: memory × executions kept warm, used or not
pub fn provisioned_cost_h(d: &NodeData) -> f64 {
    match d.provisioned.filter(|p| *p > 0.0 && d.kind == "function") {
        Some(p) => p * (runtime(d.runtime.as_deref().filter(|r| !r.is_empty()).unwrap_or("node")).3 / 1024.0) * FN_PROVISIONED_PER_GB_S * 3600.0,
        None => 0.0,
    }
}

/// the request rate a function's provisioned concurrency serves warm
pub fn provisioned_rps(d: &NodeData) -> f64 {
    match d.provisioned.filter(|p| *p > 0.0 && d.kind == "function") {
        Some(p) => p / (base_latency_of(d).max(1.0) / 1000.0),
        None => 0.0,
    }
}
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

/// a hosted DNS zone, $0.50 a month (Route 53, Azure DNS). Queries aren't priced: resolvers cache
/// answers for the TTL, so they scale with clients, not requests
const DNS_ZONE_HOURLY: f64 = 0.5 / 730.0;

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
            // DynamoDB on demand: $0.25 per million reads, $1.25 per million writes, 80/20
            "kv" => per(0.45 / 1_000_000.0),
            // Kinesis provisioned: $0.015 per shard-hour + $0.014 per million PUT payload units
            "stream" => Some(KindPricing { fixed: Some(0.015), per_request: Some(0.014 / 1_000_000.0), ..Default::default() }),
            "dns" => Some(KindPricing { fixed: Some(DNS_ZONE_HOURLY), ..Default::default() }),
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
            // Firestore: $0.06 per 100k reads, $0.18 per 100k writes, 80/20
            "kv" => per(0.84 / 1_000_000.0),
            // Pub/Sub topic with subscriptions: billed by throughput, not partitions
            "stream" => per(0.11 / 1_000_000.0),
            "dns" => Some(KindPricing { fixed: Some(0.2 / 730.0), ..Default::default() }),
            _ => None,
        },
        // Azure Retail Prices API (prices.azure.com), East US, pay as you go, 2026-10-15
        "azure-eastus" => match kind {
            "server" | "worker" => tiers(0.0702, 0.14, 0.281),
            "db" | "replica" => tiers(0.25, 0.5, 1.0),
            "cache" => tiers(0.45, 0.525, 1.05),
            "llm" => Some(KindPricing { fixed: Some(0.526), ..Default::default() }),
            // Application Gateway Standard_v2: $0.20/h + $0.008 per capacity unit-hour (≈ 1 GB/h)
            "lb" => Some(KindPricing { fixed: Some(0.2), per_request: Some(0.008 / 100_000.0), ..Default::default() }),
            "gateway" => per(3.5 / 1_000_000.0),
            "cdn" => per(0.9 / 1_000_000.0 + 0.0825 * (10.0 / 1_048_576.0)),
            "storage" => per(0.4 / 1_000_000.0),
            // Service Bus Standard: $0.80 per million operations × send, receive, complete
            "queue" => per(2.4 / 1_000_000.0),
            "function" => per(0.2 / 1_000_000.0),
            "llmapi" => per(0.15 / 1_000_000.0 * 1000.0 + 0.6 / 1_000_000.0 * 300.0),
            // Cosmos DB serverless: $0.25 per million RUs; 1 RU a 1 KB read, ~5 a write, 80/20
            "kv" => per(0.45 / 1_000_000.0),
            // Event Hubs Standard: $0.03 per throughput unit-hour (1,000 events/s in) + $0.028 per million events
            "stream" => Some(KindPricing { fixed: Some(0.03), per_request: Some(0.028 / 1_000_000.0), ..Default::default() }),
            "dns" => Some(KindPricing { fixed: Some(DNS_ZONE_HOURLY), ..Default::default() }),
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
/// a cache's memory by size: ElastiCache-like nodes (m7g.large, r7g.large, r7g.xlarge), GB
pub fn cache_memory_gb(d: &NodeData) -> f64 {
    match d.tier.as_str() {
        "M" => 13.0,
        "L" => 26.0,
        _ => 6.4,
    }
}

/// Σ_{i ≤ x} i^−s (Euler–Maclaurin): requests that land on the x most popular keys, unnormalised
fn zipf_mass(x: f64, s: f64) -> f64 {
    if x <= 1.0 {
        return x.max(0.0);
    }
    if (s - 1.0).abs() < 1e-9 {
        x.js_ln() + 0.5772156649 + 0.5 / x
    } else {
        (x.js_pow(1.0 - s) - 1.0) / (1.0 - s) + 0.5 * (1.0 + x.js_pow(-s))
    }
}

/// the share of reads a cache answers: its own `hitRate`, or — given the data it fronts — the share of
/// requests that land on the most popular keys its memory holds (1 KB keys, Zipf popularity)
pub fn cache_hit_rate(d: &NodeData) -> f64 {
    match d.working_set_gb.filter(|w| *w > 0.0) {
        Some(ws) => {
            let s = d.skew.unwrap_or(1.0).max(0.01);
            let n = ws * 1e6;
            let k = (cache_memory_gb(d) * 1e6).min(n);
            // keys expire and new ones appear: even a cache that holds everything misses now and then
            (zipf_mass(k, s) / zipf_mass(n, s)).min(1.0) * 0.99
        }
        None => d.hit_rate.unwrap_or(0.85),
    }
}

/// a link between two components that a network partition has cut
pub fn cut(a: &NodeData, b: &NodeData) -> bool {
    matches!((&a.side, &b.side), (Some(x), Some(y)) if x != y)
}

pub fn cache_warmth(cold_at: Option<f64>, now: f64, warmup_s: Option<f64>) -> f64 {
    match cold_at {
        None => 1.0,
        Some(c) => 1.0 - (-(now - c).max(0.0) / warmup_s.unwrap_or(CACHE_WARMUP_S).max(0.1)).js_exp(),
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
    let cap = if d.kind == "function" || d.kind == "llmapi" || d.kind == "external" || d.kind == "kv" || d.kind == "gateway" {
        d.limit.unwrap_or(sp.capacity)
    } else {
        let t = if sp.tiered { tier(&d.tier).0 } else { 1.0 };
        let batch = if d.kind == "llm" && d.batching == Some(true) { BATCHING_CAPACITY } else { 1.0 };
        let rt = d.runtime.as_deref().filter(|r| !r.is_empty()).map(|r| runtime(r).0).unwrap_or(1.0);
        d.capacity.unwrap_or(sp.capacity) * t * batch * rt * (if sp.scalable { reachable.max(1.0) } else { 1.0 }) * shards_of(d) * partitions_of(d)
    };
    cap * d.degraded.unwrap_or(1.0)
}

/// a database's (or its replica's) shard count (1 for everything else)
pub fn shards_of(d: &NodeData) -> f64 {
    if d.kind == "db" || d.kind == "replica" {
        d.shards.unwrap_or(1.0).max(1.0).floor()
    } else {
        1.0
    }
}

/// a stream's partitions (1 for everything else)
pub fn partitions_of(d: &NodeData) -> f64 {
    if d.kind == "stream" {
        d.partitions.unwrap_or(4.0).max(1.0).floor()
    } else {
        1.0
    }
}

/// what one subscriber of a stream drains, messages/s: its instances, but no more of them than the
/// stream has partitions (one consumer per partition)
pub fn subscriber_rps(consumer: &NodeData, partitions: f64) -> f64 {
    if spec(&consumer.kind).scalable {
        capacity_of(consumer, Some(instances_up(consumer).min(partitions)))
    } else {
        capacity_of(consumer, None)
    }
}

/// the share of a DNS name's clients still sent to a target that has been dead for `dead_for` seconds:
/// all of them until the health checks notice, then fewer as cached answers expire over the TTL
pub fn dns_stale(d: &NodeData, dead_for: f64) -> f64 {
    if dead_for <= 0.0 {
        return 0.0;
    }
    let (health, ttl) = (d.health_check_s.unwrap_or(30.0).max(0.0), d.ttl_s.unwrap_or(60.0).max(0.0));
    if dead_for < health {
        1.0
    } else if ttl <= 0.0 {
        0.0
    } else {
        (1.0 - (dead_for - health) / ttl).max(0.0)
    }
}

/// of what a DNS name answers, the share sent to targets that are dead: failover walks its targets in
/// order; otherwise each target gets an even share. `dead_for(t)` is 0 for a live target
pub fn dns_stale_share(d: &NodeData, targets: &[(bool, f64)]) -> f64 {
    if targets.is_empty() {
        return 0.0;
    }
    if d.routing.as_deref() == Some("failover") {
        let (mut left, mut dead) = (1.0, 0.0);
        for &(up, dead_for) in targets {
            if up {
                break;
            }
            let s = dns_stale(d, dead_for);
            dead += left * s;
            left *= 1.0 - s;
        }
        dead
    } else {
        targets.iter().filter(|t| !t.0).map(|t| dns_stale(d, t.1)).sum::<f64>() / targets.len() as f64
    }
}

/// a key-value store's partition: 3,000 reads or 1,000 writes a second (DynamoDB), whatever the table
/// may do — so one hot key throttles however much the table is provisioned for
pub const KV_PARTITION_READS: f64 = 3000.0;
pub const KV_PARTITION_WRITES: f64 = 1000.0;


/// the share of a database's traffic on its busiest shard: the hot key, plus an even share of the rest
pub fn hot_shard_share(d: &NodeData) -> f64 {
    let n = shards_of(d);
    let h = if d.kind == "db" { d.hot_key_share.unwrap_or(0.0).clamp(0.0, 1.0) } else { 0.0 };
    h + (1.0 - h) / n
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
    fixed_cost_of(d, profile) + provisioned_cost_h(d)
}

fn fixed_cost_of(d: &NodeData, profile: &str) -> f64 {
    let sp = spec(&d.kind);
    let n = d.instances.unwrap_or(1.0) * shards_of(d) * partitions_of(d);
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
        "external" => d.limit = Some(1000.0),
        "kv" => d.limit = Some(40000.0),
        _ => {}
    }
    d
}
