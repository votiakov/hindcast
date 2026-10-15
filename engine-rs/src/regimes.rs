//! Configuration regimes: the stretches of a history in which a service ran with the same CPU and
//! memory limits and requests, and the same replica count where no autoscaler sets it. A fit across
//! two of them reads two different services as one, so calibration fits each service on one: the
//! latest, unless it carries too little traffic to fit, then the one that carries the most.

use crate::dataset::{Dataset, ServiceSeries};
use crate::math::{js_num, js_round, js_to_fixed};
use crate::model::{FitRegime, LatestRegime, RegimeChange};
use crate::types::{Map, Num};
use serde::{Deserialize, Serialize};

/// a setting has to hold this long to count: a rollout shows both pods' values for a moment
const HOLD_S: f64 = 300.0;
/// a replica count has to hold this long (restarts and rollouts move the ready count for minutes)
const REPLICA_HOLD_S: f64 = 1800.0;
/// the latest configuration is fitted on when it carries this much traffic
pub const MIN_BUSY_S: f64 = 7200.0;
pub const MIN_BUSY_BUCKETS: usize = 30;

const KEYS: [&str; 5] = ["cpuLimitCores", "cpuRequestCores", "memoryLimitBytes", "memoryRequestBytes", "replicas"];

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Configuration {
    pub settings: Map<f64>,
    /// [start, end) bucket ranges it ran in; a rollback runs an earlier configuration again
    pub spans: Vec<[usize; 2]>,
    /// seconds of the history in which the service had traffic
    pub busy_s: f64,
    pub busy_buckets: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Regimes {
    /// in the order they first ran
    pub configurations: Vec<Configuration>,
    /// the configuration the service ran last
    pub latest: usize,
    /// the configuration it is fitted on
    pub chosen: usize,
    /// "latest", or "longest" when the latest carries too little traffic
    pub basis: String,
    /// when each setting changed: (bucket, key, from, to)
    pub changes: Vec<(usize, String, f64, f64)>,
}

impl Regimes {
    pub fn mixed(&self) -> bool {
        self.configurations.len() > 1
    }
    pub fn inside(&self, i: usize) -> bool {
        !self.mixed() || self.configurations[self.chosen].spans.iter().any(|s| i >= s[0] && i < s[1])
    }
}

fn series<'a>(s: &'a ServiceSeries, key: &str) -> Option<&'a Vec<Num>> {
    match key {
        "cpuLimitCores" => s.cpu_limit_cores.as_ref(),
        "cpuRequestCores" => s.cpu_request_cores.as_ref(),
        "memoryLimitBytes" => s.memory_limit_bytes.as_ref(),
        "memoryRequestBytes" => s.memory_request_bytes.as_ref(),
        "replicas" => s.replicas.as_ref(),
        _ => None,
    }
}

fn same(a: f64, b: f64) -> bool {
    (a - b).abs() <= 0.01 * a.abs().max(b.abs())
}

/// a setting's value per bucket, its brief values (shorter than `hold` buckets) folded into the
/// value before them; None before it is first seen
fn settled(v: &[Num], n: usize, hold: usize, skip_zero: bool) -> Vec<Option<f64>> {
    // runs of one value over the buckets that have one
    let mut runs: Vec<(usize, usize, f64)> = vec![];
    for i in 0..n.min(v.len()) {
        let x = match v[i] {
            Some(x) if x.is_finite() && !(skip_zero && x <= 0.0) => x,
            _ => continue,
        };
        match runs.last_mut() {
            Some(r) if same(r.2, x) => r.1 = i + 1,
            _ => runs.push((i, i + 1, x)),
        }
    }
    // a run counts by the buckets from its start to the next run's start, gaps included
    let long: Vec<bool> = runs.iter().enumerate().map(|(k, r)| runs.get(k + 1).map(|x| x.0).unwrap_or(n) - r.0 >= hold).collect();
    let mut kept: Vec<(usize, f64)> = vec![];
    for (k, r) in runs.iter().enumerate() {
        if !long[k] {
            continue;
        }
        match kept.last() {
            Some(p) if same(p.1, r.2) => {}
            _ => kept.push((r.0, r.2)),
        }
    }
    if kept.is_empty() {
        if let Some(r) = runs.iter().max_by_key(|r| r.1 - r.0) {
            kept.push((r.0, r.2));
        }
    }
    let mut out = vec![None; n];
    for (k, (from, x)) in kept.iter().enumerate() {
        let to = kept.get(k + 1).map(|p| p.0).unwrap_or(n);
        for o in out.iter_mut().take(to).skip(if k == 0 { 0 } else { *from }) {
            *o = Some(*x);
        }
    }
    out
}

/// the configurations one service ran in, from its own series (or its host's)
pub fn detect(s: &ServiceSeries, n: usize, step_s: f64, autoscaled: bool) -> Regimes {
    let hold = ((HOLD_S / step_s).ceil() as usize).max(1);
    let rep_hold = ((REPLICA_HOLD_S / step_s).ceil() as usize).max(1);
    let mut per_key: Vec<(&str, Vec<Option<f64>>)> = vec![];
    for key in KEYS {
        if key == "replicas" && autoscaled {
            continue;
        }
        if let Some(v) = series(s, key) {
            let st = settled(v, n, if key == "replicas" { rep_hold } else { hold }, key == "replicas");
            if st.iter().any(|x| x.is_some()) {
                per_key.push((key, st));
            }
        }
    }
    let mut changes = vec![];
    for (key, st) in &per_key {
        for i in 1..n {
            if let (Some(a), Some(b)) = (st[i - 1], st[i]) {
                if !same(a, b) {
                    changes.push((i, key.to_string(), a, b));
                }
            }
        }
    }
    changes.sort_by_key(|c| c.0);
    let busy: Vec<bool> = (0..n).map(|i| s.rps.as_ref().and_then(|r| r.get(i).copied().flatten()).map(|x| x > 0.0).unwrap_or(false)).collect();
    let mut configurations: Vec<Configuration> = vec![];
    let mut cur: Option<usize> = None;
    for i in 0..n {
        let settings: Map<f64> = per_key.iter().filter_map(|(k, st)| st[i].map(|x| (k.to_string(), x))).collect();
        let k = match configurations.iter().position(|c| c.settings.len() == settings.len() && c.settings.iter().all(|(k, v)| settings.get(k).map(|x| same(*x, *v)).unwrap_or(false))) {
            Some(k) => k,
            None => {
                configurations.push(Configuration { settings, ..Default::default() });
                configurations.len() - 1
            }
        };
        let c = &mut configurations[k];
        match (cur == Some(k), c.spans.last_mut()) {
            (true, Some(sp)) => sp[1] = i + 1,
            _ => c.spans.push([i, i + 1]),
        }
        cur = Some(k);
        if busy[i] {
            c.busy_buckets += 1;
            c.busy_s += step_s;
        }
    }
    let latest = cur.unwrap_or(0);
    let enough = |c: &Configuration| c.busy_s >= MIN_BUSY_S && c.busy_buckets >= MIN_BUSY_BUCKETS;
    let (chosen, basis) = if configurations.is_empty() || enough(&configurations[latest]) {
        (latest, "latest")
    } else {
        let mut best = latest;
        for (k, c) in configurations.iter().enumerate() {
            if c.busy_s > configurations[best].busy_s {
                best = k;
            }
        }
        (best, if best == latest { "latest" } else { "longest" })
    };
    Regimes { configurations, latest, chosen, basis: basis.into(), changes }
}

/// every service's regimes, a hosted one by its host's
pub fn detect_all(d: &Dataset, hosted_by: &Map<String>) -> Map<Regimes> {
    let n = d.n.max(0.0) as usize;
    let mut out = Map::new();
    for (id, s) in &d.services {
        let host = hosted_by.get(id).filter(|h| !h.is_empty() && d.services.contains_key(*h));
        let src = host.and_then(|h| d.services.get(h)).unwrap_or(s);
        let autoscaled = d.hpa.as_ref().map(|h| h.contains_key(host.unwrap_or(id))).unwrap_or(false);
        let mut r = detect(src, n, d.step_s, autoscaled);
        if host.is_some() {
            // the host's settings, the hosted service's own traffic
            r = recount(r, s, d.step_s);
        }
        out.insert(id.clone(), r);
    }
    out
}

/// how many configurations of the whole system the window holds: each distinct combination of the
/// services' configurations
pub fn system_configurations(all: &Map<Regimes>, n: usize) -> usize {
    let mut at: Vec<Vec<usize>> = vec![vec![]; n];
    for r in all.values().filter(|r| r.mixed()) {
        for (k, c) in r.configurations.iter().enumerate() {
            for sp in &c.spans {
                for v in at.iter_mut().take(sp[1].min(n)).skip(sp[0]) {
                    v.push(k);
                }
            }
        }
    }
    let mut seen: Vec<&Vec<usize>> = vec![];
    for v in &at {
        if !seen.contains(&v) {
            seen.push(v);
        }
    }
    seen.len().max(1)
}

fn recount(mut r: Regimes, s: &ServiceSeries, step_s: f64) -> Regimes {
    for c in r.configurations.iter_mut() {
        c.busy_buckets = c.spans.iter().map(|sp| (sp[0]..sp[1]).filter(|&i| s.rps.as_ref().and_then(|v| v.get(i).copied().flatten()).map(|x| x > 0.0).unwrap_or(false)).count()).sum();
        c.busy_s = c.busy_buckets as f64 * step_s;
    }
    r
}

/// a service's series with every bucket outside the configuration it is fitted on emptied
pub fn masked(s: &ServiceSeries, r: &Regimes) -> ServiceSeries {
    let mut o = s.clone();
    if !r.mixed() {
        return o;
    }
    let cut = |v: &mut Option<Vec<Num>>| {
        if let Some(v) = v.as_mut() {
            for (i, x) in v.iter_mut().enumerate() {
                if !r.inside(i) {
                    *x = None;
                }
            }
        }
    };
    for v in [
        &mut o.rps, &mut o.done_rps, &mut o.error_rate, &mut o.p50_ms, &mut o.p95_ms, &mut o.p99_ms, &mut o.mean_ms, &mut o.self_mean_ms, &mut o.self_p99_ms, &mut o.cpu_cores, &mut o.cpu_limit_cores, &mut o.replicas, &mut o.net_tx_bps, &mut o.net_rx_bps, &mut o.memory_bytes, &mut o.memory_max_bytes, &mut o.memory_limit_bytes, &mut o.cpu_request_cores, &mut o.memory_request_bytes, &mut o.cpu_throttled,
    ] {
        cut(v);
    }
    o
}

/// "CPU limit 0.5 cores" etc.
pub fn setting_label(key: &str, x: f64) -> String {
    match key {
        "cpuLimitCores" => format!("CPU limit {} cores", js_num(js_round(x * 1000.0) / 1000.0)),
        "cpuRequestCores" => format!("CPU request {} cores", js_num(js_round(x * 1000.0) / 1000.0)),
        "memoryLimitBytes" => format!("memory limit {} MiB", js_num(js_round(x / 1048576.0))),
        "memoryRequestBytes" => format!("memory request {} MiB", js_num(js_round(x / 1048576.0))),
        "replicas" => format!("{} replica{}", js_num(x), if x == 1.0 { "" } else { "s" }),
        _ => format!("{} {}", key, js_num(x)),
    }
}

/// what sets one configuration apart from another: the settings that differ, as `a`'s values
pub fn differences(a: &Configuration, b: &Configuration) -> Vec<String> {
    a.settings.iter().filter(|(k, v)| b.settings.get(*k).map(|x| !same(*x, **v)).unwrap_or(true)).map(|(k, v)| setting_label(k, *v)).collect()
}

pub fn hours(s: f64) -> String {
    js_to_fixed(s / 3600.0, 1)
}

/// "2026-10-15 12:48 UTC"
pub fn when(t: f64) -> String {
    let s = crate::accuracy::iso_of_ms((t * 1000.0).trunc() as i64);
    format!("{} UTC", s.get(..16).unwrap_or(&s).replace('T', " "))
}

/// what the model records of the configuration a service was fitted on; nothing where there was one
pub fn fit_regime(r: &Regimes, start: f64, step_s: f64) -> Option<FitRegime> {
    if !r.mixed() {
        return None;
    }
    let c = &r.configurations[r.chosen];
    let at = |i: usize| start + i as f64 * step_s;
    let latest = &r.configurations[r.latest];
    Some(FitRegime {
        configurations: r.configurations.len() as f64,
        basis: r.basis.clone(),
        settings: c.settings.clone(),
        from: at(c.spans[0][0]),
        to: at(c.spans[c.spans.len() - 1][1]),
        busy_hours: js_round(c.busy_s / 360.0) / 10.0,
        latest: if r.chosen == r.latest { None } else { Some(LatestRegime { differs: differences(latest, c), since: at(latest.spans[latest.spans.len() - 1][0]), busy_hours: js_round(latest.busy_s / 360.0) / 10.0 }) },
        changes: r.changes.iter().map(|(i, k, a, b)| RegimeChange { at: at(*i), setting: k.clone(), from: *a, to: *b }).collect(),
    })
}

/// the fit note: which configuration, and why that one
pub fn note(f: &FitRegime) -> String {
    let what: Vec<String> = f.settings.iter().map(|(k, v)| setting_label(k, *v)).collect();
    match &f.latest {
        None => format!("the history holds {} configurations; fitted on the latest ({}), {} h of traffic", js_num(f.configurations), what.join(", "), js_to_fixed(f.busy_hours, 1)),
        Some(l) => format!(
            "the history holds {} configurations; the latest ({}, since {}) carried {} h of traffic, under the {} h needed to fit on, so it is fitted on the one with the most ({}, {} h) — its numbers describe that configuration",
            js_num(f.configurations),
            l.differs.join(", "),
            when(l.since),
            js_to_fixed(l.busy_hours, 1),
            js_num(MIN_BUSY_S / 3600.0),
            what.join(", "),
            js_to_fixed(f.busy_hours, 1)
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn series_of(xs: &[(usize, f64)], n: usize) -> Vec<Num> {
        // piecewise constant: value xs[k].1 from bucket xs[k].0
        (0..n).map(|i| xs.iter().rev().find(|(from, _)| i >= *from).map(|x| x.1)).collect()
    }

    fn busy(n: usize) -> Vec<Num> {
        vec![Some(10.0); n]
    }

    #[test]
    fn a_replica_change_mid_window_splits_it_and_the_latest_is_fitted() {
        // 30 s buckets, 8 h: 3 replicas for 5 h, then 1; a rollout blip and a restart along the way
        let n = 960;
        let mut reps = series_of(&[(0, 3.0), (600, 1.0)], n);
        reps[100] = Some(4.0);
        reps[700] = Some(0.0);
        let s = ServiceSeries { rps: Some(busy(n)), replicas: Some(reps), cpu_limit_cores: Some(vec![Some(0.5); n]), ..Default::default() };
        let r = detect(&s, n, 30.0, false);
        assert_eq!(r.configurations.len(), 2);
        assert_eq!(r.changes.len(), 1);
        assert_eq!(r.changes[0].0, 600);
        assert_eq!(r.basis, "latest");
        assert_eq!(r.configurations[r.chosen].settings["replicas"], 1.0);
        assert!(!r.inside(599) && r.inside(600) && r.inside(n - 1));
        // under an autoscaler the replica count is behaviour, not configuration
        let r = detect(&s, n, 30.0, true);
        assert!(!r.mixed());
    }

    #[test]
    fn a_limit_change_too_recent_to_fit_falls_back_to_the_longest() {
        // 30 s buckets, 8 h: memory limit 150 MiB, then 300 MiB for the last hour
        let n = 960;
        let mib = 1048576.0;
        let s = ServiceSeries { rps: Some(busy(n)), memory_limit_bytes: Some(series_of(&[(0, 150.0 * mib), (840, 300.0 * mib)], n)), ..Default::default() };
        let r = detect(&s, n, 30.0, false);
        assert_eq!(r.configurations.len(), 2);
        assert_eq!(r.latest, 1);
        assert_eq!(r.chosen, 0);
        assert_eq!(r.basis, "longest");
        assert_eq!(differences(&r.configurations[r.latest], &r.configurations[r.chosen]), vec!["memory limit 300 MiB".to_string()]);
        // the same change with 3 h left: the latest carries enough traffic
        let s = ServiceSeries { rps: Some(busy(n)), memory_limit_bytes: Some(series_of(&[(0, 150.0 * mib), (600, 300.0 * mib)], n)), ..Default::default() };
        let r = detect(&s, n, 30.0, false);
        assert_eq!((r.chosen, r.basis.as_str()), (1, "latest"));
        let m = masked(&s, &r);
        assert!(m.rps.as_ref().unwrap()[599].is_none() && m.rps.as_ref().unwrap()[600].is_some());
    }

    /// 8 h of 30 s buckets of one service: load swinging 20–80 req/s, 4 ms of CPU per request on
    /// 20 millicores of base, 10 ms of self time
    fn history(limit: Vec<Num>, replicas: Vec<Num>) -> Dataset {
        let n = 960;
        let rps: Vec<Num> = (0..n).map(|i| Some(50.0 + 30.0 * (i as f64 / 40.0).sin())).collect();
        let cpu: Vec<Num> = (0..n).map(|i| Some(replicas[i].unwrap() * 0.02 + 0.004 * rps[i].unwrap())).collect();
        let s = ServiceSeries { rps: Some(rps), cpu_cores: Some(cpu), cpu_limit_cores: Some(limit), replicas: Some(replicas), self_mean_ms: Some(vec![Some(10.0); n]), ..Default::default() };
        Dataset { name: "t".into(), start: 1_790_000_000.0, step_s: 30.0, n: n as f64, services: [("api".to_string(), s)].into_iter().collect(), ..Default::default() }
    }

    #[test]
    fn calibration_fits_a_cpu_limit_change_on_the_latest_limit() {
        // 1 core for 5 h, then half a core: the capacity is the latest limit's
        let d = history(series_of(&[(0, 1.0), (600, 0.5)], 960), vec![Some(1.0); 960]);
        let m = crate::calibrate::calibrate(&d, &crate::calibrate::CalibrateOptions { bootstrap: Some(0.0), ..Default::default() });
        let s = &m.services["api"];
        assert_eq!(s.cpu_limit, Some(0.5));
        // (0.5 − 0.02) / 0.004 = 120 req/s per replica; the whole window's median limit would read 245
        assert!((s.capacity.per_replica_rps - 120.0).abs() < 6.0, "{}", s.capacity.per_replica_rps);
        let r = s.fit.regime.as_ref().unwrap();
        assert_eq!((r.configurations, r.basis.as_str()), (2.0, "latest"));
        assert_eq!(r.changes.len(), 1);
        assert_eq!(r.changes[0].at, d.start + 600.0 * 30.0);
        assert!(s.fit.notes.iter().any(|x| x.contains("fitted on the latest (CPU limit 0.5 cores")));
    }

    #[test]
    fn calibration_runs_a_replica_change_at_the_latest_count() {
        // 3 replicas for 5 h, then 1: the model runs 1, as the system does now
        let d = history(vec![Some(1.0); 960], series_of(&[(0, 3.0), (600, 1.0)], 960));
        let m = crate::calibrate::calibrate(&d, &crate::calibrate::CalibrateOptions { bootstrap: Some(0.0), ..Default::default() });
        let s = &m.services["api"];
        assert_eq!(s.replicas, 1.0);
        assert_eq!(s.fit.regime.as_ref().unwrap().settings["replicas"], 1.0);
        // the same history without the change carries no regime
        let d = history(vec![Some(1.0); 960], vec![Some(1.0); 960]);
        let m = crate::calibrate::calibrate(&d, &crate::calibrate::CalibrateOptions { bootstrap: Some(0.0), ..Default::default() });
        assert!(m.services["api"].fit.regime.is_none());
    }

    #[test]
    fn a_rollback_returns_to_the_earlier_configuration() {
        // CPU limit 0.5 → 1 for 2 h → 0.5 again: two configurations, the latest spans both ends
        let n = 960;
        let s = ServiceSeries { rps: Some(busy(n)), cpu_limit_cores: Some(series_of(&[(0, 0.5), (300, 1.0), (540, 0.5)], n)), ..Default::default() };
        let r = detect(&s, n, 30.0, false);
        assert_eq!(r.configurations.len(), 2);
        assert_eq!(r.configurations[r.chosen].spans, vec![[0, 300], [540, 960]]);
        assert_eq!(r.basis, "latest");
        // a 2-minute blip is a rollout, not a configuration
        let s = ServiceSeries { rps: Some(busy(n)), cpu_limit_cores: Some(series_of(&[(0, 0.5), (300, 1.0), (304, 0.5)], n)), ..Default::default() };
        assert!(!detect(&s, n, 30.0, false).mixed());
    }
}
