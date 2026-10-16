//! "What should we change?" (agent/suggest.ts) on the workspace's model and history: the candidates,
//! their backtests and verdicts are computed in crate::review::suggest.

use super::verify::slice_last;
use super::workspace::{seconds, Workspace};
use serde_json::Value;

pub fn suggest_changes(ws: &Workspace, o: &Value) -> Result<Value, String> {
    let mv = ws.read_json("model.json")?;
    let m: crate::model::Model = serde_json::from_value(mv.clone()).map_err(|e| format!("model: {}", e))?;
    let mut dv = ws.read_json("dataset.json")?;
    if let Some(l) = o.get("last").and_then(|x| x.as_str()) {
        let k = (seconds(l)? / dv["stepS"].as_f64().unwrap_or(1.0)).ceil() as usize;
        if (k as f64) < dv["n"].as_f64().unwrap_or(0.0) {
            dv = slice_last(&dv, k);
        }
    }
    let d: crate::dataset::Dataset = serde_json::from_value(dv.clone()).map_err(|e| format!("dataset: {}", e))?;
    let cal = if ws.has("calibration.json") { Some(ws.read_json("calibration.json")?) } else { None };
    crate::review::suggest::suggest(&mv, &m, &d, cal.as_ref(), o)
}
