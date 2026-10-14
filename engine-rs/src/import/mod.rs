//! Telemetry importers (src/backtest/import): metric exports, traces and cloud bills → a dataset on
//! one time grid. Everything is a file; nothing connects to a live system.

pub mod billing;
pub mod builder;
pub mod manifest;
pub mod metrics;
pub mod traces;

/// RFC 4180 CSV (quoted fields, embedded commas/newlines, doubled quotes); delimiter auto-detected
pub fn parse_csv(text: &str, delimiter: Option<char>) -> Vec<Vec<String>> {
    let first = match text.find('\n') {
        Some(i) if i > 0 => &text[..i],
        _ => text,
    };
    let d = delimiter.unwrap_or_else(|| {
        let mut best = (',', 0usize);
        for c in [',', '\t', ';'] {
            let k = first.split(c).count();
            if k > best.1 {
                best = (c, k);
            }
        }
        best.0
    });
    let chars: Vec<char> = text.chars().collect();
    let mut rows: Vec<Vec<String>> = vec![];
    let mut row: Vec<String> = vec![];
    let mut field = String::new();
    let mut quoted = false;
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if quoted {
            if ch == '"' {
                if chars.get(i + 1) == Some(&'"') {
                    field.push('"');
                    i += 1;
                } else {
                    quoted = false;
                }
            } else {
                field.push(ch);
            }
        } else if ch == '"' && field.is_empty() {
            quoted = true;
        } else if ch == d {
            row.push(std::mem::take(&mut field));
        } else if ch == '\n' || ch == '\r' {
            if ch == '\r' && chars.get(i + 1) == Some(&'\n') {
                i += 1;
            }
            row.push(std::mem::take(&mut field));
            if row.len() > 1 || !row[0].is_empty() {
                rows.push(std::mem::take(&mut row));
            } else {
                row.clear();
            }
        } else {
            field.push(ch);
        }
        i += 1;
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        if row.len() > 1 || !row[0].is_empty() {
            rows.push(row);
        }
    }
    rows
}

/// rows → records keyed by the header row
pub fn csv_objects(text: &str) -> Vec<indexmap::IndexMap<String, String>> {
    let rows = parse_csv(text, None);
    if rows.len() < 2 {
        return vec![];
    }
    let head: Vec<String> = rows[0].iter().map(|h| h.trim().to_string()).collect();
    rows[1..].iter().map(|r| head.iter().enumerate().map(|(i, h)| (h.clone(), r.get(i).cloned().unwrap_or_default())).collect()).collect()
}

/// JavaScript's parseFloat: the longest number at the start of the (trimmed) text, else NaN
pub fn js_parse_float(s: &str) -> f64 {
    let t = s.trim_start();
    if let Some(r) = t.strip_prefix("Infinity").map(|_| f64::INFINITY).or_else(|| t.strip_prefix("+Infinity").map(|_| f64::INFINITY)).or_else(|| t.strip_prefix("-Infinity").map(|_| f64::NEG_INFINITY)) {
        return r;
    }
    let b = t.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let ds = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    if i < b.len() && b[i] == b'.' {
        i += 1;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
    }
    if i == ds || (i == ds + 1 && b[ds] == b'.') {
        return f64::NAN;
    }
    let mut end = i;
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let mut j = i + 1;
        if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
            j += 1;
        }
        let es = j;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j > es {
            end = j;
        }
    }
    t[..end].parse().unwrap_or(f64::NAN)
}

/// JavaScript's Number(string): the whole (trimmed) text as a number, "" → 0, else NaN
pub fn js_number(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    if let Some(h) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return i64::from_str_radix(h, 16).map(|x| x as f64).unwrap_or(f64::NAN);
    }
    if t.ends_with('.') && t[..t.len() - 1].parse::<f64>().is_ok() {
        return t[..t.len() - 1].parse().unwrap();
    }
    if t.chars().any(|c| c.is_ascii_alphabetic() && c != 'e' && c != 'E') {
        return f64::NAN;
    }
    t.parse().unwrap_or(f64::NAN)
}

/// Number(v) of a JSON value
pub fn js_number_of(v: Option<&serde_json::Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(serde_json::Value::Null) => 0.0,
        Some(serde_json::Value::Bool(b)) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Some(serde_json::Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(serde_json::Value::String(s)) => js_number(s),
        Some(_) => f64::NAN,
    }
}

/// epoch seconds from epoch s/ms/ns numbers or ISO-8601 strings ("2026-09-14 12:03:00 UTC" too);
/// a date-time without a zone is read as UTC
pub fn parse_timestamp_num(v: f64) -> f64 {
    if v > 1e17 {
        v / 1e9
    } else if v > 1e12 {
        v / 1000.0
    } else {
        v
    }
}

pub fn parse_timestamp_str(s: &str) -> Option<f64> {
    let t = s.trim().trim_start_matches('"').trim_end_matches('"');
    if t.is_empty() {
        return None;
    }
    let numeric = {
        let u = t.strip_prefix('-').unwrap_or(t);
        let mut parts = u.splitn(2, '.');
        let a = parts.next().unwrap_or("");
        let b = parts.next();
        !a.is_empty() && a.bytes().all(|c| c.is_ascii_digit()) && b.map(|b| !b.is_empty() && b.bytes().all(|c| c.is_ascii_digit())).unwrap_or(true)
    };
    if numeric {
        return Some(parse_timestamp_num(js_parse_float(t)));
    }
    let mut x = t.replace(" UTC", "Z");
    // "2026-09-14 12:03:00" → "2026-09-14T12:03:00"
    let xb = x.as_bytes();
    if xb.len() > 11 && xb[10] == b' ' && xb[4] == b'-' && xb[7] == b'-' && xb[11].is_ascii_digit() {
        x.replace_range(10..11, "T");
    }
    crate::accuracy::parse_iso_ms(&x).map(|ms| ms as f64 / 1000.0)
}

pub fn parse_timestamp(v: Option<&serde_json::Value>) -> Option<f64> {
    match v {
        Some(serde_json::Value::Number(n)) => n.as_f64().map(parse_timestamp_num),
        Some(serde_json::Value::String(s)) => parse_timestamp_str(s),
        _ => None,
    }
}
