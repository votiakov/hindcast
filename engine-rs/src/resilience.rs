//! Losing a Kubernetes node at the worst moment (src/backtest/resilience.ts), and famous public outages
//! as replayable datasets (src/backtest/outages.ts).

use crate::accuracy::parse_iso_ms;
use crate::backtest::{backtest, base_plan, js_sort_by, scale_traffic, traffic_of, BacktestOptions, BacktestResult, LoadOpts};
use crate::dataset::{Dataset, EndpointSeries};
use crate::math::{js_num, js_round};
use crate::model::Model;
use crate::strategy::{apply_strategy, parse_strategy, Change};
use crate::types::{Fault, Map, Num};
use indexmap::IndexSet;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const RECOVER_S: f64 = 50.0 + 300.0 + 30.0;

/// how long a caller's gRPC channel stayed broken after its callee was back, on the reference cluster
/// (reference/k8s, run `normal-nodeloss`): the node stopped, cart's replacement pod was ready 348 s
/// later, and the frontend's calls to it kept failing until the frontend restarted at 600 s. One
/// observation on one kind cluster, stated as an assumption for the node-loss sensitivity — not a fit
pub const REFERENCE_RECONNECT_S: f64 = 600.0 - 348.0;

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct NodeLossOptions {
    pub recover_s: Option<f64>,
    pub strategy: Option<Value>,
    pub load: Option<LoadOpts>,
    pub draws: Option<f64>,
    pub gate_minutes: Option<f64>,
    pub pods: Option<Map<Map<f64>>>,
    pub nodes: Option<Vec<String>>,
    pub at_s: Option<f64>,
    pub zones: Option<bool>,
    /// calls made over gRPC (caller, callee), as collection found them (model provenance.grpc.calls):
    /// where a lost service is called this way, a sensitivity reruns with the caller's calls to it
    /// still failing `reconnect_s` after it is back
    pub grpc_calls: Option<Vec<(String, String)>>,
    /// that sensitivity's time (default REFERENCE_RECONNECT_S)
    pub reconnect_s: Option<f64>,
}

/// the answer again, if callers' connections to the lost services stay broken after they are back
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StuckCallers {
    /// how long each caller's calls kept failing after its callee was back, s
    pub reconnect_s: f64,
    /// (caller, callee) over gRPC, the callee one the node took with it
    pub calls: Vec<(String, String)>,
    pub verdict: String,
    pub minutes_out_of_slo: f64,
    pub failed_requests: f64,
    /// the history ends before the callers would have reconnected: the rest is not counted
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub cut_short: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Lost {
    pub service: String,
    pub pods: f64,
    pub of: f64,
    pub down: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub minutes_out_of_slo: f64,
    pub failed_requests: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NodeLossResult {
    pub node: String,
    pub lost: Vec<Lost>,
    pub verdict: String,
    pub minutes_out_of_slo: f64,
    pub failed_requests: f64,
    pub worst: String,
    pub recovered: bool,
    pub total: Totals,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub if_callers_stay_broken: Option<StuckCallers>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SinglePoint {
    pub service: String,
    pub replicas: f64,
    pub node: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NodeLossReport {
    pub at: f64,
    pub peak_rps: f64,
    pub recover_s: Option<f64>,
    pub nodes: f64,
    pub survives: bool,
    pub results: Vec<NodeLossResult>,
    pub single_points_of_failure: Vec<SinglePoint>,
    pub notes: Vec<String>,
}

fn sum(p: &Map<f64>) -> f64 {
    p.values().fold(0.0, |a, x| a + x)
}

/// pods per node per service: as collected, or for a strategy's new replica counts spread evenly
pub fn pods_per_node(model: &Model, strategy: Option<&Value>) -> Result<Map<Map<f64>>, String> {
    let mut out: Map<Map<f64>> = Map::new();
    for (id, s) in &model.services {
        if let (Some(p), None) = (&s.pods, &s.hosted_by) {
            out.insert(id.clone(), p.clone());
        }
    }
    let strategy = match strategy {
        Some(s) if !s.is_null() => s,
        _ => return Ok(out),
    };
    let spec = parse_strategy(strategy)?;
    let mut nodes: Vec<String> = out.values().flat_map(|p| p.keys().cloned()).collect::<IndexSet<_>>().into_iter().collect();
    js_sort_by(&mut nodes, |a, b| if a < b { -1.0 } else if a > b { 1.0 } else { 0.0 });
    for ch in &spec.changes {
        let ch = match ch {
            Change::Service(c) => c,
            _ => continue,
        };
        let now = match out.get(&ch.service) {
            Some(p) => sum(p),
            None => continue,
        };
        let r = match (ch.replicas, &ch.autoscale, ch.spread) {
            (Some(r), _, _) => r,
            (None, Some(a), _) => a.min,
            (None, None, true) => now,
            _ => continue,
        };
        // the default scheduler spreads a Deployment's pods and balances the nodes: each replica goes to
        // the node with the fewest of this service, then the fewest pods overall
        out.shift_remove(&ch.service);
        let mut load: Map<f64> = nodes.iter().map(|n| (n.clone(), 0.0)).collect();
        for q in out.values() {
            for (n, k) in q {
                *load.entry(n.clone()).or_insert(0.0) += k;
            }
        }
        let mut p: Map<f64> = Map::new();
        let mut k = 0.0;
        while k < r {
            let mut order = nodes.clone();
            js_sort_by(&mut order, |a, b| {
                let d = p.get(a).copied().unwrap_or(0.0) - p.get(b).copied().unwrap_or(0.0);
                if d != 0.0 {
                    return d;
                }
                let d = load[a] - load[b];
                if d != 0.0 {
                    return d;
                }
                if a < b {
                    -1.0
                } else if a > b {
                    1.0
                } else {
                    0.0
                }
            });
            let n = order[0].clone();
            *p.entry(n.clone()).or_insert(0.0) += 1.0;
            *load.get_mut(&n).unwrap() += 1.0;
            k += 1.0;
        }
        out.insert(ch.service.clone(), p);
    }
    Ok(out)
}

/// every pod's requests with the services at their typical replica counts, or the strategy's
fn requested(model: &Model, other_cpu: f64, other_mem: f64, strategy: Option<&Value>) -> Result<(f64, f64), String> {
    let base = base_plan(model, None);
    let plan = match strategy {
        Some(s) if !s.is_null() => apply_strategy(model, &base, &parse_strategy(s)?)?.plan,
        _ => base,
    };
    let (mut cpu, mut mem) = (other_cpu, other_mem);
    for (id, s) in &plan.services {
        if let (Some(r), None) = (&s.requests, &s.hosted_by) {
            let n = s.replicas.or(s.autoscale.as_ref().map(|a| a.min)).unwrap_or(model.services[id].replicas);
            cpu += n * r.cpu;
            mem += n * r.memory_gb;
        }
    }
    Ok((cpu, mem))
}

fn busiest(d: &Dataset, model: &Model, load: Option<&LoadOpts>) -> Result<(crate::types::Traffic, f64, usize), String> {
    let mut traffic = traffic_of(d, model);
    if let Some(l) = load {
        traffic = scale_traffic(&traffic, l.scale, l.peak_rps)?.traffic;
    }
    let (mut peak, mut at) = (0.0, 0usize);
    for i in 0..traffic.n.max(0.0) as usize {
        let t = traffic.endpoints.values().fold(0.0, |a, s| a + s.get(i).copied().flatten().unwrap_or(0.0));
        if t > peak {
            peak = t;
            at = i;
        }
    }
    Ok((traffic, peak, at))
}

pub fn node_loss(model: &Model, d: &Dataset, o: &NodeLossOptions) -> Result<NodeLossReport, String> {
    let mut spread: Map<Map<f64>> = match &o.pods {
        Some(p) => p.iter().filter(|(id, _)| model.services.get(*id).map(|s| s.hosted_by.is_none()).unwrap_or(false)).map(|(k, v)| (k.clone(), v.clone())).collect(),
        None => pods_per_node(model, o.strategy.as_ref())?,
    };
    let c = model.cluster.as_ref();
    let zones_on = o.zones == Some(true);
    if zones_on {
        // a zone is one big node: every pod in it goes at once
        let zone_of = c.and_then(|c| c.zones.clone()).unwrap_or_default();
        if zone_of.is_empty() {
            return Err("the nodes have no zones (they come from kube_node_info provider ids on AWS and GCP): check single nodes instead".into());
        }
        spread = spread
            .into_iter()
            .map(|(id, p)| {
                let mut acc: Map<f64> = Map::new();
                for (n, k) in p {
                    *acc.entry(zone_of.get(&n).cloned().unwrap_or(n)).or_insert(0.0) += k;
                }
                (id, acc)
            })
            .collect();
    }
    let mut nodes: Vec<String> = match &o.nodes {
        Some(n) => n.clone(),
        None => spread.values().flat_map(|p| p.keys().cloned()).collect::<IndexSet<_>>().into_iter().collect(),
    };
    js_sort_by(&mut nodes, |a, b| if a < b { -1.0 } else if a > b { 1.0 } else { 0.0 });
    if nodes.is_empty() {
        return Err("no pod placement in the model: collect from a Kubernetes cluster (kube-state-metrics kube_pod_info) to check node loss".into());
    }
    let (traffic, peak, at) = busiest(d, model, o.load.as_ref())?;
    let start = o.at_s.unwrap_or((at as f64 * traffic.step_s - 60.0).max(0.0));
    let want = match c {
        Some(c) => Some(requested(model, c.other.cpu, c.other.memory_gb, o.strategy.as_ref())?),
        None => None,
    };
    let nodes_in = |unit: &str| -> f64 {
        if zones_on {
            let k = c.and_then(|c| c.zones.as_ref()).map(|z| z.values().filter(|x| *x == unit).count()).unwrap_or(0);
            if k == 0 {
                1.0
            } else {
                k as f64
            }
        } else {
            1.0
        }
    };
    let roomless_for = |unit: &str| -> bool {
        match (c, want) {
            (Some(c), Some((cpu, mem))) if !c.autoscaled => cpu > (c.nodes - nodes_in(unit)) * c.node.cpu || mem > (c.nodes - nodes_in(unit)) * c.node.memory_gb,
            _ => false,
        }
    };
    let roomless = nodes.iter().any(|n| roomless_for(n));
    let recover_s = o.recover_s.unwrap_or(RECOVER_S);
    let strategies: Vec<Value> = o.strategy.iter().filter(|s| !s.is_null()).cloned().collect();
    let draws = o.draws.unwrap_or(8.0);
    let gate = o.gate_minutes.unwrap_or(0.5);
    let bopts = |faults: Option<Vec<Fault>>| BacktestOptions { draws: Some(draws), seed: Some(11.0), observed: None, traffic: Some(traffic.clone()), load: None, faults };
    let base = backtest(model, d, &strategies, &bopts(None))?;
    let pick = |r: &BacktestResult| if strategies.is_empty() { r.baseline.clone() } else { r.strategies[0].clone() };
    let reference = pick(&base);
    let mut results = vec![];
    for node in &nodes {
        let lost: Vec<Lost> = spread
            .iter()
            .filter(|(_, p)| p.get(node).copied().unwrap_or(0.0) > 0.0)
            .map(|(service, p)| {
                let of = sum(p);
                Lost { service: service.clone(), pods: p[node], of, down: p[node] >= of }
            })
            .collect();
        let until = if roomless_for(node) { None } else { Some(start + recover_s) };
        let faults: Vec<Fault> = lost
            .iter()
            .map(|l| Fault {
                at: start,
                until,
                service: l.service.clone(),
                capacity: None,
                down: if l.down { Some(true) } else { None },
                extra_ms: None,
                error_rate: None,
                no_scale_out: None,
                warmup_factor: None,
                replicas_lost: if l.down { None } else { Some(l.pods) },
                caller: None,
                note: Some(format!("{} lost: {} {}", node, l.service, if l.down { "has no replica left".to_string() } else { format!("down to {} of {} replicas", js_num(l.of - l.pods), js_num(l.of)) })),
            })
            .collect();
        // gRPC callers of what the node took, that themselves kept a replica: their channels can stay
        // broken after the replacements are up
        // (only where the replacements are up before the history ends: after it there is nothing to replay)
        let end = traffic.n * traffic.step_s;
        let stuck: Vec<(String, String)> = match (until.filter(|u| *u < end), &o.grpc_calls) {
            (Some(_), Some(calls)) => {
                let down = |x: &str| lost.iter().any(|l| l.down && l.service == x);
                let mut v: Vec<(String, String)> = vec![];
                for (a, b) in calls {
                    if a != b && down(b) && !down(a) && model.services.contains_key(a) && !v.contains(&(a.clone(), b.clone())) {
                        v.push((a.clone(), b.clone()));
                    }
                }
                v
            }
            _ => vec![],
        };
        let reconnect_s = o.reconnect_s.unwrap_or(REFERENCE_RECONNECT_S);
        let stuck_faults: Vec<Fault> = stuck
            .iter()
            .map(|(a, b)| Fault {
                at: until.unwrap_or(start),
                until: until.map(|u| u + reconnect_s),
                service: b.clone(),
                capacity: None,
                down: None,
                extra_ms: None,
                error_rate: Some(1.0),
                no_scale_out: None,
                warmup_factor: None,
                replicas_lost: None,
                note: Some(format!("{}'s channel to {} still broken after it is back", a, b)),
                caller: Some(a.clone()),
            })
            .collect();
        let all_faults: Vec<Fault> = faults.iter().cloned().chain(stuck_faults).collect();
        let r = backtest(model, d, &strategies, &bopts(Some(faults)))?;
        let s = pick(&r);
        let added = s.summary.minutes_out_of_slo.p50 - reference.summary.minutes_out_of_slo.p50;
        // minutes can't grow where the history was already out of SLO: then the requests the loss
        // fails decide, against what the error budget allows over the outage at the peak's rate
        let added_failed = s.summary.failed_requests.p50 - reference.summary.failed_requests.p50;
        let allowed = (peak * until.map(|u| u - start).unwrap_or(recover_s) * model.slo.error_rate).max(1.0);
        let if_stuck = if stuck.is_empty() {
            None
        } else {
            let r2 = backtest(model, d, &strategies, &bopts(Some(all_faults)))?;
            let s2 = pick(&r2);
            let added2 = s2.summary.minutes_out_of_slo.p50 - reference.summary.minutes_out_of_slo.p50;
            let failed2 = s2.summary.failed_requests.p50 - reference.summary.failed_requests.p50;
            let allowed2 = (peak * (until.map(|u| u - start).unwrap_or(recover_s) + reconnect_s) * model.slo.error_rate).max(1.0);
            Some(StuckCallers {
                reconnect_s,
                calls: stuck.clone(),
                verdict: if added2 > gate || failed2 > allowed2 { "fails".into() } else { "survives".into() },
                minutes_out_of_slo: js_round(added2 * 10.0) / 10.0,
                failed_requests: js_round(failed2),
                cut_short: until.map(|u| u + reconnect_s > end).unwrap_or(false),
            })
        };
        results.push(NodeLossResult {
            node: node.clone(),
            lost,
            verdict: if added > gate || added_failed > allowed { "fails".into() } else { "survives".into() },
            minutes_out_of_slo: js_round(added * 10.0) / 10.0,
            failed_requests: js_round(s.summary.failed_requests.p50 - reference.summary.failed_requests.p50),
            worst: s.worst.why.clone(),
            recovered: !roomless_for(node),
            total: Totals { minutes_out_of_slo: js_round(s.summary.minutes_out_of_slo.p50 * 10.0) / 10.0, failed_requests: js_round(s.summary.failed_requests.p50) },
            if_callers_stay_broken: if_stuck,
        });
    }
    js_sort_by(&mut results, |a, b| {
        let d = b.minutes_out_of_slo - a.minutes_out_of_slo;
        if d != 0.0 && !d.is_nan() {
            d
        } else {
            b.failed_requests - a.failed_requests
        }
    });
    // services one node failure takes out entirely
    let spof: Vec<SinglePoint> = spread.iter().filter(|(_, p)| p.len() == 1).map(|(service, p)| SinglePoint { service: service.clone(), replicas: *p.values().next().unwrap(), node: p.keys().next().unwrap().clone() }).collect();
    let mut notes = vec![if roomless {
        format!("the node pool is fixed and losing {} leaves no room for its pods: they stay Pending until it returns", nodes.iter().filter(|n| roomless_for(n)).cloned().collect::<Vec<_>>().join(", "))
    } else {
        format!("pods come back {} min after the node goes (NotReady after ~50 s, the default 300 s eviction toleration, a start)", js_num(js_round(recover_s / 60.0)))
    }];
    notes.push("that is when the platform has recovered; callers can stay broken longer. Reconnect backoff (gRPC waits up to 2 min between attempts) and channels that never reconnect are not in the replay. On the reference cluster a stopped node cost 10.5 min against 7 predicted, because the frontend's channel to cart stayed broken until it restarted".into());
    if let Some(x) = results.iter().find_map(|r| r.if_callers_stay_broken.as_ref()) {
        notes.push(stuck_note(x.reconnect_s));
    }
    if !strategies.is_empty() {
        notes.push("replica counts the strategy changes are spread evenly over the nodes, as the default scheduler does".into());
    }
    Ok(NodeLossReport {
        at: traffic.start + start,
        peak_rps: js_round(peak * 10.0) / 10.0,
        recover_s: if roomless { None } else { Some(recover_s) },
        nodes: nodes.len() as f64,
        survives: results.iter().all(|x| x.verdict == "survives"),
        results,
        single_points_of_failure: spof,
        notes,
    })
}

/// what the sensitivity assumed, and where the number comes from
pub fn stuck_note(reconnect_s: f64) -> String {
    if reconnect_s == REFERENCE_RECONNECT_S {
        format!(
            "ifCallersStayBroken: the same loss, with every gRPC caller of a service the node took failing its calls to it for {} s more after the replacement is up. That is how long the frontend's channel to cart stayed broken on the reference cluster (cart ready 348 s after its node stopped, the frontend's calls failing until it restarted at 600 s): one observation on one kind cluster, an assumption rather than a fit. The main answer leaves it out",
            js_num(reconnect_s)
        )
    } else {
        format!("ifCallersStayBroken: the same loss, with every gRPC caller of a service the node took failing its calls to it for {} s more after the replacement is up — an assumption; the main answer leaves it out", js_num(reconnect_s))
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NodeLossFaults {
    pub faults: Vec<FaultOut>,
    pub lost: Vec<Lost>,
    pub at_s: f64,
    pub at: f64,
    pub recover_s: Option<f64>,
    pub peak_rps: f64,
}

/// a fault as JavaScript holds it (only the fields that are set)
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FaultOut {
    pub service: String,
    pub at: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub down: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replicas_lost: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capacity: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_rate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_scale_out: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warmup_factor: Option<f64>,
    pub note: String,
}

impl FaultOut {
    pub fn fault(&self) -> Fault {
        Fault { at: self.at, until: self.until, service: self.service.clone(), capacity: self.capacity, down: self.down, extra_ms: self.extra_ms, error_rate: self.error_rate, no_scale_out: self.no_scale_out, warmup_factor: self.warmup_factor, replicas_lost: self.replicas_lost, note: Some(self.note.clone()), caller: None }
    }
}

/// the faults one node's loss puts on a history (recover_s: Some(None) never comes back)
pub fn node_loss_faults(model: &Model, d: &Dataset, node: &str, at_s: Option<f64>, recover_s: Option<Option<f64>>, pods: Option<&Map<Map<f64>>>) -> Result<NodeLossFaults, String> {
    let spread = match pods {
        Some(p) => p.clone(),
        None => pods_per_node(model, None)?,
    };
    let (traffic, peak, at) = busiest(d, model, None)?;
    let start = at_s.unwrap_or((at as f64 * traffic.step_s - 60.0).max(0.0));
    let recover = recover_s.unwrap_or(Some(RECOVER_S));
    let lost: Vec<Lost> = spread
        .iter()
        .filter(|(id, p)| p.get(node).copied().unwrap_or(0.0) > 0.0 && model.services.get(*id).map(|s| s.hosted_by.is_none()).unwrap_or(false))
        .map(|(service, p)| {
            let of = sum(p);
            Lost { service: service.clone(), pods: p[node], of, down: p[node] >= of }
        })
        .collect();
    let faults = lost
        .iter()
        .map(|l| FaultOut {
            service: l.service.clone(),
            at: start,
            until: recover.map(|r| start + r),
            down: if l.down { Some(true) } else { None },
            replicas_lost: if l.down { None } else { Some(l.pods) },
            capacity: None,
            extra_ms: None,
            error_rate: None,
            no_scale_out: None,
            warmup_factor: None,
            note: format!("{} lost: {} {}", node, l.service, if l.down { "has no replica left".to_string() } else { format!("down to {} of {} replicas", js_num(l.of - l.pods), js_num(l.of)) }),
        })
        .collect();
    Ok(NodeLossFaults { faults, lost, at_s: start, at: traffic.start + start, recover_s: recover, peak_rps: peak })
}

// ---------- public outages ----------

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Effect {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capacity: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub down: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_rate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_scale_out: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warmup_factor: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replicas_lost: Option<f64>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OutageStep {
    pub from: f64,
    pub to: Option<f64>,
    pub role: String,
    pub effect: Effect,
    pub note: String,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Keyframe {
    pub at: f64,
    pub mult: f64,
}

/// an outage as src/backtest/outages.ts describes it (the catalogue stays there, with its sources)
#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Outage {
    pub id: String,
    pub title: String,
    pub start: String,
    pub minutes: f64,
    pub step_s: f64,
    pub traffic: Vec<Keyframe>,
    pub steps: Vec<OutageStep>,
    #[serde(default)]
    pub sources: Vec<Value>,
}

/// services of a model that play a role
pub fn services_for(model: &Model, role: &str, overrides: &Map<Vec<String>>) -> Vec<String> {
    if let Some(o) = overrides.get(role).filter(|o| !o.is_empty()) {
        return o.clone();
    }
    let entry: IndexSet<&String> = model.endpoints.values().map(|e| &e.service).collect();
    let all = model.services.values();
    match role {
        "edge" => all.filter(|s| entry.contains(&s.id)).map(|s| s.id.clone()).collect(),
        "primary-db" => all.filter(|s| s.kind == "db").map(|s| s.id.clone()).collect(),
        "managed-kv" => {
            let kv: Vec<String> = all
                .filter(|s| {
                    let t = format!("{} {}", s.system.clone().unwrap_or_default(), s.id).to_lowercase();
                    s.kind == "db" && ["dynamo", "mongo", "cassandra", "firestore", "cosmos", "kv"].iter().any(|k| t.contains(k))
                })
                .map(|s| s.id.clone())
                .collect();
            if kv.is_empty() {
                services_for(model, "primary-db", overrides)
            } else {
                kv
            }
        }
        "compute" => all.filter(|s| s.hosted_by.is_none() && (s.kind == "server" || s.kind == "lb")).map(|s| s.id.clone()).collect(),
        "all" => all.filter(|s| s.hosted_by.is_none()).map(|s| s.id.clone()).collect(),
        _ => vec![],
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OutageReplay {
    pub outage: Outage,
    pub dataset: Dataset,
    pub faults: Vec<FaultOut>,
    pub roles: Map<Vec<String>>,
    pub warnings: Vec<String>,
    pub base_rps: f64,
}

/// the outage as a dataset + faults for a given model
pub fn outage_scenario(model: &Model, outage: &Outage, base_rps: Option<f64>, roles_in: &Map<Vec<String>>) -> OutageReplay {
    let base = base_rps.or(model.traffic.as_ref().map(|t| t.p90)).unwrap_or(10.0);
    let n = js_round((outage.minutes * 60.0) / outage.step_s).max(0.0) as usize;
    let start = (parse_iso_ms(&outage.start).unwrap_or(0) as f64 / 1000.0).floor();
    let mut kf = outage.traffic.clone();
    js_sort_by(&mut kf, |a, b| a.at - b.at);
    let mult = |min: f64| -> f64 {
        if min <= kf[0].at {
            return kf[0].mult;
        }
        for k in 1..kf.len() {
            if min <= kf[k].at {
                return kf[k - 1].mult + ((kf[k].mult - kf[k - 1].mult) * (min - kf[k - 1].at)) / (kf[k].at - kf[k - 1].at);
            }
        }
        kf[kf.len() - 1].mult
    };
    let mut endpoints: Map<EndpointSeries> = Map::new();
    for (id, e) in &model.endpoints {
        let rps: Vec<Num> = (0..n).map(|i| Some(base * e.share * mult((i as f64 * outage.step_s) / 60.0))).collect();
        endpoints.insert(id.clone(), EndpointSeries { service: e.service.clone(), rps: Some(rps), ..Default::default() });
    }
    let (mut faults, mut roles, mut warnings) = (vec![], Map::new(), vec![]);
    for st in &outage.steps {
        let svcs = services_for(model, &st.role, roles_in);
        roles.insert(st.role.clone(), svcs.clone());
        if svcs.is_empty() {
            warnings.push(format!("no service plays “{}” in this model — “{}” does not apply", st.role, st.note));
        }
        for s in svcs {
            let e = &st.effect;
            faults.push(FaultOut { service: s.clone(), at: st.from * 60.0, until: st.to.map(|t| t * 60.0), down: e.down, replicas_lost: e.replicas_lost, capacity: e.capacity, extra_ms: e.extra_ms, error_rate: e.error_rate, no_scale_out: e.no_scale_out, warmup_factor: e.warmup_factor, note: format!("{} ({})", st.note, s) });
        }
    }
    let dataset = Dataset {
        version: 1.0,
        name: format!("{} · {}", outage.title, model.name),
        start,
        step_s: outage.step_s,
        n: n as f64,
        services: Map::new(),
        endpoints,
        sources: outage.sources.iter().filter_map(|x| x.get("url").and_then(|u| u.as_str()).map(String::from)).collect(),
        ..Default::default()
    };
    OutageReplay { outage: outage.clone(), dataset, faults, roles, warnings, base_rps: base }
}

pub fn replay_outage(model: &Model, outage: &Outage, strategies: &[Value], base_rps: Option<f64>, roles: &Map<Vec<String>>, draws: Option<f64>) -> Result<(OutageReplay, BacktestResult), String> {
    let replay = outage_scenario(model, outage, base_rps, roles);
    let result = backtest(model, &replay.dataset, strategies, &BacktestOptions { draws: Some(draws.unwrap_or(10.0)), seed: None, observed: Some(false), traffic: None, load: None, faults: Some(replay.faults.iter().map(|f| f.fault()).collect()) })?;
    Ok((replay, result))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// the reference cluster's node kill: its model, history, and the placement at the instant
    fn reference() -> (Model, Dataset, NodeLossOptions) {
        let v: Value = serde_json::from_str(include_str!("../../public/reference/k8s-shop.json")).unwrap();
        let m: Model = serde_json::from_value(v["model"].clone()).unwrap();
        let d: Dataset = serde_json::from_value(v["dataset"].clone()).unwrap();
        let x = &v["nodeLosses"][0];
        let o = NodeLossOptions { pods: Some(serde_json::from_value(x["pods"].clone()).unwrap()), nodes: Some(vec![x["node"].as_str().unwrap().to_string()]), at_s: x["atS"].as_f64(), draws: Some(4.0), ..Default::default() };
        (m, d, o)
    }

    #[test]
    fn a_grpc_caller_left_broken_adds_its_time_beside_the_answer() {
        let (m, d, o) = reference();
        let plain = node_loss(&m, &d, &o).unwrap();
        assert!(plain.results[0].if_callers_stay_broken.is_none());
        // frontend kept two of its three replicas; cart had one, on the lost node
        let with = node_loss(&m, &d, &NodeLossOptions { grpc_calls: Some(vec![("frontend".into(), "cart".into())]), ..o.clone() }).unwrap();
        let (a, b) = (&plain.results[0], &with.results[0]);
        // the answer itself does not move
        assert_eq!((a.minutes_out_of_slo, a.failed_requests, &a.verdict), (b.minutes_out_of_slo, b.failed_requests, &b.verdict));
        let s = b.if_callers_stay_broken.as_ref().unwrap();
        assert_eq!(s.reconnect_s, 252.0);
        assert_eq!(s.calls, vec![("frontend".to_string(), "cart".to_string())]);
        // the cart endpoints fail 252 s more: about 4 minutes more out of SLO, more failed requests
        assert!(s.minutes_out_of_slo >= a.minutes_out_of_slo + 3.5 && s.minutes_out_of_slo <= a.minutes_out_of_slo + 5.0, "{} vs {}", s.minutes_out_of_slo, a.minutes_out_of_slo);
        assert!(s.failed_requests > a.failed_requests, "{} vs {}", s.failed_requests, a.failed_requests);
        assert!(with.notes.iter().any(|n| n.starts_with("ifCallersStayBroken:") && n.contains("one observation on one kind cluster")), "{:?}", with.notes);
        // a callee the node didn't take, or a caller it took with it: nothing to say
        let other = node_loss(&m, &d, &NodeLossOptions { grpc_calls: Some(vec![("frontend".into(), "product-catalog".into()), ("ad".into(), "cart".into())]), ..o }).unwrap();
        assert!(other.results[0].if_callers_stay_broken.is_none());
    }
}
