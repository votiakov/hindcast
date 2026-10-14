//! The architecture spec (src/spec/schema.ts, convert.ts): parsed and validated with the same rules
//! as the app's schema, turned into the simulator's nodes and edges, and edited by variants.

use super::catalog::{default_data, NodeData};
use super::engine::{EdgeData, SimEdge, SimNode};
use crate::math::js_num;
use serde_json::{json, Map as JMap, Value};

const KINDS: [&str; 14] = ["client", "cdn", "lb", "gateway", "server", "worker", "function", "cache", "db", "replica", "storage", "queue", "llm", "llmapi"];
const DATA_KEYS: [&str; 21] = ["tier", "instances", "runtime", "hitRate", "limit", "batching", "retries", "retryPolicy", "timeoutMs", "breaker", "fallback", "routing", "fanout", "stallRate", "stallMs", "queueS", "capacity", "latencyMs", "costPerHour", "autoscale", "warmupS"];

#[derive(Clone, Debug, Default)]
pub struct Issue {
    pub path: Vec<Value>,
    pub message: String,
    /// the schema's issue code (invalid_type, invalid_value, too_small, too_big, custom)
    pub code: &'static str,
    /// invalid_value: the allowed values
    pub values: Option<Vec<Value>>,
    pub minimum: Option<f64>,
    pub maximum: Option<f64>,
}

pub fn issues_message(issues: &[Issue]) -> String {
    let arr: Vec<Value> = issues.iter().map(|i| json!({ "code": "custom", "path": i.path, "message": i.message })).collect();
    serde_json::to_string_pretty(&Value::Array(arr)).unwrap_or_default()
}

fn received(v: Option<&Value>) -> &'static str {
    match v {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

struct V<'a> {
    o: &'a JMap<String, Value>,
    path: Vec<Value>,
    issues: &'a mut Vec<Issue>,
}

impl<'a> V<'a> {
    fn at(&self, k: &str) -> Vec<Value> {
        let mut p = self.path.clone();
        p.push(json!(k));
        p
    }
    fn fail(&mut self, k: &str, m: String) {
        self.fail_as(k, m, "invalid_type", None, None, None);
    }
    fn fail_as(&mut self, k: &str, m: String, code: &'static str, values: Option<Vec<Value>>, minimum: Option<f64>, maximum: Option<f64>) {
        let path = self.at(k);
        self.issues.push(Issue { path, message: m, code, values, minimum, maximum });
    }
    fn string(&mut self, k: &str, required: bool, min: usize) {
        match self.o.get(k) {
            None if !required => {}
            Some(Value::String(s)) => {
                if s.chars().count() < min {
                    self.fail_as(k, format!("Too small: expected string to have >={} characters", min), "too_small", None, Some(min as f64), None);
                }
            }
            v => self.fail(k, format!("Invalid input: expected string, received {}", received(v))),
        }
    }
    fn boolean(&mut self, k: &str) {
        match self.o.get(k) {
            None | Some(Value::Bool(_)) => {}
            v => self.fail(k, format!("Invalid input: expected boolean, received {}", received(v))),
        }
    }
    fn one_of(&mut self, k: &str, opts: &[&str], required: bool) {
        match self.o.get(k) {
            None if !required => {}
            Some(Value::String(s)) if opts.contains(&s.as_str()) => {}
            _ => self.fail_as(k, format!("Invalid option: expected one of {}", opts.iter().map(|x| format!("\"{}\"", x)).collect::<Vec<_>>().join("|")), "invalid_value", Some(opts.iter().map(|x| json!(x)).collect()), None, None),
        }
    }
    /// min: (value, inclusive)
    fn number(&mut self, k: &str, required: bool, min: Option<(f64, bool)>, max: Option<f64>, int: bool) {
        let v = match self.o.get(k) {
            None if !required => return,
            None => return self.fail(k, "Invalid input: expected number, received undefined".into()),
            Some(v) => v,
        };
        let x = match v.as_f64() {
            Some(x) => x,
            None => return self.fail(k, format!("Invalid input: expected number, received {}", received(Some(v)))),
        };
        if int && x.fract() != 0.0 {
            return self.fail(k, "Invalid input: expected int, received number".into());
        }
        if let Some((m, inc)) = min {
            if (inc && x < m) || (!inc && x <= m) {
                self.fail_as(k, format!("Too small: expected number to be {}{}", if inc { ">=" } else { ">" }, js_num(m)), "too_small", None, Some(m), None);
            }
        }
        if let Some(m) = max {
            if x > m {
                self.fail_as(k, format!("Too big: expected number to be <={}", js_num(m)), "too_big", None, None, Some(m));
            }
        }
    }
}

fn check_component(c: &JMap<String, Value>, path: Vec<Value>, issues: &mut Vec<Issue>, partial: bool) {
    let mut v = V { o: c, path, issues };
    if !partial {
        v.string("id", true, 1);
        v.one_of("kind", &KINDS, true);
    }
    v.string("name", false, 0);
    v.one_of("tier", &["S", "M", "L"], false);
    v.number("instances", false, Some((1.0, true)), Some(500.0), true);
    v.one_of("runtime", &["node", "python", "java", "go", "rust"], false);
    v.number("hitRate", false, Some((0.0, true)), Some(0.999), false);
    v.number("limit", false, Some((0.0, false)), None, false);
    v.boolean("batching");
    v.number("retries", false, Some((0.0, true)), Some(10.0), true);
    v.one_of("retryPolicy", &["immediate", "backoff", "budget"], false);
    v.number("timeoutMs", false, Some((0.0, false)), None, false);
    v.boolean("breaker");
    v.boolean("fallback");
    v.one_of("routing", &["split", "fanout", "failover"], false);
    v.number("stallRate", false, Some((0.0, true)), Some(0.5), false);
    v.number("stallMs", false, Some((0.0, true)), None, false);
    v.number("fanout", false, Some((1.0, true)), Some(1000.0), true);
    v.number("queueS", false, Some((0.0, false)), None, false);
    v.number("warmupS", false, Some((0.0, false)), None, false);
    v.number("capacity", false, Some((0.0, false)), None, false);
    v.number("latencyMs", false, Some((0.0, true)), None, false);
    v.number("costPerHour", false, Some((0.0, true)), None, false);
    match c.get("autoscale") {
        None => {}
        Some(Value::Object(a)) => {
            let path = v.at("autoscale");
            let mut w = V { o: a, path, issues: v.issues };
            w.number("min", true, Some((1.0, true)), Some(500.0), true);
            w.number("max", true, Some((1.0, true)), Some(500.0), true);
            w.number("targetUtil", false, Some((0.1, true)), Some(0.95), false);
            w.number("warmupS", false, Some((0.0, true)), Some(900.0), false);
            w.number("cooldownS", false, Some((0.0, true)), Some(3600.0), false);
        }
        Some(x) => v.fail("autoscale", format!("Invalid input: expected object, received {}", received(Some(x)))),
    }
}

/// an architecture as data: components (validated JSON objects) and connections
#[derive(Clone, Debug)]
pub struct Architecture {
    pub name: Option<String>,
    pub pricing: Option<String>,
    pub components: Vec<JMap<String, Value>>,
    /// (from, to, latencyMs)
    pub connections: Vec<(String, String, Option<f64>)>,
    pub zones: Vec<(String, Option<String>, Vec<String>)>,
}

fn connection_of(c: &Value) -> Option<(String, String, Option<f64>)> {
    match c {
        Value::Array(a) if a.len() == 2 => Some((a[0].as_str()?.to_string(), a[1].as_str()?.to_string(), None)),
        Value::String(s) => {
            let parts: Vec<&str> = s.split("->").collect();
            if parts.len() != 2 {
                return None;
            }
            let (a, b) = (parts[0].trim(), parts[1].trim());
            if a.is_empty() || b.is_empty() || a.contains(char::is_whitespace) || b.contains(char::is_whitespace) || a.contains('>') || b.contains('>') {
                return None;
            }
            Some((a.into(), b.into(), None))
        }
        Value::Object(o) => {
            let from = o.get("from")?.as_str()?.to_string();
            let to = o.get("to")?.as_str()?.to_string();
            let lat = match o.get("latencyMs") {
                None => None,
                Some(v) => {
                    let x = v.as_f64()?;
                    if !(0.0..=1000.0).contains(&x) {
                        return None;
                    }
                    Some(x)
                }
            };
            Some((from, to, lat))
        }
        _ => None,
    }
}

pub fn parse_architecture(v: &Value) -> Result<Architecture, String> {
    let (a, issues) = check_architecture(v);
    a.ok_or_else(|| issues_message(&issues))
}

/// the spec checked against the schema: the architecture when it holds, and every issue found
pub fn check_architecture(v: &Value) -> (Option<Architecture>, Vec<Issue>) {
    let mut issues = vec![];
    let o = match v {
        Value::Object(o) => o,
        x => return (None, vec![Issue { path: vec![], message: format!("Invalid input: expected object, received {}", received(Some(x))), code: "invalid_type", ..Default::default() }]),
    };
    if let Some(ver) = o.get("version") {
        if ver.as_f64() != Some(1.0) {
            issues.push(Issue { path: vec![json!("version")], message: "Invalid input: expected 1".into(), code: "invalid_value", values: Some(vec![json!(1)]), ..Default::default() });
        }
    }
    {
        let mut top = V { o, path: vec![], issues: &mut issues };
        top.string("name", false, 0);
        top.string("description", false, 0);
        top.one_of("pricing", &["illustrative", "aws-us-east-1", "gcp-us-central1"], false);
    }
    let mut components = vec![];
    match o.get("components") {
        Some(Value::Array(a)) => {
            if a.is_empty() {
                issues.push(Issue { path: vec![json!("components")], message: "Too small: expected array to have >=1 items".into(), code: "too_small", minimum: Some(1.0), ..Default::default() });
            }
            for (i, c) in a.iter().enumerate() {
                match c {
                    Value::Object(co) => {
                        check_component(co, vec![json!("components"), json!(i)], &mut issues, false);
                        components.push(co.clone());
                    }
                    x => issues.push(Issue { path: vec![json!("components"), json!(i)], message: format!("Invalid input: expected object, received {}", received(Some(x))), code: "invalid_type", ..Default::default() }),
                }
            }
        }
        x => issues.push(Issue { path: vec![json!("components")], message: format!("Invalid input: expected array, received {}", received(x)), code: "invalid_type", ..Default::default() }),
    }
    let mut connections = vec![];
    match o.get("connections") {
        Some(Value::Array(a)) => {
            for (i, c) in a.iter().enumerate() {
                match connection_of(c) {
                    Some(x) => connections.push(x),
                    None => issues.push(Issue { path: vec![json!("connections"), json!(i)], message: "write a connection as \"from -> to\", [\"from\", \"to\"] or { from, to, latencyMs? } (latencyMs 0–1000)".into(), code: "custom", ..Default::default() }),
                }
            }
        }
        x => issues.push(Issue { path: vec![json!("connections")], message: format!("Invalid input: expected array, received {}", received(x)), code: "invalid_type", ..Default::default() }),
    }
    let mut zones = vec![];
    match o.get("zones") {
        None => {}
        Some(Value::Array(a)) => {
            for (i, z) in a.iter().enumerate() {
                let zo = z.as_object();
                let id = zo.and_then(|z| z.get("id")).and_then(|x| x.as_str());
                let members = zo.and_then(|z| z.get("members")).and_then(|x| x.as_array()).map(|m| m.iter().map(|x| x.as_str().map(String::from)).collect::<Option<Vec<_>>>());
                match (id, members) {
                    (Some(id), Some(Some(m))) => zones.push((id.to_string(), zo.and_then(|z| z.get("label")).and_then(|x| x.as_str()).map(String::from), m)),
                    _ => issues.push(Issue { path: vec![json!("zones"), json!(i)], message: "a zone takes id, label? and members (component ids)".into(), code: "custom", ..Default::default() }),
                }
            }
        }
        x => issues.push(Issue { path: vec![json!("zones")], message: format!("Invalid input: expected array, received {}", received(x)), code: "invalid_type", ..Default::default() }),
    }
    if !issues.is_empty() {
        return (None, issues);
    }
    (Some(Architecture {
        name: o.get("name").and_then(|x| x.as_str()).map(String::from),
        pricing: o.get("pricing").and_then(|x| x.as_str()).map(String::from),
        components,
        connections,
        zones,
    }), issues)
}

/// a component's node data: the kind's defaults, then the spec's own fields
pub fn component_data(c: &JMap<String, Value>) -> NodeData {
    let id = c.get("id").and_then(|x| x.as_str()).unwrap_or("");
    let kind = c.get("kind").and_then(|x| x.as_str()).unwrap_or("server");
    let name = c.get("name").and_then(|x| x.as_str()).unwrap_or(id);
    let d = default_data(kind, name);
    let mut obj = serde_json::to_value(&d).unwrap();
    let m = obj.as_object_mut().unwrap();
    for k in DATA_KEYS {
        if let Some(v) = c.get(k) {
            if !v.is_null() {
                m.insert(k.to_string(), v.clone());
            }
        }
    }
    if m.contains_key("instances") && !m.contains_key("down") {
        m.insert("down".into(), json!(0));
    }
    serde_json::from_value(obj).unwrap_or(d)
}

/// spec → the simulator's nodes and edges
pub fn graph_of(a: &Architecture) -> (Vec<SimNode>, Vec<SimEdge>) {
    let nodes = a.components.iter().map(|c| SimNode { id: c.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string(), data: component_data(c) }).collect();
    let edges = a
        .connections
        .iter()
        .map(|(from, to, lat)| SimEdge { id: format!("e-{}-{}", from, to), source: from.clone(), target: to.clone(), data: lat.filter(|l| *l != 0.0).map(|l| EdgeData { latency_ms: Some(l) }) })
        .collect();
    (nodes, edges)
}

pub fn to_value(a: &Architecture) -> Value {
    let mut o = JMap::new();
    o.insert("version".into(), json!(1));
    if let Some(n) = &a.name {
        o.insert("name".into(), json!(n));
    }
    if let Some(p) = &a.pricing {
        o.insert("pricing".into(), json!(p));
    }
    o.insert("components".into(), Value::Array(a.components.iter().map(|c| Value::Object(c.clone())).collect()));
    o.insert(
        "connections".into(),
        Value::Array(a.connections.iter().map(|(f, t, l)| match l { Some(l) => json!({ "from": f, "to": t, "latencyMs": l }), None => json!([f, t]) }).collect()),
    );
    if !a.zones.is_empty() {
        o.insert("zones".into(), Value::Array(a.zones.iter().map(|(id, label, m)| { let mut z = json!({ "id": id, "members": m }); if let Some(l) = label { z["label"] = json!(l); } z }).collect()));
    }
    Value::Object(o)
}

/// apply a variant (a full replacement architecture, or a list of edits) to a base
pub fn apply_variant(base: &Architecture, v: &Value) -> Result<Architecture, String> {
    if let Some(spec) = v.get("spec").filter(|s| !s.is_null()) {
        return parse_architecture(spec);
    }
    let mut a = base.clone();
    let empty = vec![];
    for ch in v.get("changes").and_then(|c| c.as_array()).unwrap_or(&empty) {
        let op = ch.get("op").and_then(|x| x.as_str()).unwrap_or("");
        let s = |k: &str| ch.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
        let find = |a: &Architecture, id: &str| -> Result<usize, String> { a.components.iter().position(|c| c.get("id").and_then(|x| x.as_str()) == Some(id)).ok_or_else(|| format!("change refers to unknown component \"{}\"", id)) };
        match op {
            "set" => {
                let i = find(&a, &s("id"))?;
                if let Some(f) = ch.get("fields").and_then(|x| x.as_object()) {
                    let mut issues = vec![];
                    check_component(f, vec![json!("fields")], &mut issues, true);
                    if !issues.is_empty() {
                        return Err(issues_message(&issues));
                    }
                    for (k, val) in f {
                        if k != "id" && k != "kind" {
                            a.components[i].insert(k.clone(), val.clone());
                        }
                    }
                }
            }
            "add" => {
                let c = ch.get("component").and_then(|x| x.as_object()).ok_or("an add change takes a component")?;
                let id = c.get("id").and_then(|x| x.as_str()).unwrap_or("");
                if a.components.iter().any(|x| x.get("id").and_then(|x| x.as_str()) == Some(id)) {
                    return Err(format!("component \"{}\" already exists", id));
                }
                a.components.push(c.clone());
                if let Some(zone) = ch.get("zone").and_then(|x| x.as_str()) {
                    let z = a.zones.iter_mut().find(|z| z.0 == zone).ok_or_else(|| format!("change places \"{}\" in unknown zone \"{}\"", id, zone))?;
                    z.2.push(id.to_string());
                }
            }
            "remove" => {
                let id = s("id");
                find(&a, &id)?;
                a.components.retain(|x| x.get("id").and_then(|x| x.as_str()) != Some(id.as_str()));
                a.connections.retain(|(f, t, _)| *f != id && *t != id);
                for z in a.zones.iter_mut() {
                    z.2.retain(|m| *m != id);
                }
            }
            "connect" => {
                let (from, to) = (s("from"), s("to"));
                find(&a, &from)?;
                find(&a, &to)?;
                a.connections.push((from, to, None));
            }
            "disconnect" => {
                let (from, to) = (s("from"), s("to"));
                a.connections.retain(|(f, t, _)| !(*f == from && *t == to));
            }
            x => return Err(format!("unknown change op \"{}\" (set, add, remove, connect, disconnect)", x)),
        }
    }
    parse_architecture(&to_value(&a))
}

/// a scripted action, as ActionSpec
#[derive(Clone, Debug)]
pub enum Action {
    Kill { kind: String, busiest: bool },
    ReviveAll,
    KillId(String),
    ReviveId(String),
    FailZone(String),
    RestoreZone(String),
    Degrade(String, f64),
    Restore(String),
    InjectErrors(String, f64),
    InjectLatency(String, f64),
    FlushCache(String),
}

impl Action {
    pub fn kind_name(&self) -> &'static str {
        match self {
            Action::Kill { .. } => "kill",
            Action::ReviveAll => "revive-all",
            Action::KillId(_) => "kill-id",
            Action::ReviveId(_) => "revive-id",
            Action::FailZone(_) => "fail-zone",
            Action::RestoreZone(_) => "restore-zone",
            Action::Degrade(..) => "degrade",
            Action::Restore(_) => "restore",
            Action::InjectErrors(..) => "inject-errors",
            Action::InjectLatency(..) => "inject-latency",
            Action::FlushCache(_) => "flush-cache",
        }
    }
    pub fn id(&self) -> Option<&str> {
        match self {
            Action::KillId(i) | Action::ReviveId(i) | Action::FailZone(i) | Action::RestoreZone(i) | Action::Degrade(i, _) | Action::Restore(i) | Action::InjectErrors(i, _) | Action::InjectLatency(i, _) | Action::FlushCache(i) => Some(i),
            _ => None,
        }
    }
}

pub fn parse_action(v: &Value, path: Vec<Value>, issues: &mut Vec<Issue>) -> Option<Action> {
    let o = match v.as_object() {
        Some(o) => o,
        None => {
            issues.push(Issue { path, message: "Invalid input: expected object".into(), ..Default::default() });
            return None;
        }
    };
    let ty = o.get("type").and_then(|x| x.as_str()).unwrap_or("");
    let id = || o.get("id").and_then(|x| x.as_str()).map(String::from);
    let need_id = |issues: &mut Vec<Issue>| -> Option<String> {
        let r = id();
        if r.is_none() {
            let mut p = path.clone();
            p.push(json!("id"));
            issues.push(Issue { path: p, message: "Invalid input: expected string, received undefined".into(), ..Default::default() });
        }
        r
    };
    let frac = |k: &str, max: Option<f64>, issues: &mut Vec<Issue>| -> Option<f64> {
        let x = o.get(k).and_then(|x| x.as_f64());
        let ok = matches!(x, Some(x) if x >= 0.0 && max.map(|m| x <= m).unwrap_or(true));
        if !ok {
            let mut p = path.clone();
            p.push(json!(k));
            issues.push(Issue { path: p, message: format!("expected a number {}", max.map(|m| format!("between 0 and {}", js_num(m))).unwrap_or_else(|| ">= 0".into())), ..Default::default() });
        }
        x
    };
    Some(match ty {
        "kill-id" => Action::KillId(need_id(issues)?),
        "revive-id" => Action::ReviveId(need_id(issues)?),
        "kill" => {
            let kind = o.get("kind").and_then(|x| x.as_str()).filter(|k| KINDS.contains(k));
            if kind.is_none() {
                let mut p = path.clone();
                p.push(json!("kind"));
                issues.push(Issue { path: p, message: format!("Invalid option: expected one of {}", KINDS.iter().map(|x| format!("\"{}\"", x)).collect::<Vec<_>>().join("|")), ..Default::default() });
                return None;
            }
            Action::Kill { kind: kind.unwrap().into(), busiest: o.get("pick").and_then(|x| x.as_str()).unwrap_or("busiest") != "random" }
        }
        "revive-all" => Action::ReviveAll,
        "fail-zone" => Action::FailZone(need_id(issues)?),
        "restore-zone" => Action::RestoreZone(need_id(issues)?),
        "degrade" => {
            let i = need_id(issues)?;
            Action::Degrade(i, frac("factor", Some(1.0), issues)?)
        }
        "restore" => Action::Restore(need_id(issues)?),
        "inject-errors" => {
            let i = need_id(issues)?;
            Action::InjectErrors(i, frac("rate", Some(1.0), issues)?)
        }
        "inject-latency" => {
            let i = need_id(issues)?;
            Action::InjectLatency(i, frac("ms", None, issues)?)
        }
        "flush-cache" => Action::FlushCache(need_id(issues)?),
        x => {
            let mut p = path.clone();
            p.push(json!("type"));
            issues.push(Issue { path: p, message: format!("unknown action \"{}\" (kill-id, revive-id, kill, revive-all, fail-zone, restore-zone, degrade, restore, inject-errors, inject-latency, flush-cache)", x), ..Default::default() });
            return None;
        }
    })
}

#[derive(Clone, Debug)]
pub struct Scenario {
    pub name: Option<String>,
    pub duration: f64,
    pub rps: Option<f64>,
    pub traffic: Option<Vec<(f64, f64)>>,
    pub read_ratio: f64,
    pub events: Vec<(f64, Action, Option<String>)>,
    pub slo: (f64, f64),
}

pub fn parse_scenario(v: &Value) -> Result<Scenario, String> {
    let empty = JMap::new();
    let o = v.as_object().unwrap_or(&empty);
    let mut issues = vec![];
    {
        let mut c = V { o, path: vec![], issues: &mut issues };
        c.string("name", false, 0);
        c.number("duration", false, Some((0.0, false)), Some(3600.0), false);
        c.number("rps", false, Some((0.0, true)), None, false);
        c.number("readRatio", false, Some((0.0, true)), Some(1.0), false);
    }
    let traffic = o.get("traffic").and_then(|t| t.as_array()).map(|a| a.iter().filter_map(|k| Some((k.get("at")?.as_f64()?, k.get("rps")?.as_f64()?))).collect::<Vec<_>>());
    if let (Some(t), Some(a)) = (&traffic, o.get("traffic").and_then(|t| t.as_array())) {
        if t.len() != a.len() || t.iter().any(|(at, r)| *at < 0.0 || *r < 0.0) {
            issues.push(Issue { path: vec![json!("traffic")], message: "traffic keyframes take at ≥ 0 and rps ≥ 0".into(), ..Default::default() });
        }
    }
    let mut events = vec![];
    if let Some(a) = o.get("events").and_then(|e| e.as_array()) {
        for (i, e) in a.iter().enumerate() {
            let at = e.get("at").and_then(|x| x.as_f64()).filter(|x| *x >= 0.0);
            if at.is_none() {
                issues.push(Issue { path: vec![json!("events"), json!(i), json!("at")], message: "Invalid input: expected number >= 0".into(), ..Default::default() });
            }
            let act = parse_action(e.get("action").unwrap_or(&Value::Null), vec![json!("events"), json!(i), json!("action")], &mut issues);
            if let (Some(at), Some(act)) = (at, act) {
                events.push((at, act, e.get("note").and_then(|x| x.as_str()).map(String::from)));
            }
        }
    }
    if !issues.is_empty() {
        return Err(issues_message(&issues));
    }
    let slo = o.get("slo").map(|s| (s.get("maxErrorRate").and_then(|x| x.as_f64()).unwrap_or(0.01), s.get("maxP99Ms").and_then(|x| x.as_f64()).unwrap_or(300.0))).unwrap_or((0.01, 300.0));
    Ok(Scenario {
        name: o.get("name").and_then(|x| x.as_str()).map(String::from),
        duration: o.get("duration").and_then(|x| x.as_f64()).unwrap_or(60.0),
        rps: o.get("rps").and_then(|x| x.as_f64()),
        traffic,
        read_ratio: o.get("readRatio").and_then(|x| x.as_f64()).unwrap_or(0.8),
        events,
        slo,
    })
}
