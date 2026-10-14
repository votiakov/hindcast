//! Spec → YAML exactly as src/spec/yaml.ts writes it with the `yaml` package (2.x, lineWidth 0, no flow
//! padding): block style for structure, `a -> b` for plain connections, flow style for small objects.
//! The scalar rules follow the package's stringifyString / stringifyNumber; the layout its
//! stringifyCollection / stringifyPair.

use serde_json::Value;

enum Node {
    Scalar(Value),
    Map(Vec<(String, Node)>, bool),
    Seq(Vec<Node>, bool),
}

fn node(v: &Value) -> Node {
    match v {
        Value::Object(m) => Node::Map(m.iter().map(|(k, x)| (k.clone(), node(x))).collect(), false),
        Value::Array(a) => Node::Seq(a.iter().map(node).collect(), false),
        x => Node::Scalar(x.clone()),
    }
}

#[derive(Clone)]
struct Ctx {
    indent: String,
    in_flow: bool,
    implicit_key: bool,
}

const STEP: &str = "  ";

/// JSON.stringify of a string
fn json_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_default()
}

/// /^(%|---|\.\.\.)/m
fn contains_document_marker(s: &str) -> bool {
    s.split('\n').any(|l| l.starts_with('%') || l.starts_with("---") || l.starts_with("..."))
}

fn double_quoted(value: &str, ctx: &Ctx) -> String {
    let json: Vec<char> = json_string(value).chars().collect();
    let json_len16: usize = json.iter().map(|c| c.len_utf16()).sum();
    let indent = if !ctx.indent.is_empty() { ctx.indent.clone() } else if contains_document_marker(value) { "  ".into() } else { String::new() };
    let at = |i: usize| json.get(i).copied();
    let slice = |a: usize, b: usize| json[a.min(json.len())..b.min(json.len())].iter().collect::<String>();
    let mut out = String::new();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < json.len() {
        let mut ch = json[i];
        if ch == ' ' && at(i + 1) == Some('\\') && at(i + 2) == Some('n') {
            out += &slice(start, i);
            out += "\\ ";
            i += 1;
            start = i;
            ch = '\\';
        }
        if ch == '\\' {
            match at(i + 1) {
                Some('u') => {
                    out += &slice(start, i);
                    let code = slice(i + 2, i + 6);
                    match code.as_str() {
                        "0000" => out += "\\0",
                        "0007" => out += "\\a",
                        "000b" => out += "\\v",
                        "001b" => out += "\\e",
                        "0085" => out += "\\N",
                        "00a0" => out += "\\_",
                        "2028" => out += "\\L",
                        "2029" => out += "\\P",
                        _ => {
                            if code.starts_with("00") {
                                out += "\\x";
                                out += &code[2..];
                            } else {
                                out += &slice(i, i + 6);
                            }
                        }
                    }
                    i += 5;
                    start = i + 1;
                }
                Some('n') => {
                    if ctx.implicit_key || at(i + 2) == Some('"') || json_len16 < 40 {
                        i += 1;
                    } else {
                        // folding will eat the first newline
                        out += &slice(start, i);
                        out += "\n\n";
                        while at(i + 2) == Some('\\') && at(i + 3) == Some('n') && at(i + 4) != Some('"') {
                            out.push('\n');
                            i += 2;
                        }
                        out += &indent;
                        // a space after a newline is escaped so it is not folded
                        if at(i + 2) == Some(' ') {
                            out.push('\\');
                        }
                        i += 1;
                        start = i + 1;
                    }
                }
                _ => i += 1,
            }
        }
        i += 1;
    }
    if start > 0 {
        out + &slice(start, json.len())
    } else {
        json.iter().collect()
    }
}

/// /\n+/g → `$&` + extra
fn after_newlines(s: &str, extra: &str) -> String {
    let mut out = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        out.push(c);
        if c == '\n' && chars.peek() != Some(&'\n') {
            out += extra;
        }
    }
    out
}

fn single_quoted(value: &str, ctx: &Ctx) -> String {
    let ws_nl = value.contains(" \n") || value.contains("\t\n") || value.contains("\n ") || value.contains("\n\t");
    if (ctx.implicit_key && value.contains('\n')) || ws_nl {
        return double_quoted(value, ctx);
    }
    let indent = if !ctx.indent.is_empty() { ctx.indent.clone() } else if contains_document_marker(value) { "  ".into() } else { String::new() };
    format!("'{}'", after_newlines(&value.replace('\'', "''"), &format!("\n{}", indent)))
}

fn quoted(value: &str, ctx: &Ctx) -> String {
    let d = value.contains('"');
    let s = value.contains('\'');
    if d && !s {
        single_quoted(value, ctx)
    } else {
        double_quoted(value, ctx)
    }
}

fn block_string(value: &str, ctx: &Ctx, force_block_indent: bool) -> String {
    // /\n[\t ]+$/
    let tail_ws = {
        let t = value.trim_end_matches([' ', '\t']);
        t.len() < value.len() && t.ends_with('\n')
    };
    if tail_ws {
        return quoted(value, ctx);
    }
    let indent = if !ctx.indent.is_empty() { ctx.indent.clone() } else if force_block_indent || contains_document_marker(value) { "  ".into() } else { String::new() };
    if value.is_empty() {
        return "|\n".into();
    }
    let chars: Vec<char> = value.chars().collect();
    let mut end_start = chars.len();
    while end_start > 0 && matches!(chars[end_start - 1], '\n' | '\t' | ' ') {
        end_start -= 1;
    }
    let mut end: String = chars[end_start..].iter().collect();
    let chomp = match end.find('\n') {
        None => "-",
        Some(p) if end_start == 0 || p != end.len() - 1 => "+",
        _ => "",
    };
    let mut body: String = chars[..end_start].iter().collect();
    if !end.is_empty() {
        if end.ends_with('\n') {
            end.pop();
        }
        // (^|(?<!\n))\n+(?!\n|$): a run of newlines not at the end gets the indent after it
        end = indent_inner_newline_runs(&end, &indent);
    }
    let bc: Vec<char> = body.chars().collect();
    let mut start_with_space = false;
    let mut start_end = 0;
    let mut start_nl: isize = -1;
    while start_end < bc.len() {
        match bc[start_end] {
            ' ' => start_with_space = true,
            '\n' => start_nl = start_end as isize,
            _ => break,
        }
        start_end += 1;
    }
    let cut = if start_nl < start_end as isize { (start_nl + 1) as usize } else { start_end };
    let mut start: String = bc[..cut].iter().collect();
    if !start.is_empty() {
        body = bc[cut..].iter().collect();
        start = after_newlines(&start, &indent);
    }
    let indent_size = if indent.is_empty() { "1" } else { "2" };
    let header = format!("{}{}", if start_with_space { indent_size } else { "" }, chomp);
    let body = after_newlines(&body, &indent);
    format!("|{}\n{}{}{}{}", header, indent, start, body, end)
}

fn indent_inner_newline_runs(s: &str, indent: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < c.len() {
        if c[i] == '\n' {
            let mut j = i;
            while j < c.len() && c[j] == '\n' {
                j += 1;
            }
            for _ in i..j {
                out.push('\n');
            }
            if j < c.len() {
                out += indent;
            }
            i = j;
        } else {
            out.push(c[i]);
            i += 1;
        }
    }
    out
}

/// a string the core schema would read as something else: null, bool, int, float
fn looks_typed(s: &str) -> bool {
    let digits = |x: &str| !x.is_empty() && x.bytes().all(|b| b.is_ascii_digit());
    let unsigned = |x: &str| x.strip_prefix(['-', '+']).unwrap_or(x).to_string();
    if matches!(s, "" | "~" | "null" | "Null" | "NULL" | "true" | "True" | "TRUE" | "false" | "False" | "FALSE") {
        return true;
    }
    if let Some(o) = s.strip_prefix("0o") {
        if !o.is_empty() && o.bytes().all(|b| (b'0'..=b'7').contains(&b)) {
            return true;
        }
    }
    if digits(&unsigned(s)) {
        return true;
    }
    if let Some(h) = s.strip_prefix("0x") {
        if !h.is_empty() && h.bytes().all(|b| b.is_ascii_hexdigit()) {
            return true;
        }
    }
    let u = unsigned(s);
    if matches!(u.as_str(), ".inf" | ".Inf" | ".INF") || matches!(s, ".nan" | ".NaN" | ".NAN") {
        return true;
    }
    // [-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)[eE][-+]?[0-9]+  and  [-+]?(\.[0-9]+|[0-9]+\.[0-9]*)
    let mantissa_ok = |m: &str, need_dot: bool| -> bool {
        if let Some(f) = m.strip_prefix('.') {
            return digits(f);
        }
        match m.split_once('.') {
            Some((a, b)) => digits(a) && (b.is_empty() || digits(b)),
            None => !need_dot && digits(m),
        }
    };
    if let Some(p) = u.find(['e', 'E']) {
        let (m, e) = (&u[..p], &u[p + 1..]);
        let e = e.strip_prefix(['-', '+']).unwrap_or(e);
        if mantissa_ok(m, false) && digits(e) {
            return true;
        }
    }
    mantissa_ok(&u, true)
}

fn plain_string(value: &str, ctx: &Ctx) -> String {
    if (ctx.implicit_key && value.contains('\n')) || (ctx.in_flow && value.contains(['[', ']', '{', '}', ','])) {
        return quoted(value, ctx);
    }
    let first = value.chars().next();
    let last = value.chars().last();
    let bad = matches!(first, Some('\n' | '\t' | ' ' | ',' | '[' | ']' | '{' | '}' | '#' | '&' | '*' | '!' | '|' | '>' | '\'' | '"' | '%' | '@' | '`'))
        || value == "?"
        || value == "-"
        || value.starts_with("? ")
        || value.starts_with("?\t")
        || value.starts_with("- ")
        || value.starts_with("-\t")
        || value.contains("\n ")
        || value.contains("\n\t")
        || value.contains(": ")
        || value.contains(":\t")
        || value.contains(" \n")
        || value.contains("\t\n")
        || value.contains("\n#")
        || value.contains("\t#")
        || value.contains(" #")
        || matches!(last, Some('\n' | '\t' | ' ' | ':'));
    if bad {
        return if ctx.implicit_key || ctx.in_flow || !value.contains('\n') { quoted(value, ctx) } else { block_string(value, ctx, false) };
    }
    if !ctx.implicit_key && !ctx.in_flow && value.contains('\n') {
        return block_string(value, ctx, false);
    }
    if contains_document_marker(value) {
        if ctx.indent.is_empty() {
            return block_string(value, ctx, true);
        } else if ctx.implicit_key && ctx.indent == STEP {
            return quoted(value, ctx);
        }
    }
    let s = after_newlines(value, &format!("\n{}", ctx.indent));
    if looks_typed(&s) {
        return quoted(value, ctx);
    }
    s
}

fn string(value: &str, ctx: &Ctx) -> String {
    // control characters, C1 controls and lone surrogates: double-quoted
    if value.chars().any(|c| matches!(c as u32, 0x00..=0x08 | 0x0b..=0x1f | 0x7f..=0x9f)) {
        return double_quoted(value, ctx);
    }
    plain_string(value, ctx)
}

fn scalar(v: &Value, ctx: &Ctx) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => {
            let x = n.as_f64().unwrap_or(f64::NAN);
            if x.is_nan() {
                ".nan".into()
            } else if x.is_infinite() {
                if x < 0.0 { "-.inf" } else { ".inf" }.into()
            } else if x == 0.0 && x.is_sign_negative() {
                "-0".into()
            } else {
                crate::math::js_num(x)
            }
        }
        Value::String(s) => string(s, ctx),
        _ => String::new(),
    }
}

fn stringify(n: &Node, ctx: &Ctx) -> String {
    match n {
        Node::Scalar(v) => scalar(v, ctx),
        Node::Map(items, flow) => {
            if ctx.in_flow || *flow {
                flow_collection(items.iter().map(|(k, v)| Item::Pair(k, v)).collect(), ctx, ctx.indent.clone(), "{", "}")
            } else {
                block_collection(items.iter().map(|(k, v)| Item::Pair(k, v)).collect(), ctx, "", ctx.indent.clone(), "{}")
            }
        }
        Node::Seq(items, flow) => {
            if ctx.in_flow || *flow {
                flow_collection(items.iter().map(Item::Node).collect(), ctx, format!("{}  ", ctx.indent), "[", "]")
            } else {
                block_collection(items.iter().map(Item::Node).collect(), ctx, "- ", format!("{}  ", ctx.indent), "[]")
            }
        }
    }
}

enum Item<'a> {
    Pair(&'a String, &'a Node),
    Node(&'a Node),
}

fn item(it: &Item, ctx: &Ctx) -> String {
    match it {
        Item::Node(n) => stringify(n, ctx),
        Item::Pair(k, v) => pair(k, v, ctx),
    }
}

fn block_collection(items: Vec<Item>, ctx: &Ctx, prefix: &str, item_indent: String, empty: &str) -> String {
    if items.is_empty() {
        return empty.into();
    }
    let ictx = Ctx { indent: item_indent, in_flow: ctx.in_flow, implicit_key: false };
    let lines: Vec<String> = items.iter().map(|it| format!("{}{}", prefix, item(it, &ictx))).collect();
    let mut out = lines[0].clone();
    for l in &lines[1..] {
        if l.is_empty() {
            out.push('\n');
        } else {
            out += &format!("\n{}{}", ctx.indent, l);
        }
    }
    out
}

/// item_indent: what the collection hands its items (a sequence one step deeper than a map), before
/// the flow step is added
fn flow_collection(items: Vec<Item>, ctx: &Ctx, item_indent: String, start: &str, end: &str) -> String {
    if items.is_empty() {
        return format!("{}{}", start, end);
    }
    let ictx = Ctx { indent: format!("{}{}", item_indent, STEP), in_flow: true, implicit_key: false };
    let mut req_newline = false;
    let mut lines = vec![];
    let n = items.len();
    for (i, it) in items.iter().enumerate() {
        let mut s = item(it, &ictx);
        req_newline = req_newline || s.contains('\n');
        if i < n - 1 {
            s.push(',');
        }
        lines.push(s);
    }
    if req_newline {
        let mut out = start.to_string();
        for l in &lines {
            if l.is_empty() {
                out.push('\n');
            } else {
                out += &format!("\n{}{}{}", STEP, ctx.indent, l);
            }
        }
        format!("{}\n{}{}", out, ctx.indent, end)
    } else {
        format!("{}{}{}", start, lines.join(" "), end)
    }
}

fn pair(key: &str, value: &Node, ctx: &Ctx) -> String {
    let kctx = Ctx { indent: format!("{}{}", ctx.indent, STEP), in_flow: ctx.in_flow, implicit_key: true };
    let mut s = format!("{}:", string(key, &kctx));
    let vctx = Ctx { implicit_key: false, ..kctx };
    let vs = stringify(value, &vctx);
    let coll = |len: usize, flow: bool| {
        // ctx.inFlow ?? value.flow ?? value.items.length === 0
        let is_flow = ctx.in_flow || flow || len == 0;
        if vs.contains('\n') || !is_flow {
            format!("\n{}", vctx.indent)
        } else {
            " ".to_string()
        }
    };
    let ws = match value {
        Node::Map(items, flow) => coll(items.len(), *flow),
        Node::Seq(items, flow) => coll(items.len(), *flow),
        Node::Scalar(_) => {
            if vs.is_empty() || vs.starts_with('\n') {
                String::new()
            } else {
                " ".into()
            }
        }
    };
    s += &ws;
    s += &vs;
    s
}

/// JavaScript's \s
pub fn js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

/// specToYaml: connections as `a -> b` where both ends are plain ids; connection pairs, small objects
/// inside components and zone member lists in flow style
pub fn spec_to_yaml(spec: &Value) -> String {
    let mut root = node(spec);
    if let (Node::Map(items, _), Value::Object(o)) = (&mut root, spec) {
        if let Some(Value::Array(conns)) = o.get("connections") {
            let plain = |x: &Value| match x.as_str() {
                Some(s) => {
                    let mut cs = s.chars();
                    match cs.next() {
                        Some(f) if !js_space(f) && f != '>' && f != '-' => cs.all(|c| !js_space(c) && c != '>'),
                        _ => false,
                    }
                }
                None => false,
            };
            let arrows: Vec<Node> = conns
                .iter()
                .map(|c| match c {
                    Value::Array(a) if a.len() == 2 && a.iter().all(plain) => Node::Scalar(Value::String(format!("{} -> {}", a[0].as_str().unwrap(), a[1].as_str().unwrap()))),
                    x => node(x),
                })
                .collect();
            for (k, v) in items.iter_mut() {
                if k == "connections" {
                    *v = Node::Seq(arrows, false);
                    break;
                }
            }
        }
        for (k, v) in items.iter_mut() {
            match (k.as_str(), v) {
                ("connections", Node::Seq(cs, _)) => {
                    for c in cs.iter_mut() {
                        match c {
                            Node::Seq(_, f) | Node::Map(_, f) => *f = true,
                            _ => {}
                        }
                    }
                }
                ("components", Node::Seq(cs, _)) => {
                    for c in cs.iter_mut() {
                        if let Node::Map(ps, _) = c {
                            for (_, pv) in ps.iter_mut() {
                                if let Node::Map(_, f) = pv {
                                    *f = true;
                                }
                            }
                        }
                    }
                }
                ("zones", Node::Seq(zs, _)) => {
                    for z in zs.iter_mut() {
                        if let Node::Map(ps, _) = z {
                            for (_, pv) in ps.iter_mut() {
                                if let Node::Seq(_, f) = pv {
                                    *f = true;
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
    let ctx = Ctx { indent: String::new(), in_flow: false, implicit_key: false };
    format!("{}\n", stringify(&root, &ctx))
}
