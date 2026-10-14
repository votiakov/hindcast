//! What the commands share: flags, files, the console, and JavaScript's number and JSON formatting.

use crate::math::{js_locale, js_num, js_to_fixed};
use indexmap::IndexMap;
use serde_json::Value;
use std::io::Write;

/// stdout and stderr, written in order
#[derive(Default)]
pub struct Out {
    pub stdout: Vec<u8>,
}

impl Out {
    /// console.log
    pub fn log(&mut self, s: &str) {
        self.stdout.extend_from_slice(s.as_bytes());
        self.stdout.push(b'\n');
    }
    /// console.error (stdout written so far goes first)
    pub fn err(&mut self, s: &str) {
        self.flush();
        let e = std::io::stderr();
        let mut e = e.lock();
        let _ = e.write_all(s.as_bytes());
        let _ = e.write_all(b"\n");
    }
    pub fn flush(&mut self) {
        if !self.stdout.is_empty() {
            let o = std::io::stdout();
            let mut o = o.lock();
            let _ = o.write_all(&self.stdout);
            let _ = o.flush();
            self.stdout.clear();
        }
    }
}

pub struct Flags {
    pub pos: Vec<String>,
    /// --name value, or --name alone (true)
    pub opt: IndexMap<String, Option<String>>,
}

impl Flags {
    pub fn has(&self, k: &str) -> bool {
        self.opt.contains_key(k)
    }
    /// the value of --k (a bare flag reads as "true")
    pub fn get(&self, k: &str) -> Option<String> {
        self.opt.get(k).map(|v| v.clone().unwrap_or_else(|| "true".into()))
    }
    /// Number(opt.k) when the flag is set
    pub fn num(&self, k: &str) -> Option<f64> {
        self.opt.get(k).map(|v| match v {
            None => 1.0,
            Some(s) => crate::import::js_number(s),
        })
    }
}

pub fn flags(argv: &[String]) -> Flags {
    let mut pos = vec![];
    let mut opt = IndexMap::new();
    let mut i = 0;
    while i < argv.len() {
        if let Some(k) = argv[i].strip_prefix("--") {
            match argv.get(i + 1) {
                Some(next) if !next.starts_with("--") => {
                    opt.insert(k.to_string(), Some(next.clone()));
                    i += 1;
                }
                _ => {
                    opt.insert(k.to_string(), None);
                }
            }
        } else {
            pos.push(argv[i].clone());
        }
        i += 1;
    }
    Flags { pos, opt }
}

pub fn read(path: &str) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("ENOENT: no such file or directory, open '{}'", path),
        _ => format!("{}: {}", path, e),
    })
}

pub fn write(path: &str, text: &str) -> Result<(), String> {
    std::fs::write(path, text).map_err(|e| format!("{}: {}", path, e))
}

/// a YAML or JSON file
pub fn load(path: &str) -> Result<Value, String> {
    let text = read(path)?;
    if path.ends_with(".json") {
        serde_json::from_str(&text).map_err(|e| e.to_string())
    } else {
        parse_yaml(&text)
    }
}

/// one YAML document
pub fn parse_yaml(text: &str) -> Result<Value, String> {
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_norway::from_str::<Value>(text).map_err(|e| {
        let m = e.to_string();
        if m.contains("more than one document") {
            "Source contains multiple documents; please use YAML.parseAllDocuments()".to_string()
        } else {
            m
        }
    })
}

/// every document of a YAML stream (empty documents dropped, as `yaml`'s toJS gives them as null)
pub fn yaml_documents(text: &str) -> Result<Vec<Value>, String> {
    use serde::Deserialize;
    let mut out = vec![];
    for d in serde_norway::Deserializer::from_str(text) {
        out.push(Value::deserialize(d).map_err(|e| e.to_string())?);
    }
    Ok(out)
}

// ---- console colours (always on, as the Node CLI writes them) ----

pub fn dim(s: &str) -> String {
    format!("\x1b[2m{}\x1b[0m", s)
}
pub fn bold(s: &str) -> String {
    format!("\x1b[1m{}\x1b[0m", s)
}
pub fn red(s: &str) -> String {
    format!("\x1b[31m{}\x1b[0m", s)
}
pub fn green(s: &str) -> String {
    format!("\x1b[32m{}\x1b[0m", s)
}
pub fn yellow(s: &str) -> String {
    format!("\x1b[33m{}\x1b[0m", s)
}

/// `${(n * 100).toFixed(n < 0.1 && n > 0 ? 2 : 1)}%`
pub fn pct(n: f64) -> String {
    format!("{}%", js_to_fixed(n * 100.0, if n < 0.1 && n > 0.0 { 2 } else { 1 }))
}
/// n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${n}ms`
pub fn ms(n: f64) -> String {
    if n >= 1000.0 {
        format!("{}s", js_to_fixed(n / 1000.0, 2))
    } else {
        format!("{}ms", js_num(n))
    }
}
/// pad or cut to n UTF-16 units
pub fn pad(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    if units.len() >= n {
        String::from_utf16_lossy(&units[..n])
    } else {
        format!("{}{}", s, " ".repeat(n - units.len()))
    }
}
pub fn loc(x: f64) -> String {
    js_locale(x)
}

// ---- JSON.stringify(v, null, 2) ----

pub fn pretty(v: &Value) -> String {
    pretty_indent(v, 2)
}

/// JSON.stringify(v, null, indent)
pub fn pretty_indent(v: &Value, indent: usize) -> String {
    let mut out = String::new();
    write_pretty(v, 0, indent, &mut out);
    out
}

fn write_pretty(v: &Value, depth: usize, indent: usize, out: &mut String) {
    let pad = |d: usize| " ".repeat(d * indent);
    match v {
        Value::Array(a) if a.is_empty() => out.push_str("[]"),
        Value::Object(m) if m.is_empty() => out.push_str("{}"),
        Value::Array(a) => {
            out.push_str("[\n");
            for (i, x) in a.iter().enumerate() {
                out.push_str(&pad(depth + 1));
                write_pretty(x, depth + 1, indent, out);
                if i + 1 < a.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            out.push_str(&pad(depth));
            out.push(']');
        }
        Value::Object(m) => {
            out.push_str("{\n");
            for (i, (k, x)) in m.iter().enumerate() {
                out.push_str(&pad(depth + 1));
                out.push_str(&serde_json::to_string(k).unwrap_or_default());
                out.push_str(": ");
                write_pretty(x, depth + 1, indent, out);
                if i + 1 < m.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            out.push_str(&pad(depth));
            out.push('}');
        }
        Value::Number(n) => {
            let x = n.as_f64().unwrap_or(f64::NAN);
            out.push_str(&if x.is_finite() { js_num(x) } else { "null".into() });
        }
        Value::String(s) => out.push_str(&serde_json::to_string(s).unwrap_or_default()),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Null => out.push_str("null"),
    }
}

/// a serializable result as a JSON value (missing optionals dropped, as JavaScript leaves them undefined)
pub fn to_json<T: serde::Serialize>(x: &T) -> Value {
    serde_json::to_value(x).unwrap_or(Value::Null)
}
