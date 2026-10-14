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
    /// a write-behind cache's flush to the origin settled
    Flushed,
    Free,
}

#[derive(Clone, Copy)]
enum Ev {
    Generate { c: usize, emit: bool },
    Arrive { i: usize, read: bool, done: ContId },
    Deliver { done: ContId, ok: bool },
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
}

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
    all_ok: bool,
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
}

fn new_win() -> Win {
    Win { arrivals: 0.0, drops: 0.0, hits: 0.0, busy_area: 0.0, calls: 0.0, attempts: 0.0, late: 0.0, usage_reqs: 0.0 }
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
    queue: VecDeque<Job>,
    queue_max: f64,
    last_busy_t: f64,
    rate: f64,
    tokens: f64,
    last_refill: f64,
    warm: f64,
    down_since: Option<f64>,
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
    pub events: Vec<super::headless::Event>,
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

    fn set_busy(&mut self, n: usize, delta: f64) {
        let now = self.now;
        let x = &mut self.nodes[n];
        x.win.busy_area += x.busy * (now - x.last_busy_t);
        x.last_busy_t = now;
        x.busy += delta;
    }

    fn fail(&mut self, n: Option<usize>, done: ContId, ms: f64) {
        if let Some(n) = n {
            self.nodes[n].win.drops += 1.0;
            self.nodes[n].drops_total += 1.0;
        }
        self.at(ms, Ev::Deliver { done, ok: false });
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
        let d = &n.data;
        let reach = if n.pooled || d.kind == "llm" { instances_up(d) } else { instances_up(d).min(1.0) };
        let cap = capacity_of(d, Some(reach)).max(1e-6);
        let lat = base_latency_of(d).max(0.05);
        let kind = d.kind.as_str();
        if kind == "gateway" || kind == "llmapi" {
            n.rate = d.limit.unwrap_or(spec(kind).capacity);
            n.workers = f64::INFINITY;
            n.svc_mean_ms = if kind == "llmapi" { d.latency_ms.unwrap_or(spec("llmapi").base_latency_ms) } else { lat };
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
        // serverless throttles instead of queueing; unlimited pools never queue
        n.queue_max = if kind == "function" || !n.workers.is_finite() { 0.0 } else { (cap * d.queue_s.or(spec(kind).queue_s).unwrap_or(cfg_queue)).floor().max(1.0) };
    }

    /// run a continuation now
    fn deliver(&mut self, id: ContId, ok: bool) {
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
                }
            }
            Cont::Settle { .. } => self.settle(id, ok, false),
            Cont::Part { group } => {
                self.release(id);
                let g = self.groups[group].as_mut().unwrap();
                g.all_ok = g.all_ok && ok;
                g.pending -= 1;
                if g.pending == 0 {
                    let g = self.groups[group].take().unwrap();
                    self.deliver(g.done, g.all_ok);
                }
            }
            Cont::Failover { n, read, order, i, done } => {
                self.release(id);
                let len = self.orders[order].len();
                if ok || i + 1 >= len {
                    self.deliver(done, ok);
                } else {
                    self.try_failover(n, read, order, i + 1, done);
                }
            }
            Cont::Consumer { queue } => {
                self.release(id);
                self.nodes[queue].inflight -= 1.0;
                self.pump(queue);
            }
            Cont::Flushed => {
                self.release(id);
                if !ok {
                    self.lost_writes += 1.0;
                }
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
        if kind == "db" {
            return self.arrive_db(i, read, done);
        }
        let kind: &str = kind;
        if !up(&self.nodes[i]) {
            return self.fail(Some(i), done, 0.5);
        }
        let now = self.now;
        {
            let n = &mut self.nodes[i];
            if n.rate.is_finite() {
                n.tokens = n.rate.min(n.tokens + (now - n.last_refill) * n.rate);
                n.last_refill = now;
                if n.tokens < 1.0 {
                    return self.fail(Some(i), done, 1.0); // 429
                }
                n.tokens -= 1.0;
            }
        }
        if kind == "queue" {
            if self.nodes[i].backlog.len() >= QUEUE_BACKLOG_MAX {
                return self.fail(Some(i), done, 0.5);
            }
            self.nodes[i].backlog.push_back(Job { read, t_in: now, done: None });
            let ack = base_latency_of(&self.nodes[i].data);
            self.at(ack, Ev::Deliver { done, ok: true }); // the producer gets the ack
            self.pump(i);
            return;
        }
        if kind == "llmapi" {
            // provider capacity is not your problem — only its rate limit and latency are
            let n = &self.nodes[i];
            let (mean, fl) = (n.svc_mean_ms, n.data.fault_latency_ms.unwrap_or(0.0));
            let cv = self.cfg.service_cv * 0.5;
            let svc = self.rng.lognormal(mean, cv) + fl;
            let fault = self.nodes[i].data.fault_rate.unwrap_or(0.0);
            self.at(svc, Ev::LlmDone { n: i, done, fault });
            return;
        }
        self.enqueue(i, Job { read, t_in: now, done: Some(done) });
    }

    fn arrive_db(&mut self, i: usize, read: bool, done: ContId) {
        let replicas: Vec<usize> = self.nodes[i].children.iter().copied().filter(|&c| self.nodes[c].data.kind == "replica" && up(&self.nodes[c])).collect();
        if up(&self.nodes[i]) {
            self.nodes[i].down_since = None;
            if read && !replicas.is_empty() {
                let pick = (self.rng.next() * (replicas.len() + 1) as f64).floor() as usize;
                if pick > 0 {
                    return self.hop(replicas[pick - 1], read, done, Some(i));
                }
            }
            let now = self.now;
            return self.enqueue(i, Job { read, t_in: now, done: Some(done) });
        }
        if self.nodes[i].down_since.is_none() {
            self.nodes[i].down_since = Some(self.now);
        }
        if replicas.is_empty() {
            return self.fail(Some(i), done, 0.5);
        }
        let promoted = match self.cfg.failover_s {
            Some(f) => self.now - self.nodes[i].down_since.unwrap() >= f,
            None => false,
        };
        if !read {
            return if promoted { self.hop(replicas[0], read, done, Some(i)) } else { self.fail(Some(i), done, 0.5) };
        }
        let k = (self.rng.next() * replicas.len() as f64).floor() as usize;
        self.hop(replicas[k], read, done, Some(i))
    }

    /// one call over the network: a hop plus the link's round trip, if it has one
    fn hop(&mut self, i: usize, read: bool, done: ContId, from: Option<usize>) {
        let link = from.and_then(|f| self.link_ms.get(&(f, i)).copied()).unwrap_or(0.0);
        let ms = self.cfg.hop_ms + link;
        // a link that makes N calls per request: N in parallel, done when all have answered
        let n = from.and_then(|f| self.link_calls.get(&(f, i)).copied()).unwrap_or(1.0);
        if n > 1.0 {
            let group = self.groups.len();
            self.groups.push(Some(Group { pending: n as usize, all_ok: true, done }));
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
        if x.busy < x.workers {
            return self.start(n, job);
        }
        if x.queue.len() as f64 >= x.queue_max {
            return self.fail(Some(n), job.done.unwrap(), 0.5);
        }
        self.nodes[n].queue.push_back(job);
    }

    fn start(&mut self, n: usize, job: Job) {
        self.set_busy(n, 1.0);
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
            if x.busy > x.warm {
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
        while !self.nodes[n].queue.is_empty() && self.nodes[n].busy < self.nodes[n].workers {
            let next = self.nodes[n].queue.pop_front().unwrap();
            if (self.now - next.t_in) * 1000.0 > bound {
                self.fail(Some(n), next.done.unwrap(), 0.5);
                continue;
            }
            self.start(n, next);
        }
        self.after_service(n, job);
    }

    fn after_service(&mut self, n: usize, job: Job) {
        let done = job.done.unwrap();
        let kind = self.nodes[n].kind;
        if let Some(fr) = self.nodes[n].data.fault_rate.filter(|x| *x != 0.0) {
            if self.rng.next() < fr {
                return self.fail(Some(n), done, 0.0);
            }
        }
        if kind == "cache" || kind == "cdn" {
            let d = &self.nodes[n].data;
            // writes never hit: they go on to the origin, or wait in a write-behind cache
            if !job.read && d.write_policy.as_deref() == Some("behind") {
                let wait = self.rng.exp(super::engine::WRITE_BEHIND_S) * 1000.0;
                self.at(wait, Ev::Flush { n });
                return self.deliver(done, true);
            }
            let hit = if job.read { super::catalog::cache_hit_rate(d) * cache_warmth(self.nodes[n].cold_at, self.now, d.warmup_s) } else { 0.0 };
            if self.rng.next() < hit {
                self.nodes[n].win.hits += 1.0;
                return self.deliver(done, true);
            }
            if self.nodes[n].children.is_empty() {
                return self.fail(Some(n), done, 0.0);
            }
        }
        if kind == "db" || kind == "replica" {
            return self.deliver(done, true);
        }
        if self.nodes[n].children.is_empty() {
            return self.deliver(done, kind != "lb" && kind != "gateway");
        }
        self.call_downstream(n, job.read, done);
    }

    /// queue consumers (pull model)
    fn pump(&mut self, n: usize) {
        let consumers: Vec<usize> = self.nodes[n].children.iter().copied().filter(|&c| up(&self.nodes[c])).collect();
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
                return self.at(1.0, Ev::Deliver { done, ok: fb });
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

    fn settle(&mut self, id: ContId, ok: bool, late: bool) {
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
            return self.deliver(done, true);
        }
        let can_retry = k < retries && (!budget || self.nodes[n].retry_tokens >= 1.0);
        if !can_retry {
            self.calls[call] = None;
            return self.deliver(done, false);
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
        let filter = kind == "lb" || kind == "gateway" || kind == "queue";
        let restricted = !self.link_carries.is_empty() && self.nodes[n].children.iter().any(|&c| self.link_carries.contains_key(&(n, c)));
        // the common case: one child picked at random, no list built
        if mode == "split" && degree <= 1.0 && !filter && !restricted {
            let len = self.nodes[n].children.len();
            if len == 0 {
                return self.fail(Some(n), done, 0.5);
            }
            let k = (self.rng.next() * len as f64).floor() as usize;
            let c = self.nodes[n].children[k];
            return self.hop(c, read, done, Some(n));
        }
        let mut kids = self.nodes[n].children.clone();
        if filter {
            kids.retain(|&c| up(&self.nodes[c]));
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
            return self.fail(Some(n), done, 0.5);
        }
        if mode == "fanout" {
            let group = self.groups.len();
            self.groups.push(Some(Group { pending: kids.len(), all_ok: true, done }));
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
            self.groups.push(Some(Group { pending: degree as usize, all_ok: true, done }));
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
                self.deliver(finish, false);
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
        let mut cost = 0.0;
        for i in 0..self.nodes.len() {
            self.set_busy(i, 0.0);
            let fo = self.cfg.failover_s;
            let n = &self.nodes[i];
            let w = &n.win;
            let workers = if n.workers.is_finite() { n.workers } else { 1.0 };
            let util = if n.data.kind == "queue" { n.backlog.len() as f64 / QUEUE_BACKLOG_MAX as f64 } else if n.rate.is_finite() { w.arrivals / (n.rate * win_s).max(1e-9) } else { w.busy_area / (workers * win_s) };
            let billed = if n.data.kind == "function" || n.data.kind == "llmapi" { w.usage_reqs } else if n.data.kind == "client" { 0.0 } else { w.arrivals };
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
                queue: if n.data.kind == "queue" { n.backlog.len() as f64 } else { n.queue.len() as f64 },
                latency_ms: 0.0,
                success: if w.arrivals != 0.0 { 1.0 - w.drops / w.arrivals } else { 1.0 },
                hit_rps: w.hits / win_s,
                reachable: if n.pooled { instances_up(&n.data) } else { instances_up(&n.data).min(1.0) },
                lag_s: 0.0,
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
            Ev::Deliver { done, ok } => self.deliver(done, ok),
            Ev::Finish { n, job } => self.finish(n, job),
            Ev::LlmDone { n, done, fault } => {
                self.nodes[n].win.usage_reqs += 1.0;
                if fault != 0.0 && !fault.is_nan() && self.rng.next() < fault {
                    return self.fail(Some(n), done, 0.0);
                }
                self.deliver(done, true)
            }
            Ev::Attempt { call, k } => self.attempt(call, k),
            Ev::Timeout { settle } => self.settle(settle, false, true),
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
            queue: VecDeque::new(),
            queue_max: 0.0,
            last_busy_t: 0.0,
            rate: f64::INFINITY,
            tokens: 0.0,
            last_refill: 0.0,
            warm: 0.0,
            down_since: None,
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
        if k == "lb" || k == "gateway" || k == "queue" || nodes[a].data.fanout.unwrap_or(1.0) > 1.0 {
            nodes[b].pooled = true;
        }
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
            lost_writes: des.lost_writes,
            worst_moment_s: r3(des.worst_t),
            events: processed,
            wall_ms,
        },
        slo: super::headless::SloOut { max_error_rate: sc.slo.0, max_p99_ms: sc.slo.1 },
        timeline: des.timeline.clone(),
        components,
        bottlenecks,
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
