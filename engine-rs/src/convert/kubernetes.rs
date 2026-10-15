//! Kubernetes manifests → architecture spec (src/spec/kubernetes.ts). Workloads become components,
//! HorizontalPodAutoscalers `autoscale`, images tell databases, caches and brokers apart, Ingresses and
//! LoadBalancer Services become entry points; call edges are guessed from references to other
//! Services in env / args, and every guess is listed in `assumptions`.

use super::{a, jmax, jmin, js_stringify, n, number, o, or, s, slug, ImportResult, Mapped, Obj};
use crate::math::{js_num, js_round};
use indexmap::{IndexMap, IndexSet};
use regex_lite::Regex;
use serde_json::{json, Value};
use std::sync::OnceLock;

const WORKLOADS: [&str; 6] = ["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "DeploymentConfig", "Rollout"];
const SKIP: [&str; 16] = ["ConfigMap", "Secret", "ServiceAccount", "Role", "RoleBinding", "ClusterRole", "ClusterRoleBinding", "Namespace", "PersistentVolumeClaim", "PersistentVolume", "NetworkPolicy", "PodDisruptionBudget", "CronJob", "Job", "StorageClass", "CustomResourceDefinition"];

fn re(cell: &'static OnceLock<Regex>, p: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(p).unwrap())
}

/// what a container image most likely is
fn classify(image: &str) -> Option<(&'static str, String)> {
    static DB: OnceLock<Regex> = OnceLock::new();
    static DB2: OnceLock<Regex> = OnceLock::new();
    static CACHE: OnceLock<Regex> = OnceLock::new();
    static QUEUE: OnceLock<Regex> = OnceLock::new();
    static STORAGE: OnceLock<Regex> = OnceLock::new();
    static LB: OnceLock<Regex> = OnceLock::new();
    static LLM: OnceLock<Regex> = OnceLock::new();
    static LLM2: OnceLock<Regex> = OnceLock::new();
    let lower = image.to_lowercase();
    let i = lower.split('@').next().unwrap_or("");
    let name = i.split('/').next_back().unwrap_or("").split(':').next().unwrap_or("");
    let why = format!("{} image", name);
    if re(&DB, "^(postgres|postgresql|spilo|mysql|mariadb|mongo|mongodb|cockroach|cassandra|scylla|timescaledb|clickhouse)").is_match(name) || re(&DB2, r"bitnami/(postgresql|mysql|mongodb)").is_match(i) {
        return Some(("db", why));
    }
    if re(&CACHE, "^(redis|valkey|memcached|keydb|dragonfly)").is_match(name) {
        return Some(("cache", why));
    }
    if re(&QUEUE, "^(rabbitmq|kafka|nats|pulsar|activemq|redpanda|elasticmq)").is_match(name) {
        return Some(("queue", why));
    }
    if re(&STORAGE, "^(minio|seaweedfs)").is_match(name) {
        return Some(("storage", why));
    }
    if re(&LB, "^(nginx|envoy|haproxy|traefik|kong|caddy)$").is_match(name) || i.contains("ingress-nginx") {
        return Some(("lb", why));
    }
    if re(&LLM, "^(vllm|tgi|text-generation-inference|triton|ollama)").is_match(name) || re(&LLM2, "vllm|text-generation-inference|tritonserver").is_match(i) {
        return Some(("llm", why));
    }
    None
}

/// someone paged to promote a replica by hand, s: a guess, not a measurement
const MANUAL_FAILOVER_S: f64 = 1800.0;

/// a single-primary database: its replicas take writes only once something promotes one
fn single_primary(image: &str) -> bool {
    let lower = image.to_lowercase();
    let name = lower.split('@').next().unwrap_or("").split('/').next_back().unwrap_or("").split(':').next().unwrap_or("").to_string();
    ["postgres", "postgresql", "spilo", "mysql", "mariadb", "timescaledb"].iter().any(|p| name.starts_with(p))
}

/// an operator or agent that elects a new primary: CloudNativePG, Patroni (and Zalando's Spilo), Crunchy
fn ha_operator(image: &str, containers: &[Value], labels: &Obj) -> Option<&'static str> {
    let images: Vec<String> = std::iter::once(image.to_lowercase()).chain(containers.iter().map(|c| c.get("image").and_then(|i| i.as_str()).unwrap_or("").to_lowercase())).collect();
    let env = containers.iter().flat_map(|c| c.get("env").and_then(|e| e.as_array()).cloned().unwrap_or_default()).filter_map(|e| e.get("name").and_then(|n| n.as_str()).map(|n| n.to_string())).collect::<Vec<_>>();
    if images.iter().any(|i| i.contains("cloudnative-pg") || i.contains("cnpg")) || labels.keys().any(|k| k.starts_with("cnpg.io/")) {
        return Some("CloudNativePG");
    }
    if images.iter().any(|i| i.contains("spilo")) || labels.get("application").and_then(|v| v.as_str()) == Some("spilo") {
        return Some("Zalando's postgres-operator (Spilo, Patroni)");
    }
    if images.iter().any(|i| i.contains("patroni")) || env.iter().any(|n| n.starts_with("PATRONI_")) {
        return Some("Patroni");
    }
    if images.iter().any(|i| i.contains("crunchy")) || labels.keys().any(|k| k.starts_with("postgres-operator.crunchydata.com/")) {
        return Some("Crunchy's postgres-operator");
    }
    None
}

/// telemetry plumbing (tracing, metrics, logs): it watches the system, it is not on the request path
fn is_telemetry(image: &str, name: &str) -> bool {
    static T: OnceLock<Regex> = OnceLock::new();
    let lower = image.to_lowercase();
    let i = lower.split('@').next().unwrap_or("");
    let img = i.split('/').next_back().unwrap_or("").split(':').next().unwrap_or("");
    let r = re(&T, "^(jaeger|all-in-one|opentelemetry-collector|otel-collector|otelcol|prometheus|grafana|loki|promtail|tempo|alertmanager|node-exporter|kube-state-metrics|fluentd|fluent-bit|zipkin|opensearch-dashboards|kibana)");
    r.is_match(img) || r.is_match(&name.to_lowercase()) || i.contains("jaegertracing/") || i.contains("opentelemetry-collector")
}

/// container CPU request → size tier
fn tier_of_cpu(cpu: &str) -> Option<&'static str> {
    if cpu.is_empty() {
        return None;
    }
    let p = crate::import::js_parse_float(cpu);
    let cores = if cpu.ends_with('m') { p / 1000.0 } else { p };
    if !cores.is_finite() {
        return None;
    }
    Some(if cores <= 1.0 {
        "S"
    } else if cores <= 2.0 {
        "M"
    } else {
        "L"
    })
}

fn runtime_of(image: &str) -> Option<&'static str> {
    let i = image.to_lowercase();
    let any = |ws: &[&str]| ws.iter().any(|w| i.contains(w));
    if any(&["node", "bun", "deno"]) {
        Some("node")
    } else if any(&["python", "django", "flask", "fastapi", "uvicorn", "gunicorn"]) {
        Some("python")
    } else if any(&["java", "openjdk", "temurin", "corretto", "spring", "jvm"]) {
        Some("java")
    } else if any(&["golang", "distroless/static"]) {
        Some("go")
    } else if i.contains("rust") {
        Some("rust")
    } else {
        None
    }
}

struct Workload<'a> {
    id: String,
    name: String,
    kind_name: String,
    labels: &'a Obj,
    containers: &'a [Value],
    /// index of its component
    comp: usize,
}

/// labels[k] === v for primitives (objects never compare equal)
fn same(a: Option<&Value>, b: &Value) -> bool {
    match (a, b) {
        (Some(Value::Object(_)), _) | (Some(Value::Array(_)), _) | (_, Value::Object(_)) | (_, Value::Array(_)) => false,
        (Some(Value::Number(x)), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Some(x), y) => x == y,
        (None, _) => false,
    }
}

/// the (^|[^a-z0-9-])name([^a-z0-9-]|$) test, at every position
fn mentions(blob: &str, name: &str) -> bool {
    if name.is_empty() {
        return true;
    }
    let edge = |c: Option<char>| match c {
        None => true,
        Some(c) => !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
    };
    let mut from = 0;
    while let Some(k) = blob[from..].find(name) {
        let i = from + k;
        let before = blob[..i].chars().next_back();
        let after = blob[i + name.len()..].chars().next();
        if edge(before) && edge(after) {
            return true;
        }
        from = i + blob[i..].chars().next().map(|c| c.len_utf8()).unwrap_or(1);
    }
    false
}

pub fn import_kubernetes(docs_in: &[Value], name: Option<&str>) -> Result<ImportResult, String> {
    // flatten `List` documents and drop empties
    let mut docs: Vec<&Obj> = vec![];
    for d in docs_in {
        let x = o(Some(d));
        if x.get("kind").and_then(|k| k.as_str()) == Some("List") {
            docs.extend(a(x.get("items")).iter().map(|i| o(Some(i))));
        } else if truthy(x.get("kind")) {
            docs.push(x);
        }
    }
    if docs.is_empty() {
        return Err("no Kubernetes objects found (expected documents with apiVersion and kind)".into());
    }
    let mut assumptions: Vec<String> = vec![];
    let mut skipped: Vec<String> = vec![];
    let mut mapped: Vec<Mapped> = vec![];
    let mut components: Vec<Obj> = vec![];
    let mut edges: Vec<(String, String)> = vec![];
    let mut used: IndexSet<String> = IndexSet::new();
    used.insert("users".into());
    let uid = |base: &str, used: &mut IndexSet<String>| -> String {
        let mut id = slug(base);
        let mut i = 2;
        while used.contains(&id) {
            id = format!("{}-{}", slug(base), i);
            i += 1;
        }
        used.insert(id.clone());
        id
    };
    let meta = |d: &Obj| o(d.get("metadata")).clone();
    let kind_of = |d: &Obj| s(d.get("kind"));
    let ref_of = |d: &Obj| format!("{}/{}", js_kind(d.get("kind")), s(o(d.get("metadata")).get("name")));
    let kind_str = |c: &Obj| c.get("kind").and_then(|k| k.as_str()).unwrap_or("").to_string();

    // ---- workloads ----
    let mut workloads: Vec<Workload> = vec![];
    for d in &docs {
        let kind = kind_of(d);
        if !WORKLOADS.contains(&kind.as_str()) {
            continue;
        }
        let spec = o(d.get("spec"));
        let tpl = o(o(spec.get("template")).get("spec"));
        let containers = a(tpl.get("containers"));
        let main = o(containers.first());
        let image = s(main.get("image"));
        let nm = s(meta(d).get("name"));
        if is_telemetry(&image, &nm) {
            skipped.push(ref_of(d));
            assumptions.push(format!("{}: telemetry ({}), not on the request path — not modelled", ref_of(d), if image.is_empty() { nm.clone() } else { image.split('/').next_back().unwrap_or("").to_string() }));
            continue;
        }
        let cls = classify(&image);
        let replicas = if kind == "DaemonSet" { 3.0 } else { jmax(1.0, number(or(spec.get("replicas"), Some(&json!(1))))) };
        if kind == "DaemonSet" {
            assumptions.push(format!("{}: DaemonSet modelled as 3 instances (one per node) — set your node count", ref_of(d)));
        }
        let tier = tier_of_cpu(&s(o(o(main.get("resources")).get("requests")).get("cpu")));
        let mut comp = Obj::new();
        let id = uid(&nm, &mut used);
        comp.insert("id".into(), json!(id));
        match &cls {
            Some(("db", why)) => {
                comp.insert("kind".into(), json!("db"));
                if let Some(t) = tier {
                    comp.insert("tier".into(), json!(t));
                }
                let extra = if replicas > 1.0 { format!("; {} replica pod{} modelled as read replicas", js_num(replicas - 1.0), if replicas > 2.0 { "s" } else { "" }) } else { String::new() };
                assumptions.push(format!("{}: database ({}){}", ref_of(d), why, extra));
                // Postgres or MySQL pods elect no new primary on their own: that takes an operator
                if replicas > 1.0 && single_primary(&image) {
                    match ha_operator(&image, containers, o(o(spec.get("template")).get("metadata"))) {
                        Some(op) => assumptions.push(format!("{}: {} detected — automatic failover assumed (failoverS default, 60 s)", ref_of(d), op)),
                        None => {
                            comp.insert("failoverS".into(), json!(MANUAL_FAILOVER_S));
                            assumptions.push(format!("{}: a plain StatefulSet has no automatic failover (no CloudNativePG, Patroni or Zalando operator found) — writes fail until someone promotes a replica by hand, modelled as failoverS {} s (30 min, a guess)", ref_of(d), js_num(MANUAL_FAILOVER_S)));
                        }
                    }
                }
            }
            Some(("cache", why)) => {
                comp.insert("kind".into(), json!("cache"));
                comp.insert("hitRate".into(), json!(0.85));
                if let Some(t) = tier {
                    comp.insert("tier".into(), json!(t));
                }
                assumptions.push(format!("{}: cache ({}), hit rate assumed 85%", ref_of(d), why));
            }
            Some((k, why)) => {
                comp.insert("kind".into(), json!(k));
                if *k == "llm" {
                    comp.insert("instances".into(), n(replicas));
                }
                assumptions.push(format!("{}: {} ({})", ref_of(d), k, why));
            }
            None => {
                comp.insert("kind".into(), json!("server"));
                comp.insert("instances".into(), n(replicas));
                if let Some(t) = tier {
                    comp.insert("tier".into(), json!(t));
                }
                if let Some(rt) = runtime_of(&image) {
                    comp.insert("runtime".into(), json!(rt));
                }
            }
        }
        if nm != id {
            comp.insert("name".into(), json!(nm));
        }
        let is_db = cls.as_ref().map(|c| c.0) == Some("db");
        components.push(comp);
        mapped.push(Mapped { resource: Some(ref_of(d)), component: id.clone() });
        workloads.push(Workload { id: id.clone(), name: nm.clone(), kind_name: kind.clone(), labels: o(o(o(spec.get("template")).get("metadata")).get("labels")), containers, comp: components.len() - 1 });
        if is_db && replicas > 1.0 {
            let mut i = 1.0;
            while i < replicas {
                let rid = uid(&format!("{}-replica-{}", nm, js_num(i)), &mut used);
                let mut r = Obj::new();
                r.insert("id".into(), json!(rid));
                r.insert("kind".into(), json!("replica"));
                if let Some(t) = tier {
                    r.insert("tier".into(), json!(t));
                }
                components.push(r);
                edges.push((id.clone(), rid));
                i += 1.0;
            }
        }
    }
    if workloads.is_empty() {
        return Err("no workloads found (Deployment, StatefulSet, DaemonSet…)".into());
    }

    // ---- services: name → workload ----
    let mut svc_target: IndexMap<String, usize> = IndexMap::new();
    let mut lb_services: Vec<(String, usize)> = vec![];
    let matches = |sel: &Obj, labels: &Obj| !sel.is_empty() && sel.iter().all(|(k, v)| same(labels.get(k), v));
    for d in &docs {
        if kind_str(d) != "Service" {
            continue;
        }
        let spec = o(d.get("spec"));
        let w = match workloads.iter().position(|x| matches(o(spec.get("selector")), x.labels)) {
            Some(w) => w,
            None => {
                skipped.push(ref_of(d));
                continue;
            }
        };
        let nm = s(meta(d).get("name"));
        svc_target.insert(nm.clone(), w);
        let ty = spec.get("type").and_then(|t| t.as_str());
        if ty == Some("LoadBalancer") || ty == Some("NodePort") {
            lb_services.push((nm, w));
        }
    }
    // the workload's own name also resolves (common in compose-style setups)
    for (i, w) in workloads.iter().enumerate() {
        if !svc_target.contains_key(&w.name) {
            svc_target.insert(w.name.clone(), i);
        }
    }

    // ---- HPAs → autoscale ----
    for d in &docs {
        if kind_str(d) != "HorizontalPodAutoscaler" {
            continue;
        }
        let spec = o(d.get("spec"));
        let target = s(o(spec.get("scaleTargetRef")).get("name"));
        let w = match workloads.iter().position(|x| x.name == target) {
            Some(w) if components[workloads[w].comp].get("kind").and_then(|k| k.as_str()) == Some("server") => w,
            _ => {
                skipped.push(ref_of(d));
                continue;
            }
        };
        let min = jmax(1.0, number(or(spec.get("minReplicas"), Some(&json!(1)))));
        let max_v = or(spec.get("maxReplicas"), None);
        let max = jmax(min, if max_v.is_none() { min } else { number(max_v) });
        let found = a(spec.get("metrics")).iter().map(|m| {
            let r = o(o(Some(m)).get("resource"));
            or(o(r.get("target")).get("averageUtilization"), r.get("targetAverageUtilization"))
        });
        let mut util_v: Option<&Value> = None;
        for x in found {
            if matches!(x, Some(Value::Number(_))) {
                util_v = x;
                break;
            }
        }
        let util_v = or(or(util_v, spec.get("targetCPUUtilizationPercentage")), None);
        let util = if util_v.is_none() { 60.0 } else { number(util_v) } / 100.0;
        let c = &mut components[workloads[w].comp];
        let mut auto = Obj::new();
        auto.insert("min".into(), n(min));
        auto.insert("max".into(), n(max));
        auto.insert("targetUtil".into(), n(jmin(0.95, jmax(0.1, util))));
        auto.insert("warmupS".into(), json!(20));
        auto.insert("cooldownS".into(), json!(300));
        c.insert("autoscale".into(), Value::Object(auto));
        let inst = match c.get("instances") {
            None | Some(Value::Null) => min,
            Some(v) => v.as_f64().unwrap_or(f64::NAN),
        };
        c.insert("instances".into(), n(jmin(max, jmax(min, inst))));
        assumptions.push(format!("{}: autoscaling {}–{} at {}% CPU; pod warm-up assumed 20 s (add 60–120 s if the cluster must add a node), scale-in after 300 s", ref_of(d), js_num(min), js_num(max), js_num(js_round(util * 100.0))));
    }

    // ---- entry points ----
    let mut entries: Vec<String> = vec![];
    for d in &docs {
        let k = kind_str(d);
        if k != "Ingress" && k != "HTTPRoute" {
            continue;
        }
        let mut backends: IndexSet<String> = IndexSet::new();
        let spec = o(d.get("spec"));
        if k == "Ingress" {
            let def = s(o(o(spec.get("defaultBackend")).get("service")).get("name"));
            let def = if def.is_empty() { s(o(spec.get("backend")).get("serviceName")) } else { def };
            if !def.is_empty() {
                backends.insert(def);
            }
            for r in a(spec.get("rules")) {
                for p in a(o(o(Some(r)).get("http")).get("paths")) {
                    let b = o(o(Some(p)).get("backend"));
                    let x = s(o(b.get("service")).get("name"));
                    backends.insert(if x.is_empty() { s(b.get("serviceName")) } else { x });
                }
            }
        } else {
            for r in a(spec.get("rules")) {
                for b in a(o(Some(r)).get("backendRefs")) {
                    backends.insert(s(o(Some(b)).get("name")));
                }
            }
        }
        let mut targets: IndexSet<usize> = IndexSet::new();
        for b in &backends {
            if let Some(t) = svc_target.get(b) {
                targets.insert(*t);
            }
        }
        if targets.is_empty() {
            skipped.push(ref_of(d));
            continue;
        }
        let mname = s(meta(d).get("name"));
        let id = uid(if mname.is_empty() { "ingress" } else { &mname }, &mut used);
        let mut c = Obj::new();
        c.insert("id".into(), json!(id));
        c.insert("kind".into(), json!("lb"));
        if id != mname {
            c.insert("name".into(), json!(mname));
        }
        components.push(c);
        mapped.push(Mapped { resource: Some(ref_of(d)), component: id.clone() });
        entries.push(id.clone());
        for t in targets {
            edges.push((id.clone(), workloads[t].id.clone()));
        }
    }
    if entries.is_empty() {
        for (lname, w) in &lb_services {
            let id = uid(&format!("{}-lb", lname), &mut used);
            let mut c = Obj::new();
            c.insert("id".into(), json!(id));
            c.insert("kind".into(), json!("lb"));
            c.insert("name".into(), json!(lname));
            components.push(c);
            entries.push(id.clone());
            edges.push((id, workloads[*w].id.clone()));
            assumptions.push(format!("Service/{}: type LoadBalancer — modelled as the entry load balancer", lname));
        }
    }
    if entries.is_empty() {
        if let Some(w) = workloads.iter().find(|w| kind_str(&components[w.comp]) == "server") {
            entries.push(w.id.clone());
            assumptions.push(format!("no Ingress or LoadBalancer Service — users are assumed to reach {} directly", w.name));
        }
    }

    // ---- call edges from references to other services ----
    let mut names: Vec<String> = svc_target.keys().cloned().collect();
    names.sort_by(|x, y| y.encode_utf16().count().cmp(&x.encode_utf16().count()));
    for wi in 0..workloads.len() {
        let w = &workloads[wi];
        let k = kind_str(&components[w.comp]);
        if k != "server" && k != "worker" && k != "lb" && k != "llm" {
            continue;
        }
        let parts: Vec<Value> = w
            .containers
            .iter()
            .map(|c| {
                let c = o(Some(c));
                let mut m = Obj::new();
                for key in ["env", "args", "command", "envFrom"] {
                    if let Some(v) = c.get(key) {
                        m.insert(key.into(), v.clone());
                    }
                }
                Value::Object(m)
            })
            .collect();
        let blob = js_stringify(&Value::Array(parts)).to_lowercase();
        let mut hits: IndexSet<usize> = IndexSet::new();
        for nm in &names {
            let t = svc_target[nm];
            if t == wi {
                continue;
            }
            if mentions(&blob, &nm.to_lowercase()) {
                hits.insert(t);
            }
        }
        for t in hits {
            let (from, to) = (workloads[wi].id.clone(), workloads[t].id.clone());
            if edges.iter().any(|(x, y)| *x == from && *y == to) {
                continue;
            }
            edges.push((from, to));
            assumptions.push(format!("{}/{} → {}: inferred from a reference in its env / args", workloads[wi].kind_name, workloads[wi].name, workloads[t].name));
        }
    }
    // services that consume from a broker are workers behind it
    let snapshot = edges.clone();
    let find = |components: &Vec<Obj>, id: &str| components.iter().position(|c| c.get("id").and_then(|x| x.as_str()) == Some(id));
    for (from, to) in snapshot {
        let src = find(&components, &from);
        let dst = find(&components, &to);
        let (src, dst) = match (src, dst) {
            (Some(s), Some(d)) => (s, d),
            _ => continue,
        };
        if kind_str(&components[src]) != "server" || kind_str(&components[dst]) != "queue" {
            continue;
        }
        let src_id = from.clone();
        let dst_id = to.clone();
        let consumers: Vec<usize> = (0..workloads.len())
            .filter(|&wi| {
                let w = &workloads[wi];
                kind_str(&components[w.comp]) == "server" && w.id != src_id && edges.iter().any(|(x, y)| *x == w.id && *y == dst_id) && !entries.iter().any(|e| edges.iter().any(|(x, y)| x == e && *y == w.id))
            })
            .collect();
        for c in consumers {
            let ci = workloads[c].comp;
            components[ci].insert("kind".into(), json!("worker"));
            if let Some(i) = edges.iter().position(|(x, y)| *x == workloads[c].id && *y == dst_id) {
                edges[i] = (dst_id.clone(), workloads[c].id.clone());
            }
            assumptions.push(format!("{}/{}: not reachable from an entry point and connected to {} — modelled as a queue consumer (worker)", workloads[c].kind_name, workloads[c].name, dst_id));
        }
    }
    // caches front the database they are next to (cache-aside)
    let caches: Vec<String> = components.iter().filter(|c| kind_str(c) == "cache").map(|c| s(c.get("id"))).collect();
    let dbs: Vec<String> = components.iter().filter(|c| kind_str(c) == "db").map(|c| s(c.get("id"))).collect();
    if caches.len() == 1 && !dbs.is_empty() {
        let cache = &caches[0];
        let mut i = edges.len();
        while i > 0 {
            i -= 1;
            let (x, y) = edges[i].clone();
            let dst_db = find(&components, &y).map(|d| kind_str(&components[d]) == "db").unwrap_or(false);
            if dst_db && edges.iter().any(|(p, q)| *p == x && q == cache) {
                edges.remove(i);
            }
        }
        for db in &dbs {
            if !edges.iter().any(|(x, y)| x == cache && y == db) {
                edges.push((cache.clone(), db.clone()));
            }
        }
        assumptions.push(format!("{}: read-through in front of {} (cache-aside) — remove the cache → db link if your services read the database directly", cache, dbs.join(", ")));
    } else if caches.len() > 1 {
        // several caches: each fronts the databases its own callers also call
        for cache in &caches {
            let callers: Vec<String> = edges.iter().filter(|(_, y)| y == cache).map(|(x, _)| x.clone()).collect();
            let mut near: Vec<String> = vec![];
            for (x, y) in &edges {
                if callers.contains(x) && dbs.contains(y) && !near.contains(y) {
                    near.push(y.clone());
                }
            }
            if near.is_empty() {
                continue;
            }
            edges.retain(|(x, y)| !(callers.contains(x) && near.contains(y)));
            for db in &near {
                edges.push((cache.clone(), db.clone()));
            }
            assumptions.push(format!("{}: read-through in front of {} (cache-aside) — remove the cache → db link if your services read the database directly", cache, near.join(", ")));
        }
    }

    // a cache with nothing behind it is the store itself (a cart in Valkey, sessions in Redis)
    for c in components.iter_mut() {
        if kind_str(c) != "cache" {
            continue;
        }
        let id = s(c.get("id"));
        if edges.iter().any(|(x, _)| *x == id) {
            continue;
        }
        c.insert("kind".into(), json!("db"));
        c.shift_remove("hitRate");
        let name = c.get("name").map(|x| s(Some(x))).unwrap_or_else(|| id.clone());
        assumptions.retain(|x| !(x.contains(&format!("/{}: cache (", name)) && x.ends_with("hit rate assumed 85%")));
        assumptions.push(format!("{}: nothing behind it, so it is the data store itself — modelled as a database", id));
    }

    for d in &docs {
        let k = kind_of(d);
        if !WORKLOADS.contains(&k.as_str()) && !["Service", "Ingress", "HTTPRoute", "Gateway", "HorizontalPodAutoscaler"].contains(&k.as_str()) && !SKIP.contains(&k.as_str()) {
            skipped.push(ref_of(d));
        }
    }

    let mut comps: Vec<Value> = vec![json!({ "id": "users", "kind": "client" })];
    comps.extend(components.into_iter().map(Value::Object));
    let mut conns: Vec<Value> = entries.iter().map(|e| json!(["users", e])).collect();
    conns.extend(edges.into_iter().map(|(x, y)| json!([x, y])));
    let spec = json!({ "version": 1, "name": name.unwrap_or("Kubernetes import"), "components": comps, "connections": conns });
    Ok(ImportResult { spec, assumptions, skipped, mapped })
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(x)) => x.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(false),
        Some(Value::String(x)) => !x.is_empty(),
        _ => true,
    }
}

/// `${d.kind}` in a template string
fn js_kind(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::String(x)) => x.clone(),
        Some(Value::Number(x)) => js_num(x.as_f64().unwrap_or(f64::NAN)),
        Some(Value::Bool(b)) => b.to_string(),
        Some(_) => "[object Object]".into(),
    }
}
