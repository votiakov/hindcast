//! The capacity review and what it is built from — the judged backtest of one change, the changes
//! suggested from the history, the review itself — on a model and its history already in memory.
//! The CLI and MCP tools (src/cli/agent) read them from a workspace directory and call in here; the
//! app (the Backtest tab's Review, through `reviewCapacity` in lib.rs) calls the same code in wasm.

pub mod capacity;
pub mod json;
pub mod judge;
pub mod suggest;

thread_local! {
    static PROGRESS: std::cell::RefCell<Option<Box<dyn FnMut(&str, f64, f64)>>> = std::cell::RefCell::new(None);
}

/// a long computation's phase, reported when the caller asked for progress (MCP progress
/// notifications, the app's review worker)
pub fn progress(message: &str, done: f64, total: f64) {
    PROGRESS.with(|p| {
        if let Some(f) = p.borrow_mut().as_mut() {
            f(message, done, total);
        }
    });
}

/// run with progress reported to `f` (or with none: `None`), restoring the previous hook after
pub fn with_progress<T>(f: Option<Box<dyn FnMut(&str, f64, f64)>>, run: impl FnOnce() -> T) -> T {
    let prev = PROGRESS.with(|p| std::mem::replace(&mut *p.borrow_mut(), f));
    let out = run();
    PROGRESS.with(|p| *p.borrow_mut() = prev);
    out
}
