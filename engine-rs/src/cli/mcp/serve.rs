//! While the MCP server runs, the workspace's backtest bundles are served on 127.0.0.1 so the app can
//! open them (`#backtest=<url>`): a human sees the agent's evidence on the backtest screen.
//! Read-only, loopback only, bundles only, and only to the app's origin (agent/serve.ts).

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex, OnceLock};

static ROOTS: OnceLock<Arc<Mutex<Vec<String>>>> = OnceLock::new();
static BASE: OnceLock<Result<String, String>> = OnceLock::new();

fn basename(p: &str) -> &str {
    p.trim_end_matches('/').rsplit('/').next().unwrap_or("")
}

/// the app URL's origin (scheme://host[:port])
fn origin(url: &str) -> String {
    match url.find("://") {
        Some(i) => {
            let rest = &url[i + 3..];
            let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
            format!("{}{}", &url[..i + 3], &rest[..end]).to_lowercase()
        }
        None => url.to_string(),
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(x) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(x);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn handle(mut c: TcpStream, roots: &Mutex<Vec<String>>, origin: &str) {
    let mut line = String::new();
    let mut r = BufReader::new(match c.try_clone() {
        Ok(x) => x,
        Err(_) => return,
    });
    if r.read_line(&mut line).is_err() {
        return;
    }
    // drain the headers
    loop {
        let mut h = String::new();
        match r.read_line(&mut h) {
            Ok(0) | Err(_) => break,
            Ok(_) if h == "\r\n" || h == "\n" => break,
            _ => {}
        }
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");
    let path = target.split(['?', '#']).next().unwrap_or("/");
    let name = basename(&percent_decode(path)).to_string();
    let head = format!("Access-Control-Allow-Origin: {}\r\nVary: Origin\r\nConnection: close\r\n", origin);
    let not_found = format!("HTTP/1.1 404 Not Found\r\n{}Content-Length: 0\r\n\r\n", head);
    if method != "GET" || !(name.ends_with(".hindcast.json") || name.ends_with(".bottleneck.json")) {
        let _ = c.write_all(not_found.as_bytes());
        return;
    }
    let roots = roots.lock().map(|r| r.clone()).unwrap_or_default();
    for root in roots {
        if let Ok(body) = std::fs::read(std::path::Path::new(&root).join(&name)) {
            let _ = c.write_all(format!("HTTP/1.1 200 OK\r\n{}Content-Type: application/json\r\nContent-Length: {}\r\n\r\n", head, body.len()).as_bytes());
            let _ = c.write_all(&body);
            return;
        }
    }
    let _ = c.write_all(not_found.as_bytes());
}

fn ensure_server(app_url: &str) -> Result<String, String> {
    let roots = ROOTS.get_or_init(|| Arc::new(Mutex::new(vec![]))).clone();
    BASE.get_or_init(|| {
        let port: u16 = std::env::var("HINDCAST_SERVE_PORT").or_else(|_| std::env::var("BOTTLENECK_SERVE_PORT")).ok().and_then(|p| p.parse().ok()).unwrap_or(0);
        let l = TcpListener::bind(("127.0.0.1", port)).map_err(|e| e.to_string())?;
        let port = l.local_addr().map_err(|e| e.to_string())?.port();
        let origin = origin(app_url);
        std::thread::spawn(move || {
            for c in l.incoming().flatten() {
                let roots = roots.clone();
                let origin = origin.clone();
                std::thread::spawn(move || handle(c, &roots, &origin));
            }
        });
        Ok(format!("http://127.0.0.1:{}", port))
    })
    .clone()
}

/// a link that opens a bundle written by verify_change in the app
pub fn app_link(reports: &str, bundle: &str, app_url: &str) -> Result<String, String> {
    {
        let roots = ROOTS.get_or_init(|| Arc::new(Mutex::new(vec![])));
        let mut r = roots.lock().map_err(|e| e.to_string())?;
        if !r.iter().any(|x| x == reports) {
            r.push(reports.to_string());
        }
    }
    let b = ensure_server(app_url)?;
    Ok(format!("{}/#backtest={}", app_url, crate::cli::agent::collect::encode_uri_component(&format!("{}/{}", b, basename(bundle)))))
}
