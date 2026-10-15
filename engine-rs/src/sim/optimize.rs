//! Monte Carlo analysis (src/sim/des/analyze.ts) and the cost optimizer (src/sim/optimize.ts): the
//! cheapest configuration of the existing topology that meets the SLO — grow while it misses, shrink
//! wherever capacity isn't needed, verify with the discrete-event engine.

use super::catalog::{runtime, spec};
use super::des::{run_des, DesConfig, DesResult};
use super::headless::{simulate_parsed, SimOptions};
use super::spec::{parse_architecture, parse_scenario, to_value, Architecture};
use crate::backtest::js_sort_by;
use crate::math::{js_num, js_round, js_to_fixed};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map as JMap, Value};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    pub mean: f64,
    pub ci95: f64,
    pub min: f64,
    pub max: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub error_rate: Stat,
    pub peak_error_rate: Stat,
    pub p50_ms: Stat,
    pub p99_ms: Stat,
    pub p999_ms: Stat,
    pub slo_compliance: Stat,
    pub cost_per_hour: Stat,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TopBottleneck {
    pub id: String,
    pub share: f64,
    pub note: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    pub runs: f64,
    pub seeds: Vec<f64>,
    pub architecture: String,
    pub scenario: String,
    pub slo: super::headless::SloOut,
    pub p_slo_met: f64,
    pub metrics: Metrics,
    pub bottlenecks: Vec<TopBottleneck>,
    /// why requests failed, over all runs: where each failure started and the cause (requests per run)
    pub failures: Vec<super::des::FailureCause>,
    pub wall_ms: f64,
    pub events: f64,
}

/// two-sided 95% Student-t critical value
fn t95(df: usize) -> f64 {
    const T: [f64; 20] = [12.71, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086];
    if df < 1 {
        return 0.0;
    }
    if df <= T.len() {
        T[df - 1]
    } else if df < 40 {
        2.04
    } else if df < 120 {
        2.0
    } else {
        1.96
    }
}

fn stat(xs: &[f64], digits: i32) -> Stat {
    let n = xs.len() as f64;
    let mean = xs.iter().fold(0.0, |s, x| s + x) / n;
    let sd = if xs.len() > 1 { (xs.iter().fold(0.0, |s, x| s + (x - mean) * (x - mean)) / (n - 1.0)).sqrt() } else { 0.0 };
    let f = 10f64.powi(digits);
    Stat {
        mean: js_round(mean * f) / f,
        ci95: js_round(t95(xs.len().saturating_sub(1)) * (sd / n.sqrt()) * f) / f,
        min: xs.iter().copied().fold(f64::INFINITY, f64::min),
        max: crate::backtest::js_max(f64::NEG_INFINITY, xs.iter().copied()),
    }
}

pub fn seeds_for(runs: usize, seed0: f64) -> Vec<f64> {
    (0..runs).map(|i| seed0 + i as f64 * 7919.0).collect()
}

/// many runs' summaries → means with 95% confidence intervals, and how often each component was the #1 bottleneck
pub fn aggregate(runs: &[DesResult], wall_ms: f64) -> Analysis {
    let mut top: IndexMap<String, (f64, Option<String>)> = IndexMap::new();
    for r in runs {
        if let Some(b) = r.bottlenecks.first() {
            let e = top.entry(b.id.clone()).or_insert((0.0, b.note.clone()));
            e.0 += 1.0;
        }
    }
    let n = runs.len() as f64;
    let failures = merge_failures(runs.iter().map(|r| r.failures.as_slice()), n);
    let s: Vec<&super::des::DesSummary> = runs.iter().map(|r| &r.summary).collect();
    let mut tops: Vec<(String, (f64, Option<String>))> = top.into_iter().collect();
    js_sort_by(&mut tops, |a, b| b.1 .0 - a.1 .0);
    Analysis {
        runs: n,
        seeds: runs.iter().map(|r| r.seed).collect(),
        architecture: runs[0].architecture.clone(),
        scenario: runs[0].scenario.clone(),
        slo: runs[0].slo.clone(),
        p_slo_met: js_round((s.iter().filter(|x| x.slo_compliance >= 0.99).count() as f64 / n) * 1000.0) / 1000.0,
        metrics: Metrics {
            error_rate: stat(&s.iter().map(|x| x.mean_error_rate).collect::<Vec<_>>(), 4),
            peak_error_rate: stat(&s.iter().map(|x| x.peak_error_rate).collect::<Vec<_>>(), 4),
            p50_ms: stat(&s.iter().map(|x| x.p50_ms).collect::<Vec<_>>(), 1),
            p99_ms: stat(&s.iter().map(|x| x.p99_ms).collect::<Vec<_>>(), 1),
            p999_ms: stat(&s.iter().map(|x| x.p999_ms).collect::<Vec<_>>(), 1),
            slo_compliance: stat(&s.iter().map(|x| x.slo_compliance).collect::<Vec<_>>(), 4),
            cost_per_hour: stat(&s.iter().map(|x| x.mean_cost_per_hour).collect::<Vec<_>>(), 3),
        },
        bottlenecks: tops.into_iter().map(|(id, (k, note))| TopBottleneck { id, share: js_round((k / n) * 100.0) / 100.0, note }).collect(),
        failures,
        wall_ms,
        events: s.iter().fold(0.0, |a, x| a + x.events),
    }
}

/// failure causes of many runs, summed: requests per run, and each cause's share of all failures
pub fn merge_failures<'a>(runs: impl Iterator<Item = &'a [super::des::FailureCause]>, n: f64) -> Vec<super::des::FailureCause> {
    let mut by: IndexMap<(String, &'static str), super::des::FailureCause> = IndexMap::new();
    for fs in runs {
        for f in fs {
            by.entry((f.id.clone(), f.reason)).or_insert_with(|| super::des::FailureCause { requests: 0.0, share: 0.0, ..f.clone() }).requests += f.requests;
        }
    }
    let total: f64 = by.values().map(|f| f.requests).sum();
    let mut out: Vec<super::des::FailureCause> = by
        .into_values()
        .map(|f| super::des::FailureCause { share: if total > 0.0 { js_round(f.requests / total * 1000.0) / 1000.0 } else { 0.0 }, requests: js_round(f.requests / n.max(1.0)), ..f })
        .collect();
    js_sort_by(&mut out, |a, b| b.share - a.share);
    out.truncate(6);
    out
}

/// the discrete-event runs of many seeds: on every core natively, one after another in WebAssembly
pub fn des_runs(a: &Architecture, sc: &super::spec::Scenario, base: &DesConfig, seeds: &[f64]) -> Vec<DesResult> {
    let one = |seed: &f64| run_des(a, sc, &DesConfig { seed: *seed, ..base.clone() });
    #[cfg(not(target_arch = "wasm32"))]
    {
        use rayon::prelude::*;
        seeds.par_iter().map(one).collect()
    }
    #[cfg(target_arch = "wasm32")]
    {
        seeds.iter().map(one).collect()
    }
}

fn now_ms() -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        js_sys::Date::now()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
    }
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeOptions {
    pub runs: Option<f64>,
    pub seed: Option<f64>,
    pub des: Option<Value>,
}

fn des_config(v: Option<&Value>) -> DesConfig {
    v.and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default()
}

pub fn analyze_parsed(a: &Architecture, sc: &super::spec::Scenario, o: &AnalyzeOptions) -> Analysis {
    let t0 = now_ms();
    let seeds = seeds_for(o.runs.unwrap_or(20.0) as usize, o.seed.unwrap_or(1.0));
    let runs = des_runs(a, sc, &des_config(o.des.as_ref()), &seeds);
    aggregate(&runs, js_round(now_ms() - t0))
}

pub fn analyze(spec: &Value, scenario: &Value, o: &AnalyzeOptions) -> Result<Analysis, String> {
    Ok(analyze_parsed(&parse_architecture(spec)?, &parse_scenario(scenario)?, o))
}

// ---------- the optimizer ----------

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct OptimizeOptions {
    pub slo: Option<Value>,
    pub allow_runtimes: Option<bool>,
    pub max_instances: Option<f64>,
    pub verify_runs: Option<f64>,
    pub max_iterations: Option<f64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Side {
    pub cost_per_hour: f64,
    pub monthly: f64,
    pub slo_compliance: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OptimizeResult {
    pub feasible: bool,
    pub before: Side,
    pub after: Side,
    pub monthly_savings: f64,
    pub changes: Vec<Value>,
    pub spec: Value,
    pub log: Vec<String>,
    pub verification: Option<Analysis>,
    pub evaluations: f64,
}

const TIERS: [&str; 3] = ["S", "M", "L"];
const RUNTIMES: [&str; 5] = ["node", "python", "java", "go", "rust"];

struct Eval {
    ok: bool,
    compliance: f64,
    err: f64,
    p99: f64,
    cost: f64,
    hot: Vec<String>,
}

#[derive(Clone)]
enum Move {
    InstancesUp,
    TierUp,
    Runtime(&'static str),
    InstancesDown,
    TierDown,
}

fn label(m: &Move) -> String {
    match m {
        Move::InstancesUp => "instances+".into(),
        Move::TierUp => "tier up".into(),
        Move::Runtime(r) => format!("runtime {}", r),
        Move::InstancesDown => "instances−1".into(),
        Move::TierDown => "tier down".into(),
    }
}

fn get_num(c: &JMap<String, Value>, k: &str, d: f64) -> f64 {
    c.get(k).and_then(|x| x.as_f64()).unwrap_or(d)
}
fn get_str<'a>(c: &'a JMap<String, Value>, k: &str, d: &'a str) -> &'a str {
    c.get(k).and_then(|x| x.as_str()).unwrap_or(d)
}

pub fn optimize(spec_in: &Value, scenario: &Value, o: &OptimizeOptions) -> Result<OptimizeResult, String> {
    let base = parse_architecture(spec_in)?;
    let slo = (o.slo.as_ref().and_then(|s| s.get("maxErrorRate")).and_then(|x| x.as_f64()).unwrap_or(0.01), o.slo.as_ref().and_then(|s| s.get("maxP99Ms")).and_then(|x| x.as_f64()).unwrap_or(300.0));
    let mut sc_v = scenario.clone();
    if !sc_v.is_object() {
        sc_v = json!({});
    }
    sc_v["slo"] = json!({ "maxErrorRate": slo.0, "maxP99Ms": slo.1 });
    let sc = parse_scenario(&sc_v)?;
    let max_inst = o.max_instances.unwrap_or(64.0);
    let allow_rt = o.allow_runtimes == Some(true);
    let mut log: Vec<String> = vec![];
    let mut evaluations = 0.0;
    let so = SimOptions { dt: None, sample_every: Some(1.0), cfg: None, answers: None };

    let mut evaluate = |a: &Architecture| -> Eval {
        evaluations += 1.0;
        let r = simulate_parsed(a, &sc, &so);
        let mut hot: Vec<(&String, &super::headless::ComponentReport)> = r.components.iter().filter(|(_, c)| c.peak_util >= 0.6 || c.dropped_total > 0.0 || c.final_status == "down").collect();
        js_sort_by(&mut hot, |a, b| b.1.peak_util - a.1.peak_util);
        Eval { ok: r.summary.slo_compliance >= 0.99, compliance: r.summary.slo_compliance, err: r.summary.mean_error_rate, p99: r.summary.mean_p99_ms, cost: r.summary.mean_cost_per_hour, hot: hot.iter().map(|(id, _)| (*id).clone()).collect() }
    };
    let quality = |e: &Eval| e.compliance * 1000.0 - e.err * 100.0 - e.p99.min(10_000.0) / 1000.0;

    let grow_moves = |c: &JMap<String, Value>| -> Vec<Move> {
        let kind = get_str(c, "kind", "server");
        let sp = spec(kind);
        let mut m = vec![];
        if sp.scalable {
            m.push(Move::InstancesUp);
        }
        if sp.tiered {
            m.push(Move::TierUp);
        }
        if allow_rt && matches!(kind, "server" | "worker" | "function") {
            for r in RUNTIMES {
                m.push(Move::Runtime(r));
            }
        }
        m
    };
    let shrink_moves = |c: &JMap<String, Value>| -> Vec<Move> {
        let kind = get_str(c, "kind", "server");
        let mut m = vec![];
        if spec(kind).scalable && get_num(c, "instances", 1.0) > 1.0 {
            m.push(Move::InstancesDown);
        }
        if spec(kind).tiered && get_str(c, "tier", "S") != "S" {
            m.push(Move::TierDown);
        }
        m
    };
    let apply = |x: &mut JMap<String, Value>, mv: &Move| -> bool {
        match mv {
            Move::InstancesUp => {
                let n = get_num(x, "instances", 1.0);
                if n >= max_inst {
                    return false;
                }
                x.insert("instances".into(), json!(max_inst.min(n + js_round(n * 0.15).max(1.0))));
                true
            }
            Move::TierUp => {
                let i = TIERS.iter().position(|t| *t == get_str(x, "tier", "S")).unwrap_or(0);
                if i >= TIERS.len() - 1 {
                    return false;
                }
                x.insert("tier".into(), json!(TIERS[i + 1]));
                true
            }
            Move::Runtime(r) => {
                let cur = runtime(get_str(x, "runtime", "node")).0;
                if runtime(r).0 <= cur {
                    return false;
                }
                x.insert("runtime".into(), json!(r));
                true
            }
            Move::InstancesDown => {
                let n = get_num(x, "instances", 1.0);
                x.insert("instances".into(), json!(n - 1.0));
                true
            }
            Move::TierDown => {
                let i = TIERS.iter().position(|t| *t == get_str(x, "tier", "S")).unwrap_or(0);
                x.insert("tier".into(), json!(TIERS[i.saturating_sub(1)]));
                true
            }
        }
    };
    let id_of = |c: &JMap<String, Value>| c.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let try_move = |s: &Architecture, id: &str, mv: &Move| -> Option<Architecture> {
        let mut next = s.clone();
        let c = next.components.iter_mut().find(|x| x.get("id").and_then(|v| v.as_str()) == Some(id))?;
        if apply(c, mv) {
            Some(next)
        } else {
            None
        }
    };
    let mutable = |s: &Architecture| -> Vec<JMap<String, Value>> { s.components.iter().filter(|c| get_str(c, "kind", "") != "client" && !grow_moves(c).is_empty()).cloned().collect() };

    let start = evaluate(&base);
    let mut cur = base.clone();
    let (start_ok, start_cost, start_compliance) = (start.ok, start.cost, start.compliance);
    let mut cur_e = start;
    log.push(format!("start: {} SLO ({}% of the time), ${}/h", if start_ok { "meets" } else { "misses" }, js_num(js_round(start_compliance * 100.0)), js_to_fixed(start_cost, 2)));

    // ---- grow ----
    let mut it = 0.0;
    while !cur_e.ok && it < o.max_iterations.unwrap_or(60.0) {
        let focus: Vec<JMap<String, Value>> = if !cur_e.hot.is_empty() { cur.components.iter().filter(|c| cur_e.hot.contains(&id_of(c))).cloned().collect() } else { mutable(&cur) };
        let pool = if focus.is_empty() { mutable(&cur) } else { focus };
        let mut best: Option<(Architecture, Eval, String, f64)> = None;
        for c in &pool {
            for mv in grow_moves(c) {
                let s = match try_move(&cur, &id_of(c), &mv) {
                    Some(s) => s,
                    None => continue,
                };
                let e = evaluate(&s);
                let gain = quality(&e) - quality(&cur_e);
                if gain <= 0.0 {
                    continue;
                }
                let value = gain / (e.cost - cur_e.cost).max(0.005);
                if best.as_ref().map(|b| value > b.3).unwrap_or(true) {
                    best = Some((s, e, format!("{}: {}", id_of(c), label(&mv)), value));
                }
            }
        }
        match best {
            None => {
                log.push("grow: no single change improves the SLO — the topology itself is the limit".into());
                // the most common structural blocker: instances nobody can reach
                let kind_of = |id: &str| cur.components.iter().find(|x| x.get("id").and_then(|v| v.as_str()) == Some(id)).map(|x| get_str(x, "kind", "").to_string()).unwrap_or_default();
                let fed: Vec<String> = cur.connections.iter().filter(|(a, _, _)| ["lb", "gateway", "queue", "stream"].contains(&kind_of(a).as_str())).map(|(_, b, _)| b.clone()).collect();
                for id in &cur_e.hot {
                    if let Some(c) = cur.components.iter().find(|x| x.get("id").and_then(|v| v.as_str()) == Some(id.as_str())) {
                        if spec(get_str(c, "kind", "")).scalable && !fed.contains(id) {
                            log.push(format!("hint: put a load balancer in front of \"{}\" — without one, extra instances receive no traffic", id));
                        }
                    }
                }
                break;
            }
            Some((s, e, l, _)) => {
                cur = s;
                cur_e = e;
                log.push(format!("grow: {} → {}% in SLO, ${}/h", l, js_num(js_round(cur_e.compliance * 100.0)), js_to_fixed(cur_e.cost, 2)));
            }
        }
        it += 1.0;
    }

    // ---- shrink ----
    if cur_e.ok {
        let mut improved = true;
        while improved {
            improved = false;
            let ids: Vec<String> = cur.components.iter().map(|c| id_of(c)).collect();
            for id in ids {
                let c = match cur.components.iter().find(|x| x.get("id").and_then(|v| v.as_str()) == Some(id.as_str())) {
                    Some(c) => c.clone(),
                    None => continue,
                };
                for mv in shrink_moves(&c) {
                    let s = match try_move(&cur, &id, &mv) {
                        Some(s) => s,
                        None => continue,
                    };
                    let e = evaluate(&s);
                    if e.ok && e.cost < cur_e.cost - 1e-6 {
                        cur = s;
                        cur_e = e;
                        improved = true;
                        log.push(format!("shrink: {}: {} → ${}/h", id, label(&mv), js_to_fixed(cur_e.cost, 2)));
                        break;
                    }
                }
            }
        }
    }

    // ---- diff ----
    let mut changes = vec![];
    for c in &cur.components {
        let id = id_of(c);
        let o0 = base.components.iter().find(|x| x.get("id").and_then(|v| v.as_str()) == Some(id.as_str())).unwrap();
        let mut fields = JMap::new();
        if get_num(c, "instances", 1.0) != get_num(o0, "instances", 1.0) {
            fields.insert("instances".into(), c.get("instances").cloned().unwrap_or(Value::Null));
        }
        if get_str(c, "tier", "S") != get_str(o0, "tier", "S") {
            fields.insert("tier".into(), c.get("tier").cloned().unwrap_or(Value::Null));
        }
        if c.get("runtime") != o0.get("runtime") {
            fields.insert("runtime".into(), c.get("runtime").cloned().unwrap_or(Value::Null));
        }
        if !fields.is_empty() {
            changes.push(json!({ "op": "set", "id": id, "fields": Value::Object(fields) }));
        }
    }

    let verify_runs = o.verify_runs.unwrap_or(10.0);
    let verification = if cur_e.ok && verify_runs > 0.0 { Some(analyze_parsed(&cur, &sc, &AnalyzeOptions { runs: Some(verify_runs), seed: None, des: None })) } else { None };
    if let Some(v) = &verification {
        log.push(format!("verify (discrete-event, {} runs): SLO met in {}% of runs, p99 {}±{}ms", js_num(v.runs), js_num(js_round(v.p_slo_met * 100.0)), js_num(v.metrics.p99_ms.mean), js_num(v.metrics.p99_ms.ci95)));
    }
    Ok(OptimizeResult {
        feasible: cur_e.ok,
        before: Side { cost_per_hour: start_cost, monthly: js_round(start_cost * 730.0), slo_compliance: start_compliance },
        after: Side { cost_per_hour: cur_e.cost, monthly: js_round(cur_e.cost * 730.0), slo_compliance: cur_e.compliance },
        monthly_savings: js_round((start_cost - cur_e.cost) * 730.0),
        changes,
        spec: to_value(&cur),
        log,
        verification,
        evaluations,
    })
}
