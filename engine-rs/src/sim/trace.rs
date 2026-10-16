//! Request journeys for the discrete-event engine: a small sample of users' requests followed hop by
//! hop — when each call left, when it reached the component, how long it queued and how long it was
//! worked on, and how it ended (answered, a cache hit, queued for consumers, failed and why, or given
//! up on at the caller's deadline), retries and fan-out parts as children of the call that made them.
//!
//! Off unless the run's config asks for it. It only reads the run: it draws no numbers from the run's
//! generator and schedules no events, so a run gives the same results traced or not. Memory is bounded:
//! a request is picked one in `stride` (adjusted every second to about `perSec` a second), a journey
//! holds at most `maxSpans` hops, and each component keeps a reservoir of `perNode` journeys through it
//! and `perNode` failed ones.

use super::des::Rng;
use crate::math::js_round;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct TraceConfig {
    /// journeys kept per component, and failed journeys per component
    pub per_node: usize,
    /// about this many requests a second are followed
    pub per_sec: f64,
    /// only requests that start in [fromS, toS]
    pub from_s: f64,
    pub to_s: Option<f64>,
    /// hops per journey; past it the rest of the journey is not recorded
    pub max_spans: usize,
}

impl Default for TraceConfig {
    fn default() -> Self {
        TraceConfig { per_node: 8, per_sec: 40.0, from_s: 0.0, to_s: None, max_spans: 64 }
    }
}

/// how a span came to be: the first call, a retry, one part of a fan-out, the next target of a
/// failover, or a request a component passed on as it was (a primary routing a read to a replica)
pub const VIA_CALL: u8 = 0;
pub const VIA_RETRY: u8 = 1;
pub const VIA_FANOUT: u8 = 2;
pub const VIA_FAILOVER: u8 = 3;
pub const VIA_ROUTED: u8 = 4;

pub const MARK_HIT: u8 = 1;
pub const MARK_QUEUED: u8 = 2;

/// a continuation's place in a journey: the trace (0: none), the span, the attempt and how it began
#[derive(Clone, Copy, Default)]
struct Tc {
    tr: u32,
    span: u16,
    k: u8,
    via: u8,
}

#[derive(Clone)]
struct Span {
    node: usize,
    parent: i32,
    k: u8,
    via: u8,
    /// a component that passed the request on as it was ends when the one it passed it to does
    fwd: bool,
    sent: f64,
    arrive: f64,
    start: f64,
    served: f64,
    /// shed from its queue after waiting past the bound, without being worked on
    left: f64,
    end: f64,
    why: u32,
    mark: u8,
    /// when the caller gave up on it, and its deadline, ms
    gave_up: f64,
    deadline_ms: f64,
}

#[derive(Clone)]
struct Buf {
    t0: f64,
    read: bool,
    spans: Vec<Span>,
    truncated: bool,
    why: u32,
    end: f64,
}

#[derive(Default)]
struct Reservoir {
    ids: Vec<u32>,
    seen: f64,
}

pub struct Tracer {
    cfg: TraceConfig,
    owner: Vec<Tc>,
    callee: Vec<Tc>,
    live: HashMap<u32, Buf>,
    next_id: u32,
    stride: f64,
    count: f64,
    started: f64,
    picked: f64,
    kept: HashMap<u32, (Buf, u32)>,
    all: Vec<Reservoir>,
    failed: Vec<Reservoir>,
    rng: Rng,
}

impl Tracer {
    pub fn new(cfg: TraceConfig, nodes: usize, seed: f64) -> Tracer {
        Tracer {
            cfg,
            owner: vec![],
            callee: vec![],
            live: HashMap::new(),
            next_id: 1,
            stride: 1.0,
            count: 0.0,
            started: 0.0,
            picked: 0.0,
            kept: HashMap::new(),
            all: (0..nodes).map(|_| Reservoir::default()).collect(),
            failed: (0..nodes).map(|_| Reservoir::default()).collect(),
            // its own generator: the run's draws are untouched
            rng: Rng::new(seed * 7919.0 + 17.0),
        }
    }

    /// a continuation was made (or reused): it belongs to no journey yet
    pub fn fresh(&mut self, id: usize) {
        if id >= self.owner.len() {
            self.owner.resize(id + 1, Tc::default());
            self.callee.resize(id + 1, Tc::default());
        } else {
            self.owner[id] = Tc::default();
            self.callee[id] = Tc::default();
        }
    }

    pub fn release(&mut self, id: usize) {
        if id < self.owner.len() {
            self.owner[id] = Tc::default();
            self.callee[id] = Tc::default();
        }
    }

    /// each second: pick one request in `stride` so that about perSec a second are followed
    pub fn second(&mut self) {
        self.stride = (self.started / self.cfg.per_sec.max(1e-9)).floor().max(1.0);
        self.started = 0.0;
        self.picked = 0.0;
    }

    /// a user's request starts at a client: follow it, if it is picked
    pub fn begin(&mut self, now: f64, client: usize, read: bool, done: usize) {
        self.started += 1.0;
        if now < self.cfg.from_s || self.cfg.to_s.map_or(false, |t| now > t) {
            return;
        }
        self.count += 1.0;
        if self.count < self.stride || self.picked >= self.cfg.per_sec * 2.0 {
            return;
        }
        self.count = 0.0;
        self.picked += 1.0;
        let id = self.next_id;
        self.next_id += 1;
        let root = Span { node: client, parent: -1, k: 0, via: VIA_CALL, fwd: false, sent: now, arrive: now, start: now, served: now, left: f64::NAN, end: f64::NAN, why: 0, mark: 0, gave_up: f64::NAN, deadline_ms: f64::NAN };
        self.live.insert(id, Buf { t0: now, read, spans: vec![root], truncated: false, why: 0, end: f64::NAN });
        self.callee[done] = Tc { tr: id, span: 0, k: 0, via: VIA_CALL };
    }

    /// attempt k of a call made by the span working under `caller`
    pub fn call(&mut self, settle: usize, caller: usize, k: f64) {
        let c = self.callee[caller];
        if c.tr == 0 {
            return;
        }
        let k = k.min(255.0) as u8;
        self.owner[settle] = Tc { tr: c.tr, span: c.span, k, via: if k > 0 { VIA_RETRY } else { VIA_CALL } };
    }

    /// a part (of a fan-out, or the next failover target) made for the call under `from`
    pub fn inherit(&mut self, new: usize, from: usize, via: Option<u8>) {
        let mut o = self.owner[from];
        if o.tr == 0 {
            return;
        }
        if let Some(v) = via {
            o.via = v;
        }
        self.owner[new] = o;
    }

    /// a continuation wrapping another (a held thread, a bulkhead slot): the same place in the journey
    pub fn wrap(&mut self, new: usize, inner: usize) {
        self.owner[new] = self.owner[inner];
        self.callee[new] = self.callee[inner];
    }

    /// a call leaves for `node`; its answer comes back to `done`
    pub fn hop(&mut self, done: usize, node: usize, now: f64) {
        let (o, c) = (self.owner[done], self.callee[done]);
        // a component passing the request on as it was: the new hop is its child
        let (tr, parent, k, via, fwd) = if c.tr != 0 { (c.tr, c.span, 0, VIA_ROUTED, true) } else if o.tr != 0 { (o.tr, o.span, o.k, o.via, false) } else { return };
        let max = self.cfg.max_spans;
        let b = match self.live.get_mut(&tr) {
            Some(b) => b,
            None => return,
        };
        if b.spans.len() >= max {
            b.truncated = true;
            return;
        }
        b.spans.push(Span { node, parent: parent as i32, k, via, fwd, sent: now, arrive: f64::NAN, start: f64::NAN, served: f64::NAN, left: f64::NAN, end: f64::NAN, why: 0, mark: 0, gave_up: f64::NAN, deadline_ms: f64::NAN });
        self.callee[done] = Tc { tr, span: (b.spans.len() - 1) as u16, k, via };
    }

    fn span(&mut self, id: usize) -> Option<&mut Span> {
        let c = *self.callee.get(id)?;
        if c.tr == 0 {
            return None;
        }
        self.live.get_mut(&c.tr).and_then(|b| b.spans.get_mut(c.span as usize))
    }

    pub fn arrive(&mut self, id: usize, now: f64) {
        if let Some(s) = self.span(id) {
            if s.arrive.is_nan() {
                s.arrive = now;
            }
        }
    }

    pub fn start(&mut self, id: usize, now: f64) {
        if let Some(s) = self.span(id) {
            if s.start.is_nan() {
                s.start = now;
            }
        }
    }

    pub fn served(&mut self, id: usize, at: f64) {
        if let Some(s) = self.span(id) {
            if s.served.is_nan() {
                s.served = at;
            }
        }
    }

    /// it waited past its queue's bound and was shed without being worked on
    pub fn left_queue(&mut self, id: usize, now: f64) {
        if let Some(s) = self.span(id) {
            if s.left.is_nan() && s.start.is_nan() {
                s.left = now;
            }
        }
    }

    pub fn mark(&mut self, id: usize, m: u8) {
        if let Some(s) = self.span(id) {
            s.mark = m;
        }
    }

    /// the call's deadline passed: every hop of that attempt still out is given up on
    pub fn timeout(&mut self, settle: usize, now: f64, deadline_ms: Option<f64>) {
        let o = self.owner[settle];
        if o.tr == 0 {
            return;
        }
        if let Some(b) = self.live.get_mut(&o.tr) {
            // the attempt's own hops, and every hop below them still out (the one stuck in a queue
            // may be a few calls further down)
            let mut out: Vec<usize> = (0..b.spans.len()).filter(|&i| b.spans[i].parent == o.span as i32 && b.spans[i].k == o.k && b.spans[i].end.is_nan()).collect();
            let mut j = 0;
            while j < out.len() {
                let p = out[j] as i32;
                out.extend((0..b.spans.len()).filter(|&i| b.spans[i].parent == p && b.spans[i].end.is_nan()));
                j += 1;
            }
            for i in out {
                let s = &mut b.spans[i];
                if s.gave_up.is_nan() {
                    s.gave_up = now;
                    s.deadline_ms = deadline_ms.unwrap_or(f64::NAN);
                }
            }
        }
    }

    /// a continuation ran with this outcome: the hop working under it ends (and one that passed the
    /// request on to it); a user's request ending closes its journey
    pub fn deliver(&mut self, id: usize, why: u32, now: f64, user: bool) {
        let c = match self.callee.get(id) {
            Some(c) if c.tr != 0 => *c,
            _ => return,
        };
        if let Some(b) = self.live.get_mut(&c.tr) {
            let mut i = c.span as i32;
            while i >= 0 {
                let s = &mut b.spans[i as usize];
                if !s.end.is_nan() {
                    break;
                }
                s.end = now;
                s.why = why;
                if !s.fwd {
                    break;
                }
                i = s.parent;
            }
        }
        if user && c.span == 0 {
            if let Some(mut b) = self.live.remove(&c.tr) {
                b.why = why;
                b.end = now;
                self.keep(c.tr, b);
            }
        }
    }

    fn keep(&mut self, id: u32, b: Buf) {
        let failed = b.why != 0;
        let mut visited: Vec<usize> = b.spans.iter().map(|s| s.node).collect();
        visited.sort_unstable();
        visited.dedup();
        let n = self.cfg.per_node.max(1);
        let mut refs = 0u32;
        let mut evicted: Vec<u32> = vec![];
        for &v in &visited {
            for res in if failed { vec![&mut self.all[v], &mut self.failed[v]] } else { vec![&mut self.all[v]] } {
                res.seen += 1.0;
                if res.ids.len() < n {
                    res.ids.push(id);
                    refs += 1;
                } else {
                    let j = (self.rng.next() * res.seen).floor() as usize;
                    if j < n {
                        evicted.push(res.ids[j]);
                        res.ids[j] = id;
                        refs += 1;
                    }
                }
            }
        }
        if refs > 0 {
            self.kept.insert(id, (b, refs));
        }
        for e in evicted {
            if let Some(k) = self.kept.get_mut(&e) {
                k.1 -= 1;
                if k.1 == 0 {
                    self.kept.remove(&e);
                }
            }
        }
    }

    /// the journeys kept, oldest first, and which go through each component
    pub fn report(&self, nodes: &[(String, String, String)], reason: &dyn Fn(u8) -> &'static str) -> TraceReport {
        let mut ids: Vec<u32> = self.kept.keys().copied().collect();
        ids.sort_unstable();
        let index: HashMap<u32, usize> = ids.iter().enumerate().map(|(i, id)| (*id, i)).collect();
        let r1 = |x: f64| js_round(x * 10.0) / 10.0;
        let ms = |t0: f64, t: f64| if t.is_nan() { None } else { Some(r1((t - t0) * 1000.0)) };
        let origin = |w: u32| ((w >> 8) as usize).checked_sub(1).and_then(|n| nodes.get(n)).map(|n| n.0.clone());
        let journeys = ids
            .iter()
            .map(|id| {
                let b = &self.kept[id].0;
                let t0 = b.t0;
                let spans = b
                    .spans
                    .iter()
                    .map(|s| {
                        let failed = !s.end.is_nan() && s.why != 0;
                        let outcome = if !s.gave_up.is_nan() {
                            "timeout"
                        } else if s.end.is_nan() {
                            "open"
                        } else if failed {
                            "failed"
                        } else if s.mark == MARK_HIT {
                            "hit"
                        } else if s.mark == MARK_QUEUED {
                            "queued"
                        } else {
                            "ok"
                        };
                        let net = if s.arrive.is_nan() { 0.0 } else { s.arrive - s.sent };
                        let wait = if s.arrive.is_nan() {
                            0.0
                        } else if !s.start.is_nan() {
                            s.start - s.arrive
                        } else if !s.left.is_nan() {
                            s.left - s.arrive
                        } else {
                            0.0
                        };
                        let svc = if s.start.is_nan() || s.served.is_nan() { 0.0 } else { s.served - s.start };
                        SpanOut {
                            id: nodes[s.node].0.clone(),
                            parent: s.parent,
                            via: match s.via {
                                VIA_RETRY => "retry",
                                VIA_FANOUT => "fanout",
                                VIA_FAILOVER => "failover",
                                VIA_ROUTED => "routed",
                                _ => "call",
                            }
                            .into(),
                            attempt: s.k,
                            sent_ms: r1((s.sent - t0) * 1000.0),
                            arrive_ms: ms(t0, s.arrive),
                            start_ms: ms(t0, s.start),
                            served_ms: ms(t0, s.served),
                            end_ms: ms(t0, s.end),
                            network_ms: r1(net * 1000.0),
                            wait_ms: r1(wait * 1000.0),
                            service_ms: r1(svc * 1000.0),
                            outcome: outcome.into(),
                            reason: if failed { Some(reason((s.why & 0xff) as u8).into()) } else { None },
                            origin: if failed { origin(s.why) } else { None },
                            gave_up_ms: ms(t0, s.gave_up),
                            deadline_ms: if s.deadline_ms.is_nan() { None } else { Some(s.deadline_ms) },
                        }
                    })
                    .collect();
                Journey {
                    id: *id,
                    at_s: js_round(t0 * 1000.0) / 1000.0,
                    read: b.read,
                    ms: r1((b.end - t0) * 1000.0),
                    ok: b.why == 0,
                    failed_at: if b.why != 0 { origin(b.why) } else { None },
                    reason: if b.why != 0 { Some(reason((b.why & 0xff) as u8).into()) } else { None },
                    truncated: b.truncated,
                    spans,
                }
            })
            .collect();
        let mut by_node = IndexMap::new();
        for (i, n) in nodes.iter().enumerate() {
            if self.all[i].seen == 0.0 {
                continue;
            }
            let pick = |r: &Reservoir| {
                let mut v: Vec<usize> = r.ids.iter().filter_map(|id| index.get(id).copied()).collect();
                v.sort_unstable();
                v
            };
            by_node.insert(n.0.clone(), NodeJourneys { all: pick(&self.all[i]), failed: pick(&self.failed[i]), seen: self.all[i].seen, seen_failed: self.failed[i].seen });
        }
        TraceReport { journeys, by_node }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SpanOut {
    /// the component
    pub id: String,
    /// the hop that made this call (-1: the user's own)
    pub parent: i32,
    pub via: String,
    /// 0 for the first attempt, 1 for the first retry…
    pub attempt: u8,
    /// ms after the request began
    pub sent_ms: f64,
    pub arrive_ms: Option<f64>,
    pub start_ms: Option<f64>,
    pub served_ms: Option<f64>,
    pub end_ms: Option<f64>,
    /// the network on the way there, the wait in its queue (also when it was shed from it after
    /// waiting past the bound), and its own work
    pub network_ms: f64,
    pub wait_ms: f64,
    pub service_ms: f64,
    /// ok, hit (a cache answered), queued (left for consumers), failed, timeout (the caller gave up at
    /// its deadline), open (still out when the request ended)
    pub outcome: String,
    pub reason: Option<String>,
    /// the component the failure started at
    pub origin: Option<String>,
    pub gave_up_ms: Option<f64>,
    pub deadline_ms: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Journey {
    pub id: u32,
    /// when it began in the run, s
    pub at_s: f64,
    pub read: bool,
    /// how long the user waited for the answer or the failure
    pub ms: f64,
    pub ok: bool,
    pub failed_at: Option<String>,
    pub reason: Option<String>,
    pub truncated: bool,
    pub spans: Vec<SpanOut>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NodeJourneys {
    /// indices into the journeys: a sample of those through it, and of the failed ones
    pub all: Vec<usize>,
    pub failed: Vec<usize>,
    /// followed requests that went through it, and those that failed
    pub seen: f64,
    pub seen_failed: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TraceReport {
    pub journeys: Vec<Journey>,
    pub by_node: IndexMap<String, NodeJourneys>,
}
