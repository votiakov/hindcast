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
    /// the column a map value starts at (key and ': '), for folding
    indent_at_start: Option<usize>,
    /// 0: never fold (specToYaml); 80: the yaml package's default
    line_width: usize,
    /// ' ' inside non-empty flow collections (the default) or ''
    padding: bool,
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
    let res = if start > 0 { out + &slice(start, json.len()) } else { json.iter().collect() };
    if ctx.implicit_key {
        res
    } else {
        fold(&res, &indent, Fold::Quoted, ctx.indent_at_start, ctx.line_width).0
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
    let res = format!("'{}'", after_newlines(&value.replace('\'', "''"), &format!("\n{}", indent)));
    if ctx.implicit_key {
        res
    } else {
        fold(&res, &indent, Fold::Flow, ctx.indent_at_start, ctx.line_width).0
    }
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
    let literal = !line_length_over_limit(value, ctx.line_width, indent.chars().count());
    // folded (>): only where no line is more indented (the package keeps those unfolded with a
    // regular expression this port does not need: such values are written literally here)
    if !literal && !body.split('\n').any(|l| l.starts_with([' ', '\t'])) {
        let doubled = {
            // /\n+/g → '\n$&': each run of newlines gets one more
            let mut o = String::new();
            let mut prev_nl = false;
            for c in body.chars() {
                if c == '\n' && !prev_nl {
                    o.push('\n');
                }
                prev_nl = c == '\n';
                o.push(c);
            }
            o
        };
        let folded_value = after_newlines(&doubled, &indent);
        let (folded, overflow) = fold(&format!("{}{}{}", start, folded_value, end), &indent, Fold::Block, Some(indent.chars().count()), ctx.line_width);
        if !overflow {
            return format!(">{}\n{}{}", header, indent, folded);
        }
    }
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
    if ctx.implicit_key {
        s
    } else {
        fold(&s, &ctx.indent, Fold::Flow, ctx.indent_at_start, ctx.line_width).0
    }
}

/// lineLengthOverLimit: a line of the value longer than lineWidth − indent
fn line_length_over_limit(s: &str, line_width: usize, indent: usize) -> bool {
    if line_width == 0 {
        return false;
    }
    let limit = line_width as isize - indent as isize;
    let c: Vec<char> = s.chars().collect();
    if c.len() as isize <= limit {
        return false;
    }
    let mut start = 0usize;
    for (i, ch) in c.iter().enumerate() {
        if *ch == '\n' {
            if (i - start) as isize > limit {
                return true;
            }
            start = i + 1;
            if (c.len() - start) as isize <= limit {
                return false;
            }
        }
    }
    true
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
    let ictx = Ctx { indent: item_indent, in_flow: ctx.in_flow, implicit_key: false, indent_at_start: None, line_width: ctx.line_width, padding: ctx.padding };
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
    let ictx = Ctx { indent: format!("{}{}", item_indent, STEP), in_flow: true, implicit_key: false, indent_at_start: None, line_width: ctx.line_width, padding: ctx.padding };
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
    if !req_newline && ctx.line_width > 0 {
        let len = lines.iter().fold(2, |a, l| a + l.encode_utf16().count() + 2);
        req_newline = len > ctx.line_width;
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
        let p = if ctx.padding { " " } else { "" };
        format!("{}{}{}{}{}", start, p, lines.join(" "), p, end)
    }
}

fn pair(key: &str, value: &Node, ctx: &Ctx) -> String {
    let kctx = Ctx { indent: format!("{}{}", ctx.indent, STEP), in_flow: ctx.in_flow, implicit_key: true, indent_at_start: None, line_width: ctx.line_width, padding: ctx.padding };
    let mut s = format!("{}:", string(key, &kctx));
    let ias = if matches!(value, Node::Scalar(_)) { Some(s.encode_utf16().count() + 1) } else { None };
    let vctx = Ctx { implicit_key: false, indent_at_start: ias, ..kctx };
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
    let ctx = Ctx { indent: String::new(), in_flow: false, implicit_key: false, indent_at_start: None, line_width: 0, padding: false };
    format!("{}\n", stringify(&root, &ctx))
}

/// yaml.stringify(value) with the package's default options (lines folded at 80 columns, block style)
pub fn to_yaml(v: &Value) -> String {
    let ctx = Ctx { indent: String::new(), in_flow: false, implicit_key: false, indent_at_start: None, line_width: 80, padding: true };
    format!("{}\n", stringify(&node(v), &ctx))
}

#[derive(PartialEq, Clone, Copy)]
enum Fold {
    Flow,
    Block,
    Quoted,
}

/// foldFlowLines (yaml/stringify/foldFlowLines.js); returns the text and whether a line overflowed
fn fold(text: &str, indent: &str, mode: Fold, indent_at_start: Option<usize>, line_width: usize) -> (String, bool) {
    if line_width == 0 {
        return (text.to_string(), false);
    }
    let t: Vec<char> = text.chars().collect();
    let min_content = if line_width < 20 { 0 } else { 20 };
    let ind = indent.chars().count();
    let end_step = ((1 + min_content) as isize).max((1 + line_width) as isize - ind as isize) as usize;
    if t.len() <= end_step {
        return (text.to_string(), false);
    }
    let mut folds: Vec<usize> = vec![];
    let mut escaped: std::collections::HashSet<usize> = std::collections::HashSet::new();
    let mut end: isize = line_width as isize - ind as isize;
    if let Some(a) = indent_at_start {
        if a as isize > line_width as isize - (2.max(min_content)) as isize {
            folds.push(0);
        } else {
            end = line_width as isize - a as isize;
        }
    }
    let mut split: Option<usize> = None;
    let mut prev: Option<char> = None;
    let mut overflow = false;
    let mut i: isize = -1;
    let (mut esc_start, mut esc_end): (isize, isize) = (-1, -1);
    if mode == Fold::Block {
        i = more_indented(&t, i, ind);
        if i != -1 {
            end = i + end_step as isize;
        }
    }
    loop {
        i += 1;
        let Some(&c0) = t.get(i as usize) else { break };
        let mut ch = c0;
        if mode == Fold::Quoted && ch == '\\' {
            esc_start = i;
            i += match t.get(i as usize + 1) {
                Some('x') => 3,
                Some('u') => 5,
                Some('U') => 9,
                _ => 1,
            };
            esc_end = i;
        }
        if ch == '\n' {
            if mode == Fold::Block {
                i = more_indented(&t, i, ind);
            }
            end = i + ind as isize + end_step as isize;
            split = None;
        } else {
            if ch == ' ' && matches!(prev, Some(p) if p != ' ' && p != '\n' && p != '\t') {
                if let Some(&next) = t.get(i as usize + 1) {
                    if next != ' ' && next != '\n' && next != '\t' {
                        split = Some(i as usize);
                    }
                }
            }
            if i >= end {
                if let Some(sp) = split.filter(|x| *x != 0) {
                    folds.push(sp);
                    end = sp as isize + end_step as isize;
                    split = None;
                } else if mode == Fold::Quoted {
                    while prev == Some(' ') || prev == Some('\t') {
                        prev = Some(ch);
                        i += 1;
                        ch = t.get(i as usize).copied().unwrap_or('\0');
                        overflow = true;
                    }
                    let j = if i > esc_end + 1 { i - 2 } else { esc_start - 1 };
                    if escaped.contains(&(j as usize)) {
                        return (text.to_string(), overflow);
                    }
                    folds.push(j as usize);
                    escaped.insert(j as usize);
                    end = j + end_step as isize;
                    split = None;
                } else {
                    overflow = true;
                }
            }
        }
        prev = Some(ch);
    }
    if folds.is_empty() {
        return (text.to_string(), overflow);
    }
    let slice = |a: usize, b: usize| t[a.min(t.len())..b.min(t.len())].iter().collect::<String>();
    let mut res = slice(0, folds[0]);
    for (k, &f) in folds.iter().enumerate() {
        let e = folds.get(k + 1).copied().filter(|x| *x != 0).unwrap_or(t.len());
        if f == 0 {
            res = format!("\n{}{}", indent, slice(0, e));
        } else {
            if mode == Fold::Quoted && escaped.contains(&f) {
                res.push(t[f]);
                res.push('\\');
            }
            res += &format!("\n{}{}", indent, slice(f + 1, e));
        }
    }
    (res, overflow)
}

fn more_indented(t: &[char], i: isize, indent: usize) -> isize {
    let mut end = i;
    let mut i = i;
    let mut start = i + 1;
    let mut ch = t.get(start as usize).copied();
    while ch == Some(' ') || ch == Some('\t') {
        if i < start + indent as isize {
            i += 1;
            ch = t.get(i as usize).copied();
        } else {
            loop {
                i += 1;
                ch = t.get(i as usize).copied();
                if ch.is_none() || ch == Some('\n') {
                    break;
                }
            }
            end = i;
            start = i + 1;
            ch = t.get(start as usize).copied();
        }
    }
    end
}
