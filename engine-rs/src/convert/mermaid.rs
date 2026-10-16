//! An architecture spec → a Mermaid flowchart, for a README, a design doc or a pull request: one
//! node per component (shaped by what it is), one arrow per connection with what the link carries,
//! zones and sections as subgraphs. Text only; nothing is simulated.

use crate::sim::spec::{check_architecture, issues_message, Architecture};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::OnceLock;

/// the catalogue's display label per kind ("db" → "Database")
fn labels() -> &'static HashMap<String, String> {
    static L: OnceLock<HashMap<String, String>> = OnceLock::new();
    L.get_or_init(|| {
        let c: Value = serde_json::from_str(include_str!("../cli/catalog.json")).unwrap_or(Value::Null);
        c["components"].as_array().map(|a| a.iter().filter_map(|k| Some((k["kind"].as_str()?.to_string(), k["label"].as_str()?.to_string()))).collect()).unwrap_or_default()
    })
}

/// a Mermaid node id: letters, digits and _ only, never a keyword
fn node_id(id: &str, taken: &mut HashMap<String, String>, used: &mut std::collections::HashSet<String>) -> String {
    if let Some(x) = taken.get(id) {
        return x.clone();
    }
    let mut base: String = id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' }).collect();
    if base.is_empty() || base.chars().next().map_or(false, |c| c.is_ascii_digit()) || ["end", "graph", "subgraph", "flowchart", "click", "style", "class", "classdef", "linkstyle", "direction"].contains(&base.to_ascii_lowercase().as_str()) {
        base = format!("n_{}", base);
    }
    let mut out = base.clone();
    let mut k = 2;
    while used.contains(&out) {
        out = format!("{}_{}", base, k);
        k += 1;
    }
    used.insert(out.clone());
    taken.insert(id.to_string(), out.clone());
    out
}

/// text inside a quoted Mermaid label
fn esc(s: &str) -> String {
    s.replace('"', "#quot;").replace('<', "#lt;").replace('>', "#gt;")
}

fn num(c: &serde_json::Map<String, Value>, k: &str) -> Option<f64> {
    c.get(k).and_then(|x| x.as_f64())
}

fn fmt_num(x: f64) -> String {
    crate::math::js_num(x)
}

/// the knobs worth a word on the diagram: size, instances, runtime, hit rate, the resilience knobs
fn details(c: &serde_json::Map<String, Value>) -> Vec<String> {
    let mut d = vec![];
    if let Some(t) = c.get("tier").and_then(|x| x.as_str()).filter(|t| *t != "S") {
        d.push(format!("size {}", t));
    }
    if let Some(a) = c.get("autoscale") {
        if let (Some(lo), Some(hi)) = (a.get("min").and_then(|x| x.as_f64()), a.get("max").and_then(|x| x.as_f64())) {
            d.push(format!("{}–{} autoscaled", fmt_num(lo), fmt_num(hi)));
        }
    } else if let Some(n) = num(c, "instances").filter(|n| *n > 1.0) {
        d.push(format!("×{}", fmt_num(n)));
    }
    if let Some(r) = c.get("runtime").and_then(|x| x.as_str()) {
        d.push(r.to_string());
    }
    if let Some(h) = num(c, "hitRate") {
        d.push(format!("{}% hits", fmt_num((h * 1000.0).round() / 10.0)));
    }
    if let Some(s) = num(c, "shards").filter(|s| *s > 1.0) {
        d.push(format!("{} shards", fmt_num(s)));
    }
    if let Some(l) = num(c, "limit") {
        d.push(format!("limit {}/s", fmt_num(l)));
    }
    if let Some(t) = num(c, "timeoutMs") {
        d.push(format!("timeout {} ms", fmt_num(t)));
    }
    if let Some(r) = num(c, "retries").filter(|r| *r > 0.0) {
        d.push(format!("{} retries", fmt_num(r)));
    }
    if c.get("breaker").and_then(|x| x.as_bool()) == Some(true) {
        d.push("breaker".into());
    }
    d
}

/// the node's text and shape: users a stadium, stores a cylinder, queues and streams a subroutine,
/// front doors a hexagon, edge caches a parallelogram, everything else a box
fn shape(kind: &str, text: &str) -> String {
    let t = esc(text);
    match kind {
        "client" => format!("([\"{}\"])", t),
        "db" | "replica" | "kv" | "storage" | "archive" | "search" | "vector" => format!("[(\"{}\")]", t),
        "queue" | "stream" => format!("[[\"{}\"]]", t),
        "lb" | "gateway" | "dns" => format!("{{{{\"{}\"}}}}", t),
        "cdn" | "edge" => format!("[/\"{}\"/]", t),
        "cache" => format!("((\"{}\"))", t),
        _ => format!("[\"{}\"]", t),
    }
}

/// a validated architecture as a Mermaid flowchart (left to right)
pub fn to_mermaid(arch: &Architecture) -> String {
    let labels = labels();
    let mut taken = HashMap::new();
    let mut used = std::collections::HashSet::new();
    let mut out = String::from("flowchart LR\n");
    let mut node_line: HashMap<String, String> = HashMap::new();
    let mut order: Vec<String> = vec![];
    for c in &arch.components {
        let id = c.get("id").and_then(|x| x.as_str()).unwrap_or_default().to_string();
        let kind = c.get("kind").and_then(|x| x.as_str()).unwrap_or_default();
        let name = c.get("name").and_then(|x| x.as_str()).unwrap_or(&id).to_string();
        let label = labels.get(kind).cloned().unwrap_or_else(|| kind.to_string());
        let mut text = format!("{}<br/>{}", esc(&name), esc(&label));
        let d = details(c);
        if !d.is_empty() {
            text = format!("{} · {}", text, esc(&d.join(" · ")));
        }
        // the label is already escaped; only the line break stays markup
        let line = format!("{}{}", node_id(&id, &mut taken, &mut used), shape(kind, "\u{0}").replace('\u{0}', &text));
        node_line.insert(id.clone(), line);
        order.push(id);
    }
    // sections (labelled frames, for reading) and zones (failure domains) as subgraphs, their members
    // inside; the rest at the top level. A node keeps to one subgraph: a zone wholly inside a section
    // is drawn inside it, and a node in a zone that reaches outside the section stays in its zone
    let mut placed = std::collections::HashSet::new();
    let in_zone: std::collections::HashSet<&String> = arch.zones.iter().flat_map(|z| z.2.iter()).filter(|m| node_line.contains_key(*m)).collect();
    let nested: Vec<Option<usize>> = arch
        .zones
        .iter()
        .map(|(_, _, members)| {
            let real: Vec<&String> = members.iter().filter(|m| node_line.contains_key(*m)).collect();
            if real.is_empty() {
                return None;
            }
            arch.sections.iter().position(|(_, sm)| real.iter().all(|m| sm.contains(m)))
        })
        .collect();
    let zone_block = |out: &mut String, zi: usize, indent: &str, taken: &mut HashMap<String, String>, used: &mut std::collections::HashSet<String>, placed: &mut std::collections::HashSet<String>| {
        let (zid, zlabel, members) = &arch.zones[zi];
        let sid = node_id(&format!("zone {}", zid), taken, used);
        out.push_str(&format!("{}subgraph {}[\"{}\"]\n", indent, sid, esc(zlabel.as_deref().unwrap_or(zid))));
        for m in members {
            if let Some(l) = node_line.get(m).filter(|_| !placed.contains(m)) {
                out.push_str(&format!("{}  {}\n", indent, l));
                placed.insert(m.clone());
            }
        }
        out.push_str(&format!("{}end\n", indent));
    };
    let mut dotted = vec![];
    for (si, (label, members)) in arch.sections.iter().enumerate() {
        let zones_here: Vec<usize> = (0..arch.zones.len()).filter(|zi| nested[*zi] == Some(si)).collect();
        let own: Vec<&String> = members.iter().filter(|m| node_line.contains_key(*m) && !placed.contains(*m) && !in_zone.contains(m)).collect();
        if zones_here.is_empty() && own.is_empty() {
            continue;
        }
        let sid = node_id(&format!("section {}", label), &mut taken, &mut used);
        out.push_str(&format!("  subgraph {}[\"{}\"]\n", sid, esc(label)));
        for zi in zones_here {
            zone_block(&mut out, zi, "    ", &mut taken, &mut used, &mut placed);
        }
        for m in own {
            if placed.insert(m.clone()) {
                out.push_str(&format!("    {}\n", node_line[m]));
            }
        }
        out.push_str("  end\n");
        dotted.push(sid);
    }
    for zi in 0..arch.zones.len() {
        if nested[zi].is_none() {
            zone_block(&mut out, zi, "  ", &mut taken, &mut used, &mut placed);
        }
    }
    for id in &order {
        if !placed.contains(id) {
            out.push_str(&format!("  {}\n", node_line[id]));
        }
    }
    for (from, to, lat) in &arch.connections {
        let (Some(a), Some(b)) = (taken.get(from).cloned(), taken.get(to).cloned()) else { continue };
        let key = (from.clone(), to.clone());
        let mut words = vec![];
        if let Some(l) = lat.filter(|l| *l > 0.0) {
            words.push(format!("+{} ms", fmt_num(l)));
        }
        if let Some(n) = arch.calls.get(&key) {
            words.push(format!("×{} calls", fmt_num(*n)));
        }
        if let Some(c) = arch.carries.get(&key) {
            words.push(c.clone());
        }
        if arch.sync.contains(&key) {
            words.push("sync".into());
        }
        if words.is_empty() {
            out.push_str(&format!("  {} --> {}\n", a, b));
        } else {
            out.push_str(&format!("  {} -->|\"{}\"| {}\n", a, esc(&words.join(" · ")), b));
        }
    }
    // a section is drawn dotted, as on the board: it groups for reading, it is not a failure domain
    for sid in dotted {
        out.push_str(&format!("  style {} stroke-dasharray: 4 4\n", sid));
    }
    out
}

/// a spec (any form the validator takes) as a Mermaid flowchart, or why it is not a spec
pub fn spec_to_mermaid(spec: &Value) -> Result<String, String> {
    let (arch, issues) = check_architecture(spec);
    arch.map(|a| to_mermaid(&a)).ok_or_else(|| issues_message(&issues))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_spec_becomes_a_flowchart_with_shapes_links_and_zones() {
        let spec = json!({
            "name": "shop",
            "components": [
                { "id": "users", "kind": "client" },
                { "id": "lb", "kind": "lb" },
                { "id": "api", "kind": "server", "instances": 4, "runtime": "go", "timeoutMs": 500, "retries": 2, "breaker": true },
                { "id": "redis", "kind": "cache", "hitRate": 0.85 },
                { "id": "end", "kind": "db", "tier": "M", "name": "orders \"db\"" },
                { "id": "end-replica", "kind": "replica" },
                { "id": "jobs", "kind": "queue" }
            ],
            "connections": ["users -> lb", "lb -> api", { "from": "api", "to": "redis", "carries": "reads" }, { "from": "api", "to": "end", "latencyMs": 1.5, "calls": 3 }, { "from": "end", "to": "end-replica", "replication": "sync" }, "api -> jobs"],
            "zones": [{ "id": "az-a", "label": "us-east-1a", "members": ["api", "end"] }]
        });
        let m = spec_to_mermaid(&spec).unwrap();
        let want = "flowchart LR
  subgraph zone_az_a[\"us-east-1a\"]
    api[\"api<br/>API Server · ×4 · go · timeout 500 ms · 2 retries · breaker\"]
    n_end[(\"orders #quot;db#quot;<br/>Database · size M\")]
  end
  users([\"users<br/>Users\"])
  lb{{\"lb<br/>Load Balancer\"}}
  redis((\"redis<br/>Cache · 85% hits\"))
  end_replica[(\"end-replica<br/>Read Replica\")]
  jobs[[\"jobs<br/>Queue\"]]
  users --> lb
  lb --> api
  api -->|\"reads\"| redis
  api -->|\"+1.5 ms · ×3 calls\"| n_end
  n_end -->|\"sync\"| end_replica
  api --> jobs
";
        assert_eq!(m, want, "\n{}", m);
    }

    #[test]
    fn sections_are_dotted_subgraphs_and_zones_keep_their_own() {
        let spec = json!({
            "components": [
                { "id": "users", "kind": "client" },
                { "id": "lb", "kind": "lb" },
                { "id": "api", "kind": "server" },
                { "id": "db", "kind": "db" },
                { "id": "cache", "kind": "cache" },
                { "id": "worker", "kind": "worker" }
            ],
            "connections": ["users -> lb", "lb -> api", "api -> db", "api -> cache", "api -> worker"],
            "zones": [{ "id": "a", "label": "us-east-1a", "members": ["cache", "worker"] }, { "id": "b", "label": "us-east-1b", "members": ["db"] }],
            "sections": [{ "label": "checkout path", "members": ["lb", "api", "db"] }, { "label": "empty", "members": ["gone"] }]
        });
        let m = spec_to_mermaid(&spec).unwrap();
        let want = "flowchart LR
  subgraph section_checkout_path[\"checkout path\"]
    subgraph zone_b[\"us-east-1b\"]
      db[(\"db<br/>Database\")]
    end
    lb{{\"lb<br/>Load Balancer\"}}
    api[\"api<br/>API Server\"]
  end
  subgraph zone_a[\"us-east-1a\"]
    cache((\"cache<br/>Cache\"))
    worker[\"worker<br/>Worker\"]
  end
  users([\"users<br/>Users\"])
  users --> lb
  lb --> api
  api --> db
  api --> cache
  api --> worker
  style section_checkout_path stroke-dasharray: 4 4
";
        assert_eq!(m, want, "\n{}", m);
        // a zone reaching outside the section keeps its node: the section takes the rest
        let mut spec2 = spec.clone();
        spec2["sections"] = json!([{ "label": "edge", "members": ["lb", "cache"] }]);
        let m2 = spec_to_mermaid(&spec2).unwrap();
        assert!(m2.contains("  subgraph section_edge[\"edge\"]\n    lb{{"), "{}", m2);
        assert!(m2.contains("  subgraph zone_a[\"us-east-1a\"]\n    cache(("), "{}", m2);
    }

    #[test]
    fn an_invalid_spec_says_why() {
        let e = spec_to_mermaid(&json!({ "components": [] })).unwrap_err();
        assert!(!e.is_empty());
    }
}
