//! How good is the model (src/backtest/accuracy.ts)? Every claim is checked against something measured:
//!
//!  - holdout: calibrate on the first part of the history, predict the rest, compare
//!  - reference: predict a run that really happened under a change and compare with what was recorded
//!
//! The same definitions are used for predicted and measured series, so they compare like for like.

#[allow(unused_imports)]
use crate::fmath::JsMath;
use crate::backtest::{base_plan, draw_plan, js_max, js_sort_by, observed_replicas, quantile, rng, traffic_of};
use crate::calibrate::{calibrate, CalibrateOptions};
use crate::dataset::{Dataset, ServiceSeries};
use crate::engine::run_plan;
use crate::math::{js_num, js_round, js_to_fixed, mixture_quantile, Part};
use crate::model::Model;
use crate::strategy::{apply_strategy, locale_int, parse_strategy};
use crate::types::{Map, Num, Opts, Plan, RunResult, Traffic};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const TOL_P99: f64 = 0.2;
pub const TOL_BREAKING_POINT: f64 = 0.15;
pub const TOL_COST: f64 = 0.1;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AccuracyCheck {
    pub metric: String,
    pub predicted: f64,
    pub measured: f64,
    pub error: f64,
    pub tolerance: f64,
    pub pass: bool,
    pub note: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AccuracyRecord {
    pub method: String,
    pub label: String,
    pub checks: Vec<AccuracyCheck>,
    pub measured_at: String,
}

/// the time now, as Date.prototype.toISOString writes it
pub fn now_iso() -> String {
    #[cfg(target_arch = "wasm32")]
    {
        String::from(js_sys::Date::new_0().to_iso_string())
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        iso_of_ms(ms)
    }
}

/// epoch milliseconds → 2026-10-14T09:57:01.088Z
pub fn iso_of_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let milli = ms.rem_euclid(1000);
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    // civil from days (Howard Hinnant)
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", y, m, d, rem / 3600, (rem % 3600) / 60, rem % 60, milli)
}

/// ISO 8601 date-time (2019-07-02T13:30:00Z, 2021-01-04T05:30:00-08:00) → epoch milliseconds
pub fn parse_iso_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    let num = |a: usize, n: usize| -> Option<i64> { s.get(a..a + n)?.parse().ok() };
    let (y, mo, d) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    if b.get(4) != Some(&b'-') || b.get(7) != Some(&b'-') {
        return None;
    }
    let (mut h, mut mi, mut sec, mut ms) = (0, 0, 0, 0);
    let mut i = 10;
    if b.get(10) == Some(&b'T') || b.get(10) == Some(&b' ') {
        h = num(11, 2)?;
        mi = num(14, 2)?;
        i = 16;
        if b.get(16) == Some(&b':') {
            sec = num(17, 2)?;
            i = 19;
            if b.get(19) == Some(&b'.') {
                let mut j = 20;
                let mut frac = String::new();
                while j < b.len() && b[j].is_ascii_digit() {
                    frac.push(b[j] as char);
                    j += 1;
                }
                ms = format!("{:0<3}", &frac[..frac.len().min(3)]).parse().unwrap_or(0);
                i = j;
            }
        }
    }
    let offset_min: i64 = match b.get(i) {
        None | Some(b'Z') => 0,
        Some(b'+') | Some(b'-') => {
            let sign = if b[i] == b'-' { -1 } else { 1 };
            let oh = num(i + 1, 2)?;
            let om = if b.get(i + 3) == Some(&b':') { num(i + 4, 2)? } else { num(i + 3, 2).unwrap_or(0) };
            sign * (oh * 60 + om)
        }
        _ => return None,
    };
    // days from civil (Howard Hinnant)
    let yy = if mo <= 2 { y - 1 } else { y };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let mp = if mo > 2 { mo - 3 } else { mo + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(((days * 86400 + h * 3600 + mi * 60 + sec) - offset_min * 60) * 1000 + ms)
}

pub struct Obs {
    pub rps: Vec<Num>,
    pub p99_ms: Vec<Num>,
    pub error_rate: Vec<Num>,
}

/// total measured client series of a dataset (sum of endpoints)
pub fn client_series(d: &Dataset) -> Obs {
    let n = d.n.max(0.0) as usize;
    let (mut rps, mut p99, mut err) = (vec![], vec![], vec![]);
    let at = |s: &Option<Vec<Num>>, i: usize| s.as_ref().and_then(|v| v.get(i).copied().flatten());
    for i in 0..n {
        let (mut r, mut e, mut p, mut w, mut any) = (0.0, 0.0, 0.0, 0.0, false);
        for s in d.endpoints.values() {
            let v = match at(&s.rps, i) {
                Some(v) => v,
                None => continue,
            };
            any = true;
            r += v;
            e += v * at(&s.error_rate, i).unwrap_or(0.0);
            p += v * at(&s.p99_ms, i).unwrap_or(0.0);
            w += v;
        }
        rps.push(if any { Some(r) } else { None });
        err.push(if any { Some(if r > 0.0 { e / r } else { 0.0 }) } else { None });
        p99.push(if any && w > 0.0 { Some(p / w) } else { None });
    }
    Obs { rps, p99_ms: p99, error_rate: err }
}

/// typical per-bucket error: median of |pred − obs| / obs over buckets with traffic
pub fn median_ape(pred: &[f64], obs: &[Num], min_obs: f64) -> f64 {
    let mut e = vec![];
    for i in 0..obs.len() {
        let o = match obs[i] {
            Some(o) if o >= min_obs => o,
            _ => continue,
        };
        if !pred[i].is_finite() {
            continue;
        }
        e.push((pred[i] - o).abs() / o);
    }
    js_sort_by(&mut e, |a, b| a - b);
    if e.is_empty() {
        f64::NAN
    } else {
        e[e.len() / 2]
    }
}

fn avg(xs: &[Num]) -> f64 {
    let (mut s, mut k) = (0.0, 0usize);
    for x in xs.iter().flatten() {
        if x.is_finite() {
            s += x;
            k += 1;
        }
    }
    if k > 0 {
        s / k as f64
    } else {
        f64::NAN
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct Plateau {
    pub rps: f64,
    pub score: f64,
}

/// breaking point from a step load test: plateaus of steady load scored by how far past the SLO they are
pub fn breaking_point_of(s: &Obs, slo_p99: f64, slo_err: f64) -> (f64, Vec<Plateau>) {
    let mut plateaus = vec![];
    let mut cur: Vec<usize> = vec![];
    let flush = |cur: &mut Vec<usize>, plateaus: &mut Vec<Plateau>| {
        if cur.len() >= 3 {
            let tail = &cur[cur.len() / 2..];
            let rps = avg(&tail.iter().map(|&i| s.rps[i]).collect::<Vec<_>>());
            let p99 = avg(&tail.iter().map(|&i| s.p99_ms[i]).collect::<Vec<_>>());
            let err = avg(&tail.iter().map(|&i| s.error_rate[i]).collect::<Vec<_>>());
            plateaus.push(Plateau { rps, score: js_max(p99 / slo_p99, [err / slo_err]) });
        }
        cur.clear();
    };
    for i in 0..s.rps.len() {
        let r = match s.rps[i] {
            Some(r) if r > 0.0 => r,
            _ => continue,
        };
        if let Some(&c0) = cur.first() {
            let r0 = s.rps[c0].unwrap();
            if (r - r0).abs() / r0 > 0.08 {
                flush(&mut cur, &mut plateaus);
            }
        }
        cur.push(i);
    }
    flush(&mut cur, &mut plateaus);
    (crossing(&plateaus), plateaus)
}

/// where the SLO score (≤ 1 = within SLO) crosses 1, interpolated log-linearly between plateaus
pub fn crossing(input: &[Plateau]) -> f64 {
    let mut p = input.to_vec();
    js_sort_by(&mut p, |a, b| a.rps - b.rps);
    let mut first = p.len() as i64;
    while first > 0 && p[(first - 1) as usize].score > 1.0 {
        first -= 1;
    }
    if first == p.len() as i64 {
        first = -1;
    }
    if first < 0 {
        return p.last().map(|x| x.rps).unwrap_or(0.0);
    }
    if first == 0 {
        return p[0].rps;
    }
    let a = p[(first - 1) as usize];
    let b = p[first as usize];
    let la = a.score.max(1e-6).js_ln();
    let lb = b.score.max(1e-6).js_ln();
    let f = if lb > la { (0.0 - la) / (lb - la) } else { 0.0 };
    a.rps + f.min(1.0).max(0.0) * (b.rps - a.rps)
}

/// every request a load generator (or an access log) recorded
#[derive(Deserialize, Clone, Debug, Default)]
pub struct RequestLog {
    pub t: Vec<f64>,
    pub ms: Vec<f64>,
    pub failed: Vec<bool>,
}

fn predicted_p99(r: &RunResult, i0: usize, i1: usize) -> f64 {
    let mut parts = vec![];
    for e in r.endpoints.values() {
        for i in i0..i1 {
            if e.rps[i] > 0.0 {
                parts.push(Part { w: e.rps[i], mean: e.mean_ms[i], p99: e.p99_ms[i], p50: if e.p50_ms[i] > 0.0 && e.p99_ms[i] < 4000.0 { Some(e.p50_ms[i]) } else { None }, p90: None });
            }
        }
    }
    mixture_quantile(&parts, 0.01)
}

fn predicted_err(r: &RunResult, i0: usize, i1: usize) -> f64 {
    let (mut n, mut f) = (0.0, 0.0);
    for i in i0..i1 {
        n += r.rps[i];
        f += r.rps[i] * r.error_rate[i];
    }
    if n > 0.0 {
        f / n
    } else {
        0.0
    }
}

struct Measured {
    n: usize,
    p99: f64,
    err: f64,
    dur: f64,
}

fn measured_in(log: &RequestLog, a: f64, b: f64) -> Measured {
    let mut ms = vec![];
    let mut failed = 0usize;
    for k in 0..log.t.len() {
        if log.t[k] >= a && log.t[k] < b {
            ms.push(log.ms[k]);
            if log.failed[k] {
                failed += 1;
            }
        }
    }
    js_sort_by(&mut ms, |x, y| x - y);
    let n = ms.len();
    Measured { n, p99: if n > 0 { quantile(&ms, 0.99) } else { f64::NAN }, err: if n > 0 { failed as f64 / n as f64 } else { f64::NAN }, dur: b - a }
}

pub struct Pooled {
    pub measured: f64,
    pub predicted: f64,
    pub n: usize,
}

/// p99 over every request of the whole run, predicted vs measured
pub fn pooled_p99(r: &RunResult, log: &RequestLog, start: f64, step_s: f64) -> Pooled {
    let end = start + r.t.len() as f64 * step_s;
    let m = measured_in(log, start, end);
    Pooled { measured: m.p99, predicted: predicted_p99(r, 0, r.t.len()), n: m.n }
}

pub struct WindowRow {
    pub t: f64,
    pub measured: f64,
    pub predicted: f64,
    pub n: usize,
    pub ape: f64,
}

/// p99 over every request in each window, predicted vs measured
pub fn window_p99(r: &RunResult, log: &RequestLog, start: f64, step_s: f64, window_s: f64) -> (Vec<WindowRow>, f64, f64) {
    let per = js_round(window_s / step_s).max(1.0) as usize;
    let mut rows = vec![];
    let mut i0 = 0;
    while i0 + per <= r.t.len() {
        let a = start + i0 as f64 * step_s;
        let m = measured_in(log, a, a + per as f64 * step_s);
        if m.n >= 200 {
            let p = predicted_p99(r, i0, i0 + per);
            rows.push(WindowRow { t: a, measured: m.p99, predicted: p, n: m.n, ape: (p - m.p99).abs() / m.p99 });
        }
        i0 += per;
    }
    let mut apes: Vec<f64> = rows.iter().map(|x| x.ape).collect();
    js_sort_by(&mut apes, |a, b| a - b);
    let median = if apes.is_empty() { f64::NAN } else { quantile(&apes, 0.5) };
    let max = apes.last().copied().unwrap_or(f64::NAN);
    (rows, median, max)
}

/// plateaus of a step load test, scored predicted and measured
pub fn plateau_breaking_point(r: &RunResult, log: &RequestLog, start: f64, step_s: f64, shape: &[(f64, f64)], slo_p99: f64, slo_err: f64) -> (f64, f64) {
    let (mut measured, mut predicted) = (vec![], vec![]);
    for k in 1..shape.len() {
        if shape[k].1 != shape[k - 1].1 || shape[k].0 - shape[k - 1].0 < 30.0 {
            continue;
        }
        let a = start + (shape[k - 1].0 + shape[k].0) / 2.0;
        let b = start + shape[k].0;
        let m = measured_in(log, a, b);
        if m.n == 0 {
            continue;
        }
        let i0 = ((a - start) / step_s).floor().max(0.0) as usize;
        let i1 = (((b - start) / step_s).ceil() as usize).min(r.t.len());
        let p99 = predicted_p99(r, i0, i1);
        let err = predicted_err(r, i0, i1);
        measured.push(Plateau { rps: m.n as f64 / m.dur, score: js_max(m.p99 / slo_p99, [m.err / slo_err]) });
        predicted.push(Plateau { rps: m.n as f64 / m.dur, score: js_max(p99 / slo_p99, [err / slo_err]) });
    }
    (crossing(&measured), crossing(&predicted))
}

fn as_obs(r: &RunResult) -> Obs {
    Obs { rps: r.rps.iter().map(|x| Some(*x)).collect(), p99_ms: r.p99_ms.iter().map(|x| Some(*x)).collect(), error_rate: r.error_rate.iter().map(|x| Some(*x)).collect() }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BreakingPoint {
    pub rps: f64,
    pub limited_by: Option<String>,
}

/// model-only breaking point: step the traffic up with the endpoint mix until the SLO breaks
pub fn model_breaking_point(model: &Model, plan: Option<&Plan>, max_rps: Option<f64>, steps: Option<f64>, hold_s: Option<f64>) -> BreakingPoint {
    let owned;
    let plan = match plan {
        Some(p) => p,
        None => {
            owned = base_plan(model, None);
            &owned
        }
    };
    let shares: Vec<(&String, f64)> = model.endpoints.iter().map(|(id, e)| (id, e.share)).collect();
    // capacity guess to size the ramp: the smallest per-service limit given visits
    let mut guess = f64::INFINITY;
    for (id, s) in &plan.services {
        if !s.per_replica_rps.is_finite() {
            continue;
        }
        let visits = shares.iter().fold(0.0, |a, (ep, sh)| a + sh * model.endpoints[*ep].visits.get(id).copied().unwrap_or(0.0));
        let host = s.hosted_by.clone().filter(|h| !h.is_empty()).unwrap_or_else(|| id.clone());
        let reps = s.replicas.or(model.services.get(&host).map(|m| m.replicas)).unwrap_or(1.0);
        if visits > 0.0 {
            guess = guess.min((s.per_replica_rps * reps) / visits);
        }
    }
    let top = max_rps.unwrap_or(if guess.is_finite() { guess * 2.0 } else { 10000.0 });
    let steps = steps.unwrap_or(40.0);
    let hold = hold_s.unwrap_or(60.0);
    let step_s = 10.0;
    let per = js_round(hold / step_s);
    let n = (steps * per) as usize;
    let rps_at = |i: usize| (top * ((i as f64 / per).floor() + 1.0)) / steps;
    let traffic = Traffic { start: 0.0, step_s, n: n as f64, endpoints: shares.iter().map(|(id, sh)| ((*id).clone(), (0..n).map(|i| Some(rps_at(i) * sh)).collect())).collect() };
    // fixed replica counts for the ramp; an in-process dependency runs in its host's replicas
    fn reps_of(id: &str, plan: &Plan, model: &Model) -> Option<f64> {
        let s = &plan.services[id];
        if let Some(h) = s.hosted_by.as_ref().filter(|h| !h.is_empty()) {
            if plan.services.contains_key(h) {
                return reps_of(h, plan, model);
            }
        }
        s.replicas.or(if s.autoscale.is_some() { None } else { Some(model.services.get(id).map(|m| m.replicas).unwrap_or(1.0)) })
    }
    let mut fixed = plan.clone();
    let ids: Vec<String> = fixed.services.keys().cloned().collect();
    for id in &ids {
        let r = reps_of(id, plan, model);
        let s = fixed.services.get_mut(id).unwrap();
        s.observed_replicas = None;
        s.replicas = r;
    }
    let r = run_plan(&fixed, &traffic, &Opts::default());
    let (bp, _) = breaking_point_of(&as_obs(&r), model.slo.p99_ms, model.slo.error_rate);
    // which service was saturated just past the breaking point
    let i = r.rps.iter().position(|x| *x > bp * 1.02);
    let mut limited_by: Option<String> = None;
    if let Some(i) = i {
        let mut best = 0.0;
        for (id, s) in &r.services {
            if s.util[i] > best {
                best = s.util[i];
                limited_by = Some(id.clone());
            }
        }
        // nothing saturated yet, but errors that grow with traffic crossed the error SLO
        if best < 0.85 && r.error_rate[i] > model.slo.error_rate && r.p99_ms[i] <= model.slo.p99_ms {
            let mut eps: Vec<&crate::model::EndpointModel> = model.endpoints.values().collect();
            js_sort_by(&mut eps, |a, b| b.error_slope.unwrap_or(0.0) * b.share - a.error_slope.unwrap_or(0.0) * a.share);
            let worst = eps.first();
            limited_by = Some(format!(
                "errors that grow with load{}",
                match worst.and_then(|w| w.error_slope.filter(|s| *s != 0.0 && !s.is_nan()).map(|s| (w, s))) {
                    Some((w, s)) => format!(" ({}: +{}% per req/s)", w.id, js_to_fixed(s * 100.0, 2)),
                    None => String::new(),
                }
            ));
        }
    }
    BreakingPoint { rps: bp, limited_by }
}

fn check(metric: &str, predicted: f64, measured: f64, tolerance: f64, note: String) -> AccuracyCheck {
    let error = if measured != 0.0 { (predicted - measured).abs() / measured.abs() } else if predicted == 0.0 { 0.0 } else { 1.0 };
    AccuracyCheck { metric: metric.into(), predicted, measured, error, tolerance, pass: error <= tolerance, note }
}

/// total $ in a dataset's bill (within the dataset window)
pub fn bill_total(d: &Dataset) -> Option<f64> {
    let b = d.bill.as_ref()?;
    let mut total = 0.0;
    for c in b.components.values() {
        for v in c.series.iter().flatten().flatten() {
            total += v;
        }
    }
    Some(total + b.unattributed)
}

/// where to split: the last `share` of the requests, not of the buckets
pub fn holdout_cut(d: &Dataset, share: f64) -> usize {
    let n = d.n.max(0.0) as usize;
    let by_buckets = (n as f64 * (1.0 - share)).floor() as usize;
    let mut per = vec![0.0; n];
    for e in d.endpoints.values() {
        if let Some(r) = &e.rps {
            for (i, v) in r.iter().enumerate() {
                if i < n {
                    per[i] += v.unwrap_or(0.0);
                } else {
                    per.push(v.unwrap_or(0.0));
                }
            }
        }
    }
    let total = per.iter().fold(0.0, |a, x| a + x);
    if !(total > 0.0) {
        return by_buckets;
    }
    let mut cum = 0.0;
    for i in 0..n {
        cum += per[i];
        if cum >= total * (1.0 - share) {
            return (i + 1).min(n.saturating_sub(1)).max(1);
        }
    }
    by_buckets
}

/// slice a dataset to buckets [from, to) (src/backtest/dataset.ts sliceDataset)
pub fn slice_dataset(d: &Dataset, from: usize, to: usize) -> Dataset {
    let cut = |a: &Option<Vec<Num>>| a.as_ref().map(|v| v[from.min(v.len())..to.min(v.len())].to_vec());
    let mut out = d.clone();
    out.services = d
        .services
        .iter()
        .map(|(id, s)| {
            (
                id.clone(),
                ServiceSeries {
                    order: s.order.clone(),
                    rps: cut(&s.rps),
                    done_rps: cut(&s.done_rps),
                    error_rate: cut(&s.error_rate),
                    p50_ms: cut(&s.p50_ms),
                    p95_ms: cut(&s.p95_ms),
                    p99_ms: cut(&s.p99_ms),
                    mean_ms: cut(&s.mean_ms),
                    self_mean_ms: cut(&s.self_mean_ms),
                    self_p99_ms: cut(&s.self_p99_ms),
                    cpu_cores: cut(&s.cpu_cores),
                    cpu_limit_cores: cut(&s.cpu_limit_cores),
                    replicas: cut(&s.replicas),
                    net_tx_bps: cut(&s.net_tx_bps),
                    net_rx_bps: cut(&s.net_rx_bps),
                    memory_bytes: cut(&s.memory_bytes),
                    memory_max_bytes: cut(&s.memory_max_bytes),
                    memory_limit_bytes: cut(&s.memory_limit_bytes),
                    cpu_request_cores: cut(&s.cpu_request_cores),
                    memory_request_bytes: cut(&s.memory_request_bytes),
                    cpu_throttled: cut(&s.cpu_throttled),
                },
            )
        })
        .collect();
    out.endpoints = d
        .endpoints
        .iter()
        .map(|(id, e)| (id.clone(), crate::dataset::EndpointSeries { order: e.order.clone(), service: e.service.clone(), rps: cut(&e.rps), error_rate: cut(&e.error_rate), p50_ms: cut(&e.p50_ms), p99_ms: cut(&e.p99_ms), mean_ms: cut(&e.mean_ms) }))
        .collect();
    // the bill's totals follow the slice: each component's spend scales with its share of the series
    if let Some(b) = &d.bill {
        let start = d.start + from as f64 * d.step_s;
        let end = d.start + (d.n.min(to as f64)) * d.step_s;
        let frac = ((end.min(b.end) - start.max(b.start)) / (b.end - b.start).max(1.0)).min(1.0).max(0.0);
        let mut nb = b.clone();
        let mut total = 0.0;
        for (k, c) in &b.components {
            let all = c.series.iter().flatten().fold(0.0, |a, v| a + v.unwrap_or(0.0));
            let part = cut(&c.series).iter().flatten().fold(0.0, |a, v| a + v.unwrap_or(0.0));
            let f = if c.series.is_some() { if all > 0.0 { part / all } else { 0.0 } } else { frac };
            let scale = |m: &Map<f64>| m.iter().map(|(k, v)| (k.clone(), v * f)).collect::<Map<f64>>();
            let nc = nb.components.get_mut(k).unwrap();
            nc.total = c.total * f;
            nc.by_category = scale(&c.by_category);
            nc.usage = scale(&c.usage);
            nc.series = cut(&c.series);
            total += c.total * f;
        }
        nb.start = start.max(b.start);
        nb.end = end.min(b.end);
        nb.unattributed = b.unattributed * frac;
        nb.total = total + b.unattributed * frac;
        out.bill = Some(nb);
    }
    if let Some(c) = &d.cluster {
        out.cluster = Some(crate::dataset::ClusterSeries {
            cluster_nodes: cut(&c.cluster_nodes),
            cluster_node_cpu: cut(&c.cluster_node_cpu),
            cluster_node_memory_bytes: cut(&c.cluster_node_memory_bytes),
            cluster_requested_cpu: cut(&c.cluster_requested_cpu),
            cluster_requested_memory_bytes: cut(&c.cluster_requested_memory_bytes),
        });
    }
    out.start = d.start + from as f64 * d.step_s;
    out.n = (d.n.min(to as f64) - from as f64).max(0.0);
    out
}

fn total_cost(r: &RunResult) -> f64 {
    let mut a = 0.0;
    for i in 0..r.cost.compute.len() {
        a = a + r.cost.compute[i] + r.cost.requests[i] + r.cost.transfer[i] + r.cost.other[i];
    }
    a
}

/// calibrate on the first part, predict the rest
pub fn holdout_accuracy(d: &Dataset, opts: &CalibrateOptions, holdout: Option<f64>, requests: Option<&RequestLog>) -> AccuracyRecord {
    let share = holdout.unwrap_or(0.3);
    let cut = holdout_cut(d, share);
    let train = slice_dataset(d, 0, cut);
    let test = slice_dataset(d, cut, d.n.max(0.0) as usize);
    let model = calibrate(&train, opts);
    let obs_reps = observed_replicas(&test, &model);
    let plan = base_plan(&model, Some(&obs_reps));
    let traffic = traffic_of(&test, &model);
    let r = run_plan(&plan, &traffic, &Opts::default());
    let obs = client_series(&test);
    let mut checks = vec![];
    let span = format!("on the last {} min, calibrated on the {} min before", js_num(js_round((test.n * test.step_s) / 60.0)), js_num(js_round((train.n * train.step_s) / 60.0)));
    let w = requests.map(|log| window_p99(&r, log, test.start, test.step_s, 300.0));
    match (requests, &w) {
        (Some(log), Some((rows, median, _))) if !rows.is_empty() => {
            // the point estimate can miss where the training part never saw the load; does the band hold it?
            let mut rnd = rng(11.0);
            let mut per: Vec<Vec<f64>> = rows.iter().map(|_| vec![]).collect();
            for k in 1..=20 {
                let rk = run_plan(&draw_plan(&plan, &model, k, &mut rnd), &traffic, &Opts::default());
                for (j, x) in window_p99(&rk, log, test.start, test.step_s, 300.0).0.iter().enumerate() {
                    if let Some(p) = per.get_mut(j) {
                        p.push(x.predicted);
                    }
                }
            }
            let inside = rows
                .iter()
                .enumerate()
                .filter(|(j, x)| {
                    let mut v = per[*j].clone();
                    v.push(x.predicted);
                    js_sort_by(&mut v, |a, b| a - b);
                    x.measured >= quantile(&v, 0.1) * 0.95 && x.measured <= quantile(&v, 0.9) * 1.05
                })
                .count();
            let pool = pooled_p99(&r, log, test.start, test.step_s);
            checks.push(check(
                "p99",
                pool.predicted,
                pool.measured,
                TOL_P99,
                format!(
                    "p99 of all {} requests {}; per 5-minute window the typical error is {}%, and the measurement fell inside the model's 10–90% band in {} of {} windows",
                    locale_int(pool.n as f64),
                    span,
                    js_to_fixed(median * 100.0, 0),
                    inside,
                    rows.len()
                ),
            ));
        }
        _ => {
            // per-bucket p99s decide pass/fail
            let ape = median_ape(&r.p99_ms, &obs.p99_ms, 1.0);
            if ape.is_finite() {
                let pred: Vec<Num> = r.p99_ms.iter().enumerate().map(|(i, x)| if obs.p99_ms[i].is_none() { None } else { Some(*x) }).collect();
                let mut c = check("p99", avg(&pred), avg(&obs.p99_ms), TOL_P99, format!("typical error per {}s bucket {}% {}", js_num(test.step_s), js_to_fixed(ape * 100.0, 0), span));
                c.error = ape;
                c.pass = ape <= TOL_P99;
                checks.push(c);
            }
        }
    }
    if let Some(bill) = bill_total(&test) {
        checks.push(check("cost", total_cost(&r), bill, TOL_COST, "model cost vs the bill over the held-out window".into()));
    }
    AccuracyRecord { method: "holdout".into(), label: format!("the last {}% of the requests", js_num(js_round(share * 100.0))), checks, measured_at: now_iso() }
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShapePoint {
    pub t: f64,
    pub rps: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceRun {
    pub label: String,
    pub dataset: Dataset,
    pub requests: Option<RequestLog>,
    pub shape: Option<Vec<ShapePoint>>,
    pub start: Option<f64>,
    pub strategy: Option<Value>,
    pub stress: Option<bool>,
}

/// predict recorded runs the model never saw
pub fn reference_accuracy(model: &Model, runs: &[ReferenceRun], label: &str) -> Result<AccuracyRecord, String> {
    let mut checks = vec![];
    for run in runs {
        let base = base_plan(model, None);
        let mut plan = match &run.strategy {
            Some(s) if !s.is_null() => apply_strategy(model, &base, &parse_strategy(s)?)?.plan,
            _ => base,
        };
        // fixed replica counts were applied for real: use the counts the run actually had
        let obs_reps = observed_replicas(&run.dataset, model);
        for (id, s) in plan.services.iter_mut() {
            if s.autoscale.is_none() {
                if let Some(Some(o)) = obs_reps.get(id) {
                    s.replicas = None;
                    s.observed_replicas = Some(o.clone());
                }
            }
        }
        let r = run_plan(&plan, &traffic_of(&run.dataset, model), &Opts::default());
        let obs = client_series(&run.dataset);
        let stress = run.stress == Some(true);
        let step = run.dataset.step_s;
        if stress && run.requests.is_some() && run.shape.is_some() {
            let shape: Vec<(f64, f64)> = run.shape.as_ref().unwrap().iter().map(|p| (p.t, p.rps)).collect();
            let (m, p) = plateau_breaking_point(&r, run.requests.as_ref().unwrap(), run.start.unwrap_or(run.dataset.start), step, &shape, model.slo.p99_ms, model.slo.error_rate);
            checks.push(check(
                "breaking-point",
                p,
                m,
                TOL_BREAKING_POINT,
                format!("{}: step load test, p99 and errors over every request of each plateau (SLO p99 ≤ {} ms, errors ≤ {}%)", run.label, js_num(model.slo.p99_ms), js_to_fixed(model.slo.error_rate * 100.0, 0)),
            ));
        } else if !stress && run.requests.is_some() {
            let log = run.requests.as_ref().unwrap();
            let pool = pooled_p99(&r, log, run.dataset.start, step);
            let (_, median, max) = window_p99(&r, log, run.dataset.start, step, 300.0);
            checks.push(check(
                "p99",
                pool.predicted,
                pool.measured,
                TOL_P99,
                format!("{}: p99 of all {} requests of the run; per 5-minute window the typical error is {}%, worst {}%", run.label, locale_int(pool.n as f64), js_to_fixed(median * 100.0, 0), js_to_fixed(max * 100.0, 0)),
            ));
            let failed_pred = (0..r.rps.len()).fold(0.0, |a, i| a + r.rps[i] * r.error_rate[i] * step);
            let failed_obs = log.failed.iter().filter(|x| **x).count() as f64;
            checks.push(AccuracyCheck { metric: "errors".into(), predicted: failed_pred, measured: failed_obs, error: if failed_obs > 0.0 { (failed_pred - failed_obs).abs() / failed_obs } else if failed_pred > 0.0 { 1.0 } else { 0.0 }, tolerance: f64::INFINITY, pass: true, note: format!("{}: failed requests (informational)", run.label) });
        } else if stress {
            let (m, _) = breaking_point_of(&obs, model.slo.p99_ms, model.slo.error_rate);
            let (p, _) = breaking_point_of(&as_obs(&r), model.slo.p99_ms, model.slo.error_rate);
            checks.push(check("breaking-point", p, m, TOL_BREAKING_POINT, format!("{}: step load test, SLO p99 ≤ {} ms and errors ≤ {}%", run.label, js_num(model.slo.p99_ms), js_to_fixed(model.slo.error_rate * 100.0, 0))));
        } else {
            let ape = median_ape(&r.p99_ms, &obs.p99_ms, 1.0);
            let pred: Vec<Num> = r.p99_ms.iter().enumerate().map(|(i, x)| if obs.p99_ms[i].is_none() { None } else { Some(*x) }).collect();
            let mut c = check("p99", avg(&pred), avg(&obs.p99_ms), TOL_P99, format!("{}: typical error per {}s bucket {}%", run.label, js_num(step), js_to_fixed(ape * 100.0, 0)));
            c.error = ape;
            c.pass = ape <= TOL_P99;
            checks.push(c);
            let failed_pred = (0..r.rps.len()).fold(0.0, |a, i| a + r.rps[i] * r.error_rate[i] * step);
            let failed_obs = (0..obs.rps.len()).fold(0.0, |a, i| a + obs.rps[i].unwrap_or(0.0) * obs.error_rate[i].unwrap_or(0.0) * step);
            checks.push(AccuracyCheck { metric: "errors".into(), predicted: failed_pred, measured: failed_obs, error: if failed_obs > 0.0 { (failed_pred - failed_obs).abs() / failed_obs } else if failed_pred > 0.0 { 1.0 } else { 0.0 }, tolerance: f64::INFINITY, pass: true, note: format!("{}: failed requests (informational)", run.label) });
        }
        if let Some(bill) = bill_total(&run.dataset) {
            if !stress {
                checks.push(check("cost", total_cost(&r), bill, TOL_COST, format!("{}: predicted cost vs the run's bill", run.label)));
            }
        }
    }
    Ok(AccuracyRecord { method: "reference".into(), label: label.into(), checks, measured_at: now_iso() })
}

/// one line per check, for terminals and reports
pub fn accuracy_lines(rec: &AccuracyRecord) -> Vec<String> {
    rec.checks
        .iter()
        .filter(|c| c.metric != "errors")
        .map(|c| {
            let unit = |x: f64| match c.metric.as_str() {
                "cost" => format!("${}", js_to_fixed(x, if x < 10.0 { 3 } else { 0 })),
                "breaking-point" => format!("{} req/s", js_to_fixed(x, 1)),
                "errors" => js_num(js_round(x)),
                _ => format!("{} ms", js_num(js_round(x))),
            };
            let verdict = if c.metric == "errors" { "" } else if c.pass { "PASS" } else { "MISS" };
            format!(
                "{:<4} {:<14} predicted {} vs measured {} — off by {}%{} · {}",
                verdict,
                c.metric,
                unit(c.predicted),
                unit(c.measured),
                js_to_fixed(c.error * 100.0, 1),
                if c.tolerance.is_finite() { format!(" (target ≤ {}%)", js_num(c.tolerance * 100.0)) } else { String::new() },
                c.note
            )
        })
        .collect()
}
