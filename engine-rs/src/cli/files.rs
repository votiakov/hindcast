//! Files on disk for the importers (cli/files.ts): paths relative to a manifest, a minimal glob, and
//! large trace files read block by block.

use crate::import::manifest::{ChunkReader, FileAccess};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

/// path.resolve: absolute, with `.` and `..` folded
pub fn resolve(base: &Path, p: &str) -> PathBuf {
    let joined = if Path::new(p).is_absolute() { PathBuf::from(p) } else { base.join(p) };
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            x => out.push(x.as_os_str()),
        }
    }
    out
}

pub fn cwd() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"))
}

/// path.relative(from, to) for absolute paths
pub fn relative(from: &Path, to: &str) -> String {
    let to = resolve(&cwd(), to);
    let a: Vec<_> = from.components().collect();
    let b: Vec<_> = to.components().collect();
    let mut i = 0;
    while i < a.len() && i < b.len() && a[i] == b[i] {
        i += 1;
    }
    let mut parts: Vec<String> = (i..a.len()).map(|_| "..".to_string()).collect();
    parts.extend(b[i..].iter().map(|c| c.as_os_str().to_string_lossy().to_string()));
    parts.join("/")
}

/// the regular expression cli/files.ts builds from the wildcard part of a pattern (its `**/` becomes
/// `(?:.[^/]*/)?` there, because the `*` rule runs after it: kept as written)
fn pattern_regex(pat: &str) -> Option<regex_lite::Regex> {
    let mut esc = String::new();
    for c in pat.chars() {
        if ".+^${}()|[]\\".contains(c) {
            esc.push('\\');
        }
        esc.push(c);
    }
    let r = esc.replace("**/", "(?:.*/)?").replace('*', "[^/]*").replace('?', "[^/]");
    regex_lite::Regex::new(&format!("^{}$", r)).ok()
}

/// minimal glob: `*`, `?` and `**` within path segments; sorted
pub fn glob(pattern: &str, base: &Path) -> Vec<String> {
    let abs = resolve(base, pattern);
    let abs_s = abs.to_string_lossy().to_string();
    if !pattern.contains(['*', '?']) {
        return if abs.exists() { vec![abs_s] } else { vec![] };
    }
    let segs: Vec<&str> = abs_s.split('/').collect();
    let first = segs.iter().position(|s| s.contains(['*', '?'])).unwrap_or(segs.len());
    let root = { let r = segs[..first].join("/"); if r.is_empty() { "/".to_string() } else { r } };
    let Some(re) = pattern_regex(&segs[first..].join("/")) else { return vec![] };
    let mut out = vec![];
    fn walk(dir: &Path, root: &Path, re: &regex_lite::Regex, out: &mut Vec<String>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, root, re, out);
            } else if let Ok(rel) = p.strip_prefix(root) {
                if re.is_match(&rel.to_string_lossy()) {
                    out.push(p.to_string_lossy().to_string());
                }
            }
        }
    }
    let root = PathBuf::from(root);
    if root.exists() {
        walk(&root, &root, &re, &mut out);
    }
    out.sort();
    out
}

/// file access relative to a manifest's directory
pub struct DiskFiles {
    pub base: PathBuf,
}

impl DiskFiles {
    pub fn for_manifest(manifest: &str) -> DiskFiles {
        let m = resolve(&cwd(), manifest);
        DiskFiles { base: m.parent().map(|p| p.to_path_buf()).unwrap_or_else(cwd) }
    }
}

impl FileAccess for DiskFiles {
    fn read(&mut self, p: &str) -> Result<String, String> {
        let path = resolve(&self.base, p);
        std::fs::read_to_string(&path).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => format!("ENOENT: no such file or directory, open '{}'", path.display()),
            _ => format!("{}: {}", path.display(), e),
        })
    }
    fn glob(&mut self, p: &str) -> Result<Vec<String>, String> {
        Ok(glob(p, &self.base))
    }
    fn chunks(&mut self, p: &str) -> Option<Result<ChunkReader, String>> {
        let path = resolve(&self.base, p);
        let mut f = match std::fs::File::open(&path) {
            Ok(f) => f,
            Err(e) => return Some(Err(format!("{}: {}", path.display(), e))),
        };
        Some(Ok(Box::new(move |b: &mut Vec<u8>| {
            b.resize(1 << 22, 0);
            let n = f.read(b).map_err(|e| e.to_string())?;
            b.truncate(n);
            Ok(n > 0)
        })))
    }
}
