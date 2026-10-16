//! Reading and writing the loosely typed JSON the reviews are built on, as the TypeScript they were
//! ported from did: a missing number is NaN, null capacity is Infinity, `${x}` of any value.

use crate::math::js_round;
use serde_json::Value;

pub fn g<'a>(v: &'a Value, path: &[&str]) -> &'a Value {
    let mut x = v;
    for k in path {
        x = x.get(*k).unwrap_or(&Value::Null);
    }
    x
}
/// a number; null (JSON's Infinity) and missing as NaN
pub fn n(v: &Value, path: &[&str]) -> f64 {
    g(v, path).as_f64().unwrap_or(f64::NAN)
}
/// a number where null stands for Infinity (a model's capacity)
pub fn inf(v: &Value, path: &[&str]) -> f64 {
    match g(v, path) {
        Value::Null => f64::INFINITY,
        x => x.as_f64().unwrap_or(f64::NAN),
    }
}
pub fn s(v: &Value, path: &[&str]) -> String {
    match g(v, path) {
        Value::String(x) => x.clone(),
        Value::Null => String::new(),
        x => crate::convert::js_stringify(x),
    }
}
pub fn arr<'a>(v: &'a Value, path: &[&str]) -> Vec<&'a Value> {
    g(v, path).as_array().map(|a| a.iter().collect()).unwrap_or_default()
}
/// a JSON number; NaN and the infinities as null
pub fn num(x: f64) -> Value {
    serde_json::Number::from_f64(x).map(Value::Number).unwrap_or(Value::Null)
}
pub fn to_json<T: serde::Serialize>(x: &T) -> Value {
    serde_json::to_value(x).unwrap_or(Value::Null)
}
/// JavaScript truthiness
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(x) => x.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(false),
        Value::String(x) => !x.is_empty(),
        _ => true,
    }
}
pub fn r1(x: f64) -> f64 {
    js_round(x * 10.0) / 10.0
}
pub fn r2(x: f64) -> f64 {
    js_round(x * 100.0) / 100.0
}

/// `${x}` of a JSON value in a template string
pub fn template_str(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => crate::math::js_num(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::Bool(b)) => b.to_string(),
        Some(x) => crate::convert::js_stringify(x),
    }
}

/// new Date(t * 1000).toISOString()
pub fn iso_full(t: f64) -> String {
    crate::accuracy::iso_of_ms((t * 1000.0).trunc() as i64)
}

/// the ISO time without zero milliseconds (agent/workspace.ts iso)
pub fn iso(t: f64) -> String {
    let s = iso_full(t);
    match s.strip_suffix(".000Z") {
        Some(x) => format!("{}Z", x),
        None => s,
    }
}

/// ISO 8601 of epoch seconds, floored to the millisecond (src/backtest/report.ts)
pub fn iso_floor(t: f64) -> String {
    crate::accuracy::iso_of_ms((t * 1000.0).floor() as i64)
}

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// "Sep 14 at 12:03 UTC"
pub fn when_utc(t: f64) -> String {
    let i = iso_floor(t);
    let month: usize = i[5..7].parse().unwrap_or(1);
    let day: usize = i[8..10].parse().unwrap_or(1);
    format!("{} {} at {} UTC", MONTHS[month - 1], day, &i[11..16])
}
