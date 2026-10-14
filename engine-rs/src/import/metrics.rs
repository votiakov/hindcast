//! Metric exports → dataset points (src/backtest/import/metrics.ts): Prometheus query_range JSON, long
//! and wide CSV, CloudWatch GetMetricData. A mapping says what each series is and how to convert units.

use super::builder::{DatasetBuilder, CLUSTER_METRICS};
use super::traces::template_path;
use super::{csv_objects, js_parse_float, parse_csv, parse_timestamp, parse_timestamp_str};
use crate::types::Map;
use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SeriesMapping {
    #[serde(default)]
    pub metric: String,
    pub service: Option<String>,
    pub endpoint: Option<String>,
    pub by: Option<String>,
    pub endpoint_by: Option<String>,
    pub method_by: Option<String>,
    pub unit: Option<String>,
    pub scale: Option<f64>,
    #[serde(default)]
    pub rename: Map<String>,
    pub template: Option<bool>,
    pub edge: Option<bool>,
    pub combine: Option<String>,
}

const ENDPOINT_METRICS: [&str; 5] = ["rps", "errorRate", "p50Ms", "p99Ms", "meanMs"];

/// a raw value in the dataset's units (ms for latency, cores for CPU, req/s for rates)
pub fn convert(metric: &str, v: f64, unit: Option<&str>, period_s: f64, scale: f64) -> (String, f64) {
    let m = if metric == "cpuPercent" { "cpuCores" } else { metric };
    let mut x = v;
    if m.ends_with("Ms") {
        x = match unit {
            Some("s") => v * 1000.0,
            Some("us") => v / 1000.0,
            _ => v,
        };
    } else if metric == "cpuPercent" || unit == Some("percent") {
        x = v / 100.0;
    } else if unit == Some("millicores") {
        x = v / 1000.0;
    } else if unit == Some("rpm") {
        x = v / 60.0;
    } else if unit == Some("count-per-period") {
        x = v / period_s.max(1.0);
    }
    // percentages without a unit
    if m == "errorRate" && unit.is_none() && x > 1.0 {
        x /= 100.0;
    }
    (m.to_string(), x * scale)
}

fn emit(b: &mut DatasetBuilder, map: &SeriesMapping, labels: &IndexMap<String, String>, t: f64, raw: f64, period: f64) {
    // cluster-wide series (nodes, everything requested on them) belong to no service
    if CLUSTER_METRICS.contains(&map.metric.as_str()) {
        return b.add_cluster(&map.metric, t, raw * map.scale.unwrap_or(1.0));
    }
    let by = map.by.clone().unwrap_or_else(|| "service".into());
    let raw_svc = map.service.clone().or_else(|| labels.get(&by).cloned()).or_else(|| labels.get("service_name").cloned()).or_else(|| labels.get("application").cloned()).or_else(|| labels.get("job").cloned()).or_else(|| labels.get("container").cloned()).or_else(|| labels.get("app").cloned());
    let raw_svc = match raw_svc {
        Some(s) if !s.is_empty() => s,
        _ => return,
    };
    let service = map.rename.get(&raw_svc).cloned().unwrap_or(raw_svc);
    let (metric, v) = convert(&map.metric, raw, map.unit.as_deref(), period, map.scale.unwrap_or(1.0));
    let ep_label = map.endpoint_by.as_ref().and_then(|k| labels.get(k)).filter(|x| !x.is_empty());
    let named = map.endpoint.clone().or_else(|| {
        ep_label.map(|e| {
            let m = map.method_by.as_ref().and_then(|k| labels.get(k)).filter(|x| !x.is_empty());
            format!("{}{}", m.map(|m| format!("{} ", m)).unwrap_or_default(), e)
        })
    });
    let endpoint = match (&named, map.template == Some(true)) {
        (Some(n), true) => Some(format!("{} {}", service, template_path(n))),
        (n, _) => n.clone(),
    };
    if let Some(e) = endpoint {
        if !e.is_empty() {
            if ENDPOINT_METRICS.contains(&metric.as_str()) {
                b.add_endpoint(&e, &service, &metric, t, v);
            }
            return;
        }
    }
    b.add_service(&service, &metric, t, v, map.edge == Some(true));
}

fn labels_of(v: Option<&Value>) -> IndexMap<String, String> {
    v.and_then(|x| x.as_object()).map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_str().map(String::from).unwrap_or_else(|| v.to_string()))).collect()).unwrap_or_default()
}

fn ts_of(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => super::js_number(s),
        _ => f64::NAN,
    }
}

fn values_of(s: &Value) -> Vec<(f64, f64)> {
    let pair = |p: &Value| -> Option<(f64, f64)> {
        let a = p.as_array()?;
        let raw = match a.get(1)? {
            Value::String(s) => js_parse_float(s),
            Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
            _ => f64::NAN,
        };
        Some((ts_of(a.first()?), raw))
    };
    match s.get("values").and_then(|v| v.as_array()) {
        Some(vs) => vs.iter().filter_map(pair).collect(),
        None => s.get("value").and_then(pair).into_iter().collect(),
    }
}

/// Prometheus query_range (or instant query) JSON
pub fn import_prometheus(b: &mut DatasetBuilder, json: &Value, map: &SeriesMapping) -> Result<f64, String> {
    let result = if json.is_array() { json.as_array() } else { json.get("data").and_then(|d| d.get("result")).or_else(|| json.get("result")).and_then(|r| r.as_array()) };
    let result = result.ok_or("not a Prometheus query response (expected data.result)")?;
    if map.template == Some(true) && map.endpoint_by.is_some() {
        return Ok(import_templated(b, result, map));
    }
    let mut points = 0.0;
    for s in result {
        let vals = values_of(s);
        let period = if vals.len() > 1 { vals[1].0 - vals[0].0 } else { 60.0 };
        let labels = labels_of(s.get("metric"));
        for (t, v) in vals {
            if !v.is_finite() {
                continue; // NaN from histogram_quantile on empty buckets
            }
            emit(b, map, &labels, t, v, period);
            points += 1.0;
        }
    }
    Ok(points)
}

/// histogram_quantile over cumulative bucket rates keyed by their `le` ("+Inf" included)
pub fn bucket_quantile(q: f64, buckets: &IndexMap<String, f64>, min_count: f64) -> Option<f64> {
    let mut bs: Vec<(f64, f64)> = buckets.iter().map(|(le, c)| (if le == "+Inf" { f64::INFINITY } else { super::js_number(le) }, *c)).filter(|x| !x.0.is_nan()).collect();
    if bs.is_empty() {
        return None;
    }
    crate::backtest::js_sort_by(&mut bs, |a, b| a.0 - b.0);
    for i in 1..bs.len() {
        bs[i].1 = bs[i].1.max(bs[i - 1].1);
    }
    let total = bs[bs.len() - 1].1;
    if !(total > 0.0) || total < min_count {
        return None;
    }
    let rank = q * total;
    let (mut prev_le, mut prev_c) = (0.0, 0.0);
    for (le, c) in bs {
        if c >= rank {
            // past the largest finite bound: the answer is that bound, as Prometheus gives it
            if le == f64::INFINITY {
                return Some(prev_le);
            }
            return Some(prev_le + ((le - prev_le) * (rank - prev_c)) / (c - prev_c).max(1e-12));
        }
        prev_le = le;
        prev_c = c;
    }
    Some(prev_le)
}

struct Group {
    labels: IndexMap<String, String>,
    by_t: IndexMap<u64, Vec<f64>>,
    parts: IndexMap<u64, IndexMap<String, f64>>,
    period: f64,
}

/// endpoint series whose names template to the same endpoint, merged before they reach the dataset
fn import_templated(b: &mut DatasetBuilder, result: &[Value], map: &SeriesMapping) -> f64 {
    let ep_by = map.endpoint_by.clone().unwrap();
    let mut groups: IndexMap<String, Group> = IndexMap::new();
    for s in result {
        let labels = labels_of(s.get("metric"));
        let raw = match labels.get(&ep_by).filter(|x| !x.is_empty()) {
            Some(r) => r.clone(),
            None => continue,
        };
        let by = map.by.clone().unwrap_or_else(|| "service".into());
        let raw_svc = map.service.clone().or_else(|| labels.get(&by).cloned()).or_else(|| labels.get("service_name").cloned()).or_else(|| labels.get("application").cloned()).or_else(|| labels.get("job").cloned()).unwrap_or_default();
        let m = map.method_by.as_ref().and_then(|k| labels.get(k)).filter(|x| !x.is_empty());
        let name = format!("{}{}", m.map(|m| format!("{} ", m)).unwrap_or_default(), raw);
        let key = format!("{}\u{0}{}", raw_svc, template_path(&name));
        let vals = values_of(s);
        let g = groups.entry(key).or_insert_with(|| {
            let mut l = labels.clone();
            l.insert(ep_by.clone(), template_path(&name));
            Group { labels: l, by_t: IndexMap::new(), parts: IndexMap::new(), period: if vals.len() > 1 { vals[1].0 - vals[0].0 } else { 60.0 } }
        });
        // the part this series carries: a ratio's numerator or denominator, or a histogram bucket
        let part = match map.combine.as_deref() {
            Some("ratio") => labels.get("part").cloned(),
            Some("histogram") => labels.get("le").cloned(),
            _ => None,
        };
        for (t, v) in vals {
            if !v.is_finite() {
                continue;
            }
            match &part {
                Some(p) if map.combine.is_some() => {
                    *g.parts.entry(t.to_bits()).or_default().entry(p.clone()).or_insert(0.0) += v;
                }
                _ => g.by_t.entry(t.to_bits()).or_default().push(v),
            }
        }
    }
    let m = SeriesMapping { method_by: None, ..map.clone() };
    let mut points = 0.0;
    if let Some(combine) = &map.combine {
        for g in groups.values() {
            for (t, parts) in &g.parts {
                let t = f64::from_bits(*t);
                if combine == "ratio" {
                    let den = parts.get("den").copied().unwrap_or(0.0);
                    if den <= 0.0 {
                        continue;
                    }
                    emit(b, &m, &g.labels, t, parts.get("num").copied().unwrap_or(0.0) / den, g.period);
                    points += 1.0;
                } else {
                    for (q, metric) in [(0.5, "p50Ms"), (0.99, "p99Ms")] {
                        // bucket rates are per second: a p99 wants ~100 requests behind it, a median ~20
                        let v = match bucket_quantile(q, parts, (if q > 0.9 { 100.0 } else { 20.0 }) / g.period) {
                            Some(v) => v,
                            None => continue,
                        };
                        emit(b, &SeriesMapping { metric: metric.into(), ..m.clone() }, &g.labels, t, v, g.period);
                        points += 1.0;
                    }
                }
            }
        }
        return points;
    }
    let combine = |xs: &[f64]| -> f64 {
        match map.metric.as_str() {
            "rps" | "doneRps" => xs.iter().fold(0.0, |a, x| a + x),
            "p99Ms" | "p95Ms" => crate::backtest::js_max(f64::NEG_INFINITY, xs.iter().copied()),
            _ => xs.iter().fold(0.0, |a, x| a + x) / xs.len() as f64,
        }
    };
    for g in groups.values() {
        for (t, xs) in &g.by_t {
            emit(b, &m, &g.labels, f64::from_bits(*t), combine(xs), g.period);
            points += 1.0;
        }
    }
    points
}

/// long CSV: timestamp, service, metric, value [, endpoint]
pub fn import_long_csv(b: &mut DatasetBuilder, text: &str, defaults: &SeriesMapping) -> f64 {
    let mut points = 0.0;
    for r in csv_objects(text) {
        let ts = r.get("timestamp").or(r.get("time")).or(r.get("ts")).cloned();
        let t = ts.and_then(|s| parse_timestamp_str(&s));
        let v = js_parse_float(r.get("value").map(|s| s.as_str()).unwrap_or(""));
        let t = match t {
            Some(t) if v.is_finite() => t,
            _ => continue,
        };
        let metric = r.get("metric").cloned().unwrap_or_else(|| defaults.metric.clone());
        let nonempty = |k: &str| r.get(k).filter(|x| !x.is_empty()).cloned();
        let m = SeriesMapping { metric, unit: nonempty("unit").or(defaults.unit.clone()), service: nonempty("service").or(defaults.service.clone()), endpoint: nonempty("endpoint"), ..defaults.clone() };
        emit(b, &m, &IndexMap::new(), t, v, 60.0);
        points += 1.0;
    }
    points
}

/// wide CSV: first column time, one column per series; `columns` maps a header to its meaning
pub fn import_wide_csv(b: &mut DatasetBuilder, text: &str, columns: &Map<SeriesMapping>) -> f64 {
    let rows = parse_csv(text, None);
    if rows.len() < 2 {
        return 0.0;
    }
    let head: Vec<String> = rows[0].iter().map(|h| h.trim().to_string()).collect();
    let times: Vec<Option<f64>> = rows[1..].iter().map(|r| r.first().and_then(|x| parse_timestamp_str(x))).collect();
    let mut ts: Vec<f64> = times.iter().flatten().copied().collect();
    ts.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let period = if ts.len() > 1 { ts[1] - ts[0] } else { 60.0 };
    let mut points = 0.0;
    for (j, h) in head.iter().enumerate() {
        if j == 0 {
            continue;
        }
        let map = columns.get(h).or_else(|| columns.iter().find(|(k, _)| k.ends_with('*') && h.starts_with(&k[..k.len() - 1])).map(|(_, v)| v));
        let map = match map {
            Some(m) => m,
            None => continue,
        };
        for (i, r) in rows[1..].iter().enumerate() {
            let v = js_parse_float(r.get(j).map(|s| s.as_str()).unwrap_or(""));
            if let (Some(t), true) = (times[i], v.is_finite()) {
                emit(b, map, &IndexMap::new(), t, v, period);
                points += 1.0;
            }
        }
    }
    points
}

/// CloudWatch GetMetricData output; an Id of the form `<service>__<metric>` is understood without a mapping
pub fn import_cloudwatch(b: &mut DatasetBuilder, json: &Value, map: &Map<SeriesMapping>) -> Result<f64, String> {
    let res: Vec<&Value> = if let Some(r) = json.get("MetricDataResults").and_then(|x| x.as_array()) {
        r.iter().collect()
    } else if let Some(a) = json.as_array() {
        a.iter().flat_map(|p| p.get("MetricDataResults").and_then(|x| x.as_array()).into_iter().flatten()).collect()
    } else {
        return Err("not a CloudWatch GetMetricData response (expected MetricDataResults)".into());
    };
    let mut points = 0.0;
    for r in res {
        let id = r.get("Id").and_then(|x| x.as_str()).unwrap_or("");
        let label = r.get("Label").and_then(|x| x.as_str());
        let m = match map.get(id).or_else(|| label.and_then(|l| map.get(l))) {
            Some(m) => m.clone(),
            None => {
                let parts: Vec<&str> = id.split("__").collect();
                if parts.len() == 2 {
                    SeriesMapping { service: Some(parts[0].into()), metric: parts[1].into(), ..Default::default() }
                } else {
                    continue;
                }
            }
        };
        let empty = vec![];
        let times: Vec<Option<f64>> = r.get("Timestamps").and_then(|x| x.as_array()).unwrap_or(&empty).iter().map(|t| parse_timestamp(Some(t))).collect();
        let mut sorted: Vec<f64> = times.iter().flatten().copied().collect();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let period = if sorted.len() > 1 { sorted[1] - sorted[0] } else { 60.0 };
        for (i, v) in r.get("Values").and_then(|x| x.as_array()).unwrap_or(&empty).iter().enumerate() {
            let v = v.as_f64().unwrap_or(f64::NAN);
            if let (Some(Some(t)), true) = (times.get(i), v.is_finite()) {
                emit(b, &m, &IndexMap::new(), *t, v, period);
                points += 1.0;
            }
        }
    }
    Ok(points)
}
