//! `hindcast agent setup [host] [--write]` (agent/setup.ts): register the MCP server with an agent
//! host without hand-editing paths. The server is this binary (`hindcast mcp`): the host's config
//! is printed with its absolute path filled in, merged into the host's file when asked, and the
//! server is proved to start by completing an MCP handshake with it.

use crate::cli::util::{pretty, Out};
use serde_json::{json, Map as JMap, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

pub const HOSTS: [&str; 5] = ["claude", "cursor", "vscode", "desktop", "windsurf"];

struct Launch {
    command: String,
    args: Vec<String>,
}

fn home() -> PathBuf {
    std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).map(PathBuf::from).unwrap_or_default()
}

/// the config file a host reads, and whether it is per project or per user
fn config_path(host: &str, project: &Path) -> (PathBuf, &'static str) {
    let h = home();
    match host {
        "claude" => (project.join(".mcp.json"), "project"),
        "cursor" => (project.join(".cursor").join("mcp.json"), "project"),
        "vscode" => (project.join(".vscode").join("mcp.json"), "project"),
        "windsurf" => (h.join(".codeium").join("windsurf").join("mcp_config.json"), "user"),
        _ => (
            if cfg!(target_os = "macos") {
                h.join("Library").join("Application Support").join("Claude").join("claude_desktop_config.json")
            } else if cfg!(windows) {
                std::env::var("APPDATA").map(PathBuf::from).unwrap_or_else(|_| h.join("AppData").join("Roaming")).join("Claude").join("claude_desktop_config.json")
            } else {
                h.join(".config").join("Claude").join("claude_desktop_config.json")
            },
            "user",
        ),
    }
}

/// the host's file with the hindcast server merged in; every other server is kept, except an entry
/// under the pre-rename name "bottleneck", which this one replaces
fn merged_config(host: &str, existing: &Value, launch: &Launch, env: &JMap<String, Value>) -> Value {
    let mut entry = JMap::new();
    if host == "vscode" {
        entry.insert("type".into(), json!("stdio"));
    }
    entry.insert("command".into(), json!(launch.command));
    entry.insert("args".into(), json!(launch.args));
    if !env.is_empty() {
        entry.insert("env".into(), Value::Object(env.clone()));
    }
    // VS Code keeps servers under "servers" and wants a type; the others use "mcpServers"
    let key = if host == "vscode" { "servers" } else { "mcpServers" };
    let mut out = existing.as_object().cloned().unwrap_or_default();
    let mut servers = existing.get(key).and_then(|s| s.as_object()).cloned().unwrap_or_default();
    servers.shift_remove("bottleneck");
    servers.insert("hindcast".into(), Value::Object(entry));
    out.insert(key.into(), Value::Object(servers));
    Value::Object(out)
}

/// start the server, initialize, list its tools: the same first steps every host takes
fn handshake(launch: &Launch, env: &[(String, String)]) -> Result<(Vec<String>, String), String> {
    let mut p = Command::new(&launch.command).args(&launch.args).envs(env.iter().cloned()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let mut stdin = p.stdin.take().ok_or("no stdin")?;
    let stdout = p.stdout.take().ok_or("no stdout")?;
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for l in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(l).is_err() {
                break;
            }
        }
    });
    let mut send = |m: Value| writeln!(stdin, "{}", m).map_err(|e| e.to_string());
    send(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "hindcast-setup", "version": "1" } } }))?;
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    let mut version = String::new();
    let result = loop {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        let line = match rx.recv_timeout(left) {
            Ok(l) => l,
            Err(mpsc::RecvTimeoutError::Timeout) => break Err("the server did not answer within 20 s".to_string()),
            Err(_) => break Err(format!("the server exited with code {}", p.wait().ok().and_then(|s| s.code()).unwrap_or(-1))),
        };
        let Ok(msg) = serde_json::from_str::<Value>(line.trim()) else { continue };
        if let Some(e) = msg.get("error") {
            break Err(e.get("message").and_then(|m| m.as_str()).unwrap_or("error").to_string());
        }
        match msg.get("id").and_then(|i| i.as_i64()) {
            Some(1) => {
                version = msg["result"]["serverInfo"]["version"].as_str().unwrap_or("").to_string();
                send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))?;
                send(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }))?;
            }
            Some(2) => break Ok((msg["result"]["tools"].as_array().map(|a| a.iter().filter_map(|t| t["name"].as_str().map(String::from)).collect()).unwrap_or_default(), version.clone())),
            _ => {}
        }
    };
    let _ = p.kill();
    let _ = p.wait();
    result
}

fn label(h: &str) -> &'static str {
    match h {
        "claude" => "Claude Code",
        "cursor" => "Cursor",
        "vscode" => "VS Code",
        "desktop" => "Claude Desktop",
        _ => "Windsurf",
    }
}

pub fn setup(host: Option<&str>, write: bool, project: Option<&str>, workspace: Option<&str>, out: &mut Out) -> Result<i32, String> {
    let cwd = crate::cli::files::cwd();
    let project = project.map(|p| crate::cli::files::resolve(&cwd, p)).unwrap_or(cwd);
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = exe.canonicalize().unwrap_or(exe);
    let launch = Launch { command: exe.to_string_lossy().into_owned(), args: vec!["mcp".into()] };
    let ws = match workspace {
        Some(w) => crate::cli::files::resolve(&crate::cli::files::cwd(), w),
        None => super::workspace::default_dir(&project),
    };
    let ws = ws.to_string_lossy().into_owned();
    let mut env = JMap::new();
    env.insert("HINDCAST_WORKSPACE".into(), json!(ws));

    out.log(&format!("MCP server: {} {}", launch.command, launch.args.join(" ")));
    out.flush();
    let (tools, _) = handshake(&launch, &[("HINDCAST_WORKSPACE".into(), ws.clone())])?;
    out.log(&format!("✓ it starts and answers: {} tools ({}{})", tools.len(), tools.iter().take(6).cloned().collect::<Vec<_>>().join(", "), if tools.len() > 6 { ", …" } else { "" }));

    let hosts: Vec<&str> = match host {
        Some(h) => vec![h],
        None => HOSTS.to_vec(),
    };
    for h in hosts {
        let (path, scope) = config_path(h, &project);
        let shown = path.to_string_lossy();
        if h == "claude" && !write {
            let quoted: Vec<String> = std::iter::once(&launch.command).chain(launch.args.iter()).map(|a| crate::convert::js_stringify(&json!(a))).collect();
            out.log(&format!("\nClaude Code ({}):\n  claude mcp add hindcast -e HINDCAST_WORKSPACE={} -- {}", if scope == "project" { "this project" } else { "you" }, crate::convert::js_stringify(&json!(ws)), quoted.join(" ")));
            continue;
        }
        let existing: Value = match std::fs::read_to_string(&path) {
            Ok(t) if t.trim().is_empty() => json!({}),
            Ok(t) => serde_json::from_str(&t).map_err(|e| format!("{}: {}", shown, e))?,
            Err(_) => json!({}),
        };
        let next = merged_config(h, &existing, &launch, &env);
        if write {
            if let Some(d) = path.parent() {
                std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
            }
            std::fs::write(&path, pretty(&next) + "\n").map_err(|e| format!("{}: {}", shown, e))?;
            let kept = existing.as_object().map(|o| !o.is_empty()).unwrap_or(false);
            out.log(&format!("✓ {}: wrote {}{}", h, shown, if kept { " (other servers kept)" } else { "" }));
        } else {
            let key = if h == "vscode" { "servers" } else { "mcpServers" };
            let snippet = json!({ key: { "hindcast": next[key]["hindcast"] } });
            out.log(&format!("\n{} — {}:\n{}", label(h), shown, pretty(&snippet).lines().map(|l| format!("  {}", l)).collect::<Vec<_>>().join("\n")));
        }
    }
    if !write {
        out.log("\nAdd --write (with one host: cursor, vscode, desktop, windsurf or claude) to merge it into that file.");
    }
    out.log("Credentials (a Prometheus token, say) go in the server's \"env\" in that file; tools name the variable (tokenEnv), never the value.");
    out.log("Then ask your agent: \"use hindcast to check whether <change> is safe\".");
    Ok(0)
}
