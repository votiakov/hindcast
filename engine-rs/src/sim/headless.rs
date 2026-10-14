//! The simulator as an analysis tool (src/sim/headless.ts): spec in, numbers and explanations out —
//! a run over a scenario, variants compared, the breaking point, the load curve. Scripted actions
//! (src/sim/actions.ts) and the one-line explanation of a component's state (src/canvas/nodeModel.ts)
//! come with it.

use super::catalog::*;
use super::engine::{Engine, EngineConfig, NodeStats, SimEdge, SimNode};
use super::spec::{apply_variant, graph_of, parse_architecture, parse_scenario, Action, Architecture, Scenario};
use crate::backtest::{js_max, js_sort_by};
use crate::math::{js_num, js_round, js_to_fixed};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

fn round(n: f64, d: i32) -> f64 {
    let p = 10f64.powi(d);
    js_round(n * p) / p
}

pub fn fmt_ms(ms: f64) -> String {
    if ms >= 1000.0 {
        format!("{}s", js_to_fixed(ms / 1000.0, 1))
    } else {
        format!("{}ms", js_to_fixed(ms, 0))
    }
}

pub fn fmt(n: f64) -> String {
    if !n.is_finite() {
        "∞".into()
    } else if n >= 1000.0 {
        format!("{}k", js_to_fixed(n / 1000.0, 1))
    } else if n >= 10.0 {
        js_to_fixed(n, 0)
    } else {
        js_to_fixed(n, 1)
    }
}

fn health_of(util: f64, drop: f64, in_rps: f64, up: bool) -> &'static str {
    if !up {
        return "down";
    }
    if drop > (in_rps * 0.02).max(1.0) || util >= 0.95 {
        return "hot";
    }
    if util >= 0.7 {
        return "warm";
    }
    if in_rps < 0.5 {
        return "idle";
    }
    "ok"
}

/// the parts of the app's node view the headless report reads
pub struct View {
    pub health: &'static str,
    pub up: bool,
    pub failed_over: bool,
    pub electing: bool,
    pub unreachable: bool,
    pub no_origin: bool,
}

pub fn node_view(d0: &NodeData, st: Option<&NodeStats>, running: bool, has_outgoing: bool) -> View {
    let d = match st.and_then(|s| s.scaling.as_ref()) {
        Some(sc) => NodeData { instances: Some(sc.live), down: Some(d0.down.unwrap_or(0.0).min(sc.live)), ..d0.clone() },
        None => d0.clone(),
    };
    let failover = st.map(|s| s.failover.as_str()).unwrap_or("none");
    let up = is_up(&d) || (d.kind == "db" && failover == "electing");
    let util = st.map(|s| s.util).unwrap_or(0.0);
    let in_rps = st.map(|s| s.in_rps).unwrap_or(0.0);
    let drop = st.map(|s| s.drop_rps).unwrap_or(0.0);
    let health = if d.kind == "client" {
        if up {
            if in_rps > 0.5 {
                "ok"
            } else {
                "idle"
            }
        } else {
            "down"
        }
    } else if d.kind == "queue" {
        if !up {
            "down"
        } else if drop > 1.0 {
            "hot"
        } else if st.map(|s| s.queue).unwrap_or(0.0) > 500.0 {
            "warm"
        } else if in_rps < 0.5 {
            "idle"
        } else {
            "ok"
        }
    } else if failover == "electing" {
        "hot"
    } else {
        health_of(util, drop, in_rps, up)
    };
    let iu = instances_up(&d);
    View {
        health,
        up,
        failed_over: d.kind == "db" && failover == "promoted",
        electing: failover == "electing",
        unreachable: spec(&d.kind).scalable && d.kind != "llm" && iu > 1.0 && st.map(|s| s.reachable).unwrap_or(1.0) < iu && running,
        no_origin: (d.kind == "cache" || d.kind == "cdn") && !has_outgoing,
    }
}

/// one plain-English sentence on what a component is going through, and why
pub fn explain(d: &NodeData, st: Option<&NodeStats>, v: &View) -> Option<String> {
    let st = st?;
    let cap = capacity_of(d, Some(st.reachable));
    let pct = |x: f64| js_num(js_round(x * 100.0));
    Some(if v.failed_over {
        "Primary is down. A replica was promoted and now takes writes; this node only forwards.".into()
    } else if v.electing {
        "Primary lost. Electing a replica — writes fail until one is promoted; reads continue on replicas.".into()
    } else if !v.up {
        "Unavailable. Every request routed here fails unless an upstream load balancer can route around it.".into()
    } else if let Some(fr) = d.fault_rate.filter(|x| *x != 0.0) {
        format!("Injected fault: {}% of requests here fail — a bad deploy looks exactly like this. Callers with retries amplify it.", pct(fr))
    } else if let Some(fl) = d.fault_latency_ms.filter(|x| *x != 0.0) {
        format!("Gray failure: +{} on every request. It is still \"up\", so health checks pass — but each worker is busy longer, so throughput drops too.", fmt_ms(fl))
    } else if (d.kind == "cache" || d.kind == "cdn") && st.warmth < 0.9 {
        format!("Cold cache: only {}% warm, so misses that used to be hits stampede the origin until it refills.", pct(st.warmth))
    } else if let Some(sc) = st.scaling.as_ref().filter(|s| s.pending > 0.0) {
        format!(
            "Scaling out: {} instance{} booting (warm-up {}s). Capacity arrives after the demand did — that gap is where errors happen.",
            js_num(sc.pending),
            if sc.pending > 1.0 { "s" } else { "" },
            js_num(d.autoscale.as_ref().and_then(|a| a.warmup_s).unwrap_or(30.0))
        )
    } else if st.breaker.as_deref() == Some("open") {
        format!("Circuit breaker open: calls to the failing dependency are cut off{}, giving it room to recover.", if d.fallback == Some(true) { " and a fallback response is served" } else { " and fail fast" })
    } else if st.retry_amp > 1.5 {
        format!("Retry amplification ×{}: failed calls are retried, multiplying the load on an already struggling dependency.", js_to_fixed(st.retry_amp, 1))
    } else if st.late_frac > 0.05 {
        format!("{}% of responses arrive after the {} timeout — the work was done, but the caller had already given up.", pct(st.late_frac), fmt_ms(d.timeout_ms.unwrap_or(0.0)))
    } else if d.kind == "queue" && st.lag_s > 5.0 {
        format!("Backlog of {} messages: consumers are {} behind. Producers are unaffected — work completes later.", fmt(st.queue), if st.lag_s.is_finite() { format!("{}s", js_to_fixed(st.lag_s, 0)) } else { "indefinitely".into() })
    } else if (d.kind == "gateway" || d.kind == "llmapi") && st.drop_rps > 1.0 {
        format!("Rate limit reached: {}/s rejected with HTTP 429 to protect what is behind it.", fmt(st.drop_rps))
    } else if d.kind == "function" && st.cold_frac > 0.05 {
        format!("{}% of invocations hit a cold start while new instances spin up.", pct(st.cold_frac))
    } else if v.health == "hot" && st.drop_rps > 1.0 {
        format!("Overloaded: {} req/s offered vs {} req/s capacity. The excess queues, then gets dropped.", fmt(st.in_rps), fmt(cap))
    } else if v.health == "hot" {
        format!("Saturated at {}% — requests are queuing and latency is climbing steeply.", pct(st.util))
    } else if v.health == "warm" {
        format!("{}% utilised. Queueing delay grows non-linearly beyond ~70%; little headroom left for spikes.", pct(st.util))
    } else if v.unreachable {
        "Extra instances receive no traffic: without a load balancer, clients only know one address.".into()
    } else if v.no_origin {
        "No origin behind this cache: every miss has nowhere to go and fails.".into()
    } else {
        return None;
    })
}

/// apply a scripted action to the board; the component it hit (None: nothing)
pub fn apply_action(nodes: &mut [SimNode], zones: &IndexMap<String, Vec<String>>, a: &Action, in_rps: &dyn Fn(&str) -> f64, rand: &mut dyn FnMut() -> f64) -> Option<String> {
    fn kill(nodes: &mut [SimNode], id: &str) -> Option<String> {
        let n = nodes.iter_mut().find(|n| n.id == id)?;
        if spec(&n.data.kind).scalable && instances_up(&n.data) > 1.0 {
            n.data.down = Some(n.data.down.unwrap_or(0.0) + 1.0);
        } else {
            n.data.alive = false;
        }
        Some(id.to_string())
    }
    let set = |nodes: &mut [SimNode], id: &str, f: &dyn Fn(&mut NodeData)| {
        for n in nodes.iter_mut().filter(|n| n.id == id) {
            f(&mut n.data);
        }
    };
    match a {
        Action::ReviveAll => {
            for n in nodes.iter_mut() {
                n.data.alive = true;
                n.data.down = Some(0.0);
                n.data.degraded = None;
                n.data.fault_rate = None;
                n.data.fault_latency_ms = None;
            }
            Some("all".into())
        }
        Action::KillId(id) => kill(nodes, id),
        Action::ReviveId(id) => {
            set(nodes, id, &|d| {
                d.alive = true;
                d.down = Some(0.0);
            });
            Some(id.clone())
        }
        Action::Degrade(id, f) => {
            let f = *f;
            set(nodes, id, &move |d| d.degraded = Some(f));
            Some(id.clone())
        }
        Action::Restore(id) => {
            set(nodes, id, &|d| {
                d.degraded = None;
                d.fault_rate = None;
                d.fault_latency_ms = None;
            });
            Some(id.clone())
        }
        Action::InjectErrors(id, r) => {
            let r = *r;
            set(nodes, id, &move |d| d.fault_rate = Some(r));
            Some(id.clone())
        }
        Action::InjectLatency(id, ms) => {
            let ms = *ms;
            set(nodes, id, &move |d| d.fault_latency_ms = Some(ms));
            Some(id.clone())
        }
        Action::FlushCache(id) => {
            let n = nodes.iter_mut().find(|n| n.id == *id)?;
            n.data.flushes = Some(n.data.flushes.unwrap_or(0.0) + 1.0);
            Some(id.clone())
        }
        Action::FailZone(id) | Action::RestoreZone(id) => {
            let failed = matches!(a, Action::FailZone(_));
            let inside = zones.get(id).cloned().unwrap_or_default();
            for n in nodes.iter_mut().filter(|n| inside.contains(&n.id)) {
                n.data.alive = !failed;
                n.data.down = Some(0.0);
            }
            Some(id.clone())
        }
        Action::Kill { kind, busiest } => {
            let cands: Vec<String> = nodes.iter().filter(|n| n.data.kind == *kind && n.data.alive && instances_up(&n.data) > 0.0).map(|n| n.id.clone()).collect();
            if cands.is_empty() {
                return None;
            }
            let pick = if *busiest {
                let mut best = cands[0].clone();
                for c in &cands {
                    if in_rps(c) > in_rps(&best) {
                        best = c.clone();
                    }
                }
                best
            } else {
                cands[(rand() * cands.len() as f64).floor() as usize].clone()
            };
            kill(nodes, &pick)
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComponentReport {
    pub kind: String,
    pub peak_util: f64,
    pub mean_util: f64,
    pub peak_drop_rps: f64,
    pub dropped_total: f64,
    pub peak_latency_ms: f64,
    pub final_status: String,
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instances: Option<f64>,
    #[serde(rename = "async", skip_serializing_if = "Option::is_none")]
    pub is_async: Option<bool>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub duration_s: f64,
    pub mean_rps: f64,
    pub mean_error_rate: f64,
    pub peak_error_rate: f64,
    pub mean_p99_ms: f64,
    pub peak_p99_ms: f64,
    pub mean_cost_per_hour: f64,
    pub peak_cost_per_hour: f64,
    pub slo_compliance: f64,
    pub slo_breach_seconds: f64,
    pub requests: f64,
    pub failed_requests: f64,
    pub worst_moment_s: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SloOut {
    pub max_error_rate: f64,
    pub max_p99_ms: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub t: f64,
    pub rps: f64,
    pub error_rate: f64,
    pub p99_ms: f64,
    pub cost_per_hour: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Bottleneck {
    pub id: String,
    pub peak_util: f64,
    pub dropped_total: f64,
    pub note: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Event {
    pub t: f64,
    pub what: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SimResult {
    pub architecture: String,
    pub scenario: String,
    pub summary: Summary,
    pub slo: SloOut,
    pub timeline: Vec<Point>,
    pub components: IndexMap<String, ComponentReport>,
    pub bottlenecks: Vec<Bottleneck>,
    pub events: Vec<Event>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SimOptions {
    pub dt: Option<f64>,
    pub sample_every: Option<f64>,
    pub cfg: Option<Value>,
}

fn config(cfg: Option<&Value>) -> EngineConfig {
    let mut c = EngineConfig::default();
    if let Some(Value::Object(o)) = cfg {
        if let Some(x) = o.get("timeoutS").and_then(|x| x.as_f64()) {
            c.timeout_s = x;
        }
        if let Some(x) = o.get("failoverS") {
            c.failover_s = x.as_f64();
        }
        if let Some(x) = o.get("coldStartMs").and_then(|x| x.as_f64()) {
            c.cold_start_ms = x;
        }
    }
    c
}

/// a component whose every caller is a queue: it works off a backlog, users never wait on it
fn async_only(id: &str, nodes: &[SimNode], edges: &[SimEdge]) -> bool {
    let callers: Vec<Option<&str>> = edges.iter().filter(|e| e.target == id).map(|e| nodes.iter().find(|n| n.id == e.source).map(|n| n.data.kind.as_str())).collect();
    !callers.is_empty() && callers.iter().all(|k| *k == Some("queue"))
}

fn traffic_fn(sc: &Scenario) -> impl Fn(f64) -> f64 {
    let mut tl: Vec<(f64, f64)> = match &sc.traffic {
        Some(t) if !t.is_empty() => t.clone(),
        _ => vec![(0.0, sc.rps.unwrap_or(500.0))],
    };
    js_sort_by(&mut tl, |a, b| a.0 - b.0);
    move |t: f64| {
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
}

pub fn simulate_parsed(spec: &Architecture, sc: &Scenario, o: &SimOptions) -> SimResult {
    let pricing = spec.pricing.clone().unwrap_or_else(|| "illustrative".into());
    let (max_err, max_p99) = sc.slo;
    let dt = o.dt.unwrap_or(0.05);
    let sample_every = o.sample_every.unwrap_or(1.0);
    let cfg = config(o.cfg.as_ref());
    let traffic = traffic_fn(sc);
    let zones: IndexMap<String, Vec<String>> = spec.zones.iter().map(|z| (z.0.clone(), z.2.clone())).collect();
    let (mut nodes, edges) = graph_of(spec);
    let mut engine = Engine::new();
    let mut pending = sc.events.clone();
    js_sort_by(&mut pending, |a, b| a.0 - b.0);
    let mut pending: std::collections::VecDeque<_> = pending.into_iter().collect();
    let mut events: Vec<Event> = vec![];
    let mut timeline: Vec<Point> = vec![];
    struct Acc {
        util_sum: f64,
        n: f64,
        peak_util: f64,
        peak_drop: f64,
        dropped: f64,
        peak_lat: f64,
        worst: f64,
        worst_note: Option<String>,
    }
    let mut acc: IndexMap<String, Acc> = IndexMap::new();
    let mut last: IndexMap<String, NodeStats> = IndexMap::new();
    let mut since_sample = sample_every;
    let (mut requests, mut failed, mut breach) = (0.0, 0.0, 0.0);
    let (mut worst_t, mut worst_score) = (0.0, -1.0);
    let mut rand = crate::backtest::rng(12345.0);
    let has_out: std::collections::HashSet<String> = edges.iter().map(|e| e.source.clone()).collect();
    let steps = js_round(sc.duration / dt).max(0.0) as usize;
    for i in 0..steps {
        let t = i as f64 * dt;
        while pending.front().map(|e| e.0 <= t).unwrap_or(false) {
            let (_, action, note) = pending.pop_front().unwrap();
            let target = apply_action(&mut nodes, &zones, &action, &|id| last.get(id).map(|s| s.in_rps).unwrap_or(0.0), &mut rand);
            let id = action.id().unwrap_or("");
            events.push(Event {
                t: round(t, 2),
                what: note.unwrap_or_else(|| {
                    format!(
                        "{}{}{}",
                        action.kind_name(),
                        if action.id().is_some() { format!(" {}", id) } else { String::new() },
                        match &target {
                            Some(tg) if tg != id => format!(" → {}", tg),
                            _ => String::new(),
                        }
                    )
                }),
            });
        }
        for e in engine.step(&nodes, &edges, traffic(t), sc.read_ratio, dt, &cfg, &pricing) {
            events.push(Event { t: round(t + dt, 2), what: format!("{}: {}{}", e.kind, e.name, e.detail.map(|d| format!(" {}", d)).unwrap_or_default()) });
        }
        let snap = engine.snapshot(&nodes, &edges);
        let gl = snap.global;
        requests += gl.rps * dt;
        failed += gl.rps * gl.error_rate * dt;
        let ok = gl.error_rate <= max_err && gl.p99 <= max_p99;
        if !ok && gl.rps > 0.5 {
            breach += dt;
        }
        let score = gl.error_rate * 10.0 + gl.p99 / 1000.0;
        if score > worst_score {
            worst_score = score;
            worst_t = t;
        }
        for n in &nodes {
            let st = &snap.node_stats[&n.id];
            let a = acc.entry(n.id.clone()).or_insert(Acc { util_sum: 0.0, n: 0.0, peak_util: 0.0, peak_drop: 0.0, dropped: 0.0, peak_lat: 0.0, worst: -1.0, worst_note: None });
            a.util_sum += st.util;
            a.n += 1.0;
            a.peak_util = js_max(a.peak_util, [st.util]);
            a.peak_drop = js_max(a.peak_drop, [st.drop_rps]);
            a.dropped += st.drop_rps * dt;
            a.peak_lat = js_max(a.peak_lat, [st.latency_ms]);
            let v = node_view(&n.data, Some(st), true, has_out.contains(&n.id));
            let badness = st.drop_rps + st.util * 10.0 + (if v.up { 0.0 } else { 1000.0 }) + (if st.breaker.as_deref() == Some("open") { 500.0 } else { 0.0 }) + st.retry_amp * 20.0;
            if badness > a.worst {
                a.worst = badness;
                a.worst_note = explain(&n.data, Some(st), &v);
            }
        }
        last = snap.node_stats;
        since_sample += dt;
        if since_sample >= sample_every - 1e-9 {
            since_sample = 0.0;
            timeline.push(Point { t: round(t + dt, 2), rps: round(gl.rps, 1), error_rate: round(gl.error_rate, 4), p99_ms: round(gl.p99, 0), cost_per_hour: round(gl.cost, 3) });
        }
    }
    let mut components: IndexMap<String, ComponentReport> = IndexMap::new();
    for n in &nodes {
        let a = &acc[&n.id];
        let st = last.get(&n.id);
        let v = node_view(&n.data, st, true, has_out.contains(&n.id));
        components.insert(
            n.id.clone(),
            ComponentReport {
                kind: n.data.kind.clone(),
                peak_util: round(a.peak_util, 3),
                mean_util: round(a.util_sum / a.n, 3),
                peak_drop_rps: round(a.peak_drop, 1),
                dropped_total: js_round(a.dropped),
                peak_latency_ms: js_round(a.peak_lat),
                final_status: if v.failed_over { "failed over".into() } else if v.up { v.health.into() } else { "down".into() },
                note: a.worst_note.clone(),
                instances: st.and_then(|s| s.scaling.as_ref()).map(|s| s.live),
                is_async: if async_only(&n.id, &nodes, &edges) { Some(true) } else { None },
            },
        );
    }
    let mut ranked: Vec<(&String, &ComponentReport)> = components
        .iter()
        .filter(|(_, c)| c.kind != "client" && (c.peak_util >= 0.7 || c.dropped_total > 0.0 || c.final_status == "down") && !(c.is_async == Some(true) && c.dropped_total == 0.0))
        .collect();
    js_sort_by(&mut ranked, |a, b| {
        let d = b.1.dropped_total - a.1.dropped_total;
        if d != 0.0 && !d.is_nan() {
            d
        } else {
            b.1.peak_util - a.1.peak_util
        }
    });
    let bottlenecks: Vec<Bottleneck> = ranked.iter().take(5).map(|(id, c)| Bottleneck { id: (*id).clone(), peak_util: c.peak_util, dropped_total: c.dropped_total, note: c.note.clone() }).collect();
    let mean = |f: &dyn Fn(&Point) -> f64| if timeline.is_empty() { 0.0 } else { timeline.iter().fold(0.0, |s, x| s + f(x)) / timeline.len() as f64 };
    let peak = |f: &dyn Fn(&Point) -> f64| js_max(0.0, timeline.iter().map(f));
    SimResult {
        architecture: spec.name.clone().unwrap_or_else(|| "architecture".into()),
        scenario: sc.name.clone().unwrap_or_else(|| if sc.traffic.is_some() { "custom traffic".into() } else { format!("{} req/s steady", js_num(sc.rps.unwrap_or(500.0))) }),
        summary: Summary {
            duration_s: sc.duration,
            mean_rps: round(mean(&|x| x.rps), 1),
            mean_error_rate: round(mean(&|x| x.error_rate), 4),
            peak_error_rate: round(peak(&|x| x.error_rate), 4),
            mean_p99_ms: js_round(mean(&|x| x.p99_ms)),
            peak_p99_ms: js_round(peak(&|x| x.p99_ms)),
            mean_cost_per_hour: round(mean(&|x| x.cost_per_hour), 3),
            peak_cost_per_hour: round(peak(&|x| x.cost_per_hour), 3),
            slo_compliance: round(1.0 - breach / sc.duration, 3),
            slo_breach_seconds: round(breach, 1),
            requests: js_round(requests),
            failed_requests: js_round(failed),
            worst_moment_s: round(worst_t, 1),
        },
        slo: SloOut { max_error_rate: max_err, max_p99_ms: max_p99 },
        timeline,
        components,
        bottlenecks,
        events,
    }
}

pub fn simulate(spec: &Value, scenario: &Value, o: &SimOptions) -> Result<SimResult, String> {
    let a = parse_architecture(spec)?;
    let sc = parse_scenario(scenario)?;
    Ok(simulate_parsed(&a, &sc, o))
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CompareRow {
    pub name: String,
    pub meets_slo: bool,
    pub slo_compliance: f64,
    pub mean_error_rate: f64,
    pub peak_error_rate: f64,
    pub peak_p99_ms: f64,
    pub mean_cost_per_hour: f64,
    pub monthly_cost: f64,
    pub top_bottleneck: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct CompareRun {
    pub name: String,
    pub result: SimResult,
}

/// a baseline and variants under the same scenario; SLO-compliant variants ranked by cost
pub fn compare(base: &Value, variants: &[Value], scenario: &Value, o: &SimOptions) -> Result<(Vec<CompareRow>, Vec<(String, Architecture, SimResult)>), String> {
    let b = parse_architecture(base)?;
    let sc = parse_scenario(scenario)?;
    let mut runs = vec![("baseline".to_string(), b.clone())];
    for v in variants {
        runs.push((v.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string(), apply_variant(&b, v)?));
    }
    let results: Vec<(String, Architecture, SimResult)> = runs.into_iter().map(|(n, a)| {
        let r = simulate_parsed(&a, &sc, o);
        (n, a, r)
    }).collect();
    let rows: Vec<CompareRow> = results
        .iter()
        .map(|(name, _, r)| CompareRow {
            name: name.clone(),
            meets_slo: r.summary.slo_compliance >= 0.99,
            slo_compliance: r.summary.slo_compliance,
            mean_error_rate: r.summary.mean_error_rate,
            peak_error_rate: r.summary.peak_error_rate,
            peak_p99_ms: r.summary.peak_p99_ms,
            mean_cost_per_hour: r.summary.mean_cost_per_hour,
            monthly_cost: js_round(r.summary.mean_cost_per_hour * 730.0),
            top_bottleneck: r.bottlenecks.first().map(|b| format!("{}: {}", b.id, b.note.clone().unwrap_or_else(|| format!("peak {}% util", js_num(js_round(b.peak_util * 100.0)))))),
        })
        .collect();
    let mut ranked = rows.clone();
    js_sort_by(&mut ranked, |a, b| {
        let d = (b.meets_slo as i32 - a.meets_slo as i32) as f64;
        if d != 0.0 {
            d
        } else if a.meets_slo {
            a.mean_cost_per_hour - b.mean_cost_per_hour
        } else {
            b.slo_compliance - a.slo_compliance
        }
    });
    Ok((ranked, results))
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct BreakingOptions {
    pub read_ratio: Option<f64>,
    pub slo: Option<Value>,
    pub hold_s: Option<f64>,
    pub max_rps: Option<f64>,
    pub cfg: Option<Value>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BreakingPoint {
    pub max_rps: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_failing_rps: Option<f64>,
    pub limited_by: Option<String>,
    pub note: Option<String>,
    pub slo: SloOut,
}

fn steady(read_ratio: f64, rps: f64, hold: f64, slo: (f64, f64)) -> Scenario {
    Scenario { name: None, duration: hold, rps: Some(rps), traffic: None, read_ratio, events: vec![], slo }
}

fn tail_of(r: &SimResult) -> (f64, f64, f64) {
    let n = r.timeline.len();
    let tail = &r.timeline[n.saturating_sub(5)..];
    let k = tail.len() as f64;
    (tail.iter().fold(0.0, |s, x| s + x.error_rate) / k, tail.iter().fold(0.0, |s, x| s + x.p99_ms) / k, tail.iter().fold(0.0, |s, x| s + x.cost_per_hour) / k)
}

/// highest constant load the architecture sustains within SLO (steady state)
pub fn breaking_point(spec: &Value, o: &BreakingOptions) -> Result<BreakingPoint, String> {
    let a = parse_architecture(spec)?;
    let slo = (o.slo.as_ref().and_then(|s| s.get("maxErrorRate")).and_then(|x| x.as_f64()).unwrap_or(0.01), o.slo.as_ref().and_then(|s| s.get("maxP99Ms")).and_then(|x| x.as_f64()).unwrap_or(300.0));
    let hold = o.hold_s.unwrap_or(25.0);
    let cap = o.max_rps.unwrap_or(1_000_000.0);
    let so = SimOptions { dt: None, sample_every: Some(1.0), cfg: o.cfg.clone() };
    let probe = |rps: f64| {
        let r = simulate_parsed(&a, &steady(o.read_ratio.unwrap_or(0.8), rps, hold, slo), &so);
        let (err, p99, _) = tail_of(&r);
        (err <= slo.0 && p99 <= slo.1, r)
    };
    let (mut lo, mut hi) = (0.0, 50.0);
    let mut hi_run = probe(hi);
    while hi_run.0 && hi < cap {
        lo = hi;
        hi = cap.min(hi * 2.0);
        hi_run = probe(hi);
    }
    let slo_out = SloOut { max_error_rate: slo.0, max_p99_ms: slo.1 };
    if hi_run.0 {
        return Ok(BreakingPoint { max_rps: hi, first_failing_rps: None, limited_by: None, note: Some(format!("sustains the probe ceiling of {} req/s", js_num(hi))), slo: slo_out });
    }
    let mut i = 0;
    while i < 14 && hi - lo > (lo * 0.01).max(5.0) {
        let mid = js_round((lo + hi) / 2.0);
        let m = probe(mid);
        if m.0 {
            lo = mid;
        } else {
            hi = mid;
            hi_run = m;
        }
        i += 1;
    }
    let limiter = hi_run.1.bottlenecks.first();
    Ok(BreakingPoint { max_rps: lo, first_failing_rps: Some(hi), limited_by: limiter.map(|l| l.id.clone()), note: limiter.and_then(|l| l.note.clone()), slo: slo_out })
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CurvePoint {
    pub rps: f64,
    pub error_rate: f64,
    pub p99_ms: f64,
    pub cost_per_hour: f64,
    pub per_million: f64,
    pub bottleneck: Option<String>,
}

/// steady-state behaviour across a range of loads
pub fn load_curve(spec: &Value, max_rps: f64, points: Option<f64>, read_ratio: Option<f64>, hold_s: Option<f64>, cfg: Option<Value>) -> Result<Vec<CurvePoint>, String> {
    let a = parse_architecture(spec)?;
    let n = points.unwrap_or(16.0) as usize;
    let so = SimOptions { dt: None, sample_every: None, cfg };
    let mut out = vec![];
    for i in 1..=n {
        let rps = js_round((max_rps * i as f64) / n as f64);
        let r = simulate_parsed(&a, &steady(read_ratio.unwrap_or(0.8), rps, hold_s.unwrap_or(20.0), (0.01, 300.0)), &so);
        let (err, p99, cost) = tail_of(&r);
        let ok = rps * (1.0 - err);
        out.push(CurvePoint { rps, error_rate: round(err, 4), p99_ms: js_round(p99), cost_per_hour: round(cost, 3), per_million: if ok > 0.0 { round((cost / (ok * 3600.0)) * 1e6, 4) } else { 0.0 }, bottleneck: r.bottlenecks.first().map(|b| b.id.clone()) });
    }
    Ok(out)
}
