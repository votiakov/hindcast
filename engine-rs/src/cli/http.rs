//! HTTP for the commands that talk to a live system (Prometheus): GET with headers, status and body.

/// GET a URL: (status, body)
pub fn get(url: &str, headers: &[(String, String)]) -> Result<(u16, String), String> {
    let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).build().into();
    let mut req = agent.get(url);
    for (k, v) in headers {
        req = req.header(k.as_str(), v.as_str());
    }
    let mut resp = req.call().map_err(|e| format!("fetch failed: {}", e))?;
    let status = resp.status().as_u16();
    let body = resp.body_mut().read_to_string().map_err(|e| e.to_string())?;
    Ok((status, body))
}

/// `new URL(path, base)` for a base that is a directory (a trailing slash is added)
pub fn join(base: &str, path: &str) -> String {
    if base.ends_with('/') {
        format!("{}{}", base, path)
    } else {
        format!("{}/{}", base, path)
    }
}
