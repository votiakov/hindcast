//! Strategies (src/backtest/strategy.ts): an infrastructure change written as YAML/JSON, validated
//! with the same rules and messages as the TypeScript schema, applied to a plan with plain-English
//! notes of what changed and what was assumed.

use crate::math::{js_num, js_round, js_to_fixed};
use crate::model::Model;
use crate::types::*;
use serde_json::{json, Map as JMap, Value};

/// Graviton / Arm price relative to x86 for the same vCPU and memory
pub const ARM_PRICE_FACTOR: f64 = 0.8;

#[derive(Clone, Debug, Default)]
pub struct Autoscale {
    pub min: f64,
    pub max: f64,
    pub target_cpu: Option<f64>,
    pub warmup_s: Option<f64>,
    pub cooldown_s: Option<f64>,
    pub interval_s: Option<f64>,
    pub metric_window_s: Option<f64>,
}

#[derive(Clone, Debug, Default)]
pub struct CacheChange {
    pub hit_rate: f64,
    pub latency_ms: Option<f64>,
    pub cost_per_hour: Option<f64>,
}

#[derive(Clone, Debug, Default)]
pub struct ServiceChange {
    pub service: String,
    pub replicas: Option<f64>,
    pub autoscale: Option<Autoscale>,
    pub cpu: Option<f64>,
    pub memory_gb: Option<f64>,
    pub spread: bool,
    pub cpu_request: Option<f64>,
    pub memory_request_gb: Option<f64>,
    pub arch: Option<String>,
    pub perf: Option<f64>,
    pub capacity_rps: Option<f64>,
    pub cache: Option<CacheChange>,
    pub read_replicas: Option<f64>,
    pub read_share: Option<f64>,
    pub zone: Option<String>,
    pub region: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct EndpointChange {
    pub endpoint: String,
    pub retries: Option<(f64, Option<f64>)>,
    pub timeout_ms: Option<f64>,
}

#[derive(Clone, Debug)]
pub enum Change {
    Service(ServiceChange),
    Endpoint(EndpointChange),
}

#[derive(Clone, Debug)]
pub struct StrategySpec {
    pub name: String,
    pub description: Option<String>,
    pub changes: Vec<Change>,
}

/// a validation problem, as the TypeScript schema reports it
#[derive(Clone, Debug)]
struct Issue {
    path: Vec<Value>,
    message: String,
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

struct Checker<'a> {
    obj: &'a JMap<String, Value>,
    base: Vec<Value>,
    issues: Vec<Issue>,
}

impl<'a> Checker<'a> {
    fn at(&self, k: &str) -> Vec<Value> {
        let mut p = self.base.clone();
        p.push(json!(k));
        p
    }
    fn fail(&mut self, k: &str, message: String) {
        let path = self.at(k);
        self.issues.push(Issue { path, message });
    }
    fn string(&mut self, k: &str, required: bool) -> Option<String> {
        match self.obj.get(k) {
            Some(Value::String(s)) => Some(s.clone()),
            None if !required => None,
            v => {
                self.fail(k, format!("Invalid input: expected string, received {}", received(v)));
                None
            }
        }
    }
    /// a number with bounds: (min, inclusive), (max, inclusive), integer
    fn number(&mut self, k: &str, min: Option<(f64, bool)>, max: Option<f64>, int: bool) -> Option<f64> {
        let v = self.obj.get(k)?;
        let x = match v.as_f64() {
            Some(x) => x,
            None => {
                self.fail(k, format!("Invalid input: expected number, received {}", received(Some(v))));
                return None;
            }
        };
        if int && x.fract() != 0.0 {
            self.fail(k, "Invalid input: expected int, received number".into());
            return None;
        }
        let mut ok = true;
        if let Some((m, inclusive)) = min {
            if (inclusive && x < m) || (!inclusive && x <= m) {
                self.fail(k, format!("Too small: expected number to be {}{}", if inclusive { ">=" } else { ">" }, js_num(m)));
                ok = false;
            }
        }
        if let Some(m) = max {
            if x > m {
                self.fail(k, format!("Too big: expected number to be <={}", js_num(m)));
                ok = false;
            }
        }
        if ok {
            Some(x)
        } else {
            None
        }
    }
    fn object(&mut self, k: &str) -> Option<&'a JMap<String, Value>> {
        match self.obj.get(k) {
            None => None,
            Some(Value::Object(o)) => Some(o),
            v => {
                self.fail(k, format!("Invalid input: expected object, received {}", received(v)));
                None
            }
        }
    }
    fn strict(&mut self, allowed: &[&str]) {
        let extra: Vec<String> = self.obj.keys().filter(|k| !allowed.contains(&k.as_str())).map(|k| format!("\"{}\"", k)).collect();
        if !extra.is_empty() {
            let path = self.base.clone();
            self.issues.push(Issue { path, message: format!("Unrecognized key{}: {}", if extra.len() > 1 { "s" } else { "" }, extra.join(", ")) });
        }
    }
    fn nested(&mut self, k: &str, o: &'a JMap<String, Value>) -> Checker<'a> {
        Checker { obj: o, base: self.at(k), issues: vec![] }
    }
}

const SERVICE_KEYS: &[&str] = &["service", "replicas", "autoscale", "cpu", "memoryGb", "spread", "cpuRequest", "memoryRequestGb", "arch", "perf", "capacityRps", "cache", "readReplicas", "readShare", "zone", "region"];
const ENDPOINT_KEYS: &[&str] = &["endpoint", "retries", "timeoutMs"];

fn parse_service(o: &JMap<String, Value>) -> Result<ServiceChange, Vec<Issue>> {
    let mut c = Checker { obj: o, base: vec![], issues: vec![] };
    let service = c.string("service", true).unwrap_or_default();
    let replicas = c.number("replicas", Some((0.0, true)), Some(1000.0), true);
    let autoscale = c.object("autoscale").map(|a| {
        let mut n = c.nested("autoscale", a);
        let min = if a.contains_key("min") {
            n.number("min", Some((0.0, true)), None, true)
        } else {
            n.fail("min", "Invalid input: expected number, received undefined".into());
            None
        };
        let max = if a.contains_key("max") {
            n.number("max", Some((1.0, true)), None, true)
        } else {
            n.fail("max", "Invalid input: expected number, received undefined".into());
            None
        };
        let out = Autoscale {
            min: min.unwrap_or(0.0),
            max: max.unwrap_or(1.0),
            target_cpu: n.number("targetCpu", Some((0.05, true)), Some(1.0), false),
            warmup_s: n.number("warmupS", Some((0.0, true)), None, false),
            cooldown_s: n.number("cooldownS", Some((0.0, true)), None, false),
            interval_s: n.number("intervalS", Some((1.0, true)), None, false),
            metric_window_s: n.number("metricWindowS", Some((0.0, true)), None, false),
        };
        c.issues.extend(n.issues);
        out
    });
    let cpu = c.number("cpu", Some((0.0, false)), None, false);
    let memory_gb = c.number("memoryGb", Some((0.0, false)), None, false);
    let spread = match o.get("spread") {
        None => false,
        Some(Value::String(s)) if s == "even" => true,
        Some(_) => {
            c.fail("spread", "Invalid input: expected \"even\"".into());
            false
        }
    };
    let cpu_request = c.number("cpuRequest", Some((0.0, false)), None, false);
    let memory_request_gb = c.number("memoryRequestGb", Some((0.0, false)), None, false);
    // the spellings agents and manifests use: arm64, aarch64, graviton; amd64, x86_64
    let arch = match o.get("arch") {
        None => None,
        Some(Value::String(s)) => {
            let l = s.to_lowercase();
            let m = match l.as_str() {
                "arm64" | "aarch64" | "graviton" => "arm",
                "amd64" | "x86_64" | "x86-64" | "intel" | "amd" => "x86",
                x => x,
            };
            if m == "arm" || m == "x86" {
                Some(m.to_string())
            } else {
                c.fail("arch", "Invalid option: expected one of \"x86\"|\"arm\"".into());
                None
            }
        }
        Some(_) => {
            c.fail("arch", "Invalid option: expected one of \"x86\"|\"arm\"".into());
            None
        }
    };
    let perf = c.number("perf", Some((0.0, false)), None, false);
    let capacity_rps = c.number("capacityRps", Some((0.0, false)), None, false);
    let cache = c.object("cache").map(|a| {
        let mut n = c.nested("cache", a);
        let hit = if a.contains_key("hitRate") {
            n.number("hitRate", Some((0.0, true)), Some(1.0), false)
        } else {
            n.fail("hitRate", "Invalid input: expected number, received undefined".into());
            None
        };
        let out = CacheChange { hit_rate: hit.unwrap_or(0.0), latency_ms: n.number("latencyMs", Some((0.0, true)), None, false), cost_per_hour: n.number("costPerHour", Some((0.0, true)), None, false) };
        c.issues.extend(n.issues);
        out
    });
    let read_replicas = c.number("readReplicas", Some((0.0, true)), Some(15.0), true);
    let read_share = c.number("readShare", Some((0.0, true)), Some(1.0), false);
    let zone = c.string("zone", false);
    let region = c.string("region", false);
    c.strict(SERVICE_KEYS);
    if c.issues.is_empty() {
        Ok(ServiceChange { service, replicas, autoscale, cpu, memory_gb, spread, cpu_request, memory_request_gb, arch, perf, capacity_rps, cache, read_replicas, read_share, zone, region })
    } else {
        Err(c.issues)
    }
}

fn parse_endpoint(o: &JMap<String, Value>) -> Result<EndpointChange, Vec<Issue>> {
    let mut c = Checker { obj: o, base: vec![], issues: vec![] };
    let endpoint = c.string("endpoint", true).unwrap_or_default();
    let retries = c.object("retries").map(|a| {
        let mut n = c.nested("retries", a);
        let attempts = if a.contains_key("attempts") {
            n.number("attempts", Some((0.0, true)), Some(10.0), true)
        } else {
            n.fail("attempts", "Invalid input: expected number, received undefined".into());
            None
        };
        let budget = n.number("budget", Some((0.0, true)), Some(10.0), false);
        c.issues.extend(n.issues);
        (attempts.unwrap_or(0.0), budget)
    });
    let timeout_ms = c.number("timeoutMs", Some((0.0, false)), None, false);
    c.strict(ENDPOINT_KEYS);
    if c.issues.is_empty() {
        Ok(EndpointChange { endpoint, retries, timeout_ms })
    } else {
        Err(c.issues)
    }
}

/// StrategySpec.parse: Err carries the message the TypeScript schema throws (its issues as JSON)
pub fn parse_strategy(v: &Value) -> Result<StrategySpec, String> {
    let mut issues: Vec<Issue> = vec![];
    let o = match v {
        Value::Object(o) => o,
        x => {
            let i = Issue { path: vec![], message: format!("Invalid input: expected object, received {}", received(Some(x))) };
            return Err(issues_message(&[i]));
        }
    };
    let name = match o.get("name") {
        Some(Value::String(s)) => s.clone(),
        x => {
            issues.push(Issue { path: vec![json!("name")], message: format!("Invalid input: expected string, received {}", received(x)) });
            String::new()
        }
    };
    let description = match o.get("description") {
        None => None,
        Some(Value::String(s)) => Some(s.clone()),
        x => {
            issues.push(Issue { path: vec![json!("description")], message: format!("Invalid input: expected string, received {}", received(x)) });
            None
        }
    };
    let mut changes = vec![];
    match o.get("changes") {
        None => {}
        Some(Value::Array(a)) => {
            for (k, c) in a.iter().enumerate() {
                let empty = JMap::new();
                let co = c.as_object();
                let obj = co.unwrap_or(&empty);
                let is_endpoint = obj.contains_key("endpoint") && !obj.contains_key("service");
                let r = if co.is_none() {
                    Err(vec![Issue { path: vec![], message: format!("Invalid input: expected object, received {}", received(Some(c))) }])
                } else if is_endpoint {
                    parse_endpoint(obj).map(Change::Endpoint)
                } else {
                    parse_service(obj).map(Change::Service)
                };
                match r {
                    Ok(ch) => changes.push(ch),
                    Err(is) => {
                        for i in is {
                            let mut path = vec![json!("changes"), json!(k)];
                            path.extend(i.path);
                            let hint = if is_endpoint {
                                " — an endpoint change takes endpoint, retries { attempts, budget? }, timeoutMs"
                            } else {
                                " — a service change takes service plus replicas, autoscale, cpu, memoryGb, cpuRequest, memoryRequestGb, spread, arch, perf, capacityRps, cache, readReplicas, readShare, zone, region"
                            };
                            issues.push(Issue { path, message: format!("{}: {}{}", if is_endpoint { "endpoint change" } else { "service change" }, i.message, hint) });
                        }
                    }
                }
            }
        }
        Some(x) => issues.push(Issue { path: vec![json!("changes")], message: format!("Invalid input: expected array, received {}", received(Some(x))) }),
    }
    if issues.is_empty() {
        Ok(StrategySpec { name, description, changes })
    } else {
        Err(issues_message(&issues))
    }
}

fn issues_message(issues: &[Issue]) -> String {
    let arr: Vec<Value> = issues.iter().map(|i| json!({ "code": "custom", "path": i.path, "message": i.message })).collect();
    serde_json::to_string_pretty(&Value::Array(arr)).unwrap_or_default()
}

/// a number the way JavaScript's `+x.toFixed(d)` prints it
fn fixed_num(x: f64, d: usize) -> String {
    js_num(js_to_fixed(x, d).parse::<f64>().unwrap_or(x))
}

/// en-US grouping, as toLocaleString() prints an integer
pub fn locale_int(x: f64) -> String {
    let s = js_num(x);
    if !x.is_finite() || x.fract() != 0.0 {
        return s;
    }
    let (neg, digits) = if let Some(d) = s.strip_prefix('-') { (true, d.to_string()) } else { (false, s) };
    let mut out = String::new();
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    if neg {
        format!("-{}", out)
    } else {
        out
    }
}

pub struct Applied {
    pub plan: Plan,
    pub notes: Vec<String>,
}

pub fn apply_strategy(model: &Model, base: &Plan, spec: &StrategySpec) -> Result<Applied, String> {
    let mut plan = base.clone();
    let mut notes: Vec<String> = vec![];
    for ch in &spec.changes {
        let ch = match ch {
            Change::Endpoint(ch) => {
                let ids: Vec<String> = plan.endpoints.keys().filter(|id| ch.endpoint == "*" || **id == ch.endpoint).cloned().collect();
                if ids.is_empty() {
                    return Err(format!("strategy \"{}\": no endpoint \"{}\" (have: {})", spec.name, ch.endpoint, plan.endpoints.keys().cloned().collect::<Vec<_>>().join(", ")));
                }
                for id in &ids {
                    let e = plan.endpoints.get_mut(id).unwrap();
                    if let Some((attempts, budget)) = ch.retries {
                        e.retries = Some(Retries { attempts, budget: budget.unwrap_or(attempts) });
                    }
                    if let Some(t) = ch.timeout_ms {
                        if t != 0.0 {
                            e.timeout_ms = t;
                        }
                    }
                }
                if let Some((attempts, budget)) = ch.retries {
                    notes.push(format!("{}: clients retry failed requests up to {}×{}", ch.endpoint, js_num(attempts), budget.map(|b| format!(", at most +{}% extra load", js_num(js_round(b * 100.0)))).unwrap_or_default()));
                }
                if let Some(t) = ch.timeout_ms {
                    notes.push(format!("{}: client deadline {} ms", ch.endpoint, js_num(t)));
                }
                continue;
            }
            Change::Service(ch) => ch,
        };
        let have = || plan.services.keys().cloned().collect::<Vec<_>>().join(", ");
        let m = match (plan.services.contains_key(&ch.service), model.services.get(&ch.service)) {
            (true, Some(m)) => m,
            _ => return Err(format!("strategy \"{}\": no service \"{}\" (have: {})", spec.name, ch.service, have())),
        };
        let hosted = plan.services[&ch.service].hosted_by.clone();
        if let Some(h) = hosted.as_ref().filter(|h| !h.is_empty()) {
            if ch.replicas.is_some() || ch.autoscale.is_some() {
                return Err(format!("{} runs inside {}; scale {} instead", ch.service, h, h));
            }
        }
        let base_cluster = base.cluster.clone();
        let s = plan.services.get_mut(&ch.service).unwrap();
        let id = &ch.service;
        if let Some(r) = ch.replicas {
            s.replicas = Some(r);
            s.autoscale = None;
            notes.push(format!("{}: {} replica{} (was {})", id, js_num(r), if r == 1.0 { "" } else { "s" }, js_num(m.replicas)));
        }
        if let Some(a) = &ch.autoscale {
            s.autoscale = Some(AutoscalePolicy { min: a.min, max: a.max, target: a.target_cpu.unwrap_or(0.6), warmup_s: a.warmup_s.unwrap_or(60.0), cooldown_s: a.cooldown_s.unwrap_or(300.0), interval_s: a.interval_s.unwrap_or(15.0), metric_window_s: Some(a.metric_window_s.unwrap_or(30.0)) });
            s.replicas = None;
            if m.cpu.is_none() {
                notes.push(format!("{}: no CPU data — autoscaling tracks load as a share of fitted capacity instead of CPU", id));
            }
            notes.push(format!(
                "{}: autoscale {}–{} replicas at {}% CPU, {} s warm-up, {} s cool-down",
                id,
                js_num(a.min),
                js_num(a.max),
                js_num(js_round(a.target_cpu.unwrap_or(0.6) * 100.0)),
                js_num(a.warmup_s.unwrap_or(60.0)),
                js_num(a.cooldown_s.unwrap_or(300.0))
            ));
        }
        if ch.cpu.is_some() || ch.memory_gb.is_some() {
            let c0 = m.cpu_limit;
            let m0 = m.memory_gb;
            let c1 = ch.cpu.or(c0);
            let m1 = ch.memory_gb.or(m0);
            let c0t = c0.filter(|x| *x != 0.0 && !x.is_nan());
            if ch.cpu.is_some() && c0t.is_none() {
                return Err(format!("{}: CPU limit unknown, cannot resize — add a CPU limit series or set capacityRps", id));
            }
            if let (Some(_), Some(c0)) = (ch.cpu, c0t) {
                let c1 = c1.unwrap();
                let scale = c1 / c0;
                if m.capacity.limit == "cpu" {
                    let base = m.cpu.as_ref().map(|c| c.base).unwrap_or(0.0);
                    let f = if c0 > base { (c1 - base).max(0.0) / (c0 - base) } else { scale };
                    s.per_replica_rps *= f;
                    if let Some(o) = s.overloaded_rps.filter(|o| *o != 0.0 && !o.is_nan()) {
                        s.overloaded_rps = Some(o * f);
                    }
                    s.servers = js_round(c1).max(1.0);
                    notes.push(format!("{}: {} → {} cores per replica; CPU-bound, so capacity scales to {} req/s per replica", id, js_num(c0), js_num(c1), js_to_fixed(s.per_replica_rps, 1)));
                } else {
                    let cpu_cap = match &m.cpu {
                        Some(c) if c.per_req > 0.0 => (c1 - c.base) / c.per_req,
                        _ => f64::INFINITY,
                    };
                    if cpu_cap < s.per_replica_rps {
                        s.per_replica_rps = cpu_cap.max(0.0);
                        s.servers = js_round(c1).max(1.0);
                        notes.push(format!(
                            "{}: {} → {} cores per replica; at {} ms of CPU per request that caps it at {} req/s per replica — now CPU-bound",
                            id,
                            js_num(c0),
                            js_num(c1),
                            js_to_fixed(m.cpu.as_ref().unwrap().per_req * 1000.0, 1),
                            js_to_fixed(cpu_cap.max(0.0), 1)
                        ));
                    } else {
                        notes.push(format!(
                            "{}: {} → {} cores per replica; capacity is {}, so throughput does not change",
                            id,
                            js_num(c0),
                            js_num(c1),
                            if m.capacity.limit == "concurrency" { "bound by a concurrency limit" } else { "not CPU-bound" }
                        ));
                    }
                }
                s.cpu_limit = Some(c1);
            }
            if let Some(mem_gb) = ch.memory_gb {
                if let Some(mm) = &m.memory {
                    s.memory = Some(Memory { base: mm.base, per_req: mm.per_req, spike: mm.spike, limit: mem_gb, peak: mm.peak, seen_to: mm.seen_to });
                    let peak = mm.peak.unwrap_or(0.0);
                    let head = mem_gb - peak;
                    notes.push(format!(
                        "{}: memory limit {}{} MiB; the history's peak working set was {} MiB per container ({})",
                        id,
                        mm.limit.filter(|l| *l != 0.0 && !l.is_nan()).map(|l| format!("{} → ", js_num(js_round(l * 1024.0)))).unwrap_or_default(),
                        js_num(js_round(mem_gb * 1024.0)),
                        js_num(js_round(peak * 1024.0)),
                        if head >= 0.0 { format!("{} MiB of headroom", js_num(js_round(head * 1024.0))) } else { format!("{} MiB over: it would be OOM-killed", js_num(js_round(-head * 1024.0))) }
                    ));
                } else {
                    notes.push(format!("{}: memory {} GiB — no memory usage in the history, so OOM kills can't be checked", id, js_num(mem_gb)));
                }
            }
            let truthy = |x: Option<f64>| x.filter(|v| *v != 0.0 && !v.is_nan());
            let cpu_part = match (truthy(c0), truthy(c1)) {
                (Some(c0), Some(c1)) => (m.cost.cpu_share * c1) / c0,
                _ => m.cost.cpu_share,
            };
            let mem_part = match (truthy(m0), truthy(m1)) {
                (Some(m0), Some(m1)) => ((1.0 - m.cost.cpu_share) * m1) / m0,
                _ => 1.0 - m.cost.cpu_share,
            };
            s.replica_hour *= cpu_part + mem_part;
            notes.push(format!("{}: ${} per replica-hour (price scales with vCPU and memory)", id, js_to_fixed(s.replica_hour, 4)));
        }
        if let Some(r0) = &m.requests {
            if ch.cpu.is_some() || ch.memory_gb.is_some() || ch.cpu_request.is_some() || ch.memory_request_gb.is_some() {
                let close = |a: f64, b: Option<f64>| matches!(b, Some(b) if (a - b).abs() <= 0.01 * a.max(b));
                let cpu_r = ch.cpu_request.unwrap_or(if ch.cpu.is_some() && close(r0.cpu, m.cpu_limit) { ch.cpu.unwrap() } else { r0.cpu });
                let mem_r = ch.memory_request_gb.unwrap_or(if ch.memory_gb.is_some() && close(r0.memory_gb, m.memory_gb) { ch.memory_gb.unwrap() } else { r0.memory_gb });
                s.requests = Some(Requests { cpu: cpu_r, memory_gb: mem_r });
                if cpu_r != r0.cpu || mem_r != r0.memory_gb {
                    notes.push(format!("{}: requests {} → {} cores, {} → {} MiB per replica", id, js_num(r0.cpu), fixed_num(cpu_r, 3), js_num(js_round(r0.memory_gb * 1024.0)), js_num(js_round(mem_r * 1024.0))));
                }
                if m.cost.source == "nodes" {
                    if let Some(c) = &base_cluster {
                        let n = &c.node;
                        s.replica_hour = n.per_hour * (cpu_r / n.cpu).max(mem_r / n.memory_gb);
                    }
                }
            }
        }
        if let Some(arch) = &ch.arch {
            if *arch != m.cost.arch {
                let f = if arch == "arm" { ARM_PRICE_FACTOR } else { 1.0 / ARM_PRICE_FACTOR };
                s.replica_hour *= f;
                notes.push(format!("{}: {} pricing, ×{} per replica-hour", id, if arch == "arm" { "Graviton (Arm)" } else { "x86" }, js_to_fixed(f, 2)));
                if ch.perf.is_none() {
                    notes.push(format!("{}: assumes equal throughput per vCPU — set `perf` from your own benchmark", id));
                }
            }
        }
        if let Some(p) = ch.perf {
            s.per_replica_rps *= p;
            if let Some(c) = &s.cpu {
                s.cpu = Some(Cpu { base: c.base, per_req: c.per_req / p });
            }
            notes.push(format!("{}: ×{} throughput per replica", id, js_num(p)));
        }
        if let Some(c) = ch.capacity_rps {
            s.per_replica_rps = c;
            notes.push(format!("{}: {} req/s per replica (override)", id, js_num(c)));
        }
        if let Some(c) = &ch.cache {
            let cache = Cache { hit_rate: c.hit_rate, latency_ms: c.latency_ms.unwrap_or(1.0), cost_per_hour: c.cost_per_hour.unwrap_or(0.219) };
            notes.push(format!(
                "{}: cache in front, {}% hits at {} ms, ${}/h{}",
                id,
                js_num(js_round(c.hit_rate * 100.0)),
                js_num(cache.latency_ms),
                js_num(cache.cost_per_hour),
                if c.cost_per_hour.is_none() { " (ElastiCache cache.r7g.large)" } else { "" }
            ));
            s.cache = Some(cache);
        }
        if let Some(n) = ch.read_replicas {
            let r = ch.read_share.unwrap_or(0.8);
            let mult = 1.0 / (1.0 - r + r / (n + 1.0));
            s.per_replica_rps *= mult;
            s.replica_hour *= 1.0 + n;
            notes.push(format!(
                "{}: {} read replica{}; with {}% reads the primary carries {}% of the load (capacity ×{}), cost ×{}",
                id,
                js_num(n),
                if n == 1.0 { "" } else { "s" },
                js_num(js_round(r * 100.0)),
                js_num(js_round((1.0 / mult) * 100.0)),
                js_to_fixed(mult, 2),
                js_num(1.0 + n)
            ));
        }
        if let Some(z) = ch.zone.as_ref().filter(|z| !z.is_empty()) {
            s.zone = Some(z.clone());
            notes.push(format!("{}: placed in {}", id, z));
        }
        if let Some(r) = ch.region.as_ref().filter(|r| !r.is_empty()) {
            s.region = Some(r.clone());
            notes.push(format!("{}: placed in {}", id, r));
        }
    }
    // services hosted in a moved service move with it
    let ids: Vec<String> = plan.services.keys().cloned().collect();
    for id in ids {
        let host = plan.services[&id].hosted_by.clone().filter(|h| !h.is_empty());
        if let Some(h) = host {
            if let Some(hp) = plan.services.get(&h).cloned() {
                let s = plan.services.get_mut(&id).unwrap();
                s.zone = hp.zone;
                s.region = hp.region;
            }
        }
    }
    Ok(Applied { plan, notes })
}
