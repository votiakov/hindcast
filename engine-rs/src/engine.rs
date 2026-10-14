//! The replay: src/backtest/engine.ts `runPlan`, line for line. Endpoint traffic → visits per service
//! (through caches, retries) → per-replica load → M/M/c wait + fluid backlog when demand exceeds
//! capacity → latency per service → end-to-end latency per endpoint along its critical path →
//! failures past the client deadline → cost per bucket. Autoscalers, OOM kills, faults and the node
//! pool run on their own clocks. Expressions keep the TypeScript order of operations so the two
//! engines agree to the last few bits.

#[allow(unused_imports)]
use crate::fmath::JsMath;
use crate::math::{exceed, js_num, js_round, js_to_fixed, mixture_quantile, mmc_wait, Part};
use crate::types::*;
use indexmap::IndexMap;

const RHO_MAX: f64 = 0.97;
const OOM_RESTART_S: f64 = 10.0;
const GB: f64 = 1073741824.0;

/// the wait a one-core burst sees once it has spent its CFS quota: the rest of the 100 ms period
pub fn cfs_stall_ms(limit: Option<f64>) -> f64 {
    match limit {
        Some(l) if l != 0.0 && !l.is_nan() && l < 1.0 => (1.0 - l) * 100.0,
        _ => 0.0,
    }
}

fn truthy(x: Option<f64>) -> Option<f64> {
    match x {
        Some(v) if v != 0.0 && !v.is_nan() => Some(v),
        _ => None,
    }
}

/// effective visits per request with caches in front of services (a hit skips the whole subtree)
pub fn effective_visits(ep: &EndpointPlan, services: &Map<ServicePlan>) -> IndexMap<String, f64> {
    let mut ratio: IndexMap<String, Vec<(String, f64)>> = IndexMap::new();
    for (k, n) in &ep.calls {
        let mut it = k.split('>');
        let from = it.next().unwrap_or("").to_string();
        let to = match it.next() {
            Some(t) => t.to_string(),
            None => continue,
        };
        let v = ep.visits.get(&from).copied().unwrap_or(0.0);
        if v == 0.0 || v.is_nan() {
            continue;
        }
        ratio.entry(from).or_default().push((to, n / v));
    }
    let mut out: IndexMap<String, f64> = IndexMap::new();
    out.insert(ep.service.clone(), 1.0);
    let mut order: Vec<String> = vec![ep.service.clone()];
    let mut seen: std::collections::HashSet<String> = order.iter().cloned().collect();
    let mut i = 0;
    while i < order.len() {
        if let Some(kids) = ratio.get(&order[i]) {
            for (to, _) in kids {
                if !seen.contains(to) {
                    seen.insert(to.clone());
                    order.push(to.clone());
                }
            }
        }
        i += 1;
    }
    for s in &order {
        if *s == ep.service {
            continue;
        }
        let mut v = 0.0;
        for (from, kids) in &ratio {
            for (to, r) in kids {
                if to == s {
                    v += out.get(from).copied().unwrap_or(0.0) * r;
                }
            }
        }
        let hit = services.get(s).and_then(|x| x.cache.as_ref()).map(|c| c.hit_rate).unwrap_or(0.0);
        out.insert(s.clone(), v * (1.0 - hit));
    }
    out
}

fn link_price(a: Option<&ServicePlan>, b: Option<&ServicePlan>, tp: &Transfer) -> f64 {
    let (a, b) = match (a, b) {
        (Some(a), Some(b)) => (a, b),
        _ => return 0.0,
    };
    if let (Some(ra), Some(rb)) = (&a.region, &b.region) {
        if !ra.is_empty() && !rb.is_empty() && ra != rb {
            return tp.cross_region_gb;
        }
    }
    if let (Some(za), Some(zb)) = (&a.zone, &b.zone) {
        if !za.is_empty() && !zb.is_empty() && za != zb {
            return 2.0 * tp.cross_zone_gb;
        }
    }
    0.0
}

#[derive(Clone, Copy)]
struct Effect {
    capacity: f64,
    down: bool,
    extra_ms: f64,
    error_rate: f64,
    no_scale_out: bool,
    warmup_factor: f64,
    lost: f64,
}

struct SvcState {
    backlog: f64,
    live: f64,
    pending: Vec<(f64, f64)>,
    last_scale: f64,
    next_eval: f64,
    blocked_said: bool,
    util: f64,
    collapsed: bool,
    oom_until: f64,
    ooms: f64,
    pending_said: bool,
}

#[derive(Clone, Copy)]
struct Lat {
    mean: f64,
    p99: f64,
    err: f64,
}

pub fn run_plan(plan: &Plan, traffic: &Traffic, opts: &Opts) -> RunResult {
    let n = traffic.n.max(0.0) as usize;
    let step_s = traffic.step_s;
    let sub_n = (step_s / opts.substep_s.unwrap_or(5.0)).ceil().max(1.0);
    let sub = sub_n as usize;
    let dt = step_s / sub_n;
    let svc_ids: Vec<&String> = plan.services.keys().collect();
    let ns = svc_ids.len();
    let svcs: Vec<&ServicePlan> = plan.services.values().collect();
    let ep_ids: Vec<&String> = plan.endpoints.keys().filter(|id| traffic.endpoints.contains_key(*id)).collect();
    let ne = ep_ids.len();
    let eps: Vec<&EndpointPlan> = ep_ids.iter().map(|id| &plan.endpoints[*id]).collect();
    let tr: Vec<&Vec<Num>> = ep_ids.iter().map(|id| &traffic.endpoints[*id]).collect();
    let traffic_at = |j: usize, i: usize| -> f64 { tr[j].get(i).copied().flatten().unwrap_or(0.0) };
    let idx = |name: &str| plan.services.get_index_of(name);
    let host_idx: Vec<Option<usize>> = svcs.iter().map(|s| s.hosted_by.as_deref().and_then(idx)).collect();

    let visits: Vec<IndexMap<String, f64>> = eps.iter().map(|ep| effective_visits(ep, &plan.services)).collect();

    let mut st: Vec<SvcState> = svcs
        .iter()
        .map(|s| {
            let first = s.observed_replicas.as_ref().and_then(|o| o.iter().find_map(|x| *x));
            let live = s.replicas.or(first).unwrap_or(1.0);
            let live = match &s.autoscale {
                Some(a) => a.min.max(a.max.min(live)),
                None => live,
            };
            SvcState { backlog: 0.0, live, pending: vec![], last_scale: f64::NEG_INFINITY, next_eval: 0.0, blocked_said: false, util: 0.0, collapsed: false, oom_until: f64::NEG_INFINITY, ooms: 0.0, pending_said: false }
        })
        .collect();
    let mut ep_fail = vec![0.0; ne];
    let cl = plan.cluster.as_ref();
    let mut cs_nodes = match cl {
        Some(c) => {
            if c.autoscaled {
                -1.0
            } else {
                c.nodes
            }
        }
        None => 0.0,
    };
    let mut cs_unneeded_since = f64::NEG_INFINITY;
    let mut cs_pending_said = false;
    let mut cs_adds: Vec<f64> = vec![];
    let mut cs_want_max = 0.0;

    let empty: Vec<Fault> = vec![];
    let faults: Vec<&Fault> = opts.faults.as_ref().unwrap_or(&empty).iter().filter(|f| plan.services.contains_key(&f.service)).collect();
    let fault_svc: Vec<Option<usize>> = faults.iter().map(|f| idx(&f.service)).collect();
    // active faults, in the order they started
    let mut fault_on: Vec<usize> = vec![];
    let effect = |i: usize, on: &Vec<usize>| -> Effect {
        let mut e = Effect { capacity: 1.0, down: false, extra_ms: 0.0, error_rate: 0.0, no_scale_out: false, warmup_factor: 1.0, lost: 0.0 };
        for &k in on {
            if fault_svc[k] != Some(i) {
                continue;
            }
            let f = faults[k];
            if let Some(c) = f.capacity {
                e.capacity *= c;
            }
            if f.down == Some(true) {
                e.down = true;
            }
            e.extra_ms += f.extra_ms.unwrap_or(0.0);
            e.error_rate = 1.0 - (1.0 - e.error_rate) * (1.0 - f.error_rate.unwrap_or(0.0));
            if f.no_scale_out == Some(true) {
                e.no_scale_out = true;
            }
            if let Some(w) = truthy(f.warmup_factor) {
                e.warmup_factor *= w;
            }
            e.lost += f.replicas_lost.unwrap_or(0.0);
        }
        e
    };

    let z = || vec![0.0; n];
    let mut out = RunResult {
        t: (0..n).map(|i| traffic.start + i as f64 * step_s).collect(),
        rps: z(),
        error_rate: z(),
        p99_ms: z(),
        cost_per_hour: z(),
        cost: Costs { compute: z(), requests: z(), transfer: z(), other: z() },
        services: svc_ids
            .iter()
            .zip(&svcs)
            .map(|(id, s)| ((*id).clone(), ServiceTrace { rps: z(), util: z(), replicas: z(), wait_ms: z(), self_mean_ms: z(), self_p99_ms: z(), backlog: z(), cpu_cores: z(), oom_down: if s.memory.is_some() && n > 0 { Some(z()) } else { None } }))
            .collect(),
        endpoints: ep_ids.iter().map(|id| ((*id).clone(), EndpointTrace { rps: z(), error_rate: z(), mean_ms: z(), p99_ms: z(), p50_ms: z(), cost: z() })).collect(),
        events: vec![],
        cluster: cl.map(|_| ClusterTrace { nodes: z(), requested_cpu: z(), requested_memory_gb: z() }),
    };
    let mut events: Vec<Event> = vec![];
    let mut say = |t: f64, what: String| events.push(Event { t, what });

    // transfer $ per request per endpoint (static)
    let transfer_per_req: Vec<f64> = (0..ne)
        .map(|j| {
            let ep = eps[j];
            let mut dollars = (ep.egress_bytes / GB) * plan.transfer.internet_gb;
            for (k, bytes) in &ep.bytes {
                let mut it = k.split('>');
                let from = it.next().unwrap_or("");
                let to = it.next().unwrap_or("");
                let keep = visits[j].get(to).copied().unwrap_or(0.0) / ep.visits.get(to).copied().unwrap_or(1.0).max(1e-9);
                let host = |x: &str| -> Option<&ServicePlan> {
                    let s = plan.services.get(x);
                    let h = s.and_then(|s| s.hosted_by.as_deref()).unwrap_or(x);
                    plan.services.get(h).or(s)
                };
                dollars += ((bytes * keep) / GB) * link_price(host(from), host(to), &plan.transfer);
            }
            dollars
        })
        .collect();

    // each endpoint's mean latency with no queueing anywhere (anchors the median's shift)
    let zero_mean: Vec<f64> = (0..ne)
        .map(|j| {
            let ep = eps[j];
            let mut m = ep.overhead_ms;
            for (s, w) in &ep.weights {
                let ps = match plan.services.get(s) {
                    Some(p) => p,
                    None => continue,
                };
                let keep = visits[j].get(s).copied().unwrap_or(0.0) / ep.visits.get(s).copied().unwrap_or(1.0).max(1e-9);
                m += w * keep * ps.self_mean + ps.cache.as_ref().map(|c| w * (1.0 - keep) * c.latency_ms).unwrap_or(0.0);
            }
            m
        })
        .collect();

    // fixed per run: each endpoint's path as indices, and per service the visits of each endpoint
    let weights_of: Vec<Vec<(Option<usize>, f64)>> = eps.iter().map(|ep| ep.weights.iter().map(|(s, w)| (idx(s), *w)).collect()).collect();
    let keep_of: Vec<Vec<f64>> = (0..ne)
        .map(|j| eps[j].weights.keys().map(|s| visits[j].get(s).copied().unwrap_or(0.0) / eps[j].visits.get(s).copied().unwrap_or(1.0).max(1e-9)).collect())
        .collect();
    let visits_of: Vec<Vec<(Option<usize>, f64)>> = visits.iter().map(|v| v.iter().map(|(s, x)| (idx(s), *x)).collect()).collect();
    let stalls_of: Vec<Vec<(Option<usize>, f64)>> = eps.iter().map(|ep| ep.stalls.as_ref().map(|v| v.iter().map(|x| (idx(&x.service), x.limit)).collect()).unwrap_or_default()).collect();
    let host_group: Vec<Vec<usize>> = (0..ns).map(|i| (0..ns).filter(|&x| svcs[x].hosted_by.as_deref() == Some(svc_ids[i].as_str()) || x == i).collect()).collect();
    let own_visits: Vec<Vec<f64>> = (0..ns).map(|i| (0..ne).map(|j| visits[j].get(svc_ids[i]).copied().unwrap_or(0.0)).collect()).collect();
    let host_visits: Vec<Vec<f64>> = (0..ns)
        .map(|i| (0..ne).map(|j| host_group[i].iter().fold(0.0, |a, &x| a + visits[j].get(svc_ids[x]).copied().unwrap_or(0.0))).collect())
        .collect();
    let no_faults: Vec<Effect> = (0..ns).map(|i| effect(i, &vec![])).collect();
    let mut ep_share = vec![0.0; ne];

    fn live_of(i: usize, svcs: &[&ServicePlan], host_idx: &[Option<usize>], st: &[SvcState]) -> f64 {
        if svcs[i].hosted_by.is_some() {
            if let Some(h) = host_idx[i] {
                return live_of(h, svcs, host_idx, st);
            }
        }
        st[i].live
    }

    let mut lam = vec![0.0; ne];
    let mut svc_lam = vec![0.0; ns];
    let mut lat: Vec<Lat> = vec![Lat { mean: 0.0, p99: 0.0, err: 0.0 }; ns];
    let mut parts: Vec<Part> = Vec::with_capacity(ne * sub);

    for i in 0..n {
        let mut acc_rps = 0.0;
        let mut acc_fail = 0.0;
        let mut acc_timeout: f64 = 0.0;
        let mut acc_late = 0.0;
        parts.clear();
        for (k, s) in svcs.iter().enumerate() {
            if s.autoscale.is_none() && s.replicas.is_none() {
                if let Some(o) = &s.observed_replicas {
                    if let Some(Some(x)) = o.get(i) {
                        st[k].live = x.max(0.0);
                    }
                }
            }
        }
        for kk in 0..sub {
            let now = i as f64 * step_s + kk as f64 * dt;
            for (k, f) in faults.iter().enumerate() {
                let active = now >= f.at && now < f.until.unwrap_or(f64::INFINITY);
                let on = fault_on.iter().position(|&x| x == k);
                if active && on.is_none() {
                    fault_on.push(k);
                    say(traffic.start + now, f.note.clone().unwrap_or_else(|| format!("{}: fault starts", f.service)));
                } else if !active {
                    if let Some(p) = on {
                        fault_on.remove(p);
                        let what = match f.note.as_deref() {
                            Some(nt) if !nt.is_empty() => format!("{}: ends — {}", f.service, nt),
                            _ => format!("{}: fault ends", f.service),
                        };
                        say(traffic.start + now, what);
                    }
                }
            }
            let with_faults: Vec<Effect>;
            let fx: &[Effect] = if fault_on.is_empty() {
                &no_faults
            } else {
                with_faults = (0..ns).map(|x| effect(x, &fault_on)).collect();
                &with_faults
            };

            // offered load per endpoint, including client retries of last substep's failures
            for j in 0..ne {
                let base = traffic_at(j, i);
                let f: f64 = ep_fail[j];
                let mut amp = 1.0;
                if let Some(r) = &eps[j].retries {
                    if r.attempts > 0.0 {
                        let mut extra: f64 = 0.0;
                        let mut a = 1.0;
                        while a <= r.attempts {
                            extra += f.js_pow(a);
                            a += 1.0;
                        }
                        amp = 1.0 + extra.min(r.budget);
                    }
                }
                lam[j] = base * amp;
            }
            // per-service demand
            for x in svc_lam.iter_mut() {
                *x = 0.0;
            }
            for j in 0..ne {
                for &(s, v) in &visits_of[j] {
                    if let Some(s) = s {
                        svc_lam[s] += lam[j] * v;
                    }
                }
            }

            // queues
            for id in 0..ns {
                let s = svcs[id];
                let f = match host_idx[id] {
                    Some(h) if fx[h].down => fx[h],
                    _ => fx[id],
                };
                let lost_fx = match (s.hosted_by.is_some(), host_idx[id]) {
                    (true, Some(h)) => fx[h].lost,
                    _ => fx[id].lost,
                };
                let live = (live_of(id, &svcs, &host_idx, &st) - lost_fx).max(0.0);
                let per_rep = if live > 0.0 { svc_lam[id] / live } else if svc_lam[id] > 0.0 { f64::INFINITY } else { 0.0 };
                let host_cap = if s.hosted_by.is_some() { host_idx[id].map(|h| fx[h].capacity).unwrap_or(1.0) } else { 1.0 };
                let k_cap = s.per_replica_rps * fx[id].capacity * host_cap;
                let ss = &mut st[id];
                // OOM: every replica carries the same load, so the working set passes the limit on all
                // of them; they are killed and come back after CrashLoopBackOff and a start
                if let Some(m) = &s.memory {
                    if now >= ss.oom_until && live > 0.0 {
                        let load = per_rep.min(if k_cap.is_finite() { k_cap * 1.5 } else { per_rep });
                        let line = m.base + m.per_req * load + m.spike;
                        let ws = match (m.peak, m.seen_to) {
                            (Some(peak), Some(seen)) if load <= seen => line.min(peak),
                            _ => line,
                        };
                        if ws > m.limit {
                            ss.ooms += 1.0;
                            ss.oom_until = now + 300.0_f64.min(10.0 * 2.0_f64.js_pow(ss.ooms - 1.0)) + OOM_RESTART_S;
                            say(
                                traffic.start + now,
                                format!(
                                    "{}: OOM-killed — working set {} MiB per container at {} req/s per replica, limit {} MiB",
                                    svc_ids[id],
                                    js_num(js_round(ws * 1024.0)),
                                    js_num(js_round(per_rep)),
                                    js_num(js_round(m.limit * 1024.0))
                                ),
                            );
                        } else if now >= ss.oom_until + 600.0 {
                            ss.ooms = 0.0;
                        }
                    }
                }
                let down = f.down || now < ss.oom_until;
                let mut wait_mean = 0.0;
                let mut wait_p99 = 0.0;
                if down {
                    ss.backlog = 0.0;
                } else if live <= 0.0 && svc_lam[id] > 0.0 {
                    wait_mean = f64::INFINITY;
                    wait_p99 = f64::INFINITY;
                } else if k_cap.is_finite() {
                    let over = truthy(s.overloaded_rps);
                    if over.is_some() && ss.backlog > k_cap {
                        ss.collapsed = true;
                    }
                    if ss.collapsed && ss.backlog <= 0.0 {
                        ss.collapsed = false;
                    }
                    let k_eff = match over {
                        Some(o) if ss.collapsed => k_cap.min(o * fx[id].capacity),
                        _ => k_cap,
                    };
                    let served = k_eff.min(per_rep + ss.backlog / dt);
                    ss.backlog = (ss.backlog + (per_rep - served) * dt).max(0.0);
                    let w = mmc_wait(per_rep.min(k_cap * RHO_MAX), s.servers, k_cap);
                    let drain = (ss.backlog / k_cap) * 1000.0;
                    // x^0 is 1 for every x (NaN included), as in JavaScript: no pow without a load exponent
                    let le = s.load_exponent.unwrap_or(1.0) - 1.0;
                    let v = s.variability.unwrap_or(1.0) * if le == 0.0 { 1.0 } else { w.rho.min(1.0).js_pow(le) };
                    wait_mean = v * w.mean_ms + drain;
                    wait_p99 = v * w.p99_ms + drain;
                }
                let ex0 = (s.self_p99 - s.self_mean).max(0.0);
                let extra = fx[id].extra_ms;
                let mean = s.self_mean + wait_mean + extra;
                let q = s.tail * (wait_p99 - wait_mean).max(0.0);
                let p99 = mean + (ex0 * ex0 + q * q).sqrt();
                lat[id] = Lat { mean, p99, err: if down { 1.0 } else { fx[id].error_rate } };
                let o = &mut out.services[id];
                let subf = sub_n;
                o.rps[i] += svc_lam[id] / subf;
                o.util[i] += (if k_cap.is_finite() && live > 0.0 { 1.5_f64.min(per_rep / k_cap) } else { 0.0 }) / subf;
                o.replicas[i] += live / subf;
                o.wait_ms[i] += (if wait_mean.is_finite() { wait_mean } else { 1e6 }) / subf;
                o.self_mean_ms[i] += (if mean.is_finite() { mean } else { 1e6 }) / subf;
                o.self_p99_ms[i] += (if p99.is_finite() { p99 } else { 1e6 }) / subf;
                o.backlog[i] += ss.backlog / subf;
                o.cpu_cores[i] += (match &s.cpu {
                    Some(c) => live * (c.base + c.per_req * per_rep.min(k_cap)),
                    None => 0.0,
                }) / subf;
                if let Some(od) = &mut o.oom_down {
                    od[i] += (if now < ss.oom_until { 1.0 } else { 0.0 }) / subf;
                }
            }

            // endpoints: latency along the critical path, failures past the deadline
            for j in 0..ne {
                let ep = eps[j];
                let mut mean = ep.overhead_ms;
                let mut ex2 = 0.0;
                for (k, &(s, w)) in weights_of[j].iter().enumerate() {
                    let s = match s {
                        Some(s) => s,
                        None => continue,
                    };
                    let l = lat[s];
                    let keep = keep_of[j][k];
                    let ps = svcs[s];
                    mean += w * keep * l.mean + ps.cache.as_ref().map(|c| w * (1.0 - keep) * c.latency_ms).unwrap_or(0.0);
                    let ex0 = (ps.self_p99 - ps.self_mean).max(0.0);
                    let x = w * keep * (l.p99 - l.mean - ex0).max(0.0);
                    ex2 += x * x;
                }
                // one CFS stall at the plan's limits: the longest on the path (they rarely coincide)
                let mut stall: f64 = 0.0;
                for &(s, limit) in &stalls_of[j] {
                    let ok = match s {
                        None => true,
                        Some(s) => lat[s].err < 1.0,
                    };
                    if ok {
                        let lim = match s {
                            Some(s) => svcs[s].cpu_limit.unwrap_or(limit),
                            None => limit,
                        };
                        stall = stall.max(cfs_stall_ms(Some(lim)));
                    }
                }
                let p99 = mean + stall + (ep.base_excess_ms * ep.base_excess_ms + ep.tail * ep.tail * ex2).sqrt();
                let late = exceed(mean, p99, ep.timeout_ms);
                // a failed call to any service on the request's path fails the request
                let mut ok = 1.0;
                for &(s, v) in &visits_of[j] {
                    if let Some(s) = s {
                        let e = lat[s].err;
                        if e != 0.0 && !e.is_nan() {
                            ok *= (1.0 - e).js_pow(v.max(1.0));
                        }
                    }
                }
                let base0 = (ep.error_rate + ep.error_slope.unwrap_or(0.0) * traffic_at(j, i)).max(0.0).min(1.0);
                let fail = 1.0 - (1.0 - base0) * (1.0 - late) * ok;
                ep_fail[j] = fail;
                let base = traffic_at(j, i);
                let seen_p99 = if late > 0.01 { ep.timeout_ms } else { p99.min(ep.timeout_ms) };
                let seen_mean = if mean.is_finite() { mean.min(ep.timeout_ms) } else { ep.timeout_ms };
                let o = &mut out.endpoints[j];
                o.rps[i] += base / sub_n;
                o.error_rate[i] += fail / sub_n;
                // the median moves with the mean: everything that waits, waits for everyone
                let shift = (seen_mean - zero_mean[j]).max(0.0);
                let p50 = match truthy(ep.base_p50_ms) {
                    Some(b) => ep.timeout_ms.min(b + shift),
                    None => 0.0,
                };
                let p90 = match truthy(ep.base_p90_ms) {
                    Some(b) if p50 > 0.0 => ep.timeout_ms.min(b + shift),
                    _ => 0.0,
                };
                o.mean_ms[i] += seen_mean / sub_n;
                o.p99_ms[i] += seen_p99 / sub_n;
                o.p50_ms[i] += p50 / sub_n;
                acc_rps += base / sub_n;
                acc_fail += (base * fail) / sub_n;
                acc_late += (base * late) / sub_n;
                let with_p50 = p50 > 0.0 && late <= 0.01;
                parts.push(Part {
                    w: base / sub_n,
                    mean: seen_mean,
                    p99: seen_p99,
                    p50: if with_p50 { Some(p50) } else { None },
                    p90: if with_p50 && p90 > p50 && p90 < seen_p99 { Some(p90) } else { None },
                });
                acc_timeout = acc_timeout.max(ep.timeout_ms);
            }

            // cost of this substep, $/h
            let mut compute = 0.0;
            let mut requests = 0.0;
            let lam_tot = lam.iter().fold(0.0, |a, x| a + x);
            let host_load = |id: usize, lam: &[f64]| -> f64 {
                let hv = &host_visits[id];
                let mut a = 0.0;
                for j in 0..ne {
                    a += lam[j] * hv[j];
                }
                a
            };
            let pods_of = |x: usize, st: &[SvcState]| st[x].live + st[x].pending.iter().fold(0.0, |a, p| a + p.1);
            // on a cluster, the nodes are the bill: as many as the requests need (autoscaled, removed
            // only after they've been unneeded a while) or the fixed pool
            let mut node_scale = 1.0;
            if let Some(c) = cl {
                let mut rc = c.other.cpu;
                let mut rm = c.other.memory_gb;
                let mut allocated = 0.0;
                for x in 0..ns {
                    let s = svcs[x];
                    let r = match (&s.hosted_by, &s.requests) {
                        (None, Some(r)) => r,
                        _ => continue,
                    };
                    let pods = pods_of(x, &st);
                    rc += pods * r.cpu;
                    rm += pods * r.memory_gb;
                    allocated += pods * s.replica_hour;
                }
                let ideal = (rc / c.node.cpu).max(rm / c.node.memory_gb);
                if c.autoscaled {
                    let want = c.max_nodes.min(c.min_nodes.max((ideal * c.packing - 1e-9).ceil()));
                    if cs_nodes < 0.0 {
                        cs_nodes = want;
                    } else if want > cs_nodes {
                        say(traffic.start + now, format!("cluster: {} → {} nodes (pods request {} cores, {} GiB)", js_num(cs_nodes), js_num(want), js_to_fixed(rc, 1), js_to_fixed(rm, 1)));
                        let mut k = cs_nodes;
                        while k < want {
                            cs_adds.push(now);
                            k += 1.0;
                        }
                        cs_nodes = want;
                        cs_unneeded_since = f64::NEG_INFINITY;
                    } else if want < cs_nodes {
                        if !cs_unneeded_since.is_finite() {
                            cs_unneeded_since = now;
                            cs_want_max = want;
                        }
                        cs_want_max = cs_want_max.max(want);
                        if now - cs_unneeded_since >= c.scale_down_s {
                            say(traffic.start + now, format!("cluster: {} → {} nodes (unneeded for {} min)", js_num(cs_nodes), js_num(cs_want_max), js_num(js_round(c.scale_down_s / 60.0))));
                            cs_nodes = cs_want_max;
                            cs_unneeded_since = f64::NEG_INFINITY;
                        }
                    } else {
                        cs_unneeded_since = f64::NEG_INFINITY;
                    }
                    cs_adds.retain(|&at| at > now - c.provision_s);
                }
                if ideal > cs_nodes && !cs_pending_said {
                    say(traffic.start + now, format!("cluster: pods request {} cores and {} GiB, more than {} nodes hold — some would stay Pending", js_to_fixed(rc, 1), js_to_fixed(rm, 1), js_num(cs_nodes)));
                    cs_pending_said = true;
                }
                let others = c.node.per_hour * (c.other.cpu / c.node.cpu).max(c.other.memory_gb / c.node.memory_gb) * c.packing;
                let ours = (cs_nodes * c.node.per_hour - others).max(0.0);
                node_scale = if allocated > 0.0 { ours / allocated } else { 0.0 };
                if !(allocated > 0.0) {
                    compute += ours;
                }
                let oc = out.cluster.as_mut().unwrap();
                oc.nodes[i] += cs_nodes / sub_n;
                oc.requested_cpu[i] += rc / sub_n;
                oc.requested_memory_gb[i] += rm / sub_n;
            }
            for x in ep_share.iter_mut() {
                *x = 0.0;
            }
            let mut idle_own = 0.0;
            for id in 0..ns {
                let s = svcs[id];
                let on_nodes = cl.is_some() && s.requests.is_some() && s.hosted_by.is_none();
                let own = (if s.hosted_by.is_some() { 0.0 } else { pods_of(id, &st) * s.replica_hour * (if on_nodes { node_scale } else { 1.0 }) }) + s.cache.as_ref().map(|c| c.cost_per_hour).unwrap_or(0.0);
                let req = svc_lam[id] * 3600.0 * s.per_request;
                compute += own;
                requests += req;
                if own > 0.0 {
                    let load = host_load(id, &lam);
                    if load > 0.0 {
                        let c = own / load;
                        let hv = &host_visits[id];
                        for j in 0..ne {
                            ep_share[j] += c * hv[j];
                        }
                    } else {
                        idle_own += own;
                    }
                }
                if req > 0.0 && svc_lam[id] > 0.0 {
                    let c = req / svc_lam[id];
                    let sv = &own_visits[id];
                    for j in 0..ne {
                        ep_share[j] += c * sv[j];
                    }
                }
            }
            for j in 0..ne {
                let idle = if idle_own > 0.0 { idle_own * (if lam_tot > 0.0 { lam[j] / lam_tot } else { 1.0 / ne as f64 }) } else { 0.0 };
                out.endpoints[j].cost[i] += ((lam[j] * ep_share[j] + idle) * dt) / 3600.0;
            }
            let mut transfer = 0.0;
            for j in 0..ne {
                transfer += lam[j] * 3600.0 * transfer_per_req[j];
                out.endpoints[j].cost[i] += ((lam[j] * 3600.0 * transfer_per_req[j] + (if lam_tot > 0.0 { (plan.unattributed_per_hour * lam[j]) / lam_tot } else { 0.0 })) * dt) / 3600.0;
            }
            out.cost.compute[i] += (compute * dt) / 3600.0;
            out.cost.requests[i] += (requests * dt) / 3600.0;
            out.cost.transfer[i] += (transfer * dt) / 3600.0;
            out.cost.other[i] += (plan.unattributed_per_hour * dt) / 3600.0;

            // autoscalers
            for id in 0..ns {
                let s = svcs[id];
                let a = match &s.autoscale {
                    Some(a) => a,
                    None => continue,
                };
                let t = now + dt;
                {
                    let ss = &mut st[id];
                    let mut kept = Vec::with_capacity(ss.pending.len());
                    let mut came: Vec<f64> = vec![];
                    for p in ss.pending.drain(..) {
                        if p.0 <= t {
                            came.push(p.1);
                        } else {
                            kept.push(p);
                        }
                    }
                    ss.pending = kept;
                    for pn in came {
                        ss.live += pn;
                        let live = ss.live;
                        say(traffic.start + t, format!("{}: {} new replica{} serving ({})", svc_ids[id], js_num(pn), if pn > 1.0 { "s" } else { "" }, js_num(live)));
                    }
                }
                // the HPA sees ready pods: replicas a node failure took aren't there until they're replaced
                let lost = st[id].live.min(fx[id].lost);
                let ready = st[id].live - lost;
                let per_rep_now = if ready > 0.0 { svc_lam[id] / ready } else { 0.0 };
                let util_now = match (&s.cpu, truthy(s.cpu_limit)) {
                    (Some(c), Some(lim)) => (c.base + c.per_req * per_rep_now.min(s.per_replica_rps)) / lim,
                    _ => {
                        if s.per_replica_rps.is_finite() {
                            per_rep_now.min(s.per_replica_rps) / s.per_replica_rps
                        } else {
                            0.0
                        }
                    }
                };
                {
                    let ss = &mut st[id];
                    ss.util += (util_now - ss.util) * (1.0 - (-dt / dt.max(a.metric_window_s.unwrap_or(30.0) / 2.0)).js_exp());
                    if t + 1e-9 < ss.next_eval {
                        continue;
                    }
                    ss.next_eval = t + a.interval_s;
                }
                let util = st[id].util;
                let booting = st[id].pending.iter().fold(0.0, |x, p| x + p.1);
                let desired = a.max.min(a.min.max((ready.max(1.0) * util / a.target - 1e-9).ceil()));
                if desired > ready + booting && fx[id].no_scale_out {
                    if !st[id].blocked_said {
                        say(traffic.start + t, format!("{}: wants {} replicas but cannot launch any", svc_ids[id], js_num(desired)));
                    }
                    st[id].blocked_said = true;
                } else if desired > ready + booting {
                    st[id].blocked_said = false;
                    let mut add = desired - ready - booting;
                    let mut wait = 0.0;
                    // on a cluster the new pods need room: on an autoscaled pool, a node that isn't
                    // there yet is waited for; on a fixed pool, pods that don't fit stay Pending
                    if let (Some(c), Some(r), None) = (cl, &s.requests, &s.hosted_by) {
                        let mut rc = c.other.cpu;
                        let mut rm = c.other.memory_gb;
                        for x in 0..ns {
                            let q = svcs[x];
                            let qr = match (&q.hosted_by, &q.requests) {
                                (None, Some(qr)) => qr,
                                _ => continue,
                            };
                            let pods = pods_of(x, &st);
                            rc += pods * qr.cpu;
                            rm += pods * qr.memory_gb;
                        }
                        let usable = cs_nodes - cs_adds.iter().filter(|&&at| at > t - c.provision_s).count() as f64;
                        let fits = |k: f64| ((rc + k * r.cpu) / c.node.cpu).max((rm + k * r.memory_gb) / c.node.memory_gb) * (if c.autoscaled { c.packing } else { 1.0 }) <= usable + 1e-9;
                        if c.autoscaled {
                            if !fits(add) {
                                wait = c.provision_s;
                            }
                        } else {
                            let mut room = add;
                            while room > 0.0 && !fits(room) {
                                room -= 1.0;
                            }
                            if room < add && !st[id].pending_said {
                                say(traffic.start + t, format!("{}: {} of {} new replicas stay Pending — the {} fixed nodes have no room for their requests", svc_ids[id], js_num(add - room), js_num(add), js_num(cs_nodes)));
                            }
                            st[id].pending_said = room < add;
                            add = room;
                        }
                    }
                    if add > 0.0 {
                        let ss = &mut st[id];
                        ss.pending.push((t + a.warmup_s * fx[id].warmup_factor + wait, add));
                        ss.last_scale = t;
                        let from = ss.live + booting;
                        say(
                            traffic.start + t,
                            format!(
                                "{}: scale out {} → {} (load {}% of target {}%){}",
                                svc_ids[id],
                                js_num(from),
                                js_num(from + add),
                                js_to_fixed(util * 100.0, 0),
                                js_to_fixed(a.target * 100.0, 0),
                                if wait != 0.0 { format!(", waiting {} s for a new node", js_num(wait)) } else { String::new() }
                            ),
                        );
                    }
                } else if desired < ready && !(booting != 0.0) && t - st[id].last_scale >= a.cooldown_s {
                    say(traffic.start + t, format!("{}: scale in {} → {}", svc_ids[id], js_num(ready), js_num(desired)));
                    st[id].live = desired + lost;
                    st[id].last_scale = t;
                }
            }
        }
        out.rps[i] = acc_rps;
        out.error_rate[i] = if acc_rps > 0.0 { acc_fail / acc_rps } else { 0.0 };
        // with more than 1% of requests running into the deadline, the 99th percentile is the timeout
        out.p99_ms[i] = if acc_rps > 0.0 && acc_late / acc_rps > 0.01 {
            acc_timeout
        } else {
            (if acc_timeout != 0.0 && !acc_timeout.is_nan() { acc_timeout } else { f64::INFINITY }).min(mixture_quantile(&parts, 0.01))
        };
        let total = out.cost.compute[i] + out.cost.requests[i] + out.cost.transfer[i] + out.cost.other[i];
        out.cost_per_hour[i] = (total * 3600.0) / step_s;
    }
    out.events = events;
    out
}
