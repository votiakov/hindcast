//! The agent workspace (agent/workspace.ts): one directory holding where the telemetry lives, what was
//! collected, the calibrated model and the reports. Credentials are only ever env var names.

use crate::cli::util::pretty_indent;
use serde_json::{json, Map as JMap, Value};
use std::path::{Path, PathBuf};

/// the time now, epoch seconds; HINDCAST_NOW pins it
pub fn now_s() -> f64 {
    match std::env::var("HINDCAST_NOW") {
        Ok(v) => crate::import::js_number(&v),
        Err(_) => std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0),
    }
}

/// new Date(t * 1000).toISOString()
pub fn iso_full(t: f64) -> String {
    crate::accuracy::iso_of_ms((t * 1000.0).trunc() as i64)
}

/// the ISO time without zero milliseconds (agent/workspace.ts iso)
pub fn iso(t: f64) -> String {
    let s = iso_full(t);
    match s.strip_suffix(".000Z") {
        Some(x) => format!("{}Z", x),
        None => s,
    }
}

/// "6h", "14d", "90m" → seconds
pub fn seconds(span: &str) -> Result<f64, String> {
    let t = span.trim();
    let bad = || format!("bad duration \"{}\" (e.g. 90m, 6h, 14d)", span);
    let unit = t.chars().last().ok_or_else(bad)?;
    let f = match unit {
        's' => 1.0,
        'm' => 60.0,
        'h' => 3600.0,
        'd' => 86400.0,
        'w' => 604800.0,
        _ => return Err(bad()),
    };
    let num = &t[..t.len() - 1];
    let ok = match num.split_once('.') {
        Some((a, b)) => !a.is_empty() && a.bytes().all(|c| c.is_ascii_digit()) && !b.is_empty() && b.bytes().all(|c| c.is_ascii_digit()),
        None => !num.is_empty() && num.bytes().all(|c| c.is_ascii_digit()),
    };
    if !ok {
        return Err(bad());
    }
    Ok(crate::import::js_parse_float(num) * f)
}

pub struct Workspace {
    pub dir: PathBuf,
}

/// `.hindcast/` in `cwd`, or the pre-rename `.bottleneck/` when only that one exists
pub fn default_dir(cwd: &Path) -> PathBuf {
    let fresh = cwd.join(".hindcast");
    let legacy = cwd.join(".bottleneck");
    if !fresh.exists() && legacy.exists() {
        legacy
    } else {
        fresh
    }
}

impl Workspace {
    pub fn new(dir: Option<&str>) -> Workspace {
        let cwd = crate::cli::files::cwd();
        let d = match dir {
            Some(d) => crate::cli::files::resolve(&cwd, d),
            None => match std::env::var("HINDCAST_WORKSPACE").or_else(|_| std::env::var("BOTTLENECK_WORKSPACE")) {
                Ok(d) => crate::cli::files::resolve(&cwd, &d),
                Err(_) => default_dir(&cwd),
            },
        };
        Workspace { dir: d }
    }
    pub fn dir_str(&self) -> String {
        self.dir.to_string_lossy().to_string()
    }
    pub fn path(&self, p: &str) -> String {
        if p.is_empty() {
            self.dir_str()
        } else {
            self.dir.join(p).to_string_lossy().to_string()
        }
    }
    pub fn ensure(&self, p: &str) -> String {
        let d = self.path(p);
        let _ = std::fs::create_dir_all(&d);
        d
    }
    pub fn has(&self, file: &str) -> bool {
        Path::new(&self.path(file)).exists()
    }
    pub fn read_json(&self, file: &str) -> Result<Value, String> {
        let p = self.path(file);
        if !Path::new(&p).exists() {
            // say which step makes it: the agent (or person) then knows what to run
            let step = match file {
                "model.json" | "calibration.json" => " — run calibrate_model first (after connect_telemetry and collect_telemetry), or `hindcast quickstart --prometheus <url>` for all three",
                "dataset.json" => " — run collect_telemetry first (after connect_telemetry), or `hindcast quickstart --prometheus <url>`",
                _ => "",
            };
            return Err(format!("{} is not in the workspace ({}) yet{}", file, self.dir_str(), step));
        }
        serde_json::from_str(&std::fs::read_to_string(&p).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
    }
    /// JSON.stringify(v, null, pretty ? 1 : undefined)
    pub fn write_json(&self, file: &str, v: &Value, pretty: bool) -> Result<String, String> {
        self.ensure("");
        let p = self.path(file);
        let text = if pretty { pretty_indent(v, 1) } else { crate::convert::js_stringify(v) };
        std::fs::write(&p, text).map_err(|e| format!("{}: {}", p, e))?;
        Ok(p)
    }
    pub fn sources(&self) -> Result<Value, String> {
        if self.has("sources.json") {
            Ok(parse_sources(&self.read_json("sources.json")?))
        } else {
            Ok(parse_sources(&json!({})))
        }
    }
    pub fn save_sources(&self, s: &Value) -> Result<String, String> {
        self.write_json("sources.json", &parse_sources(s), true)
    }
}

fn pick(o: &JMap<String, Value>, keys: &[&str]) -> JMap<String, Value> {
    let mut out = JMap::new();
    for k in keys {
        if let Some(v) = o.get(*k) {
            if !v.is_null() || *k == "__keep_null" {
                out.insert((*k).into(), v.clone());
            }
        }
    }
    out
}

const AUTH: [&str; 3] = ["tokenEnv", "basicAuthEnv", "headersEnv"];

/// Sources.parse: the schema's key order, its defaults, unknown keys dropped
pub fn parse_sources(v: &Value) -> Value {
    let o = v.as_object().cloned().unwrap_or_default();
    let mut out = JMap::new();
    let sys = o.get("system").and_then(|x| x.as_object()).cloned();
    let mut system = match &sys {
        Some(s) => pick(s, &["name", "slo", "timeoutMs", "rename", "hostedBy", "ignore", "exclude", "entry", "placement"]),
        None => JMap::new(),
    };
    if !system.contains_key("name") {
        // .default('my system') puts it first only when it is missing: zod writes defaults in shape order
        let mut s2 = JMap::new();
        s2.insert("name".into(), json!("my system"));
        for (k, x) in system {
            s2.insert(k, x);
        }
        system = s2;
    }
    if let Some(Value::Object(slo)) = system.get("slo").cloned() {
        system.insert("slo".into(), Value::Object(pick(&slo, &["p99Ms", "errorRate"])));
    }
    if let Some(Value::Object(pl)) = system.get("placement").cloned() {
        let m: JMap<String, Value> = pl.into_iter().map(|(k, x)| (k, Value::Object(pick(x.as_object().unwrap_or(&JMap::new()), &["zone", "region"])))).collect();
        system.insert("placement".into(), Value::Object(m));
    }
    out.insert("system".into(), Value::Object(system));
    let with_auth = |x: &JMap<String, Value>, head: &[&str]| {
        let mut keys: Vec<&str> = head.to_vec();
        keys.extend(AUTH);
        Value::Object(pick(x, &keys))
    };
    if let Some(Value::Object(p)) = o.get("prometheus") {
        out.insert("prometheus".into(), with_auth(p, &["url", "presets", "selector", "namespaces"]));
    }
    if let Some(Value::Object(p)) = o.get("jaeger") {
        out.insert("jaeger".into(), with_auth(p, &["url"]));
    }
    if let Some(Value::Object(p)) = o.get("tempo") {
        out.insert("tempo".into(), with_auth(p, &["url"]));
    }
    if let Some(t) = o.get("traceFiles").filter(|x| !x.is_null()) {
        out.insert("traceFiles".into(), t.clone());
    }
    if let Some(Value::Object(b)) = o.get("bill") {
        out.insert("bill".into(), Value::Object(pick(b, &["cur", "gcp", "tag", "resources"])));
    }
    if let Some(Value::Object(k)) = o.get("kube") {
        out.insert("kube".into(), Value::Object(pick(k, &["context", "namespace"])));
    }
    Value::Object(out)
}

/// request headers from env var names — secrets stay in the environment
pub fn auth_headers(a: Option<&Value>) -> Result<Vec<(String, String)>, String> {
    let mut h: Vec<(String, String)> = vec![];
    let Some(a) = a else { return Ok(h) };
    let env = |name: &str| std::env::var(name).map_err(|_| format!("env var {} is not set (named in the connection's auth)", name));
    let mut set = |k: &str, v: String| {
        if let Some(e) = h.iter_mut().find(|(x, _)| x == k) {
            e.1 = v;
        } else {
            h.push((k.to_string(), v));
        }
    };
    if let Some(t) = a.get("tokenEnv").and_then(|x| x.as_str()).filter(|x| !x.is_empty()) {
        set("Authorization", format!("Bearer {}", env(t)?));
    }
    if let Some(t) = a.get("basicAuthEnv").and_then(|x| x.as_str()).filter(|x| !x.is_empty()) {
        set("Authorization", format!("Basic {}", base64(env(t)?.as_bytes())));
    }
    if let Some(Value::Object(m)) = a.get("headersEnv") {
        for (k, v) in m {
            set(k, env(v.as_str().unwrap_or(""))?);
        }
    }
    Ok(h)
}

fn base64(b: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= c.len() {
                out.push(A[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// GET JSON with a timeout and a useful error (agent/workspace.ts getJson)
pub fn get_json(url: &str, headers: &[(String, String)], timeout_ms: u64) -> Result<Value, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(std::time::Duration::from_millis(timeout_ms))).build().into();
    let mut req = agent.get(url);
    for (k, v) in headers {
        req = req.header(k.as_str(), v.as_str());
    }
    let mut resp = match req.call() {
        Ok(r) => r,
        Err(ureq::Error::Timeout(_)) => return Err(format!("{} did not answer within {} s", url, crate::math::js_num(timeout_ms as f64 / 1000.0))),
        Err(e) => return Err(format!("fetch failed: {} ({})", url.split('?').next().unwrap_or(url), e)),
    };
    let status = resp.status().as_u16();
    let text = resp.body_mut().with_config().limit(crate::cli::http::BODY_LIMIT).read_to_string().map_err(|e| crate::cli::http::body_error(url, &e))?;
    if !(200..300).contains(&status) {
        let path = url.split("://").nth(1).and_then(|r| r.find('/').map(|i| &r[i..])).unwrap_or("/");
        let path = path.split('?').next().unwrap_or(path);
        // an HTML error page says it in its title; the rest is markup
        let title = text.find("<title").and_then(|i| text[i..].find('>').map(|j| i + j + 1)).and_then(|a| text[a..].find("</title>").map(|b| text[a..a + b].trim().to_string()));
        let t: Vec<u16> = text.encode_utf16().collect();
        let head = title.unwrap_or_else(|| String::from_utf16_lossy(&t[..t.len().min(300)]));
        return Err(format!("{} answered {}: {}", path, status, head));
    }
    serde_json::from_str(&text).map_err(|e| format!("Unexpected token in JSON: {}", e))
}

/// a URL relative to a base that is treated as a directory, with its query parameters
pub fn api(base: &str, path: &str, q: &[(&str, String)]) -> String {
    let mut u = crate::cli::http::join(base, path);
    if !q.is_empty() {
        u.push('?');
        u.push_str(&q.iter().map(|(k, v)| format!("{}={}", crate::prom_export::form_encode(k), crate::prom_export::form_encode(v))).collect::<Vec<_>>().join("&"));
    }
    u
}
