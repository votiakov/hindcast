//! The capacity review (agent/review.ts) on the workspace's model and history, computed in
//! crate::review::capacity; the Markdown report written to the workspace's reports/.

use super::workspace::{iso_full, now_s, Workspace};
use serde_json::{json, Value};

pub use crate::review::capacity::review_markdown;

pub fn review_capacity(ws: &Workspace, o: &Value) -> Result<Value, String> {
    let mv = ws.read_json("model.json")?;
    let m: crate::model::Model = serde_json::from_value(mv.clone()).map_err(|e| format!("model: {}", e))?;
    let dv = ws.read_json("dataset.json")?;
    let d: crate::dataset::Dataset = serde_json::from_value(dv.clone()).map_err(|e| format!("dataset: {}", e))?;
    let draws = o.get("draws").and_then(|x| x.as_f64()).unwrap_or(12.0);
    let cal = if ws.has("calibration.json") { Some(ws.read_json("calibration.json")?) } else { None };
    let opts = || super::verify::calibrate_options(ws, &json!({ "slo": mv["slo"], "timeoutMs": mv["timeoutMs"] }));
    let mut out = crate::review::capacity::review(&mv, &m, &dv, &d, cal.as_ref(), draws, &opts)?.out;
    super::progress("writing the report", 4.0, 5.0);
    let out_v = Value::Object(out.clone());
    let md = review_markdown(&out_v);
    ws.ensure("reports");
    let file = format!("{}/capacity-review-{}.md", ws.path("reports"), &iso_full(now_s())[..10]);
    std::fs::write(&file, &md).map_err(|e| e.to_string())?;
    out.insert("report".into(), json!(file));
    out.insert("markdown".into(), json!(md));
    Ok(Value::Object(out))
}
