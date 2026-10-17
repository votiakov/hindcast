//! The import manifest (`hindcast.import.yaml`, src/backtest/import/manifest.ts): which files hold
//! what, and the corrections applied once everything is on the grid.

use super::billing::{parse_cur, parse_gcp_billing, summarise_bill, BillLine, BillMapping};
use super::builder::DatasetBuilder;
use super::metrics::{import_cloudwatch, import_long_csv, import_prometheus, import_wide_csv, SeriesMapping};
use super::traces::{build_topology, parse_trace_chunks, parse_trace_file, parse_trace_lines, Span, TraceImportOptions};
use super::parse_timestamp;
use crate::dataset::{Dataset, Hints, Topology};
use crate::model::Placement;
use crate::types::Map;
use indexmap::IndexSet;
use serde::Serialize;
use serde_json::Value;

pub type ChunkReader = Box<dyn FnMut(&mut Vec<u8>) -> Result<bool, String>>;

/// how the importer reads files: the filesystem natively, the files a user opened in the browser
pub trait FileAccess {
    fn read(&mut self, path: &str) -> Result<String, String>;
    /// expand a glob (or return [path])
    fn glob(&mut self, pattern: &str) -> Result<Vec<String>, String>;
    /// a large file line by line; None: read it whole
    fn lines(&mut self, _path: &str) -> Option<Result<Box<dyn Iterator<Item = String>>, String>> {
        None
    }
    /// a large file as raw blocks of bytes: a reader that fills the buffer with the next block and says
    /// whether there was one. None: lines(), else read() it whole
    fn chunks(&mut self, _path: &str) -> Option<Result<ChunkReader, String>> {
        None
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct ImportLog {
    pub file: String,
    pub what: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub points: Option<f64>,
}

fn duration(v: &Value) -> Result<f64, String> {
    match v {
        Value::Number(n) if n.as_f64().map(|x| x > 0.0).unwrap_or(false) => Ok(n.as_f64().unwrap()),
        Value::String(s) => {
            let k = s.bytes().take_while(|c| c.is_ascii_digit() || *c == b'.').count();
            let (num, unit) = s.split_at(k);
            let f = match unit {
                "ms" => 0.001,
                "s" => 1.0,
                "m" => 60.0,
                "h" => 3600.0,
                "d" => 86400.0,
                _ => return Err(format!("step: \"{}\" is not a duration (like 30s, 1m, 5m, 1h)", s)),
            };
            num.parse::<f64>().map(|n| n * f).map_err(|_| format!("step: \"{}\" is not a duration", s))
        }
        _ => Err("step: expected a positive number of seconds or a duration like 1m".into()),
    }
}

fn mapping(v: &Value, rename: &Map<String>) -> Result<SeriesMapping, String> {
    let mut m: SeriesMapping = serde_json::from_value(v.clone()).map_err(|e| format!("metric mapping: {}", e))?;
    let mut r = rename.clone();
    for (k, x) in m.rename.drain(..) {
        r.insert(k, x);
    }
    m.rename = r;
    Ok(m)
}

fn ts_of(v: Option<&Value>) -> Option<f64> {
    parse_timestamp(v)
}

/// import everything a manifest names → the dataset, and a log of what came from where
pub fn import_bundle(m: &Value, fs: &mut dyn FileAccess) -> Result<(Dataset, Vec<ImportLog>), String> {
    let name = m.get("name").and_then(|x| x.as_str()).ok_or("name: Invalid input: expected string, received undefined")?.to_string();
    let step = match m.get("step") {
        None | Some(Value::Null) => None,
        Some(v) => Some(duration(v)?),
    };
    let rename: Map<String> = m.get("rename").and_then(|r| serde_json::from_value(r.clone()).ok()).unwrap_or_default();
    let mut b = DatasetBuilder::new();
    let mut log: Vec<ImportLog> = vec![];
    let empty = vec![];

    for src in m.get("metrics").and_then(|x| x.as_array()).unwrap_or(&empty) {
        if let Some(p) = src.get("prometheus").and_then(|x| x.as_str()) {
            let map = mapping(src, &rename)?;
            for f in fs.glob(p)? {
                let doc: Value = serde_json::from_str(&fs.read(&f)?).map_err(|e| format!("{}: {}", f, e))?;
                let points = import_prometheus(&mut b, &doc, &map)?;
                log.push(ImportLog { file: f, what: format!("prometheus {}", map.metric), points: Some(points) });
            }
        } else if let Some(p) = src.get("csv").and_then(|x| x.as_str()) {
            let map = mapping(src, &rename)?;
            for f in fs.glob(p)? {
                let points = import_long_csv(&mut b, &fs.read(&f)?, &map);
                log.push(ImportLog { file: f, what: "metrics CSV".into(), points: Some(points) });
            }
        } else if let Some(p) = src.get("wide").and_then(|x| x.as_str()) {
            let mut cols: Map<SeriesMapping> = Map::new();
            for (k, v) in src.get("columns").and_then(|x| x.as_object()).ok_or("wide: needs columns")? {
                cols.insert(k.clone(), mapping(v, &rename)?);
            }
            for f in fs.glob(p)? {
                let points = import_wide_csv(&mut b, &fs.read(&f)?, &cols);
                log.push(ImportLog { file: f, what: "metrics CSV (wide)".into(), points: Some(points) });
            }
        } else if let Some(p) = src.get("cloudwatch").and_then(|x| x.as_str()) {
            let mut map: Map<SeriesMapping> = Map::new();
            if let Some(o) = src.get("map").and_then(|x| x.as_object()) {
                for (k, v) in o {
                    map.insert(k.clone(), mapping(v, &rename)?);
                }
            }
            for f in fs.glob(p)? {
                let doc: Value = serde_json::from_str(&fs.read(&f)?).map_err(|e| format!("{}: {}", f, e))?;
                let points = import_cloudwatch(&mut b, &doc, &map)?;
                log.push(ImportLog { file: f, what: "cloudwatch".into(), points: Some(points) });
            }
        } else {
            return Err("metrics: each source names a prometheus, csv, wide or cloudwatch file".into());
        }
    }

    let step_s = step.unwrap_or(60.0);
    let mut topology: Option<Topology> = None;
    let mut filled: IndexSet<String> = IndexSet::new();
    for src in m.get("traces").and_then(|x| x.as_array()).unwrap_or(&empty) {
        let file = src.get("file").and_then(|x| x.as_str()).ok_or("traces: each source needs a file")?;
        let mut spans: Vec<Span> = vec![];
        let files = fs.glob(file)?;
        for f in &files {
            let jsonl = f.ends_with(".jsonl") || f.ends_with(".ndjson");
            if let Some(chunks) = if jsonl { fs.chunks(f) } else { None } {
                parse_trace_chunks(chunks?, &mut spans)?;
            } else if let Some(lines) = if jsonl { fs.lines(f) } else { None } {
                parse_trace_lines(lines?, &mut spans)?;
            } else {
                parse_trace_file(&fs.read(f)?, &mut spans)?;
            }
        }
        let series = src.get("series");
        let flag = |k: &str, d: bool| series.and_then(|s| s.get(k)).and_then(|x| x.as_bool()).unwrap_or(d);
        let series = (flag("rps", !b.has("rps")), flag("latency", !b.has("p99Ms")), flag("endpoints", true));
        let had: IndexSet<String> = b.services().into_iter().filter(|id| b.has_service(id, "rps")).collect();
        let o = TraceImportOptions {
            step_s,
            sampling: src.get("sampling").and_then(|x| x.as_f64()),
            ignore_services: src.get("ignore").and_then(|x| serde_json::from_value(x.clone()).ok()).unwrap_or_default(),
            rename: rename.clone(),
            series: Some(series),
            // calibration's default where the manifest gives none
            timeout_ms: Some(m.get("model").and_then(|x| x.get("timeoutMs")).and_then(|x| x.as_f64()).filter(|t| *t > 0.0).unwrap_or(5000.0)),
        };
        let t = build_topology(&mut spans, Some(&mut b), &o);
        for id in t.services.keys() {
            if !had.contains(id) && b.has_service(id, "rps") {
                filled.insert(id.clone());
            }
        }
        log.push(ImportLog {
            file: files.join(", "),
            what: format!("traces: {} requests, {} services, {} endpoints", crate::strategy::locale_int(t.traces), t.services.len(), t.endpoints.len()),
            points: Some(spans.len() as f64),
        });
        topology = Some(t);
    }

    let window = m.get("window");
    let ws = window.and_then(|w| w.get("start")).and_then(|v| ts_of(Some(v)));
    let we = window.and_then(|w| w.get("end")).and_then(|v| ts_of(Some(v)));
    b.sources = log.iter().map(|l| format!("{} — {}", l.what, l.file)).collect();
    let mut dataset = b.build(&name, step, ws, we)?;
    if let Some(topo) = topology.as_mut() {
        // span metrics count SERVER spans: where a framework adds its own, every request counts twice
        let mut corrected: Map<f64> = Map::new();
        for (id, shape) in &topo.services {
            let k = match shape.server_spans_per_visit.filter(|k| *k != 0.0) {
                Some(k) => k,
                None => continue,
            };
            if filled.contains(id) || b.edge_services.contains(id) {
                continue;
            }
            if let Some(rps) = dataset.services.get_mut(id).and_then(|s| s.rps.as_mut()) {
                for v in rps.iter_mut() {
                    if let Some(x) = v {
                        *v = Some(*x / k);
                    }
                }
                corrected.insert(id.clone(), crate::math::js_round(k * 100.0) / 100.0);
            }
        }
        if !corrected.is_empty() {
            topo.rate_corrected = Some(corrected);
        }
        // a sampler's real share drifts from its setting: measure it where metrics count the same requests
        let mut ratios: Vec<f64> = vec![];
        for (id, shape) in &topo.services {
            let metric = match dataset.services.get(id).and_then(|s| s.rps.as_ref()) {
                Some(m) if !filled.contains(id) => m,
                _ => continue,
            };
            let counted = metric.iter().fold(0.0, |a, v| a + v.unwrap_or(0.0)) * dataset.step_s;
            if counted >= 10.0 {
                ratios.push(shape.spans / topo.sampling.unwrap_or(1.0) / counted);
            }
        }
        if !ratios.is_empty() {
            crate::backtest::js_sort_by(&mut ratios, |a, b| a - b);
            let k = ratios[ratios.len() / 2];
            topo.sampling_check = Some(k);
            if (k - 1.0).abs() > 0.01 {
                for (id, sv) in dataset.services.iter_mut() {
                    if filled.contains(id) {
                        if let Some(r) = sv.rps.as_mut() {
                            for v in r.iter_mut() {
                                if let Some(x) = v {
                                    *v = Some(*x / k);
                                }
                            }
                        }
                    }
                    if let Some(r) = sv.done_rps.as_mut() {
                        for v in r.iter_mut() {
                            if let Some(x) = v {
                                *v = Some(*x / k);
                            }
                        }
                    }
                }
            }
        }
    }
    // a framework that wraps each request in two SERVER spans makes span metrics show the outer one as an
    // endpoint named only by its method: where routed series exist, the method-only series are duplicates.
    // The wrapping is the framework's, on every request; traces that lost a span (a collector shedding
    // under a load test) only pull the average below 2, so it is read from the majority of visits
    if let Some(topo) = &topology {
        for (id, shape) in &topo.services {
            if shape.server_spans_per_visit.map(|k| k < 1.5).unwrap_or(true) {
                continue;
            }
            let mine: Vec<String> = dataset.endpoints.iter().filter(|(_, e)| e.service == *id).map(|(k, _)| k.clone()).collect();
            let bare: Vec<String> = mine.iter().filter(|eid| is_bare(eid)).cloned().collect();
            if bare.is_empty() || bare.len() == mine.len() {
                continue;
            }
            for eid in &bare {
                dataset.endpoints.shift_remove(eid);
            }
            log.push(ImportLog { file: "(traces)".into(), what: format!("{}: dropped {} — the outer server span of requests already counted under their routes", id, bare.iter().map(|e| format!("\"{}\"", e)).collect::<Vec<_>>().join(", ")), points: None });
        }
    }
    // endpoint rates from span metrics miss requests: where the edge counted the entry service's requests,
    // the endpoints keep their shares and are scaled to the edge's total
    let n = dataset.n as usize;
    for id in b.edge_services.iter() {
        let edge = match dataset.services.get(id).and_then(|s| s.rps.clone()) {
            Some(e) => e,
            None => continue,
        };
        let keys: Vec<String> = dataset.endpoints.iter().filter(|(_, e)| e.service == *id && e.rps.is_some()).map(|(k, _)| k.clone()).collect();
        if keys.is_empty() {
            continue;
        }
        const H: usize = 5;
        let mut raw: Vec<Vec<Option<f64>>> = keys.iter().map(|k| dataset.endpoints[k].rps.clone().unwrap()).collect();
        if let Some(topo) = topology.as_mut() {
            if let Some(m) = trace_mix(id, &keys, &raw, &edge, topo, &dataset, &filled, &b.edge_services) {
                raw = m.raw;
                log.push(ImportLog { file: "(traces)".into(), what: m.said.clone(), points: None });
                let mut all = match topo.mix_from_traces.take() {
                    Some(Value::Object(o)) => o,
                    _ => serde_json::Map::new(),
                };
                all.insert(id.clone(), m.record);
                topo.mix_from_traces = Some(Value::Object(all));
            }
        }
        let totals: Vec<f64> = (0..n).map(|i| raw.iter().fold(0.0, |a, r| a + r.get(i).copied().flatten().unwrap_or(0.0))).collect();
        let (mut seen, mut counted) = (0.0, 0.0);
        for i in 0..n {
            let e = match edge.get(i).copied().flatten() {
                Some(e) if totals[i] > 0.0 => e,
                _ => continue,
            };
            seen += e;
            counted += totals[i];
            let mut all = 0.0;
            let mut part = vec![0.0; raw.len()];
            for j in i.saturating_sub(H)..=(n - 1).min(i + H) {
                all += totals[j];
                for (k, r) in raw.iter().enumerate() {
                    part[k] += r.get(j).copied().flatten().unwrap_or(0.0);
                }
            }
            for (k, key) in keys.iter().enumerate() {
                let rps = dataset.endpoints.get_mut(key).unwrap().rps.as_mut().unwrap();
                rps[i] = if raw[k].get(i).copied().flatten().is_none() && part[k] == 0.0 { None } else { Some((e * part[k]) / all) };
            }
        }
        if seen > 0.0 {
            log.push(ImportLog { file: "(edge)".into(), what: format!("{}: endpoint rates scaled to the edge's count — the endpoint series had counted {}% of the requests the edge saw", id, crate::math::js_num(crate::math::js_round((counted / seen) * 100.0))), points: None });
        }
    }

    let mut lines: Vec<BillLine> = vec![];
    let mut source = "aws-cur";
    for src in m.get("billing").and_then(|x| x.as_array()).unwrap_or(&empty) {
        let mut map: BillMapping = serde_json::from_value(src.clone()).unwrap_or_default();
        let mut r = rename.clone();
        for (k, v) in map.rename.drain(..) {
            r.insert(k, v);
        }
        map.rename = r;
        if let Some(p) = src.get("cur").and_then(|x| x.as_str()) {
            for f in fs.glob(p)? {
                let l = parse_cur(&fs.read(&f)?, &map);
                log.push(ImportLog { file: f, what: format!("AWS CUR: {} lines", l.len()), points: None });
                lines.extend(l);
            }
        } else if let Some(p) = src.get("gcp").and_then(|x| x.as_str()) {
            for f in fs.glob(p)? {
                source = "gcp-billing";
                let l = parse_gcp_billing(&fs.read(&f)?, &map)?;
                log.push(ImportLog { file: f, what: format!("GCP billing: {} lines", l.len()), points: None });
                lines.extend(l);
            }
        }
    }
    if !lines.is_empty() {
        dataset.bill = Some(summarise_bill(&lines, source, Some((dataset.start, dataset.step_s, dataset.n as usize)), "USD"));
    }
    if let Some(p) = m.get("placement").filter(|x| !x.is_null()) {
        dataset.placement = serde_json::from_value::<Map<Placement>>(p.clone()).ok();
    }
    if let Some(h) = m.get("model").filter(|x| !x.is_null()) {
        dataset.hints = serde_json::from_value::<Hints>(h.clone()).ok();
    }
    if let Some(t) = topology {
        dataset.topology = Some(t);
    }
    dataset.sources = log.iter().map(|l| format!("{} — {}", l.what, l.file)).collect();
    Ok((dataset, log))
}

pub(crate) struct TraceMix {
    /// the endpoint series, each now the entry total in the traced share
    pub raw: Vec<Vec<Option<f64>>>,
    pub said: String,
    pub record: Value,
}

/// The entry endpoints' mix as the traces sampled it, where the endpoint series disagree with it and the
/// services behind the entry side with the traces.
///
/// The endpoint series of an entry service can be wrong in ways the edge's total doesn't fix: span
/// metrics of a service with several replicas, exported without a per-replica label, merge each
/// replica's counter into one series that jumps between them, and rate() reads every drop as a counter
/// reset. Each endpoint's rate is then inflated by a different factor, so the mix (each endpoint's share
/// of the edge's requests, which sets how often each path through the system is taken) is wrong even
/// after scaling to the edge. A trace sample drawn independently of the endpoint (a head or
/// probabilistic sampler) has the right mix; one kept by a tail sampler need not. So the traces' mix is
/// used only where (1) it differs from the series' beyond what sampling explains (χ²), and (2) the
/// requests the services behind the entry served, per entry request, agree with the traced mix at
/// least twice as well as with the series' (median |log| error, over services with their own request
/// metrics). Endpoints without traces keep their share.
pub(crate) fn trace_mix(id: &str, keys: &[String], raw: &[Vec<Option<f64>>], edge: &[Option<f64>], topo: &Topology, dataset: &Dataset, filled: &IndexSet<String>, edge_services: &IndexSet<String>) -> Option<TraceMix> {
    let n = dataset.n as usize;
    let sum = |r: &Vec<Option<f64>>| (0..n).fold(0.0, |a, i| a + r.get(i).copied().flatten().unwrap_or(0.0));
    let tot: Vec<f64> = raw.iter().map(sum).collect();
    let all: f64 = tot.iter().sum();
    if all <= 0.0 {
        return None;
    }
    let share: Vec<f64> = tot.iter().map(|t| t / all).collect();
    // each series' traced endpoint, as calibration matches them
    let shapes: Vec<(&String, &crate::dataset::EndpointShape)> = topo.endpoints.iter().filter(|(_, e)| e.service == id).collect();
    let of: Vec<Option<usize>> = keys
        .iter()
        .map(|k| crate::calibrate::traced_endpoint(&shapes, k))
        .collect();
    let mut groups: Vec<usize> = of.iter().flatten().copied().collect();
    groups.sort_unstable();
    groups.dedup();
    let traced: f64 = groups.iter().map(|&g| shapes[g].1.traces).sum();
    if groups.len() < 2 || traced < 100.0 {
        return None;
    }
    let matched: f64 = (0..keys.len()).filter(|&k| of[k].is_some()).map(|k| share[k]).sum();
    if matched <= 0.0 {
        return None;
    }
    let series_of = |g: usize| (0..keys.len()).filter(|&k| of[k] == Some(g)).map(|k| share[k]).sum::<f64>();
    // (1) beyond sampling noise
    let mut chi2 = 0.0;
    for &g in &groups {
        let expected = (traced * series_of(g) / matched).max(0.5);
        chi2 += (shapes[g].1.traces - expected).powi(2) / expected;
    }
    let df = (groups.len() - 1) as f64;
    if chi2 <= df + 5.0 * (2.0 * df).sqrt() {
        return None;
    }
    // the share each series gets under the traced mix
    let mut traced_share = share.clone();
    for &g in &groups {
        let members: Vec<usize> = (0..keys.len()).filter(|&k| of[k] == Some(g)).collect();
        let (gs, gt) = (series_of(g), matched * shapes[g].1.traces / traced);
        for &k in &members {
            traced_share[k] = if gs > 0.0 { gt * share[k] / gs } else { gt / members.len() as f64 };
        }
    }
    // (2) what the services behind the entry served, per entry request
    let visits = |s: &str, sh: &[f64]| (0..keys.len()).filter_map(|k| of[k].map(|g| sh[k] * shapes[g].1.visits.get(s).copied().unwrap_or(0.0))).sum::<f64>();
    let behind: IndexSet<&String> = groups.iter().flat_map(|&g| shapes[g].1.visits.keys()).filter(|s| s.as_str() != id).collect();
    let (mut e_series, mut e_traced) = (vec![], vec![]);
    for s in behind {
        if filled.contains(s.as_str()) || edge_services.contains(s.as_str()) {
            continue;
        }
        let rps = match dataset.services.get(s.as_str()).and_then(|x| x.rps.as_ref()) {
            Some(r) => r,
            None => continue,
        };
        let (mut served, mut entered) = (0.0, 0.0);
        for i in 0..n {
            if let (Some(a), Some(e)) = (rps.get(i).copied().flatten(), edge.get(i).copied().flatten()) {
                served += a;
                entered += e;
            }
        }
        if served * dataset.step_s < 50.0 || entered <= 0.0 {
            continue;
        }
        let measured = served / entered;
        let err = |v: f64| if v > 0.0 { (v / measured).ln().abs() } else { 10.0 };
        e_series.push(err(visits(s, &share)));
        e_traced.push(err(visits(s, &traced_share)));
    }
    if e_series.is_empty() {
        return None;
    }
    let med = |mut v: Vec<f64>| {
        crate::backtest::js_sort_by(&mut v, |a, b| a - b);
        let m = v.len() / 2;
        if v.len() % 2 == 1 { v[m] } else { (v[m - 1] + v[m]) / 2.0 }
    };
    let services = e_series.len();
    let (es, et) = (med(e_series), med(e_traced));
    if !(es > 0.1 && et < es * 0.5) {
        return None;
    }
    let totals: Vec<f64> = (0..n).map(|i| raw.iter().fold(0.0, |a, r| a + r.get(i).copied().flatten().unwrap_or(0.0))).collect();
    let out: Vec<Vec<Option<f64>>> = (0..keys.len())
        .map(|k| {
            if of[k].is_none() || traced_share[k] == 0.0 {
                return raw[k].clone();
            }
            (0..n).map(|i| if totals[i] > 0.0 { Some(totals[i] * traced_share[k]) } else { raw[k].get(i).copied().flatten() }).collect()
        })
        .collect();
    // the endpoint whose share moved most, for the sentence
    let k = (0..keys.len()).max_by(|&a, &b| (traced_share[a] - share[a]).abs().total_cmp(&(traced_share[b] - share[b]).abs())).unwrap_or(0);
    let pct = |x: f64| crate::math::js_num(crate::math::js_round(x * 100.0));
    let gap = |e: f64| pct(e.exp() - 1.0);
    let said = format!(
        "{}: endpoint mix taken from the {} traces — the endpoint series put {}% of the requests on {} where the traces put {}%, and the traced mix matches what the {} services behind it served within {}% (the series' mix: {}%)",
        id,
        crate::strategy::locale_int(traced),
        pct(share[k]),
        keys[k].strip_prefix(&format!("{} ", id)).unwrap_or(&keys[k]),
        pct(traced_share[k]),
        services,
        gap(et),
        gap(es)
    );
    let round = |x: f64| crate::math::js_round(x * 1000.0) / 1000.0;
    let record = serde_json::json!({
        "traces": traced,
        "chi2": crate::math::js_round(chi2 * 10.0) / 10.0,
        "services": services,
        "errorSeries": round(es.exp() - 1.0),
        "errorTraced": round(et.exp() - 1.0),
        "shares": keys.iter().enumerate().filter(|(k, _)| of[*k].is_some()).map(|(k, key)| (key.clone(), serde_json::json!([round(share[k]), round(traced_share[k])]))).collect::<serde_json::Map<String, Value>>(),
    });
    Some(TraceMix { raw: out, said, record })
}

/// /^\S+ [A-Z]+$/: an endpoint named only by its service and a method
fn is_bare(eid: &str) -> bool {
    let mut it = eid.splitn(2, ' ');
    let a = it.next().unwrap_or("");
    let b = it.next().unwrap_or("");
    !a.is_empty() && !a.chars().any(char::is_whitespace) && !b.is_empty() && b.bytes().all(|c| c.is_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    struct Mem(HashMap<String, String>);
    impl FileAccess for Mem {
        fn read(&mut self, path: &str) -> Result<String, String> {
            self.0.get(path).cloned().ok_or_else(|| format!("no file {}", path))
        }
        fn glob(&mut self, pattern: &str) -> Result<Vec<String>, String> {
            Ok(vec![pattern.to_string()])
        }
    }

    const T0: f64 = 1_700_000_000.0;
    const BUCKETS: usize = 10;

    fn matrix(series: &[(&str, &str, Option<&str>, f64)]) -> String {
        let result: Vec<Value> = series
            .iter()
            .map(|(label, svc, span, rps)| {
                let mut m = json!({ *label: svc });
                if let Some(s) = span {
                    m["span_name"] = json!(s);
                }
                json!({ "metric": m, "values": (0..BUCKETS).map(|i| json!([T0 + 60.0 * i as f64, rps.to_string()])).collect::<Vec<_>>() })
            })
            .collect();
        json!({ "status": "success", "data": { "resultType": "matrix", "result": result } }).to_string()
    }

    fn tag(k: &str, v: &str) -> Value {
        json!({ "key": k, "type": "string", "value": v })
    }

    /// `a` requests to GET /a (web → a over gRPC) and `b` to GET /b (web → b over HTTP), interleaved
    /// over the window
    fn traces(a: usize, b: usize) -> String {
        let n = a + b;
        let mut data = vec![];
        for k in 0..n {
            let to_a = k < a;
            let id = format!("{:032x}", k + 1);
            let slot = (k * 7919) % n;
            let start = ((T0 + slot as f64 * 590.0 / n as f64) * 1e6) as i64;
            let (route, callee) = if to_a { ("/a", "a") } else { ("/b", "b") };
            let (client, server, ctags) = if to_a {
                ("grpc.pkg.AService/Get", "pkg.AService/Get", vec![tag("span.kind", "client"), tag("rpc.system", "grpc")])
            } else {
                ("GET", "GET /x", vec![tag("span.kind", "client"), tag("http.method", "GET")])
            };
            let sid = |j: usize| format!("{:016x}", 3 * k + j);
            data.push(json!({
                "traceID": id,
                "spans": [
                    { "traceID": id, "spanID": sid(1), "operationName": format!("GET {}", route), "references": [], "startTime": start, "duration": 10000, "processID": "p1",
                      "tags": [tag("span.kind", "server"), tag("http.method", "GET"), tag("http.route", route)] },
                    { "traceID": id, "spanID": sid(2), "operationName": client, "references": [{ "refType": "CHILD_OF", "traceID": id, "spanID": sid(1) }], "startTime": start + 1000, "duration": 5000, "processID": "p1", "tags": ctags },
                    { "traceID": id, "spanID": sid(3), "operationName": server, "references": [{ "refType": "CHILD_OF", "traceID": id, "spanID": sid(2) }], "startTime": start + 1500, "duration": 4000, "processID": "p2", "tags": [tag("span.kind", "server")] }
                ],
                "processes": { "p1": { "serviceName": "web" }, "p2": { "serviceName": callee } }
            }));
        }
        json!({ "data": data }).to_string()
    }

    /// 10 req/s at the edge, the endpoint series saying `ep` req/s for GET /a and GET /b, services a
    /// and b serving `served`, and a trace sample of `tr` requests to each
    fn import(ep: (f64, f64), served: (f64, f64), tr: (usize, usize)) -> (Dataset, Vec<ImportLog>) {
        let mut files = HashMap::new();
        files.insert("edge.json".to_string(), matrix(&[("exported_service", "web", None, 10.0)]));
        files.insert("ep.json".to_string(), matrix(&[("service_name", "web", Some("GET /a"), ep.0), ("service_name", "web", Some("GET /b"), ep.1)]));
        files.insert("svc.json".to_string(), matrix(&[("service_name", "a", None, served.0), ("service_name", "b", None, served.1)]));
        files.insert("traces.json".to_string(), traces(tr.0, tr.1));
        let m = json!({
            "name": "t",
            "step": "60s",
            "metrics": [
                { "prometheus": "svc.json", "metric": "rps", "by": "service_name" },
                { "prometheus": "ep.json", "metric": "rps", "by": "service_name", "endpointBy": "span_name", "template": true },
                { "prometheus": "edge.json", "metric": "rps", "by": "exported_service", "edge": true }
            ],
            "traces": [{ "file": "traces.json", "series": { "rps": false, "latency": false, "endpoints": false } }]
        });
        import_bundle(&m, &mut Mem(files)).unwrap()
    }

    fn total(d: &Dataset, id: &str) -> f64 {
        d.endpoints.get(id).and_then(|e| e.rps.as_ref()).map(|r| r.iter().flatten().sum::<f64>()).unwrap_or(0.0)
    }

    fn share_a(d: &Dataset) -> f64 {
        let (a, b) = (total(d, "web GET /a"), total(d, "web GET /b"));
        a / (a + b)
    }

    #[test]
    fn an_endpoint_mix_the_services_behind_contradict_is_taken_from_the_traces() {
        // the series count GET /a three times over (replicas' counters merged into one series); the
        // services behind web served half the requests each, as the traces sampled them
        let (d, log) = import((15.0, 5.0), (5.0, 5.0), (100, 100));
        assert!((share_a(&d) - 0.5).abs() < 1e-9, "{}", share_a(&d));
        // still the edge's total
        let all = total(&d, "web GET /a") + total(&d, "web GET /b");
        assert!((all - 10.0 * BUCKETS as f64).abs() < 1e-6, "{}", all);
        assert!(log.iter().any(|l| l.what.starts_with("web: endpoint mix taken from the 200 traces")), "{:?}", log.iter().map(|l| &l.what).collect::<Vec<_>>());
        let rec = d.topology.as_ref().unwrap().mix_from_traces.as_ref().unwrap();
        assert_eq!(rec["web"]["shares"]["web GET /a"], json!([0.75, 0.5]));
    }

    #[test]
    fn the_series_mix_stands_where_the_services_behind_side_with_it() {
        // a tail sampler kept more of GET /b than came; the servers agree with the series
        let (d, log) = import((7.5, 2.5), (7.5, 2.5), (100, 100));
        assert!((share_a(&d) - 0.75).abs() < 1e-9, "{}", share_a(&d));
        assert!(!log.iter().any(|l| l.what.contains("endpoint mix taken")));
        assert!(d.topology.as_ref().unwrap().mix_from_traces.is_none());
    }

    #[test]
    fn a_difference_sampling_explains_leaves_the_series_alone() {
        // 108 against 92 of 200 is within what a 50/50 sample gives
        let (d, _) = import((5.0, 5.0), (5.4, 4.6), (108, 92));
        assert!((share_a(&d) - 0.5).abs() < 1e-9, "{}", share_a(&d));
        assert!(d.topology.as_ref().unwrap().mix_from_traces.is_none());
    }

    /// 100 requests to GET /a on web, the first `wrapped` of them inside an outer server span named only
    /// by its method (a framework's), the rest having lost it; span metrics count both spans
    fn import_wrapped(wrapped: usize) -> (Dataset, Vec<ImportLog>) {
        let mut data = vec![];
        for k in 0..100usize {
            let id = format!("{:032x}", k + 1);
            let start = ((T0 + k as f64 * 5.9) * 1e6) as i64;
            let sid = |j: usize| format!("{:016x}", 2 * k + j);
            let mut spans = vec![json!({ "traceID": id, "spanID": sid(1), "operationName": "GET /a", "references": [], "startTime": start + 100, "duration": 9000, "processID": "p1",
                "tags": [tag("span.kind", "server"), tag("http.method", "GET"), tag("http.route", "/a")] })];
            if k < wrapped {
                spans[0]["references"] = json!([{ "refType": "CHILD_OF", "traceID": id, "spanID": sid(2) }]);
                spans.push(json!({ "traceID": id, "spanID": sid(2), "operationName": "GET", "references": [], "startTime": start, "duration": 10000, "processID": "p1", "tags": [tag("span.kind", "server"), tag("http.method", "GET")] }));
            }
            data.push(json!({ "traceID": id, "spans": spans, "processes": { "p1": { "serviceName": "web" } } }));
        }
        let mut files = HashMap::new();
        files.insert("edge.json".to_string(), matrix(&[("exported_service", "web", None, 10.0)]));
        files.insert("ep.json".to_string(), matrix(&[("service_name", "web", Some("GET /a"), 10.0), ("service_name", "web", Some("GET"), wrapped as f64 / 10.0)]));
        files.insert("traces.json".to_string(), json!({ "data": data }).to_string());
        let m = json!({
            "name": "t",
            "step": "60s",
            "metrics": [
                { "prometheus": "ep.json", "metric": "rps", "by": "service_name", "endpointBy": "span_name", "template": true },
                { "prometheus": "edge.json", "metric": "rps", "by": "exported_service", "edge": true }
            ],
            "traces": [{ "file": "traces.json", "series": { "rps": false, "latency": false, "endpoints": false } }]
        });
        import_bundle(&m, &mut Mem(files)).unwrap()
    }

    #[test]
    fn the_outer_span_of_a_wrapped_request_is_dropped_though_some_traces_lost_it() {
        // 90 of 100 visits carry the framework's outer span (1.9 server spans per visit): "GET" counts
        // the requests GET /a already does
        let (d, log) = import_wrapped(90);
        assert!(!d.endpoints.contains_key("web GET"), "{:?}", d.endpoints.keys().collect::<Vec<_>>());
        assert!((total(&d, "web GET /a") - 10.0 * BUCKETS as f64).abs() < 1e-6, "{}", total(&d, "web GET /a"));
        assert!(log.iter().any(|l| l.what.starts_with("web: dropped \"web GET\"")), "{:?}", log.iter().map(|l| &l.what).collect::<Vec<_>>());
        // a server span on a fifth of the visits is not a framework's on every request: kept
        let (d, _) = import_wrapped(20);
        assert!(d.endpoints.contains_key("web GET"));
    }

    #[test]
    fn calls_the_spans_say_were_grpc_are_marked() {
        let (d, _) = import((5.0, 5.0), (5.0, 5.0), (10, 10));
        let edges = d.topology.as_ref().unwrap().edges.as_array().unwrap().clone();
        let edge = |to: &str| edges.iter().find(|e| e["from"] == "web" && e["to"] == to).cloned().unwrap();
        assert_eq!(edge("a")["grpc"], json!(true));
        assert!(edge("b").get("grpc").is_none());
    }
}
