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
    // endpoint named only by its method: where routed series exist, the method-only series are duplicates
    if let Some(topo) = &topology {
        for (id, shape) in &topo.services {
            if shape.server_spans_per_visit.map(|k| k < 2.0).unwrap_or(true) {
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
        let raw: Vec<Vec<Option<f64>>> = keys.iter().map(|k| dataset.endpoints[k].rps.clone().unwrap()).collect();
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

/// /^\S+ [A-Z]+$/: an endpoint named only by its service and a method
fn is_bare(eid: &str) -> bool {
    let mut it = eid.splitn(2, ' ');
    let a = it.next().unwrap_or("");
    let b = it.next().unwrap_or("");
    !a.is_empty() && !a.chars().any(char::is_whitespace) && !b.is_empty() && b.bytes().all(|c| c.is_ascii_uppercase())
}
