//! The design simulator's fluid, tick-based engine (src/sim/engine.ts, autoscale.ts, components/).
//!
//! Each tick, request volume flows from clients through the graph in topological order (forward
//! pass), then end-to-end success and latency fold back from the leaves (backward pass). Per-kind
//! behaviour is a match on the kind; routing (split | fanout | failover), retries, circuit breakers,
//! caller deadlines, autoscalers, cost and the global SLO numbers apply to any node.

use super::catalog::*;
use crate::backtest::{js_max, js_sort_by};
use crate::math::js_num;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct EngineConfig {
    pub timeout_s: f64,
    pub failover_s: Option<f64>,
    pub cold_start_ms: f64,
}

impl Default for EngineConfig {
    fn default() -> Self {
        EngineConfig { timeout_s: 1.0, failover_s: Some(3.0), cold_start_ms: 400.0 }
    }
}

const HISTORY_LEN: usize = 90;
const HISTORY_EVERY_S: f64 = 0.25;
const TRIP_FAIL: f64 = 0.5;
const TRIP_AFTER_S: f64 = 1.0;
const OPEN_S: f64 = 5.0;
const PROBE_OPEN: f64 = 0.02;
const PROBE_HALF: f64 = 0.2;
const CLOSE_FAIL: f64 = 0.1;
const BACKOFF_SPREAD: f64 = 0.3;
const BACKOFF_DELAY_MS: f64 = 200.0;
const RETRY_BUDGET: f64 = 0.1;
const AUTOSCALE_TARGET: f64 = 0.6;
const AUTOSCALE_WARMUP_S: f64 = 30.0;
const AUTOSCALE_COOLDOWN_S: f64 = 60.0;
const EVAL_S: f64 = 1.0;

#[derive(Deserialize, Clone, Debug)]
pub struct SimNode {
    pub id: String,
    pub data: NodeData,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct EdgeData {
    pub latency_ms: Option<f64>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct SimEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    #[serde(default)]
    pub data: Option<EdgeData>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SimEvent {
    pub kind: String,
    pub node_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ScalerState {
    pub live: f64,
    pub pending: Vec<f64>,
    pub replaced: f64,
    pub last_activity: f64,
    pub last_eval: f64,
    pub desired: f64,
}

fn new_scaler(d: &NodeData) -> ScalerState {
    let a = d.autoscale.as_ref().unwrap();
    let start = a.max.min(a.min.max(d.instances.unwrap_or(a.min)));
    ScalerState { live: start, pending: vec![], replaced: 0.0, last_activity: f64::NEG_INFINITY, last_eval: f64::NEG_INFINITY, desired: start }
}

/// node data as the engine sees it: live instance count, replaced instances no longer down
fn effective_data(d: &NodeData, s: Option<&ScalerState>) -> NodeData {
    match (&d.autoscale, s) {
        (Some(_), Some(s)) => NodeData { instances: Some(s.live), down: Some(s.live.min(d.down.unwrap_or(0.0) - s.replaced).max(0.0)), ..d.clone() },
        _ => d.clone(),
    }
}

/// advance a scaler to `now`; (kind, from, to)
fn step_scaler(s: &mut ScalerState, d: &NodeData, now: f64, demand: f64, per_instance: f64) -> Vec<(&'static str, f64, f64)> {
    let a = d.autoscale.as_ref().unwrap();
    let target = a.target_util.unwrap_or(AUTOSCALE_TARGET);
    let warmup = a.warmup_s.unwrap_or(AUTOSCALE_WARMUP_S);
    let cooldown = a.cooldown_s.unwrap_or(AUTOSCALE_COOLDOWN_S);
    let down = d.down.unwrap_or(0.0);
    let mut events = vec![];
    // a healed node (down reset) no longer needs replacements
    s.replaced = s.replaced.min(down);
    // boots that finished
    let ready = s.pending.iter().filter(|t| now - **t >= warmup).count() as f64;
    if ready > 0.0 {
        s.pending.retain(|t| now - *t < warmup);
        let before = s.live;
        // replacements for dead instances first
        let dead = (down - s.replaced).max(0.0);
        let replace = dead.min(ready);
        s.replaced += replace;
        s.live = (a.max + down).min(s.live + ready - replace);
        events.push(("scaled", before, s.live));
    }
    if now - s.last_eval < EVAL_S {
        return events;
    }
    s.last_eval = now;
    let dead = (down - s.replaced).max(0.0);
    let healthy = s.live - dead;
    let desired = a.max.min(a.min.max((demand / (per_instance * target).max(1e-9)).ceil()));
    s.desired = desired;
    let pending = s.pending.len() as f64;
    let coming = healthy + pending;
    if desired > coming || dead > pending {
        let launch = (desired - coming).max(0.0) + (dead - pending).max(0.0);
        let n = launch.min(a.max + dead - s.live - pending);
        if n > 0.0 {
            let mut i = 0.0;
            while i < n {
                s.pending.push(now);
                i += 1.0;
            }
            s.last_activity = now;
            events.push(("scale-out", healthy, healthy + s.pending.len() as f64));
        }
    } else if desired < healthy && s.pending.is_empty() && now - s.last_activity >= cooldown {
        // scale in gradually: at most half of the surplus per step
        let remove = ((healthy - desired) / 2.0).floor().max(1.0);
        let before = s.live;
        s.live = (a.min + dead).max(s.live - remove);
        if s.live != before {
            s.last_activity = now;
            events.push(("scale-in", before, s.live));
        }
    }
    events
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Breaker {
    Closed,
    Open,
    Half,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Failover {
    None,
    Electing,
    Promoted,
}

#[derive(Clone, Debug)]
pub struct NodeState {
    pub queue: f64,
    pub in_rps: f64,
    pub drop_rps: f64,
    pub hit_rps: f64,
    pub util: f64,
    pub success: f64,
    pub latency_ms: f64,
    pub drop_ratio: f64,
    pub history: VecDeque<f64>,
    pub overloaded: bool,
    pub reachable: f64,
    pub drain_rps: f64,
    pub warm: f64,
    pub cold_frac: f64,
    pub down_for: f64,
    pub cost_per_hour: f64,
    pub failover: Failover,
    pub attempt_fail: f64,
    pub retry_amp: f64,
    pub breaker: Breaker,
    pub breaker_t: f64,
    pub breaker_pass: f64,
    pub late_frac: f64,
    pub cold_at: Option<f64>,
    pub flush_seen: f64,
    pub warmth: f64,
}

fn fresh() -> NodeState {
    NodeState {
        queue: 0.0,
        in_rps: 0.0,
        drop_rps: 0.0,
        hit_rps: 0.0,
        util: 0.0,
        success: 1.0,
        latency_ms: 0.0,
        drop_ratio: 0.0,
        history: VecDeque::new(),
        overloaded: false,
        reachable: 1.0,
        drain_rps: 0.0,
        warm: 0.0,
        cold_frac: 0.0,
        down_for: 0.0,
        cost_per_hour: 0.0,
        failover: Failover::None,
        attempt_fail: 0.0,
        retry_amp: 1.0,
        breaker: Breaker::Closed,
        breaker_t: 0.0,
        breaker_pass: 1.0,
        late_frac: 0.0,
        cold_at: None,
        flush_seen: 0.0,
        warmth: 1.0,
    }
}

fn ema(prev: f64, next: f64, dt: f64, tau: f64) -> f64 {
    prev + (next - prev) * (1.0 - (-dt / tau).exp())
}

/// node data with dynamic effects applied: autoscaled instance count, and the throughput lost to
/// injected latency (a pool of workers that each take longer serves fewer requests per second)
pub fn dynamic_data(d: &NodeData, scaler: Option<&ScalerState>) -> NodeData {
    let mut e = effective_data(d, scaler);
    if let Some(fl) = e.fault_latency_ms.filter(|x| *x != 0.0 && !x.is_nan()) {
        if !matches!(d.kind.as_str(), "gateway" | "llmapi" | "client" | "queue") {
            let base = base_latency_of(d).max(0.05);
            e.degraded = Some(e.degraded.unwrap_or(1.0) * (base / (base + fl)));
        }
    }
    e
}

/// outgoing attempts per original call, given per-attempt failure rate f
pub fn retry_amp(f: f64, retries: f64, policy: &str) -> f64 {
    let mut sum = 0.0;
    let mut k = 0.0;
    while k <= retries {
        sum += f.powf(k);
        k += 1.0;
    }
    match policy {
        "backoff" => 1.0 + (sum - 1.0) * BACKOFF_SPREAD,
        "budget" => sum.min(1.0 + RETRY_BUDGET),
        _ => sum,
    }
}

/// end-to-end success after retries, given per-attempt success s
fn retry_success(s: f64, retries: f64, policy: &str, amp: f64) -> f64 {
    let f = 1.0 - s;
    if policy == "budget" {
        return s + f.min(amp - 1.0) * s;
    }
    1.0 - f.powf(retries + 1.0)
}

/// expected max of N long-tailed latencies relative to one
pub fn fanout_tail(n: f64) -> f64 {
    if n <= 1.0 {
        1.0
    } else {
        1.0 + 0.6 * (2.0 * n.ln()).sqrt()
    }
}

fn late_frac(lat: f64, deadline: f64) -> f64 {
    ((lat - 0.8 * deadline) / (0.4 * deadline)).max(0.0).min(1.0)
}

#[derive(Clone, Debug)]
pub struct Route {
    pub edge_id: String,
    pub target: String,
    pub data: NodeData,
    pub up: bool,
}

struct ProcessResult {
    processed: f64,
    failed: f64,
    forward: f64,
    routes: Option<Vec<Route>>,
    shares: Option<HashMap<String, f64>>,
    local_share: Option<f64>,
    hits: Option<f64>,
    util: f64,
    up: bool,
}

fn res(processed: f64, failed: f64, forward: f64, util: f64, up: bool) -> ProcessResult {
    ProcessResult { processed, failed, forward, routes: None, shares: None, local_share: None, hits: None, util, up }
}

fn queue_seconds(d: &NodeData, cfg: &EngineConfig) -> f64 {
    d.queue_s.or(spec(&d.kind).queue_s).unwrap_or(cfg.timeout_s)
}

/// bounded FIFO queue in front of a fixed capacity: work beyond `queue_s` seconds of capacity is shed
fn queue_stage(st: &mut NodeState, arrivals: f64, cap_per_s: f64, dt: f64, queue_s: f64) -> (f64, f64, f64) {
    let cap = (cap_per_s * dt).max(1e-9);
    st.queue += arrivals;
    let processed = st.queue.min(cap);
    st.queue -= processed;
    let max_q = cap_per_s * queue_s;
    let mut failed = 0.0;
    if st.queue > max_q {
        failed = st.queue - max_q;
        st.queue = max_q;
    }
    (processed, failed, if cap_per_s > 0.0 { arrivals / cap } else { 0.0 })
}

/// M/M/1-style service time inflation plus time spent waiting in the queue
fn service_latency(d: &NodeData, st: &NodeState) -> f64 {
    let rho = st.util.min(0.95);
    base_latency_of(d) / (1.0 - rho) + (st.queue / capacity_of(d, Some(st.reachable)).max(1.0)) * 1000.0 + d.stall_rate.unwrap_or(0.0) * d.stall_ms.unwrap_or(0.0)
}

struct Ctx<'a> {
    d: &'a NodeData,
    arrivals: f64,
    dt: f64,
    cfg: &'a EngineConfig,
    read_ratio: f64,
    routes: &'a [Route],
    pooled: bool,
}

fn reachable(c: &Ctx) -> f64 {
    let up = (c.d.instances.unwrap_or(1.0) - c.d.down.unwrap_or(0.0)).max(0.0);
    if c.pooled || c.d.kind == "llm" {
        up
    } else {
        up.min(1.0)
    }
}

fn process_through(c: &Ctx, st: &mut NodeState) -> ProcessResult {
    if spec(&c.d.kind).scalable {
        st.reachable = reachable(c);
    }
    let (processed, failed, util) = queue_stage(st, c.arrivals, capacity_of(c.d, Some(st.reachable)), c.dt, queue_seconds(c.d, c.cfg));
    res(processed, failed, processed, util, true)
}

fn process(c: &Ctx, st: &mut NodeState) -> ProcessResult {
    match c.d.kind.as_str() {
        "client" => res(c.arrivals, 0.0, c.arrivals, 0.0, c.d.alive),
        "lb" => {
            let mut r = process_through(c, st);
            let routes: Vec<Route> = c.routes.iter().filter(|k| k.up).cloned().collect();
            if routes.is_empty() {
                r.failed += r.processed;
                r.forward = 0.0;
            }
            r.routes = Some(routes);
            r
        }
        "gateway" => {
            let limit = c.d.limit.unwrap_or(f64::INFINITY);
            let processed = c.arrivals.min(limit * c.dt);
            let routes: Vec<Route> = c.routes.iter().filter(|k| k.up).cloned().collect();
            let failed = c.arrivals - processed + (if routes.is_empty() { processed } else { 0.0 });
            let mut r = res(processed, failed, if routes.is_empty() { 0.0 } else { processed }, c.arrivals / (limit * c.dt), true);
            r.routes = Some(routes);
            r
        }
        "cache" | "cdn" => {
            let mut r = process_through(c, st);
            let h = c.d.hit_rate.unwrap_or(0.85) * st.warmth;
            let hits = r.processed * h;
            let mut forward = r.processed - hits;
            if c.routes.is_empty() {
                r.failed += forward;
                forward = 0.0;
            }
            r.forward = forward;
            r.hits = Some(hits);
            r.local_share = Some(h);
            r
        }
        "db" => {
            let d = c.d;
            let write_ratio = 1.0 - c.read_ratio;
            let replicas: Vec<Route> = c.routes.iter().filter(|k| k.data.kind == "replica" && k.up).cloned().collect();
            st.failover = Failover::None;
            let mut shares = None;
            if !d.alive {
                st.down_for += c.dt;
                if let (false, Some(fs)) = (replicas.is_empty(), c.cfg.failover_s) {
                    if st.down_for >= fs {
                        // first replica is the new primary: all writes plus its share of reads
                        st.failover = Failover::Promoted;
                        let n = replicas.len() as f64;
                        shares = Some(replicas.iter().enumerate().map(|(i, k)| (k.edge_id.clone(), c.read_ratio / n + if i == 0 { write_ratio } else { 0.0 })).collect::<HashMap<_, _>>());
                    } else {
                        st.failover = Failover::Electing;
                    }
                }
            } else {
                st.down_for = 0.0;
            }
            if !d.alive && st.failover == Failover::None {
                st.queue = 0.0;
                return res(0.0, c.arrivals, 0.0, 0.0, false);
            }
            if st.failover == Failover::Promoted {
                st.queue = 0.0;
                let mut r = res(0.0, 0.0, c.arrivals, 0.0, true);
                r.routes = Some(replicas);
                r.shares = shares;
                r.local_share = Some(0.0);
                return r;
            }
            let local_share = write_ratio + c.read_ratio / (replicas.len() as f64 + 1.0);
            let to_replicas = c.arrivals * (1.0 - local_share);
            let cap = if st.failover == Failover::Electing { 0.0 } else { capacity_of(d, None) };
            let (processed, failed, util) = queue_stage(st, c.arrivals - to_replicas, cap, c.dt, queue_seconds(d, c.cfg));
            let mut r = res(processed, failed, to_replicas, util, true);
            r.routes = Some(replicas);
            r.local_share = Some(local_share);
            r
        }
        "queue" => {
            st.queue += c.arrivals;
            let mut failed = 0.0;
            if st.queue > QUEUE_MAX_BACKLOG {
                failed = st.queue - QUEUE_MAX_BACKLOG;
                st.queue = QUEUE_MAX_BACKLOG;
            }
            let routes: Vec<Route> = c.routes.iter().filter(|k| k.up).cloned().collect();
            let drain = routes.iter().fold(0.0, |s, k| s + capacity_of(&k.data, None));
            st.drain_rps = drain;
            let processed = st.queue.min(drain * c.dt);
            st.queue -= processed;
            let mut r = res(processed, failed, processed, st.queue / QUEUE_MAX_BACKLOG, true);
            r.routes = Some(routes);
            r
        }
        "function" => {
            let cap = capacity_of(c.d, None) * c.dt;
            let processed = c.arrivals.min(cap);
            let demand = c.arrivals / c.dt;
            let k = |tau: f64| 1.0 - (-c.dt / tau).exp();
            st.warm += (demand - st.warm) * k(if demand > st.warm { 4.0 } else { 1.0 });
            st.cold_frac = if demand > 0.5 { ((demand - st.warm) / demand).max(0.0) } else { 0.0 };
            res(processed, c.arrivals - processed, processed, c.arrivals / cap, true)
        }
        "llmapi" => {
            let cap = capacity_of(c.d, None) * c.dt;
            let processed = c.arrivals.min(cap);
            res(processed, c.arrivals - processed, processed, c.arrivals / cap, true)
        }
        // app servers, workers, storage, replicas, GPU pools
        _ => process_through(c, st),
    }
}

struct FoldCtx<'a> {
    d: &'a NodeData,
    keep: f64,
    local_share: f64,
    child_succ: f64,
    child_lat: f64,
    has_kids: bool,
    cfg: &'a EngineConfig,
}

fn fold(c: &FoldCtx, st: &NodeState) -> (f64, f64) {
    let kids_succ = if c.has_kids { c.child_succ } else { 1.0 };
    let kids_lat = if c.has_kids { c.child_lat } else { 0.0 };
    match c.d.kind.as_str() {
        "client" => (if c.has_kids { c.child_succ } else { 0.0 }, c.child_lat),
        "lb" => (if c.has_kids { c.keep * c.child_succ } else { 0.0 }, service_latency(c.d, st) + c.child_lat),
        "gateway" => (if c.has_kids { c.keep * c.child_succ } else { 0.0 }, spec("gateway").base_latency_ms + c.child_lat),
        "cache" | "cdn" => (c.keep * (c.local_share + (1.0 - c.local_share) * kids_succ), service_latency(c.d, st) + (1.0 - c.local_share) * c.child_lat),
        "db" => (c.local_share * c.keep + (1.0 - c.local_share) * kids_succ, c.local_share * service_latency(c.d, st) + (1.0 - c.local_share) * c.child_lat),
        "queue" => (c.keep, spec("queue").base_latency_ms),
        "function" => {
            let cold = if c.cfg.cold_start_ms > 0.0 && c.d.runtime.as_deref().map(|r| !r.is_empty()).unwrap_or(false) { runtime(c.d.runtime.as_deref().unwrap()).2 } else { c.cfg.cold_start_ms };
            (c.keep * kids_succ, base_latency_of(c.d) + st.cold_frac * cold + kids_lat)
        }
        "llmapi" => (c.keep * kids_succ, c.d.latency_ms.unwrap_or(spec("llmapi").base_latency_ms) + kids_lat),
        _ => (c.keep * kids_succ, service_latency(c.d, st) + kids_lat),
    }
}

/// usage-based $/h on top of the fixed price; None: in-rps × request price
fn usage_cost(d: &NodeData, st: &NodeState, profile: &str) -> f64 {
    match d.kind.as_str() {
        "function" => st.in_rps * 3600.0 * request_price(d, profile),
        "llmapi" => (st.in_rps - st.drop_rps) * 3600.0 * (if d.cost_per_hour.is_none() { request_price(d, profile) } else { 0.0 }),
        _ => st.in_rps * 3600.0 * request_price(d, profile),
    }
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPoint {
    pub rps: f64,
    pub err: f64,
    pub p99: f64,
    pub cost: f64,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct GlobalStats {
    pub t: f64,
    pub rps: f64,
    pub error_rate: f64,
    pub p99: f64,
    pub cost: f64,
    pub history: Vec<HistoryPoint>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Scaling {
    pub live: f64,
    pub pending: f64,
    pub desired: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NodeStats {
    pub in_rps: f64,
    pub drop_rps: f64,
    pub util: f64,
    pub queue: f64,
    pub latency_ms: f64,
    pub success: f64,
    pub hit_rps: f64,
    pub reachable: f64,
    pub lag_s: f64,
    pub cold_frac: f64,
    pub failover: String,
    pub cost_per_hour: f64,
    pub retry_amp: f64,
    pub breaker: Option<String>,
    pub late_frac: f64,
    pub history: Vec<f64>,
    pub scaling: Option<Scaling>,
    pub warmth: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EdgeStats {
    pub rps: f64,
    pub err_ratio: f64,
    pub util: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub node_stats: IndexMap<String, NodeStats>,
    pub edge_stats: IndexMap<String, EdgeStats>,
    pub global: GlobalStats,
}

struct Local {
    local_share: f64,
    routes: Vec<Route>,
    flows: Vec<(String, f64)>,
    mode: String,
    up: bool,
}

#[derive(Default)]
pub struct Engine {
    pub t: f64,
    nodes: IndexMap<String, NodeState>,
    edges: IndexMap<String, f64>,
    scalers: IndexMap<String, ScalerState>,
    global: GlobalStats,
    since_history: f64,
}

fn failover_name(f: Failover) -> &'static str {
    match f {
        Failover::None => "none",
        Failover::Electing => "electing",
        Failover::Promoted => "promoted",
    }
}

impl Engine {
    pub fn new() -> Self {
        Engine::default()
    }

    pub fn reset(&mut self) {
        *self = Engine::default();
    }

    fn state(&mut self, id: &str) -> &mut NodeState {
        if !self.nodes.contains_key(id) {
            self.nodes.insert(id.to_string(), fresh());
        }
        self.nodes.get_mut(id).unwrap()
    }

    /// advance the breaker state machine; the share of calls allowed through
    fn breaker_pass(d: &NodeData, st: &mut NodeState, dt: f64, events: &mut Vec<SimEvent>, id: &str) -> f64 {
        if d.breaker != Some(true) {
            st.breaker = Breaker::Closed;
            return 1.0;
        }
        let prev = st.breaker;
        st.breaker_t += dt;
        match st.breaker {
            Breaker::Closed => {
                if st.attempt_fail > TRIP_FAIL {
                    if st.breaker_t >= TRIP_AFTER_S {
                        st.breaker = Breaker::Open;
                        st.breaker_t = 0.0;
                    }
                } else {
                    st.breaker_t = 0.0;
                }
            }
            Breaker::Open => {
                if st.breaker_t >= OPEN_S {
                    st.breaker = Breaker::Half;
                    st.breaker_t = 0.0;
                }
            }
            Breaker::Half => {
                if st.breaker_t >= 1.0 {
                    if st.attempt_fail < CLOSE_FAIL {
                        st.breaker = Breaker::Closed;
                        st.breaker_t = 0.0;
                    } else if st.attempt_fail > TRIP_FAIL {
                        st.breaker = Breaker::Open;
                        st.breaker_t = 0.0;
                    }
                }
            }
        }
        if prev != Breaker::Open && st.breaker == Breaker::Open {
            events.push(SimEvent { kind: "breaker-open".into(), node_id: id.into(), name: d.name.clone(), detail: None });
        }
        if prev != Breaker::Closed && st.breaker == Breaker::Closed {
            events.push(SimEvent { kind: "breaker-closed".into(), node_id: id.into(), name: d.name.clone(), detail: None });
        }
        match st.breaker {
            Breaker::Open => PROBE_OPEN,
            Breaker::Half => PROBE_HALF,
            Breaker::Closed => 1.0,
        }
    }

    /// one tick: `traffic` req/s sent by all clients, `read_ratio` share of reads
    pub fn step(&mut self, nodes_in: &[SimNode], edges: &[SimEdge], traffic: f64, read_ratio: f64, dt: f64, cfg: &EngineConfig, profile: &str) -> Vec<SimEvent> {
        self.t += dt;
        let mut events: Vec<SimEvent> = vec![];
        let now = self.t;
        let original: HashMap<&str, &NodeData> = nodes_in.iter().map(|n| (n.id.as_str(), &n.data)).collect();
        let mut nodes: Vec<(String, NodeData)> = Vec::with_capacity(nodes_in.len());
        for n in nodes_in {
            if n.data.autoscale.is_some() && spec(&n.data.kind).scalable {
                if !self.scalers.contains_key(&n.id) {
                    self.scalers.insert(n.id.clone(), new_scaler(&n.data));
                }
            } else {
                self.scalers.shift_remove(&n.id);
            }
            nodes.push((n.id.clone(), dynamic_data(&n.data, self.scalers.get(&n.id))));
        }
        let mut edge_lat: HashMap<&str, f64> = HashMap::new();
        for e in edges {
            if let Some(l) = e.data.as_ref().and_then(|d| d.latency_ms).filter(|l| *l != 0.0 && !l.is_nan()) {
                edge_lat.insert(&e.id, l);
            }
        }
        let by_id: HashMap<&str, usize> = nodes.iter().enumerate().map(|(i, (id, _))| (id.as_str(), i)).collect();
        let mut out: HashMap<&str, Vec<Route>> = HashMap::new();
        let mut indeg: HashMap<&str, i64> = nodes.iter().map(|(id, _)| (id.as_str(), 0)).collect();
        let mut pooled: HashSet<&str> = HashSet::new();
        for e in edges {
            let (si, ti) = match (by_id.get(e.source.as_str()), by_id.get(e.target.as_str())) {
                (Some(s), Some(t)) if e.source != e.target => (*s, *t),
                _ => continue,
            };
            let sd = &nodes[si].1;
            // instances are reachable behind a balancer/queue, or when a scatter-gather caller addresses partitions
            if sd.kind == "lb" || sd.kind == "gateway" || sd.kind == "queue" || sd.fanout.unwrap_or(1.0) > 1.0 {
                pooled.insert(&e.target);
            }
            let data = nodes[ti].1.clone();
            let up = is_up(&data);
            out.entry(&e.source).or_default().push(Route { edge_id: e.id.clone(), target: e.target.clone(), data, up });
            *indeg.get_mut(e.target.as_str()).unwrap() += 1;
        }

        // Kahn topological order; nodes in cycles go at the end
        let mut order: Vec<String> = vec![];
        let mut ready: VecDeque<String> = nodes.iter().filter(|(id, _)| indeg[id.as_str()] == 0).map(|(id, _)| id.clone()).collect();
        let mut seen: HashSet<String> = HashSet::new();
        while let Some(id) = ready.pop_front() {
            if seen.contains(&id) {
                continue;
            }
            seen.insert(id.clone());
            order.push(id.clone());
            if let Some(rs) = out.get(id.as_str()) {
                for k in rs {
                    let v = indeg.get_mut(k.target.as_str()).unwrap();
                    *v -= 1;
                    if *v == 0 {
                        ready.push_back(k.target.clone());
                    }
                }
            }
        }
        for (id, _) in &nodes {
            if !seen.contains(id) {
                order.push(id.clone());
            }
        }

        let mut inflow: HashMap<String, f64> = HashMap::new();
        let mut edge_flow: HashMap<String, f64> = HashMap::new();
        let mut local: HashMap<String, Local> = HashMap::new();
        let mut promoted: HashSet<String> = HashSet::new();
        let clients: Vec<String> = nodes.iter().filter(|(_, d)| d.kind == "client" && d.alive).map(|(id, _)| id.clone()).collect();
        let per_client = if clients.is_empty() { 0.0 } else { (traffic * dt) / clients.len() as f64 };
        let empty: Vec<Route> = vec![];

        // ---- forward pass ----
        for id in &order {
            let d = nodes[by_id[id.as_str()]].1.clone();
            let routes = out.get(id.as_str()).unwrap_or(&empty).clone();
            let arrivals = if d.kind == "client" { if d.alive { per_client } else { 0.0 } } else { inflow.get(id).copied().unwrap_or(0.0) };
            let is_promoted = promoted.contains(id);
            let up_targets: HashMap<String, f64> = routes.iter().map(|k| (k.target.clone(), self.nodes.get(&k.target).map(|s| s.success).unwrap_or(1.0))).collect();
            let st = self.state(id);
            if d.kind == "replica" {
                st.failover = if is_promoted { Failover::Promoted } else { Failover::None };
            }
            if d.kind == "cache" || d.kind == "cdn" {
                // a dead or flushed cache comes back empty and re-warms from misses
                if !is_up(&d) || d.flushes.unwrap_or(0.0) != st.flush_seen {
                    st.cold_at = Some(now);
                }
                st.flush_seen = d.flushes.unwrap_or(0.0);
                st.warmth = cache_warmth(st.cold_at, now, d.warmup_s);
                if st.warmth > 0.999 {
                    st.cold_at = None;
                }
            }
            // a dead node fails everything (databases handle their own failover)
            let mut r = if !is_up(&d) && d.kind != "db" && d.kind != "client" {
                st.queue = 0.0;
                res(0.0, arrivals, 0.0, 0.0, false)
            } else {
                let ctx = Ctx { d: &d, arrivals, dt, cfg, read_ratio, routes: &routes, pooled: pooled.contains(id.as_str()) };
                process(&ctx, st)
            };
            // gray failure: the node answers a share of what it handles with errors
            if let Some(fr) = d.fault_rate.filter(|x| *x != 0.0 && !x.is_nan()) {
                if r.up && d.kind != "client" {
                    let bad = r.processed * fr;
                    r.failed += bad;
                    r.forward *= 1.0 - fr;
                    r.hits = Some(r.hits.unwrap_or(0.0) * (1.0 - fr));
                }
            }
            if d.kind == "db" && st.failover == Failover::Promoted {
                if let Some(t) = r.routes.as_ref().and_then(|rs| rs.first()) {
                    promoted.insert(t.target.clone());
                }
            }
            // generic caller behaviour: breaker first, then retries on whatever passes
            let targets = r.routes.clone().unwrap_or_else(|| routes.clone());
            st.breaker_pass = if targets.is_empty() { 1.0 } else { Self::breaker_pass(&d, st, dt, &mut events, id) };
            let retries = d.retries.unwrap_or(0.0);
            st.retry_amp = if retries > 0.0 && !targets.is_empty() { retry_amp(st.attempt_fail, retries, d.retry_policy.as_deref().unwrap_or("immediate")) } else { 1.0 };
            let forward = r.forward * st.breaker_pass * st.retry_amp * d.fanout.unwrap_or(1.0).max(1.0);

            // routing policy
            let mut flows: Vec<(String, f64)> = vec![];
            let mode = if r.shares.is_some() { "split".to_string() } else { d.routing.clone().unwrap_or_else(|| "split".into()) };
            if !targets.is_empty() && forward > 0.0 {
                if let Some(sh) = &r.shares {
                    for k in &targets {
                        flows.push((k.edge_id.clone(), forward * sh.get(&k.edge_id).copied().unwrap_or(0.0)));
                    }
                } else if mode == "fanout" {
                    for k in &targets {
                        flows.push((k.edge_id.clone(), forward));
                    }
                } else if mode == "failover" {
                    // children in order; whatever one failed last tick spills over to the next
                    let mut remaining = forward;
                    let mut ordered = targets.clone();
                    js_sort_by(&mut ordered, |a, b| {
                        let usage = |d: &NodeData| if spec(&d.kind).cost_per_request.map(|c| c != 0.0).unwrap_or(false) { 1.0 } else { 0.0 };
                        let u = (b.up as i32 - a.up as i32) as f64;
                        if u != 0.0 {
                            u
                        } else {
                            usage(&a.data) - usage(&b.data)
                        }
                    });
                    for k in &ordered {
                        flows.push((k.edge_id.clone(), remaining));
                        remaining *= if k.up { 1.0 - up_targets.get(&k.target).copied().unwrap_or(1.0) } else { 1.0 };
                        if remaining < 1e-9 {
                            break;
                        }
                    }
                } else {
                    for k in &targets {
                        flows.push((k.edge_id.clone(), forward / targets.len() as f64));
                    }
                }
                // a Map keeps one entry per edge: later writes replace earlier ones
                let mut dedup: Vec<(String, f64)> = vec![];
                for (eid, v) in flows.drain(..) {
                    if let Some(x) = dedup.iter_mut().find(|x| x.0 == eid) {
                        x.1 = v;
                    } else {
                        dedup.push((eid, v));
                    }
                }
                flows = dedup;
                for (eid, v) in &flows {
                    let k = targets.iter().find(|x| x.edge_id == *eid).unwrap();
                    *inflow.entry(k.target.clone()).or_insert(0.0) += v;
                    *edge_flow.entry(eid.clone()).or_insert(0.0) += v;
                }
            }
            let st = self.state(id);
            st.in_rps = ema(st.in_rps, arrivals / dt, dt, 0.6);
            st.drop_rps = ema(st.drop_rps, r.failed / dt, dt, 0.6);
            st.hit_rps = ema(st.hit_rps, r.hits.unwrap_or(0.0) / dt, dt, 0.6);
            st.util = ema(st.util, r.util, dt, 0.4);
            let local_share = r.local_share.unwrap_or(1.0);
            let own = if d.kind == "db" { arrivals * local_share } else { arrivals };
            st.drop_ratio = ema(st.drop_ratio, if own > 0.0 { r.failed / own } else { 0.0 }, dt, 0.6);
            local.insert(id.clone(), Local { local_share, routes: targets, flows, mode, up: r.up });
        }

        // ---- backward pass ----
        for i in (0..order.len()).rev() {
            let id = &order[i];
            let d = nodes[by_id[id.as_str()]].1.clone();
            let l = local.remove(id).unwrap();
            let has_kids = !l.routes.is_empty();
            // aggregate one downstream attempt according to the routing policy
            let (mut succ, mut lat) = (1.0, 0.0);
            if has_kids {
                let kids: Vec<(f64, f64, f64)> = l
                    .routes
                    .iter()
                    .map(|k| {
                        let s = self.nodes.get(&k.target).cloned().unwrap_or_else(fresh);
                        let link = edge_lat.get(k.edge_id.as_str()).copied().unwrap_or(0.0);
                        let f = l.flows.iter().find(|x| x.0 == k.edge_id).map(|x| x.1).unwrap_or(0.0);
                        (s.success, s.latency_ms + link, f)
                    })
                    .collect();
                if l.mode == "fanout" {
                    succ = kids.iter().fold(1.0, |p, k| p * k.0);
                    lat = js_max(f64::NEG_INFINITY, kids.iter().map(|k| k.1));
                } else if l.mode == "failover" {
                    let mut miss = 1.0;
                    for k in kids.iter().filter(|x| x.2 > 0.0) {
                        lat += miss * k.1;
                        miss *= 1.0 - k.0;
                    }
                    succ = 1.0 - miss;
                } else {
                    let (mut w, mut s) = (0.0, 0.0);
                    for k in &kids {
                        let wk = if k.2 > 0.0 { k.2 } else { 1e-9 };
                        w += wk;
                        s += k.0 * wk;
                        lat += k.1 * wk;
                    }
                    succ = s / w;
                    lat /= w;
                }
            }
            // scatter-gather: every partition must answer, and the caller waits for the slowest
            let degree = d.fanout.unwrap_or(1.0).max(1.0);
            if degree > 1.0 && has_kids {
                succ = succ.powf(degree);
                let kd = &l.routes[0].data;
                let p = kd.stall_rate.unwrap_or(0.0);
                lat = lat * fanout_tail(degree) + (1.0 - (1.0 - p).powf(degree) - p) * kd.stall_ms.unwrap_or(0.0);
            }
            let st = self.state(id);
            // caller deadline: answers slower than timeoutMs are failures to the caller
            let tmo = d.timeout_ms.filter(|t| *t != 0.0 && !t.is_nan());
            st.late_frac = match tmo {
                Some(t) if has_kids => late_frac(lat, t),
                _ => 0.0,
            };
            let attempt = succ * (1.0 - st.late_frac);
            if let Some(t) = tmo {
                lat = lat.min(t);
            }
            st.attempt_fail = if has_kids { 1.0 - attempt } else { 0.0 };
            // retries, then breaker (blocked calls fail fast or get the fallback)
            let mut child_succ = attempt;
            let mut child_lat = lat;
            let retries = d.retries.unwrap_or(0.0);
            if retries > 0.0 && has_kids {
                let policy = d.retry_policy.clone().unwrap_or_else(|| "immediate".into());
                child_succ = retry_success(attempt, retries, &policy, st.retry_amp);
                child_lat = lat * st.retry_amp + if policy == "backoff" { (st.retry_amp - 1.0) * BACKOFF_DELAY_MS * 4.0 } else { 0.0 };
            }
            if st.breaker_pass < 1.0 {
                let p = st.breaker_pass;
                child_succ = p * child_succ + (1.0 - p) * (if d.fallback == Some(true) { 1.0 } else { 0.0 });
                child_lat = p * child_lat + (1.0 - p) * 2.0;
            }
            let keep = 1.0 - st.drop_ratio;
            let (mut success, mut latency) = if l.up { fold(&FoldCtx { d: &d, keep, local_share: l.local_share, child_succ, child_lat, has_kids, cfg }, st) } else { (0.0, 0.0) };
            if l.up {
                if let Some(fl) = d.fault_latency_ms.filter(|x| *x != 0.0 && !x.is_nan()) {
                    latency += fl;
                }
            }
            let _ = &mut success;
            st.success = ema(st.success, success, dt, 0.3);
            st.latency_ms = ema(st.latency_ms, latency, dt, 0.3);
            let usage = usage_cost(&d, st, profile);
            let billed = self.scalers.get(id).map(|s| s.live + s.pending.len() as f64);
            let st = self.state(id);
            st.cost_per_hour = cost_of(&match billed {
                Some(b) => NodeData { instances: Some(b), ..d.clone() },
                None => d.clone(),
            }, profile) + usage;
            let over = l.up && d.kind != "client" && d.kind != "queue" && st.drop_rps > (st.in_rps * 0.02).max(1.0);
            if over && !st.overloaded {
                events.push(SimEvent { kind: "overload".into(), node_id: id.clone(), name: d.name.clone(), detail: None });
            }
            if !over && st.overloaded {
                events.push(SimEvent { kind: "recovered".into(), node_id: id.clone(), name: d.name.clone(), detail: None });
            }
            st.overloaded = over;
            if d.kind == "db" && st.failover == Failover::Promoted {
                if let Some(fs) = cfg.failover_s {
                    if st.down_for - dt < fs {
                        events.push(SimEvent { kind: "failover".into(), node_id: id.clone(), name: d.name.clone(), detail: None });
                    }
                }
            }
        }

        // autoscalers react to the demand they saw this tick
        let ids: Vec<String> = self.scalers.keys().cloned().collect();
        for id in ids {
            let orig = match original.get(id.as_str()) {
                Some(o) => *o,
                None => continue,
            };
            let demand = self.state(&id).in_rps;
            let per = per_instance_capacity(orig);
            let sc = self.scalers.get_mut(&id).unwrap();
            for (kind, from, to) in step_scaler(sc, orig, now, demand, per) {
                if kind != "scaled" {
                    events.push(SimEvent { kind: kind.into(), node_id: id.clone(), name: orig.name.clone(), detail: Some(format!("{} → {}", js_num(from), js_num(to))) });
                }
            }
        }

        let live: HashSet<&str> = edges.iter().map(|e| e.id.as_str()).collect();
        self.edges.retain(|k, _| live.contains(k.as_str()));
        for e in edges {
            let prev = self.edges.get(&e.id).copied().unwrap_or(0.0);
            let next = ema(prev, edge_flow.get(&e.id).copied().unwrap_or(0.0) / dt, dt, 0.6);
            self.edges.insert(e.id.clone(), next);
        }
        self.nodes.retain(|k, _| by_id.contains_key(k.as_str()));

        // ---- global ----
        let (mut rps, mut ok, mut lat) = (0.0, 0.0, 0.0);
        for c in &clients {
            let st = self.state(c);
            rps += st.in_rps;
            ok += st.in_rps * st.success;
            lat += st.in_rps * st.latency_ms;
        }
        let cost = nodes.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>().iter().fold(0.0, |s, id| s + self.state(id).cost_per_hour);
        let g = &mut self.global;
        g.t = self.t;
        g.rps = rps;
        g.error_rate = if rps > 0.5 { (1.0 - ok / rps).max(0.0) } else { 0.0 };
        // failed requests count as timeouts: with ≥1% failures the 99th percentile *is* a failure
        let ok_lat = if ok > 0.0 { (lat / rps) * 1.8 } else { 0.0 };
        g.p99 = if rps < 0.5 { 0.0 } else if g.error_rate >= 0.01 { ok_lat.max(cfg.timeout_s * 1000.0) } else { ok_lat };
        g.cost = cost;
        self.since_history += dt;
        if self.since_history >= HISTORY_EVERY_S {
            self.since_history = 0.0;
            let g = &mut self.global;
            g.history.push(HistoryPoint { rps: g.rps, err: g.error_rate, p99: g.p99, cost: g.cost });
            if g.history.len() > HISTORY_LEN {
                let k = g.history.len() - HISTORY_LEN;
                g.history.drain(..k);
            }
            for st in self.nodes.values_mut() {
                st.history.push_back(st.util);
                while st.history.len() > HISTORY_LEN {
                    st.history.pop_front();
                }
            }
        }
        events
    }

    pub fn snapshot(&mut self, nodes: &[SimNode], edges: &[SimEdge]) -> Snapshot {
        let mut node_stats = IndexMap::new();
        for n in nodes {
            let scaling = self.scalers.get(&n.id).map(|s| Scaling { live: s.live, pending: s.pending.len() as f64, desired: s.desired });
            let st = self.state(&n.id);
            node_stats.insert(
                n.id.clone(),
                NodeStats {
                    in_rps: st.in_rps,
                    drop_rps: st.drop_rps,
                    util: st.util,
                    queue: st.queue,
                    latency_ms: st.latency_ms,
                    success: st.success,
                    hit_rps: st.hit_rps,
                    reachable: st.reachable,
                    lag_s: if st.drain_rps > 0.0 { st.queue / st.drain_rps } else if st.queue > 1.0 { f64::INFINITY } else { 0.0 },
                    cold_frac: st.cold_frac,
                    failover: failover_name(st.failover).into(),
                    cost_per_hour: st.cost_per_hour,
                    retry_amp: st.retry_amp,
                    breaker: if n.data.breaker == Some(true) {
                        Some(
                            match st.breaker {
                                Breaker::Closed => "closed",
                                Breaker::Open => "open",
                                Breaker::Half => "half",
                            }
                            .into(),
                        )
                    } else {
                        None
                    },
                    late_frac: st.late_frac,
                    history: st.history.iter().copied().collect(),
                    scaling,
                    warmth: st.warmth,
                },
            );
        }
        let mut edge_stats = IndexMap::new();
        for e in edges {
            let (success, util) = {
                let t = self.state(&e.target);
                (t.success, t.util)
            };
            edge_stats.insert(e.id.clone(), EdgeStats { rps: self.edges.get(&e.id).copied().unwrap_or(0.0), err_ratio: 1.0 - success, util });
        }
        Snapshot { node_stats, edge_stats, global: self.global.clone() }
    }
}
