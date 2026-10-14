//! cargo run --release --example bench -- plan+traffic.json: the replay's own time, natively
use hindcast_engine::{run_plan, types::{Opts, Plan, Traffic}};
use serde::Deserialize;

#[derive(Deserialize)]
struct Input {
    plan: Plan,
    traffic: Traffic,
}

fn main() {
    let path = std::env::args().nth(1).expect("plan+traffic JSON");
    let input: Input = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let opts = Opts::default();
    let mut best = f64::INFINITY;
    for _ in 0..std::env::var("REPS").ok().and_then(|x| x.parse().ok()).unwrap_or(3) {
        let t = std::time::Instant::now();
        let out = run_plan(&input.plan, &input.traffic, &opts);
        best = best.min(t.elapsed().as_secs_f64() * 1000.0);
        std::hint::black_box(out);
    }
    println!("native: {:.0} ms", best);
}
