//! The design simulator's fluid, tick-based engine (src/sim/engine.ts, autoscale.ts, components/).
//!
//! Each tick, request volume flows from clients through the graph in topological order (forward
//! pass), then end-to-end success and latency fold back from the leaves (backward pass). Per-kind
//! behaviour is a match on the kind; routing (split | fanout | failover), retries, circuit breakers,
//! caller deadlines, autoscalers, cost and the global SLO numbers apply to any node.

#[allow(unused_imports)]
use crate::fmath::JsMath;
use super::catalog::*;
use crate::backtest::{js_max, js_sort_by};
use crate::math::{js_num, js_round};
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
        EngineConfig { timeout_s: 1.0, failover_s: Some(60.0), cold_start_ms: 400.0 }
    }
}

const HISTORY_LEN: usize = 90;
const HISTORY_EVERY_S: f64 = 0.25;
const TRIP_FAIL: f64 = 0.5;
/// the discrete-event engine judges a breaker on 1 s windows, closed on ten calls or more, half open on three
const BR_WINDOW_S: f64 = 1.0;
const BR_MIN_CALLS: f64 = 10.0;
const BR_HALF_MIN_CALLS: f64 = 3.0;
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
    /// calls per request over this link (a tweet written to N timelines, N lookups per page)
    pub calls: Option<f64>,
    /// "reads" or "writes": the link carries only that class (CQRS); None: both
    pub carries: Option<String>,
    /// database → replica: "sync" — every write waits for this replica's acknowledgement
    pub replication: Option<String>,
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

pub fn new_scaler_pub(d: &NodeData) -> ScalerState {
    new_scaler(d)
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
pub fn step_scaler_pub(s: &mut ScalerState, d: &NodeData, now: f64, demand: f64, per_instance: f64) -> Vec<(&'static str, f64, f64)> {
    step_scaler(s, d, now, demand, per_instance)
}

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
    /// success of reads and of writes on their own (a write-only failure is not retried away)
    pub success_r: f64,
    pub success_w: f64,
    pub latency_ms: f64,
    /// p99 − mean of the answers this component gives (its own tail and what it waits on)
    pub tail_ms: f64,
    /// the latency of this component's successful answers as a small mixture of (weight, mean, p99 − mean):
    /// a cache's hits and misses, a fast branch and a slow one
    pub dist: Vec<[f64; 3]>,
    pub drop_ratio: f64,
    pub history: VecDeque<f64>,
    pub overloaded: bool,
    pub reachable: f64,
    pub drain_rps: f64,
    /// what reached it last tick from callers other than queues, req/s: a queue's consumers pull
    /// only with what that leaves free
    pub pushed_rps: f64,
    /// a consumer that also takes calls: the share of its work pulled from queues last tick. Pulled
    /// messages only fill workers the calls leave idle, and a call takes the next free one, so
    /// the calls wait as if those messages were not there
    pub pulled_share: f64,
    pub warm: f64,
    /// a function's execution environments in their cold start: (done at, how many)
    pub cold_starts: Vec<(f64, f64)>,
    pub cold_frac: f64,
    pub down_for: f64,
    pub cost_per_hour: f64,
    pub failover: Failover,
    pub attempt_fail: f64,
    pub retry_amp: f64,
    pub breaker: Breaker,
    pub breaker_t: f64,
    /// half open: how far the probes' windows have gone towards reopening it
    pub breaker_h: f64,
    pub breaker_pass: f64,
    pub late_frac: f64,
    pub cold_at: Option<f64>,
    pub flush_seen: f64,
    pub warmth: f64,
    /// write-behind: writes acknowledged but not yet flushed to the origin
    pub wb_buffer: f64,
    /// write-behind: flushed to the origin this tick
    pub wb_flushed: f64,
    /// a replica's replication lag behind its primary, s
    pub repl_lag: f64,
    /// a sharded database: the busiest shard's backlog (`queue` and `util` are the busiest shard's
    /// utilisation and the rest's backlog), and the other shards' utilisation
    pub hot_queue: f64,
    /// a database: writes waiting for the hot row's lock
    pub lock_queue: f64,
    /// a gateway's token bucket (NaN: not started — full)
    pub tokens: f64,
    /// a queue: what it handed its consumers this tick, the failed messages due back (when, how
    /// many), and the dead letters a second
    pub forwarded: f64,
    pub redrive: Vec<(f64, f64)>,
    pub dead_letter_rps: f64,
    pub cold_util: f64,
    /// how long this component has been down, s (DNS answers lag it)
    pub dead_for: f64,
    /// a stream: each subscriber's backlog, by its link
    pub sub_backlog: Vec<(usize, f64)>,
    /// how long a request waits on this component's calls, ms (what a thread is held for beyond the work)
    pub hold_ms: f64,
    /// this component's own time per request, ms: its work and its queue, not what it waits on
    pub own_ms: f64,
}

/// how much faster than real time a replica catches up once it can reach its primary again
pub const CATCH_UP: f64 = 10.0;

/// write-behind: the mean wait before a buffered write is flushed to the origin, s
pub const WRITE_BEHIND_S: f64 = 5.0;

fn fresh() -> NodeState {
    NodeState {
        queue: 0.0,
        in_rps: 0.0,
        drop_rps: 0.0,
        hit_rps: 0.0,
        util: 0.0,
        success: 1.0,
        success_r: 1.0,
        success_w: 1.0,
        latency_ms: 0.0,
        tail_ms: 0.0,
        dist: vec![],
        drop_ratio: 0.0,
        history: VecDeque::new(),
        overloaded: false,
        reachable: 1.0,
        drain_rps: 0.0,
        pushed_rps: 0.0,
        pulled_share: 0.0,
        warm: 0.0,
        cold_starts: vec![],
        cold_frac: 0.0,
        down_for: 0.0,
        cost_per_hour: 0.0,
        failover: Failover::None,
        attempt_fail: 0.0,
        retry_amp: 1.0,
        breaker: Breaker::Closed,
        breaker_t: 0.0,
        breaker_h: 0.0,
        breaker_pass: 1.0,
        late_frac: 0.0,
        cold_at: None,
        flush_seen: 0.0,
        warmth: 1.0,
        wb_buffer: 0.0,
        wb_flushed: 0.0,
        repl_lag: 0.0,
        hot_queue: 0.0,
        lock_queue: 0.0,
        tokens: f64::NAN,
        forwarded: 0.0,
        redrive: vec![],
        dead_letter_rps: 0.0,
        cold_util: 0.0,
        dead_for: 0.0,
        sub_backlog: vec![],
        hold_ms: 0.0,
        own_ms: 0.0,
    }
}

fn ema(prev: f64, next: f64, dt: f64, tau: f64) -> f64 {
    prev + (next - prev) * (1.0 - (-dt / tau).js_exp())
}

/// node data with dynamic effects applied: autoscaled instance count, and the throughput lost to
/// injected latency (a pool of workers that each take longer serves fewer requests per second)
pub fn dynamic_data(d: &NodeData, scaler: Option<&ScalerState>) -> NodeData {
    let mut e = effective_data(d, scaler);
    if let Some(fl) = e.fault_latency_ms.filter(|x| *x != 0.0 && !x.is_nan()) {
        if !matches!(d.kind.as_str(), "gateway" | "llmapi" | "external" | "kv" | "archive" | "client" | "queue" | "stream") {
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
        sum += f.js_pow(k);
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
    1.0 - f.js_pow(retries + 1.0)
}

/// expected max of N long-tailed latencies relative to one
pub fn fanout_tail(n: f64) -> f64 {
    if n <= 1.0 {
        1.0
    } else {
        1.0 + 0.6 * (2.0 * n.js_ln()).sqrt()
    }
}

/// chance that a window of `n` calls, each failing with chance `p`, measures a failure rate past `t`
/// (the binomial by its normal approximation, with the continuity correction)
fn window_above(p: f64, n: f64, t: f64) -> f64 {
    let sd = (n * p * (1.0 - p)).sqrt();
    if sd < 1e-9 {
        return if p > t { 1.0 } else { 0.0 };
    }
    crate::math::normal_tail(((t * n).floor() + 0.5 - p * n) / sd)
}

/// share of answers slower than a deadline, for answers with this mean and p99 − mean: right-skewed,
/// about 40% above the mean, 1% above the p99, decaying exponentially in between and beyond
fn late_share(mean: f64, tail: f64, deadline: f64) -> f64 {
    if !mean.is_finite() {
        return 1.0;
    }
    let x = (deadline - mean) / tail.max(1e-6).max(mean * 0.05);
    if x >= 0.0 {
        0.4 * 0.025_f64.js_pow(x)
    } else {
        1.0 - 0.6 * (3.0 * x).js_exp()
    }
}

/// an outgoing connection: edge index, target node index, target up
#[derive(Clone, Copy, Debug)]
pub struct Route {
    pub e: usize,
    pub t: usize,
    pub up: bool,
}

struct ProcessResult {
    processed: f64,
    failed: f64,
    forward: f64,
    routes: Option<Vec<Route>>,
    /// explicit share per edge index, bypassing the routing policy
    shares: Option<Vec<(usize, f64)>>,
    local_share: Option<f64>,
    hits: Option<f64>,
    /// processed work this component already failed itself (nowhere to send it)
    failed_processed: f64,
    /// of what it forwards, the share that is reads (None: the share it received)
    fwd_read_share: Option<f64>,
    /// shares of reads and of writes answered here (None: local_share for both)
    local_r: Option<f64>,
    local_w: Option<f64>,
    /// share of writes failed here (a synchronous replica out of reach)
    write_fail: f64,
    /// what every write waits on beyond the component itself (synchronous replicas), ms
    write_extra_ms: f64,
    /// a sharded database: the shards other than the busiest one
    cold_util: Option<f64>,
    util: f64,
    up: bool,
}

fn res(processed: f64, failed: f64, forward: f64, util: f64, up: bool) -> ProcessResult {
    ProcessResult { processed, failed, forward, routes: None, shares: None, local_share: None, hits: None, failed_processed: 0.0, fwd_read_share: None, local_r: None, local_w: None, write_fail: 0.0, write_extra_ms: 0.0, cold_util: None, util, up }
}

fn queue_seconds(d: &NodeData, cfg: &EngineConfig) -> f64 {
    d.queue_s.or(spec(&d.kind).queue_s).unwrap_or(cfg.timeout_s)
}

/// bounded FIFO queue in front of a fixed capacity: work beyond `queue_s` seconds of capacity is shed
fn queue_stage(st: &mut NodeState, arrivals: f64, cap_per_s: f64, dt: f64, queue_s: f64) -> (f64, f64, f64) {
    queue_on(&mut st.queue, arrivals, cap_per_s, dt, queue_s)
}

fn queue_on(queue: &mut f64, arrivals: f64, cap_per_s: f64, dt: f64, queue_s: f64) -> (f64, f64, f64) {
    let cap = (cap_per_s * dt).max(1e-9);
    *queue += arrivals;
    let processed = queue.min(cap);
    *queue -= processed;
    let max_q = cap_per_s * queue_s;
    let mut failed = 0.0;
    if *queue > max_q {
        failed = *queue - max_q;
        *queue = max_q;
    }
    (processed, failed, if cap_per_s > 0.0 { arrivals / cap } else { 0.0 })
}

/// service time plus the wait in front of it: a component is a pool of workers (capacity × service
/// time of them, as the discrete-event engine runs it), waiting as M/M/c; past saturation, the backlog
fn service_latency(d: &NodeData, st: &NodeState) -> f64 {
    shard_parts(d, st).iter().map(|p| p.0 * p.1).sum()
}

/// a component's own answer time as (weight, mean, p99 − mean) parts: one for most, and for a sharded
/// database the busiest shard and the rest, each a pool of workers of its own
fn shard_parts(d: &NodeData, st: &NodeState) -> Vec<(f64, f64, f64)> {
    let n = shards_of(d);
    let total = capacity_of(d, Some(st.reachable)).max(1e-6);
    // a replica's shards share its reads evenly: one pool
    if n <= 1.0 || d.kind != "db" {
        let (m, t) = pool_latency(d, total, st.util * (1.0 - st.pulled_share), st.queue);
        return vec![(1.0, m, t)];
    }
    let s = hot_shard_share(d);
    let one = total / n;
    let (hm, ht) = pool_latency(d, one, st.util, st.hot_queue);
    let (cm, ct) = pool_latency(d, one * (n - 1.0), st.cold_util, st.queue);
    vec![(s, hm, ht), (1.0 - s, cm, ct)]
}

/// mean and p99 − mean of an answer from a pool of workers at a utilisation, with a backlog
fn pool_latency(d: &NodeData, cap: f64, util: f64, queue: f64) -> (f64, f64) {
    let base = base_latency_of(d);
    let cap = cap.max(1e-6);
    let workers = js_round(cap * (base.max(0.05) / 1000.0)).max(1.0);
    let w = crate::math::mmc_wait(util.min(0.98) * cap, workers, cap);
    let mean = base + w.mean_ms * WAIT_SCALE + (queue / cap.max(1.0)) * 1000.0 + d.stall_rate.unwrap_or(0.0) * d.stall_ms.unwrap_or(0.0);
    let stall = if d.stall_rate.unwrap_or(0.0) >= 0.01 { d.stall_ms.unwrap_or(0.0) } else { 0.0 };
    // service time and wait are independent: their spreads add in quadrature
    let (svc, wait) = ((SERVICE_P99 - 1.0) * base, (w.p99_ms - w.mean_ms).max(0.0) * WAIT_SCALE);
    (mean, (svc * svc + wait * wait).sqrt() + stall)
}

/// share of a mixture's answers slower than a deadline
fn mix_late(dist: &[[f64; 3]], deadline: f64) -> f64 {
    let w: f64 = dist.iter().map(|c| c[0]).sum();
    if w <= 0.0 {
        return 0.0;
    }
    dist.iter().map(|c| c[0] * late_share(c[1], c[2], deadline)).sum::<f64>() / w
}

/// a mixture's mean and 99th percentile
fn mix_mean_p99(dist: &[[f64; 3]]) -> (f64, f64) {
    let w: f64 = dist.iter().map(|c| c[0]).sum();
    if w <= 0.0 {
        return (0.0, 0.0);
    }
    let mean = dist.iter().map(|c| c[0] * c[1]).sum::<f64>() / w;
    let (mut lo, mut hi) = (0.0, dist.iter().map(|c| c[1] + 4.0 * c[2] + 1.0).fold(0.0, f64::max));
    for _ in 0..40 {
        let mid = (lo + hi) / 2.0;
        if mix_late(dist, mid) > 0.01 {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    (mean, hi)
}

/// a mixture's q-quantile (the share above it is 1 − q)
pub fn mix_quantile(dist: &[[f64; 3]], q: f64) -> f64 {
    let w: f64 = dist.iter().map(|c| c[0]).sum();
    if w <= 0.0 {
        return 0.0;
    }
    let (mut lo, mut hi) = (0.0, dist.iter().map(|c| c[1] + 4.0 * c[2] + 1.0).fold(0.0, f64::max));
    for _ in 0..40 {
        let mid = (lo + hi) / 2.0;
        if mix_late(dist, mid) > 1.0 - q {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    hi
}

/// at most four components: the two closest in mean merge until it fits
fn mix_merge(mut dist: Vec<[f64; 3]>) -> Vec<[f64; 3]> {
    dist.retain(|c| c[0] > 1e-12 && c[1].is_finite());
    dist.sort_by(|a, b| a[1].partial_cmp(&b[1]).unwrap_or(std::cmp::Ordering::Equal));
    while dist.len() > 4 {
        let k = (0..dist.len() - 1).min_by(|&a, &b| (dist[a + 1][1] - dist[a][1]).partial_cmp(&(dist[b + 1][1] - dist[b][1])).unwrap_or(std::cmp::Ordering::Equal)).unwrap();
        let (x, y) = (dist[k], dist[k + 1]);
        let w = x[0] + y[0];
        let m = (x[0] * x[1] + y[0] * y[1]) / w;
        let p = (x[0] * (x[1] + x[2]) + y[0] * (y[1] + y[2])) / w;
        dist[k] = [w, m, (p - m).max(0.0)];
        dist.remove(k + 1);
    }
    dist
}

/// a mixture whose every answer also spends `mean` (spread `tail`) here
fn mix_then(dist: &[[f64; 3]], mean: f64, tail: f64, weight: f64) -> Vec<[f64; 3]> {
    let w: f64 = dist.iter().map(|c| c[0]).sum::<f64>().max(1e-12);
    dist.iter().map(|c| [c[0] / w * weight, c[1] + mean, (c[2] * c[2] + tail * tail).sqrt()]).collect()
}

/// how long an idle execution environment is kept before it is reclaimed, s (Lambda keeps them for minutes)
const FN_IDLE_S: f64 = 300.0;

/// a function's cold start, ms: its runtime's, or the configured default
fn cold_start_of(d: &NodeData, cfg: &EngineConfig) -> f64 {
    match d.runtime.as_deref().filter(|r| !r.is_empty()) {
        Some(r) if cfg.cold_start_ms > 0.0 => runtime(r).2,
        _ => cfg.cold_start_ms,
    }
}

/// lognormal service times (cv 0.6, as the discrete-event engine samples them): p99 ≈ 3.1 × mean
const SERVICE_P99: f64 = 3.11;
/// someone else's API answers more steadily than your own service (the DES samples it at half the
/// spread, cv 0.3): lognormal p99 = exp(−σ²/2 + 2.326σ) with σ² = ln(1 + 0.3²) — about 1.9 × mean
const API_P99: f64 = 1.896;
/// waits under Poisson arrivals and service of that variability, relative to M/M/c (Allen–Cunneen):
/// (1 + cv²) / 2
const WAIT_SCALE: f64 = 0.68;

/// p99 − mean of a component's own part of an answer: service-time spread, the M/M/c wait's tail,
/// and stalls once they reach 1% of requests
fn service_tail(d: &NodeData, st: &NodeState) -> f64 {
    let parts = shard_parts(d, st);
    if parts.len() == 1 {
        return parts[0].2;
    }
    let dist: Vec<[f64; 3]> = parts.iter().map(|p| [p.0, p.1, p.2]).collect();
    let (mean, p99) = mix_mean_p99(&dist);
    (p99 - mean).max(0.0)
}

#[derive(Clone, Copy)]
struct Ctx<'a> {
    d: &'a NodeData,
    /// every node's data this tick (a route's target by index)
    data: &'a [NodeData],
    arrivals: f64,
    dt: f64,
    cfg: &'a EngineConfig,
    read_ratio: f64,
    routes: &'a [Route],
    pooled: bool,
    /// per edge: replicated synchronously; its network round trip
    edge_sync: &'a [bool],
    edge_lat: &'a [f64],
    /// every node's replication lag last tick, s
    lags: &'a [f64],
    /// how long each node has been down, s
    dead: &'a [f64],
    /// the simulation clock, s
    now: f64,
    /// every node's arrivals last tick from callers other than queues, req/s
    pushed: &'a [f64],
    /// every node's capacity for messages pulled from a queue, req/s
    pull_cap: &'a [f64],
}

fn reachable(c: &Ctx) -> f64 {
    let up = (c.d.instances.unwrap_or(1.0) - c.d.down.unwrap_or(0.0)).max(0.0);
    if c.pooled || c.d.kind == "llm" || clustered(&c.d.kind) {
        up
    } else {
        up.min(1.0)
    }
}

fn process_through(c: &Ctx, st: &mut NodeState) -> ProcessResult {
    if spec(&c.d.kind).scalable {
        st.reachable = reachable(c);
    }
    let cap = threads_capacity(c.d, st.reachable, st.hold_ms).min(capacity_of(c.d, Some(st.reachable)));
    let (processed, failed, util) = queue_stage(st, c.arrivals, cap, c.dt, queue_seconds(c.d, c.cfg));
    res(processed, failed, processed, util, true)
}

/// a bulkhead's admitted share of the calls over one link: at most `bulkhead` calls per instance wait
/// on it at once (calls in flight = rate × latency)
pub fn bulkhead_admit(d: &NodeData, reachable: f64, rps: f64, latency_ms: f64) -> f64 {
    match d.bulkhead.filter(|b| *b > 0.0) {
        Some(b) => {
            let inflight = rps * latency_ms.max(0.0) / 1000.0;
            let allowed = b * reachable.max(1.0);
            if inflight > allowed { allowed / inflight } else { 1.0 }
        }
        None => 1.0,
    }
}

/// thread-per-request: a thread is held for the work and every call it waits on, so the instances'
/// threads finish at most threads ÷ hold time requests a second (Little's law). Unlimited when async
pub fn threads_capacity(d: &NodeData, reachable: f64, hold_ms: f64) -> f64 {
    match d.threads.filter(|t| *t > 0.0 && (d.kind == "server" || d.kind == "worker")) {
        Some(t) => t * reachable.max(0.0) / ((base_latency_of(d) + hold_ms.max(0.0)) / 1000.0).max(1e-4),
        None => f64::INFINITY,
    }
}

fn process(c: &Ctx, st: &mut NodeState) -> ProcessResult {
    match c.d.kind.as_str() {
        "client" => res(c.arrivals, 0.0, c.arrivals, 0.0, c.d.alive),
        "lb" => {
            // a connection limit refuses first: the rest is what the balancer passes on
            let admit = connection_admit(c.d, c.arrivals / c.dt);
            let refused = c.arrivals * (1.0 - admit);
            let c = &Ctx { arrivals: c.arrivals - refused, ..*c };
            let mut r = process_through(c, st);
            let routes: Vec<Route> = c.routes.iter().filter(|k| k.up).cloned().collect();
            if routes.is_empty() {
                r.failed += r.processed;
                r.failed_processed = r.processed;
                r.forward = 0.0;
            }
            r.failed += refused;
            r.processed += refused;
            r.failed_processed += refused;
            r.routes = Some(routes);
            r
        }
        "dns" => {
            // a target cut off by a partition (alive, unreachable) is noticed at once: only deaths lag
            let targets: Vec<(bool, f64)> = c.routes.iter().map(|k| (k.up, if k.up { 0.0 } else { c.dead[k.t] })).collect();
            let stale = dns_stale_share(c.d, &targets);
            let routes: Vec<Route> = c.routes.iter().filter(|k| k.up).cloned().collect();
            let mut r = if routes.is_empty() { res(c.arrivals, c.arrivals, 0.0, 0.0, c.d.alive) } else { res(c.arrivals, c.arrivals * stale, c.arrivals * (1.0 - stale), 0.0, c.d.alive) };
            if routes.is_empty() {
                r.failed_processed = c.arrivals;
            }
            r.routes = Some(routes);
            r
        }
        "gateway" => {
            let admit = connection_admit(c.d, c.arrivals / c.dt);
            let refused = c.arrivals * (1.0 - admit);
            let c = &Ctx { arrivals: c.arrivals - refused, ..*c };
            let limit = c.d.limit.unwrap_or(f64::INFINITY);
            // a token bucket: refilled at the limit, holding up to the burst
            let burst = c.d.burst.filter(|b| *b > 0.0).unwrap_or(limit);
            st.tokens = if st.tokens.is_nan() { burst } else { (st.tokens + limit * c.dt).min(burst) };
            let processed = c.arrivals.min(st.tokens.max(0.0));
            st.tokens -= processed;
            let routes: Vec<Route> = c.routes.iter().filter(|k| k.up).cloned().collect();
            let failed = c.arrivals - processed + (if routes.is_empty() { processed } else { 0.0 });
            let mut r = res(processed, failed, if routes.is_empty() { 0.0 } else { processed }, c.arrivals / (limit * c.dt), true);
            if r.forward == 0.0 {
                r.failed_processed = processed;
            }
            r.failed += refused;
            r.processed += refused;
            r.failed_processed += refused;
            r.routes = Some(routes);
            r
        }
        "cache" | "cdn" => {
            let mut r = process_through(c, st);
            // only reads can hit; writes go on to the origin, or wait in the cache (write-behind)
            let h = cache_hit_rate(c.d) * st.warmth;
            let reads = r.processed * c.read_ratio;
            let writes = r.processed - reads;
            let hits = reads * h;
            let behind = c.d.write_policy.as_deref() == Some("behind");
            let (mut forward, local) = if behind {
                st.wb_buffer += writes;
                let flushed = st.wb_buffer * (1.0 - (-c.dt / WRITE_BEHIND_S).js_exp());
                st.wb_buffer -= flushed;
                st.wb_flushed = flushed;
                (reads - hits + flushed, hits + writes)
            } else {
                st.wb_flushed = 0.0;
                (r.processed - hits, hits)
            };
            if c.routes.is_empty() {
                r.failed += forward;
                r.failed_processed = forward;
                forward = 0.0;
            }
            let fwd_reads = reads - hits;
            r.local_r = Some(h);
            r.local_w = Some(if behind { 1.0 } else { 0.0 });
            r.fwd_read_share = Some(if forward > 0.0 { (fwd_reads / forward).min(1.0) } else { 0.0 });
            r.forward = forward;
            r.hits = Some(hits);
            r.local_share = Some(if r.processed > 0.0 { (local / r.processed).min(1.0) } else { h * c.read_ratio + if behind { 1.0 - c.read_ratio } else { 0.0 } });
            r
        }
        "db" => {
            let d = c.d;
            let write_ratio = 1.0 - c.read_ratio;
            let mut replicas: Vec<Route> = c.routes.iter().filter(|k| c.data[k.t].kind == "replica" && k.up).cloned().collect();
            // the replica furthest along is the one promoted
            replicas.sort_by(|a, b| c.lags[a.t].partial_cmp(&c.lags[b.t]).unwrap_or(std::cmp::Ordering::Equal));
            st.failover = Failover::None;
            let mut shares = None;
            if !d.alive {
                st.down_for += c.dt;
                if let (false, Some(fs)) = (replicas.is_empty(), failover_after(d, c.cfg.failover_s)) {
                    if st.down_for >= fs {
                        // first replica is the new primary: all writes plus its share of reads
                        st.failover = Failover::Promoted;
                        let n = replicas.len() as f64;
                        shares = Some(replicas.iter().enumerate().map(|(i, k)| (k.e, c.read_ratio / n + if i == 0 { write_ratio } else { 0.0 })).collect::<Vec<_>>());
                    } else {
                        st.failover = Failover::Electing;
                    }
                }
            } else {
                st.down_for = 0.0;
            }
            if !d.alive && st.failover == Failover::None {
                st.queue = 0.0;
                st.hot_queue = 0.0;
                return res(0.0, c.arrivals, 0.0, 0.0, false);
            }
            if st.failover == Failover::Promoted {
                st.queue = 0.0;
                st.hot_queue = 0.0;
                let mut r = res(0.0, 0.0, c.arrivals, 0.0, true);
                r.routes = Some(replicas);
                r.shares = shares;
                r.local_share = Some(0.0);
                r.local_r = Some(0.0);
                r.local_w = Some(0.0);
                return r;
            }
            // electing: the replicas take every read; only writes wait (and fail) on the primary
            let electing = st.failover == Failover::Electing;
            let local_share = if electing { write_ratio } else { write_ratio + c.read_ratio / (replicas.len() as f64 + 1.0) };
            let to_replicas = c.arrivals * (1.0 - local_share);
            let cap = if st.failover == Failover::Electing { 0.0 } else { capacity_of(d, None) };
            let n = shards_of(d);
            let mut own = c.arrivals - to_replicas;
            let mut cold_util = None;
            // writes to the hot row take its lock one at a time, apart from the pool
            let h = if electing { 0.0 } else { d.hot_row_share.unwrap_or(0.0).clamp(0.0, 1.0) };
            let (lp, lf, lu) = if h > 0.0 {
                let hot_w = c.arrivals * write_ratio * h;
                own -= hot_w;
                queue_on(&mut st.lock_queue, hot_w, row_lock_rps(d), c.dt, queue_seconds(d, c.cfg))
            } else {
                st.lock_queue = 0.0;
                (0.0, 0.0, 0.0)
            };
            let (processed, failed, util) = if n > 1.0 {
                // the busiest shard (the hot key's) and the rest, each with its own queue
                let s = hot_shard_share(d);
                let qs = queue_seconds(d, c.cfg);
                let (hp, hf, hu) = queue_on(&mut st.hot_queue, own * s, cap / n, c.dt, qs);
                let (cp, cf, cu) = queue_on(&mut st.queue, own * (1.0 - s), cap * (n - 1.0) / n, c.dt, qs);
                cold_util = Some(cu);
                (hp + cp, hf + cf, hu)
            } else {
                queue_stage(st, own, cap, c.dt, queue_seconds(d, c.cfg))
            };
            let mut r = res(processed + lp, failed + lf, to_replicas, util.max(lu), true);
            r.cold_util = cold_util;
            r.routes = Some(replicas);
            r.local_share = Some(local_share);
            // what goes to the replicas is reads; writes stay on the primary
            r.fwd_read_share = Some(1.0);
            r.local_r = Some(if electing { 0.0 } else { 1.0 / (r.routes.as_ref().map(|x| x.len()).unwrap_or(0) as f64 + 1.0) });
            r.local_w = Some(1.0);
            // synchronous replicas: every write waits for the slowest one's acknowledgement, and fails
            // while any of them is out of reach
            let sync: Vec<&Route> = c.routes.iter().filter(|k| c.edge_sync[k.e] && c.data[k.t].kind == "replica").collect();
            if sync.iter().any(|k| !k.up) {
                r.write_fail = 1.0;
            } else if !sync.is_empty() {
                r.write_extra_ms = sync.iter().map(|k| c.edge_lat[k.e] + base_latency_of(&c.data[k.t])).fold(0.0, f64::max);
            }
            r
        }
        "queue" => {
            st.queue += c.arrivals;
            // failed messages visible again (a redrive policy)
            let due: f64 = st.redrive.iter().filter(|x| x.0 <= c.now).map(|x| x.1).sum();
            st.redrive.retain(|x| x.0 > c.now);
            st.queue += due;
            let mut failed = 0.0;
            if st.queue > QUEUE_MAX_BACKLOG {
                failed = st.queue - QUEUE_MAX_BACKLOG;
                st.queue = QUEUE_MAX_BACKLOG;
            }
            let routes: Vec<Route> = c.routes.iter().filter(|k| k.up).cloned().collect();
            // consumers pull: each takes messages only with the capacity what is pushed at it leaves
            // free (a worker that also serves calls does not drop them to make room for the queue)
            let free: Vec<f64> = routes.iter().map(|k| (c.pull_cap[k.t] - c.pushed[k.t]).max(0.0)).collect();
            let drain: f64 = free.iter().sum();
            st.drain_rps = drain;
            let processed = st.queue.min(drain * c.dt);
            st.queue -= processed;
            st.forwarded = processed;
            let mut r = res(processed, failed, processed, st.queue / QUEUE_MAX_BACKLOG, true);
            if drain > 0.0 && routes.iter().any(|k| c.pushed[k.t] > 0.0) {
                r.shares = Some(routes.iter().zip(&free).map(|(k, f)| (k.e, f / drain)).collect());
            }
            r.routes = Some(routes);
            r
        }
        // a log: producers are answered once a partition takes the message; every subscriber gets
        // every message and drains its own backlog, one consumer per partition at most
        "stream" => {
            let cap = (capacity_of(c.d, None) * c.dt).max(1e-9);
            let accepted = c.arrivals.min(cap);
            let parts = partitions_of(c.d);
            let (mut taken, mut worst) = (vec![], (0.0f64, 0.0f64));
            for k in c.routes {
                let pos = match st.sub_backlog.iter().position(|x| x.0 == k.e) {
                    Some(p) => p,
                    None => {
                        st.sub_backlog.push((k.e, 0.0));
                        st.sub_backlog.len() - 1
                    }
                };
                let q = &mut st.sub_backlog[pos].1;
                *q += accepted;
                let drain = if k.up { subscriber_rps(&c.data[k.t], parts) } else { 0.0 };
                let take = q.min(drain * c.dt);
                *q = (*q - take).min(QUEUE_MAX_BACKLOG); // past retention, the oldest expire unread
                if k.up {
                    taken.push((k.e, take));
                }
                let lag = if drain > 0.0 { *q / drain } else if *q > 1.0 { f64::INFINITY } else { 0.0 };
                if lag >= worst.0 || worst.1 == 0.0 {
                    worst = (lag, drain);
                    st.queue = *q;
                    st.drain_rps = drain;
                }
            }
            let forward: f64 = taken.iter().map(|x| x.1).sum();
            let mut r = res(accepted, c.arrivals - accepted, forward, c.arrivals / cap, true);
            r.routes = Some(c.routes.iter().filter(|k| k.up).cloned().collect());
            r.shares = Some(taken.iter().map(|&(e, v)| (e, if forward > 0.0 { v / forward } else { 0.0 })).collect());
            r
        }
        "function" => {
            // execution environments, as the discrete-event engine runs them: a request that finds no
            // idle warm one starts a new one and waits out its cold start in it; past the concurrency
            // limit it is throttled. One cold request per new environment, so a jump cold-starts about
            // rate × (cold start + work) of them, and the ones starting are busy until they finish
            let (base, cold) = (base_latency_of(c.d), cold_start_of(c.d, c.cfg));
            let limit = capacity_of(c.d, None) * base / 1000.0;
            st.cold_starts.retain(|x| x.0 > c.now);
            let starting: f64 = st.cold_starts.iter().map(|x| x.1).sum();
            let ready = (st.warm - starting).max(0.0);
            let busy = c.arrivals / c.dt * base / 1000.0;
            let unserved = if busy > ready { c.arrivals * (busy - ready) / busy } else { 0.0 };
            let new = unserved.min((limit - st.warm).max(0.0));
            if new > 0.0 {
                st.warm += new;
                st.cold_starts.push((c.now + (cold + base) / 1000.0, new));
            }
            // idle ones are reclaimed after minutes; provisioned concurrency stays warm whatever the demand
            let used = busy.max(starting + new);
            if used < st.warm {
                st.warm += (used - st.warm) * (1.0 - (-c.dt / FN_IDLE_S).js_exp());
            }
            st.warm = st.warm.max(c.d.provisioned.filter(|p| *p > 0.0).unwrap_or(0.0));
            let processed = c.arrivals - (unserved - new);
            st.cold_frac = if processed > 0.0 { new / processed } else { 0.0 };
            res(processed, c.arrivals - processed, processed, busy / limit.max(1e-9), true)
        }
        "llmapi" | "external" | "archive" => {
            let cap = capacity_of(c.d, None) * c.dt;
            let processed = c.arrivals.min(cap);
            // a third-party API answers itself: it does not call your components (a link out of it is
            // flagged by validate and carries nothing), and an archive is storage, which answers too
            let mut r = res(processed, c.arrivals - processed, 0.0, c.arrivals / cap, true);
            r.routes = Some(vec![]);
            r
        }
        // a managed key-value store: the table's limit, then the hot key's partition; it answers itself
        "kv" => {
            let cap = (capacity_of(c.d, None) * c.dt).max(1e-9);
            let within = c.arrivals.min(cap);
            let h = c.d.hot_key_share.unwrap_or(0.0).clamp(0.0, 1.0);
            // the hot key's partition is a bucket of partition-seconds: cheap reads (1/3,000) take the
            // tokens as they come, so a write (1/1,000) only gets what reads leave — as in the DES
            let (hr, hw) = (within * h * c.read_ratio, within * h * (1.0 - c.read_ratio));
            let served_r = hr.min(KV_PARTITION_READS * c.dt);
            let served_w = hw.min((c.dt - served_r / KV_PARTITION_READS).max(0.0) * KV_PARTITION_WRITES);
            let throttled = hr + hw - served_r - served_w;
            let processed = within - throttled;
            let hot_units = (hr / KV_PARTITION_READS + hw / KV_PARTITION_WRITES) / c.dt;
            let util = (c.arrivals / cap).max(hot_units);
            let mut r = res(processed, c.arrivals - processed, 0.0, util, true);
            r.routes = Some(vec![]);
            r
        }
        // an object store: each key prefix is a bucket of prefix-seconds (a GET costs 1/5,500, a PUT
        // 1/3,500); the hot prefix takes the hot share plus its even share of the rest
        "storage" => {
            let p = prefixes_of(c.d);
            let deg = c.d.degraded.unwrap_or(1.0).max(1e-6);
            let work = (c.arrivals * c.read_ratio / PREFIX_READS + c.arrivals * (1.0 - c.read_ratio) / PREFIX_WRITES) / deg;
            let hot = hot_prefix_share(c.d);
            let cold = if p > 1.0 { (1.0 - hot) / (p - 1.0) } else { 0.0 };
            let served = |share: f64| if share * work > c.dt { c.dt / (share * work) } else { 1.0 };
            let processed = c.arrivals * (hot * served(hot) + (1.0 - hot) * if p > 1.0 { served(cold) } else { 1.0 });
            let util = (hot * work / c.dt).max(cold * work / c.dt);
            let mut r = res(processed, c.arrivals - processed, 0.0, util, true);
            r.routes = Some(vec![]);
            r
        }
        // code at the edge: it runs on every request (past its CPU limit it is killed), answers its
        // share itself and passes the rest to the origin
        "edge" => {
            let mut r = process_through(c, st);
            let bad = r.processed * edge_cpu_fail(c.d);
            let ok = r.processed - bad;
            let share = edge_share_of(c.d);
            let mut forward = ok * (1.0 - share);
            let mut failed_fwd = 0.0;
            if c.routes.iter().all(|k| !k.up) {
                failed_fwd = forward;
                forward = 0.0;
            }
            r.failed += bad + failed_fwd;
            r.failed_processed = bad + failed_fwd;
            r.forward = forward;
            r.hits = Some(ok * share);
            r.local_r = Some(share);
            r.local_w = Some(share);
            r.local_share = Some(if ok > 0.0 { ok * share / (ok * share + forward + failed_fwd).max(1e-12) } else { share });
            r
        }
        // a read replica is a data store: it answers, it does not call on (as a primary only reaches its replicas);
        // so is a search index — its nodes share the queries between them
        "replica" | "search" | "vector" => {
            let mut r = process_through(c, st);
            r.forward = 0.0;
            r.routes = Some(vec![]);
            r
        }
        // app servers, workers, storage, GPU pools
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
        "lb" | "dns" => (if c.has_kids { c.keep * c.child_succ } else { 0.0 }, service_latency(c.d, st) + c.child_lat),
        "gateway" => (if c.has_kids { c.keep * c.child_succ } else { 0.0 }, spec("gateway").base_latency_ms + c.child_lat),
        "cache" | "cdn" | "edge" => (c.keep * (c.local_share + (1.0 - c.local_share) * kids_succ), service_latency(c.d, st) + (1.0 - c.local_share) * c.child_lat),
        "db" => (c.local_share * c.keep + (1.0 - c.local_share) * kids_succ, c.local_share * service_latency(c.d, st) + (1.0 - c.local_share) * c.child_lat),
        "queue" | "stream" => (c.keep, spec(&c.d.kind).base_latency_ms),
        "function" => (c.keep * kids_succ, base_latency_of(c.d) + st.cold_frac * cold_start_of(c.d, c.cfg) + kids_lat),
        // leaves: they answer themselves (their routes are empty, so they have no kids)
        "llmapi" | "external" | "kv" => (c.keep, c.d.latency_ms.unwrap_or(spec(&c.d.kind).base_latency_ms)),
        "archive" => (c.keep, base_latency_of(c.d)),
        _ => (c.keep * kids_succ, service_latency(c.d, st) + kids_lat),
    }
}

/// usage-based $/h on top of the fixed price; None: in-rps × request price
fn usage_cost(d: &NodeData, st: &NodeState, profile: &str) -> f64 {
    match d.kind.as_str() {
        "function" => st.in_rps * 3600.0 * request_price(d, profile),
        "llmapi" | "external" | "kv" | "storage" | "archive" => (st.in_rps - st.drop_rps) * 3600.0 * (if d.cost_per_hour.is_none() { request_price(d, profile) } else { 0.0 }),
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
    /// writes acknowledged and then lost (a write-behind cache that died, or could not flush; writes a
    /// promoted replica never received)
    pub lost_writes: f64,
    /// reads answered by a replica more than a second behind its primary
    pub stale_reads: f64,
    /// the furthest any replica is behind its primary, s
    pub replica_lag_s: f64,
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
    /// a replica: how far behind its primary, s
    pub repl_lag_s: f64,
    pub cold_frac: f64,
    pub failover: String,
    pub cost_per_hour: f64,
    pub retry_amp: f64,
    pub breaker: Option<String>,
    pub late_frac: f64,
    pub history: Vec<f64>,
    pub scaling: Option<Scaling>,
    pub warmth: f64,
    /// thread-per-request: how long a request waits on this component's calls, ms (a thread is held for it)
    #[serde(skip_serializing_if = "is_zero_f")]
    pub hold_ms: f64,
    /// its own time per request, ms (work and queue, not what it waits on)
    pub own_ms: f64,
    /// a queue with a redrive policy: messages a second sent to the dead-letter queue
    #[serde(skip_serializing_if = "is_zero_f")]
    pub dead_letter_rps: f64,
}

fn is_zero_f(x: &f64) -> bool {
    *x == 0.0
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
    local_r: f64,
    local_w: f64,
    /// reads among what arrived
    rr: f64,
    write_fail: f64,
    write_extra_ms: f64,
    routes: Vec<Route>,
    /// (edge index, volume), in the order first sent
    flows: Vec<(usize, f64)>,
    /// (edge index, reads among that volume)
    flows_r: Vec<(usize, f64)>,
    mode: &'static str,
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
    /// requests sent this tick to a component that had already run (a call cycle): they arrive next tick
    carry: HashMap<String, (f64, f64)>,
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

    /// the users' successful answers this tick as a mixture of (share of the traffic, mean, p99 − mean):
    /// the clients' answer mixtures, each client sending an equal share and answered at its success
    /// (by share, not by the clients' smoothed arrival rate: the first ticks' answers count in full)
    pub fn answer_mix(&self, nodes: &[SimNode]) -> Vec<[f64; 3]> {
        let clients: Vec<&SimNode> = nodes.iter().filter(|n| n.data.kind == "client" && n.data.alive).collect();
        let mut out = vec![];
        for n in &clients {
            if let Some(st) = self.nodes.get(&n.id) {
                let ok = st.success / clients.len() as f64;
                if ok <= 0.0 {
                    continue;
                }
                if st.dist.is_empty() {
                    out.push([ok, st.latency_ms, st.tail_ms]);
                } else {
                    out.extend(mix_then(&st.dist, 0.0, 0.0, ok));
                }
            }
        }
        out
    }

    /// writes acknowledged and then lost so far
    pub fn lost_writes(&self) -> f64 {
        self.global.lost_writes
    }

    /// reads answered by a lagging replica so far
    pub fn stale_reads(&self) -> f64 {
        self.global.stale_reads
    }

    /// how far the furthest replica is behind its primary now, s
    pub fn replica_lag(&self) -> f64 {
        self.global.replica_lag_s
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
        // a breaker judges what it measures over a window of calls, and that wanders around the
        // expected failure rate: past the threshold it trips after a second, as always; just under it,
        // a window now and then measures past it, and the first one trips it (the discrete-event engine,
        // and a real breaker, trip that way). So below the threshold the clock runs at the chance that a
        // window measures past it: a callee failing half the calls (one of two dependencies late) trips
        // it within a few seconds, one failing a tenth of them never does
        let calls = st.in_rps * st.retry_amp * BR_WINDOW_S;
        let hazard = |p: f64, n: f64, min: f64| if p > TRIP_FAIL { 1.0 } else if n < min { 0.0 } else { window_above(p, n, TRIP_FAIL) };
        match st.breaker {
            Breaker::Closed => {
                let h = hazard(st.attempt_fail, calls, BR_MIN_CALLS);
                if h < 1e-3 {
                    st.breaker_t = 0.0;
                } else {
                    st.breaker_t += dt * h;
                    if st.breaker_t >= TRIP_AFTER_S {
                        st.breaker = Breaker::Open;
                        st.breaker_t = 0.0;
                    }
                }
            }
            Breaker::Open => {
                st.breaker_t += dt;
                if st.breaker_t >= OPEN_S {
                    st.breaker = Breaker::Half;
                    st.breaker_t = 0.0;
                    st.breaker_h = 0.0;
                }
            }
            Breaker::Half => {
                st.breaker_t += dt;
                // the probes' windows (three calls make one) measure past the threshold now and then too
                st.breaker_h += dt * hazard(st.attempt_fail, calls * PROBE_HALF, BR_HALF_MIN_CALLS);
                if st.breaker_t >= 1.0 {
                    if st.attempt_fail < CLOSE_FAIL {
                        st.breaker = Breaker::Closed;
                        st.breaker_t = 0.0;
                    } else if st.breaker_h >= 1.0 {
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

    /// the index of a node's state, created fresh the first time
    fn state_index(&mut self, id: &str) -> usize {
        if let Some(i) = self.nodes.get_index_of(id) {
            return i;
        }
        self.nodes.insert(id.to_string(), fresh());
        self.nodes.len() - 1
    }

    /// one tick: `traffic` req/s sent by all clients, `read_ratio` share of reads
    pub fn step(&mut self, nodes_in: &[SimNode], edges: &[SimEdge], traffic: f64, read_ratio: f64, dt: f64, cfg: &EngineConfig, profile: &str) -> Vec<SimEvent> {
        self.t += dt;
        let mut events: Vec<SimEvent> = vec![];
        let now = self.t;
        let n = nodes_in.len();
        for nd in nodes_in {
            if nd.data.autoscale.is_some() && spec(&nd.data.kind).scalable {
                if !self.scalers.contains_key(&nd.id) {
                    self.scalers.insert(nd.id.clone(), new_scaler(&nd.data));
                }
            } else if self.scalers.contains_key(&nd.id) {
                self.scalers.shift_remove(&nd.id);
            }
        }
        let data: Vec<NodeData> = nodes_in.iter().map(|nd| dynamic_data(&nd.data, self.scalers.get(&nd.id))).collect();
        let by_id: HashMap<&str, usize> = nodes_in.iter().enumerate().map(|(i, nd)| (nd.id.as_str(), i)).collect();
        // states by node index (every node gets one this tick, as the TypeScript engine's lookups do)
        let sidx: Vec<usize> = nodes_in.iter().map(|nd| self.state_index(&nd.id)).collect();
        let edge_lat: Vec<f64> = edges.iter().map(|e| e.data.as_ref().and_then(|d| d.latency_ms).filter(|l| *l != 0.0 && !l.is_nan()).unwrap_or(0.0)).collect();
        // calls per request over each link: N in parallel, all must answer
        let edge_calls: Vec<f64> = edges.iter().map(|e| e.data.as_ref().and_then(|d| d.calls).filter(|c| *c > 1.0).unwrap_or(1.0)).collect();
        // which requests a link carries: 0 both, 1 reads only, 2 writes only
        let edge_sync: Vec<bool> = edges.iter().map(|e| e.data.as_ref().and_then(|d| d.replication.as_deref()) == Some("sync")).collect();
        let edge_carries: Vec<u8> = edges.iter().map(|e| match e.data.as_ref().and_then(|d| d.carries.as_deref()) { Some("reads") => 1, Some("writes") => 2, _ => 0 }).collect();
        let mut out: Vec<Vec<Route>> = vec![vec![]; n];
        let mut indeg: Vec<i64> = vec![0; n];
        let mut pooled: Vec<bool> = vec![false; n];
        // links a network partition has cut, and each replica's primary (edge, node)
        let mut edge_cut = vec![false; edges.len()];
        let mut primary_of: Vec<Option<(usize, usize)>> = vec![None; n];
        for (ei, e) in edges.iter().enumerate() {
            let (si, ti) = match (by_id.get(e.source.as_str()), by_id.get(e.target.as_str())) {
                (Some(s), Some(t)) if e.source != e.target => (*s, *t),
                _ => continue,
            };
            let sd = &data[si];
            // instances are reachable behind a balancer/queue, or when a scatter-gather caller addresses partitions
            if sd.kind == "lb" || sd.kind == "gateway" || sd.kind == "queue" || sd.kind == "stream" || sd.fanout.unwrap_or(1.0) > 1.0 {
                pooled[ti] = true;
            }
            // a dead primary's links to its replicas are not the network's: failover is decided around it
            edge_cut[ei] = (cut(&data[si], &data[ti]) || data[si].cut_to.as_ref().map_or(false, |v| v.iter().any(|x| *x == nodes_in[ti].id))) && !(sd.kind == "db" && !sd.alive);
            if sd.kind == "db" && data[ti].kind == "replica" {
                primary_of[ti] = Some((ei, si));
            }
            out[si].push(Route { e: ei, t: ti, up: is_up(&data[ti]) && !edge_cut[ei] });
            indeg[ti] += 1;
        }

        // Kahn topological order; nodes in cycles go at the end
        let mut order: Vec<usize> = Vec::with_capacity(n);
        let mut ready: VecDeque<usize> = (0..n).filter(|&i| indeg[i] == 0).collect();
        let mut seen = vec![false; n];
        while let Some(i) = ready.pop_front() {
            if seen[i] {
                continue;
            }
            seen[i] = true;
            order.push(i);
            for k in &out[i] {
                indeg[k.t] -= 1;
                if indeg[k.t] == 0 {
                    ready.push_back(k.t);
                }
            }
        }
        for i in 0..n {
            if !seen[i] {
                order.push(i);
            }
        }

        let lags: Vec<f64> = (0..n).map(|i| self.nodes[sidx[i]].repl_lag).collect();
        for i in 0..n {
            let st = &mut self.nodes[sidx[i]];
            st.dead_for = if is_up(&data[i]) { 0.0 } else { st.dead_for + dt };
        }
        let dead: Vec<f64> = (0..n).map(|i| self.nodes[sidx[i]].dead_for).collect();
        let pushed: Vec<f64> = (0..n).map(|i| self.nodes[sidx[i]].pushed_rps).collect();
        // what a consumer can take from its queues: its capacity; a function's environments, those
        // ready at a warm request's pace and those it may still start at a cold one's (the discrete-event
        // engine hands a message only to an idle environment, so none is throttled)
        let pull_cap: Vec<f64> = (0..n)
            .map(|i| {
                let d = &data[i];
                if d.kind != "function" {
                    return capacity_of(d, None);
                }
                let st = &self.nodes[sidx[i]];
                let (base, cold) = (base_latency_of(d).max(0.05), cold_start_of(d, cfg));
                let limit = capacity_of(d, None) * base / 1000.0;
                let starting: f64 = st.cold_starts.iter().filter(|x| x.0 > now).map(|x| x.1).sum();
                let ready = (st.warm - starting).max(0.0);
                ready * 1000.0 / base + (limit - st.warm).max(0.0) * 1000.0 / (base + cold)
            })
            .collect();
        // what each node receives from queues this tick (the rest was pushed at it)
        let mut from_queues = vec![0.0; n];
        let mut stale_now = 0.0;
        let mut inflow = vec![0.0; n];
        let mut done = vec![false; n];
        let mut carried: HashMap<String, (f64, f64)> = std::mem::take(&mut self.carry);
        // reads among what arrives: a cache's misses and every write are what reaches what is behind it
        let mut inflow_r = vec![0.0; n];
        let mut edge_flow = vec![0.0; edges.len()];
        let mut local: Vec<Option<Local>> = (0..n).map(|_| None).collect();
        let mut promoted = vec![false; n];
        let clients: Vec<usize> = (0..n).filter(|&i| data[i].kind == "client" && data[i].alive && job_rate(&data[i], now).is_none()).collect();
        let per_client = if clients.is_empty() { 0.0 } else { (traffic * dt) / clients.len() as f64 };

        // ---- forward pass ----
        for &i in &order {
            let d = &data[i];
            let id = nodes_in[i].id.as_str();
            let routes = &out[i];
            let (late_in, late_r) = if d.kind == "client" { (0.0, 0.0) } else { carried.remove(id).unwrap_or((0.0, 0.0)) };
            let arrivals = if d.kind == "client" {
                match (d.alive, job_rate(d, now)) {
                    (false, _) => 0.0,
                    (true, Some(_)) => job_volume(d, now, now + dt).unwrap_or(0.0),
                    (true, None) => per_client,
                }
            } else {
                inflow[i] + late_in
            };
            let read_ratio = if d.kind == "client" || arrivals <= 0.0 { read_ratio } else { ((inflow_r[i] + late_r) / arrivals).clamp(0.0, 1.0) };
            done[i] = true;
            let mut st = std::mem::replace(&mut self.nodes[sidx[i]], fresh());
            if d.kind == "replica" {
                st.failover = if promoted[i] { Failover::Promoted } else { Failover::None };
                // replication lag: none for a synchronous replica, the link's delay for a reachable
                // asynchronous one (catching up after a cut), growing while it cannot reach a primary
                // that keeps taking writes
                if promoted[i] {
                    st.repl_lag = 0.0;
                } else if let Some((e, src)) = primary_of[i] {
                    let reachable = !edge_cut[e] && is_up(&data[src]);
                    // a synchronous replica never falls behind: the primary refuses what it cannot replicate
                    if edge_sync[e] {
                        st.repl_lag = 0.0;
                    } else if reachable {
                        st.repl_lag = (st.repl_lag - dt * CATCH_UP).max(edge_lat[e] / 1000.0);
                    } else if is_up(&data[src]) {
                        st.repl_lag += dt;
                    }
                }
                if st.repl_lag > 1.0 {
                    stale_now += arrivals * read_ratio;
                }
            }
            let was_promoted = st.failover == Failover::Promoted;
            if d.kind == "cache" || d.kind == "cdn" {
                // a dead or flushed cache comes back empty and re-warms from misses; a dead one also loses
                // the writes it had acknowledged but not flushed
                if !is_up(d) || d.flushes.unwrap_or(0.0) != st.flush_seen {
                    st.cold_at = Some(now);
                    self.global.lost_writes += st.wb_buffer;
                    st.wb_buffer = 0.0;
                }
                st.flush_seen = d.flushes.unwrap_or(0.0);
                st.warmth = cache_warmth(st.cold_at, now, d.warmup_s);
                if st.warmth > 0.999 {
                    st.cold_at = None;
                }
            }
            // a dead node fails everything (databases handle their own failover)
            let mut r = if !is_up(d) && d.kind != "db" && d.kind != "client" {
                st.queue = 0.0;
                res(0.0, arrivals, 0.0, 0.0, false)
            } else {
                let ctx = Ctx { d, data: &data, arrivals, dt, cfg, read_ratio, routes, pooled: pooled[i], edge_sync: &edge_sync, edge_lat: &edge_lat, lags: &lags, dead: &dead, now, pushed: &pushed, pull_cap: &pull_cap };
                process(&ctx, &mut st)
            };
            // a search index: a write is searchable after the indexing backlog ahead of it and the next
            // refresh; reads in that window miss the writes made in it
            if d.kind == "search" {
                st.repl_lag = index_lag_s(d, st.queue, capacity_of(d, Some(st.reachable)));
                let writes_s = arrivals * (1.0 - read_ratio) / dt;
                if st.repl_lag > 1.0 && r.up {
                    stale_now += arrivals * read_ratio * (1.0 - (-writes_s * st.repl_lag).js_exp());
                }
            }
            // gray failure: the node answers a share of what it handles with errors
            if let Some(fr) = d.fault_rate.filter(|x| *x != 0.0 && !x.is_nan()) {
                if r.up && d.kind != "client" {
                    // only what is still on its way to succeeding can fail (a balancer with nowhere
                    // to send has already failed everything)
                    let bad = (r.processed - r.failed_processed) * fr;
                    r.failed += bad;
                    r.forward *= 1.0 - fr;
                    r.hits = Some(r.hits.unwrap_or(0.0) * (1.0 - fr));
                }
            }
            if d.kind == "db" && st.failover == Failover::Promoted {
                if let Some(t) = r.routes.as_ref().and_then(|rs| rs.first()) {
                    promoted[t.t] = true;
                    // the writes the promoted replica had not received are gone
                    if !was_promoted {
                        self.global.lost_writes += st.in_rps * (1.0 - read_ratio) * lags[t.t];
                    }
                }
            }
            // generic caller behaviour: breaker first, then retries on whatever passes
            let targets: Vec<Route> = r.routes.take().unwrap_or_else(|| routes.clone());
            st.breaker_pass = if targets.is_empty() { 1.0 } else { Self::breaker_pass(d, &mut st, dt, &mut events, id) };
            let retries = d.retries.unwrap_or(0.0);
            st.retry_amp = if retries > 0.0 && !targets.is_empty() { retry_amp(st.attempt_fail, retries, d.retry_policy.as_deref().unwrap_or("immediate")) } else { 1.0 };
            let forward = r.forward * st.breaker_pass * st.retry_amp * d.fanout.unwrap_or(1.0).max(1.0);
            let fwd_r = r.fwd_read_share.unwrap_or(read_ratio);

            // routing policy
            let mut flows: Vec<(usize, f64)> = vec![];
            let mode: &'static str = if r.shares.is_some() {
                "split"
            } else {
                match d.routing.as_deref() {
                    Some("fanout") => "fanout",
                    Some("failover") => "failover",
                    _ => "split",
                }
            };
            let mut flows_r: Vec<(usize, f64)> = vec![];
            let mut unroutable = 0.0;
            let restricted = targets.iter().any(|k| edge_carries[k.e] != 0);
            if restricted && forward > 0.0 && r.shares.is_none() {
                // reads and writes each go over the links that carry them, by the routing policy
                let mut parts: Vec<(usize, f64, f64)> = vec![];
                for (class, amount) in [(1u8, forward * fwd_r), (2u8, forward * (1.0 - fwd_r))] {
                    if amount <= 0.0 {
                        continue;
                    }
                    let allowed: Vec<Route> = targets.iter().filter(|k| edge_carries[k.e] == 0 || edge_carries[k.e] == class).cloned().collect();
                    if allowed.is_empty() {
                        unroutable += amount;
                        continue;
                    }
                    let mut put = |e: usize, v: f64| {
                        let (vr, vw) = if class == 1 { (v, 0.0) } else { (0.0, v) };
                        if let Some(x) = parts.iter_mut().find(|x| x.0 == e) {
                            x.1 += vr;
                            x.2 += vw;
                        } else {
                            parts.push((e, vr, vw));
                        }
                    };
                    if mode == "fanout" {
                        for k in &allowed {
                            put(k.e, amount);
                        }
                    } else if mode == "failover" {
                        let mut remaining = amount;
                        let mut ordered = allowed.clone();
                        ordered.sort_by_key(|k| !k.up);
                        for k in &ordered {
                            put(k.e, remaining);
                            remaining *= if k.up { 1.0 - self.nodes[sidx[k.t]].success } else { 1.0 };
                            if remaining < 1e-9 {
                                break;
                            }
                        }
                    } else {
                        let share = amount / allowed.len() as f64;
                        for k in &allowed {
                            put(k.e, share);
                        }
                    }
                }
                for (e, vr, vw) in parts {
                    flows.push((e, vr + vw));
                    flows_r.push((e, vr));
                    if edge_cut[e] {
                        continue;
                    }
                    let t = targets.iter().find(|x| x.e == e).unwrap().t;
                    // a bulkhead refuses what is past its share at the caller: it never reaches the dependency
                    let admit = bulkhead_admit(d, st.reachable, (vr + vw) / dt, self.nodes[sidx[t]].latency_ms + edge_lat[e]);
                    let (v, v_r) = ((vr + vw) * edge_calls[e] * admit, vr * edge_calls[e] * admit);
                    if done[t] {
                        let c = self.carry.entry(nodes_in[t].id.clone()).or_insert((0.0, 0.0));
                        c.0 += v;
                        c.1 += v_r;
                    } else {
                        inflow[t] += v;
                        inflow_r[t] += v_r;
                        if d.kind == "queue" {
                            from_queues[t] += v;
                        }
                    }
                    edge_flow[e] += v;
                }
            } else if !targets.is_empty() && forward > 0.0 {
                let set = |flows: &mut Vec<(usize, f64)>, e: usize, v: f64| {
                    // a Map keeps one entry per edge: a later write replaces the value in place
                    if let Some(x) = flows.iter_mut().find(|x| x.0 == e) {
                        x.1 = v;
                    } else {
                        flows.push((e, v));
                    }
                };
                if let Some(sh) = &r.shares {
                    for k in &targets {
                        set(&mut flows, k.e, forward * sh.iter().find(|x| x.0 == k.e).map(|x| x.1).unwrap_or(0.0));
                    }
                } else if mode == "fanout" {
                    for k in &targets {
                        set(&mut flows, k.e, forward);
                    }
                } else if mode == "failover" {
                    // children in order; whatever one failed last tick spills over to the next
                    let mut remaining = forward;
                    let mut ordered = targets.clone();
                    js_sort_by(&mut ordered, |a, b| {
                        let usage = |t: usize| if spec(&data[t].kind).cost_per_request.map(|c| c != 0.0).unwrap_or(false) { 1.0 } else { 0.0 };
                        let u = (b.up as i32 - a.up as i32) as f64;
                        if u != 0.0 {
                            u
                        } else {
                            usage(a.t) - usage(b.t)
                        }
                    });
                    for k in &ordered {
                        set(&mut flows, k.e, remaining);
                        remaining *= if k.up { 1.0 - self.nodes[sidx[k.t]].success } else { 1.0 };
                        if remaining < 1e-9 {
                            break;
                        }
                    }
                } else {
                    let share = forward / targets.len() as f64;
                    for k in &targets {
                        set(&mut flows, k.e, share);
                    }
                }
                for &(e, v0) in &flows {
                    // across a partition nothing arrives
                    if edge_cut[e] {
                        continue;
                    }
                    let t = targets.iter().find(|x| x.e == e).unwrap().t;
                    let admit = bulkhead_admit(d, st.reachable, v0 / dt, self.nodes[sidx[t]].latency_ms + edge_lat[e]);
                    let v = v0 * edge_calls[e] * admit;
                    if done[t] {
                        // a call back into a component that already ran this tick (a cycle): next tick
                        let c = self.carry.entry(nodes_in[t].id.clone()).or_insert((0.0, 0.0));
                        c.0 += v;
                        c.1 += v * fwd_r;
                    } else {
                        inflow[t] += v;
                        inflow_r[t] += v * fwd_r;
                        if d.kind == "queue" {
                            from_queues[t] += v;
                        }
                    }
                    edge_flow[e] += v;
                }
                flows_r = flows.iter().map(|&(e, v)| (e, v * fwd_r)).collect();
            }
            if unroutable > 0.0 {
                // a class with no link to take it: those requests fail here
                r.failed += unroutable;
            }
            st.in_rps = ema(st.in_rps, arrivals / dt, dt, 0.6);
            st.pushed_rps = (arrivals - from_queues[i]).max(0.0) / dt;
            st.pulled_share = if from_queues[i] > 0.0 && st.pushed_rps > 0.0 { (from_queues[i] / arrivals).min(1.0) } else { 0.0 };
            st.drop_rps = ema(st.drop_rps, r.failed / dt, dt, 0.6);
            st.hit_rps = ema(st.hit_rps, r.hits.unwrap_or(0.0) / dt, dt, 0.6);
            st.util = ema(st.util, r.util, dt, 0.4);
            st.cold_util = ema(st.cold_util, r.cold_util.unwrap_or(r.util), dt, 0.4);
            let local_share = r.local_share.unwrap_or(1.0);
            let own = if d.kind == "db" { arrivals * local_share } else { arrivals };
            st.drop_ratio = ema(st.drop_ratio, if own > 0.0 { r.failed / own } else { 0.0 }, dt, 0.6);
            self.nodes[sidx[i]] = st;
            local[i] = Some(Local { local_share, local_r: r.local_r.unwrap_or(local_share), local_w: r.local_w.unwrap_or(local_share), rr: read_ratio, write_fail: r.write_fail, write_extra_ms: r.write_extra_ms, routes: targets, flows, flows_r, mode, up: r.up });
        }

        // ---- backward pass ----
        let mut lost_now = 0.0;
        for &i in order.iter().rev() {
            let d = &data[i];
            let id = nodes_in[i].id.as_str();
            let l = local[i].take().unwrap();
            let has_kids = !l.routes.is_empty();
            // aggregate one downstream attempt according to the routing policy
            let (mut succ, mut lat, mut tail) = (1.0, 0.0, 0.0);
            let (mut succ_r, mut succ_w) = (1.0, 1.0);
            // the caller's deadline judged branch by branch: a slow branch's answers are late, a fast one's are not
            let tmo = d.timeout_ms.filter(|t| *t != 0.0 && !t.is_nan());
            let mut late: Option<f64> = None;
            let mut kids_mix: Vec<[f64; 3]> = vec![];
            if has_kids {
                // a link that makes N calls per request: all must succeed, the caller waits for the slowest
                let timeout_ms = cfg.timeout_s * 1000.0;
                let bulk_reach = self.nodes[sidx[i]].reachable;
                let kid = |k: &Route| {
                    let s = &self.nodes[sidx[k.t]];
                    let f = l.flows.iter().find(|x| x.0 == k.e).map(|x| x.1).unwrap_or(0.0);
                    let n = edge_calls[k.e];
                    if edge_cut[k.e] {
                        // across a partition: no answer, until the connection times out
                        return (0.0, timeout_ms, f, 0.0);
                    }
                    let (ks, kl, kt) = if n > 1.0 { (s.success.js_pow(n), s.latency_ms * fanout_tail(n) + edge_lat[k.e], s.tail_ms * fanout_tail(n)) } else { (s.success, s.latency_ms + edge_lat[k.e], s.tail_ms) };
                    // a bulkhead: past its share of waiting calls, the rest fail at once
                    let admit = bulkhead_admit(d, bulk_reach, f / dt, kl);
                    (ks * admit, admit * kl + (1.0 - admit) * 0.5, f, kt)
                };
                // a kid's answers as a mixture (its own one, or its mean and tail), the link's latency added
                let kid_dist = |k: &Route| -> Vec<[f64; 3]> {
                    let s = &self.nodes[sidx[k.t]];
                    let n = edge_calls[k.e];
                    if edge_cut[k.e] {
                        return vec![[1.0, timeout_ms, 0.0]];
                    }
                    if n > 1.0 {
                        return vec![[1.0, s.latency_ms * fanout_tail(n) + edge_lat[k.e], s.tail_ms * fanout_tail(n)]];
                    }
                    if s.dist.is_empty() {
                        vec![[1.0, s.latency_ms + edge_lat[k.e], s.tail_ms]]
                    } else {
                        mix_then(&s.dist, edge_lat[k.e], 0.0, 1.0)
                    }
                };
                let kid_rw = |k: &Route| {
                    let s = &self.nodes[sidx[k.t]];
                    let n = edge_calls[k.e];
                    if edge_cut[k.e] {
                        return (0.0, 0.0);
                    }
                    let f = l.flows.iter().find(|x| x.0 == k.e).map(|x| x.1).unwrap_or(0.0);
                    let admit = bulkhead_admit(d, bulk_reach, f / dt, s.latency_ms + edge_lat[k.e]);
                    (s.success_r.js_pow(n) * admit, s.success_w.js_pow(n) * admit)
                };
                // each class's own flow over a link (links that carry only reads or only writes)
                let restricted = l.routes.iter().any(|k| edge_carries[k.e] != 0);
                let class_flow = |k: &Route| {
                    let f = l.flows.iter().find(|x| x.0 == k.e).map(|x| x.1).unwrap_or(0.0);
                    let fr = l.flows_r.iter().find(|x| x.0 == k.e).map(|x| x.1).unwrap_or(0.0);
                    (fr, (f - fr).max(0.0))
                };
                let carries = |k: &Route, class: u8| edge_carries[k.e] == 0 || edge_carries[k.e] == class;
                if l.mode == "fanout" {
                    succ = l.routes.iter().fold(1.0, |p, k| p * kid(k).0);
                    succ_r = l.routes.iter().filter(|k| carries(k, 1)).fold(1.0, |p, k| p * kid_rw(k).0);
                    succ_w = l.routes.iter().filter(|k| carries(k, 2)).fold(1.0, |p, k| p * kid_rw(k).1);
                    lat = js_max(f64::NEG_INFINITY, l.routes.iter().map(|k| kid(k).1));
                    // the slowest answer's 99th percentile
                    let p99 = js_max(f64::NEG_INFINITY, l.routes.iter().map(|k| kid(k).1 + kid(k).3));
                    tail = (p99 - lat).max(0.0);
                    if let Some(t) = tmo {
                        late = Some(1.0 - l.routes.iter().fold(1.0, |p, k| p * (1.0 - late_share(kid(k).1, kid(k).3, t))));
                    }
                } else if l.mode == "failover" {
                    let mut miss = 1.0;
                    let (mut miss_r, mut miss_w) = (1.0, 1.0);
                    let mut p99 = 0.0;
                    for k in &l.routes {
                        let (s, la, f, t) = kid(k);
                        if f > 0.0 {
                            lat += miss * la;
                            p99 += miss * (la + t);
                            miss *= 1.0 - s;
                            let (sr, sw) = kid_rw(k);
                            if carries(k, 1) {
                                miss_r *= 1.0 - sr;
                            }
                            if carries(k, 2) {
                                miss_w *= 1.0 - sw;
                            }
                        }
                    }
                    succ = 1.0 - miss;
                    succ_r = 1.0 - miss_r;
                    succ_w = 1.0 - miss_w;
                    tail = (p99 - lat).max(0.0);
                } else {
                    let (mut w, mut s, mut p99, mut lt, mut wa) = (0.0, 0.0, 0.0, 0.0, 0.0);
                    let (mut sr, mut sw, mut wr, mut ww) = (0.0, 0.0, 0.0, 0.0);
                    for k in &l.routes {
                        let (ks, kl, f, t) = kid(k);
                        let wk = if f > 0.0 { f } else { 1e-9 };
                        w += wk;
                        s += ks * wk;
                        let (kr, kw) = kid_rw(k);
                        // by each class's own flow where links are class-specific, else by the total
                        let (cr, cw) = if restricted { class_flow(k) } else { (wk, wk) };
                        let (cr, cw) = (if carries(k, 1) { cr.max(1e-12) } else { 0.0 }, if carries(k, 2) { cw.max(1e-12) } else { 0.0 });
                        sr += kr * cr;
                        sw += kw * cw;
                        wr += cr;
                        ww += cw;
                        lat += kl * wk;
                        p99 += (kl + t) * wk;
                        // the answers are the ones that succeeded: a branch that mostly fails is mostly not
                        // among them, so its lateness counts by its successes, not by the calls it took
                        // (weighting by calls makes a slow, failing branch's lateness strike the fast,
                        // healthy branches' answers too: success × (1 − late) counts it twice)
                        let wa_k = wk * ks.max(1e-6);
                        wa += wa_k;
                        let kd = kid_dist(k);
                        if let Some(dl) = tmo {
                            lt += mix_late(&kd, dl) * wa_k;
                        }
                        kids_mix.extend(mix_then(&kd, 0.0, 0.0, wa_k));
                    }
                    succ = s / w;
                    succ_r = if wr > 0.0 { sr / wr } else { 0.0 };
                    succ_w = if ww > 0.0 { sw / ww } else { 0.0 };
                    lat /= w;
                    tail = (p99 / w - lat).max(0.0);
                    if tmo.is_some() {
                        late = Some(lt / wa);
                    }
                }
            }
            // scatter-gather: every partition must answer, and the caller waits for the slowest
            let degree = d.fanout.unwrap_or(1.0).max(1.0);
            if degree > 1.0 && has_kids {
                succ = succ.js_pow(degree);
                succ_r = succ_r.js_pow(degree);
                succ_w = succ_w.js_pow(degree);
                let kd = &data[l.routes[0].t];
                let p = kd.stall_rate.unwrap_or(0.0);
                lat = lat * fanout_tail(degree) + (1.0 - (1.0 - p).js_pow(degree) - p) * kd.stall_ms.unwrap_or(0.0);
                tail *= fanout_tail(degree);
                late = None;
                kids_mix.clear();
            }
            let billed = self.scalers.get(id).map(|s| s.live + s.pending.len() as f64);
            let st = &mut self.nodes[sidx[i]];
            // caller deadline: answers slower than timeoutMs are failures to the caller
            st.late_frac = match tmo {
                Some(t) if has_kids => late.unwrap_or_else(|| late_share(lat, tail, t)),
                _ => 0.0,
            };
            let attempt = succ * (1.0 - st.late_frac);
            let (attempt_r, attempt_w) = (succ_r * (1.0 - st.late_frac), succ_w * (1.0 - st.late_frac));
            if let Some(t) = tmo {
                lat = lat.min(t);
            }
            st.attempt_fail = if has_kids { 1.0 - attempt } else { 0.0 };
            // retries, then breaker (blocked calls fail fast or get the fallback)
            let mut child_succ = attempt;
            let (mut child_r, mut child_w) = (attempt_r, attempt_w);
            let mut child_lat = lat;
            let retries = d.retries.unwrap_or(0.0);
            if retries > 0.0 && has_kids {
                let policy = d.retry_policy.as_deref().unwrap_or("immediate");
                child_succ = retry_success(attempt, retries, policy, st.retry_amp);
                child_r = retry_success(attempt_r, retries, policy, st.retry_amp);
                child_w = retry_success(attempt_w, retries, policy, st.retry_amp);
                child_lat = lat * st.retry_amp + if policy == "backoff" { (st.retry_amp - 1.0) * BACKOFF_DELAY_MS * 4.0 } else { 0.0 };
            }
            if st.breaker_pass < 1.0 {
                let p = st.breaker_pass;
                let fb = if d.fallback == Some(true) { 1.0 } else { 0.0 };
                child_succ = p * child_succ + (1.0 - p) * fb;
                child_r = p * child_r + (1.0 - p) * fb;
                child_w = p * child_w + (1.0 - p) * fb;
                child_lat = p * child_lat + (1.0 - p) * 2.0;
            }
            st.hold_ms = ema(st.hold_ms, if has_kids { child_lat } else { 0.0 }, dt, 0.3);
            // a queue with a redrive policy: of what its consumers failed, the messages with receives
            // left come back after the visibility timeout; the rest go to the dead-letter queue
            // (with a failure share f and N receives, f^(N−1)(1−f)/(1−f^N) of the failures are last tries)
            if d.kind == "queue" {
                let mut dl = 0.0;
                if let Some(max) = d.max_receives.filter(|m| *m >= 1.0 && has_kids) {
                    let f = (1.0 - child_succ).clamp(0.0, 1.0);
                    let fails = st.forwarded * f;
                    if fails > 0.0 {
                        let last = if f > 0.9999 { 1.0 / max } else { f.js_pow(max - 1.0) * (1.0 - f) / (1.0 - f.js_pow(max)) };
                        dl = fails * last;
                        let back = fails - dl;
                        if back > 0.0 {
                            st.redrive.push((now + d.visibility_s.unwrap_or(30.0).max(0.0), back));
                        }
                    }
                }
                st.dead_letter_rps = ema(st.dead_letter_rps, dl / dt, dt, 0.6);
            }
            let keep = 1.0 - st.drop_ratio;
            let (_, mut latency) = if l.up { fold(&FoldCtx { d, keep, local_share: l.local_share, child_succ, child_lat, has_kids, cfg }, st) } else { (0.0, 0.0) };
            // success per class: a cache answers its read hits, a database its writes; the rest waits on what is behind
            let origin_less = (d.kind == "cache" || d.kind == "cdn") && !has_kids;
            let class = |local: f64, child: f64| {
                if !l.up {
                    0.0
                } else if origin_less {
                    // nothing behind it: only what it answers itself succeeds (its drops are those misses, plus any shedding)
                    if l.local_share > 0.0 { (keep / l.local_share).min(1.0) * local } else { 0.0 }
                } else {
                    fold(&FoldCtx { d, keep, local_share: local, child_succ: child, child_lat, has_kids, cfg }, st).0
                }
            };
            let (success_r, mut success_w) = (class(l.local_r, child_r), class(l.local_w, child_w));
            // a synchronous replica out of reach: writes cannot be acknowledged
            success_w *= 1.0 - l.write_fail;
            if l.write_extra_ms > 0.0 {
                latency += (1.0 - l.rr) * l.write_extra_ms;
            }
            let success = l.rr * success_r + (1.0 - l.rr) * success_w;
            if l.up {
                if let Some(fl) = d.fault_latency_ms.filter(|x| *x != 0.0 && !x.is_nan()) {
                    latency += fl;
                }
            }
            // the answer's tail: this component's own and what it waits on, independent spreads adding
            // in quadrature, each weighted by the share of requests that take that part
            let tail_total = if !l.up {
                0.0
            } else {
                let (own_share, kid_share) = match d.kind.as_str() {
                    "client" => (0.0, 1.0),
                    "queue" | "stream" => (0.0, 0.0),
                    "cache" | "cdn" | "edge" | "db" => (1.0, 1.0 - l.local_share),
                    _ => (1.0, 1.0),
                };
                let own = match d.kind.as_str() {
                    "client" | "queue" | "stream" | "gateway" => 0.0,
                    "function" => (SERVICE_P99 - 1.0) * base_latency_of(d),
                    "llmapi" | "external" | "kv" | "storage" | "archive" => (API_P99 - 1.0) * base_latency_of(d),
                    _ => service_tail(d, st),
                };
                let kids = if has_kids { tail * if retries > 0.0 { st.retry_amp } else { 1.0 } } else { 0.0 };
                let t = (own_share * own * own + kid_share * kids * kids).sqrt();
                match tmo {
                    Some(tm) if has_kids => t.min((tm - latency).max(0.0)),
                    _ => t,
                }
            };
            // the answers as a mixture: what this component answers itself, and what it waits on downstream
            // (only answers within the deadline count; retries add the failed attempts' time)
            let dist = if !l.up {
                vec![]
            } else {
                let own_mean = fold(&FoldCtx { d, keep, local_share: 1.0, child_succ: 1.0, child_lat: 0.0, has_kids: false, cfg }, st).1 + d.fault_latency_ms.filter(|x| !x.is_nan()).unwrap_or(0.0);
                let own_tail = match d.kind.as_str() {
                    "client" | "queue" | "stream" | "gateway" => 0.0,
                    "function" => (SERVICE_P99 - 1.0) * base_latency_of(d),
                    "llmapi" | "external" | "kv" | "storage" | "archive" => (API_P99 - 1.0) * base_latency_of(d),
                    _ => service_tail(d, st),
                };
                let own_mean = if d.kind == "client" { 0.0 } else { own_mean };
                let mut kids = if !has_kids {
                    vec![]
                } else if kids_mix.is_empty() {
                    vec![[1.0, lat, tail]]
                } else {
                    kids_mix.clone()
                };
                if let (Some(t), false) = (tmo, kids.is_empty()) {
                    for c in kids.iter_mut() {
                        c[0] *= 1.0 - late_share(c[1], c[2], t);
                        c[1] = c[1].min(t);
                    }
                }
                if retries > 0.0 && !kids.is_empty() {
                    let extra = (child_lat - lat).max(0.0);
                    for c in kids.iter_mut() {
                        c[1] += extra;
                    }
                }
                let (own_share, kid_share) = match d.kind.as_str() {
                    "client" => (0.0, 1.0),
                    "queue" | "stream" => (1.0, 0.0),
                    "cache" | "cdn" | "edge" | "db" => (l.local_share, 1.0 - l.local_share),
                    _ => (if has_kids { 0.0 } else { 1.0 }, 1.0),
                };
                // a function's cold starts are a slow mode of their own, not a little on every answer
                let modes: Vec<(f64, f64)> = if d.kind == "function" && st.cold_frac > 0.0 {
                    let (cf, cold) = (st.cold_frac.min(1.0), cold_start_of(d, cfg));
                    vec![(1.0 - cf, own_mean - cf * cold), (cf, own_mean + (1.0 - cf) * cold)]
                } else {
                    vec![(1.0, own_mean)]
                };
                let mut out: Vec<[f64; 3]> = vec![];
                for &(mw, own_mean) in &modes {
                    if own_share > 0.0 || kids.is_empty() {
                        let w = own_share.max(if kids.is_empty() { 1.0 } else { 0.0 }) * mw;
                        if l.write_extra_ms > 0.0 {
                            // writes wait for synchronous replicas: a slower mode of their own
                            out.push([w * l.rr, own_mean, own_tail]);
                            out.push([w * (1.0 - l.rr), own_mean + l.write_extra_ms, own_tail]);
                        } else {
                            out.push([w, own_mean, own_tail]);
                        }
                    }
                    if kid_share > 0.0 && !kids.is_empty() {
                        out.extend(mix_then(&kids, own_mean, own_tail, kid_share * mw));
                    }
                }
                if st.breaker_pass < 1.0 && d.fallback == Some(true) {
                    let p = st.breaker_pass;
                    for c in out.iter_mut() {
                        c[0] *= p;
                    }
                    out.push([1.0 - p, 2.0, 0.0]);
                }
                mix_merge(out)
            };
            // the tail the users see is the mixture's: a cache's misses are its 99th percentile
            let tail_total = if dist.is_empty() {
                tail_total
            } else {
                let (_, p99) = mix_mean_p99(&dist);
                (p99 - latency).max(0.0)
            };
            st.dist = dist;
            // write-behind flushes the origin did not take are writes lost
            if st.wb_flushed > 0.0 {
                lost_now += st.wb_flushed * if has_kids { 1.0 - succ } else { 1.0 };
            }
            st.success = ema(st.success, success, dt, 0.3);
            st.success_r = ema(st.success_r, success_r, dt, 0.3);
            st.success_w = ema(st.success_w, success_w, dt, 0.3);
            st.latency_ms = ema(st.latency_ms, latency, dt, 0.3);
            let own_now = if l.up && d.kind != "client" { fold(&FoldCtx { d, keep, local_share: 1.0, child_succ: 1.0, child_lat: 0.0, has_kids: false, cfg }, st).1 + d.fault_latency_ms.filter(|x| !x.is_nan()).unwrap_or(0.0) } else { 0.0 };
            st.own_ms = ema(st.own_ms, own_now, dt, 0.3);
            st.tail_ms = ema(st.tail_ms, tail_total, dt, 0.3);
            let usage = usage_cost(d, st, profile);
            let fixed = match billed {
                Some(b) => cost_of(&NodeData { instances: Some(b), ..d.clone() }, profile),
                None => cost_of(d, profile),
            };
            st.cost_per_hour = fixed + usage;
            let over = l.up && d.kind != "client" && d.kind != "queue" && d.kind != "stream" && st.drop_rps > (st.in_rps * 0.02).max(1.0);
            if over && !st.overloaded {
                events.push(SimEvent { kind: "overload".into(), node_id: id.into(), name: d.name.clone(), detail: None });
            }
            if !over && st.overloaded {
                events.push(SimEvent { kind: "recovered".into(), node_id: id.into(), name: d.name.clone(), detail: None });
            }
            st.overloaded = over;
            if d.kind == "db" && st.failover == Failover::Promoted {
                if let Some(fs) = failover_after(d, cfg.failover_s) {
                    if st.down_for - dt < fs {
                        events.push(SimEvent { kind: "failover".into(), node_id: id.into(), name: d.name.clone(), detail: None });
                    }
                }
            }
        }

        self.global.lost_writes += lost_now;
        self.global.stale_reads += stale_now;
        self.global.replica_lag_s = (0..n).filter(|&i| data[i].kind == "replica").map(|i| self.nodes[sidx[i]].repl_lag).fold(0.0, f64::max);

        // autoscalers react to the demand they saw this tick
        for k in 0..self.scalers.len() {
            let id = self.scalers.get_index(k).unwrap().0.clone();
            let i = match by_id.get(id.as_str()) {
                Some(i) => *i,
                None => continue,
            };
            let orig = &nodes_in[i].data;
            let demand = self.nodes[sidx[i]].in_rps;
            let per = per_instance_capacity(orig);
            let sc = self.scalers.get_index_mut(k).unwrap().1;
            for (kind, from, to) in step_scaler(sc, orig, now, demand, per) {
                if kind != "scaled" {
                    events.push(SimEvent { kind: kind.into(), node_id: id.clone(), name: orig.name.clone(), detail: Some(format!("{} → {}", js_num(from), js_num(to))) });
                }
            }
        }

        if self.edges.len() != edges.len() || edges.iter().any(|e| !self.edges.contains_key(&e.id)) {
            let live: HashSet<&str> = edges.iter().map(|e| e.id.as_str()).collect();
            self.edges.retain(|k, _| live.contains(k.as_str()));
        }
        for (ei, e) in edges.iter().enumerate() {
            match self.edges.get_mut(&e.id) {
                Some(v) => *v = ema(*v, edge_flow[ei] / dt, dt, 0.6),
                None => {
                    self.edges.insert(e.id.clone(), ema(0.0, edge_flow[ei] / dt, dt, 0.6));
                }
            }
        }
        // states are indexed: prune only when the graph lost a node
        let cost = (0..n).fold(0.0, |s, i| s + self.nodes[sidx[i]].cost_per_hour);
        let (mut rps, mut ok, mut lat) = (0.0, 0.0, 0.0);
        for &c in &clients {
            let st = &self.nodes[sidx[c]];
            rps += st.in_rps;
            ok += st.in_rps * st.success;
            lat += st.in_rps * (st.latency_ms + st.tail_ms);
        }
        if self.nodes.len() != n {
            self.nodes.retain(|k, _| by_id.contains_key(k.as_str()));
        }

        // ---- global ----
        let g = &mut self.global;
        g.t = self.t;
        g.rps = rps;
        g.error_rate = if rps > 0.5 { (1.0 - ok / rps).max(0.0) } else { 0.0 };
        // failed requests count as timeouts: with ≥1% failures the 99th percentile *is* a failure
        let ok_lat = if ok > 0.0 { lat / rps } else { 0.0 };
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
        self.snapshot_with(nodes, edges, true)
    }

    /// without each node's utilisation history (headless runs never read it)
    pub fn snapshot_with(&mut self, nodes: &[SimNode], edges: &[SimEdge], with_history: bool) -> Snapshot {
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
                    repl_lag_s: st.repl_lag,
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
                    history: if with_history { st.history.iter().copied().collect() } else { vec![] },
                    scaling,
                    warmth: st.warmth,
                    hold_ms: if n.data.threads.is_some() { st.hold_ms } else { 0.0 },
                    own_ms: st.own_ms,
                    dead_letter_rps: st.dead_letter_rps,
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
        let global = if with_history { self.global.clone() } else { GlobalStats { history: vec![], ..self.global.clone() } };
        Snapshot { node_stats, edge_stats, global }
    }
}
