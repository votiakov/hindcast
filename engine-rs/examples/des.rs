//! cargo run --release --example des -- {spec, scenario}.json: one discrete-event run, natively
use hindcast_engine::sim::des::{simulate_des, DesConfig};

fn main() {
    let path = std::env::args().nth(1).expect("JSON with spec and scenario");
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut best = f64::INFINITY;
    for _ in 0..3 {
        let t = std::time::Instant::now();
        let r = simulate_des(&v["spec"], &v["scenario"], &DesConfig::default()).unwrap();
        best = best.min(t.elapsed().as_secs_f64() * 1000.0);
        std::hint::black_box(r);
    }
    println!("native DES: {:.0} ms", best);
}
