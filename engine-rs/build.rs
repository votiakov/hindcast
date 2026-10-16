//! `hindcast demo`'s data, packed from the committed reference systems at build time so the binary
//! can never ship a stale copy: the Astronomy Shop on Docker Compose (reference/shop: model, recorded
//! day, its four strategies) and the shop on Kubernetes (public/reference/k8s-shop.json). One gzipped
//! file in OUT_DIR, `include_bytes!`d by src/cli/demo.rs; its layout is a header line, then per file
//! "<path>\n<byte length>\n<bytes>". The WebAssembly build skips it (the CLI is not compiled there).

use std::io::Write;
use std::path::{Path, PathBuf};

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32") {
        return;
    }
    let root = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("..");
    let shop = root.join("reference/shop");
    let mut files: Vec<(String, PathBuf)> = vec![("shop/model.json".into(), shop.join("model.json")), ("shop/dataset.json".into(), shop.join("dataset.json"))];
    let sdir = shop.join("strategies");
    println!("cargo:rerun-if-changed={}", sdir.display());
    let mut strategies: Vec<String> = std::fs::read_dir(&sdir)
        .unwrap_or_else(|e| panic!("{}: {} (hindcast demo is built from the repository's reference/ directory)", sdir.display(), e))
        .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().to_string()))
        .filter(|f| f.ends_with(".yaml"))
        .collect();
    strategies.sort();
    for s in strategies {
        files.push((format!("shop/strategies/{}", s), sdir.join(&s)));
    }
    files.push(("k8s-shop.json".into(), root.join("public/reference/k8s-shop.json")));

    let mut raw: Vec<u8> = b"hindcast-demo 1\n".to_vec();
    for (name, path) in &files {
        println!("cargo:rerun-if-changed={}", path.display());
        let bytes = read(path);
        raw.extend_from_slice(format!("{}\n{}\n", name, bytes.len()).as_bytes());
        raw.extend_from_slice(&bytes);
    }
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
    gz.write_all(&raw).unwrap();
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("demo-bundle.gz");
    std::fs::write(&out, gz.finish().unwrap()).unwrap();
}

fn read(p: &Path) -> Vec<u8> {
    std::fs::read(p).unwrap_or_else(|e| panic!("{}: {} (hindcast demo is built from the repository's reference files)", p.display(), e))
}
