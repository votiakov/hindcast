//! Drift: has the system changed under its calibration? The calibrated relations (CPU per request
//! above the fixed CPU, self time and memory per replica) are read on a recent window and on the
//! calibration's own window at the load both of them saw, and compared.
//!
//! CPU per request is what verdicts rest on, so it is the one judged. Per bucket it is the CPU above
//! the calibrated fixed CPU, per request, (cpu − replicas·base) / requests; each window gives a median
//! and its spread, and a bootstrap of the two windows' buckets says how sure the change is. A change
//! is drift only past DRIFT_THRESHOLD and MIN_MILLICORES, which come from how much back-to-back
//! recordings of the same system differ (reference/k8s/shop). Self time and memory are reported
//! beside it, not judged: between such recordings they moved by more than CPU did.

#[allow(unused_imports)]
use crate::fmath::JsMath;
use crate::backtest::{js_sort_by, quantile, rng};
use crate::dataset::{Dataset, ServiceSeries};
use crate::math::{js_num, js_round, js_to_fixed};
use crate::model::{CpuModel, Model, ServiceModel};
use crate::types::Num;
use serde::Serialize;

/// A change in CPU per request this large is drift. Between back-to-back recordings of the same
/// system (under 2 h apart, the services neither run changed; reference/k8s/shop, 17 pairs, 97
/// readings) CPU per request moved by 6% at the median and 22% at the 95th percentile, and by up to
/// 23% where the change was worth MIN_MILLICORES or more (29% below that). 25% is past all of them
pub const DRIFT_THRESHOLD: f64 = 0.25;
/// ... and the change is worth this much CPU per replica (millicores) at the busiest load both
/// windows saw: below it, a service's CPU is a few millicores and the reading is the measurement's
/// noise (back-to-back, the only changes past 25% were currency's and checkout's, 3–5 millicores)
pub const MIN_MILLICORES: f64 = 5.0;
/// buckets each window needs at the shared load before a median is read off it
pub const MIN_BUCKETS: usize = 10;
const DRAWS: usize = 200;
const GIB: f64 = 1073741824.0;

#[derive(Clone, Debug, Default)]
pub struct DriftOptions {
    pub threshold: Option<f64>,
    pub seed: Option<f64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
    pub median: f64,
    pub p25: f64,
    pub p75: f64,
    pub buckets: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Relation {
    /// what the numbers are in
    pub unit: String,
    pub calibrated: Option<Estimate>,
    pub recent: Option<Estimate>,
    /// recent against calibrated, −0.3 for 30% less
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change: Option<f64>,
    /// the change's 10–90% range over bootstrap draws of both windows' buckets
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval: Option<[f64; 2]>,
}

/// the recent window's buckets busier than any the calibration saw: CPU there against the calibrated
/// line (fixed CPU + CPU per request × load), which is extrapolated at that load
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PastHistory {
    pub buckets: usize,
    /// req/s per replica the calibration's busiest bucket carried
    pub above_rps: f64,
    pub change: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDrift {
    pub service: String,
    /// "matches", "drifted" or "not enough recent load to tell"
    pub verdict: String,
    /// the change in CPU per request where the verdict is drifted or matches
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change: Option<f64>,
    /// the load per replica both windows saw (req/s), where the relations are compared
    #[serde(skip_serializing_if = "Option::is_none")]
    pub band: Option<[f64; 2]>,
    pub cpu_per_request: Relation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub self_time: Option<Relation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory: Option<Relation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub past_history: Option<PastHistory>,
    pub said: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DriftReport {
    pub threshold: f64,
    /// "the calibration's data" (both windows read the same way) or "the fitted line" (no calibration
    /// data: the recent window against the model's CPU per request)
    pub against: String,
    pub services: Vec<ServiceDrift>,
    pub drifted: Vec<String>,
    /// services not compared, and why
    pub skipped: Vec<String>,
}

/// one bucket of a window: load per replica, CPU per request above the fixed CPU (ms), self time
/// (ms) and memory per replica (MiB) where collected
struct Point {
    x: f64,
    cpu_ms: f64,
    self_ms: Option<f64>,
    mem_mib: Option<f64>,
}

fn at(a: Option<&Vec<Num>>, i: usize) -> Option<f64> {
    a.and_then(|v| v.get(i).copied().flatten()).filter(|x| x.is_finite())
}

fn sorted(xs: &[f64]) -> Vec<f64> {
    let mut s = xs.to_vec();
    js_sort_by(&mut s, |a, b| a - b);
    s
}

fn median(xs: &[f64]) -> f64 {
    quantile(&sorted(xs), 0.5)
}

fn estimate(xs: &[f64]) -> Option<Estimate> {
    if xs.is_empty() {
        return None;
    }
    let s = sorted(xs);
    Some(Estimate { median: quantile(&s, 0.5), p25: quantile(&s, 0.25), p75: quantile(&s, 0.75), buckets: s.len() })
}

/// errors at which a bucket is failing: its CPU is then the failure's (timeouts, retries, work
/// abandoned), not what the requests cost
const FAILING: f64 = 0.05;

/// buckets where the system was failing its users: an endpoint, or a service requests enter through,
/// erring at FAILING or more (a service further in can err all the time and the users not see it)
fn failing(d: &Dataset) -> Vec<bool> {
    let n = d.n.max(0.0) as usize;
    let entry: Vec<&ServiceSeries> = d.services.iter().filter(|(id, _)| d.endpoints.values().any(|e| &e.service == *id)).map(|x| x.1).collect();
    (0..n).map(|i| d.endpoints.values().any(|e| at(e.error_rate.as_ref(), i).unwrap_or(0.0) >= FAILING) || entry.iter().any(|s| at(s.error_rate.as_ref(), i).unwrap_or(0.0) >= FAILING)).collect()
}

/// the buckets of a service a CPU comparison can read: the system not failing, load per replica where
/// the load's CPU is at least the fixed CPU (below it the fixed CPU's noise is most of the reading),
/// and CPU under 90% of the limit (pinned at the limit, CPU says what it was allowed, not what the
/// requests cost)
fn points(s: &ServiceSeries, sm: &ServiceModel, c: &CpuModel, bad: &[bool]) -> Vec<Point> {
    let mut out = vec![];
    for i in 0..bad.len() {
        if bad[i] {
            continue;
        }
        let (cpu, l) = match (at(s.cpu_cores.as_ref(), i), at(s.rps.as_ref(), i)) {
            (Some(cpu), Some(l)) if l > 0.0 => (cpu, l),
            _ => continue,
        };
        let r = at(s.replicas.as_ref(), i).unwrap_or(sm.replicas);
        if !(r > 0.0) {
            continue;
        }
        let x = l / r;
        if c.per_req * x < c.base {
            continue;
        }
        if let Some(lim) = at(s.cpu_limit_cores.as_ref(), i).or(sm.cpu_limit).filter(|l| *l > 0.0) {
            if cpu / r >= 0.9 * lim {
                continue;
            }
        }
        let mem = at(s.memory_max_bytes.as_ref(), i).filter(|m| *m > 0.0).or_else(|| at(s.memory_bytes.as_ref(), i).filter(|m| *m > 0.0).map(|m| m / r));
        out.push(Point { x, cpu_ms: (cpu / r - c.base) / x * 1000.0, self_ms: at(s.self_mean_ms.as_ref(), i).filter(|v| *v > 0.0), mem_mib: mem.map(|m| m / GIB * 1024.0) });
    }
    out
}

/// recent against calibrated as a median ratio, and its 10–90% range over draws of both sets
fn compare(cal: &[f64], recent: &[f64], rand: &mut impl FnMut() -> f64) -> (f64, [f64; 2]) {
    let change = median(recent) / median(cal) - 1.0;
    let pick = |xs: &[f64], rand: &mut dyn FnMut() -> f64| -> Vec<f64> { (0..xs.len()).map(|_| xs[((rand() * xs.len() as f64) as usize).min(xs.len() - 1)]).collect() };
    let mut draws: Vec<f64> = (0..DRAWS).map(|_| median(&pick(recent, rand)) / median(&pick(cal, rand)) - 1.0).collect();
    js_sort_by(&mut draws, |a, b| a - b);
    (change, [quantile(&draws, 0.1), quantile(&draws, 0.9)])
}

fn relation(unit: &str, cal: &[f64], recent: &[f64], rand: &mut impl FnMut() -> f64) -> Option<Relation> {
    if cal.len() < MIN_BUCKETS || recent.len() < MIN_BUCKETS {
        return None;
    }
    let (change, interval) = compare(cal, recent, rand);
    Some(Relation { unit: unit.into(), calibrated: estimate(cal), recent: estimate(recent), change: Some(change), interval: Some(interval) })
}

/// "27% less", "12% more"
pub fn change_words(c: f64) -> String {
    format!("{}% {}", js_num(js_round(c.abs() * 100.0)), if c < 0.0 { "less" } else { "more" })
}

fn ms(x: f64) -> String {
    js_to_fixed(x, if x < 1.0 { 3 } else { 2 })
}

/// compare a model's calibrated relations with a recent window. `calibration` is the data the model
/// was fitted on; without it the recent window is read against the model's CPU per request alone
pub fn drift(m: &Model, calibration: Option<&Dataset>, recent: &Dataset, o: &DriftOptions) -> DriftReport {
    let threshold = o.threshold.unwrap_or(DRIFT_THRESHOLD);
    let mut rand = rng(o.seed.unwrap_or(1.0));
    let mut services = vec![];
    let mut skipped = vec![];
    let recent_bad = failing(recent);
    let cal_bad = calibration.map(failing).unwrap_or_default();
    for (id, sm) in &m.services {
        if sm.kind == "external" || sm.hosted_by.is_some() {
            continue;
        }
        let c = match &sm.cpu {
            Some(c) if c.per_req > 0.0 && c.r2 >= 0.3 => c,
            Some(_) => {
                skipped.push(format!("{}: its CPU doesn't follow load in the calibration, so there is no CPU per request to compare", id));
                continue;
            }
            None => continue,
        };
        let rs = match recent.services.get(id).filter(|s| s.cpu_cores.is_some() && s.rps.is_some()) {
            Some(s) => s,
            None => {
                skipped.push(format!("{}: not in the recent window (no CPU or requests)", id));
                continue;
            }
        };
        let rp = points(rs, sm, c, &recent_bad);
        let cp = calibration.and_then(|d| d.services.get(id)).map(|s| points(s, sm, c, &cal_bad));
        // the load both windows saw; without the calibration's data, all of the recent window's
        let band = match &cp {
            Some(cp) if !cp.is_empty() && !rp.is_empty() => {
                let lo = |p: &[Point]| p.iter().fold(f64::INFINITY, |a, q| a.min(q.x));
                let hi = |p: &[Point]| p.iter().fold(f64::NEG_INFINITY, |a, q| a.max(q.x));
                Some([lo(cp).max(lo(&rp)), hi(cp).min(hi(&rp))])
            }
            _ => None,
        };
        let inside = |p: &Point| band.map(|[lo, hi]| p.x >= lo && p.x <= hi).unwrap_or(cp.is_none());
        let r_in: Vec<&Point> = rp.iter().filter(|p| inside(p)).collect();
        let c_in: Vec<&Point> = cp.as_ref().map(|cp| cp.iter().filter(|p| inside(p)).collect()).unwrap_or_default();
        let r_cpu: Vec<f64> = r_in.iter().map(|p| p.cpu_ms).collect();
        let c_cpu: Vec<f64> = c_in.iter().map(|p| p.cpu_ms).collect();
        let fitted_ms = c.per_req * 1000.0;
        let enough = r_cpu.len() >= MIN_BUCKETS && (cp.is_none() || c_cpu.len() >= MIN_BUCKETS);
        let (cpu_rel, change) = if !enough {
            (Relation { unit: "ms of CPU per request".into(), calibrated: if cp.is_some() { estimate(&c_cpu) } else { Some(Estimate { median: fitted_ms, p25: fitted_ms, p75: fitted_ms, buckets: 0 }) }, recent: estimate(&r_cpu), change: None, interval: None }, None)
        } else if cp.is_some() {
            let r = relation("ms of CPU per request", &c_cpu, &r_cpu, &mut rand).unwrap();
            let ch = r.change;
            (r, ch)
        } else {
            // against the fitted line: only the recent window is drawn
            let change = median(&r_cpu) / fitted_ms - 1.0;
            let mut draws: Vec<f64> = (0..DRAWS).map(|_| median(&(0..r_cpu.len()).map(|_| r_cpu[((rand() * r_cpu.len() as f64) as usize).min(r_cpu.len() - 1)]).collect::<Vec<_>>()) / fitted_ms - 1.0).collect();
            js_sort_by(&mut draws, |a, b| a - b);
            (Relation { unit: "ms of CPU per request".into(), calibrated: Some(Estimate { median: fitted_ms, p25: fitted_ms, p75: fitted_ms, buckets: 0 }), recent: estimate(&r_cpu), change: Some(change), interval: Some([quantile(&draws, 0.1), quantile(&draws, 0.9)]) }, Some(change))
        };
        let self_time = if cp.is_some() {
            let pick = |ps: &[&Point]| ps.iter().filter_map(|p| p.self_ms).collect::<Vec<_>>();
            relation("ms of self time", &pick(&c_in), &pick(&r_in), &mut rand)
        } else {
            None
        };
        let memory = if cp.is_some() {
            let pick = |ps: &[&Point]| ps.iter().filter_map(|p| p.mem_mib).collect::<Vec<_>>();
            relation("MiB per replica", &pick(&c_in), &pick(&r_in), &mut rand)
        } else {
            None
        };
        let past_history = band.and_then(|[_, hi]| {
            let above: Vec<f64> = rp.iter().filter(|p| p.x > hi).map(|p| (c.base + (p.cpu_ms / 1000.0) * p.x) / (c.base + c.per_req * p.x)).collect();
            if above.len() < MIN_BUCKETS {
                return None;
            }
            Some(PastHistory { buckets: above.len(), above_rps: hi, change: median(&above) - 1.0 })
        });
        let interval = cpu_rel.interval;
        let (cal_ms, rec_ms) = (cpu_rel.calibrated.as_ref().map(|e| e.median), cpu_rel.recent.as_ref().map(|e| e.median));
        // what the change is worth per replica at the busiest load compared, in millicores
        let busiest = band.map(|b| b[1]).unwrap_or_else(|| r_in.iter().fold(0.0, |a, p| a.max(p.x)));
        let worth = match (cal_ms, rec_ms) {
            (Some(a), Some(b)) => (b - a).abs() * busiest,
            _ => 0.0,
        };
        let verdict = match (change, interval) {
            (Some(ch), Some([lo, hi])) if ch.abs() > threshold && worth >= MIN_MILLICORES && (lo > 0.0 || hi < 0.0) => "drifted",
            (Some(ch), _) if ch.abs() <= threshold || worth < MIN_MILLICORES => "matches",
            _ => "not enough recent load to tell",
        };
        let at_load = band.map(|[lo, hi]| format!(" at {}–{} req/s per replica", js_num(js_round(lo)), js_num(js_round(hi)))).unwrap_or_default();
        let said = match (verdict, change, interval) {
            ("drifted", Some(ch), Some([lo, hi])) => format!(
                "{} now costs {} CPU per request than when calibrated: {} → {} ms{} (10–90%: {} … {}), more than the {}% back-to-back recordings of the same system differ by",
                id,
                change_words(ch),
                ms(cal_ms.unwrap()),
                ms(rec_ms.unwrap()),
                at_load,
                pct_signed(lo),
                pct_signed(hi),
                js_num(js_round(threshold * 100.0))
            ),
            ("matches", Some(ch), _) if ch.abs() > threshold => format!(
                "{}: CPU per request {} → {} ms{} ({}), but that is {} millicores per replica at its busiest, under the {} a reading resolves: it matches as far as can be told",
                id,
                ms(cal_ms.unwrap()),
                ms(rec_ms.unwrap()),
                at_load,
                pct_signed(ch),
                js_to_fixed(worth, 1),
                js_num(MIN_MILLICORES)
            ),
            ("matches", Some(ch), _) => format!("{}: CPU per request matches the calibration, {} → {} ms{} ({}, within the {}% back-to-back recordings of the same system differ by)", id, ms(cal_ms.unwrap()), ms(rec_ms.unwrap()), at_load, pct_signed(ch), js_num(js_round(threshold * 100.0))),
            (_, Some(ch), Some([lo, hi])) => format!("{}: not enough recent load to tell: CPU per request {} → {} ms{} ({}), but the 10–90% range ({} … {}) takes in no change", id, ms(cal_ms.unwrap()), ms(rec_ms.unwrap()), at_load, pct_signed(ch), pct_signed(lo), pct_signed(hi)),
            _ => {
                if r_cpu.len() < MIN_BUCKETS {
                    format!("{}: not enough recent load to tell: {} buckets of the recent window at the load the calibration saw, {} needed", id, r_cpu.len(), MIN_BUCKETS)
                } else {
                    format!("{}: not enough recent load to tell: the calibration has {} buckets at the load the recent window saw, {} needed", id, c_cpu.len(), MIN_BUCKETS)
                }
            }
        };
        let said = match &past_history {
            Some(p) => format!("{}; busier than the calibration ever was (over {} req/s per replica, {} buckets), CPU runs {} than the calibrated line predicts, a line extrapolated there", said, js_num(js_round(p.above_rps)), p.buckets, change_words(p.change)),
            None => said,
        };
        services.push(ServiceDrift { service: id.clone(), verdict: verdict.into(), change: if verdict == "not enough recent load to tell" { None } else { change }, band, cpu_per_request: cpu_rel, self_time, memory, past_history, said });
    }
    let drifted = services.iter().filter(|s| s.verdict == "drifted").map(|s| s.service.clone()).collect();
    DriftReport { threshold, against: if calibration.is_some() { "the calibration's data".into() } else { "the fitted line".into() }, services, drifted, skipped }
}

/// "+12%", "−7%"
pub fn pct_signed(x: f64) -> String {
    let r = js_round(x * 100.0);
    format!("{}{}%", if r > 0.0 { "+" } else if r < 0.0 { "−" } else { "" }, js_num(r.abs()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn series(n: usize, load: impl Fn(usize) -> f64, per_req: f64) -> ServiceSeries {
        let mut s = ServiceSeries::default();
        // a little noise, the same every run
        let mut r = rng(7.0);
        s.rps = Some((0..n).map(|i| Some(load(i))).collect());
        s.replicas = Some(vec![Some(2.0); n]);
        s.cpu_cores = Some((0..n).map(|i| Some(2.0 * 0.02 + load(i) * per_req * (0.97 + 0.06 * r()))).collect());
        s
    }

    fn model(per_req: f64) -> Model {
        let mut m: Model = serde_json::from_value(serde_json::json!({ "version": 1, "name": "t", "timeoutMs": 5000, "slo": { "p99Ms": 500, "errorRate": 0.01 }, "services": {}, "endpoints": {}, "transfer": {}, "unattributedPerHour": 0, "accuracy": [] })).unwrap();
        let sm: ServiceModel = serde_json::from_value(serde_json::json!({ "id": "api", "kind": "service", "replicas": 2, "cpuLimit": 1, "capacity": { "limit": "cpu", "servers": 1, "perReplicaRps": 400 }, "self": { "mean": 2, "p99": 5 }, "tail": 2, "cost": { "perReplicaHour": 0, "perRequest": 0, "cpuShare": 0.8, "arch": "x86", "source": "none" }, "fit": { "status": "good", "notes": [] } })).unwrap();
        m.services.insert("api".into(), ServiceModel { cpu: Some(CpuModel { base: 0.02, per_req, r2: 0.9 }), ..sm });
        m
    }

    fn dataset(s: ServiceSeries, n: usize) -> Dataset {
        let mut d: Dataset = serde_json::from_value(serde_json::json!({ "version": 1, "name": "d", "start": 0, "stepS": 60, "n": n, "services": {}, "endpoints": {} })).unwrap();
        d.services.insert("api".into(), s);
        d
    }

    #[test]
    fn the_same_cost_matches_and_a_third_less_is_drift() {
        let n = 60;
        let cal = dataset(series(n, |i| 40.0 + i as f64, 0.002), n);
        let same = dataset(series(n, |i| 30.0 + i as f64 * 1.5, 0.002), n);
        let cheaper = dataset(series(n, |i| 30.0 + i as f64 * 1.5, 0.0014), n);
        let m = model(0.002);
        let r = drift(&m, Some(&cal), &same, &DriftOptions::default());
        assert_eq!(r.services[0].verdict, "matches", "{}", r.services[0].said);
        assert!(r.drifted.is_empty());
        let r = drift(&m, Some(&cal), &cheaper, &DriftOptions::default());
        let s = &r.services[0];
        assert_eq!(s.verdict, "drifted", "{}", s.said);
        assert!((s.change.unwrap() + 0.3).abs() < 0.03, "{:?}", s.change);
        assert!(s.said.starts_with("api now costs 30% less CPU per request than when calibrated"), "{}", s.said);
        assert_eq!(r.drifted, vec!["api".to_string()]);
        // busier than the calibration: read against the line there, and said
        assert!(s.past_history.is_some(), "{}", s.said);
        // without the calibration's data: against the fitted line
        let r = drift(&m, None, &cheaper, &DriftOptions::default());
        assert_eq!(r.against, "the fitted line");
        assert_eq!(r.services[0].verdict, "drifted");
    }

    #[test]
    fn a_quiet_recent_window_is_not_enough_to_tell() {
        let n = 60;
        let cal = dataset(series(n, |i| 40.0 + i as f64, 0.002), n);
        // below the fixed CPU's share: nothing to read CPU per request from
        let quiet = dataset(series(n, |_| 5.0, 0.0014), n);
        let r = drift(&model(0.002), Some(&cal), &quiet, &DriftOptions::default());
        assert_eq!(r.services[0].verdict, "not enough recent load to tell");
        assert!(r.services[0].said.contains("0 buckets of the recent window"), "{}", r.services[0].said);
    }
}
