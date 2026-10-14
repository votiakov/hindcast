//! Traffic from a metrics export (src/spec/trafficCsv.ts): CSV / TSV with a time column and a
//! request-rate column. Times may be seconds, epoch seconds / ms or ISO timestamps; long series are
//! compressed in time to keep a run watchable, and the factor is reported.

use crate::import::js_parse_float;
use crate::math::js_round;

#[derive(Clone, Debug)]
pub struct Keyframe {
    pub at: f64,
    pub rps: f64,
}

pub struct TrafficSeries {
    pub traffic: Vec<Keyframe>,
    /// real seconds per simulated second (1 = real time)
    pub compression: f64,
    pub span_s: f64,
    pub peak: f64,
}

fn parse_time(v: &str) -> Option<f64> {
    let t = v.trim();
    let t = t.strip_prefix('"').unwrap_or(t);
    let t = t.strip_suffix('"').unwrap_or(t);
    if t.is_empty() {
        return None;
    }
    let u = t.strip_prefix('-').unwrap_or(t);
    let numeric = match u.split_once('.') {
        Some((a, b)) => !a.is_empty() && a.bytes().all(|c| c.is_ascii_digit()) && !b.is_empty() && b.bytes().all(|c| c.is_ascii_digit()),
        None => !u.is_empty() && u.bytes().all(|c| c.is_ascii_digit()),
    };
    if numeric {
        let n = js_parse_float(t);
        // epoch ms → s
        return Some(if n > 1e12 { n / 1000.0 } else { n });
    }
    // timestamps without a zone are read as UTC (Date.parse reads a date-time without one as local time)
    crate::import::parse_timestamp_str(t)
}

pub fn parse_traffic_csv(text: &str, max_duration_s: Option<f64>, per_minute: bool) -> Result<TrafficSeries, String> {
    let mut pts: Vec<(f64, f64)> = vec![];
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let r: Vec<&str> = line.split([',', '\t', ';']).map(|c| c.trim()).collect();
        if r.len() < 2 || !r.iter().any(|c| !c.is_empty()) {
            continue;
        }
        let t = parse_time(r[0]);
        let col = if r.len() > 2 { r.iter().enumerate().position(|(i, c)| i > 0 && !js_parse_float(c).is_nan()) } else { Some(1) };
        // findIndex → -1 reads r[-1]: undefined, NaN
        let v = col.map(|i| js_parse_float(r[i])).unwrap_or(f64::NAN);
        match t {
            Some(t) if v.is_finite() => pts.push((t, if per_minute { v / 60.0 } else { v })),
            _ => {} // header or junk
        }
    }
    if pts.len() < 2 {
        return Err("need at least two rows of \"time, requests per second\"".into());
    }
    pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let t0 = pts[0].0;
    let span_s = pts[pts.len() - 1].0 - t0;
    let max = max_duration_s.unwrap_or(300.0);
    let compression = if span_s > max { span_s / max } else { 1.0 };
    // thin to ≤ 400 keyframes
    let step = ((pts.len() as f64 / 400.0).ceil() as usize).max(1);
    let n = pts.len();
    let traffic: Vec<Keyframe> = pts
        .iter()
        .enumerate()
        .filter(|(i, _)| i % step == 0 || *i == n - 1)
        .map(|(_, p)| Keyframe { at: js_round(((p.0 - t0) / compression) * 100.0) / 100.0, rps: (js_round(p.1 * 10.0) / 10.0).max(0.0) })
        .collect();
    let peak = traffic.iter().fold(f64::NEG_INFINITY, |a, k| a.max(k.rps));
    Ok(TrafficSeries { traffic, compression, span_s, peak })
}
