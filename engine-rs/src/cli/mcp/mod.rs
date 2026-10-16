//! The MCP server (mcp/server.ts), natively: newline-delimited JSON-RPC over stdio. What the server
//! says about itself (initialize, tools, prompts, resources) is recorded from the TypeScript server
//! (manifest.json, scripts/mcp-manifest.ts); every tool answers from the engine here.

mod serve;

use crate::cli::agent;
use crate::cli::reports::{arr, g, s};
use crate::cli::util::{pretty, to_json};
use serde_json::{json, Map as JMap, Value};
use std::io::{BufRead, Write};

const SUPPORTED: [&str; 5] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
const LATEST: &str = "2025-11-25";
const CANVAS_URI: &str = "ui://hindcast/canvas.html";

fn manifest() -> Value {
    serde_json::from_str(include_str!("manifest.json")).unwrap_or(Value::Null)
}

fn app_url() -> String {
    std::env::var("HINDCAST_APP_URL").or_else(|_| std::env::var("BOTTLENECK_APP_URL")).unwrap_or_else(|_| "http://localhost:5173".into())
}

fn send(out: &mut impl Write, v: &Value) {
    let _ = out.write_all(crate::convert::js_stringify(v).as_bytes());
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}

fn result(id: &Value, r: Value) -> Value {
    let mut o = JMap::new();
    o.insert("result".into(), r);
    o.insert("jsonrpc".into(), json!("2.0"));
    o.insert("id".into(), id.clone());
    Value::Object(o)
}

fn error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn text(t: String) -> Value {
    json!({ "content": [{ "type": "text", "text": t }] })
}
fn as_json(v: &Value) -> Value {
    text(pretty(v))
}
fn fail(e: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": e }], "isError": true })
}

/// serve until stdin closes
pub fn serve() -> i32 {
    let m = manifest();
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                send(&mut out, &json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": format!("Parse error: {}", e) } }));
                continue;
            }
        };
        let mut sink: Vec<Value> = vec![];
        let reply = handle(&m, &msg, &|_| true, &mut sink);
        for n in sink {
            send(&mut out, &n);
        }
        if let Some(r) = reply {
            send(&mut out, &r);
        }
    }
    0
}

/// tools that only compute on what they are given — no workspace on disk, no paths, no cluster, no
/// browser: the ones a server reachable over the network offers by default (an allowlist, so a tool
/// added later is not exposed until it is judged safe)
pub fn network_safe(tool: &str) -> bool {
    matches!(tool, "list_components" | "validate_architecture" | "simulate" | "trace_request" | "compare_architectures" | "find_breaking_point" | "analyze" | "optimize_cost" | "audit_resilience" | "import_terraform" | "import_kubernetes" | "show_architecture" | "verify_design")
}

/// one JSON-RPC message: its reply (none for a notification); progress notifications go to `sink`
pub fn handle(m: &Value, msg: &Value, allow: &dyn Fn(&str) -> bool, sink: &mut Vec<Value>) -> Option<Value> {
    let id = msg.get("id").cloned()?; // a notification
    let method = msg.get("method").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let params = msg.get("params").cloned().unwrap_or(json!({}));
    Some(match method.as_str() {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(|x| x.as_str()).unwrap_or("");
            let mut r = JMap::new();
            r.insert("protocolVersion".into(), json!(if SUPPORTED.contains(&asked) { asked } else { LATEST }));
            for (k, v) in m["initialize"].as_object().cloned().unwrap_or_default() {
                r.insert(k, v);
            }
            result(&id, Value::Object(r))
        }
        "ping" => result(&id, json!({})),
        "tools/list" => result(&id, json!({ "tools": arr(m, &["tools"]).into_iter().filter(|t| allow(t["name"].as_str().unwrap_or(""))).collect::<Vec<_>>() })),
        "prompts/list" => result(&id, json!({ "prompts": m["prompts"] })),
        "resources/list" => result(&id, json!({ "resources": m["resources"] })),
        "resources/templates/list" => result(&id, json!({ "resourceTemplates": m["resourceTemplates"] })),
        "resources/read" => {
            let uri = s(&params, &["uri"]);
            if uri == CANVAS_URI {
                result(&id, json!({ "contents": [{ "uri": CANVAS_URI, "mimeType": "text/html;profile=mcp-app", "text": canvas_html(), "_meta": { "ui": { "csp": { "resourceDomains": [] } } } }] }))
            } else {
                error(&id, -32602, &format!("MCP error -32602: Resource {} not found", uri))
            }
        }
        "prompts/get" => prompt(&id, &params),
        "tools/call" => {
            let name = s(&params, &["name"]);
            if !allow(&name) {
                return Some(error(&id, -32602, &format!("MCP error -32602: Tool {} is not offered by this server (it works on local files or a cluster; run the server with --all-tools on a machine you trust)", name)));
            }
            let token = params.get("_meta").and_then(|x| x.get("progressToken")).cloned();
            result(&id, call_tool(m, &name, params.get("arguments"), token.as_ref(), sink))
        }
        _ => error(&id, -32601, "Method not found"),
    })
}

/// the MCP server over HTTP (Streamable HTTP, JSON responses): POST /mcp takes a JSON-RPC message or a
/// batch; GET /health answers ok. Loopback unless a host is given — and then only with a bearer token
/// (HINDCAST_MCP_TOKEN) unless `no_auth`; only network-safe tools unless `all_tools`. Host and Origin
/// are checked (DNS rebinding), requests are bounded in size, time and number at once
pub fn serve_http(host: &str, port: u16, all_tools: bool, no_auth: bool) -> i32 {
    let token = std::env::var("HINDCAST_MCP_TOKEN").ok().filter(|t| !t.is_empty());
    let loopback = matches!(host, "127.0.0.1" | "localhost" | "::1");
    if !loopback && token.is_none() && !no_auth {
        eprintln!("refusing to listen on {} without a token: set HINDCAST_MCP_TOKEN (or pass --no-auth on a network you trust)", host);
        return 1;
    }
    let listener = match std::net::TcpListener::bind((host, port)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("cannot listen on {}:{}: {}", host, port, e);
            return 1;
        }
    };
    eprintln!("hindcast MCP on http://{}:{}/mcp{}{}", host, port, if token.is_some() { " (bearer token required)" } else { "" }, if all_tools { " — all tools, local files included" } else { "" });
    let m = std::sync::Arc::new(manifest());
    let token = std::sync::Arc::new(token);
    let busy = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    for stream in listener.incoming().flatten() {
        let (m, token, busy) = (m.clone(), token.clone(), busy.clone());
        std::thread::spawn(move || {
            let _ = http_one(stream, &m, token.as_deref(), all_tools, loopback, &busy);
        });
    }
    0
}

const MAX_LINE: usize = 8 * 1024;
const MAX_HEADERS: usize = 64;
const MAX_BODY: usize = 4 << 20;
const MAX_BATCH: usize = 16;
const MAX_AT_ONCE: usize = 8;

fn ct_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// localhost by name or address, any port
fn is_local_host(h: &str) -> bool {
    let h = h.trim();
    let name = if let Some(rest) = h.strip_prefix('[') { rest.split(']').next().unwrap_or("") } else { h.rsplit_once(':').map(|x| x.0).unwrap_or(h) };
    matches!(name, "localhost" | "127.0.0.1" | "::1")
}

fn http_one(stream: std::net::TcpStream, m: &Value, token: Option<&str>, all_tools: bool, loopback: bool, busy: &std::sync::atomic::AtomicUsize) -> std::io::Result<()> {
    use std::io::Read;
    use std::sync::atomic::Ordering;
    stream.set_read_timeout(Some(std::time::Duration::from_secs(30)))?;
    stream.set_write_timeout(Some(std::time::Duration::from_secs(30)))?;
    let mut reader = std::io::BufReader::new(stream.try_clone()?);
    let mut read_line = |out: &mut String| -> std::io::Result<usize> {
        let n = (&mut reader).take(MAX_LINE as u64).read_line(out)?;
        if n >= MAX_LINE && !out.ends_with('\n') {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "line too long"));
        }
        Ok(n)
    };
    let mut line = String::new();
    read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let (method, path) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("").to_string());
    let (mut length, mut auth, mut host_h, mut origin) = (0usize, String::new(), String::new(), String::new());
    for _ in 0..=MAX_HEADERS {
        let mut h = String::new();
        if read_line(&mut h)? == 0 || h.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            match k.trim().to_ascii_lowercase().as_str() {
                "content-length" => length = v.trim().parse().unwrap_or(usize::MAX),
                "authorization" => auth = v.trim().to_string(),
                "host" => host_h = v.trim().to_string(),
                "origin" => origin = v.trim().to_string(),
                _ => {}
            }
        }
    }
    let mut out = stream;
    let reply = |out: &mut std::net::TcpStream, status: &str, ctype: &str, body: &str| -> std::io::Result<()> {
        write!(out, "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", status, ctype, body.len(), body)
    };
    let path = path.split('?').next().unwrap_or("");
    if method == "GET" && path == "/health" {
        return reply(&mut out, "200 OK", "text/plain", "ok");
    }
    if path != "/mcp" {
        return reply(&mut out, "404 Not Found", "text/plain", "not found");
    }
    if method != "POST" {
        return reply(&mut out, "405 Method Not Allowed", "text/plain", "POST JSON-RPC to /mcp");
    }
    // DNS rebinding: a loopback server answers only to a local Host, and a browser page only from a
    // local origin (HINDCAST_MCP_ORIGINS adds more, comma-separated)
    if loopback && !host_h.is_empty() && !is_local_host(&host_h) {
        return reply(&mut out, "403 Forbidden", "text/plain", "host not allowed");
    }
    if !origin.is_empty() {
        let extra = std::env::var("HINDCAST_MCP_ORIGINS").unwrap_or_default();
        let host_of_origin = origin.split("://").nth(1).unwrap_or("");
        if !is_local_host(host_of_origin) && !extra.split(',').any(|o| !o.trim().is_empty() && o.trim() == origin) {
            return reply(&mut out, "403 Forbidden", "text/plain", "origin not allowed");
        }
    }
    if let Some(t) = token {
        if !ct_eq(&auth, &format!("Bearer {}", t)) {
            return reply(&mut out, "401 Unauthorized", "text/plain", "a bearer token is required");
        }
    }
    if length > MAX_BODY {
        return reply(&mut out, "413 Payload Too Large", "text/plain", "too large");
    }
    if busy.fetch_add(1, Ordering::SeqCst) >= MAX_AT_ONCE {
        busy.fetch_sub(1, Ordering::SeqCst);
        return reply(&mut out, "503 Service Unavailable", "text/plain", "busy: too many requests at once");
    }
    let r = (|| -> std::io::Result<()> {
        let mut body = vec![0u8; length];
        reader.read_exact(&mut body)?;
        let msg: Value = match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(e) => return reply(&mut out, "400 Bad Request", "application/json", &json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": format!("Parse error: {}", e) } }).to_string()),
        };
        let allow = |t: &str| all_tools || network_safe(t);
        let mut sink = vec![];
        let answer = match &msg {
            Value::Array(batch) if batch.len() > MAX_BATCH => return reply(&mut out, "400 Bad Request", "application/json", &json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32600, "message": format!("at most {} messages in a batch", MAX_BATCH) } }).to_string()),
            Value::Array(batch) => {
                let rs: Vec<Value> = batch.iter().filter_map(|x| handle(m, x, &allow, &mut sink)).collect();
                if rs.is_empty() { None } else { Some(Value::Array(rs)) }
            }
            one => handle(m, one, &allow, &mut sink),
        };
        match answer {
            Some(a) => reply(&mut out, "200 OK", "application/json", &a.to_string()),
            None => reply(&mut out, "202 Accepted", "text/plain", ""),
        }
    })();
    busy.fetch_sub(1, Ordering::SeqCst);
    r
}

fn canvas_html() -> String {
    let mut candidates: Vec<std::path::PathBuf> = vec![];
    if let Ok(p) = std::env::var("HINDCAST_MCP_APP") {
        candidates.push(p.into());
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut d = exe.parent().map(|p| p.to_path_buf());
        while let Some(dir) = d {
            candidates.push(dir.join("dist-mcp").join("mcp-app.html"));
            d = dir.parent().map(|p| p.to_path_buf());
        }
    }
    for c in candidates {
        if let Ok(t) = std::fs::read_to_string(&c) {
            return t;
        }
    }
    "<!doctype html><body style=\"font-family:sans-serif;padding:24px\">Live canvas not built yet — run <code>npm run build:mcp</code> in the Hindcast repo.</body>".into()
}

fn prompt(id: &Value, params: &Value) -> Value {
    let name = s(params, &["name"]);
    let a = params.get("arguments").cloned().unwrap_or(json!({}));
    let arg = |k: &str| a.get(k).and_then(|x| x.as_str()).map(String::from);
    let msg = |t: String| result(id, json!({ "messages": [{ "role": "user", "content": { "type": "text", "text": t } }] }));
    match name.as_str() {
        "verify-infra-change" => match arg("change") {
            None => error(id, -32602, &format!("MCP error -32602: Invalid arguments for prompt verify-infra-change: Invalid input: expected string, received {} at change", received(a.get("change")))),
            Some(change) => msg(format!("Verify this infrastructure change with Hindcast before it ships: {}\n\n1. model_status. If there is no model, or the history is older than a week: connect_telemetry (ask me for the Prometheus and Jaeger/Tempo URLs if you don't know them) → collect_telemetry (7d if the data has it) → calibrate_model.\n2. Read the calibration trust report. Mention any service the change touches that is \"extrapolated\" or fits poorly.\n3. verify_change with the change as a strategy, a Kubernetes diff, a Terraform plan or edited manifests against read_cluster.\n4. Answer in this order: verdict and confidence; $ per month (range, and whether it is the bill or list prices); minutes out of SLO added; the worst moment and why; what would make it safer. Give the app.open link (the backtest screen) and the HTML report path. Do not call a low-confidence pass safe.", change)),
        },
        "check-my-design" => match arg("design") {
            None => error(id, -32602, &format!("MCP error -32602: Invalid arguments for prompt check-my-design: Invalid input: expected string, received {} at design", received(a.get("design")))),
            Some(design) => {
                let rps = arg("rps").filter(|x| !x.is_empty());
                let budget = arg("budget").filter(|x| !x.is_empty());
                msg(format!(
                    "Check this design with Hindcast: {}{}{}.\n\n1. list_components, then write the architecture spec (components, connections, zones).\n2. verify_design{}{}.\n3. While it fails: apply the cheapest fix that resolves each critical finding (each fix lists its spec changes) and verify again.\n4. Report the final design, what each fix bought and cost, the remaining risks, and the link to open it in the app.",
                    design,
                    rps.as_ref().map(|r| format!(" at {} req/s", r)).unwrap_or_default(),
                    budget.as_ref().map(|b| format!(", budget ${}/month", b)).unwrap_or_default(),
                    rps.as_ref().map(|r| format!(" with rps {}", r)).unwrap_or_default(),
                    budget.as_ref().map(|b| format!(" and budgetMonthly {}", b)).unwrap_or_default()
                ))
            }
        },
        _ => error(id, -32602, &format!("MCP error -32602: Prompt {} not found", name)),
    }
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

/// a tool's arguments checked as the SDK checks them (the schema library's messages, "message at path")
fn check_args(tool: &Value, args: Option<&Value>) -> Result<Value, String> {
    let name = s(tool, &["name"]);
    let schema = &tool["inputSchema"];
    let mut issues: Vec<(String, String)> = vec![];
    let args = match args {
        Some(Value::Object(o)) => o.clone(),
        x => return Err(format!("MCP error -32602: Input validation error: Invalid arguments for tool {}: Invalid input: expected object, received {}", name, received(x))),
    };
    let mut out = JMap::new();
    let required: Vec<String> = schema.get("required").and_then(|r| r.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    for (k, ps) in schema.get("properties").and_then(|p| p.as_object()).cloned().unwrap_or_default() {
        let v = args.get(&k);
        if v.is_none() && !required.contains(&k) {
            continue;
        }
        // the architecture spec and scenario: the engine's own checks give the schema's messages
        if k == "architecture" {
            match v {
                Some(a) => {
                    let (arch, iss) = crate::sim::spec::check_architecture(a);
                    if arch.is_none() {
                        for i in iss {
                            let path = i.path.iter().fold("architecture".to_string(), |acc, p| match p.as_str() {
                                Some(k) => format!("{}.{}", acc, k),
                                None => format!("{}[{}]", acc, crate::math::js_num(p.as_f64().unwrap_or(f64::NAN))),
                            });
                            issues.push((path, i.message.clone()));
                        }
                    } else {
                        out.insert(k.clone(), crate::cli::sim::canonical_spec(a));
                    }
                }
                None => issues.push(("architecture".into(), "Invalid input: expected object, received undefined".into())),
            }
            continue;
        }
        let mut sub = vec![];
        if let Some(r) = agent::validate(&ps, v, &[k.clone()], &mut sub) {
            if sub.is_empty() {
                out.insert(k.clone(), r);
            }
        }
        // the SDK's dot path: array indices in brackets
        issues.extend(sub.into_iter().map(|(p, m)| (p.split('.').enumerate().fold(String::new(), |acc, (i, seg)| match (i, seg.parse::<u64>()) {
            (0, _) => seg.to_string(),
            (_, Ok(_)) => format!("{}[{}]", acc, seg),
            _ => format!("{}.{}", acc, seg),
        }), m)));
    }
    if !issues.is_empty() {
        return Err(format!("MCP error -32602: Input validation error: Invalid arguments for tool {}: {}", name, issues.iter().map(|(p, m)| if p == "(root)" || p.is_empty() { m.clone() } else { format!("{} at {}", m, p) }).collect::<Vec<_>>().join("\n")));
    }
    Ok(Value::Object(out))
}

fn call_tool(m: &Value, name: &str, args: Option<&Value>, token: Option<&Value>, sink: &mut Vec<Value>) -> Value {
    let Some(tool) = arr(m, &["tools"]).into_iter().find(|t| s(t, &["name"]) == name) else {
        return fail(&format!("MCP error -32602: Tool {} not found", name));
    };
    let a = match check_args(tool, args) {
        Ok(a) => a,
        Err(e) => return fail(&e),
    };
    match run(name, &a, token, sink) {
        Ok(v) => v,
        Err(e) => fail(&e),
    }
}

fn scenario_of(a: &Value) -> Value {
    a.get("scenario").cloned().filter(|x| !x.is_null()).unwrap_or(json!({}))
}

fn opt_slo(a: &Value) -> Option<Value> {
    a.get("slo").cloned().filter(|x| !x.is_null())
}

fn num_arg(a: &Value, k: &str) -> Option<f64> {
    a.get(k).and_then(|x| x.as_f64())
}

fn strategies_arg(a: &Value) -> Result<Vec<Value>, String> {
    a.get("strategies").and_then(|x| x.as_array()).cloned().unwrap_or_default().into_iter().map(|x| match x {
        Value::String(t) => crate::cli::util::parse_yaml(&t),
        v => Ok(v),
    }).collect()
}

fn lint(spec: &Value) -> Value {
    json!(crate::cli::sim::validate(spec).issues.iter().map(|(l, m)| json!({ "level": l, "message": m })).collect::<Vec<_>>())
}

fn without(mut v: Value, k: &str) -> Value {
    if let Value::Object(o) = &mut v {
        o.shift_remove(k);
    }
    v
}

fn run(name: &str, a: &Value, token: Option<&Value>, sink: &mut Vec<Value>) -> Result<Value, String> {
    use crate::cli::bt;
    let arch = || a.get("architecture").cloned().unwrap_or(Value::Null);
    let base_name = || a.get("architecture").and_then(|x| x.get("name")).cloned();
    Ok(match name {
        "list_components" => as_json(&serde_json::from_str::<Value>(include_str!("../catalog.json")).map_err(|e| e.to_string())?),
        "validate_architecture" => {
            let v = crate::cli::sim::validate(&arch());
            let mut o = JMap::new();
            o.insert("ok".into(), json!(v.ok));
            o.insert("issues".into(), json!(v.issues.iter().map(|(l, m)| json!({ "level": l, "message": m })).collect::<Vec<_>>()));
            if let Some(sp) = v.spec {
                o.insert("spec".into(), sp);
            }
            as_json(&Value::Object(o))
        }
        "simulate" => {
            let mut r = if a.get("engine").and_then(|x| x.as_str()) == Some("des") {
                let cfg = crate::sim::des::DesConfig { seed: num_arg(a, "seed").unwrap_or(1.0), ..Default::default() };
                to_json(&crate::sim::des::simulate_des(&arch(), &scenario_of(a), &cfg)?)
            } else {
                to_json(&crate::sim::headless::simulate(&arch(), &scenario_of(a), &Default::default())?)
            };
            let samples = r.get("timeline").and_then(|t| t.as_array()).map(|t| t.len()).unwrap_or(0);
            if a.get("include_timeline").and_then(|x| x.as_bool()) != Some(true) {
                r = without(r, "timeline");
            }
            r.as_object_mut().ok_or("no result")?.insert("timelineSamples".into(), json!(samples));
            as_json(&r)
        }
        "trace_request" => {
            let count = num_arg(a, "count").map(|c| c as usize).unwrap_or(3);
            let t = crate::cli::sim::trace_request(&arch(), &scenario_of(a), num_arg(a, "seed").unwrap_or(1.0), &s(a, &["component"]), a.get("failed_only").and_then(|x| x.as_bool()) == Some(true), count)?;
            as_json(&t.to_json())
        }
        "compare_architectures" => {
            let variants = a.get("variants").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            let (ranked, results) = crate::sim::headless::compare(&arch(), &variants, &scenario_of(a), &Default::default())?;
            as_json(&json!({ "ranked": to_json(&ranked), "details": results.iter().map(|(nm, _, r)| json!({ "name": nm, "summary": to_json(&r.summary), "bottlenecks": to_json(&r.bottlenecks) })).collect::<Vec<_>>() }))
        }
        "find_breaking_point" => {
            let o = crate::sim::headless::BreakingOptions { read_ratio: num_arg(a, "readRatio"), slo: opt_slo(a), ..Default::default() };
            as_json(&to_json(&crate::sim::headless::breaking_point(&arch(), &o)?))
        }
        "analyze" => {
            let o = crate::sim::optimize::AnalyzeOptions { runs: Some(num_arg(a, "runs").unwrap_or(20.0)), seed: None, des: None };
            as_json(&to_json(&crate::sim::optimize::analyze(&arch(), &scenario_of(a), &o)?))
        }
        "optimize_cost" => {
            let o = crate::sim::optimize::OptimizeOptions { allow_runtimes: a.get("allow_runtimes").and_then(|x| x.as_bool()), slo: opt_slo(a), ..Default::default() };
            let r = crate::sim::optimize::optimize(&arch(), &scenario_of(a), &o)?;
            let mut v = without(to_json(&r), "spec");
            let changes = v["changes"].clone();
            v.as_object_mut().ok_or("no result")?.insert("variant".into(), json!({ "name": "optimized", "changes": changes }));
            as_json(&v)
        }
        "audit_resilience" => {
            let parsed = crate::sim::spec::parse_architecture(&arch())?;
            let o = crate::sim::audit::AuditOptions { rps: num_arg(a, "rps"), read_ratio: num_arg(a, "read_ratio"), slo: opt_slo(a), incident_cost_per_minute: num_arg(a, "incident_cost_per_minute"), ..Default::default() };
            let r = to_json(&crate::sim::audit::audit(&parsed, &o, &mut |_, _, _| {})?);
            let md = crate::cli::design::audit_markdown(&r);
            let mut v = r.clone();
            let ob = v.as_object_mut().ok_or("no result")?;
            ob.insert("findings".into(), json!(arr(&r, &["findings"]).into_iter().map(|f| without(f.clone(), "scenario")).collect::<Vec<_>>()));
            ob.insert("report_markdown".into(), json!(md));
            as_json(&v)
        }
        "import_terraform" | "import_kubernetes" => {
            let nm = a.get("name").and_then(|x| x.as_str());
            let r = if name == "import_terraform" {
                crate::convert::terraform::import_terraform(&a["terraform_json"], nm)?
            } else {
                crate::convert::kubernetes::import_kubernetes(&crate::cli::util::yaml_documents(a.get("manifests_yaml").and_then(|x| x.as_str()).unwrap_or(""))?, nm)?
            };
            let mut v = to_json(&r);
            v.as_object_mut().ok_or("no result")?.insert("lint".into(), lint(&r.spec));
            as_json(&v)
        }
        "open_in_app" | "show_architecture" => {
            let base = arch();
            let compare = match a.get("compare_with").filter(|x| !x.is_null()) {
                Some(v) => {
                    let b = crate::cli::design::apply_variant(&base, v)?;
                    let mut c = JMap::new();
                    c.insert("a".into(), json!({ "title": base_name().unwrap_or(json!("baseline")), "spec": base }));
                    let mut bo = JMap::new();
                    if let Some(t) = v.get("name") {
                        bo.insert("title".into(), t.clone());
                    }
                    bo.insert("spec".into(), b);
                    c.insert("b".into(), Value::Object(bo));
                    if let Some(sc) = a.get("scenario").filter(|x| !x.is_null()) {
                        c.insert("scenario".into(), sc.clone());
                    }
                    Some(Value::Object(c))
                }
                None => None,
            };
            let url = match &compare {
                Some(c) => format!("{}/#compare={}", app_url(), crate::cli::design::encode_payload(c)),
                None => format!("{}/#spec={}", app_url(), crate::cli::design::encode_payload(&base)),
            };
            if name == "open_in_app" {
                as_json(&json!({ "url": url }))
            } else {
                let nm = base_name().and_then(|x| x.as_str().map(String::from));
                let what = match &compare {
                    Some(_) => format!("{} vs {}", nm.as_deref().unwrap_or("baseline"), crate::cli::agent::sources_str(a["compare_with"].get("name"))),
                    None => nm.unwrap_or_else(|| "the architecture".into()),
                };
                let payload = match compare {
                    Some(c) => json!({ "compare": c }),
                    None => json!({ "spec": base }),
                };
                json!({ "content": [{ "type": "text", "text": format!("Rendering {} live. Also available at {}", what, url) }], "structuredContent": payload })
            }
        }
        "backtest_strategy" => {
            let ws = agent::workspace::Workspace::new(None);
            let mv = bt::read_json(&a.get("model").and_then(|x| x.as_str()).map(String::from).unwrap_or_else(|| ws.path("model.json")))?;
            let m = bt::model_of(&mv)?;
            let mut d = bt::dataset_of(&bt::read_json(&a.get("dataset").and_then(|x| x.as_str()).map(String::from).unwrap_or_else(|| ws.path("dataset.json")))?)?;
            if let Some(l) = a.get("last").and_then(|x| x.as_str()).filter(|l| !l.is_empty()) {
                d = bt::last_window(d, l)?;
            }
            let o = crate::backtest::BacktestOptions { draws: Some(num_arg(a, "draws").unwrap_or(20.0)), ..Default::default() };
            let r = crate::backtest::backtest(&m, &d, &strategies_arg(a)?, &o)?;
            text(crate::cli::reports::backtest_markdown(&bt::result_json(&r, &mv), &mv))
        }
        "replay_outage" => {
            let ws = agent::workspace::Workspace::new(None);
            let mv = bt::read_json(&a.get("model").and_then(|x| x.as_str()).map(String::from).unwrap_or_else(|| ws.path("model.json")))?;
            let m = bt::model_of(&mv)?;
            let outages: Vec<Value> = serde_json::from_str(include_str!("../outages.json")).map_err(|e| e.to_string())?;
            let id = s(a, &["outage"]);
            let ov = outages.into_iter().find(|o| s(o, &["id"]) == id).ok_or("no such outage")?;
            let outage: crate::resilience::Outage = serde_json::from_value(ov.clone()).map_err(|e| e.to_string())?;
            let (replay, result) = crate::resilience::replay_outage(&m, &outage, &strategies_arg(a)?, num_arg(a, "rps"), &Default::default(), None)?;
            let pv = to_json(&replay);
            as_json(&json!({ "outage": g(&ov, &["title"]), "what": g(&ov, &["what"]), "timeline": g(&ov, &["timeline"]), "assumptions": g(&ov, &["assumptions"]), "sources": g(&ov, &["sources"]), "roles": g(&pv, &["roles"]), "warnings": g(&pv, &["warnings"]), "report": crate::cli::reports::backtest_markdown(&bt::result_json(&result, &mv), &mv) }))
        }
        _ => {
            // the agent tools, with their phases as progress notifications when the client asked for them
            let queue = std::rc::Rc::new(std::cell::RefCell::new(Vec::<Value>::new()));
            let hook: Option<Box<dyn FnMut(&str, f64, f64)>> = token.cloned().map(|t| {
                let q = queue.clone();
                Box::new(move |m: &str, d: f64, tot: f64| q.borrow_mut().push(json!({ "method": "notifications/progress", "params": { "progressToken": t, "progress": d, "total": tot, "message": m }, "jsonrpc": "2.0" }))) as Box<dyn FnMut(&str, f64, f64)>
            });
            let r = agent::with_progress(hook, || agent::dispatch(name, a));
            sink.extend(queue.borrow_mut().drain(..));
            let mut out = r?;
            if let Some(bundle) = out.get("reports").and_then(|r| r.get("bundle")).and_then(|b| b.as_str()).map(String::from) {
                let ws = agent::workspace::Workspace::new(a.get("workspace").and_then(|w| w.as_str()));
                let link = serve::app_link(&ws.path("reports"), &bundle, &app_url())?;
                if let Value::Object(o) = &mut out {
                    o.insert("app".into(), json!({ "open": link, "note": "opens the backtest screen with these strategies over the same history, served from this MCP server while it runs" }));
                }
            }
            as_json(&out)
        }
    })
}

