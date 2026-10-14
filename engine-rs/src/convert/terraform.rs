//! Terraform (`terraform show -json`, a state or a saved plan) → architecture spec
//! (src/spec/terraform.ts). The call graph comes from real references where they exist (target-group
//! ARNs, CloudFront origins, API Gateway integrations, Lambda event sources) and from conventional
//! heuristics otherwise; every heuristic is reported in `assumptions`.

use super::{a, jmax, jmin, n, o, slug, ImportResult, Mapped, Obj};
use crate::math::js_num;
use indexmap::{IndexMap, IndexSet};
use serde_json::{json, Value};

fn str_of(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(x)) => x.clone(),
        _ => String::new(),
    }
}
fn num(v: Option<&Value>, d: f64) -> f64 {
    match v {
        Some(Value::Number(x)) => x.as_f64().filter(|f| f.is_finite()).unwrap_or(d),
        _ => d,
    }
}

struct Res<'a> {
    address: String,
    has_address: bool,
    ty: String,
    name: String,
    index: Option<&'a Value>,
    values: &'a Obj,
}

fn collect(root: &Value) -> Result<Vec<Res<'_>>, String> {
    let pick = |k: &str| root.get(k).and_then(|x| x.get("root_module"));
    let m = match pick("planned_values") {
        None | Some(Value::Null) => pick("values"),
        x => x,
    };
    let m = match m {
        Some(x) if !matches!(x, Value::Null | Value::Bool(false)) => x,
        _ => return Err("not a `terraform show -json` document (no values.root_module / planned_values.root_module)".into()),
    };
    let mut out = vec![];
    fn walk<'a>(m: &'a Value, out: &mut Vec<Res<'a>>) {
        for x in a(m.get("resources")) {
            if x.get("mode").and_then(|v| v.as_str()) == Some("data") {
                continue;
            }
            out.push(Res {
                address: tpl(x.get("address")),
                has_address: x.get("address").is_some(),
                ty: tpl(x.get("type")),
                name: tpl(x.get("name")),
                index: x.get("index"),
                values: o(x.get("values")),
            });
        }
        for c in a(m.get("child_modules")) {
            walk(c, out);
        }
    }
    walk(m, &mut out);
    Ok(out)
}

/// `${x}`
fn tpl(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::String(x)) => x.clone(),
        Some(Value::Number(x)) => js_num(x.as_f64().unwrap_or(f64::NAN)),
        Some(Value::Bool(b)) => b.to_string(),
        Some(_) => "[object Object]".into(),
    }
}

/// instance size → tier: up to large = S, xlarge = M, 2xlarge and above = L
fn tier_of(instance_type: &str) -> &'static str {
    let size = instance_type.split('.').next_back().unwrap_or("");
    let digits = size.strip_suffix("xlarge").map(|d| !d.is_empty() && d.bytes().all(|c| c.is_ascii_digit())).unwrap_or(false);
    if digits || size == "metal" {
        "L"
    } else if size == "xlarge" {
        "M"
    } else {
        "S"
    }
}

fn is_gpu(t: &str) -> bool {
    let bare = t.strip_prefix("db.").or_else(|| t.strip_prefix("cache.")).or_else(|| t.strip_prefix("ml.")).unwrap_or(t);
    for p in ["g", "p", "inf", "trn"] {
        if let Some(rest) = bare.strip_prefix(p) {
            if rest.bytes().next().map(|c| c.is_ascii_digit()).unwrap_or(false) {
                return true;
            }
        }
    }
    false
}

fn lambda_runtime(rt: &str) -> Option<&'static str> {
    if rt.starts_with("nodejs") {
        Some("node")
    } else if rt.starts_with("python") {
        Some("python")
    } else if rt.starts_with("java") {
        Some("java")
    } else if rt.starts_with("go") {
        Some("go")
    } else {
        None
    }
}

const REFERENCE_TYPES: [&str; 16] = [
    "aws_lb_target_group",
    "aws_alb_target_group",
    "aws_lb_listener",
    "aws_alb_listener",
    "aws_lb_listener_rule",
    "aws_lb_target_group_attachment",
    "aws_launch_template",
    "aws_launch_configuration",
    "aws_lambda_event_source_mapping",
    "aws_lambda_permission",
    "aws_apigatewayv2_integration",
    "aws_apigatewayv2_route",
    "aws_apigatewayv2_stage",
    "aws_api_gateway_integration",
    "aws_api_gateway_resource",
    "aws_api_gateway_method",
];

struct State {
    components: Vec<Obj>,
    /// a replica's source, by component index
    src: IndexMap<usize, String>,
    edges: IndexSet<String>,
    mapped: Vec<Mapped>,
    by_arn: IndexMap<String, String>,
    ids: IndexSet<String>,
}

impl State {
    /// the component, its keys first and `id` last, as `{ ...c, id }` writes it
    fn add(&mut self, r: &Res, c: Vec<(&str, Value)>) -> String {
        let mut id = slug(&format!("{}{}", r.name, match r.index {
            None => String::new(),
            Some(i) => format!("-{}", tpl(Some(i))),
        }));
        let suffix = r.ty.split('_').next_back().unwrap_or("").to_string();
        while self.ids.contains(&id) {
            id = format!("{}-{}", id, suffix);
        }
        self.ids.insert(id.clone());
        let mut comp = Obj::new();
        for (k, v) in c {
            comp.insert(k.into(), v);
        }
        comp.insert("id".into(), json!(id));
        self.components.push(comp);
        self.mapped.push(Mapped { resource: if r.has_address { Some(r.address.clone()) } else { None }, component: id.clone() });
        for k in ["arn", "id", "dns_name", "domain_name", "bucket_regional_domain_name", "api_endpoint", "name", "url", "invoke_arn"] {
            let v = str_of(r.values.get(k));
            if !v.is_empty() {
                self.by_arn.insert(v, id.clone());
            }
        }
        id
    }
    fn connect(&mut self, a: Option<&str>, b: Option<&str>) {
        if let (Some(a), Some(b)) = (a, b) {
            if !a.is_empty() && !b.is_empty() && a != b {
                self.edges.insert(format!("{}→{}", a, b));
            }
        }
    }
    fn find(&self, r: &str) -> Option<String> {
        if r.is_empty() {
            return None;
        }
        if let Some(v) = self.by_arn.get(r) {
            return Some(v.clone());
        }
        self.by_arn.iter().find(|(k, _)| !k.is_empty() && (r.contains(k.as_str()) || k.contains(r))).map(|(_, v)| v.clone())
    }
    fn has_in(&self, id: &str) -> bool {
        let t = format!("→{}", id);
        self.edges.iter().any(|e| e.ends_with(&t))
    }
    fn has_out(&self, id: &str) -> bool {
        let t = format!("{}→", id);
        self.edges.iter().any(|e| e.starts_with(&t))
    }
    fn kind(&self, i: usize) -> &str {
        self.components[i].get("kind").and_then(|k| k.as_str()).unwrap_or("")
    }
}

pub fn import_terraform(doc: &Value, name: Option<&str>) -> Result<ImportResult, String> {
    let resources = collect(doc)?;
    let mut st = State { components: vec![], src: IndexMap::new(), edges: IndexSet::new(), mapped: vec![], by_arn: IndexMap::new(), ids: IndexSet::new() };
    let mut assumptions: Vec<String> = vec![];
    let mut skipped: Vec<String> = vec![];

    // launch templates / configurations: instance types for ASGs
    let mut lt_type: IndexMap<String, String> = IndexMap::new();
    for r in resources.iter().filter(|x| x.ty == "aws_launch_template" || x.ty == "aws_launch_configuration") {
        let t = str_of(r.values.get("instance_type"));
        for k in ["id", "name", "arn"] {
            let v = str_of(r.values.get(k));
            if !v.is_empty() {
                lt_type.insert(v, t.clone());
            }
        }
    }

    // ---- pass 1: components ----
    let mut entry: Vec<String> = vec![];
    let mut compute: Vec<String> = vec![];
    let mut dbs: Vec<String> = vec![];
    let mut caches: Vec<String> = vec![];
    let mut queues: Vec<String> = vec![];
    for r in &resources {
        let v = r.values;
        match r.ty.as_str() {
            "aws_cloudfront_distribution" => {
                entry.push(st.add(r, vec![("kind", json!("cdn")), ("hitRate", json!(0.6))]));
                assumptions.push(format!("{}: CDN hit rate assumed 60% — set hitRate from CloudFront metrics", r.address));
            }
            "aws_lb" | "aws_alb" => {
                let internal = v.get("internal") == Some(&Value::Bool(true));
                let id = st.add(r, vec![("kind", json!("lb"))]);
                if !internal {
                    entry.push(id);
                }
            }
            "aws_apigatewayv2_api" | "aws_api_gateway_rest_api" => {
                entry.push(st.add(r, vec![("kind", json!("gateway")), ("limit", json!(10000))]));
                assumptions.push(format!("{}: gateway rate limit assumed 10,000 req/s (AWS default account throttle)", r.address));
            }
            "aws_autoscaling_group" => {
                let lt = o(a(v.get("launch_template")).first());
                let ty = lt_type
                    .get(&str_of(lt.get("id")))
                    .or_else(|| lt_type.get(&str_of(lt.get("name"))))
                    .or_else(|| lt_type.get(&str_of(v.get("launch_configuration"))))
                    .cloned()
                    .unwrap_or_default();
                let count = num(v.get("desired_capacity"), num(v.get("min_size"), 1.0));
                let min = jmax(1.0, num(v.get("min_size"), count));
                let max = jmax(min, num(v.get("max_size"), count));
                let warmup = num(v.get("default_instance_warmup"), num(v.get("health_check_grace_period"), 120.0));
                let scales = max > min;
                let gpu = is_gpu(&ty);
                let mut c = vec![("kind", json!(if gpu { "llm" } else { "server" })), ("instances", n(jmax(1.0, count)))];
                if !ty.is_empty() && !gpu {
                    c.push(("tier", json!(tier_of(&ty))));
                }
                if scales {
                    c.push(("autoscale", json!({ "min": n(min), "max": n(jmin(500.0, max)), "targetUtil": 0.6, "warmupS": n(jmin(900.0, warmup)), "cooldownS": 300 })));
                }
                compute.push(st.add(r, c));
                if ty.is_empty() {
                    assumptions.push(format!("{}: instance type not resolvable — sized as S", r.address));
                }
                if scales {
                    assumptions.push(format!("{}: autoscaling {}–{} assumed target-tracking at 60% CPU, {} s warm-up, 300 s scale-in cooldown — check your scaling policy", r.address, js_num(min), js_num(max), js_num(jmin(900.0, warmup))));
                }
            }
            "aws_ecs_service" => {
                compute.push(st.add(r, vec![("kind", json!("server")), ("instances", n(jmax(1.0, num(v.get("desired_count"), 1.0))))]));
                assumptions.push(format!("{}: ECS task capacity uses the API-server default (250 req/s per task) — calibrate `capacity`", r.address));
            }
            "aws_instance" => {
                let ty = str_of(v.get("instance_type"));
                let c = if is_gpu(&ty) { vec![("kind", json!("llm"))] } else { vec![("kind", json!("server")), ("tier", json!(tier_of(&ty)))] };
                compute.push(st.add(r, c));
            }
            "aws_lambda_function" => {
                let rt = lambda_runtime(&str_of(v.get("runtime")));
                let conc = num(v.get("reserved_concurrent_executions"), -1.0);
                let mut c = vec![("kind", json!("function"))];
                if let Some(rt) = rt {
                    c.push(("runtime", json!(rt)));
                }
                if conc > 0.0 {
                    c.push(("limit", n(conc * 10.0)));
                }
                compute.push(st.add(r, c));
            }
            "aws_db_instance" => {
                let cls = str_of(v.get("instance_class"));
                let src = str_of(v.get("replicate_source_db"));
                let id = st.add(r, vec![("kind", json!(if src.is_empty() { "db" } else { "replica" })), ("tier", json!(tier_of(&cls)))]);
                if !src.is_empty() {
                    st.src.insert(st.components.len() - 1, src);
                } else {
                    dbs.push(id);
                }
                if v.get("multi_az") == Some(&Value::Bool(true)) {
                    assumptions.push(format!("{}: Multi-AZ standby is not modelled as a separate node (it doubles RDS cost in reality)", r.address));
                }
            }
            "aws_rds_cluster" => dbs.push(st.add(r, vec![("kind", json!("db"))])),
            "aws_rds_cluster_instance" => {
                // writer is represented by the cluster; extra instances become replicas
                st.add(r, vec![("kind", json!("replica")), ("tier", json!(tier_of(&str_of(v.get("instance_class")))))]);
                st.src.insert(st.components.len() - 1, str_of(v.get("cluster_identifier")));
            }
            "aws_elasticache_replication_group" | "aws_elasticache_cluster" => {
                caches.push(st.add(r, vec![("kind", json!("cache")), ("tier", json!(tier_of(&str_of(v.get("node_type"))))), ("hitRate", json!(0.85))]));
                assumptions.push(format!("{}: cache hit rate assumed 85% — set hitRate from CacheHits / (CacheHits + CacheMisses)", r.address));
            }
            "aws_sqs_queue" => queues.push(st.add(r, vec![("kind", json!("queue"))])),
            "aws_s3_bucket" => {
                // only buckets that serve traffic (CloudFront origins) are added later
                let d = str_of(v.get("bucket_regional_domain_name"));
                let k = if d.is_empty() { str_of(v.get("bucket")) } else { d };
                st.by_arn.insert(k, format!("s3:{}", str_of(v.get("bucket"))));
            }
            t => {
                if t.starts_with("aws_") && !REFERENCE_TYPES.contains(&t) {
                    skipped.push(r.address.clone());
                }
            }
        }
    }

    // ---- pass 2: real references ----
    let mut tg_targets: IndexMap<String, Vec<Option<String>>> = IndexMap::new();
    for r in &resources {
        let v = r.values;
        if r.ty == "aws_autoscaling_group" {
            for tg in a(v.get("target_group_arns")) {
                let t = st.find(&str_of(v.get("arn"))).or_else(|| st.find(&str_of(v.get("name"))));
                tg_targets.entry(tpl(Some(tg))).or_default().push(t);
            }
        }
        if r.ty == "aws_ecs_service" {
            for lb in a(v.get("load_balancer")) {
                let t = st.find(&str_of(v.get("id"))).or_else(|| st.find(&str_of(v.get("name"))));
                tg_targets.entry(str_of(o(Some(lb)).get("target_group_arn"))).or_default().push(t);
            }
        }
        if r.ty == "aws_lb_target_group_attachment" {
            let t = st.find(&str_of(v.get("target_id")));
            let e = tg_targets.entry(str_of(v.get("target_group_arn"))).or_default();
            e.push(t);
            e.retain(|x| x.as_deref().map(|s| !s.is_empty()).unwrap_or(false));
        }
    }
    let mut tg_owner: IndexMap<String, String> = IndexMap::new();
    for r in resources.iter().filter(|x| x.ty == "aws_lb_listener" || x.ty == "aws_alb_listener") {
        let lb = st.find(&str_of(r.values.get("load_balancer_arn")));
        for act in a(r.values.get("default_action")) {
            let tg = str_of(o(Some(act)).get("target_group_arn"));
            if let Some(lb) = lb.as_ref().filter(|_| !tg.is_empty()) {
                tg_owner.insert(tg, lb.clone());
            }
        }
    }
    for (tg, targets) in &tg_targets {
        let lbs: Vec<usize> = (0..st.components.len()).filter(|&i| st.kind(i) == "lb").collect();
        let lb = tg_owner.get(tg).cloned().or_else(|| if lbs.len() == 1 { st.components[lbs[0]].get("id").and_then(|x| x.as_str()).map(String::from) } else { None });
        for t in targets {
            st.connect(lb.as_deref(), t.as_deref());
        }
    }
    for r in resources.iter().filter(|x| x.ty == "aws_cloudfront_distribution") {
        let cdn = st.find(&str_of(r.values.get("arn"))).or_else(|| st.find(&str_of(r.values.get("id"))));
        for org in a(r.values.get("origin")) {
            let dn = str_of(o(Some(org)).get("domain_name"));
            let mut target = st.find(&dn);
            if let Some(bucket) = target.as_ref().and_then(|t| t.strip_prefix("s3:")).map(String::from) {
                let id = slug(&bucket);
                if !st.ids.contains(&id) {
                    st.ids.insert(id.clone());
                    let mut c = Obj::new();
                    c.insert("id".into(), json!(id));
                    c.insert("kind".into(), json!("storage"));
                    st.components.push(c);
                    st.mapped.push(Mapped { resource: Some(format!("aws_s3_bucket ({})", bucket)), component: id.clone() });
                }
                target = Some(id);
            }
            match target {
                Some(t) => st.connect(cdn.as_deref(), Some(&t)),
                None => assumptions.push(format!("{}: origin {} not found in this state", r.address, dn)),
            }
        }
    }
    for r in resources.iter().filter(|x| x.ty == "aws_apigatewayv2_integration" || x.ty == "aws_api_gateway_integration") {
        let api = st.find(&str_of(r.values.get("api_id"))).or_else(|| st.find(&str_of(r.values.get("rest_api_id"))));
        let target = st.find(&str_of(r.values.get("integration_uri"))).or_else(|| st.find(&str_of(r.values.get("uri"))));
        st.connect(api.as_deref(), target.as_deref());
    }
    for r in resources.iter().filter(|x| x.ty == "aws_lambda_event_source_mapping") {
        let from = st.find(&str_of(r.values.get("event_source_arn")));
        let to = st.find(&str_of(r.values.get("function_name")));
        st.connect(from.as_deref(), to.as_deref());
    }
    let srcs: Vec<(usize, String)> = st.src.iter().map(|(i, s)| (*i, s.clone())).collect();
    for (i, src) in srcs {
        if st.kind(i) == "replica" && !src.is_empty() {
            let from = st.find(&src).or_else(|| dbs.first().cloned());
            let id = st.components[i].get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
            st.connect(from.as_deref(), Some(&id));
        }
    }

    // ---- pass 3: heuristics ----
    st.components.insert(0, {
        let mut c = Obj::new();
        c.insert("id".into(), json!("users"));
        c.insert("kind".into(), json!("client"));
        c
    });
    st.ids.insert("users".into());
    let entries: Vec<String> = entry.iter().filter(|id| !st.has_in(id)).cloned().collect();
    let roots: Vec<String> = if !entries.is_empty() { entries.clone() } else { compute.iter().filter(|id| !st.has_in(id)).cloned().collect() };
    for id in &roots {
        st.connect(Some("users"), Some(id));
    }
    if entries.is_empty() {
        assumptions.push("no public entry point (CloudFront / internet-facing LB / API Gateway) found — users call compute directly".into());
    }
    for id in &entries {
        if st.has_out(id) {
            continue;
        }
        let free: Vec<String> = compute.iter().filter(|c| !st.has_in(c)).cloned().collect();
        for t in &free {
            st.connect(Some(id), Some(t));
        }
        let routes: Vec<String> = compute.iter().filter(|c| !st.has_in(c) || st.edges.contains(&format!("{}→{}", id, c))).cloned().collect();
        let routes = if routes.is_empty() { "nothing".to_string() } else { routes.join(", ") };
        assumptions.push(format!("{}: routes to {} (no explicit target found)", id, routes));
    }
    let consumers: IndexSet<String> = st.edges.iter().filter(|e| queues.iter().any(|q| e.starts_with(&format!("{}→", q)))).map(|e| e.split('→').nth(1).unwrap_or("").to_string()).collect();
    let web: Vec<String> = compute.iter().filter(|c| !consumers.contains(*c)).cloned().collect();
    for c in &compute {
        if caches.len() == 1 && !dbs.is_empty() {
            st.connect(Some(c), Some(&caches[0]));
            for d in &dbs {
                st.connect(Some(&caches[0]), Some(d));
            }
        } else {
            for d in &dbs {
                st.connect(Some(c), Some(d));
            }
        }
    }
    if !compute.is_empty() && !dbs.is_empty() {
        assumptions.push(if caches.len() == 1 { format!("every service reads through {} (cache-aside) into {}", caches[0], dbs.join(", ")) } else { format!("every service calls {} directly", dbs.join(", ")) });
    }
    for q in &queues {
        for w in &web {
            st.connect(Some(w), Some(q));
        }
        if !web.is_empty() {
            assumptions.push(format!("{}: produced by {} (Terraform has no producer references)", q, web.join(", ")));
        }
    }

    let known: IndexSet<String> = st.components.iter().map(|c| c.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string()).collect();
    let connections: Vec<Value> = st
        .edges
        .iter()
        .map(|e| e.split('→').map(String::from).collect::<Vec<_>>())
        .filter(|p| known.contains(&p[0]) && p.get(1).map(|b| known.contains(b)).unwrap_or(false))
        .map(|p| json!(p))
        .collect();
    let mut seen: IndexSet<String> = IndexSet::new();
    for x in assumptions {
        seen.insert(x);
    }
    let spec = json!({ "version": 1, "name": name.unwrap_or("Imported from Terraform"), "pricing": "aws-us-east-1", "components": st.components.into_iter().map(Value::Object).collect::<Vec<_>>(), "connections": connections });
    Ok(ImportResult { spec, assumptions: seen.into_iter().collect(), skipped, mapped: st.mapped })
}
