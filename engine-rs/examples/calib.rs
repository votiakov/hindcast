//! cargo run --release --example calib -- dataset.json: calibration's own time, natively
use hindcast_engine::{calibrate::calibrate, dataset::Dataset};

fn main() {
    let path = std::env::args().nth(1).expect("dataset JSON");
    let d: Dataset = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let reps: usize = std::env::var("REPS").ok().and_then(|x| x.parse().ok()).unwrap_or(2);
    let mut best = f64::INFINITY;
    for _ in 0..reps {
        let t = std::time::Instant::now();
        let m = calibrate(&d, &Default::default());
        best = best.min(t.elapsed().as_secs_f64() * 1000.0);
        std::hint::black_box(m);
    }
    println!("native calibration: {:.0} ms", best);
}
