//! The backtest (src/backtest/backtest.ts): replay the history through the calibrated model as it is
//! and with each strategy applied, many times over with capacities drawn from their bootstrap bands,
//! and summarise what would have happened, with the measured history alongside.

use crate::engine::run_plan;
use crate::math::{js_num, js_round, js_to_fixed};
use crate::dataset::Dataset;
use crate::model::{Model, Slo};
use crate::strategy::{apply_strategy, locale_int, parse_strategy};
use crate::types::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------- JavaScript semantics the summaries depend on ----------

/// Math.max(init, ...xs): NaN anywhere makes it NaN
pub fn js_max(init: f64, xs: impl IntoIterator<Item = f64>) -> f64 {
    let mut m = init;
    for x in xs {
        if x.is_nan() || m.is_nan() {
            m = f64::NAN;
        } else if x > m {
            m = x;
        }
    }
    m
}

/// Array.prototype.sort as V8 runs it on short arrays (binary insertion after the first run), so a
/// comparator that is not a strict order puts things where the TypeScript version did
pub fn js_sort_by<T: Clone>(a: &mut Vec<T>, cmp: impl Fn(&T, &T) -> f64) {
    let n = a.len();
    if n < 2 {
        return;
    }
    if n >= 64 {
        a.sort_by(|x, y| cmp(x, y).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
        return;
    }
    // count the first run; a strictly descending one is reversed
    let mut run = 2;
    let descending = cmp(&a[1], &a[0]) < 0.0;
    while run < n {
        let o = cmp(&a[run], &a[run - 1]);
        if descending {
            if !(o < 0.0) {
                break;
            }
        } else if o < 0.0 {
            break;
        }
        run += 1;
    }
    if descending {
        a[..run].reverse();
    }
    for start in run..n {
        let pivot = a[start].clone();
        let (mut left, mut right) = (0, start);
        while left < right {
            let mid = left + ((right - left) >> 1);
            if cmp(&pivot, &a[mid]) < 0.0 {
                right = mid;
            } else {
                left = mid + 1;
            }
        }
        let mut p = start;
        while p > left {
            a[p] = a[p - 1].clone();
            p -= 1;
        }
        a[left] = pivot;
    }
}

fn sorted(xs: &[f64]) -> Vec<f64> {
    let mut s = xs.to_vec();
    js_sort_by(&mut s, |a, b| a - b);
    s
}

pub fn quantile(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let pos = (sorted.len() - 1) as f64 * q;
    let lo = pos.floor() as usize;
    let hi = pos.ceil() as usize;
    sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo as f64)
}

/// mulberry32, as backtest.ts `rng`
pub fn rng(seed: f64) -> impl FnMut() -> f64 {
    let mut a: u32 = (seed as i64) as u32;
    move || {
        a = a.wrapping_add(0x6d2b79f5);
        let mut t = a;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
}

// ---------- the model as a plan ----------

/// endpoint traffic of a dataset, aligned to the model's endpoints
pub fn traffic_of(d: &Dataset, model: &Model) -> Traffic {
    let mut endpoints: Map<Vec<Num>> = Map::new();
    for id in model.endpoints.keys() {
        if let Some(s) = d.endpoints.get(id).and_then(|e| e.rps.as_ref()) {
            endpoints.insert(id.clone(), s.clone());
        }
    }
    if endpoints.is_empty() {
        // no endpoint series: split the entry services' traffic by the model's shares
        for (id, e) in &model.endpoints {
            if let Some(entry) = d.services.get(&e.service).and_then(|s| s.rps.as_ref()) {
                endpoints.insert(id.clone(), entry.iter().map(|v| v.map(|v| v * e.share)).collect());
            }
        }
    }
    Traffic { start: d.start, step_s: d.step_s, n: d.n, endpoints }
}

pub struct Scaled {
    pub traffic: Traffic,
    pub factor: f64,
    pub peak_rps: f64,
}

/// the history at a different load: ×scale, or scaled so its busiest bucket carries peakRps
pub fn scale_traffic(t: &Traffic, scale: Option<f64>, peak_rps: Option<f64>) -> Result<Scaled, String> {
    let mut peak: f64 = 0.0;
    for i in 0..(t.n.max(0.0) as usize) {
        let mut sum = 0.0;
        for s in t.endpoints.values() {
            sum += s.get(i).copied().flatten().unwrap_or(0.0);
        }
        peak = js_max(peak, [sum]);
    }
    let factor = match peak_rps {
        Some(p) => {
            if peak > 0.0 {
                p / peak
            } else {
                1.0
            }
        }
        None => scale.unwrap_or(1.0),
    };
    if !(factor > 0.0) || !factor.is_finite() {
        return Err(format!("traffic: scale must be above 0 (got {})", js_num(factor)));
    }
    let endpoints = t.endpoints.iter().map(|(id, s)| (id.clone(), s.iter().map(|v| v.map(|v| v * factor)).collect())).collect();
    Ok(Scaled { traffic: Traffic { start: t.start, step_s: t.step_s, n: t.n, endpoints }, factor, peak_rps: peak * factor })
}

pub fn observed_replicas(d: &Dataset, model: &Model) -> Map<Option<Vec<Num>>> {
    model
        .services
        .iter()
        .map(|(id, s)| {
            let key = s.hosted_by.as_ref().filter(|h| !h.is_empty()).unwrap_or(id);
            (id.clone(), d.services.get(key).and_then(|x| x.replicas.clone()))
        })
        .collect()
}

/// a plan that reproduces the model as it was (observed replicas, no changes)
pub fn base_plan(model: &Model, observed: Option<&Map<Option<Vec<Num>>>>) -> Plan {
    let mut services = Map::new();
    for (id, s) in &model.services {
        let obs = observed.and_then(|o| o.get(id).cloned().flatten());
        services.insert(
            id.clone(),
            ServicePlan {
                id: id.clone(),
                hosted_by: s.hosted_by.clone(),
                replicas: if obs.is_some() { None } else { Some(s.replicas) },
                observed_replicas: obs,
                autoscale: None,
                per_replica_rps: s.capacity.per_replica_rps,
                overloaded_rps: s.capacity.overloaded_rps,
                servers: s.capacity.servers,
                self_mean: s.self_time.mean,
                self_p99: s.self_time.p99,
                tail: s.tail,
                variability: s.variability,
                load_exponent: s.load_exponent,
                cpu: s.cpu.as_ref().map(|c| Cpu { base: c.base, per_req: c.per_req }),
                cpu_limit: s.cpu_limit,
                memory: s.memory.as_ref().and_then(|m| m.limit.filter(|l| *l != 0.0 && !l.is_nan()).map(|limit| Memory { base: m.base, per_req: m.per_req, spike: m.spike, limit, peak: m.peak, seen_to: m.seen_to, leak: m.leak })),
                requests: s.requests.as_ref().map(|r| Requests { cpu: r.cpu, memory_gb: r.memory_gb }),
                replica_hour: s.cost.per_replica_hour,
                per_request: s.cost.per_request,
                cache: None,
                zone: s.placement.as_ref().and_then(|p| p.zone.clone()),
                region: s.placement.as_ref().and_then(|p| p.region.clone()),
            },
        );
    }
    let mut endpoints = Map::new();
    for (id, e) in &model.endpoints {
        endpoints.insert(
            id.clone(),
            EndpointPlan {
                id: id.clone(),
                service: e.service.clone(),
                visits: e.visits.clone(),
                calls: e.calls.clone(),
                weights: e.weights.clone(),
                overhead_ms: e.overhead_ms,
                base_excess_ms: e.base_excess_ms,
                base_p50_ms: e.base_p50_ms,
                base_p90_ms: e.base_p90_ms,
                tail: e.tail,
                error_rate: e.error_rate,
                error_slope: e.error_slope,
                stalls: e.stalls.as_ref().map(|v| v.iter().map(|x| Stall { service: x.service.clone(), limit: x.limit }).collect()),
                bytes: e.bytes.clone(),
                egress_bytes: e.egress_bytes,
                retries: None,
                timeout_ms: model.timeout_ms,
                slo: Some(e.slo.clone()),
            },
        );
    }
    let cluster = model.cluster.as_ref().map(|c| ClusterPlan {
        node: Node { cpu: c.node.cpu, memory_gb: c.node.memory_gb, per_hour: c.node.per_hour },
        nodes: c.nodes,
        autoscaled: c.autoscaled,
        min_nodes: if c.autoscaled { 1.0 } else { c.nodes },
        max_nodes: if c.autoscaled { (c.max_nodes * 4.0).max(c.max_nodes + 10.0) } else { c.nodes },
        packing: c.packing,
        other: Others { cpu: c.other.cpu, memory_gb: c.other.memory_gb },
        scale_down_s: 600.0,
        provision_s: c.provision_s.unwrap_or(90.0),
    });
    Plan { services, endpoints, cluster, transfer: model.transfer.plan(), unattributed_per_hour: model.unattributed_per_hour, slo: Some(model.slo.clone()) }
}

/// a plan with every capacity drawn from its bootstrap samples (draw 0 = point estimate)
pub fn draw_plan(plan: &Plan, model: &Model, draw: usize, rnd: &mut impl FnMut() -> f64) -> Plan {
    if draw == 0 {
        return plan.clone();
    }
    let mut p = plan.clone();
    for (id, s) in p.services.iter_mut() {
        let m = match model.services.get(id) {
            Some(m) => m,
            None => continue,
        };
        let samples = match &m.capacity.samples {
            Some(x) if !x.is_empty() => x,
            _ => continue,
        };
        if !s.per_replica_rps.is_finite() {
            continue;
        }
        // relative draw keeps strategy changes
        let k = samples[(rnd() * samples.len() as f64).floor() as usize] / m.capacity.per_replica_rps;
        s.per_replica_rps *= k;
    }
    p
}

// ---------- results ----------

#[derive(Serialize, Clone, Debug)]
pub struct Band {
    pub p50: Vec<f64>,
    pub lo: Vec<f64>,
    pub hi: Vec<f64>,
}

#[derive(Serialize, Clone, Copy, Debug)]
pub struct Ranged {
    pub p50: f64,
    pub lo: f64,
    pub hi: f64,
}

#[derive(Clone, Copy, Debug)]
struct Summary {
    cost: f64,
    monthly: f64,
    minutes_out_of_slo: f64,
    failed_requests: f64,
    requests: f64,
    error_budget_used: f64,
    peak_p99_ms: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SummaryOut {
    pub cost: Ranged,
    pub monthly: Ranged,
    pub minutes_out_of_slo: Ranged,
    pub failed_requests: Ranged,
    pub requests: Ranged,
    pub error_budget_used: Ranged,
    pub peak_p99_ms: Ranged,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Delta {
    pub cost: Ranged,
    pub monthly: Ranged,
    pub minutes_out_of_slo: Ranged,
    pub failed_requests: Ranged,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Worst {
    pub t: f64,
    pub p99_ms: f64,
    pub error_rate: f64,
    pub why: String,
    pub service: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EndpointSummary {
    pub requests: f64,
    pub failed_requests: f64,
    pub minutes_out_of_slo: f64,
    pub peak_p99_ms: f64,
    pub cost: f64,
    pub cost_per_million: f64,
    pub slo: Slo,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Incident {
    pub start: f64,
    pub end: f64,
    pub minutes: f64,
    pub peak_p99_ms: f64,
    pub peak_error_rate: f64,
    pub why: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Series {
    pub p99_ms: Band,
    pub error_rate: Band,
    pub cost_per_hour: Band,
    pub cumulative_cost: Band,
    pub error_budget: Band,
    pub replicas: Map<Vec<f64>>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClusterSummary {
    pub peak_nodes: f64,
    pub mean_nodes: f64,
    pub autoscaled: bool,
    pub peak_requested_cpu: f64,
    pub peak_requested_memory_gb: f64,
    pub node_cpu: f64,
    pub node_memory_gb: f64,
    pub node_hour: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StrategyResult {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub notes: Vec<String>,
    pub series: Series,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cluster: Option<ClusterSummary>,
    pub summary: SummaryOut,
    pub delta: Delta,
    pub worst: Worst,
    pub endpoints: Map<EndpointSummary>,
    pub incidents: Vec<Incident>,
    pub events: Vec<Event>,
    pub peak_util: Map<f64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Ranking {
    pub name: String,
    pub monthly_delta: f64,
    pub minutes_out_of_slo_delta: f64,
    pub verdict: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    pub start: f64,
    pub end: f64,
    pub step_s: f64,
    pub n: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Actual {
    pub rps: Vec<Num>,
    pub error_rate: Vec<Num>,
    pub p99_ms: Vec<Num>,
    pub cost_per_hour: Vec<Num>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Load {
    pub factor: f64,
    pub peak_rps: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BacktestResult {
    pub model: String,
    pub window: Window,
    pub slo: Slo,
    pub t: Vec<f64>,
    pub actual: Actual,
    pub baseline: StrategyResult,
    pub strategies: Vec<StrategyResult>,
    pub ranking: Vec<Ranking>,
    pub accuracy: Value,
    pub draws: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load: Option<Load>,
    pub peak_rps: f64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct LoadOpts {
    pub scale: Option<f64>,
    pub peak_rps: Option<f64>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct BacktestOptions {
    pub draws: Option<f64>,
    pub seed: Option<f64>,
    pub observed: Option<bool>,
    pub traffic: Option<Traffic>,
    pub load: Option<LoadOpts>,
    pub faults: Option<Vec<Fault>>,
}

fn range_of(xs: &[f64]) -> Ranged {
    let s = sorted(xs);
    Ranged { p50: quantile(&s, 0.5), lo: quantile(&s, 0.1), hi: quantile(&s, 0.9) }
}

fn band(runs: &[&Vec<f64>]) -> Band {
    let n = runs.first().map(|r| r.len()).unwrap_or(0);
    let (mut p50, mut lo, mut hi) = (Vec::with_capacity(n), Vec::with_capacity(n), Vec::with_capacity(n));
    let mut col = Vec::with_capacity(runs.len());
    for i in 0..n {
        col.clear();
        col.extend(runs.iter().map(|r| r[i]));
        js_sort_by(&mut col, |a, b| a - b);
        p50.push(quantile(&col, 0.5));
        lo.push(quantile(&col, 0.1));
        hi.push(quantile(&col, 0.9));
    }
    Band { p50, lo, hi }
}

fn summarise(r: &RunResult, slo: &Slo, step_s: f64) -> Summary {
    let (mut cost, mut out, mut failed, mut requests) = (0.0, 0.0, 0.0, 0.0);
    for i in 0..r.t.len() {
        cost += r.cost.compute[i] + r.cost.requests[i] + r.cost.transfer[i] + r.cost.other[i];
        if r.rps[i] > 0.0 && (r.p99_ms[i] > slo.p99_ms || r.error_rate[i] > slo.error_rate) {
            out += step_s / 60.0;
        }
        failed += r.rps[i] * r.error_rate[i] * step_s;
        requests += r.rps[i] * step_s;
    }
    let hours = (r.t.len() as f64 * step_s) / 3600.0;
    Summary {
        cost,
        monthly: if hours > 0.0 { (cost / hours) * 730.0 } else { 0.0 },
        minutes_out_of_slo: out,
        failed_requests: failed,
        requests,
        error_budget_used: if requests > 0.0 { failed / (requests * slo.error_rate) } else { 0.0 },
        peak_p99_ms: js_max(0.0, r.p99_ms.iter().copied()),
    }
}

/// which service was the problem at bucket i, in words
pub fn explain_moment(r: &RunResult, plan: &Plan, i: usize) -> (String, Option<String>) {
    // a service down after an OOM kill explains everything behind it
    let mut ooms: Vec<(&String, &ServiceTrace)> = r.services.iter().filter(|(_, s)| s.oom_down.as_ref().and_then(|o| o.get(i)).copied().unwrap_or(0.0) > 0.0).collect();
    js_sort_by(&mut ooms, |a, b| {
        let d = b.1.oom_down.as_ref().unwrap()[i] - a.1.oom_down.as_ref().unwrap()[i];
        if d != 0.0 && !d.is_nan() {
            d
        } else {
            b.1.rps[i] - a.1.rps[i]
        }
    });
    if let Some((id, s)) = ooms.first() {
        let mem = plan.services[*id].memory.as_ref().unwrap();
        let per_rep = s.rps[i] / s.replicas[i].max(1.0);
        if mem.leak > 0.0 {
            return (
                format!(
                    "{} OOM-killed: its memory grows with the requests it serves (a leak, +{} MiB per 1,000) until it passes the {} MiB limit, its pods restarting (CrashLoopBackOff)",
                    id,
                    js_to_fixed(mem.leak * 1024.0 * 1000.0, 1),
                    js_num(js_round(mem.limit * 1024.0))
                ),
                Some((*id).clone()),
            );
        }
        return (
            format!(
                "{} OOM-killed: working set {} MiB per container against a {} MiB limit, its pods restarting (CrashLoopBackOff)",
                id,
                js_num(js_round((mem.base + mem.per_req * per_rep + mem.spike) * 1024.0)),
                js_num(js_round(mem.limit * 1024.0))
            ),
            Some((*id).clone()),
        );
    }
    let mut worst: Option<(&String, f64)> = None;
    for (id, s) in &r.services {
        let score = s.util[i] + s.backlog[i] / plan.services[id].per_replica_rps.max(1.0) + s.wait_ms[i] / 1000.0;
        if worst.is_none() || score > worst.unwrap().1 {
            worst = Some((id, score));
        }
    }
    let id = match worst {
        Some((id, _)) => id,
        None => return ("no services in the model".into(), None),
    };
    let s = &r.services[id];
    let p = &plan.services[id];
    let util = s.util[i];
    let reps = js_round(s.replicas[i] * 10.0) / 10.0;
    if reps == 0.0 && s.rps[i] > 0.0 {
        return (format!("{} has no replica serving ({} req/s refused)", id, js_num(js_round(s.rps[i] * 10.0) / 10.0)), Some(id.clone()));
    }
    if util < 0.5 && s.wait_ms[i] < 50.0 {
        return (format!("no component near its limit (busiest: {} at {}%)", id, js_num(js_round(util * 100.0))), None);
    }
    let per_rep = (if util > 0.0 && s.replicas[i] > 0.0 { s.rps[i] / s.replicas[i] / util } else { p.per_replica_rps }).min(p.per_replica_rps);
    let cap = if per_rep.is_finite() {
        format!("{} × {} req/s{}", js_num(reps), js_to_fixed(per_rep, 1), if per_rep < p.per_replica_rps * 0.95 { format!(" (normally {})", js_to_fixed(p.per_replica_rps, 1)) } else { String::new() })
    } else {
        "unbounded".into()
    };
    let queue = if s.backlog[i] > 0.5 {
        format!(", {} s queue", js_to_fixed(s.wait_ms[i] / 1000.0, 1))
    } else if s.wait_ms[i] > 5.0 {
        format!(", {} ms wait", js_num(js_round(s.wait_ms[i])))
    } else {
        String::new()
    };
    // offered ÷ capacity: utilisation itself is capped once the queue grows
    let load = if per_rep.is_finite() && s.replicas[i] > 0.0 { js_max(util, [s.rps[i] / (s.replicas[i] * per_rep)]) } else { util };
    (format!("{} at {}% of capacity ({} req/s on {}){}", id, js_num(js_round(load * 100.0)), js_to_fixed(s.rps[i], 1), cap, queue), Some(id.clone()))
}

fn incidents(r: &RunResult, plan: &Plan, slo: &Slo, step_s: f64) -> Vec<Incident> {
    let mut out = vec![];
    // start, end, peak p99, peak errors, the worst bucket
    let mut cur: Option<(usize, usize, f64, f64, usize)> = None;
    let flush = |cur: &mut Option<(usize, usize, f64, f64, usize)>, out: &mut Vec<Incident>| {
        if let Some((s, e, p, er, wi)) = cur.take() {
            out.push(Incident { start: r.t[s], end: r.t[e] + step_s, minutes: ((e - s + 1) as f64 * step_s) / 60.0, peak_p99_ms: p, peak_error_rate: er, why: explain_moment(r, plan, wi).0 });
        }
    };
    for i in 0..r.t.len() {
        let bad = r.rps[i] > 0.0 && (r.p99_ms[i] > slo.p99_ms || r.error_rate[i] > slo.error_rate);
        if !bad {
            flush(&mut cur, &mut out);
            continue;
        }
        let c = cur.get_or_insert((i, i, 0.0, 0.0, i));
        c.1 = i;
        if r.p99_ms[i] > c.2 {
            c.2 = r.p99_ms[i];
            c.4 = i;
        }
        c.3 = js_max(c.3, [r.error_rate[i]]);
    }
    flush(&mut cur, &mut out);
    out
}

fn measured(d: &Dataset, model: &Model) -> Actual {
    let ids: Vec<&String> = model.endpoints.keys().filter(|id| d.endpoints.get(*id).map(|e| e.rps.is_some()).unwrap_or(false)).collect();
    let n = d.n.max(0.0) as usize;
    let (mut rps, mut err, mut p99, mut cost) = (vec![], vec![], vec![], vec![]);
    let at = |s: &Option<Vec<Num>>, i: usize| s.as_ref().and_then(|v| v.get(i).copied().flatten());
    for i in 0..n {
        let (mut r, mut e, mut p, mut any) = (0.0, 0.0, 0.0, false);
        for id in &ids {
            let s = &d.endpoints[*id];
            let v = match at(&s.rps, i) {
                Some(v) => v,
                None => continue,
            };
            any = true;
            r += v;
            e += v * at(&s.error_rate, i).unwrap_or(0.0);
            p = js_max(p, [at(&s.p99_ms, i).unwrap_or(0.0)]);
        }
        rps.push(if any { Some(r) } else { None });
        err.push(if any && r > 0.0 { Some(e / r) } else if any { Some(0.0) } else { None });
        p99.push(if any { Some(p) } else { None });
        if let Some(b) = &d.bill {
            let (mut c, mut has) = (0.0, false);
            for comp in b.components.values() {
                if let Some(v) = at(&comp.series, i) {
                    c += v;
                    has = true;
                }
            }
            let unattr = b.unattributed / ((b.end - b.start) / d.step_s).max(1.0);
            cost.push(if has { Some(((c + unattr) * 3600.0) / d.step_s) } else { None });
        } else {
            cost.push(None);
        }
    }
    Actual { rps, error_rate: err, p99_ms: p99, cost_per_hour: cost }
}

/// strategies ordered by time out of SLO (when it differs by more than half a minute), then by cost
pub fn rank_strategies(results: &[StrategyResult]) -> Vec<Ranking> {
    let mut out: Vec<Ranking> = results
        .iter()
        .map(|r| {
            let dm = r.delta.monthly.p50;
            let ds = r.delta.minutes_out_of_slo.p50;
            let verdict = if ds <= 0.5 && dm < 0.0 {
                format!("saves ${}/month with no more time out of SLO", locale_int(js_round(-dm)))
            } else if ds < -0.5 && dm <= 0.0 {
                "cheaper and more reliable".into()
            } else if ds < -0.5 {
                format!("${}/month buys {} fewer minutes out of SLO", locale_int(js_round(dm)), js_num(js_round(-ds)))
            } else if ds > 0.5 && dm < 0.0 {
                format!("saves ${}/month but adds {} minutes out of SLO", locale_int(js_round(-dm)), js_num(js_round(ds)))
            } else if ds > 0.5 {
                "worse on both".into()
            } else {
                format!("costs ${}/month more for the same reliability", locale_int(js_round(dm)))
            };
            Ranking { name: r.name.clone(), monthly_delta: dm, minutes_out_of_slo_delta: ds, verdict }
        })
        .collect();
    js_sort_by(&mut out, |a, b| {
        if a.minutes_out_of_slo_delta - b.minutes_out_of_slo_delta > 0.5 || b.minutes_out_of_slo_delta - a.minutes_out_of_slo_delta > 0.5 {
            a.minutes_out_of_slo_delta - b.minutes_out_of_slo_delta
        } else {
            a.monthly_delta - b.monthly_delta
        }
    });
    out
}

/// replays a batch of plans: on every core natively, one after another in WebAssembly
fn replay_all(plans: &[Plan], traffic: &Traffic, opts: &Opts) -> Vec<RunResult> {
    #[cfg(not(target_arch = "wasm32"))]
    {
        use rayon::prelude::*;
        plans.par_iter().map(|p| run_plan(p, traffic, opts)).collect()
    }
    #[cfg(target_arch = "wasm32")]
    {
        plans.iter().map(|p| run_plan(p, traffic, opts)).collect()
    }
}

pub fn backtest(model: &Model, d: &Dataset, strategies: &[Value], o: &BacktestOptions) -> Result<BacktestResult, String> {
    let draws = o.draws.unwrap_or(30.0).max(1.0) as usize;
    let mut traffic = o.traffic.clone().unwrap_or_else(|| traffic_of(d, model));
    let mut load = None;
    if let Some(l) = &o.load {
        if (l.scale.is_some() || l.peak_rps.is_some()) && !(l.scale == Some(1.0) && l.peak_rps.is_none()) {
            let s = scale_traffic(&traffic, l.scale, l.peak_rps)?;
            traffic = s.traffic;
            load = Some(Load { factor: s.factor, peak_rps: s.peak_rps });
        }
    }
    let observed = if o.observed == Some(false) { None } else { Some(observed_replicas(d, model)) };
    let base = base_plan(model, observed.as_ref());
    let parsed = strategies.iter().map(parse_strategy).collect::<Result<Vec<_>, _>>()?;
    let applied = parsed.iter().map(|s| apply_strategy(model, &base, s).map(|a| (s, a))).collect::<Result<Vec<_>, _>>()?;
    let slo = &model.slo;

    // every draw of every plan (each plan's draws from the same seed, in order), replayed in one batch
    let drawn = |plan: &Plan| {
        let mut rnd = rng(o.seed.unwrap_or(7.0));
        (0..draws).map(|k| draw_plan(plan, model, k, &mut rnd)).collect::<Vec<_>>()
    };
    let mut batch: Vec<Plan> = drawn(&base);
    for (_, a) in &applied {
        batch.extend(drawn(&a.plan));
    }
    let ropts = Opts { substep_s: None, faults: o.faults.clone() };
    let replayed = replay_all(&batch, &traffic, &ropts);
    let runs_of = |k: usize| &replayed[k * draws..(k + 1) * draws];
    let step_s = traffic.step_s;
    let base_sums: Vec<Summary> = runs_of(0).iter().map(|r| summarise(r, slo, step_s)).collect();

    let pack = |name: String, description: Option<String>, notes: Vec<String>, plan: &Plan, runs: &[RunResult]| -> StrategyResult {
        let sums: Vec<Summary> = runs.iter().map(|r| summarise(r, slo, step_s)).collect();
        let point = &runs[0];
        let mut worst_i = 0;
        for i in 0..point.p99_ms.len() {
            if point.p99_ms[i] + point.error_rate[i] * 1e5 > point.p99_ms[worst_i] + point.error_rate[worst_i] * 1e5 {
                worst_i = i;
            }
        }
        let (why, service) = if point.t.is_empty() { ("no services in the model".to_string(), None) } else { explain_moment(point, plan, worst_i) };
        let budget = |r: &RunResult| {
            let (mut failed, mut req) = (0.0, 0.0);
            (0..r.t.len())
                .map(|i| {
                    failed += r.rps[i] * r.error_rate[i] * step_s;
                    req += r.rps[i] * step_s;
                    if req > 0.0 {
                        failed / (req * slo.error_rate)
                    } else {
                        0.0
                    }
                })
                .collect::<Vec<f64>>()
        };
        let mut endpoints = Map::new();
        for (id, e) in &point.endpoints {
            let sl = plan.endpoints.get(id).and_then(|p| p.slo.clone()).unwrap_or_else(|| slo.clone());
            let (mut requests, mut failed, mut out, mut cost) = (0.0, 0.0, 0.0, 0.0);
            for i in 0..e.rps.len() {
                requests += e.rps[i] * step_s;
                failed += e.rps[i] * e.error_rate[i] * step_s;
                cost += e.cost[i];
                if e.rps[i] > 0.0 && (e.p99_ms[i] > sl.p99_ms || e.error_rate[i] > sl.error_rate) {
                    out += step_s / 60.0;
                }
            }
            endpoints.insert(id.clone(), EndpointSummary { requests, failed_requests: failed, minutes_out_of_slo: out, peak_p99_ms: js_max(0.0, e.p99_ms.iter().copied()), cost, cost_per_million: if requests > 0.0 { (cost / requests) * 1e6 } else { 0.0 }, slo: sl });
        }
        let total = |r: &RunResult| -> Vec<f64> {
            let mut s = 0.0;
            (0..r.t.len())
                .map(|i| {
                    s += r.cost.compute[i] + r.cost.requests[i] + r.cost.transfer[i] + r.cost.other[i];
                    s
                })
                .collect()
        };
        let cum: Vec<Vec<f64>> = runs.iter().map(total).collect();
        let budgets: Vec<Vec<f64>> = runs.iter().map(budget).collect();
        let field = |f: fn(&Summary) -> f64| range_of(&sums.iter().map(f).collect::<Vec<_>>());
        let delta = |f: fn(&Summary) -> f64| range_of(&sums.iter().zip(&base_sums).map(|(s, b)| f(s) - f(b)).collect::<Vec<_>>());
        StrategyResult {
            name,
            description,
            notes,
            series: Series {
                p99_ms: band(&runs.iter().map(|r| &r.p99_ms).collect::<Vec<_>>()),
                error_rate: band(&runs.iter().map(|r| &r.error_rate).collect::<Vec<_>>()),
                cost_per_hour: band(&runs.iter().map(|r| &r.cost_per_hour).collect::<Vec<_>>()),
                cumulative_cost: band(&cum.iter().collect::<Vec<_>>()),
                error_budget: band(&budgets.iter().collect::<Vec<_>>()),
                replicas: point.services.iter().filter(|(id, _)| plan.services[*id].hosted_by.as_ref().map(|h| h.is_empty()).unwrap_or(true)).map(|(id, s)| (id.clone(), s.replicas.clone())).collect(),
            },
            cluster: match (&point.cluster, &plan.cluster) {
                (Some(c), Some(pc)) => Some(ClusterSummary {
                    peak_nodes: js_round(js_max(f64::NEG_INFINITY, c.nodes.iter().copied())),
                    mean_nodes: c.nodes.iter().fold(0.0, |a, x| a + x) / (c.nodes.len() as f64).max(1.0),
                    autoscaled: pc.autoscaled,
                    peak_requested_cpu: js_max(f64::NEG_INFINITY, c.requested_cpu.iter().copied()),
                    peak_requested_memory_gb: js_max(f64::NEG_INFINITY, c.requested_memory_gb.iter().copied()),
                    node_cpu: pc.node.cpu,
                    node_memory_gb: pc.node.memory_gb,
                    node_hour: pc.node.per_hour,
                }),
                _ => None,
            },
            summary: SummaryOut {
                cost: field(|s| s.cost),
                monthly: field(|s| s.monthly),
                minutes_out_of_slo: field(|s| s.minutes_out_of_slo),
                failed_requests: field(|s| s.failed_requests),
                requests: field(|s| s.requests),
                error_budget_used: field(|s| s.error_budget_used),
                peak_p99_ms: field(|s| s.peak_p99_ms),
            },
            delta: Delta { cost: delta(|s| s.cost), monthly: delta(|s| s.monthly), minutes_out_of_slo: delta(|s| s.minutes_out_of_slo), failed_requests: delta(|s| s.failed_requests) },
            worst: Worst { t: point.t.get(worst_i).copied().unwrap_or(f64::NAN), p99_ms: point.p99_ms.get(worst_i).copied().unwrap_or(f64::NAN), error_rate: point.error_rate.get(worst_i).copied().unwrap_or(f64::NAN), why, service },
            endpoints,
            incidents: incidents(point, plan, slo, step_s),
            events: point.events.clone(),
            peak_util: point.services.iter().map(|(id, sv)| (id.clone(), js_max(0.0, sv.util.iter().copied().filter(|u| u.is_finite())))).collect(),
        }
    };

    let baseline = pack("As built".into(), Some("the calibrated model with nothing changed".into()), vec![], &base, runs_of(0));
    let results: Vec<StrategyResult> = applied.iter().enumerate().map(|(k, (spec, a))| pack(spec.name.clone(), spec.description.clone(), a.notes.clone(), &a.plan, runs_of(k + 1))).collect();
    let ranking = rank_strategies(&results);
    let peak_rps = scale_traffic(&traffic, Some(1.0), None)?.peak_rps;
    Ok(BacktestResult {
        model: model.name.clone(),
        window: Window { start: traffic.start, end: traffic.start + traffic.n * traffic.step_s, step_s: traffic.step_s, n: traffic.n },
        slo: slo.clone(),
        t: replayed[0].t.clone(),
        actual: measured(d, model),
        baseline,
        strategies: results,
        ranking,
        accuracy: Value::Null,
        draws: draws as f64,
        load,
        peak_rps,
    })
}
