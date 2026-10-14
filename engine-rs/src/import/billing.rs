//! Cloud bills → cost per component (src/backtest/import/billing.ts): AWS Cost and Usage Report (legacy
//! and 2.0 column names) and the Google Cloud billing export, attributed by tag or resource id.

use super::{csv_objects, js_number_of, js_parse_float, parse_timestamp, parse_timestamp_str};
use crate::dataset::{Bill, BillComponent};
use crate::types::{Map, Num};
use regex_lite::Regex;
use serde_json::Value;
use std::sync::OnceLock;

#[derive(Clone, Debug, Default, serde::Deserialize)]
pub struct BillMapping {
    pub tag: Option<String>,
    pub resources: Option<Map<String>>,
    #[serde(default)]
    pub rename: Map<String>,
}

#[derive(Clone, Debug)]
pub struct BillLine {
    pub start: f64,
    pub end: f64,
    pub component: Option<String>,
    pub category: &'static str,
    pub cost: f64,
    pub usage: f64,
    pub sku: String,
}

fn re(cell: &'static OnceLock<Regex>, pat: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pat).unwrap())
}

pub fn category_of(usage_type: &str, product_family: &str) -> &'static str {
    static T: OnceLock<Regex> = OnceLock::new();
    static C: OnceLock<Regex> = OnceLock::new();
    static R: OnceLock<Regex> = OnceLock::new();
    static S: OnceLock<Regex> = OnceLock::new();
    let u = format!("{} {}", usage_type, product_family).to_lowercase();
    if re(&T, r"data ?transfer|bytes|egress|ingress|network|inter-?zone|inter-?region|-out-|-in-").is_match(&u) {
        return "transfer";
    }
    if re(&C, r"boxusage|instanceusage|nodeusage|fargate|vcpu|core|ram|memory|instance|spotusage|dedicatedusage|cpu|compute|gb-second|lambda-gb").is_match(&u) {
        return "compute";
    }
    if re(&R, r"request|invocation|api ?call|operation|lcu|query").is_match(&u) {
        return "requests";
    }
    if re(&S, r"storage|volume|snapshot|timedstorage|pd |backup|ebs:").is_match(&u) {
        return "storage";
    }
    "other"
}

fn attribute(tags: &Map<String>, resource_id: &str, map: &BillMapping) -> Option<String> {
    if let Some(tag) = &map.tag {
        let alt = tag.replacen(':', "_", 1);
        let user = format!("user_{}", tag.strip_prefix("user:").unwrap_or(tag));
        let v = tags.get(tag).or(tags.get(&alt)).or(tags.get(&user));
        if let Some(v) = v.filter(|v| !v.is_empty()) {
            return Some(map.rename.get(v).cloned().unwrap_or_else(|| v.clone()));
        }
    }
    if let Some(res) = &map.resources {
        if !resource_id.is_empty() {
            for (k, comp) in res {
                if resource_id.contains(k.as_str()) {
                    return Some(comp.clone());
                }
            }
        }
    }
    None
}

/// AWS CUR (legacy or 2.0) CSV text → lines
pub fn parse_cur(text: &str, map: &BillMapping) -> Vec<BillLine> {
    static SKIP: OnceLock<Regex> = OnceLock::new();
    static USAGE: OnceLock<Regex> = OnceLock::new();
    let mut out = vec![];
    for r in csv_objects(text) {
        let get = |legacy: &str, v2: &str| r.get(legacy).or(r.get(v2)).cloned().unwrap_or_default();
        let ty = get("lineItem/LineItemType", "line_item_line_item_type");
        if re(&SKIP, r"(?i)tax|credit|refund|rifee|savingsplanrecurringfee|fee").is_match(&ty) && !re(&USAGE, r"(?i)usage").is_match(&ty) {
            continue;
        }
        let start = parse_timestamp_str(&get("lineItem/UsageStartDate", "line_item_usage_start_date"));
        let end = parse_timestamp_str(&get("lineItem/UsageEndDate", "line_item_usage_end_date"));
        let cost = js_parse_float(&get("lineItem/UnblendedCost", "line_item_unblended_cost"));
        let start = match start {
            Some(s) if cost.is_finite() => s,
            _ => continue,
        };
        let mut tags: Map<String> = Map::new();
        for (k, v) in &r {
            if let Some(t) = k.strip_prefix("resourceTags/") {
                if !v.is_empty() {
                    tags.insert(t.to_string(), v.clone());
                }
            }
        }
        if let Some(rt) = r.get("resource_tags").filter(|x| !x.is_empty()) {
            if let Ok(Value::Object(o)) = serde_json::from_str::<Value>(rt) {
                for (k, v) in o {
                    tags.insert(k, v.as_str().map(String::from).unwrap_or_else(|| v.to_string()));
                }
            }
        }
        let usage_type = get("lineItem/UsageType", "line_item_usage_type");
        let family = get("product/productFamily", "product_product_family");
        let instance = get("product/instanceType", "product_instance_type");
        let usage = js_parse_float(&get("lineItem/UsageAmount", "line_item_usage_amount"));
        out.push(BillLine {
            start,
            end: end.unwrap_or(start + 3600.0),
            component: attribute(&tags, &get("lineItem/ResourceId", "line_item_resource_id"), map),
            category: category_of(&usage_type, &family),
            cost,
            usage: if usage.is_nan() || usage == 0.0 { 0.0 } else { usage },
            sku: if instance.is_empty() { usage_type } else { instance },
        });
    }
    out
}

fn pick<'a>(r: &'a Value, path: &str) -> Option<&'a Value> {
    if let Some(v) = r.get(path) {
        return Some(v);
    }
    let mut o = Some(r);
    for k in path.split('.') {
        o = match o {
            Some(Value::Object(m)) => m.get(k),
            _ => None,
        };
    }
    o
}

fn js_str(v: Option<&Value>, fallback: &str) -> String {
    match v {
        None | Some(Value::Null) => fallback.to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => crate::math::js_num(n.as_f64().unwrap_or(f64::NAN)),
        Some(x) => x.to_string(),
    }
}

/// Google Cloud billing export (CSV with dotted headers, or BigQuery JSON lines) → lines
pub fn parse_gcp_billing(text: &str, map: &BillMapping) -> Result<Vec<BillLine>, String> {
    let trimmed = text.trim_start();
    let records: Vec<Value> = if trimmed.starts_with('[') {
        serde_json::from_str::<Vec<Value>>(trimmed).map_err(|e| e.to_string())?
    } else if trimmed.starts_with('{') {
        trimmed.split('\n').filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str(l).map_err(|e| e.to_string())).collect::<Result<_, _>>()?
    } else {
        csv_objects(text).into_iter().map(|r| Value::Object(r.into_iter().map(|(k, v)| (k, Value::String(v))).collect())).collect()
    };
    let mut out = vec![];
    for r in &records {
        let start = parse_timestamp(pick(r, "usage_start_time"));
        let end = parse_timestamp(pick(r, "usage_end_time"));
        let cost = js_number_of(pick(r, "cost"));
        let start = match start {
            Some(s) if cost.is_finite() => s,
            _ => continue,
        };
        let mut tags: Map<String> = Map::new();
        let labels = pick(r, "labels");
        let list = match labels {
            Some(Value::String(s)) => serde_json::from_str::<Value>(s).unwrap_or(Value::Array(vec![])),
            Some(v) => v.clone(),
            None => Value::Null,
        };
        if let Value::Array(a) = list {
            for l in a {
                tags.insert(js_str(l.get("key"), "undefined"), js_str(l.get("value"), "undefined"));
            }
        }
        if let Value::Object(o) = r {
            for (k, v) in o {
                if let Some(t) = k.strip_prefix("labels.") {
                    let truthy = !matches!(v, Value::Null | Value::Bool(false)) && !matches!(v, Value::String(s) if s.is_empty()) && !matches!(v, Value::Number(n) if n.as_f64() == Some(0.0));
                    if truthy {
                        tags.insert(t.to_string(), js_str(Some(v), ""));
                    }
                }
            }
        }
        let sku = js_str(pick(r, "sku.description"), "");
        let svc = js_str(pick(r, "service.description"), "");
        let resource = match pick(r, "resource.name") {
            None | Some(Value::Null) => js_str(pick(r, "resource.global_name"), ""),
            v => js_str(v, ""),
        };
        let usage_v = match pick(r, "usage.amount_in_pricing_units") {
            None | Some(Value::Null) => pick(r, "usage.amount"),
            v => v,
        };
        let usage = match usage_v {
            None | Some(Value::Null) => 0.0,
            v => js_number_of(v),
        };
        out.push(BillLine { start, end: end.unwrap_or(start + 3600.0), component: attribute(&tags, &resource, map), category: category_of(&sku, &svc), cost, usage: if usage.is_nan() || usage == 0.0 { 0.0 } else { usage }, sku });
    }
    Ok(out)
}

/// aggregate bill lines; with a grid, each line's cost is spread over the buckets it covers
pub fn summarise_bill(lines: &[BillLine], source: &str, grid: Option<(f64, f64, usize)>, currency: &str) -> Bill {
    let mut comps: Map<BillComponent> = Map::new();
    let (mut unattributed, mut total, mut start, mut end) = (0.0, 0.0, f64::INFINITY, f64::NEG_INFINITY);
    for l in lines {
        total += l.cost;
        start = start.min(l.start);
        end = end.max(l.end);
        let comp = match &l.component {
            Some(c) => c,
            None => {
                unattributed += l.cost;
                continue;
            }
        };
        let c = comps.entry(comp.clone()).or_insert_with(|| BillComponent { series: grid.map(|g| vec![None; g.2]), ..Default::default() });
        c.total += l.cost;
        *c.by_category.entry(l.category.into()).or_insert(0.0) += l.cost;
        *c.usage.entry(l.category.into()).or_insert(0.0) += l.usage;
        if !l.sku.is_empty() && !c.skus.contains(&l.sku) {
            c.skus.push(l.sku.clone());
        }
        if let (Some((gs, step, n)), Some(series)) = (grid, c.series.as_mut()) {
            let dur = (l.end - l.start).max(1.0);
            let mut i = ((l.start - gs) / step).floor().max(0.0) as usize;
            while i < n {
                let bs = gs + i as f64 * step;
                let be = bs + step;
                if bs >= l.end {
                    break;
                }
                let overlap = be.min(l.end) - bs.max(l.start);
                if overlap > 0.0 {
                    let cur: Num = series[i];
                    series[i] = Some(cur.unwrap_or(0.0) + (l.cost * overlap) / dur);
                }
                i += 1;
            }
        }
    }
    Bill { source: source.into(), currency: currency.into(), start: if start.is_finite() { start } else { 0.0 }, end: if end.is_finite() { end } else { 0.0 }, total, components: comps, unattributed }
}
