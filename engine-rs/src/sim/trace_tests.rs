//! Request journeys (trace.rs) on boards small enough to check by hand.

use super::des::{simulate_des, DesConfig, DesResult};
use super::trace::{Journey, SpanOut, TraceConfig};
use serde_json::json;

fn traced(spec: serde_json::Value, sc: serde_json::Value, tc: TraceConfig) -> DesResult {
    let cfg = DesConfig { service_cv: 0.0, trace: Some(tc), ..Default::default() };
    simulate_des(&spec, &sc, &cfg).unwrap()
}
fn hop<'a>(j: &'a Journey, id: &str) -> Vec<&'a SpanOut> {
    j.spans.iter().filter(|s| s.id == id).collect()
}
fn near(a: f64, b: f64) -> bool {
    (a - b).abs() <= 0.11
}

/// users →12 ms→ api (one worker, 100 ms a request) →5 ms→ db (a provider answering in 40 ms): each
/// hop's network is the link plus the 0.3 ms hop, the api's work 100 ms, the db's 40 ms, and the
/// request's time their sum plus whatever it queued at the api
#[test]
fn a_quiet_board_s_journey_adds_up_hop_by_hop() {
    let spec = json!({ "components": [{ "id": "users", "kind": "client" }, { "id": "api", "kind": "server", "capacity": 10, "latencyMs": 100 }, { "id": "db", "kind": "external", "latencyMs": 40 }], "connections": [{ "from": "users", "to": "api", "latencyMs": 12 }, { "from": "api", "to": "db", "latencyMs": 5 }] });
    let r = traced(spec, json!({ "duration": 20, "rps": 2 }), TraceConfig::default());
    let t = r.trace.expect("traced");
    assert!(t.journeys.len() >= 10, "{} journeys", t.journeys.len());
    let mut queued = 0;
    for j in &t.journeys {
        assert!(j.ok, "{:?}", j);
        assert_eq!(j.spans[0].id, "users");
        assert_eq!(j.spans[0].parent, -1);
        let (api, db) = (hop(j, "api"), hop(j, "db"));
        assert_eq!((api.len(), db.len()), (1, 1));
        let (api, db) = (api[0], db[0]);
        assert_eq!(api.parent, 0);
        assert_eq!(db.parent, 1);
        assert!(near(api.network_ms, 12.3) && near(db.network_ms, 5.3), "{} {}", api.network_ms, db.network_ms);
        assert!(near(api.service_ms, 100.0) && near(db.service_ms, 40.0), "{} {}", api.service_ms, db.service_ms);
        assert!(near(db.wait_ms, 0.0));
        assert_eq!((api.outcome, db.outcome), ("ok", "ok"));
        // the api answers when the db has: its time covers the call
        assert!(near(api.end_ms.unwrap(), db.end_ms.unwrap()));
        assert!(near(j.ms, 12.3 + api.wait_ms + 100.0 + 5.3 + 40.0), "{} vs {}", j.ms, 157.6 + api.wait_ms);
        if api.wait_ms > 0.0 {
            queued += 1;
            // it waited for the one ahead of it (at 2 req/s, rarely two ahead)
            assert!(api.wait_ms <= 200.0, "{}", api.wait_ms);
        }
    }
    assert!(queued < t.journeys.len());
    assert!(t.by_node["api"].all.len() <= 8 && t.by_node["api"].failed.is_empty());
}

/// the db (one worker, 100 ms, a queue of 1 s) gets 50 req/s against its 10: the api's 500 ms
/// deadline passes while its call waits in the queue, the api retries once, 1 ms later, and that
/// retry times out too or is shed by the full queue
#[test]
fn a_timeout_and_its_retry_are_marked_where_they_happened() {
    let spec = json!({ "components": [{ "id": "users", "kind": "client" }, { "id": "api", "kind": "server", "capacity": 1000, "latencyMs": 2, "timeoutMs": 500, "retries": 1 }, { "id": "db", "kind": "server", "capacity": 10, "latencyMs": 100, "queueS": 1 }], "connections": ["users -> api", "api -> db"] });
    let r = traced(spec, json!({ "duration": 20, "rps": 50 }), TraceConfig { from_s: 5.0, ..Default::default() });
    let t = r.trace.expect("traced");
    let failed: Vec<&Journey> = t.journeys.iter().filter(|j| !j.ok).collect();
    assert!(!failed.is_empty() && !t.by_node["db"].failed.is_empty());
    let mut timeouts = 0;
    let mut sheds = 0;
    for j in &failed {
        let dbs = hop(j, "db");
        let first = dbs[0];
        assert_eq!((first.attempt, first.via), (0, "call"));
        if first.outcome == "failed" {
            // shed at once, and the retry was too
            assert_eq!((first.reason, first.origin.as_deref()), (Some("overloaded"), Some("db")));
        } else {
            // every hop of the first try was given up on at the deadline, 500 ms after it was sent
            assert_eq!(first.outcome, "timeout");
            assert_eq!(first.deadline_ms, Some(500.0));
            assert!(near(first.gave_up_ms.unwrap() - first.sent_ms, 500.0));
        }
        assert_eq!(dbs.len(), 2, "first try and one retry: {:?}", j);
        let retry = dbs[1];
        assert_eq!((retry.attempt, retry.via), (1, "retry"));
        // the retry leaves 1 ms after the first try's outcome (the immediate policy)
        let first_out = first.gave_up_ms.or(first.end_ms).unwrap();
        assert!(near(retry.sent_ms, first_out + 1.0), "{} {}", retry.sent_ms, first_out);
        match retry.outcome {
            "timeout" => {
                timeouts += 1;
                assert_eq!(j.failed_at.as_deref(), Some("api"));
                assert_eq!(j.reason, Some("timed out waiting on its calls"));
            }
            "failed" => {
                sheds += 1;
                assert_eq!((retry.reason, retry.origin.as_deref()), (Some("overloaded"), Some("db")));
                // refused on arrival: no wait, no work, answered in 0.5 ms
                assert!(retry.start_ms.is_none());
                assert!(near(retry.end_ms.unwrap() - retry.arrive_ms.unwrap(), 0.5));
                assert_eq!((j.failed_at.as_deref(), j.reason), (Some("db"), Some("overloaded")));
            }
            o => panic!("retry {}", o),
        }
        // the api's own hop failed, with the reason the user got
        let api = hop(j, "api")[0];
        assert_eq!((api.outcome, api.reason), ("failed", j.reason));
    }
    assert!(timeouts > 0 && sheds > 0, "timeouts {} sheds {}", timeouts, sheds);
    // a request that got through was answered within its deadline
    let waited: Vec<f64> = t.journeys.iter().filter(|j| j.ok).flat_map(|j| hop(j, "db")).filter(|s| s.outcome == "ok").map(|s| s.wait_ms + s.service_ms).collect();
    assert!(waited.iter().all(|w| *w <= 500.0), "{:?}", waited);
}

#[test]
fn a_dead_component_is_where_the_journey_fails_and_a_cache_hit_ends_it() {
    let spec = json!({ "components": [{ "id": "users", "kind": "client" }, { "id": "api", "kind": "server", "capacity": 1000, "latencyMs": 2 }, { "id": "cache", "kind": "cache", "hitRate": 0.5 }, { "id": "db", "kind": "db" }], "connections": ["users -> api", "api -> cache", "cache -> db"] });
    let sc = json!({ "duration": 10, "rps": 20, "readRatio": 1, "events": [{ "at": 0, "action": { "type": "kill-id", "id": "db" } }] });
    let t = traced(spec, sc, TraceConfig::default()).trace.unwrap();
    let (mut hits, mut down) = (0, 0);
    for j in &t.journeys {
        let cache = hop(j, "cache")[0];
        if j.ok {
            hits += 1;
            assert_eq!(cache.outcome, "hit");
            assert!(hop(j, "db").is_empty());
        } else {
            down += 1;
            assert_eq!((j.failed_at.as_deref(), j.reason), (Some("db"), Some("down")));
            let db = hop(j, "db")[0];
            assert_eq!((db.outcome, db.origin.as_deref()), ("failed", Some("db")));
            // the cache passes the failure on: failed, started at the db
            assert_eq!((cache.outcome, cache.origin.as_deref()), ("failed", Some("db")));
        }
    }
    assert!(hits > 0 && down > 0, "hits {} down {}", hits, down);
}

#[test]
fn a_fan_out_s_parts_are_siblings() {
    let spec = json!({ "components": [{ "id": "users", "kind": "client" }, { "id": "api", "kind": "server", "capacity": 1000, "latencyMs": 2, "routing": "fanout" }, { "id": "a", "kind": "external", "latencyMs": 10 }, { "id": "b", "kind": "external", "latencyMs": 30 }], "connections": ["users -> api", "api -> a", "api -> b"] });
    let t = traced(spec, json!({ "duration": 5, "rps": 10 }), TraceConfig::default()).trace.unwrap();
    assert!(!t.journeys.is_empty());
    for j in &t.journeys {
        let (a, b) = (hop(j, "a")[0], hop(j, "b")[0]);
        assert_eq!((a.parent, b.parent, a.via, b.via), (1, 1, "fanout", "fanout"));
        // the api answers when the slower part has
        assert!(near(hop(j, "api")[0].end_ms.unwrap(), b.end_ms.unwrap()));
    }
}

/// following requests reads the run and changes nothing in it; what it keeps is bounded
#[test]
fn tracing_leaves_the_run_unchanged_and_keeps_a_bounded_sample() {
    let spec = json!({ "components": [{ "id": "users", "kind": "client" }, { "id": "lb", "kind": "lb" }, { "id": "api", "kind": "server", "instances": 2, "timeoutMs": 300, "retries": 2, "breaker": true }, { "id": "cache", "kind": "cache" }, { "id": "db", "kind": "db", "tier": "S" }], "connections": ["users -> lb", "lb -> api", "api -> cache", "cache -> db"] });
    let sc = json!({ "duration": 30, "rps": 1500, "events": [{ "at": 10, "action": { "type": "kill-id", "id": "db" } }, { "at": 20, "action": { "type": "revive-id", "id": "db" } }] });
    let plain = simulate_des(&spec, &sc, &DesConfig::default()).unwrap();
    let tc = TraceConfig { per_node: 3, ..Default::default() };
    let with = simulate_des(&spec, &sc, &DesConfig { trace: Some(tc), ..Default::default() }).unwrap();
    let strip = |r: &DesResult| {
        let mut v = serde_json::to_value(r).unwrap();
        v["summary"]["wallMs"] = json!(0);
        v.as_object_mut().unwrap().remove("trace");
        v
    };
    assert_eq!(strip(&plain), strip(&with));
    assert!(serde_json::to_value(&plain).unwrap().get("trace").is_none());
    let t = with.trace.unwrap();
    for (id, n) in &t.by_node {
        assert!(n.all.len() <= 3 && n.failed.len() <= 3, "{}: {:?}", id, n);
        for &i in n.all.iter().chain(&n.failed) {
            assert!(t.journeys[i].spans.iter().any(|s| &s.id == id));
        }
        for &i in &n.failed {
            assert!(!t.journeys[i].ok);
        }
    }
    assert!(t.journeys.len() <= 5 * 6, "{}", t.journeys.len());
    assert!(t.by_node["db"].seen_failed > 0.0);
}

/// the api (one worker, 100 ms a request, a queue bound of 0.5 s) gets 30 req/s against its 10: a
/// request is refused at once when the queue is full, or shed when it reaches the front after more
/// than 0.5 s in it; either way it was never worked on, and the wait it had is the queue's
#[test]
fn a_request_shed_from_the_queue_shows_the_wait_it_had() {
    let spec = json!({ "components": [{ "id": "users", "kind": "client" }, { "id": "api", "kind": "server", "capacity": 10, "latencyMs": 100, "queueS": 0.5 }], "connections": ["users -> api"] });
    // service times spread (the default), so some reach the front past the bound
    let cfg = DesConfig { trace: Some(TraceConfig { from_s: 5.0, ..Default::default() }), ..Default::default() };
    let t = simulate_des(&spec, &json!({ "duration": 20, "rps": 30 }), &cfg).unwrap().trace.unwrap();
    let (mut refused, mut waited) = (0, 0);
    for j in t.journeys.iter().filter(|j| !j.ok) {
        let api = hop(j, "api")[0];
        assert_eq!((api.reason, api.origin.as_deref()), (Some("overloaded"), Some("api")));
        assert!(api.start_ms.is_none() && api.service_ms == 0.0);
        if api.wait_ms == 0.0 {
            refused += 1;
        } else {
            waited += 1;
            assert!(api.wait_ms > 500.0 && api.wait_ms < 1500.0, "{}", api.wait_ms);
            assert!(near(api.end_ms.unwrap() - api.arrive_ms.unwrap(), api.wait_ms + 0.5));
        }
    }
    assert!(refused > 0 && waited > 0, "refused {} waited {}", refused, waited);
}
