//! Availability in numbers: what a design's structure promises before any load test — components in
//! sequence multiply their availability, redundant ones (instances behind a balancer, a replica that
//! takes over, a failover route) multiply their unavailability. Per-unit numbers follow the public
//! SLAs of the managed services each kind stands for. A steady-state estimate: it ignores load,
//! correlated failures (a zone) and the seconds a failover takes — the audit replays those.
//! After The System Design Primer's "availability in numbers" (Donne Martin, CC BY 4.0).

use super::catalog::spec as kind_spec;
use super::spec::Architecture;
use serde::Serialize;
use serde_json::{Map as JMap, Value};
use std::collections::{HashMap, HashSet};

const HOURS_PER_YEAR: f64 = 8766.0;
/// how long a typical outage lasts before it is fixed, s: what DNS failover's lag is a share of
const OUTAGE_S: f64 = 1800.0;

/// one unit's availability: one instance, one database, one managed service
pub fn unit_availability(kind: &str) -> f64 {
    match kind {
        "client" => 1.0,
        "lb" => 0.9999,                                    // ELB SLA
        "gateway" | "function" => 0.9995,                  // API Gateway, Lambda SLAs
        "cdn" | "cache" | "storage" | "queue" => 0.999,     // CloudFront, ElastiCache, S3, SQS
        "archive" => 0.999,                                // S3 Glacier Instant Retrieval
        "edge" => 0.999,                                   // CloudFront (Functions run in it)
        "dns" => 1.0,                                      // Route 53: a 100% SLA (anycast, cached everywhere)
        "kv" => 0.9999,                                    // DynamoDB
        "llmapi" | "external" => 0.999,                    // someone else's service: what they promise
        _ => 0.995,                                        // one VM, one single-AZ database (EC2, RDS)
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WeakLink {
    pub id: String,
    pub name: String,
    /// downtime a year that would go away if this component never failed
    pub downtime_hours_per_year: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Availability {
    pub estimate: f64,
    /// −log10(1 − estimate): 3 is "three nines"
    pub nines: f64,
    pub downtime_hours_per_year: f64,
    pub downtime_minutes_per_month: f64,
    /// the components that cost the most downtime, worst first
    pub weakest: Vec<WeakLink>,
}

struct Graph<'a> {
    comps: HashMap<&'a str, &'a JMap<String, Value>>,
    kids: HashMap<&'a str, Vec<&'a str>>,
    pooled: HashSet<&'a str>,
    a: &'a Architecture,
    read_ratio: f64,
}

fn s<'a>(c: &'a JMap<String, Value>, k: &str) -> Option<&'a str> {
    c.get(k).and_then(|v| v.as_str())
}
fn n(c: &JMap<String, Value>, k: &str) -> Option<f64> {
    c.get(k).and_then(|v| v.as_f64())
}

impl<'a> Graph<'a> {
    fn new(a: &'a Architecture, read_ratio: f64) -> Self {
        let comps: HashMap<&str, &JMap<String, Value>> = a.components.iter().filter_map(|c| s(c, "id").map(|id| (id, c))).collect();
        let mut kids: HashMap<&str, Vec<&str>> = HashMap::new();
        let mut pooled = HashSet::new();
        for (from, to, _) in &a.connections {
            if from == to || !comps.contains_key(from.as_str()) || !comps.contains_key(to.as_str()) {
                continue;
            }
            kids.entry(from.as_str()).or_default().push(to.as_str());
            let fk = s(comps[from.as_str()], "kind").unwrap_or("server");
            if matches!(fk, "lb" | "gateway" | "queue") || n(comps[from.as_str()], "fanout").unwrap_or(1.0) > 1.0 {
                pooled.insert(to.as_str());
            }
        }
        Graph { comps, kids, pooled, a, read_ratio }
    }

    /// the component on its own: its units, redundant where they can stand in for each other
    fn own(&self, id: &str, perfect: Option<&str>) -> f64 {
        if perfect == Some(id) {
            return 1.0;
        }
        let c = self.comps[id];
        let kind = s(c, "kind").unwrap_or("server");
        let a = unit_availability(kind);
        let sp = kind_spec(kind);
        if sp.scalable && self.pooled.contains(id) {
            let units = c.get("autoscale").and_then(|x| x.get("min")).and_then(|x| x.as_f64()).or_else(|| n(c, "instances")).unwrap_or(1.0).max(1.0);
            return 1.0 - (1.0 - a).powf(units);
        }
        a
    }

    /// a request arriving here is answered: this component, and what it needs downstream
    fn avail(&self, id: &'a str, perfect: Option<&str>, path: &mut Vec<&'a str>) -> f64 {
        if path.contains(&id) {
            return 1.0;
        }
        path.push(id);
        let c = self.comps[id];
        let kind = s(c, "kind").unwrap_or("server");
        let own = self.own(id, perfect);
        let kids: Vec<&'a str> = self.kids.get(id).cloned().unwrap_or_default();
        let r = match kind {
            // producers are acknowledged by the queue: consumers are work for later
            "queue" => own,
            "db" => {
                // a replica promoted in the primary's place: the database is down only when all are
                let reps: Vec<&str> = kids.iter().copied().filter(|k| s(self.comps[k], "kind") == Some("replica")).collect();
                let down = reps.iter().fold(1.0 - own, |d, r| d * (1.0 - self.own(r, perfect)));
                1.0 - down
            }
            "replica" => own,
            "cache" | "cdn" => {
                let hit = n(c, "hitRate").unwrap_or(if kind == "cdn" { 0.6 } else { 0.85 }) * self.read_ratio;
                let origin = if kids.is_empty() { 0.0 } else { self.combine(id, &kids, perfect, path) };
                own * (hit + (1.0 - hit) * origin)
            }
            _ => {
                if kids.is_empty() {
                    own
                } else {
                    own * self.combine(id, &kids, perfect, path)
                }
            }
        };
        path.pop();
        r
    }

    /// what a caller's children give it, by how it calls them
    fn combine(&self, id: &str, kids: &[&'a str], perfect: Option<&str>, path: &mut Vec<&'a str>) -> f64 {
        let c = self.comps[id];
        let kind = s(c, "kind").unwrap_or("server");
        let carries = |k: &str| self.a.carries.get(&(id.to_string(), k.to_string())).map(|x| x.as_str());
        let classed = kids.iter().any(|k| carries(k).is_some());
        let group = |ks: Vec<&'a str>, path: &mut Vec<&'a str>| -> f64 {
            if ks.is_empty() {
                return 0.0;
            }
            let each: Vec<f64> = ks.iter().map(|k| self.avail(k, perfect, path)).collect();
            if kind == "dns" {
                // health-checked answers route around a dead target, but only after the checks notice
                // and cached answers expire: that lag, of each outage, is downtime for the share that
                // target had (failover: all of it for the first; otherwise an even share each)
                let lag = (n(c, "healthCheckS").unwrap_or(30.0) + n(c, "ttlS").unwrap_or(60.0) / 2.0) / OUTAGE_S;
                let failover = s(c, "routing") == Some("failover");
                let all_down: f64 = each.iter().map(|x| 1.0 - x).product();
                let lagged: f64 = each.iter().enumerate().map(|(i, x)| (1.0 - x) * if failover { if i == 0 { 1.0 } else { 0.0 } } else { 1.0 / each.len() as f64 }).sum::<f64>() * lag.min(1.0);
                return (1.0 - all_down - lagged).max(0.0);
            }
            match s(c, "routing") {
                Some("fanout") => each.iter().product(),
                // a balancer routes around a dead child; a failover route tries the next
                Some("failover") => 1.0 - each.iter().map(|x| 1.0 - x).product::<f64>(),
                _ if kind == "lb" || kind == "gateway" || kind == "dns" => 1.0 - each.iter().map(|x| 1.0 - x).product::<f64>(),
                // split without health checks: each request goes to one child
                _ => each.iter().sum::<f64>() / each.len() as f64,
            }
        };
        if !classed {
            return group(kids.to_vec(), path);
        }
        let reads: Vec<&'a str> = kids.iter().copied().filter(|k| carries(k) != Some("writes")).collect();
        let writes: Vec<&'a str> = kids.iter().copied().filter(|k| carries(k) != Some("reads")).collect();
        self.read_ratio * group(reads, path) + (1.0 - self.read_ratio) * group(writes, path)
    }

    fn total(&self, perfect: Option<&str>) -> f64 {
        let clients: Vec<&str> = self.comps.iter().filter(|(_, c)| s(c, "kind") == Some("client")).map(|(id, _)| *id).collect();
        if clients.is_empty() {
            return 0.0;
        }
        let mut path = vec![];
        let mut ids: Vec<&str> = clients;
        ids.sort();
        ids.iter().map(|id| self.avail(id, perfect, &mut path)).sum::<f64>() / ids.len() as f64
    }
}

pub fn availability(a: &Architecture, read_ratio: f64) -> Availability {
    let g = Graph::new(a, read_ratio);
    let estimate = g.total(None);
    let down = |x: f64| (1.0 - x).max(0.0) * HOURS_PER_YEAR;
    let mut weakest: Vec<WeakLink> = a
        .components
        .iter()
        .filter_map(|c| {
            let id = s(c, "id")?;
            if s(c, "kind") == Some("client") {
                return None;
            }
            let saved = down(estimate) - down(g.total(Some(id)));
            (saved > 0.05).then(|| WeakLink { id: id.to_string(), name: s(c, "name").unwrap_or(id).to_string(), downtime_hours_per_year: (saved * 10.0).round() / 10.0 })
        })
        .collect();
    weakest.sort_by(|x, y| y.downtime_hours_per_year.partial_cmp(&x.downtime_hours_per_year).unwrap_or(std::cmp::Ordering::Equal));
    weakest.truncate(3);
    let r6 = |x: f64| (x * 1e6).round() / 1e6;
    Availability {
        estimate: r6(estimate),
        nines: if estimate >= 1.0 { 9.0 } else { ((-(1.0 - estimate).log10()) * 100.0).round() / 100.0 },
        // tenths of an hour, or to the minute under an hour
        downtime_hours_per_year: if down(estimate) >= 1.0 { (down(estimate) * 10.0).round() / 10.0 } else { (down(estimate) * 60.0).round() / 60.0 },
        downtime_minutes_per_month: (down(estimate) / 12.0 * 60.0).round(),
        weakest,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::spec::parse_architecture;

    fn est(yaml: serde_json::Value) -> f64 {
        availability(&parse_architecture(&yaml).unwrap(), 0.8).estimate
    }

    #[test]
    fn in_sequence_multiply_in_parallel_unavailability_multiplies() {
        let one = est(serde_json::json!({ "components": [{ "id": "u", "kind": "client" }, { "id": "api", "kind": "server" }, { "id": "db", "kind": "db" }], "connections": [["u", "api"], ["api", "db"]] }));
        assert!((one - 0.995 * 0.995).abs() < 1e-6);
        let two = est(serde_json::json!({ "components": [{ "id": "u", "kind": "client" }, { "id": "lb", "kind": "lb" }, { "id": "api", "kind": "server", "instances": 2 }, { "id": "db", "kind": "db" }, { "id": "r", "kind": "replica" }], "connections": [["u", "lb"], ["lb", "api"], ["api", "db"], ["db", "r"]] }));
        let pair = 1.0 - 0.005f64.powi(2);
        assert!((two - 0.9999 * pair * pair).abs() < 1e-6);
    }
}
