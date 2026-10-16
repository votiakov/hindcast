//! A pull request's Kubernetes manifests before and after → the strategy that says what changed
//! (src/backtest/configDiff.ts): replicas, CPU / memory limits and requests, HorizontalPodAutoscalers,
//! spreading over nodes and the CPU architecture. Takes the parsed YAML documents.

use crate::import::{js_number_of, js_parse_float};
use crate::math::{js_num, js_round, js_to_fixed};
use indexmap::{IndexMap, IndexSet};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map as JMap, Value};

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Autoscale {
    pub min: f64,
    pub max: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_cpu: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scale_down_s: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadConfig {
    pub service: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replicas: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_gb: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spread: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_request: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_request_gb: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub autoscale: Option<Autoscale>,
    /// a JIT runtime the pod template shows ("jvm", "dotnet"): its image, or the options it is given
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
}

/// the JIT runtime a container runs, from what its spec gives away: an image named for it (openjdk,
/// eclipse-temurin, spring-…, dotnet/aspnet) or the environment a JVM or .NET reads (JAVA_TOOL_OPTIONS,
/// JAVA_OPTS, a -javaagent; DOTNET_*, ASPNETCORE_*)
fn runtime_of(c: &JMap<String, Value>) -> Option<String> {
    let image = c.get("image").map(js_string).unwrap_or_default();
    let image = image.rsplit('/').next().unwrap_or("").split([':', '@']).next().unwrap_or("").to_string();
    let env: Vec<(String, String)> = arr(c.get("env")).iter().map(|e| (o(Some(e)).get("name").map(js_string).unwrap_or_default(), o(Some(e)).get("value").map(js_string).unwrap_or_default())).collect();
    let jvm_env = env.iter().any(|(k, v)| ["JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JAVA_OPTS", "JDK_JAVA_OPTIONS", "JAVA_HOME"].contains(&k.as_str()) || v.contains("-javaagent") || v.contains("-Xmx"));
    let dotnet_env = env.iter().any(|(k, _)| k.starts_with("DOTNET_") || k.starts_with("ASPNETCORE_") || k.starts_with("COMPlus_"));
    if jvm_env {
        return Some("jvm".into());
    }
    if dotnet_env {
        return Some("dotnet".into());
    }
    crate::model::jit_runtime(&image).map(String::from)
}

fn o(v: Option<&Value>) -> &JMap<String, Value> {
    static M: std::sync::OnceLock<JMap<String, Value>> = std::sync::OnceLock::new();
    match v {
        Some(Value::Object(m)) => m,
        _ => M.get_or_init(JMap::new),
    }
}
fn arr(v: Option<&Value>) -> &[Value] {
    match v {
        Some(Value::Array(a)) => a,
        _ => &[],
    }
}
/// String(x) for a defined value
fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => js_num(n.as_f64().unwrap_or(f64::NAN)),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".into(),
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { js_string(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}
/// a ?? b on object fields
fn coalesce<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    match a {
        None | Some(Value::Null) => b.filter(|x| !x.is_null()),
        x => x,
    }
}

/// "500m" → 0.5, "2" → 2
pub fn cpu_quantity(q: Option<&Value>) -> Option<f64> {
    let q = q.filter(|x| !x.is_null())?;
    let s = js_string(q);
    let s = s.trim();
    if s.ends_with('m') {
        return Some(js_parse_float(s) / 1000.0);
    }
    let v = js_parse_float(s);
    if v.is_finite() {
        Some(v)
    } else {
        None
    }
}

/// "512Mi" → 0.5, "2Gi" → 2, "1G" → 0.93 (GiB)
pub fn mem_quantity(q: Option<&Value>) -> Option<f64> {
    let q = q.filter(|x| !x.is_null())?;
    let s = js_string(q);
    let s = s.trim();
    let k = s.bytes().take_while(|c| c.is_ascii_digit() || *c == b'.').count();
    if k == 0 {
        return None;
    }
    let (num, rest) = s.split_at(k);
    let unit = rest.trim_start();
    let mult = match unit {
        "" => 1.0,
        "Ki" => 1024.0,
        "Mi" => 1048576.0,
        "Gi" => 1073741824.0,
        "Ti" => 1099511627776.0,
        "K" => 1e3,
        "M" => 1e6,
        "G" => 1e9,
        "T" => 1e12,
        _ => return None,
    };
    Some((js_parse_float(num) * mult) / 1073741824.0)
}

/// every workload in the documents, by model service
pub fn read_workloads(documents: &[Value]) -> IndexMap<String, WorkloadConfig> {
    let mut docs: Vec<&Value> = vec![];
    for d in documents {
        let x = o(Some(d));
        let kind = x.get("kind");
        if kind.and_then(|k| k.as_str()) == Some("List") {
            docs.extend(arr(x.get("items")).iter());
        } else if kind.map(truthy).unwrap_or(false) {
            docs.push(d);
        }
    }
    let mut out: IndexMap<String, WorkloadConfig> = IndexMap::new();
    let mut by_name: IndexMap<String, String> = IndexMap::new();
    for d in &docs {
        let d = o(Some(d));
        let kind = d.get("kind").map(js_string).unwrap_or_default();
        if !["Deployment", "StatefulSet", "ReplicaSet"].contains(&kind.as_str()) {
            continue;
        }
        let meta = o(d.get("metadata"));
        let name = meta.get("name").map(js_string).unwrap_or_else(|| "undefined".into());
        let ann = o(meta.get("annotations"));
        let service = coalesce(ann.get("hindcast.dev/service"), ann.get("bottleneck.dev/service")).map(js_string).unwrap_or_else(|| name.clone());
        let spec = o(d.get("spec"));
        let pod = o(o(spec.get("template")).get("spec"));
        let c = o(arr(pod.get("containers")).first());
        let res = o(c.get("resources"));
        let limits = o(res.get("limits"));
        let requests = o(res.get("requests"));
        let sel = o(pod.get("nodeSelector"));
        let affinity = pod.get("affinity").filter(|x| !x.is_null());
        let arch_label: Option<Value> = coalesce(sel.get("kubernetes.io/arch"), sel.get("beta.kubernetes.io/arch")).cloned().or_else(|| {
            let s = affinity.map(|a| a.to_string()).unwrap_or_else(|| "{}".into());
            if s.contains("arm64") {
                Some(Value::String("arm64".into()))
            } else {
                None
            }
        });
        let anti = Value::Object(o(o(pod.get("affinity")).get("podAntiAffinity")).clone()).to_string();
        let spread = arr(pod.get("topologySpreadConstraints")).iter().any(|t| o(Some(t)).get("topologyKey").and_then(|k| k.as_str()) == Some("kubernetes.io/hostname")) || anti.contains("kubernetes.io/hostname");
        let replicas = match spec.get("replicas") {
            None => 1.0,
            v => js_number_of(v),
        };
        let w = WorkloadConfig {
            service: service.clone(),
            replicas: Some(replicas),
            cpu: cpu_quantity(coalesce(limits.get("cpu"), requests.get("cpu"))),
            memory_gb: mem_quantity(coalesce(limits.get("memory"), requests.get("memory"))),
            spread: Some(spread),
            cpu_request: cpu_quantity(coalesce(requests.get("cpu"), limits.get("cpu"))),
            memory_request_gb: mem_quantity(coalesce(requests.get("memory"), limits.get("memory"))),
            arch: Some(if arch_label.as_ref().and_then(|a| a.as_str()) == Some("arm64") { "arm" } else { "x86" }.into()),
            autoscale: None,
            runtime: runtime_of(c),
        };
        out.insert(service.clone(), w);
        by_name.insert(name, service);
    }
    for d in &docs {
        let d = o(Some(d));
        if d.get("kind").and_then(|k| k.as_str()) != Some("HorizontalPodAutoscaler") {
            continue;
        }
        let spec = o(d.get("spec"));
        let target_name = o(spec.get("scaleTargetRef")).get("name").map(js_string).unwrap_or_else(|| "undefined".into());
        let target = match by_name.get(&target_name) {
            Some(t) => t.clone(),
            None => continue,
        };
        let metric = arr(spec.get("metrics")).iter().find(|m| o(o(Some(m)).get("resource")).get("name").and_then(|n| n.as_str()) == Some("cpu"));
        let util = match metric {
            Some(m) => {
                let r = o(o(Some(m)).get("resource"));
                js_number_of(coalesce(o(r.get("target")).get("averageUtilization"), r.get("targetAverageUtilization")))
            }
            None => match coalesce(spec.get("targetCPUUtilizationPercentage"), None) {
                None => 80.0,
                v => js_number_of(v),
            },
        };
        let down = o(o(spec.get("behavior")).get("scaleDown")).get("stabilizationWindowSeconds");
        let min = match coalesce(spec.get("minReplicas"), None) {
            None => 1.0,
            v => js_number_of(v),
        };
        if let Some(w) = out.get_mut(&target) {
            w.autoscale = Some(Autoscale { min, max: js_number_of(spec.get("maxReplicas")), target_cpu: Some(if util.is_finite() { util / 100.0 } else { 0.8 }), scale_down_s: down.map(|d| js_number_of(Some(d))) });
        }
    }
    out
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|x| x != 0.0 && !x.is_nan()).unwrap_or(false),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// `${x}` for an optional number, '?' when missing
fn or_q(x: Option<f64>) -> String {
    x.map(js_num).unwrap_or_else(|| "?".into())
}
fn fixed_or_q(x: Option<f64>) -> String {
    x.map(|v| js_to_fixed(v, 2)).unwrap_or_else(|| "?".into())
}
/// JSON.stringify of an optional autoscale (NaN written as null, as JavaScript does)
fn stringify(a: &Option<Autoscale>) -> String {
    match a {
        None => "undefined".into(),
        Some(a) => {
            let mut m = JMap::new();
            let n = |x: f64| if x.is_finite() { json!(x) } else { Value::Null };
            m.insert("min".into(), n(a.min));
            m.insert("max".into(), n(a.max));
            if let Some(t) = a.target_cpu {
                m.insert("targetCpu".into(), n(t));
            }
            if let Some(s) = a.scale_down_s {
                m.insert("scaleDownS".into(), n(s));
            }
            Value::Object(m).to_string()
        }
    }
}
fn num(x: f64) -> Value {
    serde_json::Number::from_f64(x).map(Value::Number).unwrap_or(Value::Null)
}

#[derive(Serialize)]
pub struct DiffResult {
    pub strategy: Option<Value>,
    pub ignored: Vec<String>,
}

/// the strategy that turns `before` into `after`, or None when nothing the model knows changed
pub fn strategy_from_diff(before: &IndexMap<String, WorkloadConfig>, after: &IndexMap<String, WorkloadConfig>, name: Option<&str>, known: Option<&IndexSet<String>>) -> DiffResult {
    let mut changes: Vec<Value> = vec![];
    let mut ignored: Vec<String> = vec![];
    let mut said: Vec<String> = vec![];
    for (svc, b) in after {
        let a = match before.get(svc) {
            Some(a) => a,
            None => {
                ignored.push(format!("{}: new workload — not in the model yet", svc));
                continue;
            }
        };
        if let Some(k) = known {
            if !k.contains(svc) {
                ignored.push(format!("{}: no service of that name in the model (annotate it with hindcast.dev/service)", svc));
                continue;
            }
        }
        let mut ch = JMap::new();
        ch.insert("service".into(), json!(svc));
        if b.autoscale.is_some() && stringify(&b.autoscale) != stringify(&a.autoscale) {
            let s = b.autoscale.as_ref().unwrap();
            let mut x = JMap::new();
            x.insert("min".into(), num(s.min));
            x.insert("max".into(), num(s.max));
            if let Some(t) = s.target_cpu {
                x.insert("targetCpu".into(), num(t));
            }
            x.insert("cooldownS".into(), num(s.scale_down_s.unwrap_or(300.0)));
            x.insert("warmupS".into(), json!(30));
            ch.insert("autoscale".into(), Value::Object(x));
            said.push(format!("{} autoscale {}–{} @ {}% CPU", svc, js_num(s.min), js_num(s.max), js_num(js_round(s.target_cpu.unwrap_or(0.8) * 100.0))));
        } else if b.autoscale.is_none() && a.autoscale.is_some() {
            ch.insert("replicas".into(), num(b.replicas.unwrap_or(1.0)));
            said.push(format!("{} fixed at {} replicas (autoscaler removed)", svc, b.replicas.map(js_num).unwrap_or_else(|| "undefined".into())));
        } else if b.autoscale.is_none() && b.replicas != a.replicas {
            ch.insert("replicas".into(), b.replicas.map(num).unwrap_or(Value::Null));
            said.push(format!("{} {} → {} replicas", svc, a.replicas.map(js_num).unwrap_or_else(|| "undefined".into()), b.replicas.map(js_num).unwrap_or_else(|| "undefined".into())));
        }
        if let Some(cpu) = b.cpu.filter(|_| b.cpu != a.cpu) {
            ch.insert("cpu".into(), num(cpu));
            said.push(format!("{} CPU {} → {}", svc, or_q(a.cpu), js_num(cpu)));
        }
        if let Some(m) = b.memory_gb.filter(|_| b.memory_gb != a.memory_gb) {
            ch.insert("memoryGb".into(), num(js_round(m * 1000.0) / 1000.0));
            said.push(format!("{} memory {} → {} GiB", svc, fixed_or_q(a.memory_gb), js_to_fixed(m, 2)));
        }
        if b.spread == Some(true) && a.spread != Some(true) {
            ch.insert("spread".into(), json!("even"));
            said.push(format!("{} spread over nodes", svc));
        }
        // a request that moved on its own (a limit change carries an equal request with it)
        if let Some(r) = b.cpu_request.filter(|_| b.cpu_request != a.cpu_request && !(b.cpu != a.cpu && b.cpu_request == b.cpu)) {
            ch.insert("cpuRequest".into(), num(r));
            said.push(format!("{} CPU request {} → {}", svc, or_q(a.cpu_request), js_num(r)));
        }
        if let Some(r) = b.memory_request_gb.filter(|_| b.memory_request_gb != a.memory_request_gb && !(b.memory_gb != a.memory_gb && b.memory_request_gb == b.memory_gb)) {
            ch.insert("memoryRequestGb".into(), num(js_round(r * 1000.0) / 1000.0));
            said.push(format!("{} memory request {} → {} GiB", svc, fixed_or_q(a.memory_request_gb), js_to_fixed(r, 2)));
        }
        if b.arch != a.arch {
            ch.insert("arch".into(), b.arch.clone().map(Value::String).unwrap_or(Value::Null));
            said.push(format!("{} → {}", svc, if b.arch.as_deref() == Some("arm") { "Graviton (arm64)" } else { "x86" }));
        }
        if ch.len() > 1 {
            // a JIT runtime: the pods the change starts (a new template, an autoscaler's) start cold
            if let Some(r) = &b.runtime {
                ch.insert("runtime".into(), json!(r));
            }
            changes.push(Value::Object(ch));
        }
    }
    for svc in before.keys() {
        if !after.contains_key(svc) {
            ignored.push(format!("{}: workload removed — not modelled", svc));
        }
    }
    if changes.is_empty() {
        return DiffResult { strategy: None, ignored };
    }
    let name = name.map(String::from).unwrap_or_else(|| said.join("; "));
    DiffResult { strategy: Some(json!({ "name": name, "description": "from the pull request diff", "changes": changes })), ignored }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deploy(name: &str, image: &str, env: Value, cpu: &str) -> Value {
        json!({ "kind": "Deployment", "metadata": { "name": name }, "spec": { "replicas": 1, "template": { "spec": { "containers": [{ "image": image, "env": env, "resources": { "limits": { "cpu": cpu } } }] } } } })
    }

    #[test]
    fn the_runtime_is_read_from_the_image_or_its_options() {
        let w = read_workloads(&[
            deploy("customers", "springcommunity/spring-petclinic-customers-service:3.4.1@sha256:ab", json!([]), "250m"),
            deploy("ad", "ghcr.io/open-telemetry/demo:2.0.2-ad", json!([{ "name": "_JAVA_OPTIONS", "value": "-Xmx400m" }]), "250m"),
            deploy("api", "registry/api:1", json!([{ "name": "JAVA_TOOL_OPTIONS", "value": "-javaagent:/otel/agent.jar" }]), "250m"),
            deploy("cart", "mcr.microsoft.com/dotnet/aspnet:8.0", json!([]), "250m"),
            deploy("frontend", "ghcr.io/open-telemetry/demo:2.0.2-frontend", json!([{ "name": "NODE_OPTIONS", "value": "--max-old-space-size=200" }]), "250m"),
            deploy("tools", "eclipse-temurin:21-jre", json!([]), "250m"),
        ]);
        let rt: Vec<Option<&str>> = w.values().map(|x| x.runtime.as_deref()).collect();
        assert_eq!(rt, vec![Some("jvm"), Some("jvm"), Some("jvm"), Some("dotnet"), None, Some("jvm")]);
        // a changed JVM workload carries its runtime into the strategy; an unchanged one isn't there
        let after = read_workloads(&[deploy("customers", "springcommunity/spring-petclinic-customers-service:3.4.1", json!([]), "125m"), deploy("frontend", "ghcr.io/open-telemetry/demo:2.0.2-frontend", json!([]), "125m")]);
        let r = strategy_from_diff(&w, &after, None, None);
        assert_eq!(r.strategy.unwrap()["changes"], json!([{ "service": "customers", "cpu": 0.125, "runtime": "jvm" }, { "service": "frontend", "cpu": 0.125 }]));
    }
}
