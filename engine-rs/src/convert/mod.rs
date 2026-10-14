//! Infrastructure descriptions → architecture specs (src/spec/kubernetes.ts, src/spec/terraform.ts).
//! Specs are built as ordered JSON maps: key order and in-place changes match the TypeScript objects.

pub mod kubernetes;
pub mod terraform;

use serde::Serialize;
use serde_json::{Map as JMap, Value};
use std::sync::OnceLock;

pub type Obj = JMap<String, Value>;

#[derive(Serialize, Clone, Debug)]
pub struct Mapped {
    /// missing when the resource had no address
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
    pub component: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct ImportResult {
    pub spec: Value,
    pub assumptions: Vec<String>,
    pub skipped: Vec<String>,
    pub mapped: Vec<Mapped>,
}

pub(crate) fn empty() -> &'static Obj {
    static E: OnceLock<Obj> = OnceLock::new();
    E.get_or_init(Obj::new)
}

/// the value when it is an object, else {}
pub(crate) fn o(v: Option<&Value>) -> &Obj {
    match v {
        Some(Value::Object(m)) => m,
        _ => empty(),
    }
}

/// the value when it is an array, else []
pub(crate) fn a(v: Option<&Value>) -> &[Value] {
    match v {
        Some(Value::Array(x)) => x,
        _ => &[],
    }
}

/// a string, a number as text, else ''
pub(crate) fn s(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(x)) => x.clone(),
        Some(Value::Number(n)) => crate::math::js_num(n.as_f64().unwrap_or(f64::NAN)),
        _ => String::new(),
    }
}

/// x.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'x'
pub(crate) fn slug(x: &str) -> String {
    let mut out = String::with_capacity(x.len());
    let mut run = false;
    for c in x.chars() {
        if c.is_ascii_alphanumeric() || c == '-' {
            out.push(c);
            run = false;
        } else if !run {
            out.push('-');
            run = true;
        }
    }
    let t = out.strip_prefix('-').unwrap_or(&out);
    let t = t.strip_suffix('-').unwrap_or(t);
    let t = t.to_lowercase();
    if t.is_empty() {
        "x".into()
    } else {
        t
    }
}

/// JSON.stringify: numbers as JavaScript writes them
pub(crate) fn js_stringify(v: &Value) -> String {
    let mut out = String::new();
    write_json(v, &mut out);
    out
}

fn write_json(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            let x = n.as_f64().unwrap_or(f64::NAN);
            if x.is_finite() {
                out.push_str(&crate::math::js_num(x))
            } else {
                out.push_str("null")
            }
        }
        Value::String(x) => out.push_str(&serde_json::to_string(x).unwrap_or_default()),
        Value::Array(xs) => {
            out.push('[');
            for (i, x) in xs.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(x, out);
            }
            out.push(']');
        }
        Value::Object(m) => {
            out.push('{');
            for (i, (k, x)) in m.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).unwrap_or_default());
                out.push(':');
                write_json(x, out);
            }
            out.push('}');
        }
    }
}

/// Number(x)
pub(crate) fn number(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Array(_)) => crate::import::js_number(&array_string(v.unwrap())),
        x => crate::import::js_number_of(x),
    }
}

fn array_string(v: &Value) -> String {
    match v {
        Value::Array(xs) => xs.iter().map(|x| if x.is_null() { String::new() } else { array_string(x) }).collect::<Vec<_>>().join(","),
        Value::String(x) => x.clone(),
        Value::Number(n) => crate::math::js_num(n.as_f64().unwrap_or(f64::NAN)),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".into(),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// a ?? b
pub(crate) fn or<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    match a {
        None | Some(Value::Null) => b,
        x => x,
    }
}

/// Math.max / Math.min as JavaScript computes them (NaN wins)
pub(crate) fn jmax(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}
pub(crate) fn jmin(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

/// a number for a JSON value (NaN and infinities as null, as JSON writes them)
pub(crate) fn n(x: f64) -> Value {
    serde_json::Number::from_f64(x).map(Value::Number).unwrap_or(Value::Null)
}
