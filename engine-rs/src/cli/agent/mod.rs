//! The agent tools (agent/tools.ts), defined once: `hindcast agent <tool>` runs them from a shell and
//! the MCP server registers them. Every tool is read-only towards the user's systems.

pub mod collect;
pub mod connect;
pub mod sources;
pub mod verify;
pub mod workspace;

use crate::cli::util::*;
use serde_json::{json, Map as JMap, Value};
use workspace::Workspace;

pub fn tools() -> Vec<Value> {
    serde_json::from_str(include_str!("tools.json")).unwrap_or_default()
}

fn received(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// an argument checked against a tool's input schema with the schema library's rules: unknown keys
/// dropped, a union's first branch that fits taken; issues as (path, message)
pub fn validate(schema: &Value, v: Option<&Value>, path: &[String], issues: &mut Vec<(String, String)>) -> Option<Value> {
    let p = || if path.is_empty() { "(root)".to_string() } else { path.join(".") };
    if let Some(any) = schema.get("anyOf").and_then(|a| a.as_array()) {
        let v = match v {
            Some(v) => v,
            None => {
                issues.push((p(), "Invalid input: expected nonoptional, received undefined".into()));
                return None;
            }
        };
        for b in any {
            let mut sub = vec![];
            if let Some(out) = validate(b, Some(v), path, &mut sub) {
                if sub.is_empty() {
                    return Some(out);
                }
            }
        }
        issues.push((p(), "Invalid input".into()));
        return None;
    }
    let ty = schema.get("type").and_then(|t| t.as_str());
    let v = match v {
        Some(v) => v,
        None => {
            issues.push((p(), format!("Invalid input: expected {}, received undefined", ty.map(|t| if t == "integer" { "number" } else { t }).unwrap_or("value"))));
            return None;
        }
    };
    let mismatch = |want: &str, issues: &mut Vec<(String, String)>| {
        issues.push((p(), format!("Invalid input: expected {}, received {}", want, received(v))));
        None
    };
    match ty {
        Some("object") => {
            let o = match v {
                Value::Object(o) => o,
                _ => return mismatch("object", issues),
            };
            let mut out = JMap::new();
            if let Some(props) = schema.get("properties").and_then(|x| x.as_object()) {
                let required: Vec<&str> = schema.get("required").and_then(|r| r.as_array()).map(|a| a.iter().filter_map(|x| x.as_str()).collect()).unwrap_or_default();
                for (k, s) in props {
                    let mut pp = path.to_vec();
                    pp.push(k.clone());
                    match o.get(k) {
                        None if !required.contains(&k.as_str()) => {}
                        x => {
                            if let Some(r) = validate(s, x, &pp, issues) {
                                out.insert(k.clone(), r);
                            }
                        }
                    }
                }
            } else if let Some(ap) = schema.get("additionalProperties").filter(|a| a.is_object()) {
                // a record: every value against the value schema
                for (k, x) in o {
                    let mut pp = path.to_vec();
                    pp.push(k.clone());
                    let ok = if ap.as_object().map(|m| m.is_empty()).unwrap_or(false) { Some(x.clone()) } else { validate(ap, Some(x), &pp, issues) };
                    if let Some(r) = ok {
                        out.insert(k.clone(), r);
                    }
                }
            } else {
                return Some(v.clone());
            }
            Some(Value::Object(out))
        }
        Some("array") => {
            let a = match v {
                Value::Array(a) => a,
                _ => return mismatch("array", issues),
            };
            if let Some(m) = schema.get("minItems").and_then(|x| x.as_u64()) {
                if (a.len() as u64) < m {
                    issues.push((p(), format!("Too small: expected array to have >={} items", m)));
                }
            }
            let items = schema.get("items").cloned().unwrap_or(json!({}));
            let mut out = vec![];
            for (i, x) in a.iter().enumerate() {
                let mut pp = path.to_vec();
                pp.push(i.to_string());
                if let Some(r) = validate(&items, Some(x), &pp, issues) {
                    out.push(r);
                }
            }
            Some(Value::Array(out))
        }
        Some("string") => {
            let s = match v {
                Value::String(s) => s,
                _ => return mismatch("string", issues),
            };
            if let Some(e) = schema.get("enum").and_then(|e| e.as_array()) {
                if !e.iter().any(|x| x.as_str() == Some(s)) {
                    issues.push((p(), format!("Invalid option: expected one of {}", e.iter().map(|x| format!("\"{}\"", x.as_str().unwrap_or(""))).collect::<Vec<_>>().join("|"))));
                    return None;
                }
            }
            if schema.get("format").and_then(|f| f.as_str()) == Some("uri") && !(s.contains("://") && s.split("://").next().map(|sch| !sch.is_empty() && sch.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))).unwrap_or(false)) {
                issues.push((p(), "Invalid URL".into()));
                return None;
            }
            Some(v.clone())
        }
        Some("number") | Some("integer") => {
            let x = match v.as_f64() {
                Some(x) if v.is_number() => x,
                _ => return mismatch("number", issues),
            };
            if ty == Some("integer") && x.fract() != 0.0 {
                issues.push((p(), "Invalid input: expected int, received number".into()));
                return None;
            }
            if let Some(m) = schema.get("exclusiveMinimum").and_then(|m| m.as_f64()) {
                if x <= m {
                    issues.push((p(), format!("Too small: expected number to be >{}", crate::math::js_num(m))));
                }
            }
            if let Some(m) = schema.get("minimum").and_then(|m| m.as_f64()) {
                if x < m {
                    issues.push((p(), format!("Too small: expected number to be >={}", crate::math::js_num(m))));
                }
            }
            if let Some(m) = schema.get("maximum").and_then(|m| m.as_f64()) {
                if x > m {
                    issues.push((p(), format!("Too big: expected number to be <={}", crate::math::js_num(m))));
                }
            }
            Some(v.clone())
        }
        Some("boolean") => match v {
            Value::Bool(_) => Some(v.clone()),
            _ => mismatch("boolean", issues),
        },
        _ => Some(v.clone()),
    }
}

/// a schema error (the issues as JSON) as explainError writes it: "invalid input" and a "path: message" line each
pub fn explain_schema_error(e: &str) -> String {
    match serde_json::from_str::<Value>(e) {
        Ok(Value::Array(issues)) => format!(
            "invalid input:\n{}",
            issues
                .iter()
                .map(|i| {
                    let path: Vec<String> = i.get("path").and_then(|p| p.as_array()).map(|a| a.iter().map(|x| match x {
                        Value::String(s) => s.clone(),
                        x => crate::math::js_num(x.as_f64().unwrap_or(f64::NAN)),
                    }).collect()).unwrap_or_default();
                    format!("- {}: {}", if path.is_empty() { "(root)".to_string() } else { path.join(".") }, i.get("message").and_then(|m| m.as_str()).unwrap_or(""))
                })
                .collect::<Vec<_>>()
                .join("\n")
        ),
        _ => e.to_string(),
    }
}

/// run a tool by name with arguments: the result as JSON, or an error an agent can act on
pub fn run_tool(name: &str, args: &Value) -> Result<Value, String> {
    let all = tools();
    let t = all.iter().find(|t| t.get("name").and_then(|n| n.as_str()) == Some(name)).ok_or_else(|| format!("no tool \"{}\" — one of {}", name, all.iter().filter_map(|t| t.get("name").and_then(|n| n.as_str())).collect::<Vec<_>>().join(", ")))?;
    let mut issues = vec![];
    let parsed = validate(&t["inputSchema"], Some(args), &[], &mut issues).unwrap_or(json!({}));
    if !issues.is_empty() {
        return Err(format!("invalid input:\n{}", issues.iter().map(|(p, m)| format!("- {}: {}", p, m)).collect::<Vec<_>>().join("\n")));
    }
    let ws = Workspace::new(parsed.get("workspace").and_then(|w| w.as_str()));
    match name {
        "connect_telemetry" => connect::connect_telemetry(&ws, &parsed),
        "read_cluster" => connect::read_cluster(&ws, &parsed),
        "collect_telemetry" => collect::collect(&ws, &parsed),
        "calibrate_model" => verify::calibrate_model(&ws, &parsed),
        "model_status" => verify::model_status(&ws),
        "verify_change" => verify::verify_change(&ws, parsed.get("changes").and_then(|c| c.as_array()).map(|a| a.as_slice()).unwrap_or(&[]), &parsed),
        "find_headroom" => verify::find_headroom(&ws, &parsed),
        "check_node_loss" => verify::check_node_loss(&ws, &parsed),
        "verify_design" => verify::verify_design(&parsed),
        _ => Err(format!("{} is not available in this build yet", name)),
    }
}

/// `hindcast agent <tool> <json | @file | ->`
pub fn command(rest: &[String], out: &mut Out) -> Result<i32, String> {
    let tool = rest.first().map(|s| s.as_str()).unwrap_or("");
    if tool.is_empty() || tool == "list" {
        for t in tools() {
            out.log(&format!("{} {}", pad_end(t["name"].as_str().unwrap_or(""), 20), t["title"].as_str().unwrap_or("")));
        }
        return Ok(0);
    }
    let text = match rest.get(1).map(|s| s.as_str()) {
        None => "{}".to_string(),
        Some("-") => {
            let mut s = String::new();
            std::io::Read::read_to_string(&mut std::io::stdin(), &mut s).map_err(|e| e.to_string())?;
            s
        }
        Some(a) if a.starts_with('@') => read(&a[1..])?,
        Some(a) => a.to_string(),
    };
    let args: Value = if text.trim().starts_with('{') { serde_json::from_str(&text).map_err(|e| e.to_string())? } else { parse_yaml(&text)? };
    let args = if args.is_null() { json!({}) } else { args };
    match run_tool(&tool.replace('-', "_"), &args) {
        Ok(v) => {
            out.log(&pretty(&v));
            Ok(0)
        }
        Err(e) => {
            out.log(&pretty(&json!({ "error": e })));
            Ok(1)
        }
    }
}

/// String.prototype.padEnd
pub fn pad_end(x: &str, n: usize) -> String {
    let len = x.encode_utf16().count();
    if len >= n {
        x.to_string()
    } else {
        format!("{}{}", x, " ".repeat(n - len))
    }
}
