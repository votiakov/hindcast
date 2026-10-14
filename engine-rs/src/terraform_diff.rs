//! A Terraform plan (`terraform show -json plan.out`) → the strategy it amounts to
//! (src/backtest/terraformDiff.ts): ECS services and task definitions, application autoscaling, EC2
//! autoscaling groups, launch templates and instances, RDS instances and read replicas, Cloud Run and
//! Kubernetes deployments. Resources map to model services by the `hindcast:service` tag or label,
//! else by name.

use crate::config_diff::{cpu_quantity, mem_quantity};
use crate::import::js_number_of;
use crate::math::{js_num, js_round, js_to_fixed};
use indexmap::{IndexMap, IndexSet};
use regex_lite::Regex;
use serde::Serialize;
use serde_json::{json, Map as JMap, Value};
use std::sync::OnceLock;

type Obj = JMap<String, Value>;

fn empty() -> &'static Obj {
    static E: OnceLock<Obj> = OnceLock::new();
    E.get_or_init(Obj::new)
}
fn o(v: Option<&Value>) -> &Obj {
    match v {
        Some(Value::Object(m)) => m,
        _ => empty(),
    }
}
fn arr(v: Option<&Value>) -> &[Value] {
    match v {
        Some(Value::Array(a)) => a,
        _ => &[],
    }
}
/// o(arr(x)[0] ?? x)
fn first(v: Option<&Value>) -> &Obj {
    match v {
        Some(Value::Array(a)) => match a.first() {
            Some(Value::Null) | None => empty(),
            x => o(x),
        },
        x => o(x),
    }
}
fn nullish(v: Option<&Value>) -> bool {
    matches!(v, None | Some(Value::Null))
}
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|x| x != 0.0 && !x.is_nan()).unwrap_or(false),
        Some(Value::String(s)) => !s.is_empty(),
        _ => true,
    }
}
/// String(x)
fn js_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => js_num(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Array(a)) => a.iter().map(|x| if x.is_null() { String::new() } else { js_string(Some(x)) }).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}
/// a ?? b
fn or<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    if nullish(a) {
        b
    } else {
        a
    }
}
/// a number, or None for null, undefined, '' and what is not a finite number
fn num(v: Option<&Value>) -> Option<f64> {
    match v {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.is_empty() => None,
        x => {
            // Number([5]) is Number("5")
            let n = match x {
                Some(Value::Array(_)) => crate::import::js_number(&js_string(x)),
                _ => js_number_of(x),
            };
            if n.is_finite() {
                Some(n)
            } else {
                None
            }
        }
    }
}

/// a resource's before or after: None when falsy; something truthy that is not an object reads as {}
fn side_of(v: Option<&Value>) -> Option<&Obj> {
    if truthy(v) {
        Some(o(v))
    } else {
        None
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstanceType {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_gb: Option<f64>,
    pub arch: &'static str,
}

fn size_vcpu(s: &str) -> Option<f64> {
    Some(match s {
        "nano" | "micro" | "small" | "large" => 2.0,
        "medium" => 1.0,
        "xlarge" => 4.0,
        "2xlarge" => 8.0,
        "3xlarge" => 12.0,
        "4xlarge" => 16.0,
        "6xlarge" => 24.0,
        "8xlarge" => 32.0,
        "9xlarge" => 36.0,
        "12xlarge" => 48.0,
        "16xlarge" => 64.0,
        "18xlarge" => 72.0,
        "24xlarge" => 96.0,
        "32xlarge" => 128.0,
        "48xlarge" => 192.0,
        "metal" => 96.0,
        _ => return None,
    })
}

/// an EC2 / RDS / ElastiCache instance type → vCPU, memory and architecture (approximate for odd families)
pub fn instance_type(t: &str) -> InstanceType {
    static ARM: OnceLock<Regex> = OnceLock::new();
    let bare = t.strip_prefix("db.").or_else(|| t.strip_prefix("cache.")).unwrap_or(t);
    let mut parts = bare.split('.');
    let family = parts.next().unwrap_or("");
    let size = parts.next().unwrap_or("");
    let arch = if ARM.get_or_init(|| Regex::new(r"^(?:db\.|cache\.)?[a-z]+\d+g[a-z]*\.").unwrap()).is_match(t) { "arm" } else { "x86" };
    let burst = family.starts_with('t');
    let cpu = if burst && matches!(size, "nano" | "micro" | "small" | "medium" | "large") { Some(2.0) } else { size_vcpu(size) };
    let per_vcpu = match family.chars().next() {
        Some('c') => Some(2.0),
        Some('m') => Some(4.0),
        Some('r') => Some(8.0),
        Some('x') => Some(16.0),
        Some('t') => Some(2.0),
        _ => None,
    };
    let memory_gb = if burst {
        match size {
            "nano" => Some(0.5),
            "micro" => Some(1.0),
            "small" => Some(2.0),
            "medium" => Some(4.0),
            "large" => Some(8.0),
            "xlarge" => Some(16.0),
            "2xlarge" => Some(32.0),
            _ => None,
        }
    } else {
        match (cpu, per_vcpu) {
            (Some(c), Some(p)) if c != 0.0 => Some(c * p),
            _ => None,
        }
    };
    InstanceType { cpu, memory_gb, arch }
}

const SERVICE_TAGS: [&str; 6] = ["hindcast:service", "hindcast.dev/service", "hindcast-service", "bottleneck:service", "bottleneck.dev/service", "bottleneck-service"];
const SERVICE_ANNOTATIONS: [&str; 2] = ["hindcast.dev/service", "bottleneck.dev/service"];

fn tag_of(v: Option<&Obj>) -> Option<String> {
    let v = v?;
    for k in ["tags", "tags_all", "labels", "user_labels"] {
        let t = o(v.get(k));
        if let Some(s) = SERVICE_TAGS.iter().map(|k| t.get(*k)).find(|x| truthy(*x)) {
            return Some(js_string(s));
        }
    }
    let meta = first(v.get("metadata"));
    let ann = o(meta.get("annotations"));
    SERVICE_ANNOTATIONS.iter().map(|k| ann.get(*k)).find(|x| truthy(*x)).map(js_string)
}

struct Change<'a> {
    address: Option<&'a Value>,
    ty: &'a str,
    name: Option<&'a Value>,
    actions: Vec<String>,
    before: Option<&'a Obj>,
    after: Option<&'a Obj>,
    /// the raw sides, for `?.identifier` lookups
    raw_before: Option<&'a Value>,
    raw_after: Option<&'a Value>,
}

impl<'a> Change<'a> {
    fn side(&self, after: bool) -> Option<&'a Obj> {
        if after {
            self.after
        } else {
            self.before
        }
    }
    fn raw(&self, after: bool) -> Option<&'a Value> {
        if after {
            self.raw_after
        } else {
            self.raw_before
        }
    }
    fn address(&self) -> String {
        js_string(self.address)
    }
}

fn name_of(r: &Change, v: Option<&Obj>) -> String {
    if let Some(t) = tag_of(v) {
        return t;
    }
    let meta = first(v.and_then(|v| v.get("metadata")));
    let get = |k: &str| v.and_then(|v| v.get(k));
    let x = or(or(or(or(get("name"), get("family")), meta.get("name")), get("identifier")), r.name);
    js_string(x)
}

/// an autoscaler as JavaScript holds it: keys in the order they were first set, a key may be undefined
type Scale = IndexMap<&'static str, Option<f64>>;

fn stringify(a: Option<&Scale>) -> String {
    match a {
        None => "undefined".into(),
        Some(a) => {
            let mut m = Obj::new();
            for (k, v) in a {
                if let Some(v) = v {
                    m.insert((*k).into(), if v.is_finite() { json!(v) } else { Value::Null });
                }
            }
            Value::Object(m).to_string()
        }
    }
}

#[derive(Default, Clone)]
struct Workload {
    replicas: Option<f64>,
    cpu: Option<f64>,
    memory_gb: Option<f64>,
    arch: Option<&'static str>,
    autoscale: Option<Scale>,
    read_replicas: Option<f64>,
}

fn merge(m: &mut IndexMap<String, Workload>, svc: &str, w: Workload) {
    let cur = m.entry(svc.to_string()).or_default();
    if w.replicas.is_some() {
        cur.replicas = w.replicas;
    }
    if w.cpu.is_some() {
        cur.cpu = w.cpu;
    }
    if w.memory_gb.is_some() {
        cur.memory_gb = w.memory_gb;
    }
    if w.arch.is_some() {
        cur.arch = w.arch;
    }
    if w.autoscale.is_some() {
        cur.autoscale = w.autoscale;
    }
    if w.read_replicas.is_some() {
        cur.read_replicas = w.read_replicas;
    }
}

fn scale(min: Option<f64>, max: Option<f64>) -> Scale {
    let mut s = Scale::new();
    s.insert("min", min);
    s.insert("max", max);
    s
}

fn read_workload(r: &Change, v: Option<&Obj>) -> Option<(String, Workload)> {
    let v = v?;
    let service = name_of(r, Some(v));
    let w = match r.ty {
        "aws_ecs_service" => Workload { replicas: num(v.get("desired_count")), ..Default::default() },
        "aws_ecs_task_definition" => {
            let cpu_units = num(v.get("cpu"));
            let mem_mib = num(v.get("memory"));
            let a = or(first(v.get("runtime_platform")).get("cpu_architecture"), None);
            let arch = if a.map(|a| js_string(Some(a))).unwrap_or_else(|| "X86_64".into()).to_uppercase() == "ARM64" { "arm" } else { "x86" };
            Workload { cpu: cpu_units.map(|c| c / 1024.0), memory_gb: mem_mib.map(|m| m / 1024.0), arch: Some(arch), ..Default::default() }
        }
        "aws_autoscaling_group" => {
            let min = num(v.get("min_size"));
            let max = num(v.get("max_size"));
            Workload {
                replicas: num(v.get("desired_capacity")).or(min),
                autoscale: match (min, max) {
                    (Some(a), Some(b)) if a != b => Some(scale(min, max)),
                    _ => None,
                },
                ..Default::default()
            }
        }
        "aws_launch_template" | "aws_instance" | "aws_db_instance" | "aws_rds_cluster_instance" => {
            let key = if r.ty == "aws_launch_template" || r.ty == "aws_instance" { "instance_type" } else { "instance_class" };
            if !truthy(v.get(key)) {
                return None;
            }
            let t = instance_type(&js_string(v.get(key)));
            Workload { cpu: t.cpu, memory_gb: t.memory_gb, arch: Some(t.arch), ..Default::default() }
        }
        "google_cloud_run_v2_service" => {
            let tpl = first(v.get("template"));
            let scaling = first(tpl.get("scaling"));
            let limits = o(first(first(tpl.get("containers")).get("resources")).get("limits"));
            Workload { cpu: cpu_quantity(limits.get("cpu")), memory_gb: mem_quantity(limits.get("memory")), autoscale: Some(scale(Some(num(scaling.get("min_instance_count")).unwrap_or(0.0)), Some(num(scaling.get("max_instance_count")).unwrap_or(100.0)))), ..Default::default() }
        }
        "google_cloud_run_service" => {
            let tpl = first(v.get("template"));
            let ann = o(first(tpl.get("metadata")).get("annotations"));
            let limits = o(first(first(first(tpl.get("spec")).get("containers")).get("resources")).get("limits"));
            Workload { cpu: cpu_quantity(limits.get("cpu")), memory_gb: mem_quantity(limits.get("memory")), autoscale: Some(scale(Some(num(ann.get("autoscaling.knative.dev/minScale")).unwrap_or(0.0)), Some(num(ann.get("autoscaling.knative.dev/maxScale")).unwrap_or(100.0)))), ..Default::default() }
        }
        "kubernetes_deployment" | "kubernetes_deployment_v1" | "kubernetes_stateful_set" | "kubernetes_stateful_set_v1" => {
            let spec = first(v.get("spec"));
            let pod = first(first(spec.get("template")).get("spec"));
            let c = first(pod.get("container"));
            let res = first(c.get("resources"));
            let mut limits = o(res.get("requests")).clone();
            for (k, x) in o(res.get("limits")) {
                limits.insert(k.clone(), x.clone());
            }
            let sel = o(pod.get("node_selector"));
            Workload {
                replicas: Some(num(spec.get("replicas")).unwrap_or(1.0)),
                cpu: cpu_quantity(limits.get("cpu")),
                memory_gb: mem_quantity(limits.get("memory")),
                arch: Some(if sel.get("kubernetes.io/arch").and_then(|x| x.as_str()) == Some("arm64") { "arm" } else { "x86" }),
                ..Default::default()
            }
        }
        _ => return None,
    };
    Some((service, w))
}

/// "service/<cluster>/<name>" → name
fn ecs_service(id: Option<&Value>) -> Option<String> {
    match id {
        Some(Value::String(s)) if s.starts_with("service/") => s.split('/').next_back().map(String::from),
        _ => None,
    }
}

fn autoscaling(changes: &[Change], after: bool) -> IndexMap<String, Scale> {
    let mut out: IndexMap<String, Scale> = IndexMap::new();
    let mut by_address: IndexMap<String, String> = IndexMap::new();
    for r in changes {
        let v = match r.side(after) {
            Some(v) if r.ty == "aws_appautoscaling_target" => v,
            _ => continue,
        };
        let svc = match tag_of(Some(v)).or_else(|| ecs_service(v.get("resource_id"))) {
            Some(s) if !s.is_empty() => s,
            _ => continue,
        };
        out.insert(svc.clone(), scale(num(v.get("min_capacity")), num(v.get("max_capacity"))));
        by_address.insert(js_string(v.get("resource_id")), svc);
    }
    for r in changes {
        let v = match r.side(after) {
            Some(v) if r.ty == "aws_appautoscaling_policy" => v,
            _ => continue,
        };
        let svc = by_address.get(&js_string(v.get("resource_id"))).cloned().or_else(|| ecs_service(v.get("resource_id")));
        let cfg = first(v.get("target_tracking_scaling_policy_configuration"));
        let metric = match or(first(cfg.get("predefined_metric_specification")).get("predefined_metric_type"), None) {
            None => String::new(),
            m => js_string(m),
        };
        let svc = match svc {
            Some(s) if !s.is_empty() && metric.contains("CPU") => s,
            _ => continue,
        };
        let mut a = out.get(&svc).cloned().unwrap_or_default();
        a.insert("targetCpu", Some(num(cfg.get("target_value")).unwrap_or(60.0) / 100.0));
        if let Some(c) = num(cfg.get("scale_in_cooldown")) {
            a.insert("cooldownS", Some(c));
        }
        out.insert(svc, a);
    }
    out
}

/// match a resource's service name to a model service: exact, then by containment ("orders-api" ↔ "orders")
pub fn match_service(name: &str, known: Option<&IndexSet<String>>) -> Option<String> {
    let known = match known {
        None => return Some(name.to_string()),
        Some(k) => k,
    };
    if known.contains(name) {
        return Some(name.to_string());
    }
    let n = name.to_lowercase();
    let hits: Vec<&String> = known.iter().filter(|k| n.contains(&k.to_lowercase()) || k.to_lowercase().contains(&n)).collect();
    if hits.len() == 1 {
        Some(hits[0].clone())
    } else {
        None
    }
}

#[derive(Serialize)]
pub struct PlanResult {
    pub strategy: Option<Value>,
    pub ignored: Vec<String>,
    pub mapped: Vec<String>,
}

fn n(x: f64) -> Value {
    serde_json::Number::from_f64(x).map(Value::Number).unwrap_or(Value::Null)
}

pub fn strategy_from_terraform_plan(plan: &Value, name: Option<&str>, known: Option<&IndexSet<String>>) -> PlanResult {
    let mut changes: Vec<Change> = vec![];
    for x in arr(o(Some(plan)).get("resource_changes")) {
        let ch = match x.get("change") {
            Some(c) if truthy(Some(c)) => c,
            _ => continue,
        };
        let actions: Vec<String> = arr(ch.get("actions")).iter().map(|a| js_string(Some(a))).collect();
        if actions.len() == 1 && actions[0] == "no-op" {
            continue;
        }
        changes.push(Change {
            address: x.get("address"),
            ty: x.get("type").and_then(|t| t.as_str()).unwrap_or(""),
            name: x.get("name"),
            actions,
            before: side_of(ch.get("before")),
            after: side_of(ch.get("after")),
            raw_before: ch.get("before"),
            raw_after: ch.get("after"),
        });
    }
    let mut ignored: Vec<String> = vec![];
    let mut mapped: Vec<String> = vec![];
    let mut before: IndexMap<String, Workload> = IndexMap::new();
    let mut after: IndexMap<String, Workload> = IndexMap::new();
    let reads = |t: &str| t == "aws_db_instance";

    for r in &changes {
        if r.ty == "aws_appautoscaling_target" || r.ty == "aws_appautoscaling_policy" {
            continue;
        }
        if reads(r.ty) && (truthy(r.after.and_then(|a| a.get("replicate_source_db"))) || truthy(r.before.and_then(|b| b.get("replicate_source_db")))) {
            continue;
        }
        let b = read_workload(r, r.before);
        let a = read_workload(r, r.after);
        let (b, a) = match (b, a) {
            (None, None) => {
                ignored.push(format!("{}: {} is not something the backtest models ({})", r.address(), r.ty, r.actions.join("/")));
                continue;
            }
            (None, Some(_)) => {
                ignored.push(format!("{}: new {} — not in the model yet", r.address(), r.ty));
                continue;
            }
            (Some(_), None) => {
                ignored.push(format!("{}: {} destroyed — not modelled", r.address(), r.ty));
                continue;
            }
            (Some(b), Some(a)) => (b, a),
        };
        let svc = match match_service(&a.0, known) {
            Some(s) => s,
            None => {
                ignored.push(format!("{}: \"{}\" matches no service in the model — tag it hindcast:service", r.address(), a.0));
                continue;
            }
        };
        mapped.push(format!("{} → {}", r.address(), svc));
        merge(&mut before, &svc, b.1);
        merge(&mut after, &svc, a.1);
    }
    for (side, m) in [(false, &mut before), (true, &mut after)] {
        for (raw, a) in autoscaling(&changes, side) {
            let svc = match match_service(&raw, known) {
                Some(s) => s,
                None => continue,
            };
            let mut s = m.get(&svc).and_then(|w| w.autoscale.clone()).unwrap_or_default();
            for (k, v) in a {
                s.insert(k, v);
            }
            merge(m, &svc, Workload { autoscale: Some(s), ..Default::default() });
        }
    }
    for (side, m) in [(false, &mut before), (true, &mut after)] {
        // read replicas of a database: aws_db_instance resources pointing at a source
        let mut counts: IndexMap<String, f64> = IndexMap::new();
        for r in &changes {
            let v = match r.side(side) {
                Some(v) if reads(r.ty) && truthy(v.get("replicate_source_db")) => v,
                _ => continue,
            };
            let src = js_string(v.get("replicate_source_db"));
            let owner = changes.iter().find(|x| x.raw(side).and_then(|s| s.get("identifier")).and_then(|i| i.as_str()) == Some(src.as_str()) || x.name.and_then(|n| n.as_str()) == Some(src.as_str()));
            let svc = match owner {
                Some(ow) => name_of(ow, ow.side(side)),
                None => src,
            };
            *counts.entry(svc).or_insert(0.0) += 1.0;
        }
        for (raw, c) in counts {
            if let Some(svc) = match_service(&raw, known) {
                merge(m, &svc, Workload { read_replicas: Some(c), ..Default::default() });
            }
        }
    }

    let mut out: Vec<Value> = vec![];
    let mut said: Vec<String> = vec![];
    let none = Workload::default();
    for (svc, a) in &after {
        let b = before.get(svc).unwrap_or(&none);
        let mut ch = Obj::new();
        ch.insert("service".into(), json!(svc));
        let max = a.autoscale.as_ref().and_then(|s| s.get("max").copied().flatten());
        if a.autoscale.is_some() && stringify(a.autoscale.as_ref()) != stringify(b.autoscale.as_ref()) && max.is_some() {
            let s = a.autoscale.as_ref().unwrap();
            let min = s.get("min").copied().flatten().unwrap_or(1.0);
            let max = max.unwrap();
            let target = s.get("targetCpu").copied().flatten().unwrap_or(0.6);
            ch.insert("autoscale".into(), json!({ "min": n(min), "max": n(max), "targetCpu": n(target), "cooldownS": n(s.get("cooldownS").copied().flatten().unwrap_or(300.0)), "warmupS": 60, "metricWindowS": 60 }));
            said.push(format!("{} autoscale {}–{} @ {}% CPU", svc, js_num(min), js_num(max), js_num(js_round(target * 100.0))));
        } else if let Some(r) = a.replicas.filter(|r| Some(*r) != b.replicas && a.autoscale.is_none()) {
            ch.insert("replicas".into(), n(r));
            said.push(format!("{} {} → {} replicas", svc, b.replicas.map(js_num).unwrap_or_else(|| "?".into()), js_num(r)));
        }
        if let Some(c) = a.cpu.filter(|c| Some(*c) != b.cpu) {
            ch.insert("cpu".into(), n(c));
            said.push(format!("{} CPU {} → {}", svc, b.cpu.map(js_num).unwrap_or_else(|| "?".into()), js_num(c)));
        }
        if let Some(m) = a.memory_gb.filter(|m| Some(*m) != b.memory_gb) {
            ch.insert("memoryGb".into(), n(js_round(m * 1000.0) / 1000.0));
            said.push(format!("{} memory {} → {} GB", svc, b.memory_gb.map(|x| js_to_fixed(x, 2)).unwrap_or_else(|| "?".into()), js_to_fixed(m, 2)));
        }
        if let Some(arch) = a.arch.filter(|x| *x != b.arch.unwrap_or("x86")) {
            ch.insert("arch".into(), json!(arch));
            said.push(format!("{} → {}", svc, if arch == "arm" { "Graviton (Arm)" } else { "x86" }));
        }
        if let Some(rr) = a.read_replicas.filter(|r| *r != b.read_replicas.unwrap_or(0.0)) {
            ch.insert("readReplicas".into(), n(rr));
            said.push(format!("{} {} → {} read replicas", svc, js_num(b.read_replicas.unwrap_or(0.0)), js_num(rr)));
        }
        if ch.len() > 1 {
            out.push(Value::Object(ch));
        }
    }
    if out.is_empty() {
        return PlanResult { strategy: None, ignored, mapped };
    }
    let name = name.map(String::from).unwrap_or_else(|| said.join("; "));
    PlanResult { strategy: Some(json!({ "name": name, "description": "from the Terraform plan", "changes": out })), ignored, mapped }
}
