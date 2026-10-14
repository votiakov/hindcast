//! Queueing and latency-distribution maths of src/backtest/queueing.ts and engine.ts, and number
//! formatting the way JavaScript prints it (the replay's events are text).

#[allow(unused_imports)]
use crate::fmath::JsMath;
/// Erlang C: probability an arrival has to wait (`a` Erlangs offered to `c` servers)
pub fn erlang_c(c: f64, a: f64) -> f64 {
    if a <= 0.0 {
        return 0.0;
    }
    if a >= c {
        return 1.0;
    }
    let mut b = 1.0;
    let mut k = 1.0;
    while k <= c {
        b = (a * b) / (k + a * b);
        k += 1.0;
    }
    let rho = a / c;
    b / (1.0 - rho + rho * b)
}

pub struct Wait {
    pub mean_ms: f64,
    pub p99_ms: f64,
    pub rho: f64,
}

/// steady-state M/M/c wait for `lambda` < `k` req/s of capacity over `c` servers
pub fn mmc_wait(lambda: f64, c: f64, k: f64) -> Wait {
    if !k.is_finite() {
        return Wait { mean_ms: 0.0, p99_ms: 0.0, rho: 0.0 };
    }
    let rho = lambda / k;
    if rho >= 1.0 {
        return Wait { mean_ms: f64::INFINITY, p99_ms: f64::INFINITY, rho };
    }
    let n = js_round(c).max(1.0);
    let mu = k / n;
    let cc = erlang_c(n, lambda / mu);
    let gap = k - lambda;
    let mean_ms = (cc / gap) * 1000.0;
    let p99_ms = if cc > 0.01 { ((cc / 0.01).js_ln() / gap) * 1000.0 } else { 0.0 };
    Wait { mean_ms, p99_ms, rho }
}

/// P(latency > t) for a latency summarised by (mean, p99) with an exponential tail
pub fn exceed(mean: f64, p99: f64, t: f64) -> f64 {
    if !mean.is_finite() {
        return 1.0;
    }
    let ex = (p99 - mean).max(1e-6);
    if t >= mean {
        return 0.01_f64.js_pow((t - mean) / ex).min(1.0);
    }
    (1.0 - 0.5 * (-(mean - t) / ex).js_exp()).min(1.0)
}

/// standard normal upper tail (Abramowitz–Stegun 7.1.26 via erfc)
pub fn normal_tail(z: f64) -> f64 {
    let t = 1.0 / (1.0 + 0.3275911 * (z / std::f64::consts::SQRT_2).abs());
    let y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * (-(z * z) / 2.0).js_exp();
    if z >= 0.0 {
        y / 2.0
    } else {
        1.0 - y / 2.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Part {
    pub w: f64,
    pub mean: f64,
    pub p99: f64,
    pub p50: Option<f64>,
    pub p90: Option<f64>,
}

fn truthy(x: Option<f64>) -> Option<f64> {
    match x {
        Some(v) if v != 0.0 && !v.is_nan() => Some(v),
        _ => None,
    }
}

/// P(latency > x) for one endpoint: through (p50, p90, p99) when known, lognormal through
/// (p50, p99), else an exponential tail through (mean, p99)
pub fn survival(p: &Part, x: f64) -> f64 {
    if let (Some(p50), Some(p90)) = (truthy(p.p50), truthy(p.p90)) {
        if p50 > 0.0 && p90 > p50 * 1.01 && p.p99 > p90 * 1.01 && x > 0.0 {
            if x <= p90 {
                let sigma = (p90.js_ln() - p50.js_ln()) / 1.2816;
                return normal_tail((x.js_ln() - p50.js_ln()) / sigma);
            }
            let slope = (0.01_f64.js_ln() - 0.1_f64.js_ln()) / (p.p99.js_ln() - p90.js_ln());
            return (0.1_f64.js_ln() + slope * (x.js_ln() - p90.js_ln())).js_exp().min(0.1);
        }
    }
    if let Some(p50) = truthy(p.p50) {
        if p50 > 0.0 && p.p99 > p50 * 1.01 && x > 0.0 {
            let sigma = (p.p99.js_ln() - p50.js_ln()) / 2.3263;
            return normal_tail((x.js_ln() - p50.js_ln()) / sigma);
        }
    }
    exceed(p.mean, p.p99, x)
}

/// p-quantile (`tail` = 1 − p) of a traffic-weighted mixture of endpoint latencies
pub fn mixture_quantile(input: &[Part], tail: f64) -> f64 {
    let mut parts: Vec<Part> = Vec::with_capacity(input.len());
    for p in input {
        if let Some(same) = parts.iter_mut().find(|q| q.mean == p.mean && q.p99 == p.p99 && q.p50 == p.p50 && q.p90 == p.p90) {
            same.w += p.w;
        } else {
            parts.push(*p);
        }
    }
    let mut tot = 0.0;
    for p in &parts {
        tot += p.w;
    }
    if !(tot > 0.0) {
        return 0.0;
    }
    let f = |x: f64| {
        let mut s = 0.0;
        for p in &parts {
            s += (p.w / tot) * survival(p, x);
        }
        s - tail
    };
    let mut lo = 0.0;
    let mut hi: f64 = 1.0;
    for p in &parts {
        hi = hi.max(if p.p99.is_finite() { p.p99 } else { 1e7 });
    }
    hi *= 2.0;
    if f(hi) > 0.0 {
        return hi;
    }
    let mut i = 0;
    while i < 50 && hi - lo > 0.01 {
        let mid = (lo + hi) / 2.0;
        if f(mid) > 0.0 {
            lo = mid;
        } else {
            hi = mid;
        }
        i += 1;
    }
    (lo + hi) / 2.0
}

/// JavaScript's Math.round: halves go up (toward +∞)
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

/// a number as JavaScript prints it in a template string
pub fn js_num(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if x == 0.0 {
        return "0".into();
    }
    let a = x.abs();
    let (digits, e) = shortest_digits(a);
    let neg = if x < 0.0 { "-" } else { "" };
    let k = digits.len() as i32;
    if a >= 1e21 || a < 1e-6 {
        // exponent form, as JS writes 1e+21 / 1.5e-7
        let m = if k == 1 { digits.clone() } else { format!("{}.{}", &digits[..1], &digits[1..]) };
        let ex = e + k - 1;
        return format!("{}{}e{}{}", neg, m, if ex >= 0 { "+" } else { "-" }, ex.abs());
    }
    // value = 0.digits × 10^(e + k)
    let point = e + k;
    let body = if point <= 0 {
        format!("0.{}{}", "0".repeat((-point) as usize), digits)
    } else if point >= k {
        format!("{}{}", digits, "0".repeat((point - k) as usize))
    } else {
        format!("{}.{}", &digits[..point as usize], &digits[point as usize..])
    };
    format!("{}{}", neg, body)
}

/// the shortest digits that read back as x (x > 0), with x ≈ digits × 10^e. Where two candidates are
/// equally short and equally close, JavaScript takes the even one (Number::toString); Rust's
/// formatter rounds the tie up
fn shortest_digits(x: f64) -> (String, i32) {
    let s = format!("{:e}", x);
    let (m, ex) = s.split_once('e').unwrap();
    let ex: i32 = ex.parse().unwrap();
    let mut digits: String = m.chars().filter(|c| *c != '.').collect();
    let e = ex - (digits.len() as i32 - 1);
    let last = digits.as_bytes()[digits.len() - 1] - b'0';
    if last % 2 == 1 {
        let n = digits.len();
        let below = format!("{}{}", &digits[..n - 1], last - 1);
        // both read back as x: then x lies exactly halfway only if its exact expansion says so
        if format!("{}e{}", below, e).parse::<f64>().map(|c| c == x).unwrap_or(false) {
            let exact = format!("{:.800e}", x);
            let (em, _) = exact.split_once('e').unwrap();
            let ed: String = em.chars().filter(|c| *c != '.').collect();
            let tail = &ed[n..];
            if ed[..n] == below[..] && tail.starts_with('5') && tail[1..].bytes().all(|c| c == b'0') {
                digits = below;
            }
        }
    }
    (digits, e)
}

/// JavaScript's Number.prototype.toFixed (exact decimal value, ties to the larger magnitude)
pub fn js_to_fixed(x: f64, digits: usize) -> String {
    if !x.is_finite() {
        return js_num(x);
    }
    if x.abs() >= 1e21 {
        return js_num(x);
    }
    let neg = x < 0.0;
    // Rust prints the exact binary value to any precision: 40 more digits decide the rounding
    let exact = format!("{:.*}", digits + 40, x.abs());
    let (int_part, frac) = exact.split_once('.').unwrap();
    let keep = &frac[..digits];
    let rest = &frac[digits..];
    let round_up = rest.as_bytes()[0] >= b'5';
    let mut digits_vec: Vec<u8> = int_part.bytes().chain(keep.bytes()).collect();
    if round_up {
        let mut i = digits_vec.len();
        loop {
            if i == 0 {
                digits_vec.insert(0, b'1');
                break;
            }
            i -= 1;
            if digits_vec[i] == b'9' {
                digits_vec[i] = b'0';
            } else {
                digits_vec[i] += 1;
                break;
            }
        }
    }
    let s = String::from_utf8(digits_vec).unwrap();
    let split = s.len() - digits;
    let body = if digits > 0 { format!("{}.{}", &s[..split], &s[split..]) } else { s };
    // the sign stays even when the digits round to zero: (-0.04).toFixed(1) is "-0.0"
    if neg {
        format!("-{}", body)
    } else {
        body
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_like_javascript() {
        assert_eq!(js_to_fixed(2.5, 0), "3");
        assert_eq!(js_to_fixed(1.005, 2), "1.00"); // 1.005 is 1.00499… in binary
        assert_eq!(js_to_fixed(12.34, 1), "12.3");
        assert_eq!(js_to_fixed(-0.04, 1), "-0.0");
        assert_eq!(js_to_fixed(99.96, 1), "100.0");
        assert_eq!(js_num(3.0), "3");
        assert_eq!(js_num(2.5), "2.5");
        assert_eq!(js_num(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(js_num(f64::INFINITY), "Infinity");
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(2.5), 3.0);
    }

    #[test]
    fn mm1_matches_erlang_c() {
        // M/M/1: P(wait) = rho
        assert!((erlang_c(1.0, 0.7) - 0.7).abs() < 1e-12);
        let w = mmc_wait(70.0, 1.0, 100.0);
        assert!((w.mean_ms - 0.7 / 30.0 * 1000.0).abs() < 1e-9);
    }
}

/// Number.prototype.toLocaleString('en-US'): grouped thousands, at most three fraction digits
/// (rounded half away from zero), trailing zeros dropped
pub fn js_locale(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x < 0.0 { "-∞" } else { "∞" }.into();
    }
    let fixed = if x.abs() >= 1e21 { format!("{:.3}", x) } else { js_to_fixed(x, 3) };
    let (neg, body) = match fixed.strip_prefix('-') {
        Some(b) => (true, b.to_string()),
        None => (false, fixed),
    };
    let (int, frac) = match body.split_once('.') {
        Some((i, f)) => (i.to_string(), f.trim_end_matches('0').to_string()),
        None => (body, String::new()),
    };
    let mut out = String::new();
    let n = int.len();
    for (i, ch) in int.chars().enumerate() {
        if i > 0 && (n - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    if !frac.is_empty() {
        out.push('.');
        out += &frac;
    }
    // -0 and values that round to zero keep their sign, as Intl does
    if neg || (x == 0.0 && x.is_sign_negative()) {
        format!("-{}", out)
    } else {
        out
    }
}

#[cfg(test)]
mod js_num_tests {
    #[test]
    fn like_javascript() {
        for (x, s) in [(0.20331192016601562, "0.20331192016601562"), (0.1, "0.1"), (1e21, "1e+21"), (1.5e-7, "1.5e-7"), (123456789012.0, "123456789012"), (-2.5, "-2.5"), (1e-6, "0.000001"), (5e-324, "5e-324"), (1.7976931348623157e308, "1.7976931348623157e+308"), (0.30000000000000004, "0.30000000000000004"), (86.69231982197918, "86.69231982197918"), (100.0, "100"), (1e20, "100000000000000000000")] {
            assert_eq!(super::js_num(x), s);
        }
    }
}

#[cfg(test)]
mod js_num_fuzz {
    /// JSNUM=<file of "bits String(x)" from node>: every value printed identically
    #[test]
    fn matches_node() {
        let Ok(p) = std::env::var("JSNUM") else { return };
        let text = std::fs::read_to_string(p).unwrap();
        let mut bad = vec![];
        for l in text.lines() {
            let (b, want) = l.split_once(' ').unwrap();
            let x = f64::from_bits(b.parse().unwrap());
            let got = super::js_num(x);
            if got != want {
                bad.push(format!("{} → {} (js {})", b, got, want));
            }
        }
        assert!(bad.is_empty(), "{} differ, e.g. {:?}", bad.len(), &bad[..bad.len().min(5)]);
    }
}
