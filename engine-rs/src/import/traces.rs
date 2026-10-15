//! Traces → topology and per-bucket latency (src/backtest/import/traces.ts). OTLP JSON (collector file
//! exporter, Tempo) and Jaeger JSON. A *visit* is one service handling one call; self time is a visit's
//! duration minus what its child visits cover; the critical path says how many ms of each request each
//! service owns.

use super::builder::DatasetBuilder;
use crate::backtest::{js_sort_by, quantile};
use crate::dataset::{EndpointShape, ServiceShape, Topology};
use crate::types::Map;
use indexmap::{IndexMap, IndexSet};
use serde::de::{IgnoredAny, Visitor};
use serde::Deserialize;
use serde_json::Value;
use std::borrow::Cow;
use std::rc::Rc;
use std::collections::HashMap;

#[derive(Clone, Debug)]
pub enum Attr {
    S(String),
    N(f64),
    B(bool),
}

impl Attr {
    fn as_str(&self) -> String {
        match self {
            Attr::S(s) => s.clone(),
            Attr::N(n) => crate::math::js_num(*n),
            Attr::B(b) => b.to_string(),
        }
    }
    fn num(&self) -> f64 {
        match self {
            Attr::S(s) => super::js_number(s),
            Attr::N(n) => *n,
            Attr::B(b) => {
                if *b {
                    1.0
                } else {
                    0.0
                }
            }
        }
    }
}

#[derive(Clone, Debug)]
pub struct Span {
    pub trace_id: String,
    pub span_id: String,
    pub parent_id: Option<String>,
    /// shared by every span of one resource
    pub service: Rc<str>,
    pub name: String,
    pub kind: &'static str,
    /// ms since epoch
    pub start: f64,
    pub end: f64,
    pub error: bool,
    pub attrs: Attrs,
}

/// the few attributes kept from a span, in the order first seen (a later value replaces an earlier one)
#[derive(Clone, Debug, Default)]
pub struct Attrs(Vec<(Cow<'static, str>, Attr)>);

impl Attrs {
    pub fn get(&self, k: &str) -> Option<&Attr> {
        self.0.iter().find(|(x, _)| x == k).map(|(_, v)| v)
    }
    fn insert(&mut self, k: &str, v: Attr) {
        if let Some(e) = self.0.iter_mut().find(|(x, _)| x == k) {
            e.1 = v;
            return;
        }
        // most kept keys are spelled exactly as the list spells them: no allocation for those
        let key = match KEEP_PREFIXES.iter().find(|p| **p == k) {
            Some(p) => Cow::Borrowed(*p),
            None => Cow::Owned(k.to_string()),
        };
        self.0.push((key, v));
    }
}

const KEEP_PREFIXES: [&str; 25] = [
    "url.path",
    "http.target",
    "http.route",
    "http.method",
    "http.request.method",
    "http.status_code",
    "http.response.status_code",
    "http.request.body.size",
    "http.response.body.size",
    "http.request_content_length",
    "http.response_content_length",
    "rpc.system",
    "rpc.service",
    "rpc.method",
    "rpc.request.size",
    "rpc.response.size",
    "db.system",
    "messaging.system",
    "messaging.message",
    "peer.service",
    "server.address",
    "net.peer.name",
    "error",
    "otel.status_code",
    "span.kind",
];

fn keep(k: &str) -> bool {
    KEEP_PREFIXES.iter().any(|p| k.starts_with(p))
}

/// one JSON scalar as JavaScript sees it: `undefined` when the key is missing; objects and arrays are
/// skipped unread
#[derive(Default, Debug)]
enum Scalar<'a> {
    #[default]
    Undef,
    Null,
    Bool(bool),
    Num(f64),
    Str(Cow<'a, str>),
    Other,
}

impl<'de: 'a, 'a> Deserialize<'de> for Scalar<'a> {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V<'a>(std::marker::PhantomData<&'a ()>);
        impl<'de: 'a, 'a> Visitor<'de> for V<'a> {
            type Value = Scalar<'a>;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a JSON value")
            }
            fn visit_bool<E>(self, v: bool) -> Result<Scalar<'a>, E> {
                Ok(Scalar::Bool(v))
            }
            fn visit_i64<E>(self, v: i64) -> Result<Scalar<'a>, E> {
                Ok(Scalar::Num(v as f64))
            }
            fn visit_u64<E>(self, v: u64) -> Result<Scalar<'a>, E> {
                Ok(Scalar::Num(v as f64))
            }
            fn visit_f64<E>(self, v: f64) -> Result<Scalar<'a>, E> {
                Ok(Scalar::Num(v))
            }
            fn visit_borrowed_str<E>(self, v: &'de str) -> Result<Scalar<'a>, E> {
                Ok(Scalar::Str(Cow::Borrowed(v)))
            }
            fn visit_str<E>(self, v: &str) -> Result<Scalar<'a>, E> {
                Ok(Scalar::Str(Cow::Owned(v.to_string())))
            }
            fn visit_string<E>(self, v: String) -> Result<Scalar<'a>, E> {
                Ok(Scalar::Str(Cow::Owned(v)))
            }
            fn visit_unit<E>(self) -> Result<Scalar<'a>, E> {
                Ok(Scalar::Null)
            }
            fn visit_none<E>(self) -> Result<Scalar<'a>, E> {
                Ok(Scalar::Null)
            }
            fn visit_some<D: serde::Deserializer<'de>>(self, d: D) -> Result<Scalar<'a>, D::Error> {
                Scalar::deserialize(d)
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut a: A) -> Result<Scalar<'a>, A::Error> {
                while a.next_element::<IgnoredAny>()?.is_some() {}
                Ok(Scalar::Other)
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut a: A) -> Result<Scalar<'a>, A::Error> {
                while a.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(Scalar::Other)
            }
        }
        d.deserialize_any(V(std::marker::PhantomData))
    }
}

impl Scalar<'_> {
    fn is_undef(&self) -> bool {
        matches!(self, Scalar::Undef)
    }
    fn truthy(&self) -> bool {
        match self {
            Scalar::Undef | Scalar::Null => false,
            Scalar::Bool(b) => *b,
            Scalar::Num(n) => *n != 0.0 && !n.is_nan(),
            Scalar::Str(s) => !s.is_empty(),
            Scalar::Other => true,
        }
    }
    /// String(x)
    fn js_string(&self) -> String {
        match self {
            Scalar::Undef => "undefined".into(),
            Scalar::Null => "null".into(),
            Scalar::Bool(b) => b.to_string(),
            Scalar::Num(n) => crate::math::js_num(*n),
            Scalar::Str(s) => s.to_string(),
            Scalar::Other => "[object Object]".into(),
        }
    }
    /// Number(x)
    fn js_number(&self) -> f64 {
        match self {
            Scalar::Undef | Scalar::Other => f64::NAN,
            Scalar::Null => 0.0,
            Scalar::Bool(b) => *b as u8 as f64,
            Scalar::Num(n) => *n,
            Scalar::Str(s) => super::js_number(s),
        }
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AnyValue<'a> {
    #[serde(default, borrow)]
    string_value: Scalar<'a>,
    #[serde(default, borrow)]
    int_value: Scalar<'a>,
    #[serde(default, borrow)]
    double_value: Scalar<'a>,
    #[serde(default, borrow)]
    bool_value: Scalar<'a>,
}

impl AnyValue<'_> {
    fn attr(&self) -> Option<Attr> {
        if !self.string_value.is_undef() {
            Some(Attr::S(self.string_value.js_string()))
        } else if !self.int_value.is_undef() {
            Some(Attr::N(self.int_value.js_number()))
        } else if !self.double_value.is_undef() {
            Some(Attr::N(self.double_value.js_number()))
        } else if !self.bool_value.is_undef() {
            Some(Attr::B(self.bool_value.truthy()))
        } else {
            None
        }
    }
}

#[derive(Deserialize)]
struct KeyValue<'a> {
    #[serde(default, borrow)]
    key: Option<Cow<'a, str>>,
    #[serde(default, borrow)]
    value: Option<AnyValue<'a>>,
}

#[derive(Deserialize, Default)]
struct Status<'a> {
    #[serde(default, borrow)]
    code: Scalar<'a>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OtlpSpan<'a> {
    #[serde(default, borrow)]
    trace_id: Scalar<'a>,
    #[serde(default, borrow)]
    span_id: Scalar<'a>,
    #[serde(default, borrow)]
    parent_span_id: Scalar<'a>,
    #[serde(default, borrow)]
    name: Scalar<'a>,
    #[serde(default, borrow)]
    kind: Scalar<'a>,
    #[serde(default, borrow)]
    start_time_unix_nano: Scalar<'a>,
    #[serde(default, borrow)]
    end_time_unix_nano: Scalar<'a>,
    #[serde(default, borrow)]
    attributes: Option<Vec<KeyValue<'a>>>,
    #[serde(default, borrow)]
    status: Option<Status<'a>>,
}

#[derive(Deserialize)]
struct ScopeSpans<'a> {
    #[serde(default, borrow)]
    spans: Option<Vec<OtlpSpan<'a>>>,
}

#[derive(Deserialize)]
struct Resource<'a> {
    #[serde(default, borrow)]
    attributes: Option<Vec<KeyValue<'a>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResourceSpans<'a> {
    #[serde(default, borrow)]
    resource: Option<Resource<'a>>,
    #[serde(default, borrow)]
    scope_spans: Option<Vec<ScopeSpans<'a>>>,
    #[serde(default, borrow)]
    instrumentation_library_spans: Option<Vec<ScopeSpans<'a>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TraceV2<'a> {
    #[serde(default, borrow)]
    resource_spans: Option<Vec<ResourceSpans<'a>>>,
}

/// one OTLP document (or the head of a Jaeger one: `data` set means Jaeger)
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OtlpDoc<'a> {
    #[serde(default, borrow)]
    resource_spans: Option<Vec<ResourceSpans<'a>>>,
    #[serde(default, borrow)]
    batches: Option<Vec<ResourceSpans<'a>>>,
    #[serde(default, borrow)]
    trace: Option<TraceV2<'a>>,
    /// Jaeger
    #[serde(default, borrow)]
    data: Option<Vec<JaegerTrace<'a>>>,
}

fn kind_of(k: &Scalar) -> &'static str {
    let s = match k {
        Scalar::Num(n) => {
            return match *n as i64 {
                2 => "server",
                3 => "client",
                4 => "producer",
                5 => "consumer",
                _ => "internal",
            }
        }
        Scalar::Undef | Scalar::Null => String::new(),
        x => x.js_string().to_lowercase(),
    };
    match s.replacen("span_kind_", "", 1).as_str() {
        "server" => "server",
        "client" => "client",
        "producer" => "producer",
        "consumer" => "consumer",
        _ => "internal",
    }
}

fn ns_of(v: &Scalar) -> f64 {
    match v {
        Scalar::Num(n) => n / 1e6,
        Scalar::Str(s) => super::js_number(if s.len() > 3 { &s[..s.len() - 3] } else { "0" }) / 1000.0,
        _ => f64::NAN,
    }
}

fn spans_of<'a>(resource_spans: Option<Vec<ResourceSpans<'a>>>, batches: Option<Vec<ResourceSpans<'a>>>, trace: Option<TraceV2<'a>>, out: &mut Vec<Span>) {
    let rs = match resource_spans.or(batches).or_else(|| trace.and_then(|t| t.resource_spans)) {
        Some(r) => r,
        None => return,
    };
    for r in rs {
        let service = r
            .resource
            .as_ref()
            .and_then(|x| x.attributes.as_ref())
            .and_then(|a| a.iter().find(|x| x.key.as_deref() == Some("service.name")))
            .and_then(|x| x.value.as_ref())
            .and_then(|v| v.attr())
            .map(|a| a.as_str())
            .unwrap_or_else(|| "unknown".into());
        let service: Rc<str> = service.into();
        for ss in r.scope_spans.or(r.instrumentation_library_spans).unwrap_or_default() {
            for sp in ss.spans.unwrap_or_default() {
                let mut attrs = Attrs::default();
                for a in sp.attributes.as_deref().unwrap_or(&[]) {
                    let k = a.key.as_deref().unwrap_or("undefined");
                    if !keep(k) {
                        continue;
                    }
                    if let Some(v) = a.value.as_ref().and_then(|v| v.attr()) {
                        attrs.insert(k, v);
                    }
                }
                let code = sp.status.as_ref().map(|s| &s.code).unwrap_or(&Scalar::Undef);
                let http = attrs.get("http.response.status_code").or(attrs.get("http.status_code")).map(|a| a.num()).unwrap_or(0.0);
                let error = matches!(code, Scalar::Num(n) if *n == 2.0) || matches!(code, Scalar::Str(s) if s == "STATUS_CODE_ERROR") || http >= 500.0;
                out.push(Span {
                    trace_id: sp.trace_id.js_string(),
                    span_id: sp.span_id.js_string(),
                    parent_id: if sp.parent_span_id.truthy() { Some(sp.parent_span_id.js_string()) } else { None },
                    service: service.clone(),
                    name: match sp.name {
                        Scalar::Undef | Scalar::Null => String::new(),
                        ref v => v.js_string(),
                    },
                    kind: kind_of(&sp.kind),
                    start: ns_of(&sp.start_time_unix_nano),
                    end: ns_of(&sp.end_time_unix_nano),
                    error,
                    attrs,
                });
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JaegerRef<'a> {
    #[serde(default, borrow)]
    ref_type: Scalar<'a>,
    #[serde(default, borrow, rename = "spanID")]
    span_id: Scalar<'a>,
}

#[derive(Deserialize)]
struct JaegerTag<'a> {
    #[serde(default, borrow)]
    key: Scalar<'a>,
    #[serde(default, borrow)]
    value: Scalar<'a>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JaegerSpan<'a> {
    #[serde(default, borrow, rename = "traceID")]
    trace_id: Scalar<'a>,
    #[serde(default, borrow, rename = "spanID")]
    span_id: Scalar<'a>,
    #[serde(default, borrow)]
    operation_name: Scalar<'a>,
    #[serde(default, borrow)]
    references: Option<Vec<JaegerRef<'a>>>,
    #[serde(default, borrow)]
    start_time: Scalar<'a>,
    #[serde(default, borrow)]
    duration: Scalar<'a>,
    #[serde(default, borrow)]
    tags: Option<Vec<JaegerTag<'a>>>,
    #[serde(default, borrow, rename = "processID")]
    process_id: Scalar<'a>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JaegerProcess<'a> {
    #[serde(default, borrow)]
    service_name: Scalar<'a>,
}

#[derive(Deserialize)]
struct JaegerTrace<'a> {
    #[serde(borrow)]
    spans: Vec<JaegerSpan<'a>>,
    #[serde(default, borrow)]
    processes: HashMap<Cow<'a, str>, JaegerProcess<'a>>,
}

fn str_of(s: &Scalar) -> String {
    match s {
        Scalar::Str(s) => s.to_string(),
        _ => String::new(),
    }
}
fn num_of(s: &Scalar) -> f64 {
    match s {
        Scalar::Num(n) => *n,
        _ => f64::NAN,
    }
}

fn jaeger_spans(data: Vec<JaegerTrace>, out: &mut Vec<Span>) {
    for tr in data {
        let mut names: HashMap<String, Rc<str>> = HashMap::new();
        for sp in tr.spans {
            let mut attrs = Attrs::default();
            let mut kind = "internal";
            let mut error = false;
            for t in sp.tags.as_deref().unwrap_or(&[]) {
                let k = match &t.key {
                    Scalar::Str(s) => s.as_ref(),
                    _ => "",
                };
                if k == "span.kind" {
                    kind = kind_of(&t.value);
                } else if k == "error" {
                    error = matches!(t.value, Scalar::Bool(true)) || matches!(&t.value, Scalar::Str(s) if s == "true");
                } else if k == "otel.status_code" {
                    error = error || matches!(&t.value, Scalar::Str(s) if s == "ERROR");
                }
                if keep(k) {
                    match &t.value {
                        Scalar::Str(s) => {
                            attrs.insert(k, Attr::S(s.to_string()));
                        }
                        Scalar::Num(n) => {
                            attrs.insert(k, Attr::N(*n));
                        }
                        Scalar::Bool(b) => {
                            attrs.insert(k, Attr::B(*b));
                        }
                        _ => {}
                    }
                }
            }
            let parent = sp.references.as_ref().and_then(|r| r.iter().find(|x| matches!(&x.ref_type, Scalar::Str(s) if s == "CHILD_OF")).or_else(|| r.first())).and_then(|r| match &r.span_id {
                Scalar::Str(s) => Some(s.to_string()),
                _ => None,
            });
            let pid = match &sp.process_id {
                Scalar::Str(s) => s.as_ref(),
                _ => "",
            };
            let start = num_of(&sp.start_time);
            let dur = num_of(&sp.duration);
            out.push(Span {
                trace_id: str_of(&sp.trace_id),
                span_id: str_of(&sp.span_id),
                parent_id: parent,
                service: names.entry(pid.to_string()).or_insert_with(|| tr.processes.get(pid).and_then(|p| match &p.service_name {
                    Scalar::Str(s) => Some(Rc::from(s.as_ref())),
                    _ => None,
                }).unwrap_or_else(|| Rc::from("unknown"))).clone(),
                name: str_of(&sp.operation_name),
                kind,
                start: start / 1000.0,
                end: (start + dur) / 1000.0,
                error,
                attrs,
            });
        }
    }
}

fn doc_spans(d: OtlpDoc, out: &mut Vec<Span>) {
    match d.data {
        Some(data) => jaeger_spans(data, out),
        None => spans_of(d.resource_spans, d.batches, d.trace, out),
    }
}

/// one parsed document: OTLP, or Jaeger when it has `data`
pub fn parse_value(doc: &Value, out: &mut Vec<Span>) {
    if let Ok(d) = OtlpDoc::deserialize(doc) {
        doc_spans(d, out);
    }
}

/// JSON lines of OTLP / Jaeger documents
pub fn parse_trace_lines<S: AsRef<str>>(lines: impl Iterator<Item = S>, out: &mut Vec<Span>) -> Result<(), String> {
    for line in lines {
        let line = line.as_ref();
        if line.trim().is_empty() {
            continue;
        }
        parse_text(line, out)?;
    }
    Ok(())
}

/// one JSON document: read straight into the OTLP shape; Jaeger (or anything that does not fit) as a
/// generic value
fn parse_text(text: &str, out: &mut Vec<Span>) -> Result<(), String> {
    parse_bytes(text.as_bytes(), out)
}

fn parse_bytes(text: &[u8], out: &mut Vec<Span>) -> Result<(), String> {
    match serde_json::from_slice::<OtlpDoc>(text) {
        Ok(d) => doc_spans(d, out),
        // a shape that does not fit (a field of an unexpected type) is skipped, as the TypeScript
        // importer's optional chaining does; text that is not JSON is an error
        Err(_) => {
            let doc: Value = serde_json::from_slice(text).map_err(|e| e.to_string())?;
            parse_value(&doc, out);
        }
    }
    Ok(())
}

/// JSON lines arriving as raw blocks of bytes (a file read block by block into one reused buffer):
/// lines split here, each parsed in place
pub fn parse_trace_chunks(mut next: impl FnMut(&mut Vec<u8>) -> Result<bool, String>, out: &mut Vec<Span>) -> Result<(), String> {
    let line = |l: &[u8], out: &mut Vec<Span>| -> Result<(), String> {
        if l.iter().all(|c| c.is_ascii_whitespace()) {
            return Ok(());
        }
        parse_bytes(l, out)
    };
    let mut rest: Vec<u8> = vec![];
    let mut chunk: Vec<u8> = vec![];
    while next(&mut chunk)? {
        let mut from = 0;
        while let Some(k) = chunk[from..].iter().position(|&c| c == b'\n') {
            let i = from + k;
            if rest.is_empty() {
                line(&chunk[from..i], out)?;
            } else {
                rest.extend_from_slice(&chunk[from..i]);
                line(&rest, out)?;
                rest.clear();
            }
            from = i + 1;
        }
        rest.extend_from_slice(&chunk[from..]);
    }
    if !rest.is_empty() {
        line(&rest, out)?;
    }
    Ok(())
}

/// any supported trace file: JSON lines of OTLP, one OTLP document, or Jaeger JSON
pub fn parse_trace_file(text: &str, out: &mut Vec<Span>) -> Result<(), String> {
    let trimmed = text.trim_start();
    if trimmed.starts_with('{') && !trimmed.contains("\n{") {
        return parse_text(trimmed, out);
    }
    parse_trace_lines(text.split('\n'), out)
}

// ---------------------------------------------------------------------------------------------

const SQL: [&str; 15] = ["mysql", "postgresql", "postgres", "mssql", "oracle", "sqlite", "mariadb", "cockroachdb", "db2", "spanner", "dynamodb", "mongodb", "cassandra", "elasticsearch", "opensearch"];
const CACHE: [&str; 3] = ["redis", "memcached", "valkey"];

fn attr_str(sp: &Span, k: &str) -> Option<String> {
    sp.attrs.get(k).map(|a| a.as_str())
}

fn system_of(sp: &Span) -> Option<(&'static str, String)> {
    let db = attr_str(sp, "db.system").or_else(|| attr_str(sp, "db.system.name"));
    let mq = attr_str(sp, "messaging.system");
    if let Some(db) = db.filter(|x| !x.is_empty()) {
        return Some((if CACHE.contains(&db.as_str()) { "cache" } else { "db" }, db));
    }
    if let Some(mq) = mq.filter(|x| !x.is_empty()) {
        return Some(("queue", mq));
    }
    None
}

fn is_ip(s: &str) -> bool {
    let v4 = {
        let parts: Vec<&str> = s.split('.').collect();
        parts.len() == 4 && parts.iter().all(|p| !p.is_empty() && p.len() <= 3 && p.bytes().all(|c| c.is_ascii_digit()))
    };
    if v4 {
        return true;
    }
    // \[?[0-9a-f:]+:[0-9a-f:]*\]? (case-insensitive)
    let t = s.strip_prefix('[').unwrap_or(s);
    let t = t.strip_suffix(']').unwrap_or(t);
    let ok = |c: char| c.is_ascii_hexdigit() || c == ':';
    match t.find(':') {
        Some(i) if i > 0 => t.chars().all(ok),
        _ => false,
    }
}

fn dependency_of(sp: &Span) -> Option<(String, &'static str, Option<String>)> {
    let db = attr_str(sp, "db.system").or_else(|| attr_str(sp, "db.system.name")).filter(|x| !x.is_empty());
    let mq = attr_str(sp, "messaging.system").filter(|x| !x.is_empty());
    let peer = attr_str(sp, "peer.service").or_else(|| attr_str(sp, "server.address")).or_else(|| attr_str(sp, "net.peer.name"));
    if let Some(db) = db {
        let kind = if CACHE.contains(&db.as_str()) { "cache" } else { let _ = SQL; "db" };
        return Some((peer.unwrap_or_else(|| db.clone()), kind, Some(db)));
    }
    if let Some(mq) = mq {
        return Some((peer.unwrap_or_else(|| mq.clone()), "queue", Some(mq)));
    }
    // a bare IP is an address, not a component
    if let Some(p) = peer.filter(|p| !p.is_empty()) {
        if sp.kind == "client" && !is_ip(&p) {
            return Some((p, "external", None));
        }
    }
    None
}

struct Visit {
    service: String,
    kind: &'static str,
    system: Option<String>,
    start: f64,
    end: f64,
    error: bool,
    name: String,
    route: Option<String>,
    target: Option<String>,
    method: Option<String>,
    span_kind: &'static str,
    bytes: Option<f64>,
    children: Vec<usize>,
    server_spans: f64,
    self_ms: f64,
}

const BYTE_KEYS: [&str; 8] = ["http.request.body.size", "http.response.body.size", "http.request_content_length", "http.response_content_length", "messaging.message.body.size", "messaging.message_payload_size_bytes", "rpc.request.size", "rpc.response.size"];

fn payload_bytes(spans: [Option<&Span>; 2]) -> Option<f64> {
    let (mut total, mut any) = (0.0, false);
    for sp in spans.iter().flatten() {
        for k in BYTE_KEYS {
            let v = sp.attrs.get(k).map(|a| a.num()).unwrap_or(f64::NAN);
            if v.is_finite() && v > 0.0 {
                total += v;
                any = true;
            }
        }
        if any {
            break; // client and server usually report the same body — count it once
        }
    }
    if any {
        Some(total)
    } else {
        None
    }
}

/// " /path[with{param}]" at the end of a span name: a route template
fn route_in_name(name: &str) -> Option<String> {
    // \s(\/[^\s?]*[\[{:][^\s?]*)$
    let i = name.rfind(char::is_whitespace)?;
    let tail = &name[i + name[i..].chars().next().unwrap().len_utf8()..];
    if !tail.starts_with('/') || tail.contains('?') || tail.is_empty() {
        return None;
    }
    if tail[1..].chars().any(|c| c == '[' || c == '{' || c == ':') {
        Some(tail.to_string())
    } else {
        None
    }
}

struct Arena {
    v: Vec<Visit>,
}

/// a synchronous call under the request that ran well past the request's own end (durations, so
/// clock skew between hosts doesn't matter); messaging consumers may outlive it by design
fn abandoned(root: usize, dur: f64, arena: &Arena) -> bool {
    let mut stack: Vec<usize> = arena.v[root].children.clone();
    while let Some(v) = stack.pop() {
        let x = &arena.v[v];
        if (x.span_kind == "server" || x.span_kind == "client") && x.end - x.start > dur * 1.1 + 50.0 {
            return true;
        }
        stack.extend_from_slice(&x.children);
    }
    false
}

/// build the visit tree of one trace; the indices of its top-level visits
fn visits_of(spans: &[Span], ignore: &IndexSet<String>, arena: &mut Arena) -> Vec<usize> {
    let by_id: HashMap<&str, usize> = spans.iter().enumerate().map(|(i, s)| (s.span_id.as_str(), i)).collect();
    let mut kids: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, s) in spans.iter().enumerate() {
        if let Some(p) = &s.parent_id {
            if by_id.contains_key(p.as_str()) {
                kids.entry(p.as_str()).or_default().push(i);
            }
        }
    }
    // a span whose parent never arrived is an orphan, not the start of another request
    let roots: Vec<usize> = (0..spans.len()).filter(|&i| spans[i].parent_id.is_none()).collect();
    let mut orphans: Vec<usize> = (0..spans.len()).filter(|&i| spans[i].parent_id.as_ref().map(|p| !by_id.contains_key(p.as_str())).unwrap_or(false)).collect();
    let mut tops: Vec<usize> = vec![];

    fn walk(i: usize, owner: Option<usize>, via: Option<usize>, spans: &[Span], by_id: &HashMap<&str, usize>, kids: &HashMap<&str, Vec<usize>>, ignore: &IndexSet<String>, arena: &mut Arena, tops: &mut Vec<usize>) {
        let sp = &spans[i];
        let parent = sp.parent_id.as_ref().and_then(|p| by_id.get(p.as_str())).map(|&p| &spans[p]);
        let ignored = ignore.contains(sp.service.as_ref());
        let mut current = owner;
        if !ignored {
            // a new visit starts at a service boundary
            let owner_service = owner.map(|o| arena.v[o].service.clone());
            let boundary = owner.is_none()
                || parent.map(|p| p.service != sp.service).unwrap_or(false)
                || (parent.is_none() && owner_service.as_deref() != Some(sp.service.as_ref()))
                || ((sp.kind == "server" || sp.kind == "consumer") && parent.map(|p| p.service != sp.service).unwrap_or(false));
            let child_spans = kids.get(sp.span_id.as_str());
            let dep = if (sp.kind == "client" || sp.kind == "producer") && !child_spans.map(|c| c.iter().any(|&k| spans[k].service != sp.service)).unwrap_or(false) { dependency_of(sp) } else { None };
            if boundary || dep.is_some() {
                // a service that reports itself still gets its kind from attributes
                let own: Option<(&'static str, Option<String>)> = match &dep {
                    Some((_, k, sys)) => Some((k, sys.clone())),
                    None => system_of(sp).map(|(k, s)| (k, Some(s))),
                };
                let v = Visit {
                    service: dep.as_ref().map(|d| d.0.clone()).unwrap_or_else(|| sp.service.to_string()),
                    kind: own.as_ref().map(|o| o.0).unwrap_or("server"),
                    system: own.and_then(|o| o.1),
                    start: sp.start,
                    end: sp.end,
                    error: sp.error,
                    name: sp.name.clone(),
                    route: attr_str(sp, "http.route"),
                    target: attr_str(sp, "url.path").or_else(|| attr_str(sp, "http.target")),
                    method: attr_str(sp, "http.request.method").or_else(|| attr_str(sp, "http.method")),
                    span_kind: sp.kind,
                    bytes: payload_bytes([via.map(|x| &spans[x]), Some(sp)]),
                    children: vec![],
                    server_spans: 0.0,
                    self_ms: 0.0,
                };
                arena.v.push(v);
                let vi = arena.v.len() - 1;
                match owner {
                    Some(o) => arena.v[o].children.push(vi),
                    None => tops.push(vi),
                }
                current = Some(vi);
            } else if let Some(c) = current {
                if arena.v[c].route.is_none() {
                    // the route template often sits on a framework span inside the visit
                    let r = attr_str(sp, "http.route").or_else(|| route_in_name(&sp.name));
                    if let Some(r) = r {
                        arena.v[c].route = Some(r);
                    }
                }
            }
        }
        if let Some(c) = current {
            if !ignored && (sp.kind == "server" || sp.kind == "consumer") && *sp.service == *arena.v[c].service {
                arena.v[c].server_spans += 1.0;
            }
        }
        if let Some(ks) = kids.get(sp.span_id.as_str()) {
            for &k in ks {
                let via = if sp.kind == "client" || sp.kind == "producer" { Some(i) } else { None };
                walk(k, current, via, spans, by_id, kids, ignore, arena, tops);
            }
        }
    }

    for r in roots {
        walk(r, None, None, spans, &by_id, &kids, ignore, arena, &mut tops);
    }
    // each orphan hangs under the innermost visit whose time span contains it
    let mut all: Vec<usize> = vec![];
    fn collect(v: usize, arena: &Arena, all: &mut Vec<usize>) {
        all.push(v);
        for &c in &arena.v[v].children {
            collect(c, arena, all);
        }
    }
    for &t in &tops {
        collect(t, arena, &mut all);
    }
    js_sort_by(&mut orphans, |a, b| spans[*a].start - spans[*b].start);
    for o in orphans {
        let os = &spans[o];
        let mut best: Option<usize> = None;
        for &v in &all {
            let vv = &arena.v[v];
            if vv.start <= os.start + 1.0 && vv.end >= os.end - 1.0 && best.map(|b| vv.end - vv.start < arena.v[b].end - arena.v[b].start).unwrap_or(true) {
                best = Some(v);
            }
        }
        let before = tops.len();
        walk(o, best, None, spans, &by_id, &kids, ignore, arena, &mut tops);
        // a new top-level visit (no caller found) can host the orphans that follow
        for &v in &tops[before..].to_vec() {
            collect(v, arena, &mut all);
        }
        if let Some(b) = best {
            for c in arena.v[b].children.clone() {
                if !all.contains(&c) {
                    collect(c, arena, &mut all);
                }
            }
        }
    }
    tops
}

/// union length of intervals clipped to [lo, hi]
fn covered(iv: &[(f64, f64)], lo: f64, hi: f64) -> f64 {
    let mut xs: Vec<(f64, f64)> = iv.iter().map(|(a, b)| (lo.max(*a), hi.min(*b))).filter(|(a, b)| b > a).collect();
    js_sort_by(&mut xs, |a, b| a.0 - b.0);
    let (mut total, mut cs, mut ce) = (0.0, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for (a, b) in xs {
        if a > ce {
            if ce > cs {
                total += ce - cs;
            }
            cs = a;
            ce = b;
        } else {
            ce = ce.max(b);
        }
    }
    if ce > cs {
        total += ce - cs;
    }
    total
}

/// ms of the critical path owned by each service, walking back from the end of the visit
fn critical_path(v: usize, hi: f64, arena: &Arena, acc: &mut IndexMap<String, f64>) {
    let vv = &arena.v[v];
    let end = vv.end.min(hi);
    let mut cursor = end;
    let mut kids = vv.children.clone();
    js_sort_by(&mut kids, |a, b| arena.v[*b].end - arena.v[*a].end);
    for k in kids {
        let kk = &arena.v[k];
        if kk.start >= cursor {
            continue;
        }
        let k_end = kk.end.min(cursor);
        *acc.entry(vv.service.clone()).or_insert(0.0) += cursor - k_end;
        critical_path(k, k_end, arena, acc);
        cursor = vv.start.max(kk.start);
    }
    *acc.entry(vv.service.clone()).or_insert(0.0) += (cursor - vv.start).max(0.0);
}

fn self_times(v: usize, arena: &mut Arena) {
    let iv: Vec<(f64, f64)> = arena.v[v].children.iter().map(|&c| (arena.v[c].start, arena.v[c].end)).collect();
    let (s, e) = (arena.v[v].start, arena.v[v].end);
    arena.v[v].self_ms = (e - s - covered(&iv, s, e)).max(0.0);
    for c in arena.v[v].children.clone() {
        self_times(c, arena);
    }
}

/// an id-looking path segment: numbers, UUIDs, hex, or opaque codes with digits
fn id_segment(seg: &str) -> bool {
    let b = seg.as_bytes();
    if b.is_empty() {
        return false;
    }
    if b.iter().all(|c| c.is_ascii_digit()) {
        return true;
    }
    let hex = |c: &u8| c.is_ascii_digit() || (b'a'..=b'f').contains(c);
    if b.len() >= 8 && b.iter().all(hex) {
        return true;
    }
    if b.len() == 36 && b.iter().all(|c| hex(c) || *c == b'-') {
        return true;
    }
    let word = |c: &u8| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'-';
    b.len() >= 6 && b.iter().all(word) && b.iter().any(|c| c.is_ascii_digit())
}

fn template_segments(path: &str) -> String {
    let p = path.split('?').next().unwrap_or("");
    let t = p.split('/').map(|seg| if id_segment(seg) { "{id}" } else { seg }).collect::<Vec<_>>().join("/");
    if t.is_empty() {
        "/".into()
    } else {
        t
    }
}

/// a span or route name as an endpoint name: query string dropped, id-looking path segments → {id}
pub fn template_path(name: &str) -> String {
    let t = name.trim();
    // ^((?:HTTP )?[A-Z]+ )?(\S*)(.*)$ — the optional group is a method word (or "HTTP" plus one)
    let method_word = |x: &str| -> Option<usize> {
        let k = x.bytes().take_while(|c| c.is_ascii_uppercase()).count();
        if k > 0 && x[k..].starts_with(' ') {
            Some(k + 1)
        } else {
            None
        }
    };
    let (prefix, rest): (&str, &str) = match t.strip_prefix("HTTP ").and_then(method_word) {
        Some(k) => (&t[..5 + k], &t[5 + k..]),
        None => match method_word(t) {
            Some(k) => (&t[..k], &t[k..]),
            None => ("", t),
        },
    };
    let ws = rest.find(char::is_whitespace).unwrap_or(rest.len());
    let (path, tail) = (&rest[..ws], &rest[ws..]);
    if !path.starts_with('/') {
        return t.strip_prefix("HTTP ").unwrap_or(t).to_string();
    }
    format!("{}{}{}", prefix.strip_prefix("HTTP ").unwrap_or(prefix), template_segments(path), tail)
}

pub fn endpoint_id(service: &str, name: &str, route: Option<&str>, target: Option<&str>, method: Option<&str>) -> String {
    let method = method.filter(|m| !m.is_empty()).map(|m| format!("{} ", m.to_uppercase())).unwrap_or_default();
    if let Some(r) = route.filter(|r| !r.is_empty()) {
        return format!("{} {}{}", service, method, r);
    }
    // a bare method name ("GET") says nothing: fall back to the request path with ids templated
    let u = name.trim().to_uppercase();
    let generic = matches!(u.strip_prefix("HTTP ").unwrap_or(&u), "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS");
    if let Some(t) = target.filter(|t| !t.is_empty()) {
        if generic || !name.contains('/') {
            return format!("{} {}{}", service, method, template_segments(t));
        }
    }
    format!("{} {}", service, name.strip_prefix("HTTP ").unwrap_or(name))
}

#[derive(Clone, Debug, Default)]
pub struct TraceImportOptions {
    pub step_s: f64,
    pub sampling: Option<f64>,
    pub ignore_services: Vec<String>,
    pub rename: Map<String>,
    pub series: Option<(bool, bool, bool)>,
    /// the clients' timeout: a request that lasted 80% of it ran into it
    pub timeout_ms: Option<f64>,
}

fn mean(xs: &[f64]) -> f64 {
    xs.iter().fold(0.0, |a, x| a + x) / xs.len() as f64
}

fn sorted(xs: &[f64]) -> Vec<f64> {
    let mut s = xs.to_vec();
    js_sort_by(&mut s, |a, b| a - b);
    s
}

/// fold spans into topology + per-bucket series on the builder
pub fn build_topology(spans: &mut [Span], b: Option<&mut DatasetBuilder>, o: &TraceImportOptions) -> Topology {
    let ignore: IndexSet<String> = o.ignore_services.iter().cloned().collect();
    for s in spans.iter_mut() {
        if let Some(r) = o.rename.get(s.service.as_ref()).filter(|r| !r.is_empty()) {
            s.service = r.as_str().into();
        }
    }
    let sampling = o.sampling.unwrap_or(1.0);
    let mut by_trace: IndexMap<String, Vec<Span>> = IndexMap::new();
    for s in spans.iter() {
        by_trace.entry(s.trace_id.clone()).or_default().push(s.clone());
    }
    struct Svc {
        n: f64,
        self_: Vec<f64>,
        incl: Vec<f64>,
        kind: &'static str,
        system: Option<String>,
        server_spans: f64,
    }
    struct Ep {
        service: String,
        n: f64,
        err: f64,
        dur: Vec<f64>,
        calls: IndexMap<String, f64>,
        visits: IndexMap<String, f64>,
        cp: IndexMap<String, f64>,
        bytes: IndexMap<String, f64>,
    }
    struct Cell {
        n: f64,
        err: f64,
        self_: Vec<f64>,
        incl: Vec<f64>,
    }
    struct ECell {
        n: f64,
        err: f64,
        dur: Vec<f64>,
        /// the requests that completed: none of their calls outlived them
        whole: Vec<f64>,
    }
    let mut svc: IndexMap<String, Svc> = IndexMap::new();
    let mut edges: IndexMap<String, (f64, f64, f64)> = IndexMap::new();
    let mut eps: IndexMap<String, Ep> = IndexMap::new();
    let step = o.step_s;
    let mut sb: IndexMap<String, IndexMap<u64, Cell>> = IndexMap::new();
    let mut done: IndexMap<String, IndexMap<u64, f64>> = IndexMap::new();
    let mut eb: IndexMap<String, IndexMap<u64, ECell>> = IndexMap::new();
    let (mut t_min, mut t_max) = (f64::INFINITY, f64::NEG_INFINITY);
    let mut traces = 0.0;

    for tr in by_trace.values() {
        let mut arena = Arena { v: vec![] };
        let roots = visits_of(tr, &ignore, &mut arena);
        for root in roots {
            // background work (timers, DNS lookups at startup) is not a request anyone made
            let r = &arena.v[root];
            if r.span_kind != "server" && r.span_kind != "consumer" && r.kind == "server" {
                continue;
            }
            traces += 1.0;
            self_times(root, &mut arena);
            let mut cp: IndexMap<String, f64> = IndexMap::new();
            let rend = arena.v[root].end;
            critical_path(root, rend, &arena, &mut cp);
            let r = &arena.v[root];
            let id = endpoint_id(&r.service, &r.name, r.route.as_deref(), r.target.as_deref(), r.method.as_deref());
            let ep = eps.entry(id.clone()).or_insert_with(|| Ep { service: r.service.clone(), n: 0.0, err: 0.0, dur: vec![], calls: IndexMap::new(), visits: IndexMap::new(), cp: IndexMap::new(), bytes: IndexMap::new() });
            ep.n += 1.0;
            let dur = r.end - r.start;
            ep.dur.push(dur);
            let mut failed = false;
            // depth-first, as the recursive walk does
            let mut stack: Vec<(usize, Option<usize>)> = vec![(root, None)];
            while let Some((v, parent)) = stack.pop() {
                let vv = &arena.v[v];
                failed = failed || (v == root && vv.error);
                *ep.visits.entry(vv.service.clone()).or_insert(0.0) += 1.0;
                let s = svc.entry(vv.service.clone()).or_insert_with(|| Svc { n: 0.0, self_: vec![], incl: vec![], kind: vv.kind, system: vv.system.clone(), server_spans: 0.0 });
                s.n += 1.0;
                s.server_spans += vv.server_spans;
                s.self_.push(vv.self_ms);
                s.incl.push(vv.end - vv.start);
                let bucket = (vv.start / 1000.0 / step).floor() * step;
                t_min = t_min.min(bucket);
                t_max = t_max.max(bucket);
                let cell = sb.entry(vv.service.clone()).or_default().entry(bucket.to_bits()).or_insert_with(|| Cell { n: 0.0, err: 0.0, self_: vec![], incl: vec![] });
                cell.n += 1.0;
                cell.err += if vv.error { 1.0 } else { 0.0 };
                cell.self_.push(vv.self_ms);
                cell.incl.push(vv.end - vv.start);
                let end_bucket = (vv.end / 1000.0 / step).floor() * step;
                *done.entry(vv.service.clone()).or_default().entry(end_bucket.to_bits()).or_insert(0.0) += 1.0;
                if let Some(p) = parent {
                    let key = format!("{}>{}", arena.v[p].service, vv.service);
                    *ep.calls.entry(key.clone()).or_insert(0.0) += 1.0;
                    let e = edges.entry(key.clone()).or_insert((0.0, 0.0, 0.0));
                    e.0 += 1.0;
                    if let Some(bytes) = vv.bytes {
                        e.1 += bytes;
                        e.2 += 1.0;
                        *ep.bytes.entry(key).or_insert(0.0) += bytes;
                    }
                }
                for &c in vv.children.iter().rev() {
                    stack.push((c, Some(v)));
                }
            }
            if failed {
                ep.err += 1.0;
            }
            for (k, ms) in cp {
                *ep.cp.entry(k).or_insert(0.0) += ms;
            }
            // a call that outlasted the request it served was abandoned: the request was cut off at a
            // timeout while a dependency hung, which is a failure, not how long it takes. So is one
            // that ran into the timeout with the hung call's spans never reported
            let cut = abandoned(root, dur, &arena) || o.timeout_ms.map(|t| dur >= 0.8 * t).unwrap_or(false);
            let bucket = (arena.v[root].start / 1000.0 / step).floor() * step;
            let cell = eb.entry(id).or_default().entry(bucket.to_bits()).or_insert_with(|| ECell { n: 0.0, err: 0.0, dur: vec![], whole: vec![] });
            cell.n += 1.0;
            cell.err += if failed { 1.0 } else { 0.0 };
            cell.dur.push(dur);
            if !cut {
                cell.whole.push(dur);
            }
        }
    }

    let span = if t_min.is_finite() { t_max - t_min + step } else { 0.0 };
    let mut services: Map<ServiceShape> = Map::new();
    for (id, s) in &svc {
        let self_ = sorted(&s.self_);
        let incl = sorted(&s.incl);
        services.insert(
            id.clone(),
            ServiceShape {
                spans: s.n,
                self_mean_ms: mean(&self_),
                self_p50_ms: quantile(&self_, 0.5),
                self_p99_ms: quantile(&self_, 0.99),
                mean_ms: mean(&incl),
                p99_ms: quantile(&incl, 0.99),
                kind: s.kind.into(),
                system: s.system.clone().filter(|x| !x.is_empty()),
                server_spans_per_visit: if s.server_spans > s.n * 1.05 { Some(s.server_spans / s.n) } else { None },
            },
        );
    }
    let mut endpoints: Map<EndpointShape> = Map::new();
    for (id, e) in &eps {
        let dur = sorted(&e.dur);
        let per = |m: &IndexMap<String, f64>| m.iter().map(|(k, v)| (k.clone(), v / e.n)).collect::<Map<f64>>();
        // the quietest buckets, until they hold at least 30% of the buckets and 100 requests
        let mut by_bucket: Vec<&ECell> = eb.get(id).map(|m| m.values().collect()).unwrap_or_default();
        js_sort_by(&mut by_bucket, |a, b| a.n - b.n);
        let mut low: Vec<f64> = vec![];
        for k in 0..by_bucket.len() {
            low.extend_from_slice(&by_bucket[k].whole);
            if (k + 1) as f64 >= by_bucket.len() as f64 * 0.3 && low.len() >= 100 {
                break;
            }
            if (k + 1) as f64 >= by_bucket.len() as f64 * 0.6 {
                break;
            }
        }
        let low = sorted(&low);
        let has_low = low.len() >= 20;
        endpoints.insert(
            id.clone(),
            EndpointShape {
                service: e.service.clone(),
                traces: e.n,
                calls: per(&e.calls),
                visits: per(&e.visits),
                critical_ms: per(&e.cp),
                mean_ms: mean(&dur),
                p50_ms: Some(quantile(&dur, 0.5)),
                p90_ms: Some(quantile(&dur, 0.9)),
                p99_ms: quantile(&dur, 0.99),
                low_mean_ms: if has_low { Some(mean(&low)) } else { None },
                low_p50_ms: if has_low { Some(quantile(&low, 0.5)) } else { None },
                low_p90_ms: if has_low { Some(quantile(&low, 0.9)) } else { None },
                low_p99_ms: if has_low { Some(quantile(&low, 0.99)) } else { None },
                bytes: per(&e.bytes),
                error_rate: e.err / e.n,
            },
        );
    }

    if let Some(b) = b {
        let (w_rps, w_lat, w_eps) = o.series.unwrap_or((true, true, true));
        for (id, m) in &sb {
            // services the metrics don't cover (uninstrumented databases, caches) still get rates from traces
            let fill = !w_rps && !b.has_service(id, "rps");
            let fill_lat = !w_lat && !b.has_service(id, "p99Ms");
            for (t, c) in m {
                let t = f64::from_bits(*t);
                let self_ = sorted(&c.self_);
                let incl = sorted(&c.incl);
                b.add_service(id, "selfMeanMs", t, mean(&self_), false);
                b.add_service(id, "selfP99Ms", t, quantile(&self_, 0.99), false);
                if w_rps || fill {
                    b.add_service(id, "rps", t, c.n / step / sampling, false);
                    b.add_service(id, "errorRate", t, c.err / c.n, false);
                }
                if w_lat || fill_lat {
                    b.add_service(id, "meanMs", t, mean(&incl), false);
                    b.add_service(id, "p50Ms", t, quantile(&incl, 0.5), false);
                    b.add_service(id, "p99Ms", t, quantile(&incl, 0.99), false);
                }
            }
        }
        for (id, m) in &done {
            for (t, n) in m {
                b.add_service(id, "doneRps", f64::from_bits(*t), n / step / sampling, false);
            }
        }
        if w_eps {
            for (id, m) in &eb {
                let service = endpoints[id].service.clone();
                for (t, c) in m {
                    let t = f64::from_bits(*t);
                    let dur = sorted(&c.dur);
                    b.add_endpoint(id, &service, "rps", t, c.n / step / sampling);
                    b.add_endpoint(id, &service, "errorRate", t, c.err / c.n);
                    b.add_endpoint(id, &service, "meanMs", t, mean(&dur));
                    b.add_endpoint(id, &service, "p50Ms", t, quantile(&dur, 0.5));
                    b.add_endpoint(id, &service, "p99Ms", t, quantile(&dur, 0.99));
                }
            }
        }
    }

    let edges_v: Vec<Value> = edges
        .iter()
        .map(|(k, e)| {
            let mut it = k.split('>');
            let from = it.next().unwrap_or("");
            let to = it.next().unwrap_or("");
            serde_json::json!({ "from": from, "to": to, "callsPerS": if span != 0.0 { e.0 / span / sampling } else { 0.0 }, "bytesPerCall": if e.2 != 0.0 { Value::from(e.1 / e.2) } else { Value::Null } })
        })
        .collect();
    Topology {
        services,
        edges: Value::Array(edges_v),
        endpoints,
        start: if t_min.is_finite() { t_min } else { 0.0 },
        end: if t_max.is_finite() { t_max + step } else { 0.0 },
        traces,
        sampling: o.sampling.filter(|s| *s != 0.0),
        sampling_check: None,
        rate_corrected: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// one Jaeger trace: frontend serves the request, checkout serves the call under it
    fn trace(k: usize, root_ms: f64, child_ms: f64) -> String {
        let t0 = 1_790_000_000_000_000u64 + k as u64 * 30_000_000;
        let span = |id: &str, parent: Option<&str>, p: &str, us: f64| {
            let refs = parent.map(|x| format!("[{{\"refType\":\"CHILD_OF\",\"traceID\":\"t{k}\",\"spanID\":\"{x}\"}}]")).unwrap_or("[]".into());
            format!("{{\"traceID\":\"t{k}\",\"spanID\":\"{id}\",\"operationName\":\"POST /api/checkout\",\"references\":{refs},\"startTime\":{t0},\"duration\":{us},\"tags\":[{{\"key\":\"span.kind\",\"type\":\"string\",\"value\":\"server\"}}],\"processID\":\"{p}\"}}")
        };
        format!(
            "{{\"data\":[{{\"traceID\":\"t{k}\",\"spans\":[{},{}],\"processes\":{{\"p1\":{{\"serviceName\":\"frontend\"}},\"p2\":{{\"serviceName\":\"checkout\"}}}}}}]}}",
            span("a", None, "p1", root_ms * 1000.0),
            span("b", Some("a"), "p2", child_ms * 1000.0)
        )
    }

    #[test]
    fn requests_cut_off_while_a_call_hung_are_not_the_quiet_time_latency() {
        // 5 requests cut off at a 5 s timeout while checkout hung for 18 s, 3 at the timeout whose
        // hung call never reported, then 40 ordinary ones
        let mut lines: Vec<String> = (0..5).map(|k| trace(k, 5000.0, 18000.0)).collect();
        lines.extend((5..8).map(|k| trace(k, 5001.0, 3.0)));
        lines.extend((8..48).map(|k| trace(k, 15.0, 10.0)));
        let mut spans = vec![];
        parse_trace_lines(lines.iter(), &mut spans).unwrap();
        let t = build_topology(&mut spans, None, &TraceImportOptions { step_s: 30.0, timeout_ms: Some(5000.0), ..Default::default() });
        let e = t.endpoints.values().next().unwrap();
        assert_eq!(e.traces, 48.0);
        // what users saw still counts in the whole history
        assert!(e.p99_ms >= 4999.0);
        // the quiet-time baseline is what a completed request takes
        assert!(e.low_p99_ms.unwrap() < 20.0, "{:?}", e.low_p99_ms);
    }
}
