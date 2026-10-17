//! Calibration (src/backtest/calibrate.ts): fit a model to a dataset.
//!
//!  - topology and per-request work from traces (visits, critical path, payloads)
//!  - per service: CPU per request (regression), capacity per replica — CPU-bound, concurrency-bound
//!    (M/M/c fitted to self time vs load, replaying the history through the queue so overload
//!    transients are fitted too) or unbounded — with bootstrap bands
//!  - per endpoint: network/proxy overhead, latency tail, baseline errors
//!  - cost from the bill: $ per replica-hour, per request, per GB
//!  - fit quality per component; anything the model cannot explain is flagged

#[allow(unused_imports)]
use crate::fmath::JsMath;
use crate::backtest::{base_plan, js_max, js_sort_by, quantile, rng, traffic_of};
use crate::dataset::{mean_of, Dataset, EndpointShape, ServiceHint, ServiceSeries};
use crate::engine::{cfs_stall_ms, run_plan};
use crate::math::{js_num, js_round, js_to_fixed, mmc_wait};
use crate::model::*;
use crate::types::{Map, Num, Opts};
use indexmap::{IndexMap, IndexSet};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ListPrices {
    pub per_vcpu_hour: f64,
    pub per_gb_hour: f64,
    pub arm_per_vcpu_hour: f64,
    pub arm_per_gb_hour: f64,
    pub source: String,
}

fn fargate() -> ListPrices {
    ListPrices { per_vcpu_hour: 0.04048, per_gb_hour: 0.004445, arm_per_vcpu_hour: 0.03238, arm_per_gb_hour: 0.00356, source: "AWS Fargate on-demand, us-east-1 (aws.amazon.com/fargate/pricing)".into() }
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CalibrateOptions {
    pub slo: Option<Slo>,
    pub timeout_ms: Option<f64>,
    pub hosted_by: Option<Map<String>>,
    pub bootstrap: Option<f64>,
    pub services: Option<Map<ServiceHint>>,
    pub endpoints: Option<Map<crate::dataset::EndpointHint>>,
    pub seed: Option<f64>,
    /// true, or prices
    pub list_prices: Option<Value>,
}

const SERVER_GRID: [f64; 14] = [1.0, 2.0, 3.0, 4.0, 6.0, 8.0, 12.0, 16.0, 24.0, 32.0, 48.0, 64.0, 128.0, 256.0];
const VARIABILITY: [f64; 8] = [0.3, 0.4, 0.5, 0.65, 0.8, 1.0, 1.3, 1.7];
const THROTTLE_COLLAPSE: f64 = 0.25;
const COMPACT_ABOVE: usize = 1000;
const GIB: f64 = 1073741824.0;
/// EC2 on-demand, us-east-1, general purpose (m6i/m7i), by allocatable size
const NODE_PER_VCPU_HOUR: f64 = 0.03334;
const NODE_PER_GB_HOUR: f64 = 0.003664;
const NODE_SOURCE: &str = "EC2 m6i on-demand, us-east-1 ($0.192/h for 4 vCPU + 16 GiB), by allocatable size";

fn vals(a: Option<&Vec<Num>>, i: usize) -> Option<f64> {
    a.and_then(|a| a.get(i).copied().flatten()).filter(|x| x.is_finite())
}

/// a JIT runtime's warm-up, read from the history where it shows a pod starting (the replica count
/// rising by a whole pod): the CPU above the fitted line in the minutes after, per new pod. That is
/// the compiler's work plus the cold requests' extra cost, so the core-seconds it reads are an upper
/// bound; the cold multiplier and the compiler's share stay the runtime's defaults. A restart that
/// keeps the count (a rollout) is not in the series, so calibration cannot see one
fn warmup_of(runtime: Option<&str>, reps: &[Num], lam: &[Num], cpu_s: Option<&Vec<Num>>, cpu: Option<&CpuModel>, step: f64) -> (Option<crate::types::Warmup>, Option<String>) {
    let mut w = match runtime.and_then(assumed_warmup) {
        Some(w) => w,
        None => return (None, None),
    };
    let label = runtime_label(&w.runtime);
    let assumed = format!(
        "a {} (named by its traces): pods that start during a replay start cold — ×{} CPU per request until ~{} core-seconds of JIT compilation are done (assumed: the history shows none of its pods starting)",
        label,
        js_num(w.cold),
        js_num(w.core_s)
    );
    let c = match cpu {
        Some(c) if cpu_s.is_some() => c,
        _ => return (Some(w), Some(assumed)),
    };
    let mut est: Vec<f64> = vec![];
    let mut prev: Option<f64> = None;
    for i in 0..reps.len() {
        let r = match reps[i] {
            Some(r) if r > 0.0 => r,
            _ => continue,
        };
        let added = prev.map(|p| js_round(r - p)).unwrap_or(0.0);
        prev = Some(r);
        if added < 1.0 {
            continue;
        }
        // CPU above the line until it is back within 10% of it for a minute (at most 10 minutes)
        let (mut sum, mut quiet) = (0.0, 0);
        for k in i..reps.len().min(i + (600.0 / step).ceil() as usize) {
            let (cc, l, rk) = match (vals(cpu_s, k), lam[k], reps[k]) {
                (Some(cc), Some(l), Some(rk)) => (cc, l, rk),
                _ => continue,
            };
            let line = rk * c.base + c.per_req * l;
            let over = cc - line;
            if over <= 0.1 * line.max(0.01) {
                quiet += 1;
                if quiet as f64 * step >= 60.0 {
                    break;
                }
            } else {
                quiet = 0;
                sum += over * step;
            }
        }
        if sum > 0.0 {
            est.push(sum / added);
        }
    }
    if est.is_empty() {
        return (Some(w), Some(assumed));
    }
    w.core_s = js_round(median(&est) * 10.0) / 10.0;
    w.source = "calibrated".into();
    let note = format!(
        "a {}: {} pod start{} in the history cost ~{} core-seconds of CPU each above its line (JIT warm-up, an upper bound: the cold requests' extra cost is in it); the ×{} cold cost per request is assumed",
        label,
        est.len(),
        if est.len() == 1 { "" } else { "s" },
        js_num(w.core_s),
        js_num(w.cold)
    );
    (Some(w), Some(note))
}

fn median(xs: &[f64]) -> f64 {
    if xs.is_empty() {
        return f64::NAN;
    }
    let mut s = xs.to_vec();
    js_sort_by(&mut s, |a, b| a - b);
    quantile(&s, 0.5)
}

/// the median of (value, weight) pairs: the value below and above which half the weight lies
fn weighted_median(xs: &[(f64, f64)]) -> f64 {
    let mut s: Vec<(f64, f64)> = xs.iter().copied().filter(|x| x.1 > 0.0).collect();
    if s.is_empty() {
        return median(&xs.iter().map(|x| x.0).collect::<Vec<_>>());
    }
    js_sort_by(&mut s, |a, b| a.0 - b.0);
    let total = s.iter().fold(0.0, |a, x| a + x.1);
    let mut cum = 0.0;
    for x in &s {
        cum += x.1;
        if cum >= total / 2.0 {
            return x.0;
        }
    }
    s[s.len() - 1].0
}

fn mape(pred: &[f64], obs: &[Num], floor: f64) -> Option<f64> {
    let (mut s, mut k) = (0.0, 0usize);
    for i in 0..obs.len() {
        let o = match obs[i] {
            Some(o) => o,
            None => continue,
        };
        let p = pred.get(i).copied().unwrap_or(f64::NAN);
        if !p.is_finite() {
            continue;
        }
        s += (p - o).abs() / floor.max(o.abs());
        k += 1;
    }
    if k > 0 {
        Some(s / k as f64)
    } else {
        None
    }
}

fn status(m: Option<f64>) -> String {
    match m {
        None => "unexplained",
        Some(m) if m < 0.15 => "good",
        Some(m) if m < 0.3 => "fair",
        Some(m) if m < 0.6 => "poor",
        _ => "unexplained",
    }
    .into()
}

/// each bucket's M/M/c wait at (c, K): it depends on the load alone, not on variability or the tail,
/// so the fits compute it once per (c, K) and replay it under every variability and tail
pub fn queue_waits(per_rep: &[f64], c: f64, k: f64) -> Vec<(f64, f64)> {
    if !k.is_finite() {
        return vec![];
    }
    per_rep.iter().map(|&lam| {
        let w = mmc_wait(lam.min(k * 0.97), c, k);
        (w.mean_ms, w.p99_ms)
    }).collect()
}

/// replay per-replica load through one queue whose waits are known; predicted self mean and p99
pub fn replay_waits(per_rep: &[f64], waits: &[(f64, f64)], step_s: f64, k: f64, s: f64, s99: f64, tail: f64, v: f64) -> (Vec<f64>, Vec<f64>) {
    let sub_n = (step_s / 5.0).ceil().max(1.0);
    let sub = sub_n as usize;
    let dt = step_s / sub_n;
    let mut backlog = 0.0;
    let mut mean = Vec::with_capacity(per_rep.len());
    let mut p99 = Vec::with_capacity(per_rep.len());
    let idle_p99 = s + (s99 - s).abs();
    let ex = s99 - s;
    let finite = k.is_finite();
    for (i, &lam) in per_rep.iter().enumerate() {
        // nothing arriving and nothing queued: the bucket is just the service time
        if lam <= 0.0 && backlog <= 0.0 {
            mean.push(s);
            p99.push(idle_p99);
            continue;
        }
        let (mut m, mut p) = (0.0, 0.0);
        // no backlog and the load within capacity: every sub-step is the same one, added sub times
        if backlog <= 0.0 && (!finite || lam <= k) {
            let (wm, wp) = if finite { (v * waits[i].0, v * waits[i].1) } else { (0.0, 0.0) };
            let q = tail * (wp - wm);
            let tm = (s + wm) / sub_n;
            let tp = (s + wm + (ex * ex + q * q).sqrt()) / sub_n;
            for _ in 0..sub {
                m += tm;
                p += tp;
            }
            mean.push(m);
            p99.push(p);
            continue;
        }
        for _ in 0..sub {
            let (mut wm, mut wp) = (0.0, 0.0);
            if finite {
                let (w_mean, w_p99) = waits[i];
                let served = k.min(lam + backlog / dt);
                backlog = (backlog + (lam - served) * dt).max(0.0);
                wm = v * w_mean + (backlog / k) * 1000.0;
                wp = v * w_p99 + (backlog / k) * 1000.0;
            }
            m += (s + wm) / sub_n;
            let q = tail * (wp - wm);
            p += (s + wm + (ex * ex + q * q).sqrt()) / sub_n;
        }
        mean.push(m);
        p99.push(p);
    }
    (mean, p99)
}

/// replay per-replica load through one queue; predicted self mean and p99 per bucket
pub fn replay_queue(per_rep: &[f64], step_s: f64, c: f64, k: f64, s: f64, s99: f64, tail: f64, v: f64) -> (Vec<f64>, Vec<f64>) {
    replay_waits(per_rep, &queue_waits(per_rep, c, k), step_s, k, s, s99, tail, v)
}

struct Compact {
    lam: Vec<f64>,
    obs: Vec<Num>,
    p99: Vec<Num>,
}

/// a long history compacted for fitting: the busy episodes (busiest first, ~750 buckets) and an even
/// sample of 250 of everything else
fn compact_fit(lam: &[f64], obs: &[Num], p99: &[Num], max_lam: f64, s: f64) -> Compact {
    let n = lam.len();
    if n <= COMPACT_ABOVE {
        return Compact { lam: lam.to_vec(), obs: obs.to_vec(), p99: p99.to_vec() };
    }
    let mut near = vec![false; n];
    for i in 0..n {
        if lam[i] >= max_lam * 0.7 || obs[i].unwrap_or(0.0) >= 2.0 * s {
            for j in i.saturating_sub(3)..=(n - 1).min(i + 15) {
                near[j] = true;
            }
        }
    }
    let mut episodes: Vec<(usize, usize, f64)> = vec![];
    let mut i = 0;
    while i < n {
        if !near[i] {
            i += 1;
            continue;
        }
        let a = i;
        let mut peak: f64 = 0.0;
        while i < n && near[i] {
            peak = js_max(peak, [lam[i], obs[i].unwrap_or(0.0) / s.max(1e-9)]);
            i += 1;
        }
        episodes.push((a, i, peak));
        // the for loop's own i++ after the inner while
        i += 1;
    }
    let mut keep = vec![false; n];
    let mut kept = 0;
    let mut by_peak = episodes.clone();
    js_sort_by(&mut by_peak, |x, y| y.2 - x.2);
    for e in by_peak {
        if kept >= 750 {
            break;
        }
        for j in e.0..e.1 {
            keep[j] = true;
        }
        kept += e.1 - e.0;
    }
    let every = (((n - kept) as f64) / 250.0).ceil().max(1.0) as usize;
    let mut q = 0usize;
    for i in 0..n {
        if !keep[i] {
            if q % every == 0 {
                keep[i] = true;
            }
            q += 1;
        }
    }
    let idx: Vec<usize> = (0..n).filter(|&i| keep[i]).collect();
    Compact { lam: idx.iter().map(|&i| lam[i]).collect(), obs: idx.iter().map(|&i| obs[i]).collect(), p99: idx.iter().map(|&i| p99[i]).collect() }
}

fn log_err(pred: &[f64], obs: &[Num], w: Option<&[f64]>) -> f64 {
    let (mut s, mut k) = (0.0, 0.0);
    for i in 0..obs.len() {
        let o = match obs[i] {
            Some(o) if o > 0.0 => o,
            _ => continue,
        };
        let p = pred[i].min(1e7).max(1e-3);
        let wi = w.map(|w| w[i]).unwrap_or(1.0);
        let l = (p / o).js_ln();
        s += wi * l * l;
        k += wi;
    }
    if k != 0.0 {
        s / k
    } else {
        f64::INFINITY
    }
}

#[derive(Clone, Copy, Debug)]
struct Fitted {
    c: f64,
    k: f64,
    s: f64,
    v: f64,
    err: f64,
    tied: Option<bool>,
}

/// any number of servers, any capacity
fn fit_free(per_rep: &[f64], obs: &[Num], step_s: f64, s: f64, s99: f64, max_lam: f64, servers: Option<&[f64]>) -> Fitted {
    let mut best = Fitted { c: 1.0, k: f64::INFINITY, s, v: 1.0, err: f64::INFINITY, tied: None };
    // overloaded histories run above capacity: search from well below the peak
    let lo = (max_lam * 0.3).max(1e-3);
    for &c in servers.unwrap_or(&SERVER_GRID) {
        for j in 0..=48 {
            let k = lo * 200f64.js_pow(j as f64 / 48.0);
            let w = queue_waits(per_rep, c, k);
            for &v in &VARIABILITY {
                let err = log_err(&replay_waits(per_rep, &w, step_s, k, s, s99, 1.0, v).0, obs, None);
                if err < best.err - 1e-12 {
                    best = Fitted { c, k, s, v, err, tied: None };
                }
            }
        }
    }
    // refine K around the best
    for j in -10..=10 {
        let k = best.k * 1.06f64.js_pow(j as f64 / 2.0);
        let err = log_err(&replay_queue(per_rep, step_s, best.c, k, s, s99, 1.0, best.v).0, obs, None);
        if err < best.err {
            best = Fitted { k, err, ..best };
        }
    }
    best
}

/// a lock, a connection pool or a worker pool: c holders, each held for the service time s
fn fit_tied(per_rep: &[f64], obs: &[Num], step_s: f64, s0: f64, s99: f64, servers: Option<&[f64]>) -> Fitted {
    let mut best = Fitted { c: 1.0, k: f64::INFINITY, s: s0, v: 1.0, err: f64::INFINITY, tied: None };
    if s0 <= 0.05 {
        return best;
    }
    for &c in servers.unwrap_or(&SERVER_GRID) {
        for j in 0..=14 {
            let s = s0 * (0.45 + 0.04 * j as f64);
            let k = (c * 1000.0) / s;
            let w = queue_waits(per_rep, c, k);
            for &v in &VARIABILITY {
                let err = log_err(&replay_waits(per_rep, &w, step_s, k, s, s99 - (s0 - s), 1.0, v).0, obs, None);
                if err < best.err - 1e-12 {
                    best = Fitted { c, k, s, v, err, tied: None };
                }
            }
        }
    }
    best
}

/// fit servers, service time and variability at a capacity that was seen directly
fn fit_at_k(per_rep: &[f64], obs: &[Num], step_s: f64, s0: f64, s99: f64, k: f64) -> Fitted {
    let mut best = Fitted { c: 1.0, k, s: s0, v: 1.0, err: f64::INFINITY, tied: Some(false) };
    for &c in &SERVER_GRID {
        let w = queue_waits(per_rep, c, k);
        for tied in [true, false] {
            let s = if tied { (c * 1000.0) / k } else { s0 };
            if tied && (s < s0 * 0.4 || s > s0 * 1.1) {
                continue;
            }
            for &v in &VARIABILITY {
                let err = log_err(&replay_waits(per_rep, &w, step_s, k, s, s99 - (s0 - s), 1.0, v).0, obs, None);
                // prefer the physical (tied) reading when it explains the data as well
                if err < best.err * (if tied { 1.0001 } else { 0.97 }) {
                    best = Fitted { c, k, s, v, err, tied: Some(tied) };
                }
            }
        }
    }
    best
}

struct Fit {
    slope: f64,
    intercept: f64,
    r2: f64,
    se: f64,
}

fn regress(x: &[f64], y: &[f64]) -> Option<Fit> {
    let n = x.len();
    if n < 3 {
        return None;
    }
    let nf = n as f64;
    let mx = x.iter().fold(0.0, |a, b| a + b) / nf;
    let my = y.iter().fold(0.0, |a, b| a + b) / nf;
    let (mut sxy, mut sxx, mut syy) = (0.0, 0.0, 0.0);
    for i in 0..n {
        sxy += (x[i] - mx) * (y[i] - my);
        sxx += (x[i] - mx) * (x[i] - mx);
        syy += (y[i] - my) * (y[i] - my);
    }
    if !(sxx > 0.0) {
        return None;
    }
    let slope = sxy / sxx;
    let intercept = my - slope * mx;
    let r2 = if syy > 0.0 { (sxy * sxy) / (sxx * syy) } else { 0.0 };
    let mut sse = 0.0;
    for i in 0..n {
        let e = y[i] - intercept - slope * x[i];
        sse += e * e;
    }
    let se = if n > 2 { (sse / (nf - 2.0) / sxx).sqrt() } else { f64::INFINITY };
    Some(Fit { slope, intercept, r2, se })
}

// ---------- endpoint names from different sources ----------

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// lowercase, drop the word "http", path parameters ({id}, [id], :id) as *, no query string, no
/// trailing slash, single spaces
fn norm(s: &str) -> String {
    let s: Vec<char> = s.to_lowercase().chars().collect();
    // \bhttp\b → ''
    let mut a: Vec<char> = vec![];
    let mut i = 0;
    while i < s.len() {
        if i + 4 <= s.len() && s[i..i + 4] == ['h', 't', 't', 'p'] && (i == 0 || !is_word(s[i - 1])) && (i + 4 == s.len() || !is_word(s[i + 4])) {
            i += 4;
            continue;
        }
        a.push(s[i]);
        i += 1;
    }
    // \{[^}]*\} | \[[^\]]*\] | :[a-z_]\w* → *
    let mut b: Vec<char> = vec![];
    let mut i = 0;
    while i < a.len() {
        let c = a[i];
        if c == '{' {
            if let Some(j) = a[i + 1..].iter().position(|&x| x == '}') {
                b.push('*');
                i += j + 2;
                continue;
            }
        } else if c == '[' {
            if let Some(j) = a[i + 1..].iter().position(|&x| x == ']') {
                b.push('*');
                i += j + 2;
                continue;
            }
        } else if c == ':' && i + 1 < a.len() && (a[i + 1].is_ascii_lowercase() || a[i + 1] == '_') {
            let mut j = i + 2;
            while j < a.len() && is_word(a[j]) {
                j += 1;
            }
            b.push('*');
            i = j;
            continue;
        }
        b.push(c);
        i += 1;
    }
    // \?\S* → ''
    let mut c2: Vec<char> = vec![];
    let mut i = 0;
    while i < b.len() {
        if b[i] == '?' {
            i += 1;
            while i < b.len() && !b[i].is_whitespace() {
                i += 1;
            }
            continue;
        }
        c2.push(b[i]);
        i += 1;
    }
    // \/(\s|$) → $1
    let mut d: Vec<char> = vec![];
    for i in 0..c2.len() {
        if c2[i] == '/' && (i + 1 == c2.len() || c2[i + 1].is_whitespace()) {
            continue;
        }
        d.push(c2[i]);
    }
    // \s+ → ' ', trim
    let mut out = String::new();
    let mut space = false;
    for ch in d {
        if ch.is_whitespace() {
            space = true;
        } else {
            if space && !out.is_empty() {
                out.push(' ');
            }
            space = false;
            out.push(ch);
        }
    }
    out
}

/// endpoint ids from different sources ("frontend GET /dispatch" vs "frontend HTTP GET /dispatch")
pub fn same_endpoint(a: &str, b: &str) -> bool {
    let (na, nb) = (norm(a), norm(b));
    if na == nb {
        return true;
    }
    let parse = |s: &str| {
        let t: Vec<String> = s.split(' ').map(|x| x.to_string()).collect();
        let method = t.iter().find(|x| matches!(x.as_str(), "get" | "post" | "put" | "patch" | "delete" | "head" | "options")).cloned();
        (t[0].clone(), t[t.len() - 1].clone(), method)
    };
    let (pa, pb) = (parse(&na), parse(&nb));
    pa.0 == pb.0 && pa.1 == pb.1 && (pa.2.is_none() || pb.2.is_none() || pa.2 == pb.2)
}

/// the traced endpoint an endpoint series stands for: of those that are the same endpoint, the one with
/// the most traces (the exact id on a tie). Traces can name one route two ways — the framework's
/// ("/api/products/[productId]") and, on a few broken traces, the series' own template ("{id}") — and
/// a call path read from 42 traces must not stand in for one read from 4,829
pub fn traced_endpoint(shapes: &[(&String, &EndpointShape)], id: &str) -> Option<usize> {
    let mut best: Option<usize> = None;
    for (i, (s, e)) in shapes.iter().enumerate() {
        if !(s.as_str() == id || same_endpoint(s, id)) {
            continue;
        }
        let better = match best {
            None => true,
            Some(b) => e.traces > shapes[b].1.traces || (e.traces == shapes[b].1.traces && s.as_str() == id && shapes[b].0.as_str() != id),
        };
        if better {
            best = Some(i);
        }
    }
    best
}

// ---------- the node pool ----------

fn requests_of_service(s: Option<&ServiceSeries>) -> Option<Requests> {
    let pos = |a: Option<&Vec<Num>>| a.map(|v| v.iter().flatten().copied().filter(|x| *x > 0.0).collect::<Vec<f64>>()).unwrap_or_default();
    let cpu = pos(s.and_then(|s| s.cpu_request_cores.as_ref()));
    let mem = pos(s.and_then(|s| s.memory_request_bytes.as_ref()));
    if cpu.is_empty() && mem.is_empty() {
        return None;
    }
    Some(Requests { cpu: if cpu.is_empty() { 0.0 } else { median(&cpu) }, memory_gb: if mem.is_empty() { 0.0 } else { median(&mem) / GIB } })
}

fn cluster_of(d: &Dataset, services: &Map<ServiceModel>, replicas_of: &dyn Fn(&str) -> Vec<Num>) -> Option<ClusterModel> {
    let c = d.cluster.as_ref()?;
    let pos = |a: &Option<Vec<Num>>| a.as_ref().map(|v| v.iter().flatten().copied().filter(|x| *x > 0.0).collect::<Vec<f64>>()).unwrap_or_default();
    let nodes_v = pos(&c.cluster_nodes);
    let cpu_v = pos(&c.cluster_node_cpu);
    let mem_v = pos(&c.cluster_node_memory_bytes);
    if nodes_v.is_empty() || cpu_v.is_empty() || mem_v.is_empty() {
        return None;
    }
    let node_cpu = median(&cpu_v);
    let node_mem = median(&mem_v) / GIB;
    let hint = d.hints.as_ref().and_then(|h| h.cluster.as_ref());
    let price_hint = hint.and_then(|h| h.node_price_hour).filter(|p| *p != 0.0 && !p.is_nan());
    let per_hour = hint.and_then(|h| h.node_price_hour).unwrap_or(node_cpu * NODE_PER_VCPU_HOUR + node_mem * NODE_PER_GB_HOUR);
    let mut notes = vec![];
    let (mut other_cpu, mut other_mem, mut packing) = (vec![], vec![], vec![]);
    let n = d.n.max(0.0) as usize;
    let reps: IndexMap<&String, Vec<Num>> = services.keys().map(|id| (id, replicas_of(id))).collect();
    for i in 0..n {
        let at = |a: &Option<Vec<Num>>| a.as_ref().and_then(|v| v.get(i).copied().flatten());
        let (nn, rc, rm) = match (at(&c.cluster_nodes), at(&c.cluster_requested_cpu), at(&c.cluster_requested_memory_bytes)) {
            (Some(a), Some(b), Some(cc)) => (a, b, cc),
            _ => continue,
        };
        let (mut sc, mut sm) = (0.0, 0.0);
        for (id, s) in services {
            let r0 = match (&s.requests, &s.hosted_by) {
                (Some(r), None) => r,
                _ => continue,
            };
            let r = reps[id].get(i).copied().flatten().unwrap_or(s.replicas);
            sc += r * r0.cpu;
            sm += r * r0.memory_gb;
        }
        other_cpu.push((rc - sc).max(0.0));
        other_mem.push((rm / GIB - sm).max(0.0));
        let ideal = (rc / node_cpu).max(rm / GIB / node_mem);
        if ideal > 0.0 {
            packing.push(nn / ideal);
        }
    }
    let nodes = js_round(median(&nodes_v));
    let min_nodes = nodes_v.iter().copied().fold(f64::INFINITY, f64::min);
    let max_nodes = js_max(f64::NEG_INFINITY, nodes_v.iter().copied());
    // a node replaced once isn't autoscaling: the count has to have been away from its typical value
    // for a twentieth of the history
    let med = median(&nodes_v);
    let away = nodes_v.iter().filter(|x| (*x - med).abs() >= 1.0).count() as f64;
    let autoscaled = hint.and_then(|h| h.autoscaled).unwrap_or(max_nodes > min_nodes && away >= 0.05 * nodes_v.len() as f64);
    let pk = if packing.is_empty() { 1.0 } else { median(&packing).max(1.0) };
    notes.push(format!(
        "{} node{} of {} cores + {} GiB allocatable, ${}/node-hour ({})",
        js_num(nodes),
        if nodes == 1.0 { "" } else { "s" },
        js_num(js_to_fixed(node_cpu, 2).parse::<f64>().unwrap_or(node_cpu)),
        js_to_fixed(node_mem, 1),
        js_to_fixed(per_hour, 3),
        if price_hint.is_some() { "given" } else { NODE_SOURCE }
    ));
    notes.push(if autoscaled {
        format!("the node count followed demand ({}–{}): requests that need fewer nodes save money, at {}× the nodes requests would fill exactly", js_num(min_nodes), js_num(max_nodes), js_to_fixed(pk, 2))
    } else {
        format!("a fixed pool: {} nodes the whole history. Smaller requests leave room on them but save nothing until the pool shrinks", js_num(nodes))
    });
    Some(ClusterModel {
        node: NodeModel { cpu: node_cpu, memory_gb: node_mem, per_hour, source: if price_hint.is_some() { "hint".into() } else { "pricing".into() } },
        nodes,
        min_nodes,
        max_nodes,
        autoscaled,
        packing: pk,
        other: OtherRequests { cpu: if other_cpu.is_empty() { 0.0 } else { median(&other_cpu) }, memory_gb: if other_mem.is_empty() { 0.0 } else { median(&other_mem) } },
        provision_s: hint.and_then(|h| h.provision_s).filter(|p| *p != 0.0 && !p.is_nan()),
        zones: d.node_zones.clone().filter(|z| !z.is_empty()),
        notes,
    })
}

fn truthy(x: Option<f64>) -> Option<f64> {
    x.filter(|v| *v != 0.0 && !v.is_nan())
}

pub fn calibrate(d: &Dataset, options: &CalibrateOptions) -> Model {
    // the dataset's hints, then the caller's options over them
    let hints = d.hints.clone().unwrap_or_default();
    let mut hosted_by: Map<String> = hints.hosted_by.clone().unwrap_or_default();
    for (k, v) in options.hosted_by.clone().unwrap_or_default() {
        hosted_by.insert(k, v);
    }
    let mut svc_opts: Map<ServiceHint> = hints.services.clone().unwrap_or_default();
    for (k, v) in options.services.clone().unwrap_or_default() {
        svc_opts.insert(k, v);
    }
    let mut ep_opts: Map<crate::dataset::EndpointHint> = hints.endpoints.clone().unwrap_or_default();
    for (k, v) in options.endpoints.clone().unwrap_or_default() {
        ep_opts.insert(k, v);
    }
    let slo = options.slo.clone().or(hints.slo.clone()).unwrap_or(Slo { p99_ms: 500.0, error_rate: 0.01 });
    let timeout_ms = options.timeout_ms.or(hints.timeout_ms).unwrap_or(5000.0);
    let host_of = |id: &str| hosted_by.get(id).filter(|h| !h.is_empty()).cloned();
    let topo = d.topology.as_ref();
    let mut rand = rng(options.seed.unwrap_or(1.0));
    let b_draws = options.bootstrap.unwrap_or(40.0).max(0.0) as usize;
    let n = d.n.max(0.0) as usize;
    let mut ids: IndexSet<String> = IndexSet::new();
    if let Some(t) = topo {
        ids.extend(t.services.keys().cloned());
    }
    ids.extend(d.services.keys().cloned());
    if let Some(b) = &d.bill {
        ids.extend(b.components.keys().cloned());
    }

    // the history may hold several configurations of a service: each is fitted on one of them
    let regimes = crate::regimes::detect_all(d, &hosted_by);
    let fit_series: Map<ServiceSeries> = d.services.iter().map(|(id, s)| (id.clone(), regimes.get(id).map(|r| crate::regimes::masked(s, r)).unwrap_or_else(|| s.clone()))).collect();
    let replicas_in = |all: &Map<ServiceSeries>, id: &str| -> Vec<Num> {
        if let Some(h) = host_of(id) {
            if let Some(r) = all.get(&h).and_then(|s| s.replicas.clone()) {
                return r;
            }
        }
        all.get(id).and_then(|s| s.replicas.clone()).unwrap_or_else(|| vec![Some(1.0); n])
    };
    let replicas_of = |id: &str| replicas_in(&fit_series, id);
    // what really ran, for what it cost
    let replicas_run = |id: &str| replicas_in(&d.services, id);

    // buckets where users were timing out
    let mut entry_ids: IndexSet<&String> = IndexSet::new();
    for e in d.endpoints.values() {
        entry_ids.insert(&e.service);
    }
    let overloaded: Vec<bool> = (0..n)
        .map(|i| {
            d.endpoints.values().any(|e| vals(e.error_rate.as_ref(), i).unwrap_or(0.0) >= 0.05 && vals(e.p99_ms.as_ref(), i).unwrap_or(0.0) >= timeout_ms * 0.8)
                || entry_ids.iter().any(|id| {
                    let s = d.services.get(*id);
                    vals(s.and_then(|s| s.error_rate.as_ref()), i).unwrap_or(0.0) >= 0.03 && vals(s.and_then(|s| s.p99_ms.as_ref()), i).unwrap_or(0.0) >= timeout_ms * 0.8
                })
        })
        .collect();
    let mut services: Map<ServiceModel> = Map::new();
    // services whose queue sits outside their spans (CPU pinned, latency fit blind to it)
    let mut hidden_queue: IndexSet<String> = IndexSet::new();
    let empty = ServiceSeries::default();

    for id in &ids {
        let s = fit_series.get(id).unwrap_or(&empty);
        let shape = topo.and_then(|t| t.services.get(id));
        let mut notes: Vec<String> = vec![];
        let reps = replicas_of(id);
        let rep_vals: Vec<f64> = reps.iter().flatten().copied().filter(|x| *x > 0.0).collect();
        let replicas = if rep_vals.is_empty() { 1.0 } else { js_round(median(&rep_vals)) };
        let host_id = host_of(id).unwrap_or_else(|| id.clone());
        let host = fit_series.get(&host_id);
        let limit_vals: Vec<f64> = host.and_then(|h| h.cpu_limit_cores.as_ref()).map(|v| v.iter().flatten().copied().filter(|x| *x > 0.0).collect()).unwrap_or_default();
        let cpu_limit = if limit_vals.is_empty() { None } else { Some(median(&limit_vals)) };
        let mem_limits: Vec<f64> = host.and_then(|h| h.memory_limit_bytes.as_ref()).map(|v| v.iter().flatten().copied().filter(|x| *x > 0.0).collect()).unwrap_or_default();
        let mem_limit = if mem_limits.is_empty() { None } else { Some(median(&mem_limits) / GIB) };
        let hosted = host_of(id).is_some();
        let rep_at = |i: usize| vals(Some(&reps), i);
        // used per replica: the largest container at its peak where collected, else the average replica
        let mem_used: Vec<Num> = (0..n)
            .map(|i| {
                let mx = vals(host.and_then(|h| h.memory_max_bytes.as_ref()), i);
                let v = match mx {
                    Some(mx) if mx > 0.0 => Some(mx / GIB),
                    _ => {
                        let sum = vals(host.and_then(|h| h.memory_bytes.as_ref()), i);
                        let r = rep_at(i).unwrap_or(replicas);
                        match sum {
                            Some(sum) if sum > 0.0 && r > 0.0 => Some(sum / r / GIB),
                            _ => None,
                        }
                    }
                };
                v.filter(|x| *x > 0.0)
            })
            .collect();
        let mem_vals: Vec<f64> = mem_used.iter().flatten().copied().collect();

        let lam: Vec<Num> = (0..n).map(|i| vals(s.rps.as_ref(), i)).collect();
        let per_rep: Vec<f64> = (0..n).map(|i| match lam[i] {
            None => 0.0,
            Some(l) => l / rep_at(i).unwrap_or(replicas).max(1.0),
        }).collect();
        let self_obs: Vec<Num> = (0..n).map(|i| vals(s.self_mean_ms.as_ref(), i).or(if shape.is_some() { None } else { vals(s.mean_ms.as_ref(), i) })).collect();
        let self_p99_obs: Vec<Num> = (0..n).map(|i| vals(s.self_p99_ms.as_ref(), i).or(if shape.is_some() { None } else { vals(s.p99_ms.as_ref(), i) })).collect();

        // CPU per request (per replica)
        let mut cpu: Option<CpuModel> = None;
        let mut cpu_se = f64::INFINITY;
        if s.cpu_cores.is_some() && !hosted {
            let (mut xs, mut ys) = (vec![], vec![]);
            for i in 0..n {
                let c = vals(s.cpu_cores.as_ref(), i);
                let r = rep_at(i).unwrap_or(replicas);
                let (c, l) = match (c, lam[i]) {
                    (Some(c), Some(l)) if r > 0.0 => (c, l),
                    _ => continue,
                };
                xs.push(l / r);
                ys.push(c / r);
            }
            if let Some(fit) = regress(&xs, &ys) {
                cpu = Some(CpuModel { base: fit.intercept.max(0.0), per_req: fit.slope.max(0.0), r2: fit.r2 });
                cpu_se = fit.se;
                if fit.r2 < 0.3 && xs.len() > 10 {
                    notes.push(format!("CPU barely follows load (R² {}) — capacity is not CPU-bound or CPU data is noisy", js_to_fixed(fit.r2, 2)));
                }
            }
        }

        // memory against load: an OOM kill comes when one container's working set passes its limit
        let mut memory: Option<MemoryModel> = None;
        if mem_vals.len() >= 5 && !hosted && (0..n).any(|i| mem_used[i].is_some() && lam[i].is_some()) {
            let (mut xs, mut ys) = (vec![], vec![]);
            for i in 0..n {
                let (y, _) = match (mem_used[i], lam[i]) {
                    (Some(y), Some(l)) => (y, l),
                    _ => continue,
                };
                xs.push(per_rep[i]);
                ys.push(y);
            }
            let fit = if xs.len() >= 5 { regress(&xs, &ys) } else { None };
            // a leak: memory that follows the requests a container has served since it started, not
            // the load — the count restarts where the working set drops (the container did)
            let (mut served, mut cs, mut ms) = (0.0, vec![], vec![]);
            let mut last: Option<f64> = None;
            for i in 0..n {
                let (y, l) = match (mem_used[i], lam[i]) {
                    (Some(y), Some(l)) => (y, l),
                    _ => continue,
                };
                if matches!(last, Some(p) if y < p * 0.7) {
                    served = 0.0;
                }
                last = Some(y);
                let r = rep_at(i).unwrap_or(replicas).max(1.0);
                served += l / r * d.step_s;
                cs.push(served);
                ms.push(y);
            }
            let leak_fit = if cs.len() >= 12 { regress(&cs, &ms) } else { None };
            let leaks = match (&leak_fit, &fit) {
                (Some(lf), f) => lf.slope > 0.0 && lf.r2 >= 0.8 && lf.r2 > f.as_ref().map(|f| f.r2).unwrap_or(0.0) + 0.2 && lf.slope * cs.iter().copied().fold(0.0, f64::max) > 0.15 * lf.intercept.max(1e-9),
                _ => false,
            };
            let follows = !leaks && matches!(&fit, Some(f) if f.slope > 0.0 && f.r2 >= 0.3);
            let (base, per_req, leak) = if leaks {
                (leak_fit.as_ref().unwrap().intercept.max(0.0), 0.0, leak_fit.as_ref().unwrap().slope)
            } else if follows {
                (fit.as_ref().unwrap().intercept.max(0.0), fit.as_ref().unwrap().slope, 0.0)
            } else {
                (median(&ys), 0.0, 0.0)
            };
            let spike = if leaks { js_max(0.0, ms.iter().zip(&cs).map(|(y, c)| y - (base + leak * c))) } else { js_max(0.0, ys.iter().zip(&xs).map(|(y, x)| y - (base + per_req * x))) };
            let m = MemoryModel { base, per_req, spike, peak: Some(js_max(f64::NEG_INFINITY, ys.iter().copied())), limit: mem_limit, r2: if leaks { leak_fit.as_ref().unwrap().r2 } else { fit.as_ref().map(|f| f.r2).unwrap_or(0.0) }, seen_to: Some(js_max(f64::NEG_INFINITY, xs.iter().copied())), leak };
            if leaks {
                let to_limit = truthy(mem_limit).map(|ml| ((ml - base - spike) / leak).max(0.0));
                notes.push(format!(
                    "memory grows with the requests a container has served, not with load: +{} MiB per 1,000 requests (R² {}) — a leak{}",
                    js_to_fixed(leak * 1024.0 * 1000.0, 1),
                    js_to_fixed(m.r2, 2),
                    to_limit.map(|k| format!("; it reaches the limit after about {} requests per container, then is OOM-killed", crate::math::js_locale(js_round(k)))).unwrap_or_default()
                ));
            }
            if let Some(ml) = truthy(mem_limit) {
                notes.push(format!(
                    "memory: peaks at {} MiB per container against a {} MiB limit ({}%){}",
                    js_num(js_round(m.peak.unwrap() * 1024.0)),
                    js_num(js_round(ml * 1024.0)),
                    js_num(js_round((m.peak.unwrap() / ml) * 100.0)),
                    if follows { format!(", +{} MiB per 100 req/s per replica", js_to_fixed(per_req * 1024.0 * 100.0, 1)) } else if leak > 0.0 { ", rising with the requests served".into() } else { ", flat with load".into() }
                ));
            }
            memory = Some(m);
        }

        // CFS quota throttling
        let mut throttle: Option<Throttle> = None;
        let mut throttle_bound = false;
        let mut throttle_capped = false;
        if let (Some(_), Some(cl)) = (&s.cpu_throttled, truthy(cpu_limit)) {
            if !hosted {
                let (mut us, mut ls) = (vec![], vec![]);
                for i in 0..n {
                    let c = vals(s.cpu_cores.as_ref(), i);
                    let th = vals(s.cpu_throttled.as_ref(), i);
                    let r = rep_at(i).unwrap_or(replicas);
                    let (c, th) = match (c, th) {
                        (Some(c), Some(th)) if r > 0.0 && th >= 0.002 && th < 0.98 => (c, th),
                        _ => continue,
                    };
                    us.push(c / (r * cl));
                    ls.push(th.js_ln());
                }
                let fit = if us.len() >= 12 { regress(&us, &ls) } else { None };
                let max_u = if us.is_empty() { 0.0 } else { js_max(f64::NEG_INFINITY, us.iter().copied()) };
                let own = s.self_p99_ms.as_ref().or(s.p99_ms.as_ref());
                let mut p99s: Vec<f64> = own.map(|v| v.iter().flatten().copied().filter(|x| *x > 0.0).collect()).unwrap_or_default();
                js_sort_by(&mut p99s, |a, b| a - b);
                let calm_p99 = if p99s.is_empty() { f64::NAN } else { quantile(&p99s, 0.25) };
                let (mut hard, mut healthy, mut broke) = (0usize, 0usize, 0usize);
                let mut top_u: f64 = 0.0;
                let mut broke_at: Vec<f64> = vec![];
                for i in 0..n {
                    let th = match vals(s.cpu_throttled.as_ref(), i) {
                        Some(th) if th >= THROTTLE_COLLAPSE => th,
                        _ => continue,
                    };
                    let _ = th;
                    hard += 1;
                    let c = vals(s.cpu_cores.as_ref(), i);
                    let r = rep_at(i).unwrap_or(replicas);
                    let u = match c {
                        Some(c) if r > 0.0 => c / (r * cl),
                        _ => 0.0,
                    };
                    top_u = js_max(top_u, [u]);
                    let p = vals(own, i);
                    let err = vals(s.error_rate.as_ref(), i).unwrap_or(0.0);
                    if let Some(p) = p {
                        if calm_p99.is_finite() && p <= (calm_p99 * 2.0).max(calm_p99 + 50.0) && err < 0.01 {
                            healthy += 1;
                        }
                    }
                    if err >= 0.01 || vals(s.p99_ms.as_ref(), i).unwrap_or(0.0) >= timeout_ms * 0.5 {
                        broke += 1;
                        broke_at.push(u);
                    }
                }
                throttle_bound = broke as f64 >= (0.1 * hard as f64).max(2.0) || broke_at.iter().any(|u| *u >= top_u * 0.95);
                if hard >= 3 && healthy as f64 >= hard as f64 * 0.8 {
                    notes.push(format!("throttled in {}%+ of CPU periods for {} buckets of the history without slowing down: the quota does not limit it", js_num(js_round(THROTTLE_COLLAPSE * 100.0)), hard));
                } else if let Some(fit) = fit.filter(|f| f.slope > 0.0 && f.r2 >= 0.3) {
                    let knee = (THROTTLE_COLLAPSE.js_ln() - fit.intercept) / fit.slope;
                    if knee < 0.97 {
                        let t = Throttle { knee: knee.max(0.3), at_zero: fit.intercept.js_exp(), growth: fit.slope, r2: fit.r2, seen_to: max_u };
                        notes.push(format!(
                            "CPU quota throttling: {}% of periods throttled at {}% of the limit, rising ×{} per 10 points (R² {}); it reaches {}% at {}% of the limit, so that is the CPU it can use{}",
                            // the fit's value at the busiest bucket (a share of periods: at most all of them)
                            js_to_fixed((fit.intercept + fit.slope * max_u.min(1.0)).js_exp().min(1.0) * 100.0, 0),
                            js_num(js_round(max_u.min(1.0) * 100.0)),
                            js_to_fixed((fit.slope * 0.1).js_exp(), 2),
                            js_to_fixed(fit.r2, 2),
                            js_num(js_round(THROTTLE_COLLAPSE * 100.0)),
                            js_num(js_round(t.knee * 100.0)),
                            if knee > max_u + 0.2 { " (extrapolated)" } else { "" }
                        ));
                        throttle = Some(t);
                    }
                }
            }
        }

        // low-load self time
        let mut with_data: Vec<(usize, f64)> = (0..n).filter(|&i| lam[i].is_some() && self_obs[i].is_some()).map(|i| (i, per_rep[i])).collect();
        let mut sorted_by_load = with_data.clone();
        js_sort_by(&mut sorted_by_load, |a, b| a.1 - b.1);
        let low_n = 3.max((sorted_by_load.len() as f64 * 0.3).floor() as usize).min(sorted_by_load.len());
        let low = &sorted_by_load[..low_n];
        let s_low = if !low.is_empty() { median(&low.iter().map(|x| self_obs[x.0].unwrap()).collect::<Vec<_>>()) } else { shape.map(|sh| sh.self_mean_ms).unwrap_or(0.0) };
        let low_p99: Vec<f64> = low.iter().filter_map(|x| self_p99_obs[x.0]).collect();
        let s99 = if !low_p99.is_empty() { median(&low_p99) } else { shape.map(|sh| sh.self_p99_ms).unwrap_or(s_low * 2.0) };
        let max_lam = js_max(0.0, per_rep.iter().copied());
        let _ = &mut with_data;

        let mut capacity = Capacity { limit: "none".into(), servers: 1.0, per_replica_rps: f64::INFINITY, band: None, samples: None, overloaded_rps: None, throttle: None, cpu_alone: false };
        let mut tail = 1.0;
        let mut variability = 1.0;
        let mut self_mean = s_low;
        let mut self_p99 = s99;
        let mut latency_mape: Option<f64> = None;
        let mut p99_mape: Option<f64> = None;
        let ov = svc_opts.get(id);
        let ov_rps = ov.and_then(|o| truthy(o.per_replica_rps));
        if with_data.len() >= 5 {
            let f = compact_fit(&per_rep, &self_obs, &self_p99_obs, max_lam, s_low);
            let none = log_err(&replay_queue(&f.lam, d.step_s, 1.0, f64::INFINITY, s_low, s99, 1.0, 1.0).0, &f.obs, None);
            let usable = truthy(cpu_limit).map(|cl| cl * throttle.as_ref().map(|t| t.knee).unwrap_or(1.0));
            let cpu_k = match (&cpu, usable) {
                (Some(c), Some(u)) if u != 0.0 && c.per_req > 0.0 => (u - c.base).max(0.0) / c.per_req,
                _ => f64::INFINITY,
            };
            let cpu_c = truthy(cpu_limit).map(|cl| js_round(cl).max(1.0)).unwrap_or(1.0);
            let mut cpu_fit = Fitted { c: cpu_c, k: cpu_k, s: s_low, v: 1.0, err: f64::INFINITY, tied: None };
            if cpu_k.is_finite() {
                let w = queue_waits(&f.lam, cpu_c, cpu_k);
                for &v in &VARIABILITY {
                    let err = log_err(&replay_waits(&f.lam, &w, d.step_s, cpu_k, s_low, s99, 1.0, v).0, &f.obs, None);
                    if err < cpu_fit.err {
                        cpu_fit = Fitted { c: cpu_c, k: cpu_k, s: s_low, v, err, tied: None };
                    }
                }
            }
            let servers_ov: Option<Vec<f64>> = ov.and_then(|o| truthy(o.servers)).map(|x| vec![x]);
            let free = fit_free(&f.lam, &f.obs, d.step_s, s_low, s99, max_lam, servers_ov.as_deref());
            let tied = fit_tied(&f.lam, &f.obs, d.step_s, s_low, s99, servers_ov.as_deref());
            // the tied model is physically grounded; the free one has to be clearly better to win
            let mut queue = if tied.err <= free.err / 0.85 { Fitted { tied: Some(true), ..tied } } else { Fitted { tied: Some(false), ..free } };
            // while a service was overloaded, what finished per second *is* its capacity
            let saturated: Vec<usize> = with_data.iter().map(|x| x.0).filter(|&i| self_obs[i].unwrap_or(0.0) > (4.0 * s_low).max(s_low + 500.0)).collect();
            if let (Some(done), true, None) = (&s.done_rps, saturated.len() >= 2, &servers_ov) {
                let ks: Vec<f64> = saturated.iter().map(|&i| vals(Some(done), i).unwrap_or(f64::NAN) / rep_at(i).unwrap_or(replicas).max(1.0)).filter(|k| k.is_finite() && *k > 0.0).collect();
                if ks.len() >= 2 {
                    let seen = median(&ks);
                    let at_seen = fit_at_k(&f.lam, &f.obs, d.step_s, s_low, s99, seen);
                    if at_seen.err <= queue.err * 1.15 {
                        queue = at_seen;
                        notes.push(format!("capacity seen directly: {} req/s per replica finished while it was overloaded ({} buckets)", js_to_fixed(seen, 1), saturated.len()));
                    }
                }
            }
            let simple = none.min(cpu_fit.err);
            // CPU that reached its limit in the history is capacity seen directly
            let mut cpu_peak: f64 = 0.0;
            if let (Some(_), Some(cl), Some(cc)) = (&cpu, truthy(cpu_limit), &s.cpu_cores) {
                for i in 0..n {
                    let c = vals(Some(cc), i);
                    let r = rep_at(i).unwrap_or(replicas);
                    if let Some(c) = c {
                        if r > 0.0 {
                            cpu_peak = js_max(cpu_peak, [c / (r * cl)]);
                        }
                    }
                }
            }
            let pinned = |i: usize| {
                let c = vals(s.cpu_cores.as_ref(), i);
                let r = rep_at(i).unwrap_or(replicas);
                match (c, truthy(cpu_limit)) {
                    (Some(c), Some(cl)) if r > 0.0 => c / (r * cl) >= 0.95,
                    _ => false,
                }
            };
            let seen_at_saturation = || {
                let mut seen: f64 = 0.0;
                if let (Some(done), Some(_), Some(_)) = (&s.done_rps, &cpu, truthy(cpu_limit)) {
                    for i in 0..n {
                        if let Some(k) = vals(Some(done), i) {
                            if pinned(i) {
                                seen = js_max(seen, [k / rep_at(i).unwrap_or(replicas)]);
                            }
                        }
                    }
                }
                seen
            };
            let seen_while_overloaded = || {
                let mut ks = vec![];
                if let (Some(done), Some(_), Some(_)) = (&s.done_rps, &cpu, truthy(cpu_limit)) {
                    for i in 0..n {
                        if let Some(k) = vals(Some(done), i) {
                            if pinned(i) && overloaded[i] {
                                ks.push(k / rep_at(i).unwrap_or(replicas));
                            }
                        }
                    }
                }
                if ks.len() >= 2 {
                    median(&ks)
                } else {
                    0.0
                }
            };
            let cpu_seen_k = |fallback: f64| {
                let s = seen_at_saturation();
                if s != 0.0 && !s.is_nan() {
                    s
                } else {
                    fallback
                }
            };
            let mut chosen: Option<Fitted> = None;
            let mut chosen_is_cpu_fit = false;
            let mut cpu_saturated = false;
            // an overload in the history brackets the limit
            struct Knee {
                healthy: f64,
                broke: f64,
                collapse: f64,
                pinned: bool,
            }
            let mut knee: Option<Knee> = None;
            {
                let done = s.done_rps.as_ref().or(s.rps.as_ref());
                let entry: Vec<&crate::dataset::EndpointSeries> = d.endpoints.values().filter(|e| e.service == *id && e.rps.is_some()).collect();
                let traced: Vec<(&String, &EndpointShape)> = topo.map(|t| t.endpoints.iter().collect()).unwrap_or_default();
                let via: Vec<(&crate::dataset::EndpointSeries, f64)> = d
                    .endpoints
                    .iter()
                    .map(|(eid, e)| {
                        let v = traced_endpoint(&traced, eid).and_then(|k| traced[k].1.visits.get(id).copied()).unwrap_or(0.0);
                        (e, v)
                    })
                    .filter(|(e, v)| *v > 0.0 && e.rps.is_some())
                    .collect();
                let offered = |i: usize| -> f64 {
                    let r = rep_at(i).unwrap_or(replicas).max(1.0);
                    if !entry.is_empty() {
                        entry.iter().fold(0.0, |a, e| a + vals(e.rps.as_ref(), i).unwrap_or(0.0)) / r
                    } else if !via.is_empty() {
                        via.iter().fold(0.0, |a, (e, v)| a + vals(e.rps.as_ref(), i).unwrap_or(0.0) * v) / r
                    } else {
                        per_rep[i]
                    }
                };
                let mut healthy: f64 = 0.0;
                let mut broke = f64::INFINITY;
                let mut collapse: Vec<f64> = vec![];
                let mut collapse_pinned = 0usize;
                let mine = |i: usize| overloaded[i] && self_obs[i].unwrap_or(0.0) > (4.0 * s_low).max(s_low + 200.0);
                for i in 1..n {
                    let r = rep_at(i).unwrap_or(replicas);
                    let k = vals(done, i);
                    let lam0 = offered(i);
                    if !overloaded[i] && !overloaded[i - 1] && i + 1 < n && !overloaded[i + 1] {
                        if let Some(k) = k {
                            healthy = js_max(healthy, [(k / r).min(lam0)]);
                        }
                    }
                    if mine(i) && !overloaded[i - 1] {
                        broke = broke.min(js_max(lam0, [offered(i - 1)]));
                    }
                    if mine(i) && mine(i - 1) {
                        if let Some(k) = k {
                            collapse.push(k / r);
                            if cpu.is_some() && truthy(cpu_limit).is_some() && pinned(i) {
                                collapse_pinned += 1;
                            }
                        }
                    }
                }
                if broke.is_finite() && healthy > 0.0 && broke >= healthy * 0.9 {
                    knee = Some(Knee { healthy, broke: js_max(broke, [healthy]), collapse: if collapse.len() >= 2 { median(&collapse) } else { 0.0 }, pinned: collapse.len() >= 2 && collapse_pinned as f64 >= collapse.len() as f64 / 2.0 });
                }
            }
            if let Some(rps) = ov_rps {
                capacity = Capacity { limit: "concurrency".into(), servers: ov.and_then(|o| o.servers).unwrap_or(1.0), per_replica_rps: rps, band: None, samples: None, overloaded_rps: None, throttle: None, cpu_alone: false };
            } else if knee.as_ref().map(|k| !(cpu_peak >= 0.9 && !(k.collapse != 0.0 && !k.collapse.is_nan()))).unwrap_or(false) {
                let kn = knee.as_ref().unwrap();
                // seen breaking: the limit lies between what it handled and where it broke
                let k = (kn.healthy + kn.broke) / 2.0;
                let lim = if (cpu_k.is_finite() && (cpu_k - k).abs() / k < 0.25) || kn.pinned { "cpu" } else { "concurrency" };
                let shape_fit = if queue.err <= cpu_fit.err { queue } else { cpu_fit };
                capacity = Capacity { limit: lim.into(), servers: shape_fit.c.max(1.0), per_replica_rps: k, band: Some([kn.healthy, kn.broke]), samples: None, overloaded_rps: None, throttle: None, cpu_alone: false };
                // its queue showed in its own spans: keep the latency fit's shape
                chosen = Some(Fitted { k, ..shape_fit });
                cpu_saturated = true;
                if kn.collapse != 0.0 && !kn.collapse.is_nan() && kn.collapse < k * 0.8 {
                    capacity.overloaded_rps = Some(kn.collapse);
                    notes.push(format!(
                        "broke between {} and {} req/s per replica, and while overloaded finished only {} req/s — a metastable failure: it stays down until the backlog is gone",
                        js_to_fixed(kn.healthy, 0),
                        js_to_fixed(kn.broke, 0),
                        js_to_fixed(kn.collapse, 0)
                    ));
                } else {
                    notes.push(format!("broke between {} and {} req/s per replica in the history", js_to_fixed(kn.healthy, 0), js_to_fixed(kn.broke, 0)));
                }
            } else if cpu_peak >= 0.9 && cpu_k.is_finite() && cpu_seen_k(cpu_k) < (if queue.k.is_finite() && queue.err < simple * 0.85 { queue.k / 1.1 } else { f64::INFINITY }) {
                let seen = seen_at_saturation();
                let mut busy: Vec<usize> = with_data.iter().map(|x| x.0).collect();
                js_sort_by(&mut busy, |a, b| per_rep[*b] - per_rep[*a]);
                busy.truncate(3.max((with_data.len() as f64 * 0.15).floor() as usize));
                let mut eff = vec![];
                for &i in &busy {
                    let c = vals(s.cpu_cores.as_ref(), i);
                    let r = rep_at(i).unwrap_or(replicas);
                    if let (Some(c), Some(cl)) = (c, truthy(cpu_limit)) {
                        if c > 0.0 && r > 0.0 {
                            eff.push((per_rep[i] * cl) / (c / r));
                        }
                    }
                }
                let at_limit = if eff.is_empty() { 0.0 } else { median(&eff) };
                let collapsed = seen_while_overloaded();
                let or = |a: f64, b: f64| if a != 0.0 && !a.is_nan() { a } else { b };
                let k = or(collapsed, or(js_max(seen, [at_limit]), cpu_k));
                capacity = Capacity { limit: "cpu".into(), servers: cpu_c, per_replica_rps: k, band: None, samples: None, overloaded_rps: None, throttle: None, cpu_alone: false };
                chosen = Some(Fitted { k, v: cpu_fit.v.max(1.0), ..cpu_fit });
                cpu_saturated = true;
                hidden_queue.insert(id.clone());
                notes.push(if collapsed != 0.0 && !collapsed.is_nan() {
                    format!(
                        "CPU reached {}% of its limit while users were timing out: {} req/s per replica is what it could still finish ({} would follow from CPU efficiency when it was not overloaded)",
                        js_num(js_round(cpu_peak * 100.0)),
                        js_to_fixed(collapsed, 1),
                        js_to_fixed(at_limit, 1)
                    )
                } else {
                    format!(
                        "CPU reached {}% of its limit in the history; capacity {} req/s per replica ({}{} from CPU efficiency in the busiest buckets)",
                        js_num(js_round(cpu_peak * 100.0)),
                        js_to_fixed(k, 1),
                        if seen > 0.0 { format!("{} finished while pinned, ", js_to_fixed(seen, 1)) } else { String::new() },
                        js_to_fixed(at_limit, 1)
                    )
                });
            } else if queue.err < simple * 0.85 && queue.k.is_finite() && queue.k < max_lam * 40.0 {
                let limited_by_cpu = cpu_k.is_finite() && (queue.k - cpu_k).abs() / cpu_k < 0.25;
                capacity = Capacity { limit: if limited_by_cpu { "cpu" } else { "concurrency" }.into(), servers: queue.c, per_replica_rps: queue.k, band: None, samples: None, overloaded_rps: None, throttle: None, cpu_alone: false };
                chosen = Some(queue);
                if queue.tied == Some(true) {
                    notes.push(format!("{} at a time, each holding it {} ms (a lock or pool)", js_num(queue.c), js_to_fixed(queue.s, if queue.s < 10.0 { 1 } else { 0 })));
                }
            } else if cpu_fit.err.is_finite() && cpu_fit.err <= none * 1.1 {
                capacity = Capacity { limit: "cpu".into(), servers: cpu_c, per_replica_rps: cpu_k, band: None, samples: None, overloaded_rps: None, throttle: None, cpu_alone: false };
                chosen = Some(cpu_fit);
                chosen_is_cpu_fit = true;
            } else if cpu_k.is_finite() {
                // load never came close: the CPU limit is the only limit we know of
                capacity = Capacity { limit: "cpu".into(), servers: cpu_c, per_replica_rps: cpu_k, band: None, samples: None, overloaded_rps: None, throttle: None, cpu_alone: false };
                chosen = Some(cpu_fit);
                chosen_is_cpu_fit = true;
                notes.push("load never approached capacity; the CPU limit is extrapolated".into());
            }
            // where the history shows it breaking while throttled, the quota is the ceiling
            if throttle.is_some() && throttle_bound && cpu_k.is_finite() && capacity.per_replica_rps > cpu_k * 1.05 && ov_rps.is_none() {
                notes.push(format!("the latency history reads {} req/s per replica, but the CPU quota throttles it at {}: capped there", js_to_fixed(capacity.per_replica_rps, 0), js_to_fixed(cpu_k, 0)));
                capacity = Capacity { limit: "cpu".into(), servers: cpu_c, per_replica_rps: cpu_k, band: None, samples: None, overloaded_rps: None, throttle: None, cpu_alone: false };
                let obs: Vec<Num> = f.obs.iter().enumerate().map(|(i, x)| if f.lam[i] > cpu_k { None } else { *x }).collect();
                cpu_fit = Fitted { c: cpu_c, k: cpu_k, s: s_low, v: 1.0, err: f64::INFINITY, tied: None };
                let w = queue_waits(&f.lam, cpu_c, cpu_k);
                for &v in &VARIABILITY {
                    let err = log_err(&replay_waits(&f.lam, &w, d.step_s, cpu_k, s_low, s99, 1.0, v).0, &obs, None);
                    if err < cpu_fit.err {
                        cpu_fit = Fitted { c: cpu_c, k: cpu_k, s: s_low, v, err, tied: None };
                    }
                }
                chosen = Some(cpu_fit);
                chosen_is_cpu_fit = true;
                throttle_capped = true;
            }
            if let Some(ch) = &chosen {
                variability = if ch.err.is_finite() { ch.v } else { 1.0 };
                self_mean = ch.s;
                self_p99 = ch.s.max(s99 - (s_low - ch.s));
            }
            let tied_k = chosen.map(|c| c.tied == Some(true)).unwrap_or(false);

            let cpu_only = capacity.limit == "cpu" && (chosen_is_cpu_fit || cpu_saturated) && cpu.is_some() && truthy(cpu_limit).is_some() && cpu_se.is_finite();
            if cpu_saturated && b_draws > 0 && knee.is_some() && capacity.band.is_some() {
                let [lo, hi] = capacity.band.unwrap();
                capacity.samples = Some((0..b_draws).map(|_| lo + (hi - lo) * rand()).collect());
            } else if cpu_saturated && b_draws > 0 {
                // seen directly at saturation: a narrow band around it
                let rel = match &cpu {
                    Some(c) if cpu_se.is_finite() && c.per_req > 0.0 => (cpu_se / c.per_req).min(0.15),
                    _ => 0.05,
                };
                capacity.band = Some([capacity.per_replica_rps * (1.0 - 1.28 * rel - 0.03), capacity.per_replica_rps * (1.0 + 1.28 * rel + 0.03)]);
                let k = capacity.per_replica_rps;
                capacity.samples = Some((0..b_draws).map(|_| k * (1.0 + (rand() * 2.0 - 1.0) * (1.28 * rel + 0.03))).collect());
            } else if cpu_only && b_draws > 0 {
                // the band comes from how well CPU per request is known (slope ± its standard error)
                let c = cpu.as_ref().unwrap();
                let mut draws = vec![];
                for _ in 0..b_draws {
                    let u1 = rand();
                    let u2 = rand();
                    let z = (-2.0 * u1.max(1e-12).js_ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).js_cos();
                    let slope = (c.per_req * 0.2).max(c.per_req + z * cpu_se);
                    draws.push((usable.unwrap_or(cpu_limit.unwrap()) - c.base).max(0.0) / slope);
                }
                js_sort_by(&mut draws, |a, b| a - b);
                capacity.band = Some([quantile(&draws, 0.1), quantile(&draws, 0.9)]);
                capacity.samples = Some(draws);
            } else if capacity.per_replica_rps.is_finite() && b_draws > 0 && ov_rps.is_none() {
                // bootstrap the capacity (blocks of 6 buckets): every draw scores the same replays with
                // its own weights, so the replays run once
                let fn_ = f.lam.len();
                let blocks = (fn_ as f64 / 6.0).ceil() as usize;
                let cs: Vec<f64> = if tied_k {
                    let mut v: Vec<f64> = vec![];
                    for x in [(capacity.servers - 1.0).max(1.0), capacity.servers, capacity.servers + 1.0] {
                        if !v.contains(&x) {
                            v.push(x);
                        }
                    }
                    v
                } else {
                    vec![capacity.servers]
                };
                // (K, replayed mean) in the order the draws try them
                let mut grid: Vec<(f64, Vec<f64>)> = vec![];
                for &c in &cs {
                    let ks: Vec<f64> = (-12..=12).map(|j| capacity.per_replica_rps * 1.04f64.js_pow(j as f64) * (if tied_k { c / capacity.servers } else { 1.0 })).collect();
                    let waits: Vec<Vec<(f64, f64)>> = ks.iter().map(|&k| queue_waits(&f.lam, c, k)).collect();
                    for &v in &VARIABILITY {
                        for (jj, &k) in ks.iter().enumerate() {
                            let sv = if tied_k { (c * 1000.0) / k } else { self_mean };
                            if tied_k && (sv < s_low * 0.4 || sv > s_low * 1.05) {
                                continue;
                            }
                            grid.push((k, replay_waits(&f.lam, &waits[jj], d.step_s, k, sv, self_p99 + (sv - self_mean), 1.0, v).0));
                        }
                    }
                }
                let mut draws = vec![];
                for _ in 0..b_draws {
                    let mut w = vec![0.0; fn_];
                    for _ in 0..blocks {
                        let start = (rand() * blocks as f64).floor() as usize * 6;
                        for j in start..fn_.min(start + 6) {
                            w[j] += 1.0;
                        }
                    }
                    let mut best_k = capacity.per_replica_rps;
                    let mut best_e = f64::INFINITY;
                    for (k, mean) in &grid {
                        let e = log_err(mean, &f.obs, Some(&w));
                        if e < best_e {
                            best_e = e;
                            best_k = *k;
                        }
                    }
                    draws.push(best_k);
                }
                js_sort_by(&mut draws, |a, b| a - b);
                capacity.band = Some([quantile(&draws, 0.1), quantile(&draws, 0.9)]);
                capacity.samples = Some(draws);
            }

            // a limit the history never came near is an extrapolation: when CPU and latency read it
            // differently, the band has to span both
            if capacity.per_replica_rps.is_finite() && cpu_k.is_finite() && !cpu_saturated && max_lam < capacity.per_replica_rps * 0.85 && (cpu_k - capacity.per_replica_rps).abs() / capacity.per_replica_rps > 0.1 && b_draws > 0 {
                let lo = cpu_k.min(capacity.per_replica_rps).min(capacity.band.map(|b| b[0]).unwrap_or(f64::INFINITY));
                let hi = js_max(cpu_k, [capacity.per_replica_rps, capacity.band.map(|b| b[1]).unwrap_or(0.0)]);
                capacity.samples = Some((0..b_draws).map(|_| lo * (hi / lo).js_pow(rand())).collect());
                capacity.band = Some([lo * (hi / lo).js_pow(0.1), lo * (hi / lo).js_pow(0.9)]);
                capacity.per_replica_rps = (lo * hi).sqrt();
                notes.push(format!(
                    "never loaded past {}% of capacity: CPU ({}) and latency ({}) read the limit differently, the band spans both",
                    js_num(js_round((max_lam / capacity.per_replica_rps) * 100.0)),
                    js_to_fixed(cpu_k, 0),
                    js_to_fixed(capacity.per_replica_rps, 0)
                ));
            }

            // tail multiplier on queueing excess
            let (mut best_t, mut best_e) = (1.0, f64::INFINITY);
            let tw = queue_waits(&f.lam, capacity.servers, capacity.per_replica_rps);
            for t in [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.15, 1.3, 1.5, 1.75, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 6.0] {
                let e = log_err(&replay_waits(&f.lam, &tw, d.step_s, capacity.per_replica_rps, self_mean, self_p99, t, variability).1, &f.p99, None);
                if e < best_e {
                    best_e = e;
                    best_t = t;
                }
            }
            tail = best_t;
            let (rm, rp) = replay_queue(&per_rep, d.step_s, capacity.servers, capacity.per_replica_rps, self_mean, self_p99, tail, variability);
            // errors below a few ms don't matter to anyone's p99: floor the denominator
            let k = capacity.per_replica_rps;
            let sustained = |xs: &[Num]| -> Vec<Num> { if throttle_capped { xs.iter().enumerate().map(|(i, x)| if per_rep[i] > k { None } else { *x }).collect() } else { xs.to_vec() } };
            latency_mape = mape(&rm, &sustained(&self_obs), 5.0);
            p99_mape = mape(&rp, &sustained(&self_p99_obs), 5.0);
            if throttle_capped {
                notes.push(format!(
                    "latency fit scored on the {} buckets at or below that capacity: above it the history only held for load-test steps",
                    (0..n).filter(|&i| per_rep[i] <= k && self_obs[i].is_some()).count()
                ));
            }
            if throttle.is_some() && capacity.limit == "cpu" {
                capacity.throttle = throttle.clone();
            }
        } else if let (Some(c), Some(cl), true) = (cpu.as_ref().filter(|c| c.per_req > 0.0 && c.r2 >= 0.3), truthy(cpu_limit), self_obs.iter().all(|x| x.is_none())) {
            // no latency metric at all: the capacity is what the CPU limit (to its throttling knee) allows;
            // with no service time known, a wide queue: no wait to speak of until the limit, then backlog
            let usable = cl * throttle.as_ref().map(|t| t.knee).unwrap_or(1.0);
            let k = (usable - c.base).max(0.0) / c.per_req;
            capacity = Capacity { limit: "cpu".into(), servers: 32.0, per_replica_rps: k, band: None, samples: None, overloaded_rps: None, throttle: throttle.clone(), cpu_alone: true };
            notes.push(format!("no latency metric: capacity read from CPU alone, {} req/s per replica at {} of its {}-core limit", js_to_fixed(k, 1), if throttle.is_some() { "the throttling knee" } else { "all" }, js_num(cl)));
        } else if shape.is_some() {
            notes.push("too little load data to fit capacity; using trace averages".into());
        }

        let mut cpu_mape = None;
        if let (Some(c), Some(cc)) = (&cpu, &s.cpu_cores) {
            let pred: Vec<f64> = (0..n).map(|i| match lam[i] {
                None => f64::NAN,
                Some(l) => rep_at(i).unwrap_or(replicas) * c.base + c.per_req * l,
            }).collect();
            cpu_mape = mape(&pred, cc, 0.01);
        }

        let kind = ov.and_then(|o| o.kind.clone()).unwrap_or_else(|| match shape {
            Some(sh) => {
                if sh.kind == "client" {
                    "server".into()
                } else {
                    sh.kind.clone()
                }
            }
            None => "lb".into(),
        });
        let runtime = shape.and_then(|sh| sh.runtime.clone());
        let (warmup, warm_note) = if hosted { (None, None) } else { warmup_of(runtime.as_deref(), &reps, &lam, s.cpu_cores.as_ref(), cpu.as_ref(), d.step_s) };
        notes.extend(warm_note);
        let mut fit_notes = notes.clone();
        let st;
        if shape.is_none() && s.rps.is_none() {
            st = "cost-only".to_string();
            fit_notes.push("not seen in traces or request metrics — modelled for cost only".into());
        } else {
            st = status(latency_mape);
            match latency_mape {
                None => fit_notes.push("no per-bucket latency to check the model against".into()),
                Some(m) => fit_notes.push(format!("replaying the history reproduces its self time within {}% (mean abs. error)", js_to_fixed(m * 100.0, 0))),
            }
        }
        let regime = regimes.get(id).and_then(|r| crate::regimes::fit_regime(r, d.start, d.step_s));
        if let Some(r) = &regime {
            fit_notes.push(crate::regimes::note(r));
        }
        services.insert(
            id.clone(),
            ServiceModel {
                id: id.clone(),
                kind,
                system: shape.and_then(|sh| sh.system.clone()).filter(|x| !x.is_empty()),
                hosted_by: host_of(id),
                replicas,
                cpu_limit,
                memory_gb: mem_limit.or(if mem_vals.is_empty() { None } else { Some(median(&mem_vals)) }),
                memory,
                requests: requests_of_service(host),
                pods: d.pods_by_node.as_ref().and_then(|p| p.get(id).cloned()),
                hpa: d.hpa.as_ref().and_then(|h| h.get(id).cloned()),
                cpu: cpu.clone(),
                capacity,
                self_time: SelfTime { mean: self_mean, p99: self_mean.max(self_p99) },
                tail,
                variability: Some(variability),
                load_exponent: None,
                cost: CostModel { per_replica_hour: 0.0, per_request: 0.0, cpu_share: 0.8, arch: ov.and_then(|o| o.arch.clone()).unwrap_or_else(|| "x86".into()), source: "none".into() },
                placement: d.placement.as_ref().and_then(|p| p.get(&host_id).cloned()),
                fit: FitQuality { status: st, latency_mape, p99_mape, cpu_mape, cpu_r2: cpu.as_ref().map(|c| c.r2), samples: with_data.len() as f64, notes: fit_notes, regime },
                runtime,
                warmup,
            },
        );
    }

    // ---- cost from the bill ----
    let mut fixed_per_hour = 0.0;
    let bill_hours = d.bill.as_ref().map(|b| ((b.end - b.start) / 3600.0).max(1.0 / 60.0)).unwrap_or(0.0);
    if let Some(b) = &d.bill {
        fixed_per_hour += b.unattributed / bill_hours;
        for (cid, c) in &b.components {
            let sm = match services.get_mut(cid) {
                Some(s) => s,
                None => continue,
            };
            let reps = replicas_run(cid);
            let mut rep_hours = 0.0;
            for i in 0..n {
                let t = d.start + i as f64 * d.step_s;
                if t < b.start || t >= b.end {
                    continue;
                }
                rep_hours += (vals(Some(&reps), i).unwrap_or(sm.replicas) * d.step_s) / 3600.0;
            }
            let cat = |k: &str| c.by_category.get(k).copied();
            let compute = cat("compute").unwrap_or(0.0);
            sm.cost.per_replica_hour = if rep_hours > 0.0 { compute / rep_hours } else { 0.0 };
            let reqs = mean_of(d.services.get(cid).and_then(|s| s.rps.as_ref())).unwrap_or(0.0) * bill_hours * 3600.0;
            sm.cost.per_request = if reqs > 0.0 { cat("requests").unwrap_or(0.0) / reqs } else { 0.0 };
            fixed_per_hour += (cat("storage").unwrap_or(0.0) + cat("other").unwrap_or(0.0) + (if reqs > 0.0 { 0.0 } else { cat("requests").unwrap_or(0.0) })) / bill_hours;
            sm.cost.source = "bill".into();
        }
    }

    // ---- Kubernetes nodes: on a cluster, compute is what the nodes cost ----
    let cluster = cluster_of(d, &services, &replicas_run);
    if let Some(cl) = &cluster {
        for sm in services.values_mut() {
            if sm.cost.source != "none" || sm.hosted_by.is_some() {
                continue;
            }
            let r = match &sm.requests {
                Some(r) => r.clone(),
                None => continue,
            };
            let share = (r.cpu / cl.node.cpu).max(r.memory_gb / cl.node.memory_gb);
            sm.cost.per_replica_hour = cl.node.per_hour * share;
            sm.cost.cpu_share = if r.cpu / cl.node.cpu >= r.memory_gb / cl.node.memory_gb { 1.0 } else { 0.0 };
            sm.cost.source = "nodes".into();
            sm.fit.notes.push(format!("requests {} cores + {} MiB = {}% of a node, ${}/replica-hour", js_num(r.cpu), js_num(js_round(r.memory_gb * 1024.0)), js_to_fixed(share * 100.0, 1), js_to_fixed(sm.cost.per_replica_hour, 4)));
        }
    }

    // ---- list prices where the bill says nothing ----
    let list = match &options.list_prices {
        Some(Value::Bool(true)) => Some(fargate()),
        Some(v @ Value::Object(_)) => serde_json::from_value::<ListPrices>(v.clone()).ok(),
        _ => None,
    };
    if let Some(lp) = list {
        for sm in services.values_mut() {
            if sm.cost.source != "none" || sm.hosted_by.is_some() || sm.kind == "external" {
                continue;
            }
            let cl = match truthy(sm.cpu_limit) {
                Some(c) => c,
                None => {
                    sm.fit.notes.push("no CPU limit in the data, so no list price: its cost reads $0".into());
                    continue;
                }
            };
            let mem = sm.memory_gb.unwrap_or(cl * 2.0);
            let arm = sm.cost.arch == "arm";
            let cpu_d = cl * if arm { lp.arm_per_vcpu_hour } else { lp.per_vcpu_hour };
            let mem_d = mem * if arm { lp.arm_per_gb_hour } else { lp.per_gb_hour };
            sm.cost.per_replica_hour = cpu_d + mem_d;
            sm.cost.cpu_share = cpu_d / (cpu_d + mem_d);
            sm.cost.source = "pricing".into();
            sm.fit.notes.push(format!(
                "priced at list price: {} vCPU{} = ${}/replica-hour ({}); no bill",
                js_num(cl),
                match truthy(sm.memory_gb) {
                    Some(m) => format!(" + {} GB", js_to_fixed(m, 2)),
                    None => format!(" + {} GB (assumed 2 GB per vCPU)", js_num(mem)),
                },
                js_to_fixed(sm.cost.per_replica_hour, 4),
                lp.source
            ));
        }
    }

    // ---- endpoints ----
    let mut endpoints: Map<EndpointModel> = Map::new();
    let empty_shapes = Map::new();
    let shapes: &Map<EndpointShape> = topo.map(|t| &t.endpoints).unwrap_or(&empty_shapes);
    let topo_ids: Vec<&String> = shapes.keys().collect();
    let traced: Vec<(&String, &EndpointShape)> = shapes.iter().collect();
    let series_ids: Vec<String> = if !d.endpoints.is_empty() { d.endpoints.keys().cloned().collect() } else { topo_ids.iter().map(|s| (*s).clone()).collect() };
    let total_rps = series_ids.iter().fold(0.0, |s, id| s + mean_of(d.endpoints.get(id).and_then(|e| e.rps.as_ref())).unwrap_or(0.0));
    for id in &series_ids {
        let shape = traced_endpoint(&traced, id).map(|k| traced[k].1);
        let ser = d.endpoints.get(id);
        let mut notes: Vec<String> = vec![];
        if shape.is_none() {
            notes.push("no traces for this endpoint — its path through the system is unknown".into());
        }
        let first_word = id.split(' ').next().unwrap_or("").to_string();
        let ser_service = ser.map(|s| s.service.clone()).filter(|s| !s.is_empty()).unwrap_or_else(|| first_word.clone());
        let mut weights: Map<f64> = Map::new();
        if let Some(sh) = shape {
            for (svc, ms) in &sh.critical_ms {
                let m = topo.and_then(|t| t.services.get(svc)).map(|x| x.self_mean_ms).unwrap_or(0.0);
                if m > 0.01 {
                    weights.insert(svc.clone(), ms / m);
                }
            }
        }
        // low-traffic buckets → overhead and baseline excess
        let empty_rps = vec![];
        let rps: &Vec<Num> = ser.and_then(|s| s.rps.as_ref()).unwrap_or(&empty_rps);
        let mut idx: Vec<(f64, usize)> = rps.iter().enumerate().map(|(i, v)| (v.unwrap_or(0.0), i)).filter(|x| x.0 > 0.0).collect();
        js_sort_by(&mut idx, |a, b| a.0 - b.0);
        let low_idx: Vec<usize> = idx[..3.max((idx.len() as f64 * 0.3).floor() as usize).min(idx.len())].iter().map(|x| x.1).collect();
        // the baseline is read where nothing on the path queues (the wait the replay adds at that
        // load is under a tenth of each service's own time), weighted by the requests each bucket
        // carried: what the clients saw. The quietest buckets alone can be the slowest ones — a
        // service idling between requests wakes for each (PetClinic's gateway path: 6 ms at 20
        // req/s, 3.5 ms at 60) — so they are the baseline only when the history queued most of the time
        let path: Vec<&String> = match shape {
            Some(sh) => sh.visits.keys().collect(),
            None => vec![&ser_service],
        };
        let calm_idx: Vec<usize> = (0..rps.len())
            .filter(|&i| {
                rps[i].unwrap_or(0.0) > 0.0
                    && path.iter().all(|svc| {
                        let (sm, ss) = match (services.get(*svc), d.services.get(*svc)) {
                            (Some(sm), Some(ss)) => (sm, ss),
                            _ => return true,
                        };
                        let lam = match vals(ss.rps.as_ref(), i) {
                            Some(l) => l / vals(ss.replicas.as_ref(), i).unwrap_or(sm.replicas).max(1.0),
                            None => return true,
                        };
                        let w = mmc_wait(lam, sm.capacity.servers, sm.capacity.per_replica_rps);
                        let le = sm.load_exponent.unwrap_or(1.0) - 1.0;
                        let v = sm.variability.unwrap_or(1.0) * if le == 0.0 { 1.0 } else { w.rho.min(1.0).js_pow(le) };
                        v * w.mean_ms <= 0.1 * sm.self_time.mean
                    })
            })
            .collect();
        let base_idx: &Vec<usize> = if calm_idx.len() >= low_idx.len() { &calm_idx } else { &low_idx };
        let low_of = |a: Option<&Vec<Num>>| weighted_median(&base_idx.iter().filter_map(|&i| Some((vals(a, i)?, rps[i].unwrap_or(0.0)))).collect::<Vec<_>>());
        let low_mean = low_of(ser.and_then(|s| s.mean_ms.as_ref()));
        let low_p99 = low_of(ser.and_then(|s| s.p99_ms.as_ref()));
        let low_p50 = low_of(ser.and_then(|s| s.p50_ms.as_ref()));
        let path_mean = weights.iter().fold(0.0, |a, (svc, w)| a + w * services.get(svc).map(|s| s.self_time.mean).unwrap_or(0.0));
        let measured_mean = if low_mean.is_finite() {
            low_mean
        } else if low_p50.is_finite() && low_p50 > 0.0 {
            low_p50
        } else {
            shape.map(|sh| sh.low_mean_ms.unwrap_or(sh.mean_ms)).unwrap_or(path_mean)
        };
        let measured_p99 = if low_p99.is_finite() { low_p99 } else { shape.map(|sh| sh.low_p99_ms.unwrap_or(sh.p99_ms)).unwrap_or(measured_mean * 1.5) };
        if path_mean > measured_mean * 1.1 && measured_mean > 0.0 {
            let k = measured_mean / path_mean;
            for w in weights.values_mut() {
                *w *= k;
            }
            notes.push(format!("its services' self times along the path add up to {} ms, above the {} ms it measured at low load: path weights scaled by {}", js_to_fixed(path_mean, 1), js_to_fixed(measured_mean, 1), js_to_fixed(k, 2)));
        }
        // baseline errors: request-weighted over the low-traffic buckets
        let (mut err_n, mut err_f) = (0.0, 0.0);
        for &i in &low_idx {
            if let (Some(e), Some(nn)) = (vals(ser.and_then(|s| s.error_rate.as_ref()), i), vals(ser.and_then(|s| s.rps.as_ref()), i)) {
                err_n += nn;
                err_f += nn * e;
            }
        }
        let mut errs: Option<f64> = if err_n > 0.0 { Some(err_f / err_n) } else { None };
        let mut error_slope: Option<f64> = None;
        {
            let (mut xs, mut ys) = (vec![], vec![]);
            for i in 0..rps.len() {
                let e = vals(ser.and_then(|s| s.error_rate.as_ref()), i);
                let nn = vals(ser.and_then(|s| s.rps.as_ref()), i);
                let p = vals(ser.and_then(|s| s.p99_ms.as_ref()), i);
                let (e, nn) = match (e, nn) {
                    (Some(e), Some(nn)) if nn > 0.0 && e <= 0.2 && !matches!(p, Some(p) if p >= timeout_ms * 0.5) => (e, nn),
                    _ => continue,
                };
                xs.push(nn);
                ys.push(e);
            }
            if let Some(fit) = regress(&xs, &ys) {
                if fit.slope > 0.0 && fit.se < fit.slope / 2.0 && xs.len() >= 10 {
                    error_slope = Some(fit.slope);
                    errs = Some(fit.intercept.max(0.0));
                    notes.push(format!("errors grow with traffic: {}% + {}% per req/s", js_to_fixed(fit.intercept * 100.0, 2), js_to_fixed(fit.slope * 100.0, 3)));
                }
            }
        }
        // services on the path that ran throttled under a limit below one core
        let default_visits: Map<f64> = [(ser_service.clone(), 1.0)].into_iter().collect();
        let mut stalls: Vec<Stall> = vec![];
        for svc in shape.map(|sh| &sh.visits).unwrap_or(&default_visits).keys() {
            let lim = match services.get(svc).and_then(|s| truthy(s.cpu_limit)) {
                Some(l) if l < 1.0 => l,
                _ => continue,
            };
            if services.get(svc).map(|s| s.hosted_by.is_some()).unwrap_or(false) {
                continue;
            }
            let th = median(&low_idx.iter().filter_map(|&i| vals(d.services.get(svc).and_then(|s| s.cpu_throttled.as_ref()), i)).collect::<Vec<_>>());
            if th.is_finite() && th >= 0.01 {
                stalls.push(Stall { service: svc.clone(), limit: lim });
            }
        }
        let stall_ms = js_max(0.0, stalls.iter().map(|x| cfs_stall_ms(Some(x.limit))));
        if !stalls.is_empty() {
            notes.push(format!(
                "{} ran throttled under a CPU limit below one core: {} ms of the p99 is read as a CFS stall, which a higher limit shortens",
                stalls.iter().map(|x| x.service.clone()).collect::<Vec<_>>().join(", "),
                js_num(js_round(stall_ms))
            ));
        }
        let shape_p50 = shape.and_then(|sh| truthy(sh.low_p50_ms.or(sh.p50_ms)));
        let shape_p90 = shape.and_then(|sh| truthy(sh.low_p90_ms.or(sh.p90_ms)));
        endpoints.insert(
            id.clone(),
            EndpointModel {
                id: id.clone(),
                service: shape.map(|sh| sh.service.clone()).unwrap_or_else(|| ser_service.clone()),
                share: if total_rps > 0.0 { mean_of(ser.and_then(|s| s.rps.as_ref())).unwrap_or(0.0) / total_rps } else { 1.0 / series_ids.len() as f64 },
                visits: shape.map(|sh| sh.visits.clone()).unwrap_or_else(|| default_visits.clone()),
                calls: shape.map(|sh| sh.calls.clone()).unwrap_or_default(),
                weights: if shape.is_some() { weights } else { default_visits.clone() },
                overhead_ms: (measured_mean - path_mean.min(measured_mean)).max(0.0),
                base_excess_ms: (measured_p99 - measured_mean - stall_ms).max(0.0),
                base_p50_ms: if low_p50.is_finite() && low_p50 > 0.0 { Some(low_p50) } else { shape_p50 },
                base_p90_ms: if !low_p99.is_finite() { shape_p90 } else { None },
                tail: 1.0,
                error_rate: match errs {
                    Some(e) => e.min(0.5),
                    None => shape.map(|sh| sh.error_rate).unwrap_or(0.0),
                },
                error_slope: truthy(error_slope),
                stalls: if stalls.is_empty() { None } else { Some(stalls) },
                bytes: shape.map(|sh| sh.bytes.clone()).unwrap_or_default(),
                egress_bytes: 0.0,
                slo: ep_opts.get(id).and_then(|e| e.slo.clone()).unwrap_or_else(|| slo.clone()),
                fit: FitQuality { status: if shape.is_some() { "good".into() } else { "poor".into() }, samples: rps.iter().filter(|x| x.is_some()).count() as f64, notes, ..Default::default() },
            },
        );
    }

    // egress bytes per request: from the bill's transfer line when there is one
    if let Some(b) = &d.bill {
        let transfer = b.components.values().fold(0.0, |a, c| a + c.by_category.get("transfer").copied().unwrap_or(0.0));
        let reqs = total_rps * bill_hours * 3600.0;
        if transfer > 0.0 && reqs > 0.0 {
            for e in endpoints.values_mut() {
                e.egress_bytes = ((transfer / TransferPrices::aws().internet_gb) * GIB) / reqs;
            }
        }
    }

    let mut model = Model {
        version: 1.0,
        name: d.name.clone(),
        timeout_ms,
        slo: slo.clone(),
        services,
        endpoints,
        transfer: TransferPrices::aws(),
        unattributed_per_hour: fixed_per_hour,
        accuracy: Accuracy::default(),
        fitted_on: Some(FittedOn { start: d.start, end: d.start + d.n * d.step_s, step_s: d.step_s, buckets: d.n }),
        traffic: None,
        cluster,
    };

    // ---- endpoint tail + fit quality: replay the whole history through the full model ----
    let traffic = traffic_of(d, &model);
    let mut totals: Vec<f64> = (0..n).map(|i| traffic.endpoints.values().fold(0.0, |a, s| a + s.get(i).copied().flatten().unwrap_or(0.0))).filter(|x| *x > 0.0).collect();
    js_sort_by(&mut totals, |a, b| a - b);
    if !totals.is_empty() {
        model.traffic = Some(TrafficSummary { mean: totals.iter().fold(0.0, |a, x| a + x) / totals.len() as f64, p90: quantile(&totals, 0.9), peak: totals[totals.len() - 1] });
    }
    let observed: Map<Option<Vec<Num>>> = model.services.keys().map(|id| (id.clone(), Some(replicas_of(id)))).collect();
    let ropts = Opts::default();
    if !traffic.endpoints.is_empty() {
        let ep_ids: Vec<String> = model.endpoints.keys().cloned().collect();
        let use_of = |obs: &Vec<Num>, slo_p99: f64| -> Vec<Num> {
            let everyday: Vec<Num> = obs.iter().map(|x| x.filter(|v| *v <= slo_p99)).collect();
            if everyday.iter().filter(|x| x.is_some()).count() >= 10 {
                everyday
            } else {
                obs.clone()
            }
        };
        let tails = [0.5, 0.7, 0.85, 1.0, 1.15, 1.3, 1.5, 1.75, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 6.0];
        // an endpoint's p99 depends on its own tail alone (the base plan has no retries), so one replay
        // per tail value scores every endpoint at once
        let fit_tails = |model: &mut Model| -> f64 {
            let fitted: Vec<(&String, &Vec<Num>)> = ep_ids.iter().filter_map(|id| d.endpoints.get(id).and_then(|e| e.p99_ms.as_ref()).map(|o| (id, o))).collect();
            let uses: Vec<Vec<Num>> = fitted.iter().map(|(id, obs)| use_of(obs, model.endpoints[*id].slo.p99_ms)).collect();
            let mut best: Vec<(f64, f64)> = vec![(1.0, f64::INFINITY); fitted.len()];
            for t in tails {
                for (id, _) in &fitted {
                    model.endpoints.get_mut(*id).unwrap().tail = t;
                }
                let r = run_plan(&base_plan(model, Some(&observed)), &traffic, &ropts);
                for (j, (id, _)) in fitted.iter().enumerate() {
                    let err = log_err(&r.endpoints[*id].p99_ms, &uses[j], None);
                    if err < best[j].1 {
                        best[j] = (t, err);
                    }
                }
            }
            let mut total = 0.0;
            for (j, (id, _)) in fitted.iter().enumerate() {
                model.endpoints.get_mut(*id).unwrap().tail = best[j].0;
                let share = model.endpoints[*id].share;
                total += best[j].1 * (if share != 0.0 && !share.is_nan() { share } else { 0.01 });
            }
            total
        };
        // a queue the spans can't see is read from the endpoints instead: how steeply it rises with load
        if !hidden_queue.is_empty() {
            let (mut best_k, mut best_err) = (1.0, f64::INFINITY);
            let mut best_tails: Map<f64> = Map::new();
            for k in [1.0, 1.5, 2.0, 3.0, 4.0] {
                for id in &hidden_queue {
                    model.services.get_mut(id).unwrap().load_exponent = Some(k);
                }
                let err = fit_tails(&mut model);
                if err < best_err {
                    best_k = k;
                    best_err = err;
                    best_tails = model.endpoints.iter().map(|(id, e)| (id.clone(), e.tail)).collect();
                }
            }
            for id in &hidden_queue {
                let s = model.services.get_mut(id).unwrap();
                s.load_exponent = Some(best_k);
                if best_k != 1.0 {
                    s.fit.notes.push(format!("queueing outside its spans rises steeply with load (exponent {}, read from end-to-end latency)", js_num(best_k)));
                }
            }
            for (id, t) in best_tails {
                model.endpoints.get_mut(&id).unwrap().tail = t;
            }
        } else {
            // everyday latency decides the tail: buckets within the SLO
            fit_tails(&mut model);
        }
        let r = run_plan(&base_plan(&model, Some(&observed)), &traffic, &ropts);
        for id in &ep_ids {
            let ser = match d.endpoints.get(id) {
                Some(s) if s.p99_ms.is_some() => s,
                _ => continue,
            };
            let p99m = mape(&r.endpoints[id].p99_ms, ser.p99_ms.as_ref().unwrap(), 1.0);
            let meanm = ser.mean_ms.as_ref().and_then(|m| mape(&r.endpoints[id].mean_ms, m, 1.0));
            let e = model.endpoints.get_mut(id).unwrap();
            e.fit.p99_mape = p99m;
            e.fit.latency_mape = meanm;
            e.fit.status = if e.fit.status == "poor" { "poor".into() } else { status(p99m) };
            e.fit.notes.push(format!("replaying the history reproduces its p99 within {}% (mean abs. error)", js_to_fixed(p99m.unwrap_or(0.0) * 100.0, 0)));
        }
    }
    model
}

#[cfg(test)]
mod warmup_tests {
    use super::*;

    #[test]
    fn a_pod_start_in_the_history_measures_the_warm_up() {
        // 2 → 3 pods at minute 5: 0.3 cores above the line for 2 minutes (36 core-seconds), then back on it
        let c = CpuModel { base: 0.02, per_req: 0.001, r2: 0.9 };
        let n = 30;
        let reps: Vec<Num> = (0..n).map(|i| Some(if i < 10 { 2.0 } else { 3.0 })).collect();
        let lam: Vec<Num> = vec![Some(60.0); n];
        let cpu: Vec<Num> = (0..n).map(|i| Some(reps[i].unwrap() * c.base + c.per_req * 60.0 + if (10..14).contains(&i) { 0.3 } else { 0.0 })).collect();
        let (w, note) = warmup_of(Some("jvm"), &reps, &lam, Some(&cpu), Some(&c), 30.0);
        let w = w.unwrap();
        assert_eq!((w.core_s, w.source.as_str(), w.cold), (36.0, "calibrated", JVM_COLD));
        assert!(note.unwrap().contains("1 pod start in the history cost ~36 core-seconds"));
        // no pod starts: the defaults, said to be assumed; not a JIT runtime: nothing
        let (w, note) = warmup_of(Some("jvm"), &vec![Some(2.0); n], &lam, Some(&cpu), Some(&c), 30.0);
        assert_eq!(w.unwrap().source, "assumed");
        assert!(note.unwrap().contains("assumed"));
        assert!(warmup_of(Some("go"), &reps, &lam, Some(&cpu), Some(&c), 30.0).0.is_none());
    }
}

#[cfg(test)]
mod endpoint_match_tests {
    use super::*;

    fn shape(traces: f64, catalog: f64) -> EndpointShape {
        let mut visits = Map::new();
        visits.insert("frontend".to_string(), 1.0);
        visits.insert("product-catalog".to_string(), catalog);
        EndpointShape { service: "frontend".into(), traces, visits, ..Default::default() }
    }

    #[test]
    fn a_series_reads_the_call_path_of_its_most_traced_name() {
        // the framework's route name on 4,829 traces, the series' own template on 42 broken ones
        let (framework, stray) = ("frontend GET /api/products/[productId]".to_string(), "frontend GET /api/products/{id}".to_string());
        let (a, b) = (shape(4829.0, 1.0), shape(42.0, 0.57));
        let shapes = vec![(&framework, &a), (&stray, &b)];
        assert_eq!(traced_endpoint(&shapes, "frontend GET /api/products/{id}"), Some(0));
        // the exact id wins a tie, and nothing stands for an endpoint the traces never saw
        let c = shape(4829.0, 0.9);
        let tied = vec![(&framework, &a), (&stray, &c)];
        assert_eq!(traced_endpoint(&tied, "frontend GET /api/products/{id}"), Some(1));
        assert_eq!(traced_endpoint(&shapes, "frontend GET /api/cart"), None);
    }
}
