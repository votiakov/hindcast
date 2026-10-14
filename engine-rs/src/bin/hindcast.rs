//! `hindcast`: the native command line (see src/cli).

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(hindcast_engine::cli::main(args));
}

#[cfg(target_arch = "wasm32")]
fn main() {}
