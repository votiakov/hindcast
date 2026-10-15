//! Discrete-event simulation (src/sim/des/des.ts) — the analysis engine. Every request is an
//! individual entity; each component is a pool of workers in front of a bounded FIFO queue with
//! log-normal service times. Routing, retries, timeouts and breakers act on single requests, so retry
//! storms, metastable failures, breaker oscillation and tail latency emerge. Deterministic per seed.
//!
//! The TypeScript engine passes closures through its event queue; here each pending continuation is a
//! record in a slab (what to do when the answer comes back), and events say which one to run. Events
//! are ordered by (time, push order) and random draws happen in the same order, so a seed gives the
//! same run in both.

#[allow(unused_imports)]
use crate::fmath::JsMath;
use super::catalog::*;
use super::engine::{NodeStats, Scaling, SimEdge, SimNode};
use super::headless::{explain, node_view};
use super::spec::{graph_of, parse_architecture, parse_scenario, Action, Architecture, Scenario};
use crate::backtest::{js_max, js_sort_by};
use crate::math::{js_num, js_round};
use crate::strategy::locale_int;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct DesConfig {
    pub seed: f64,
    pub service_cv: f64,
    pub queue_s: f64,
    pub failover_s: Option<f64>,
    pub cold_start_ms: f64,
    pub hop_ms: f64,
    pub max_events: f64,
}

impl Default for DesConfig {
    fn default() -> Self {
        DesConfig { seed: 1.0, service_cv: 0.6, queue_s: 1.0, failover_s: Some(3.0), cold_start_ms: 400.0, hop_ms: 0.3, max_events: 60_000_000.0 }
    }
}

const BR_MIN_CALLS: f64 = 10.0;
const BR_TRIP_FAIL: f64 = 0.5;
const BR_OPEN_S: f64 = 5.0;
const BR_PROBE: f64 = 0.1;
const BR_CLOSE_FAIL: f64 = 0.1;
const BACKOFF_BASE_MS: f64 = 50.0;
const BACKOFF_CAP: f64 = 2000.0;
const BUDGET_RATIO: f64 = 0.1;
const BUDGET_CAP: f64 = 20.0;
const QUEUE_BACKLOG_MAX: usize = 200_000;

// ---------- random numbers (src/sim/des/random.ts) ----------

pub struct Rng {
    s: u32,
    spare: Option<f64>,
}

impl Rng {
    pub fn new(seed: f64) -> Rng {
        let s = (seed as i64) as u32;
        Rng { s: if s == 0 { 0x9e3779b9 } else { s }, spare: None }
    }
    /// uniform [0, 1)
    pub fn next(&mut self) -> f64 {
        self.s = self.s.wrapping_add(0x6d2b79f5);
        let mut t = self.s;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
    /// standard normal (Box–Muller, the second value kept for the next call)
    pub fn normal(&mut self) -> f64 {
        if let Some(v) = self.spare.take() {
            return v;
        }
        let mut u = 0.0;
        while u == 0.0 {
            u = self.next();
        }
        let v = self.next();
        let r = (-2.0 * u.js_ln()).sqrt();
        self.spare = Some(r * (2.0 * std::f64::consts::PI * v).js_sin());
        r * (2.0 * std::f64::consts::PI * v).js_cos()
    }
    pub fn exp(&mut self, mean: f64) -> f64 {
        -(1.0 - self.next()).js_ln() * mean
    }
    /// log-normal with the given mean and coefficient of variation
    pub fn lognormal(&mut self, mean: f64, cv: f64) -> f64 {
        if cv <= 0.0 {
            return mean;
        }
        let s2 = (1.0 + cv * cv).js_ln();
        (mean.js_ln() - s2 / 2.0 + s2.sqrt() * self.normal()).js_exp()
    }
}

// ---------- latency histogram (src/sim/des/histogram.ts) ----------

const MIN_MS: f64 = 0.05;
const GROWTH: f64 = 1.025;

fn buckets() -> usize {
    ((1_000_000.0f64 / MIN_MS).js_ln() / GROWTH.js_ln()).ceil() as usize + 1
}

#[derive(Clone)]
pub struct Histogram {
    counts: Vec<u32>,
    total: u64,
    sum: f64,
    max: f64,
    log_g: f64,
}

impl Histogram {
    pub fn new() -> Histogram {
        Histogram { counts: vec![0; buckets()], total: 0, sum: 0.0, max: 0.0, log_g: GROWTH.js_ln() }
    }
    pub fn record(&mut self, ms: f64) {
        let v = ms.max(MIN_MS);
        let i = ((v / MIN_MS).js_ln() / self.log_g).floor().min((self.counts.len() - 1) as f64) as usize;
        self.counts[i] += 1;
        self.total += 1;
        self.sum += ms;
        if ms > self.max {
            self.max = ms;
        }
    }
    /// q in [0, 1] → latency (the bucket's upper edge)
    pub fn quantile(&self, q: f64) -> f64 {
        if self.total == 0 {
            return 0.0;
        }
        let target = (q * self.total as f64).ceil();
        let mut acc = 0.0;
        for (i, c) in self.counts.iter().enumerate() {
            acc += *c as f64;
            if acc >= target {
                return self.max.min(MIN_MS * GROWTH.js_pow((i + 1) as f64));
            }
        }
        self.max
    }
    pub fn reset(&mut self) {
        for c in self.counts.iter_mut() {
            *c = 0;
        }
        self.total = 0;
        self.sum = 0.0;
        self.max = 0.0;
    }
}

// ---------- event queue: a binary heap keyed by (time, seq) ----------

struct EventQueue {
    t: Vec<f64>,
    s: Vec<u64>,
    e: Vec<Ev>,
    seq: u64,
}

impl EventQueue {
    fn new() -> Self {
        EventQueue { t: vec![], s: vec![], e: vec![], seq: 0 }
    }
    fn len(&self) -> usize {
        self.t.len()
    }
    fn push(&mut self, time: f64, ev: Ev) {
        let seq = self.seq;
        self.seq += 1;
        let mut i = self.t.len();
        self.t.push(time);
        self.s.push(seq);
        self.e.push(ev.clone());
        while i > 0 {
            let p = (i - 1) >> 1;
            if self.t[p] < time || (self.t[p] == time && self.s[p] < seq) {
                break;
            }
            self.t[i] = self.t[p];
            self.s[i] = self.s[p];
            self.e[i] = self.e[p].clone();
            i = p;
        }
        self.t[i] = time;
        self.s[i] = seq;
        self.e[i] = ev;
    }
    fn peek_time(&self) -> f64 {
        self.t[0]
    }
    fn pop(&mut self) -> Ev {
        let top = self.e[0].clone();
        let lt = self.t.pop().unwrap();
        let ls = self.s.pop().unwrap();
        let le = self.e.pop().unwrap();
        let n = self.t.len();
        if n > 0 {
            let mut i = 0;
            loop {
                let l = 2 * i + 1;
                if l >= n {
                    break;
                }
                let r = l + 1;
                let c = if r < n && (self.t[r] < self.t[l] || (self.t[r] == self.t[l] && self.s[r] < self.s[l])) { r } else { l };
                if self.t[c] > lt || (self.t[c] == lt && self.s[c] > ls) {
                    break;
                }
                self.t[i] = self.t[c];
                self.s[i] = self.s[c];
                self.e[i] = self.e[c].clone();
                i = c;
            }
            self.t[i] = lt;
            self.s[i] = ls;
            self.e[i] = le;
        }
        top
    }
}

// ---------- continuations ----------

type ContId = usize;

/// how a request ended: OK, or the component it failed at and why (node + 1 in the high bits, so
/// that 0 is OK), carried up to the user so each failure is counted where it started
type Why = u32;
const OK: Why = 0;
const R_DOWN: u8 = 1;
const R_LIMIT: u8 = 2;
const R_SHED: u8 = 3;
const R_TIMEOUT: u8 = 4;
const R_PARTITION: u8 = 5;
const R_ERROR: u8 = 6;
const R_BREAKER: u8 = 7;
const R_DNS: u8 = 8;
const R_NO_ROUTE: u8 = 9;
const R_SYNC: u8 = 10;
const R_BULKHEAD: u8 = 11;
const R_THREADS: u8 = 12;

fn why(n: usize, r: u8) -> Why {
    ((n as u32 + 1) << 8) | r as u32
}

/// what a user would read: the cause, worded for the component it happened at
fn reason_text(r: u8) -> &'static str {
    match r {
        R_DOWN => "down",
        R_LIMIT => "rate limited",
        R_SHED => "overloaded",
        R_TIMEOUT => "timed out waiting on its calls",
        R_PARTITION => "unreachable (network partition)",
        R_ERROR => "returned errors",
        R_BREAKER => "circuit breaker open",
        R_DNS => "stale DNS answer",
        R_NO_ROUTE => "no healthy target",
        R_SYNC => "synchronous replica unreachable",
        R_BULKHEAD => "bulkhead full (call refused at once)",
        R_THREADS => "out of threads (all waiting on calls)",
        _ => "failed",
    }
}

#[derive(Clone, Copy)]
enum Cont {
    /// a user's request finished
    User { t0: f64 },
    /// one attempt of a call settled (the answer, or its deadline): reachable twice when timed
    Settle { call: usize, k: f64, settled: bool, refs: u8 },
    /// one part of a fan-out or scatter-gather
    Part { group: usize },
    /// the failover target at position i answered
    Failover { n: usize, read: bool, order: usize, i: usize, done: ContId },
    /// a queue's consumer finished one message
    Consumer { queue: usize },
    /// a stream's subscriber (its k-th child) finished one message
    SubConsumer { stream: usize, k: usize },
    /// a write-behind cache's flush to the origin settled
    Flushed,
    /// the request held one of the component's threads until its answer (thread-per-request)
    Hold { n: usize, done: ContId, t0: f64 },
    /// a call through a bulkhead: its slot for that dependency is freed when it settles
    Bulk { n: usize, k: usize, done: ContId },
    Free,
}

#[derive(Clone, Copy)]
enum Ev {
    Generate { c: usize, emit: bool },
    Arrive { i: usize, read: bool, done: ContId },
    Deliver { done: ContId, why: Why },
    Finish { n: usize, job: Job },
    /// fault: the node's fault rate when the request arrived
    LlmDone { n: usize, done: ContId, fault: f64 },
    Attempt { call: usize, k: f64 },
    Timeout { settle: ContId },
    Sample,
    Scenario { k: usize },
    /// a write-behind cache flushes one buffered write to its origin
    Flush { n: usize },
}

#[derive(Clone, Copy)]
struct Job {
    read: bool,
    t_in: f64,
    /// None: a queue's backlog entry (its producer was already answered)
    done: Option<ContId>,
    /// a sharded database: the shard that holds the key (0 is the hot key's)
    shard: u16,
}

const NO_SHARD: u16 = u16::MAX;

/// a call to the children, with what the caller's data said when it began (retries see the same)
struct Call {
    n: usize,
    read: bool,
    done: ContId,
    retries: f64,
    policy: &'static str,
    timeout: Option<f64>,
    breaker: bool,
}

struct Group {
    pending: usize,
    /// the first part that failed (OK while all have answered)
    why: Why,
    done: ContId,
}

struct Win {
    arrivals: f64,
    drops: f64,
    hits: f64,
    busy_area: f64,
    calls: f64,
    attempts: f64,
    late: f64,
    usage_reqs: f64,
    /// a sharded database: shard 0's busy worker-seconds
    hot_area: f64,
    /// thread-per-request: seconds threads were held, and how many requests released one
    held_s: f64,
    held_n: f64,
}

fn new_win() -> Win {
    Win { arrivals: 0.0, drops: 0.0, hits: 0.0, busy_area: 0.0, calls: 0.0, attempts: 0.0, late: 0.0, usage_reqs: 0.0, hot_area: 0.0, held_s: 0.0, held_n: 0.0 }
}

struct DNode {
    id: String,
    /// the kind, and the routing mode, as static strings (no allocation per request)
    kind: &'static str,
    mode: &'static str,
    raw: NodeData,
    data: NodeData,
    scaler: Option<super::engine::ScalerState>,
    cold_at: Option<f64>,
    flush_seen: f64,
    children: Vec<usize>,
    pooled: bool,
    workers: f64,
    svc_mean_ms: f64,
    busy: f64,
    /// a sharded database: shards, workers and queue bound per shard (0: not sharded), each shard's
    /// busy workers and queue, the hot key's share, and when shard 0's busy count last changed
    sh_n: usize,
    sh_workers: f64,
    sh_qmax: f64,
    sh_busy: Vec<f64>,
    sh_queue: Vec<VecDeque<Job>>,
    hot: f64,
    hot_last_t: f64,
    /// a key-value store: the hot key's partition, in partition-seconds of work available
    kv_bucket: f64,
    kv_t: f64,
    /// an object store: each prefix's bucket of prefix-seconds, and when it was last topped up
    px_bucket: Vec<f64>,
    px_t: Vec<f64>,
    /// when it went down (DNS answers lag it)
    dead_since: Option<f64>,
    /// a stream: each subscriber's backlog and messages in flight, by child position
    sub_backlog: Vec<VecDeque<Job>>,
    sub_inflight: Vec<f64>,
    /// thread-per-request: threads (∞: async) and requests holding one, waiting on calls included
    threads_cap: f64,
    held: f64,
    /// a bulkhead: calls that may wait on each dependency (∞: none), and those waiting, by child position
    bulk_cap: f64,
    bulk_inflight: Vec<f64>,
    queue: VecDeque<Job>,
    queue_max: f64,
    last_busy_t: f64,
    rate: f64,
    tokens: f64,
    last_refill: f64,
    warm: f64,
    down_since: Option<f64>,
    /// a replica: replication lag behind its primary, s
    repl_lag: f64,
    /// a database: writes that arrived this second, and whether its promotion's loss was counted
    writes_win: f64,
    writes_rate: f64,
    promoted_counted: bool,
    br: &'static str,
    br_until: f64,
    br_ok: f64,
    br_fail: f64,
    retry_tokens: f64,
    backlog: VecDeque<Job>,
    inflight: f64,
    win: Win,
    peak_util: f64,
    util_sum: f64,
    util_n: f64,
    drops_total: f64,
    worst: f64,
    worst_note: Option<String>,
    last_stats: Option<NodeStats>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DesSummary {
    pub duration_s: f64,
    pub mean_rps: f64,
    pub mean_error_rate: f64,
    pub peak_error_rate: f64,
    pub p50_ms: f64,
    pub p90_ms: f64,
    pub p99_ms: f64,
    pub p999_ms: f64,
    pub mean_p99_ms: f64,
    pub peak_p99_ms: f64,
    pub mean_cost_per_hour: f64,
    pub peak_cost_per_hour: f64,
    pub slo_compliance: f64,
    pub slo_breach_seconds: f64,
    pub requests: f64,
    pub failed_requests: f64,
    /// writes a write-behind cache acknowledged and then lost
    #[serde(skip_serializing_if = "is_zero")]
    pub lost_writes: f64,
    /// reads answered by a replica more than a second behind its primary
    #[serde(skip_serializing_if = "is_zero")]
    pub stale_reads: f64,
    /// the furthest any replica fell behind its primary, s
    #[serde(skip_serializing_if = "is_zero")]
    pub max_replica_lag_s: f64,
    pub worst_moment_s: f64,
    pub events: f64,
    pub wall_ms: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DesPoint {
    pub t: f64,
    pub rps: f64,
    pub error_rate: f64,
    pub p50_ms: f64,
    pub p99_ms: f64,
    pub cost_per_hour: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DesComponent {
    pub kind: String,
    pub peak_util: f64,
    pub mean_util: f64,
    pub dropped_total: f64,
    pub final_status: String,
    pub note: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DesResult {
    pub engine: &'static str,
    pub seed: f64,
    pub architecture: String,
    pub scenario: String,
    pub summary: DesSummary,
    pub slo: super::headless::SloOut,
    pub timeline: Vec<DesPoint>,
    pub components: IndexMap<String, DesComponent>,
    pub bottlenecks: Vec<super::headless::Bottleneck>,
    /// why requests failed: the component each failure started at and the cause, most first
    pub failures: Vec<FailureCause>,
    pub events: Vec<super::headless::Event>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FailureCause {
    pub id: String,
    pub name: String,
    pub reason: &'static str,
    pub requests: f64,
    /// of all failed requests
    pub share: f64,
}

fn r3(n: f64) -> f64 {
    js_round(n * 1000.0) / 1000.0
}

fn up(n: &DNode) -> bool {
    n.data.alive && instances_up(&n.data) > 0.0
}

struct Des<'a> {
    cfg: DesConfig,
    sc: &'a Scenario,
    pricing: String,
    rng: Rng,
    q: EventQueue,
    now: f64,
    nodes: Vec<DNode>,
    link_ms: HashMap<(usize, usize), f64>,
    /// calls per request over a link, when more than one
    link_calls: HashMap<(usize, usize), f64>,
    /// links that carry only reads (1) or only writes (2)
    link_carries: HashMap<(usize, usize), u8>,
    /// database → replica links replicated synchronously
    link_sync: std::collections::HashSet<(usize, usize)>,
    /// each replica's primary
    primary_of: HashMap<usize, usize>,
    stale_reads: f64,
    max_replica_lag: f64,
    conts: Vec<Cont>,
    free: Vec<ContId>,
    calls: Vec<Option<Call>>,
    groups: Vec<Option<Group>>,
    orders: Vec<Vec<usize>>,
    clients: Vec<usize>,
    user_hist: Histogram,
    win_hist: Histogram,
    win_reqs: f64,
    win_fail: f64,
    /// failed user requests by where and why they failed
    fail_by: HashMap<Why, f64>,
    total_reqs: f64,
    total_fail: f64,
    lost_writes: f64,
    traffic: Vec<(f64, f64)>,
    ev_log: Vec<super::headless::Event>,
    timeline: Vec<DesPoint>,
    breach: f64,
    worst_t: f64,
    worst_score: f64,
    sim_nodes: Vec<SimNode>,
    zones: IndexMap<String, Vec<String>>,
}

impl<'a> Des<'a> {
    /// b is up and a network partition does not cut it off from a
    fn reach(&self, a: usize, b: usize) -> bool {
        up(&self.nodes[b]) && !self.link_cut(a, b)
    }

    fn cont(&mut self, c: Cont) -> ContId {
        if let Some(i) = self.free.pop() {
            self.conts[i] = c;
            i
        } else {
            self.conts.push(c);
            self.conts.len() - 1
        }
    }

    fn at(&mut self, dt_ms: f64, ev: Ev) {
        self.q.push(self.now + dt_ms / 1000.0, ev);
    }

    /// the link a → b is cut: the two are on different sides of a partition, or the link itself is
    fn link_cut(&self, a: usize, b: usize) -> bool {
        cut(&self.nodes[a].data, &self.nodes[b].data) || self.nodes[a].data.cut_to.as_ref().map_or(false, |v| v.iter().any(|x| *x == self.nodes[b].id))
    }

    fn set_busy(&mut self, n: usize, delta: f64) {
        let now = self.now;
        let x = &mut self.nodes[n];
        x.win.busy_area += x.busy * (now - x.last_busy_t);
        x.last_busy_t = now;
        x.busy += delta;
    }

    fn fail(&mut self, n: Option<usize>, why: Why, done: ContId, ms: f64) {
        if let Some(n) = n {
            self.nodes[n].win.drops += 1.0;
            self.nodes[n].drops_total += 1.0;
        }
        self.at(ms, Ev::Deliver { done, why });
    }

    /// derive pool size, service time and limits from the node's (possibly changed) data
    fn configure(&mut self, i: usize) {
        let now = self.now;
        let cfg_queue = self.cfg.queue_s;
        let n = &mut self.nodes[i];
        n.mode = match n.raw.routing.as_deref() {
            Some("fanout") => "fanout",
            Some("failover") => "failover",
            _ => "split",
        };
        n.data = match (&n.raw.autoscale, &n.scaler) {
            (Some(_), Some(s)) => NodeData { instances: Some(s.live), down: Some(s.live.min(n.raw.down.unwrap_or(0.0) - s.replaced).max(0.0)), ..n.raw.clone() },
            _ => n.raw.clone(),
        };
        if (n.raw.kind == "cache" || n.raw.kind == "cdn") && (!up(n) || n.raw.flushes.unwrap_or(0.0) != n.flush_seen) {
            n.cold_at = Some(now);
        }
        n.flush_seen = n.raw.flushes.unwrap_or(0.0);
        n.dead_since = if up(n) { None } else { n.dead_since.or(Some(now)) };
        let d = &n.data;
        let reach = if n.pooled || d.kind == "llm" { instances_up(d) } else { instances_up(d).min(1.0) };
        let cap = capacity_of(d, Some(reach)).max(1e-6);
        let lat = base_latency_of(d).max(0.05);
        let kind = d.kind.as_str();
        if kind == "storage" {
            // a managed store: no pool to fill, only its prefixes' limits (checked as requests arrive)
            n.rate = f64::INFINITY;
            n.workers = f64::INFINITY;
            n.svc_mean_ms = d.latency_ms.unwrap_or(spec(kind).base_latency_ms);
        } else if kind == "gateway" || kind == "llmapi" || kind == "external" || kind == "kv" || kind == "stream" {
            n.rate = d.limit.unwrap_or(spec(kind).capacity);
            n.workers = f64::INFINITY;
            n.svc_mean_ms = if kind == "llmapi" || kind == "external" || kind == "kv" { d.latency_ms.unwrap_or(spec(kind).base_latency_ms) } else { lat };
        } else if kind == "function" {
            n.rate = f64::INFINITY;
            n.workers = js_round(d.limit.unwrap_or(3000.0) * (lat / 1000.0)).max(1.0);
            n.svc_mean_ms = lat;
        } else {
            n.rate = f64::INFINITY;
            n.workers = js_round(cap * (lat / 1000.0)).max(1.0);
            // keep total capacity exact: workers / service time = capacity
            n.svc_mean_ms = (n.workers / cap) * 1000.0;
        }
        n.tokens = n.tokens.min(n.rate);
        n.threads_cap = match d.threads.filter(|t| *t > 0.0) {
            Some(t) if kind == "server" || kind == "worker" => t * reach,
            _ => f64::INFINITY,
        };
        n.bulk_cap = d.bulkhead.filter(|b| *b > 0.0).map(|b| b * reach.max(1.0)).unwrap_or(f64::INFINITY);
        // serverless throttles instead of queueing; unlimited pools never queue
        n.queue_max = if kind == "function" || !n.workers.is_finite() { 0.0 } else { (cap * d.queue_s.or(spec(kind).queue_s).unwrap_or(cfg_queue)).floor().max(1.0) };
        // a sharded database: a pool and a queue per shard
        // (a sharded replica's reads spread evenly: one pool of all its shards' workers)
        let shards = if kind == "db" { shards_of(d) } else { 1.0 };
        if shards > 1.0 {
            let k = shards as usize;
            let one = cap / shards;
            n.sh_n = k;
            n.sh_workers = js_round(one * (lat / 1000.0)).max(1.0);
            n.svc_mean_ms = (n.sh_workers / one) * 1000.0;
            n.workers = n.sh_workers * shards;
            n.sh_qmax = (one * d.queue_s.or(spec(kind).queue_s).unwrap_or(cfg_queue)).floor().max(1.0);
            n.hot = d.hot_key_share.unwrap_or(0.0).clamp(0.0, 1.0);
            if n.sh_busy.len() < k {
                n.sh_busy.resize(k, 0.0);
                n.sh_queue.resize_with(k, VecDeque::new);
            }
        } else {
            n.sh_n = 1;
            n.sh_workers = 0.0;
        }
    }

    fn shard_busy(&mut self, n: usize, s: usize, delta: f64) {
        let now = self.now;
        let x = &mut self.nodes[n];
        if s >= x.sh_busy.len() {
            return;
        }
        if s == 0 {
            x.win.hot_area += x.sh_busy[0] * (now - x.hot_last_t);
            x.hot_last_t = now;
        }
        x.sh_busy[s] += delta;
    }

    /// run a continuation now
    fn deliver(&mut self, id: ContId, why: Why) {
        let ok = why == OK;
        match self.conts[id] {
            Cont::User { t0 } => {
                self.release(id);
                let ms = (self.now - t0) * 1000.0;
                self.win_reqs += 1.0;
                self.total_reqs += 1.0;
                if ok {
                    self.win_hist.record(ms);
                    self.user_hist.record(ms);
                } else {
                    self.win_fail += 1.0;
                    self.total_fail += 1.0;
                    *self.fail_by.entry(why).or_insert(0.0) += 1.0;
                }
            }
            Cont::Settle { .. } => self.settle(id, why, false),
            Cont::Part { group } => {
                self.release(id);
                let g = self.groups[group].as_mut().unwrap();
                if g.why == OK {
                    g.why = why;
                }
                g.pending -= 1;
                if g.pending == 0 {
                    let g = self.groups[group].take().unwrap();
                    self.deliver(g.done, g.why);
                }
            }
            Cont::Failover { n, read, order, i, done } => {
                self.release(id);
                let len = self.orders[order].len();
                if ok || i + 1 >= len {
                    self.deliver(done, why);
                } else {
                    self.try_failover(n, read, order, i + 1, done);
                }
            }
            Cont::Consumer { queue } => {
                self.release(id);
                self.nodes[queue].inflight -= 1.0;
                self.pump(queue);
            }
            Cont::SubConsumer { stream, k } => {
                self.release(id);
                self.nodes[stream].sub_inflight[k] -= 1.0;
                self.pump_stream(stream);
            }
            Cont::Flushed => {
                self.release(id);
                if !ok {
                    self.lost_writes += 1.0;
                }
            }
            Cont::Hold { n, done, t0 } => {
                self.release(id);
                self.nodes[n].held -= 1.0;
                self.nodes[n].win.held_s += self.now - t0;
                self.nodes[n].win.held_n += 1.0;
                let bound = {
                    let d = &self.nodes[n].data;
                    d.queue_s.or(spec(&d.kind).queue_s).unwrap_or(self.cfg.queue_s) * 1000.0
                };
                self.drain(n, bound);
                self.deliver(done, why);
            }
            Cont::Bulk { n, k, done } => {
                self.release(id);
                self.nodes[n].bulk_inflight[k] -= 1.0;
                self.deliver(done, why);
            }
            Cont::Free => {}
        }
    }

    fn release(&mut self, id: ContId) {
        self.conts[id] = Cont::Free;
        self.free.push(id);
    }

    fn arrive(&mut self, i: usize, read: bool, done: ContId) {
        self.nodes[i].win.arrivals += 1.0;
        let kind = self.nodes[i].kind;
        if kind == "replica" && read && self.nodes[i].repl_lag > 1.0 {
            self.stale_reads += 1.0;
        }
        if kind == "db" && !read {
            self.nodes[i].writes_win += 1.0;
        }
        if kind == "db" {
            return self.arrive_db(i, read, done);
        }
        let kind: &str = kind;
        if !up(&self.nodes[i]) {
            return self.fail(Some(i), why(i, R_DOWN), done, 0.5);
        }
        let now = self.now;
        {
            let n = &mut self.nodes[i];
            if n.rate.is_finite() {
                n.tokens = n.rate.min(n.tokens + (now - n.last_refill) * n.rate);
                n.last_refill = now;
                if n.tokens < 1.0 {
                    return self.fail(Some(i), why(i, R_LIMIT), done, 1.0); // 429
                }
                n.tokens -= 1.0;
            }
        }
        if kind == "stream" {
            // every subscriber gets it; past retention the oldest expire unread
            for k in 0..self.nodes[i].children.len() {
                let q = &mut self.nodes[i].sub_backlog[k];
                if q.len() >= QUEUE_BACKLOG_MAX {
                    q.pop_front();
                }
                q.push_back(Job { read, t_in: now, done: None, shard: NO_SHARD });
            }
            let ack = base_latency_of(&self.nodes[i].data);
            self.at(ack, Ev::Deliver { done, why: OK }); // the producer gets the ack
            self.pump_stream(i);
            return;
        }
        if kind == "queue" {
            if self.nodes[i].backlog.len() >= QUEUE_BACKLOG_MAX {
                return self.fail(Some(i), why(i, R_SHED), done, 0.5);
            }
            self.nodes[i].backlog.push_back(Job { read, t_in: now, done: None, shard: NO_SHARD });
            let ack = base_latency_of(&self.nodes[i].data);
            self.at(ack, Ev::Deliver { done, why: OK }); // the producer gets the ack
            self.pump(i);
            return;
        }
        if kind == "dns" {
            // clients that still hold an answer pointing at a dead target: they wait for the connection
            // to time out, and fail
            let d = &self.nodes[i].data;
            let targets: Vec<(bool, f64)> = self.nodes[i].children.iter().map(|&c| if self.reach(i, c) { (true, 0.0) } else { (false, self.nodes[c].dead_since.map(|t| now - t).unwrap_or(0.0)) }).collect();
            let stale = super::catalog::dns_stale_share(d, &targets);
            if stale > 0.0 && self.rng.next() < stale {
                return self.fail(Some(i), why(i, R_DNS), done, 1000.0);
            }
        }
        if kind == "kv" {
            // the hot key's partition: a bucket of partition-seconds, a read costing 1/3,000, a write 1/1,000
            let h = self.nodes[i].data.hot_key_share.unwrap_or(0.0);
            if h > 0.0 && self.rng.next() < h {
                let n = &mut self.nodes[i];
                n.kv_bucket = (n.kv_bucket + (now - n.kv_t)).min(1.0);
                n.kv_t = now;
                let cost = if read { 1.0 / super::catalog::KV_PARTITION_READS } else { 1.0 / super::catalog::KV_PARTITION_WRITES };
                if n.kv_bucket < cost {
                    return self.fail(Some(i), why(i, R_LIMIT), done, 1.0); // throttled
                }
                n.kv_bucket -= cost;
            }
        }
        if kind == "storage" {
            // the request's prefix: the hot one, or one picked by its key's hash
            let p = super::catalog::prefixes_of(&self.nodes[i].data) as usize;
            let h = self.nodes[i].data.hot_key_share.unwrap_or(0.0);
            let k = if self.rng.next() < h { 0 } else { ((self.rng.next() * p as f64).floor() as usize).min(p - 1) };
            let deg = self.nodes[i].data.degraded.unwrap_or(1.0).max(1e-6);
            let n = &mut self.nodes[i];
            if n.px_bucket.len() != p {
                n.px_bucket = vec![1.0; p];
                n.px_t = vec![now; p];
            }
            n.px_bucket[k] = (n.px_bucket[k] + (now - n.px_t[k])).min(1.0);
            n.px_t[k] = now;
            let cost = (if read { 1.0 / super::catalog::PREFIX_READS } else { 1.0 / super::catalog::PREFIX_WRITES }) / deg;
            if n.px_bucket[k] < cost {
                return self.fail(Some(i), why(i, R_LIMIT), done, 1.0); // 503 SlowDown
            }
            n.px_bucket[k] -= cost;
        }
        if kind == "llmapi" || kind == "external" || kind == "kv" || kind == "storage" {
            // provider capacity is not your problem — only its rate limit and latency are
            let n = &self.nodes[i];
            let (mean, fl) = (n.svc_mean_ms, n.data.fault_latency_ms.unwrap_or(0.0));
            let cv = self.cfg.service_cv * 0.5;
            let svc = self.rng.lognormal(mean, cv) + fl;
            let fault = self.nodes[i].data.fault_rate.unwrap_or(0.0);
            self.at(svc, Ev::LlmDone { n: i, done, fault });
            return;
        }
        self.enqueue(i, Job { read, t_in: now, done: Some(done), shard: NO_SHARD });
    }

    fn arrive_db(&mut self, i: usize, read: bool, done: ContId) {
        // a dead primary's replicas are chosen around it: the partition does not stop the failover
        let primary_up = up(&self.nodes[i]);
        let mut replicas: Vec<usize> = self.nodes[i].children.iter().copied().filter(|&c| self.nodes[c].data.kind == "replica" && if primary_up { self.reach(i, c) } else { up(&self.nodes[c]) }).collect();
        // the replica furthest along is promoted first
        replicas.sort_by(|a, b| self.nodes[*a].repl_lag.partial_cmp(&self.nodes[*b].repl_lag).unwrap_or(std::cmp::Ordering::Equal));
        if up(&self.nodes[i]) {
            self.nodes[i].down_since = None;
            self.nodes[i].promoted_counted = false;
            // a synchronous replica out of reach: the write cannot be acknowledged
            if !read && self.nodes[i].children.iter().any(|&c| self.link_sync.contains(&(i, c)) && !self.reach(i, c)) {
                return self.fail(Some(i), why(i, R_SYNC), done, 0.5);
            }
            if read && !replicas.is_empty() {
                let pick = (self.rng.next() * (replicas.len() + 1) as f64).floor() as usize;
                if pick > 0 {
                    return self.hop(replicas[pick - 1], read, done, Some(i));
                }
            }
            let now = self.now;
            // a sharded database: the hot key's shard, or one picked by the key's hash
            let shard = {
                let x = &self.nodes[i];
                if x.sh_workers > 0.0 {
                    let (hot, k) = (x.hot, x.sh_n as f64);
                    if self.rng.next() < hot { 0 } else { (self.rng.next() * k).floor().min(k - 1.0) as u16 }
                } else {
                    NO_SHARD
                }
            };
            return self.enqueue(i, Job { read, t_in: now, done: Some(done), shard });
        }
        if self.nodes[i].down_since.is_none() {
            self.nodes[i].down_since = Some(self.now);
        }
        if replicas.is_empty() {
            return self.fail(Some(i), why(i, R_DOWN), done, 0.5);
        }
        let promoted = match self.cfg.failover_s {
            Some(f) => self.now - self.nodes[i].down_since.unwrap() >= f,
            None => false,
        };
        if !read {
            return if promoted { self.hop(replicas[0], read, done, Some(i)) } else { self.fail(Some(i), why(i, R_DOWN), done, 0.5) };
        }
        let k = (self.rng.next() * replicas.len() as f64).floor() as usize;
        self.hop(replicas[k], read, done, Some(i))
    }

    /// one call over the network: a hop plus the link's round trip, if it has one
    fn hop(&mut self, i: usize, read: bool, done: ContId, from: Option<usize>) {
        // across a partition: no answer until the connection times out
        if let Some(f) = from {
            if self.link_cut(f, i) && !(self.nodes[f].data.kind == "db" && !up(&self.nodes[f])) {
                return self.fail(None, why(i, R_PARTITION), done, 1000.0);
            }
        }
        // a bulkhead: past the dependency's share of waiting calls, refuse at once
        let mut done = done;
        if let Some(f) = from {
            if self.nodes[f].bulk_cap.is_finite() {
                if let Some(k) = self.nodes[f].children.iter().position(|&c| c == i) {
                    let x = &mut self.nodes[f];
                    if x.bulk_inflight.len() < x.children.len() {
                        x.bulk_inflight.resize(x.children.len(), 0.0);
                    }
                    if x.bulk_inflight[k] >= x.bulk_cap {
                        return self.fail(Some(f), why(f, R_BULKHEAD), done, 0.5);
                    }
                    x.bulk_inflight[k] += 1.0;
                    done = self.cont(Cont::Bulk { n: f, k, done });
                }
            }
        }
        let link = from.and_then(|f| self.link_ms.get(&(f, i)).copied()).unwrap_or(0.0);
        let ms = self.cfg.hop_ms + link;
        // a link that makes N calls per request: N in parallel, done when all have answered
        let n = from.and_then(|f| self.link_calls.get(&(f, i)).copied()).unwrap_or(1.0);
        if n > 1.0 {
            let group = self.groups.len();
            self.groups.push(Some(Group { pending: n as usize, why: OK, done }));
            for _ in 0..(n as usize) {
                let p = self.cont(Cont::Part { group });
                self.at(ms, Ev::Arrive { i, read, done: p });
            }
            return;
        }
        self.at(ms, Ev::Arrive { i, read, done });
    }

    fn enqueue(&mut self, n: usize, job: Job) {
        let x = &self.nodes[n];
        if x.sh_workers > 0.0 {
            let s = (job.shard as usize).min(x.sh_n - 1);
            if x.sh_busy[s] < x.sh_workers {
                return self.start(n, Job { shard: s as u16, ..job });
            }
            if x.sh_queue[s].len() as f64 >= x.sh_qmax {
                return self.fail(Some(n), why(n, R_SHED), job.done.unwrap(), 0.5);
            }
            self.nodes[n].sh_queue[s].push_back(Job { shard: s as u16, ..job });
            return;
        }
        if x.busy < x.workers && x.held < x.threads_cap {
            return self.start(n, job);
        }
        if x.queue.len() as f64 >= x.queue_max {
            let r = if x.held >= x.threads_cap { R_THREADS } else { R_SHED };
            return self.fail(Some(n), why(n, r), job.done.unwrap(), 0.5);
        }
        self.nodes[n].queue.push_back(job);
    }

    fn start(&mut self, n: usize, mut job: Job) {
        self.set_busy(n, 1.0);
        // a thread is taken for the work and every call it makes, until the answer
        if self.nodes[n].threads_cap.is_finite() {
            if let Some(done) = job.done {
                self.nodes[n].held += 1.0;
                let t0 = self.now;
                job.done = Some(self.cont(Cont::Hold { n, done, t0 }));
            }
        }
        if job.shard != NO_SHARD {
            self.shard_busy(n, job.shard as usize, 1.0);
        }
        let (mean, cv) = (self.nodes[n].svc_mean_ms, self.cfg.service_cv);
        let mut svc = self.rng.lognormal(mean, cv);
        if let Some(sr) = self.nodes[n].data.stall_rate.filter(|x| *x != 0.0) {
            if self.rng.next() < sr {
                svc += self.nodes[n].data.stall_ms.unwrap_or(0.0);
            }
        }
        svc += self.nodes[n].data.fault_latency_ms.unwrap_or(0.0);
        if self.nodes[n].data.kind == "function" {
            let x = &mut self.nodes[n];
            if x.busy > x.warm.max(x.data.provisioned.unwrap_or(0.0)) {
                x.warm = x.busy;
                if self.cfg.cold_start_ms > 0.0 {
                    svc += match x.data.runtime.as_deref().filter(|r| !r.is_empty()) {
                        Some(r) => runtime(r).2,
                        None => self.cfg.cold_start_ms,
                    };
                }
            }
            x.win.usage_reqs += 1.0;
        }
        self.at(svc, Ev::Finish { n, job });
    }

    fn finish(&mut self, n: usize, job: Job) {
        self.set_busy(n, -1.0);
        // next in line; shed anything that waited longer than the queue bound
        let bound = {
            let d = &self.nodes[n].data;
            d.queue_s.or(spec(&d.kind).queue_s).unwrap_or(self.cfg.queue_s) * 1000.0
        };
        if job.shard != NO_SHARD {
            let s = job.shard as usize;
            self.shard_busy(n, s, -1.0);
            while s < self.nodes[n].sh_queue.len() && !self.nodes[n].sh_queue[s].is_empty() && self.nodes[n].sh_busy[s] < self.nodes[n].sh_workers {
                let next = self.nodes[n].sh_queue[s].pop_front().unwrap();
                if (self.now - next.t_in) * 1000.0 > bound {
                    self.fail(Some(n), why(n, R_SHED), next.done.unwrap(), 0.5);
                    continue;
                }
                self.start(n, next);
            }
        }
        self.drain(n, bound);
        self.after_service(n, job);
    }

    /// next in line while a worker (and a thread) is free; shed what waited past the queue bound
    fn drain(&mut self, n: usize, bound: f64) {
        while !self.nodes[n].queue.is_empty() && self.nodes[n].busy < self.nodes[n].workers && self.nodes[n].held < self.nodes[n].threads_cap {
            let next = self.nodes[n].queue.pop_front().unwrap();
            if (self.now - next.t_in) * 1000.0 > bound {
                // it waited for a thread, not for the work, when workers were free
                let r = if self.nodes[n].threads_cap.is_finite() && self.nodes[n].busy < self.nodes[n].workers { R_THREADS } else { R_SHED };
                self.fail(Some(n), why(n, r), next.done.unwrap(), 0.5);
                continue;
            }
            self.start(n, next);
        }
    }

    fn after_service(&mut self, n: usize, job: Job) {
        let done = job.done.unwrap();
        let kind = self.nodes[n].kind;
        if let Some(fr) = self.nodes[n].data.fault_rate.filter(|x| *x != 0.0) {
            if self.rng.next() < fr {
                return self.fail(Some(n), why(n, R_ERROR), done, 0.0);
            }
        }
        if kind == "cache" || kind == "cdn" {
            let d = &self.nodes[n].data;
            // writes never hit: they go on to the origin, or wait in a write-behind cache
            if !job.read && d.write_policy.as_deref() == Some("behind") {
                let wait = self.rng.exp(super::engine::WRITE_BEHIND_S) * 1000.0;
                self.at(wait, Ev::Flush { n });
                return self.deliver(done, OK);
            }
            let hit = if job.read { super::catalog::cache_hit_rate(d) * cache_warmth(self.nodes[n].cold_at, self.now, d.warmup_s) } else { 0.0 };
            if self.rng.next() < hit {
                self.nodes[n].win.hits += 1.0;
                return self.deliver(done, OK);
            }
            if self.nodes[n].children.is_empty() {
                return self.fail(Some(n), why(n, R_NO_ROUTE), done, 0.0);
            }
        }
        if kind == "db" && !job.read {
            // every synchronous replica acknowledges before the write is answered
            let wait = self.nodes[n].children.iter().filter(|&&c| self.link_sync.contains(&(n, c))).map(|&c| self.link_ms.get(&(n, c)).copied().unwrap_or(0.0) + self.cfg.hop_ms + self.nodes[c].svc_mean_ms).fold(0.0, f64::max);
            if wait > 0.0 {
                self.at(wait, Ev::Deliver { done, why: OK });
                return;
            }
        }
        if kind == "db" || kind == "replica" {
            return self.deliver(done, OK);
        }
        if self.nodes[n].children.is_empty() {
            return self.deliver(done, if kind == "lb" || kind == "gateway" { why(n, R_NO_ROUTE) } else { OK });
        }
        self.call_downstream(n, job.read, done);
    }

    /// queue consumers (pull model)
    fn pump(&mut self, n: usize) {
        let consumers: Vec<usize> = self.nodes[n].children.iter().copied().filter(|&c| self.reach(n, c)).collect();
        while !self.nodes[n].backlog.is_empty() {
            // pull when some consumer has a free worker
            let free = consumers.iter().copied().find(|&c| self.nodes[c].busy + (self.nodes[c].queue.len() as f64) < self.nodes[c].workers);
            let free = match free {
                Some(f) => f,
                None => break,
            };
            let job = self.nodes[n].backlog.pop_front().unwrap();
            self.nodes[n].inflight += 1.0;
            let c = self.cont(Cont::Consumer { queue: n });
            self.arrive(free, job.read, c);
        }
    }

    /// a stream's subscribers: each pulls from its own backlog, with no more messages in flight than
    /// its instances can work on — and no more instances than the stream has partitions
    fn pump_stream(&mut self, n: usize) {
        let parts = partitions_of(&self.nodes[n].data);
        for k in 0..self.nodes[n].children.len() {
            let c = self.nodes[n].children[k];
            if !self.reach(n, c) {
                continue;
            }
            let x = &self.nodes[c];
            let inst = instances_up(&x.data).max(1.0);
            let limit = if spec(&x.data.kind).scalable { (x.workers / inst) * inst.min(parts) } else { x.workers };
            while !self.nodes[n].sub_backlog[k].is_empty() && self.nodes[n].sub_inflight[k] < limit && self.nodes[c].busy + (self.nodes[c].queue.len() as f64) < self.nodes[c].workers {
                let job = self.nodes[n].sub_backlog[k].pop_front().unwrap();
                self.nodes[n].sub_inflight[k] += 1.0;
                let cont = self.cont(Cont::SubConsumer { stream: n, k });
                self.arrive(c, job.read, cont);
            }
        }
    }

    /// calling children: breaker → retries → deadline → routing
    fn call_downstream(&mut self, n: usize, read: bool, done: ContId) {
        self.nodes[n].win.calls += 1.0;
        let breaker = self.nodes[n].data.breaker == Some(true);
        if breaker && self.nodes[n].br != "closed" {
            if self.nodes[n].br == "open" && self.now >= self.nodes[n].br_until {
                self.nodes[n].br = "half";
            }
            if self.nodes[n].br == "open" || self.rng.next() > BR_PROBE {
                let fb = self.nodes[n].data.fallback == Some(true);
                return self.at(1.0, Ev::Deliver { done, why: if fb { OK } else { why(n, R_BREAKER) } });
            }
        }
        let retries = self.nodes[n].data.retries.unwrap_or(0.0);
        let policy: &'static str = match self.nodes[n].data.retry_policy.as_deref() {
            Some("budget") => "budget",
            Some("backoff") => "backoff",
            _ => "immediate",
        };
        if policy == "budget" {
            let x = &mut self.nodes[n];
            x.retry_tokens = BUDGET_CAP.min(x.retry_tokens + BUDGET_RATIO);
        }
        let timeout = self.nodes[n].data.timeout_ms.filter(|t| *t != 0.0 && !t.is_nan());
        let call = self.calls.len();
        self.calls.push(Some(Call { n, read, done, retries, policy, timeout, breaker }));
        self.attempt(call, 0.0);
    }

    fn attempt(&mut self, call: usize, k: f64) {
        let (n, read, tmo) = {
            let c = self.calls[call].as_ref().unwrap();
            (c.n, c.read, c.timeout)
        };
        self.nodes[n].win.attempts += 1.0;
        let settle = self.cont(Cont::Settle { call, k, settled: false, refs: if tmo.is_some() { 2 } else { 1 } });
        if let Some(t) = tmo {
            self.at(t, Ev::Timeout { settle });
        }
        self.route(n, read, settle);
    }

    fn settle(&mut self, id: ContId, why: Why, late: bool) {
        let ok = why == OK && !late;
        let (call, k, settled) = match &mut self.conts[id] {
            Cont::Settle { call, k, settled, refs } => {
                *refs -= 1;
                let r = (*call, *k, *settled);
                *settled = true;
                r
            }
            _ => return,
        };
        if let Cont::Settle { refs: 0, .. } = self.conts[id] {
            self.release(id);
        }
        if settled {
            return;
        }
        let (n, done, retries, budget, backoff, breaker) = {
            let c = self.calls[call].as_ref().unwrap();
            (c.n, c.done, c.retries, c.policy == "budget", c.policy == "backoff", c.breaker)
        };
        if late {
            self.nodes[n].win.late += 1.0;
        }
        if breaker {
            if ok {
                self.nodes[n].br_ok += 1.0;
            } else {
                self.nodes[n].br_fail += 1.0;
            }
        }
        if ok {
            self.calls[call] = None;
            return self.deliver(done, OK);
        }
        let can_retry = k < retries && (!budget || self.nodes[n].retry_tokens >= 1.0);
        if !can_retry {
            self.calls[call] = None;
            return self.deliver(done, if late { self::why(n, R_TIMEOUT) } else { why });
        }
        if budget {
            self.nodes[n].retry_tokens -= 1.0;
        }
        let delay = if backoff { BACKOFF_CAP.min(BACKOFF_BASE_MS * 2f64.js_pow(k)) * (0.5 + self.rng.next()) } else { 1.0 };
        self.at(delay, Ev::Attempt { call, k: k + 1.0 });
    }

    fn route(&mut self, n: usize, read: bool, done: ContId) {
        let kind = self.nodes[n].kind;
        let mode = self.nodes[n].mode;
        let degree = self.nodes[n].data.fanout.unwrap_or(1.0).max(1.0);
        let filter = kind == "lb" || kind == "gateway" || kind == "queue" || kind == "dns";
        let restricted = !self.link_carries.is_empty() && self.nodes[n].children.iter().any(|&c| self.link_carries.contains_key(&(n, c)));
        // the common case: one child picked at random, no list built
        if mode == "split" && degree <= 1.0 && !filter && !restricted {
            let len = self.nodes[n].children.len();
            if len == 0 {
                return self.fail(Some(n), why(n, R_NO_ROUTE), done, 0.5);
            }
            let k = (self.rng.next() * len as f64).floor() as usize;
            let c = self.nodes[n].children[k];
            return self.hop(c, read, done, Some(n));
        }
        let mut kids = self.nodes[n].children.clone();
        if filter {
            kids.retain(|&c| self.reach(n, c));
        }
        if restricted {
            // only the links that carry this request's class
            kids.retain(|&c| match self.link_carries.get(&(n, c)) {
                Some(1) => read,
                Some(2) => !read,
                _ => true,
            });
        }
        if kids.is_empty() {
            return self.fail(Some(n), why(n, R_NO_ROUTE), done, 0.5);
        }
        if mode == "fanout" {
            let group = self.groups.len();
            self.groups.push(Some(Group { pending: kids.len(), why: OK, done }));
            for c in kids {
                let p = self.cont(Cont::Part { group });
                self.hop(c, read, p, Some(n));
            }
            return;
        }
        if mode == "failover" {
            let mut ordered = kids.clone();
            js_sort_by(&mut ordered, |a, b| {
                let usage = |t: usize| if spec(&self.nodes[t].data.kind).cost_per_request.map(|c| c != 0.0).unwrap_or(false) { 1.0 } else { 0.0 };
                let u = (up(&self.nodes[*b]) as i32 - up(&self.nodes[*a]) as i32) as f64;
                if u != 0.0 {
                    u
                } else {
                    usage(*a) - usage(*b)
                }
            });
            let order = self.orders.len();
            self.orders.push(ordered);
            return self.try_failover(n, read, order, 0, done);
        }
        if degree > 1.0 {
            // scatter-gather over N partitions; wait for all
            let group = self.groups.len();
            self.groups.push(Some(Group { pending: degree as usize, why: OK, done }));
            let mut i = 0.0;
            while i < degree {
                let k = (self.rng.next() * kids.len() as f64).floor() as usize;
                let p = self.cont(Cont::Part { group });
                self.hop(kids[k], read, p, Some(n));
                i += 1.0;
            }
            return;
        }
        let k = (self.rng.next() * kids.len() as f64).floor() as usize;
        self.hop(kids[k], read, done, Some(n))
    }

    fn try_failover(&mut self, n: usize, read: bool, order: usize, i: usize, done: ContId) {
        let target = self.orders[order][i];
        let c = self.cont(Cont::Failover { n, read, order, i, done });
        self.hop(target, read, c, Some(n));
    }

    fn rps_at(&self, t: f64) -> f64 {
        let tl = &self.traffic;
        if t <= tl[0].0 {
            return tl[0].1;
        }
        for i in 1..tl.len() {
            if t <= tl[i].0 {
                return tl[i - 1].1 + ((tl[i].1 - tl[i - 1].1) * (t - tl[i - 1].0)) / (tl[i].0 - tl[i - 1].0);
            }
        }
        tl[tl.len() - 1].1
    }

    /// Poisson arrivals with a time-varying rate (thinning at a 250 ms horizon)
    fn generate(&mut self, c: usize, emit: bool) {
        let rate = self.rps_at(self.now) / (self.clients.len() as f64).max(1.0);
        if emit && rate > 0.0 && self.nodes[c].data.alive {
            let t0 = self.now;
            let read = self.rng.next() < self.sc.read_ratio;
            self.nodes[c].win.arrivals += 1.0;
            let finish = self.cont(Cont::User { t0 });
            if self.nodes[c].children.is_empty() {
                self.deliver(finish, why(c, R_NO_ROUTE));
            } else {
                self.call_downstream(c, read, finish);
            }
        }
        let gap = if rate > 0.0 { self.rng.exp(1.0 / rate) } else { f64::INFINITY };
        if gap <= 0.25 {
            self.q.push(self.now + gap, Ev::Generate { c, emit: true });
        } else {
            self.q.push(self.now + 0.25, Ev::Generate { c, emit: false });
        }
    }

    fn scenario(&mut self, k: usize) {
        let (_, action, note) = self.sc.events[k].clone();
        let stats: HashMap<String, f64> = self.nodes.iter().map(|n| (n.id.clone(), n.last_stats.as_ref().map(|s| s.in_rps).unwrap_or(0.0))).collect();
        let mut rand_once = || 0.0;
        let target = super::headless::apply_action(&mut self.sim_nodes, &self.zones, &action, &|id| stats.get(id).copied().unwrap_or(0.0), &mut rand_once);
        for i in 0..self.nodes.len() {
            self.nodes[i].raw = self.sim_nodes[i].data.clone();
            self.configure(i);
        }
        let has_id = action.id().is_some();
        let what = note.unwrap_or_else(|| {
            format!(
                "{}{}{}",
                action.kind_name(),
                action.id().map(|i| format!(" {}", i)).unwrap_or_default(),
                match &target {
                    Some(t) if !has_id => format!(" → {}", t),
                    _ => String::new(),
                }
            )
        });
        self.ev_log.push(super::headless::Event { t: r3(self.now), what });
    }

    /// 1-second sampling: metrics, breakers, warm pools
    fn sample(&mut self) {
        let win_s = 1.0;
        let now = self.now;
        // replication: lag per replica, and the writes a promotion loses
        let fo = self.cfg.failover_s;
        for i in 0..self.nodes.len() {
            if self.nodes[i].data.kind == "db" {
                let promoted = matches!((fo, self.nodes[i].down_since), (Some(f), Some(t)) if now - t >= f);
                if promoted && !self.nodes[i].promoted_counted {
                    self.nodes[i].promoted_counted = true;
                    let lag = self.nodes[i].children.iter().filter(|&&c| self.nodes[c].data.kind == "replica" && up(&self.nodes[c])).map(|&c| self.nodes[c].repl_lag).fold(f64::INFINITY, f64::min);
                    if lag.is_finite() {
                        self.lost_writes += self.nodes[i].writes_rate * lag;
                    }
                }
                if up(&self.nodes[i]) {
                    self.nodes[i].writes_rate = self.nodes[i].writes_win / win_s;
                }
                self.nodes[i].writes_win = 0.0;
            }
        }
        let mut max_lag: f64 = 0.0;
        for i in 0..self.nodes.len() {
            if self.nodes[i].data.kind != "replica" {
                continue;
            }
            if let Some(&p) = self.primary_of.get(&i) {
                let primary_up = up(&self.nodes[p]);
                let reachable = primary_up && !self.link_cut(p, i);
                let base = self.link_ms.get(&(p, i)).copied().unwrap_or(0.0) / 1000.0;
                let primary_promoted = !primary_up && matches!((fo, self.nodes[p].down_since), (Some(f), Some(t)) if now - t >= f);
                let sync = self.link_sync.contains(&(p, i));
                let x = &mut self.nodes[i];
                if primary_promoted {
                    x.repl_lag = 0.0;
                } else if sync {
                    // a synchronous replica never falls behind: the primary refuses what it cannot replicate
                    x.repl_lag = 0.0;
                } else if reachable {
                    x.repl_lag = (x.repl_lag - win_s * super::engine::CATCH_UP).max(base);
                } else if primary_up {
                    x.repl_lag += win_s;
                }
            }
            max_lag = max_lag.max(self.nodes[i].repl_lag);
        }
        self.max_replica_lag = self.max_replica_lag.max(max_lag);
        let mut cost = 0.0;
        for i in 0..self.nodes.len() {
            self.set_busy(i, 0.0);
            self.shard_busy(i, 0, 0.0);
            let fo = self.cfg.failover_s;
            let n = &self.nodes[i];
            let w = &n.win;
            let workers = if n.workers.is_finite() { n.workers } else { 1.0 };
            let util = if n.sh_workers > 0.0 { w.hot_area / (n.sh_workers * win_s) } else if n.data.kind == "queue" { n.backlog.len() as f64 / QUEUE_BACKLOG_MAX as f64 } else if n.data.kind == "stream" { n.sub_backlog.iter().map(|q| q.len()).max().unwrap_or(0) as f64 / QUEUE_BACKLOG_MAX as f64 } else if n.rate.is_finite() { w.arrivals / (n.rate * win_s).max(1e-9) } else { w.busy_area / (workers * win_s) };
            // thread-per-request: the threads the offered load needs (rate × hold time, Little's law) over those there are
            let util = if n.threads_cap.is_finite() && w.held_n > 0.0 { util.max((w.arrivals / win_s) * (w.held_s / w.held_n) / n.threads_cap.max(1e-9)) } else { util };
            let billed = if n.data.kind == "function" || n.data.kind == "llmapi" || n.data.kind == "external" || n.data.kind == "kv" || n.data.kind == "storage" { w.usage_reqs } else if n.data.kind == "client" { 0.0 } else { w.arrivals };
            let usage = billed * request_price(&n.data, &self.pricing) * 3600.0;
            let cost_h = match &n.scaler {
                Some(s) => cost_of(&NodeData { instances: Some(s.live + s.pending.len() as f64), ..n.data.clone() }, &self.pricing),
                None => cost_of(&n.data, &self.pricing),
            } + usage;
            cost += cost_h;
            let stats = NodeStats {
                in_rps: w.arrivals / win_s,
                drop_rps: w.drops / win_s,
                util,
                queue: if n.data.kind == "queue" { n.backlog.len() as f64 } else if n.data.kind == "stream" { n.sub_backlog.iter().map(|q| q.len()).max().unwrap_or(0) as f64 } else { (n.queue.len() + n.sh_queue.iter().map(|q| q.len()).sum::<usize>()) as f64 },
                latency_ms: 0.0,
                success: if w.arrivals != 0.0 { 1.0 - w.drops / w.arrivals } else { 1.0 },
                hit_rps: w.hits / win_s,
                reachable: if n.pooled { instances_up(&n.data) } else { instances_up(&n.data).min(1.0) },
                lag_s: 0.0,
                repl_lag_s: n.repl_lag,
                cold_frac: 0.0,
                failover: if n.data.kind == "db" && n.down_since.is_some() {
                    match fo {
                        Some(f) if now - n.down_since.unwrap() >= f => "promoted",
                        _ => "electing",
                    }
                } else {
                    "none"
                }
                .into(),
                cost_per_hour: cost_h,
                retry_amp: if w.calls != 0.0 { w.attempts / w.calls } else { 1.0 },
                breaker: if n.data.breaker == Some(true) { Some(n.br.into()) } else { None },
                late_frac: if w.attempts != 0.0 { w.late / w.attempts } else { 0.0 },
                history: vec![],
                scaling: n.scaler.as_ref().map(|s| Scaling { live: s.live, pending: s.pending.len() as f64, desired: s.desired }),
                warmth: cache_warmth(n.cold_at, now, n.data.warmup_s),
                // what a thread was held for beyond the work itself
                hold_ms: if w.held_n > 0.0 { (w.held_s / w.held_n * 1000.0 - n.svc_mean_ms).max(0.0) } else { 0.0 },
                own_ms: n.svc_mean_ms,
            };
            let arrivals = w.arrivals;
            if (n.data.kind == "cache" || n.data.kind == "cdn") && !up(n) {
                self.nodes[i].cold_at = Some(now);
            }
            if self.nodes[i].scaler.is_some() {
                let raw = self.nodes[i].raw.clone();
                let per = per_instance_capacity(&raw);
                let id = self.nodes[i].id.clone();
                let evs = super::engine::step_scaler_pub(self.nodes[i].scaler.as_mut().unwrap(), &raw, now, arrivals / win_s, per);
                for (kind, from, to) in &evs {
                    if *kind != "scaled" {
                        self.ev_log.push(super::headless::Event { t: r3(now), what: format!("{}: {} {} → {}", kind, id, js_num(*from), js_num(*to)) });
                    }
                }
                if !evs.is_empty() {
                    self.configure(i);
                }
            }
            let n = &mut self.nodes[i];
            n.peak_util = js_max(n.peak_util, [util]);
            n.util_sum += util;
            n.util_n += 1.0;
            let v = node_view(&n.data, Some(&stats), true, !n.children.is_empty());
            let badness = stats.drop_rps + util * 10.0 + (if v.up { 0.0 } else { 1000.0 }) + (if n.br == "open" { 500.0 } else { 0.0 }) + stats.retry_amp * 20.0;
            if badness > n.worst {
                n.worst = badness;
                n.worst_note = explain(&n.data, Some(&stats), &v);
            }
            // breaker state machine on the window's outcomes
            if n.data.breaker == Some(true) {
                let total = n.br_ok + n.br_fail;
                let fail_rate = if total != 0.0 { n.br_fail / total } else { 0.0 };
                if n.br == "closed" && total >= BR_MIN_CALLS && fail_rate > BR_TRIP_FAIL {
                    n.br = "open";
                    n.br_until = now + BR_OPEN_S;
                } else if n.br == "half" && total >= 3.0 {
                    if fail_rate < BR_CLOSE_FAIL {
                        n.br = "closed";
                    } else if fail_rate > BR_TRIP_FAIL {
                        n.br = "open";
                        n.br_until = now + BR_OPEN_S;
                    }
                }
                if Some(n.br.to_string()) != stats.breaker {
                    let what = format!("breaker-{}: {}", n.br, n.id);
                    self.ev_log.push(super::headless::Event { t: r3(now), what });
                }
                let n = &mut self.nodes[i];
                n.br_ok = 0.0;
                n.br_fail = 0.0;
            }
            let n = &mut self.nodes[i];
            if n.data.kind == "function" {
                n.warm = n.busy.max(n.warm * (-win_s / 60.0).js_exp());
            }
            n.last_stats = Some(stats);
            n.win = new_win();
        }
        let err = if self.win_reqs != 0.0 { self.win_fail / self.win_reqs } else { 0.0 };
        let p99 = self.win_hist.quantile(0.99);
        let rps = self.win_reqs / win_s;
        self.timeline.push(DesPoint { t: r3(now), rps, error_rate: r3(err), p50_ms: js_round(self.win_hist.quantile(0.5)), p99_ms: js_round(p99), cost_per_hour: r3(cost) });
        if rps > 0.5 && (err > self.sc.slo.0 || p99 > self.sc.slo.1) {
            self.breach += win_s;
        }
        let score = err * 10.0 + p99 / 1000.0;
        if score > self.worst_score {
            self.worst_score = score;
            self.worst_t = now;
        }
        self.win_hist.reset();
        self.win_reqs = 0.0;
        self.win_fail = 0.0;
        if now + win_s <= self.sc.duration + 1e-9 {
            self.q.push(now + win_s, Ev::Sample);
        }
    }

    fn run(&mut self, ev: Ev) {
        match ev {
            Ev::Generate { c, emit } => self.generate(c, emit),
            Ev::Arrive { i, read, done } => self.arrive(i, read, done),
            Ev::Deliver { done, why } => self.deliver(done, why),
            Ev::Finish { n, job } => self.finish(n, job),
            Ev::LlmDone { n, done, fault } => {
                self.nodes[n].win.usage_reqs += 1.0;
                if fault != 0.0 && !fault.is_nan() && self.rng.next() < fault {
                    return self.fail(Some(n), why(n, R_ERROR), done, 0.0);
                }
                self.deliver(done, OK)
            }
            Ev::Attempt { call, k } => self.attempt(call, k),
            Ev::Timeout { settle } => self.settle(settle, OK, true),
            Ev::Sample => self.sample(),
            Ev::Scenario { k } => self.scenario(k),
            Ev::Flush { n } => {
                // a cache that died meanwhile took the write with it
                if !up(&self.nodes[n]) || self.nodes[n].children.is_empty() {
                    self.lost_writes += 1.0;
                    return;
                }
                let c = self.cont(Cont::Flushed);
                self.call_downstream(n, false, c);
            }
        }
    }
}

pub fn run_des(spec: &Architecture, sc: &Scenario, cfg: &DesConfig) -> DesResult {
    #[cfg(not(target_arch = "wasm32"))]
    let wall0 = std::time::Instant::now();
    let pricing = spec.pricing.clone().unwrap_or_else(|| "illustrative".into());
    let (sim_nodes, edges): (Vec<SimNode>, Vec<SimEdge>) = graph_of(spec);
    let index: HashMap<String, usize> = sim_nodes.iter().enumerate().map(|(i, n)| (n.id.clone(), i)).collect();
    let mut nodes: Vec<DNode> = sim_nodes
        .iter()
        .map(|n| DNode {
            id: n.id.clone(),
            kind: static_kind(&n.data.kind),
            mode: "split",
            raw: n.data.clone(),
            data: n.data.clone(),
            scaler: if n.data.autoscale.is_some() && spec_scalable(&n.data.kind) { Some(super::engine::new_scaler_pub(&n.data)) } else { None },
            cold_at: None,
            flush_seen: n.data.flushes.unwrap_or(0.0),
            children: vec![],
            pooled: false,
            workers: 1.0,
            svc_mean_ms: 1.0,
            busy: 0.0,
            sh_n: 1,
            sh_workers: 0.0,
            sh_qmax: 0.0,
            sh_busy: vec![],
            sh_queue: vec![],
            hot: 0.0,
            hot_last_t: 0.0,
            kv_bucket: 1.0,
            kv_t: 0.0,
            px_bucket: vec![],
            px_t: vec![],
            dead_since: None,
            sub_backlog: vec![],
            sub_inflight: vec![],
            threads_cap: f64::INFINITY,
            held: 0.0,
            bulk_cap: f64::INFINITY,
            bulk_inflight: vec![],
            queue: VecDeque::new(),
            queue_max: 0.0,
            last_busy_t: 0.0,
            rate: f64::INFINITY,
            tokens: 0.0,
            last_refill: 0.0,
            warm: 0.0,
            down_since: None,
            repl_lag: 0.0,
            writes_win: 0.0,
            writes_rate: 0.0,
            promoted_counted: false,
            br: "closed",
            br_until: 0.0,
            br_ok: 0.0,
            br_fail: 0.0,
            retry_tokens: BUDGET_CAP,
            backlog: VecDeque::new(),
            inflight: 0.0,
            win: new_win(),
            peak_util: 0.0,
            util_sum: 0.0,
            util_n: 0.0,
            drops_total: 0.0,
            worst: -1.0,
            worst_note: None,
            last_stats: None,
        })
        .collect();
    let mut link_ms = HashMap::new();
    let mut link_calls = HashMap::new();
    let mut link_carries = HashMap::new();
    let mut link_sync = std::collections::HashSet::new();
    let mut primary_of = HashMap::new();
    for e in &edges {
        let (a, b) = match (index.get(&e.source), index.get(&e.target)) {
            (Some(a), Some(b)) if a != b => (*a, *b),
            _ => continue,
        };
        if let Some(l) = e.data.as_ref().and_then(|d| d.latency_ms).filter(|l| *l != 0.0) {
            link_ms.insert((a, b), l);
        }
        if let Some(c) = e.data.as_ref().and_then(|d| d.calls).filter(|c| *c > 1.0) {
            link_calls.insert((a, b), c);
        }
        if e.data.as_ref().and_then(|d| d.replication.as_deref()) == Some("sync") {
            link_sync.insert((a, b));
        }
        if nodes[a].data.kind == "db" && nodes[b].data.kind == "replica" {
            primary_of.insert(b, a);
        }
        match e.data.as_ref().and_then(|d| d.carries.as_deref()) {
            Some("reads") => {
                link_carries.insert((a, b), 1u8);
            }
            Some("writes") => {
                link_carries.insert((a, b), 2u8);
            }
            _ => {}
        }
        nodes[a].children.push(b);
        let k = nodes[a].data.kind.clone();
        if k == "lb" || k == "gateway" || k == "queue" || k == "stream" || nodes[a].data.fanout.unwrap_or(1.0) > 1.0 {
            nodes[b].pooled = true;
        }
    }
    for n in nodes.iter_mut() {
        n.sub_backlog = (0..n.children.len()).map(|_| VecDeque::new()).collect();
        n.sub_inflight = vec![0.0; n.children.len()];
    }
    let mut tl: Vec<(f64, f64)> = match &sc.traffic {
        Some(t) if !t.is_empty() => t.clone(),
        _ => vec![(0.0, sc.rps.unwrap_or(500.0))],
    };
    js_sort_by(&mut tl, |a, b| a.0 - b.0);
    let clients: Vec<usize> = (0..nodes.len()).filter(|&i| nodes[i].data.kind == "client").collect();
    let mut des = Des {
        cfg: cfg.clone(),
        sc,
        pricing,
        rng: Rng::new(cfg.seed),
        q: EventQueue::new(),
        now: 0.0,
        nodes,
        link_ms,
        link_calls,
        link_carries,
        link_sync,
        primary_of,
        stale_reads: 0.0,
        max_replica_lag: 0.0,
        conts: vec![],
        free: vec![],
        calls: vec![],
        groups: vec![],
        orders: vec![],
        clients: clients.clone(),
        user_hist: Histogram::new(),
        win_hist: Histogram::new(),
        win_reqs: 0.0,
        win_fail: 0.0,
        fail_by: HashMap::new(),
        total_reqs: 0.0,
        total_fail: 0.0,
        lost_writes: 0.0,
        traffic: tl,
        ev_log: vec![],
        timeline: vec![],
        breach: 0.0,
        worst_t: 0.0,
        worst_score: -1.0,
        sim_nodes,
        zones: spec.zones.iter().map(|z| (z.0.clone(), z.2.clone())).collect(),
    };
    for i in 0..des.nodes.len() {
        des.configure(i);
        let n = &mut des.nodes[i];
        n.tokens = if n.rate.is_finite() { n.rate * 0.1 } else { 0.0 };
    }
    for k in 0..sc.events.len() {
        des.q.push(sc.events[k].0, Ev::Scenario { k });
    }
    for &c in &clients {
        des.q.push(0.0, Ev::Generate { c, emit: false });
    }
    des.q.push(1.0, Ev::Sample);
    let mut processed = 0.0;
    while des.q.len() > 0 && des.q.peek_time() <= sc.duration + 1e-9 {
        des.now = des.q.peek_time();
        let ev = des.q.pop();
        des.run(ev);
        processed += 1.0;
        if processed > cfg.max_events {
            let t = r3(des.now);
            des.ev_log.push(super::headless::Event { t, what: format!("stopped: event budget ({}) exhausted", locale_int(cfg.max_events)) });
            break;
        }
    }

    // ---- report ----
    let mut components: IndexMap<String, DesComponent> = IndexMap::new();
    for n in &des.nodes {
        if n.data.kind == "client" {
            continue;
        }
        let v = node_view(&n.data, n.last_stats.as_ref(), true, !n.children.is_empty());
        components.insert(
            n.id.clone(),
            DesComponent { kind: n.data.kind.clone(), peak_util: r3(n.peak_util), mean_util: r3(if n.util_n != 0.0 { n.util_sum / n.util_n } else { 0.0 }), dropped_total: n.drops_total, final_status: if v.failed_over { "failed over".into() } else if v.up { v.health.into() } else { "down".into() }, note: n.worst_note.clone() },
        );
    }
    let cur_nodes: Vec<SimNode> = des.sim_nodes.clone();
    let async_only = |id: &str| {
        let callers: Vec<Option<&str>> = edges.iter().filter(|e| e.target == id).map(|e| cur_nodes.iter().find(|n| n.id == e.source).map(|n| n.data.kind.as_str())).collect();
        !callers.is_empty() && callers.iter().all(|k| *k == Some("queue"))
    };
    let mut ranked: Vec<(&String, &DesComponent)> = components.iter().filter(|(id, c)| (c.peak_util >= 0.7 || c.dropped_total > 0.0 || c.final_status == "down") && !(c.dropped_total == 0.0 && async_only(id))).collect();
    js_sort_by(&mut ranked, |a, b| {
        let d = b.1.dropped_total - a.1.dropped_total;
        if d != 0.0 && !d.is_nan() {
            d
        } else {
            b.1.peak_util - a.1.peak_util
        }
    });
    let bottlenecks = ranked.iter().take(5).map(|(id, c)| super::headless::Bottleneck { id: (*id).clone(), peak_util: c.peak_util, dropped_total: c.dropped_total, note: c.note.clone() }).collect();
    let mut failures: Vec<FailureCause> = des
        .fail_by
        .iter()
        .map(|(&w, &count)| {
            let n = ((w >> 8) as usize).saturating_sub(1);
            let node = &des.sim_nodes[n.min(des.sim_nodes.len().saturating_sub(1))];
            FailureCause { id: node.id.clone(), name: node.data.name.clone(), reason: reason_text((w & 0xff) as u8), requests: count, share: if des.total_fail > 0.0 { r3(count / des.total_fail) } else { 0.0 } }
        })
        .collect();
    js_sort_by(&mut failures, |a, b| if b.requests != a.requests { b.requests - a.requests } else if a.id < b.id { -1.0 } else { 1.0 });
    failures.truncate(8);
    let tln = &des.timeline;
    let mean = |f: &dyn Fn(&DesPoint) -> f64| if tln.is_empty() { 0.0 } else { tln.iter().fold(0.0, |s, x| s + f(x)) / tln.len() as f64 };
    let peak = |f: &dyn Fn(&DesPoint) -> f64| js_max(0.0, tln.iter().map(f));
    #[cfg(not(target_arch = "wasm32"))]
    let wall_ms = js_round(wall0.elapsed().as_secs_f64() * 1000.0);
    #[cfg(target_arch = "wasm32")]
    let wall_ms = 0.0;
    DesResult {
        engine: "des",
        seed: cfg.seed,
        architecture: spec.name.clone().unwrap_or_else(|| "architecture".into()),
        scenario: sc.name.clone().unwrap_or_else(|| if sc.traffic.is_some() { "custom traffic".into() } else { format!("{} req/s steady", js_num(sc.rps.unwrap_or(500.0))) }),
        summary: DesSummary {
            duration_s: sc.duration,
            mean_rps: js_round(mean(&|x| x.rps) * 10.0) / 10.0,
            mean_error_rate: if des.total_reqs != 0.0 { r3(des.total_fail / des.total_reqs) } else { 0.0 },
            peak_error_rate: r3(peak(&|x| x.error_rate)),
            p50_ms: js_round(des.user_hist.quantile(0.5)),
            p90_ms: js_round(des.user_hist.quantile(0.9)),
            p99_ms: js_round(des.user_hist.quantile(0.99)),
            p999_ms: js_round(des.user_hist.quantile(0.999)),
            mean_p99_ms: js_round(mean(&|x| x.p99_ms)),
            peak_p99_ms: js_round(peak(&|x| x.p99_ms)),
            mean_cost_per_hour: r3(mean(&|x| x.cost_per_hour)),
            peak_cost_per_hour: r3(peak(&|x| x.cost_per_hour)),
            slo_compliance: r3(1.0 - des.breach / (tln.len() as f64).max(1.0)),
            slo_breach_seconds: des.breach,
            requests: des.total_reqs,
            failed_requests: des.total_fail,
            lost_writes: js_round(des.lost_writes),
            stale_reads: des.stale_reads,
            max_replica_lag_s: r3(des.max_replica_lag),
            worst_moment_s: r3(des.worst_t),
            events: processed,
            wall_ms,
        },
        slo: super::headless::SloOut { max_error_rate: sc.slo.0, max_p99_ms: sc.slo.1 },
        timeline: des.timeline.clone(),
        components,
        bottlenecks,
        failures,
        events: des.ev_log.clone(),
    }
}

fn static_kind(k: &str) -> &'static str {
    match k {
        "client" => "client",
        "cdn" => "cdn",
        "lb" => "lb",
        "gateway" => "gateway",
        "server" => "server",
        "worker" => "worker",
        "function" => "function",
        "cache" => "cache",
        "db" => "db",
        "replica" => "replica",
        "storage" => "storage",
        "queue" => "queue",
        "llm" => "llm",
        "llmapi" => "llmapi",
        "external" => "external",
        "kv" => "kv",
        "dns" => "dns",
        "stream" => "stream",
        _ => "server",
    }
}

fn spec_scalable(kind: &str) -> bool {
    spec(kind).scalable
}

pub fn simulate_des(spec: &serde_json::Value, scenario: &serde_json::Value, cfg: &DesConfig) -> Result<DesResult, String> {
    let a = parse_architecture(spec)?;
    let sc = parse_scenario(scenario)?;
    let _ = Action::ReviveAll;
    Ok(run_des(&a, &sc, cfg))
}

fn is_zero(x: &f64) -> bool {
    *x == 0.0
}
