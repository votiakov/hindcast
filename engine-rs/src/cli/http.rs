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
    // a range query over days of many series runs past ureq's 10 MB default
    let body = resp.body_mut().with_config().limit(BODY_LIMIT).read_to_string().map_err(|e| body_error(url, &e))?;
    Ok((status, body))
}

/// the largest answer read: a week of per-pod series at a fine step is tens of megabytes
pub const BODY_LIMIT: u64 = 512 * 1024 * 1024;

/// a failed read, said with where it came from and what to do about a body too large
pub fn body_error(url: &str, e: &ureq::Error) -> String {
    let path = url.split("://").nth(1).and_then(|r| r.find('/').map(|i| &r[i..])).unwrap_or("/");
    let path = path.split('?').next().unwrap_or(path);
    match e {
        ureq::Error::BodyExceedsLimit(n) => format!("{} answered with more than {} MB: collect a shorter window (`last`), a coarser step (`stepS`) or fewer namespaces", path, n / (1024 * 1024)),
        e => format!("reading {}: {}", path, e),
    }
}

/// `new URL(path, base)` for a base that is a directory (a trailing slash is added)
pub fn join(base: &str, path: &str) -> String {
    if base.ends_with('/') {
        format!("{}{}", base, path)
    } else {
        format!("{}/{}", base, path)
    }
}
