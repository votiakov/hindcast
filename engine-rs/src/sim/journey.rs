//! One sampled request (a journey from the tracer) as text: the path row by row, the first call each
//! hop makes continuing on its row and the others (retries, fan-out parts, failover targets)
//! branching below the hop that made them, and a one-line verdict. The app's trace strip draws these
//! rows (through WebAssembly, src/ui/journey.ts), the CLI prints them (`simulate --trace`) and the MCP
//! tool `trace_request` returns them:
//!
//! ```text
//! users ─0.4ms─▶ api ══ 840ms queue + 12ms ══▶ db ✕ timeout (1 s)
//!                └─ retry 1 ─0.3ms─▶ db ✕ overloaded
//! ```
//!
//! Pure: the engine measured everything; this only words and places it.

use super::trace::{Journey, SpanOut};
use crate::math::{js_num, js_round, js_to_fixed};
use serde::Serialize;
use std::collections::HashMap;

fn fixed(x: f64, d: usize) -> String {
    js_num(js_to_fixed(x, d).parse::<f64>().unwrap_or(f64::NAN))
}

/// compact: 0.4ms, 12ms, 840ms, 1.21s
pub fn ms(x: f64) -> String {
    if x >= 1000.0 {
        format!("{}s", fixed(x / 1000.0, if x >= 10000.0 { 1 } else { 2 }))
    } else if x >= 10.0 {
        format!("{}ms", js_num(js_round(x)))
    } else {
        format!("{}ms", fixed(x, 1))
    }
}

/// a deadline as people set it: 500 ms, 1 s
fn deadline(x: f64) -> String {
    if x >= 1000.0 {
        format!("{} s", fixed(x / 1000.0, 2))
    } else {
        format!("{} ms", js_num(js_round(x)))
    }
}

pub struct HopTimes {
    /// the network on the way there
    pub net: f64,
    /// waiting in its queue for a worker (or still waiting when the caller gave up)
    pub wait: f64,
    /// its own work, not counting the calls it made
    pub work: f64,
    /// most of the hop was spent in the queue
    pub queued: bool,
    /// the call never reached it (refused before it left, or cut off)
    pub unreached: bool,
}

pub fn hop_times(j: &Journey, s: &SpanOut) -> HopTimes {
    let cut = s.gave_up_ms.or(s.end_ms).unwrap_or(j.ms);
    let stuck = s.outcome == "timeout" || s.outcome == "open";
    // the engine's wait covers one that was worked on, or shed after waiting; one still in the queue
    // when its caller gave up waited until then
    let wait = if s.start_ms.is_some() || s.wait_ms > 0.0 {
        s.wait_ms
    } else if let (true, Some(a)) = (stuck, s.arrive_ms) {
        (cut - a).max(0.0)
    } else {
        0.0
    };
    let work = if s.served_ms.is_some() {
        s.service_ms
    } else if let Some(st) = s.start_ms {
        (cut - st).max(0.0)
    } else {
        0.0
    };
    let net = s.network_ms;
    HopTimes { net, wait, work, queued: wait >= 1.0 && wait >= 0.25 * (net + work + wait), unreached: s.arrive_ms.is_none() }
}

/// what went wrong at this hop, in the engine's words; none where it only passed a failure on
pub fn fail_mark(j: &Journey, i: usize) -> Option<String> {
    let s = &j.spans[i];
    let timed_out_below = || j.spans.iter().any(|c| c.parent == i as i32 && c.outcome == "timeout");
    if s.outcome == "timeout" {
        // given up on with everything below it: the mark goes where the request was stuck
        if timed_out_below() {
            return None;
        }
        return Some(match s.deadline_ms {
            Some(d) => format!("timeout ({})", deadline(d)),
            None => "timeout".into(),
        });
    }
    let reason = s.reason.as_deref()?;
    if s.outcome != "failed" || s.origin.as_deref() != Some(s.id.as_str()) || reason.is_empty() {
        return None;
    }
    // a caller that timed out waiting: the hop it gave up on carries the mark
    if reason.starts_with("timed out") && timed_out_below() {
        return None;
    }
    Some(reason.to_string())
}

pub fn ok_mark(s: &SpanOut) -> Option<&'static str> {
    match s.outcome.as_str() {
        "hit" => Some("cache hit"),
        "queued" => Some("queued for its consumers"),
        _ => None,
    }
}

fn via_label(s: &SpanOut) -> String {
    match s.via.as_str() {
        "retry" => format!("retry {} ", s.attempt),
        "failover" => "failover ".into(),
        "routed" => "routed ".into(),
        _ => String::new(),
    }
}

/// the arrow into a hop: its network and own work, or a heavy one when it mostly queued
pub fn arrow(j: &Journey, s: &SpanOut) -> (String, bool) {
    let t = hop_times(j, s);
    if t.unreached {
        return ("──▶".into(), false);
    }
    if t.queued {
        let rest = if t.net + t.work >= 1.0 { format!(" + {}", ms(t.net + t.work)) } else { String::new() };
        return (format!("══ {} queue{} ══▶", ms(t.wait), rest), true);
    }
    (format!("─{}─▶", ms(t.net + t.work)), false)
}

/// a stretch of text in one tone: "" (plain), arrow, q (queued), bad, ok, name, focus (the component
/// asked about), dim (the branch lines)
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Run {
    pub t: String,
    pub c: &'static str,
}

/// the journey as rows of text runs (see the module's comment)
pub fn journey_rows(j: &Journey, name_of: &dyn Fn(&str) -> String, focus: Option<&str>) -> Vec<Vec<Run>> {
    let mut grid: Vec<Vec<(char, &'static str)>> = vec![];
    fn put(grid: &mut Vec<Vec<(char, &'static str)>>, row: usize, col: usize, text: &str, c: &'static str) -> usize {
        while grid.len() <= row {
            grid.push(vec![]);
        }
        let r = &mut grid[row];
        while r.len() < col {
            r.push((' ', ""));
        }
        let mut k = col;
        for ch in text.chars() {
            if k < r.len() {
                r[k] = (ch, c);
            } else {
                r.push((ch, c));
            }
            k += 1;
        }
        k
    }
    let mut kids: HashMap<usize, Vec<usize>> = HashMap::new();
    for (i, s) in j.spans.iter().enumerate() {
        if s.parent >= 0 {
            kids.entry(s.parent as usize).or_default().push(i);
        }
    }
    for v in kids.values_mut() {
        v.sort_by(|&a, &b| j.spans[a].sent_ms.partial_cmp(&j.spans[b].sent_ms).unwrap_or(std::cmp::Ordering::Equal).then(a.cmp(&b)));
    }
    struct Ctx<'a> {
        j: &'a Journey,
        name_of: &'a dyn Fn(&str) -> String,
        focus: Option<&'a str>,
        kids: &'a HashMap<usize, Vec<usize>>,
    }
    fn node(x: &Ctx, grid: &mut Vec<Vec<(char, &'static str)>>, i: usize, row: usize, col: usize) {
        let s = &x.j.spans[i];
        let mut c = put(grid, row, col, &(x.name_of)(&s.id), if Some(s.id.as_str()) == x.focus { "focus" } else { "name" });
        if let Some(bad) = fail_mark(x.j, i) {
            c = put(grid, row, c, &format!(" ✕ {}", bad), "bad");
        } else if let Some(ok) = ok_mark(s) {
            c = put(grid, row, c, &format!(" · {}", ok), "ok");
        }
        let empty = vec![];
        let ch = x.kids.get(&i).unwrap_or(&empty);
        let mut rows: Vec<usize> = vec![];
        for (n, &k) in ch.iter().enumerate() {
            let (text, queued) = arrow(x.j, &x.j.spans[k]);
            let tone = if queued { "q" } else { "arrow" };
            if n == 0 {
                let end = put(grid, row, c, &format!(" {} ", text), tone);
                node(x, grid, k, row, end);
                continue;
            }
            let r = grid.len();
            rows.push(r);
            let mut at = put(grid, r, col, if n == ch.len() - 1 { "└─ " } else { "├─ " }, "dim");
            let via = via_label(&x.j.spans[k]);
            if !via.is_empty() {
                at = put(grid, r, at, &via, "dim");
            }
            at = put(grid, r, at, &format!("{} ", text), tone);
            node(x, grid, k, r, at);
        }
        // the branch's stem, down to its last row
        if let Some(&last) = rows.last() {
            for r in row + 1..last {
                let blank = grid.get(r).and_then(|g| g.get(col)).map_or(true, |cell| cell.0 == ' ');
                if blank {
                    put(grid, r, col, "│", "dim");
                }
            }
        }
    }
    if !j.spans.is_empty() {
        node(&Ctx { j, name_of, focus, kids: &kids }, &mut grid, 0, 0, 0);
    }
    grid.into_iter()
        .map(|r| {
            let mut runs: Vec<Run> = vec![];
            for (ch, c) in r {
                match runs.last_mut() {
                    Some(last) if last.c == c => last.t.push(ch),
                    _ => runs.push(Run { t: ch.to_string(), c }),
                }
            }
            runs
        })
        .collect()
}

/// the rows as plain lines
pub fn journey_lines(j: &Journey, name_of: &dyn Fn(&str) -> String, focus: Option<&str>) -> Vec<String> {
    journey_rows(j, name_of, focus).into_iter().map(|r| r.into_iter().map(|x| x.t).collect()).collect()
}

/// the one-line summary: what it was, how long the user waited, and how it ended
pub fn journey_verdict(j: &Journey, name_of: &dyn Fn(&str) -> String) -> String {
    let kind = if j.read { "read" } else { "write" };
    if j.ok {
        return format!("{} · answered in {}", kind, ms(j.ms));
    }
    let at = j.failed_at.as_deref().map(|f| format!("{}: ", name_of(f))).unwrap_or_default();
    format!("{} · failed after {} · {}{}", kind, ms(j.ms), at, j.reason.as_deref().unwrap_or("failed"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn span(id: &str, parent: i32) -> SpanOut {
        SpanOut { id: id.into(), parent, via: "call".into(), attempt: 0, sent_ms: 0.0, arrive_ms: Some(0.0), start_ms: Some(0.0), served_ms: Some(0.0), end_ms: Some(0.0), network_ms: 0.0, wait_ms: 0.0, service_ms: 0.0, outcome: "ok".into(), reason: None, origin: None, gave_up_ms: None, deadline_ms: None }
    }

    /// the sketch the app's strip was designed on (test/journey.test.ts has the same journey)
    fn sketch() -> Journey {
        let failed = |mut s: SpanOut| {
            s.outcome = "failed".into();
            s.reason = Some("overloaded".into());
            s.origin = Some("db".into());
            s
        };
        let users = failed(SpanOut { end_ms: Some(1013.5), ..span("users", -1) });
        let lb = failed(SpanOut { arrive_ms: Some(12.0), start_ms: Some(12.0), served_ms: Some(12.4), end_ms: Some(1013.5), network_ms: 12.0, service_ms: 0.4, ..span("lb", 0) });
        let api = failed(SpanOut { sent_ms: 12.4, arrive_ms: Some(12.7), start_ms: Some(12.7), served_ms: Some(15.4), end_ms: Some(1013.5), network_ms: 0.3, service_ms: 2.7, ..span("api", 1) });
        let db = SpanOut { sent_ms: 15.4, arrive_ms: Some(15.7), start_ms: None, served_ms: None, end_ms: None, network_ms: 0.3, outcome: "timeout".into(), gave_up_ms: Some(1015.4), deadline_ms: Some(1000.0), ..span("db", 2) };
        let retry = failed(SpanOut { via: "retry".into(), attempt: 1, sent_ms: 1012.7, arrive_ms: Some(1013.0), start_ms: None, served_ms: None, end_ms: Some(1013.5), network_ms: 0.3, ..span("db", 2) });
        Journey { id: 1, at_s: 7.4, read: true, ms: 1013.5, ok: false, failed_at: Some("db".into()), reason: Some("overloaded".into()), truncated: false, spans: vec![users, lb, api, db, retry] }
    }

    #[test]
    fn the_sketch_reads_as_designed() {
        let j = sketch();
        let id = |s: &str| s.to_string();
        let lines = journey_lines(&j, &id, Some("db"));
        assert_eq!(lines, vec!["users ─12ms─▶ lb ─3ms─▶ api ══ 1000ms queue ══▶ db ✕ timeout (1 s)", "                        └─ retry 1 ─0.3ms─▶ db ✕ overloaded"]);
        // the asked-about component in its own tone
        assert!(journey_rows(&j, &id, Some("db"))[0].iter().any(|r| r.c == "focus" && r.t == "db"));
        assert_eq!(journey_verdict(&j, &id), "read · failed after 1.01s · db: overloaded");
    }

    #[test]
    fn numbers_read_as_in_the_app() {
        assert_eq!((ms(0.44), ms(9.96), ms(12.5), ms(840.0), ms(1013.5), ms(12345.0)), ("0.4ms".into(), "10ms".into(), "13ms".into(), "840ms".into(), "1.01s".into(), "12.3s".into()));
        assert_eq!((deadline(800.0), deadline(1000.0), deadline(2500.0)), ("800 ms".into(), "1 s".into(), "2.5 s".into()));
    }
}
