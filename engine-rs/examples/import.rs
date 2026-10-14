//! cargo run --release --example import -- <manifest.json> <dir>: times importBundle natively
use hindcast_engine::import::manifest::{import_bundle, FileAccess};
use std::time::Instant;

struct Fs(std::path::PathBuf);
impl FileAccess for Fs {
    fn read(&mut self, p: &str) -> Result<String, String> {
        let t = Instant::now();
        let s = std::fs::read_to_string(self.0.join(p)).map_err(|e| e.to_string());
        eprintln!("read {} {:?}", p, t.elapsed());
        s
    }
    fn glob(&mut self, p: &str) -> Result<Vec<String>, String> {
        Ok(vec![p.to_string()])
    }
    fn chunks(&mut self, p: &str) -> Option<Result<hindcast_engine::import::manifest::ChunkReader, String>> {
        use std::io::Read;
        let mut f = match std::fs::File::open(self.0.join(p)) {
            Ok(f) => f,
            Err(e) => return Some(Err(e.to_string())),
        };
        Some(Ok(Box::new(move |b: &mut Vec<u8>| {
            b.resize(1 << 22, 0);
            let n = f.read(b).map_err(|e| e.to_string())?;
            b.truncate(n);
            Ok(n > 0)
        })))
    }
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let m: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&a[1]).unwrap()).unwrap();
    let mut fs = Fs(a[2].clone().into());
    let t = Instant::now();
    let (d, log) = import_bundle(&m, &mut fs).unwrap();
    eprintln!("total {:?}: {} services, {} log", t.elapsed(), d.services.len(), log.len());
}
