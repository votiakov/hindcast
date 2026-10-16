//! `hindcast demo [--workspace <dir>] [--json]`: what Hindcast does, from the binary alone. The data is
//! the committed reference systems, packed into the binary at build time (build.rs): the Astronomy Shop
//! on Docker Compose (model, recorded day, four strategies, its accuracy record) and the same shop on a
//! two-node Kubernetes cluster (model and recorded day, for a capacity review with node loss). No
//! network, no files read. `--workspace` writes the same data to disk for every other command.

use super::agent::quickstart::summary_lines;
use super::agent::workspace::Workspace;
use super::bt::{dataset_of, model_of, print_accuracy, print_backtest_table, result_json};
use super::reports::{arr, s};
use super::util::*;
use serde_json::{json, Value};
use std::io::Read;

const BUNDLE: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/demo-bundle.gz"));

pub const USAGE: &str = "hindcast demo [--workspace ./hindcast-demo] [--json]";

const ABOUT: &str = "A recorded day of the OpenTelemetry Astronomy Shop: a 40-minute load test of a demo system, not production.";
const RECORDED: &str = "Recorded on a two-node Kubernetes cluster (kind) for the capacity review, and on Docker Compose for the backtest, where two of the strategies were then applied for real.";

/// the bundle's files, by path: shop/model.json, shop/dataset.json, shop/strategies/*.yaml, k8s-shop.json
pub fn bundle() -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut raw = vec![];
    flate2::read::GzDecoder::new(BUNDLE).read_to_end(&mut raw).map_err(|e| format!("the demo data: {}", e))?;
    let bad = || "the demo data is damaged".to_string();
    let mut rest: &[u8] = raw.strip_prefix(b"hindcast-demo 1\n".as_slice()).ok_or_else(bad)?;
    let line = |r: &mut &[u8]| -> Result<String, String> {
        let i = r.iter().position(|b| *b == b'\n').ok_or_else(bad)?;
        let l = String::from_utf8(r[..i].to_vec()).map_err(|_| bad())?;
        *r = &r[i + 1..];
        Ok(l)
    };
    let mut files = vec![];
    while !rest.is_empty() {
        let name = line(&mut rest)?;
        let len: usize = line(&mut rest)?.parse().map_err(|_| bad())?;
        if rest.len() < len {
            return Err(bad());
        }
        files.push((name, rest[..len].to_vec()));
        rest = &rest[len..];
    }
    Ok(files)
}

struct Demo {
    shop_model: Value,
    shop_dataset: Value,
    strategies: Vec<(String, String)>,
    k8s_model: Value,
    k8s_dataset: Value,
}

fn load() -> Result<Demo, String> {
    let files = bundle()?;
    let text = |p: &str| -> Result<String, String> { files.iter().find(|(k, _)| k == p).map(|(_, b)| String::from_utf8_lossy(b).to_string()).ok_or_else(|| format!("the demo data has no {}", p)) };
    let json = |p: &str| -> Result<Value, String> { serde_json::from_str(&text(p)?).map_err(|e| format!("{}: {}", p, e)) };
    let k8s = json("k8s-shop.json")?;
    Ok(Demo {
        shop_model: json("shop/model.json")?,
        shop_dataset: json("shop/dataset.json")?,
        strategies: files.iter().filter_map(|(k, b)| k.strip_prefix("shop/strategies/").map(|f| (f.to_string(), String::from_utf8_lossy(b).to_string()))).collect(),
        k8s_model: k8s["model"].clone(),
        k8s_dataset: k8s["dataset"].clone(),
    })
}

/// the capacity review on the Kubernetes shop, as review_capacity computes it on a workspace holding it
fn review(d: &Demo) -> Result<Value, String> {
    let (mv, dv) = (&d.k8s_model, &d.k8s_dataset);
    let opts = || {
        let mut o = crate::calibrate::CalibrateOptions::default();
        o.slo = serde_json::from_value(mv["slo"].clone()).ok();
        o.timeout_ms = mv["timeoutMs"].as_f64().filter(|t| *t != 0.0);
        o.list_prices = Some(json!(true));
        Ok(o)
    };
    let mut out = crate::review::capacity::review(mv, &model_of(mv)?, dv, &dataset_of(dv)?, None, 12.0, &opts)?.out;
    let md = crate::review::capacity::review_markdown(&Value::Object(out.clone()));
    out.insert("summary".into(), json!(summary_lines(&md)));
    Ok(Value::Object(out))
}

fn backtest(d: &Demo) -> Result<Value, String> {
    let strategies: Vec<Value> = d.strategies.iter().map(|(f, y)| parse_yaml(y).map_err(|e| format!("{}: {}", f, e))).collect::<Result<_, _>>()?;
    let r = crate::backtest::backtest(&model_of(&d.shop_model)?, &dataset_of(&d.shop_dataset)?, &strategies, &Default::default())?;
    Ok(result_json(&r, &d.shop_model))
}

fn next_lines() -> Vec<(String, &'static str)> {
    vec![
        ("hindcast quickstart --prometheus http://localhost:9090".into(), "the same review of your own system (--datadog <site> on Datadog)"),
        ("hindcast demo --workspace ./hindcast-demo".into(), "this data on disk, to run any other command on it"),
    ]
}

fn print_next(lines: &[(String, &str)], out: &mut Out) {
    // aligned while the commands are short; long ones as quickstart writes them
    let w = lines.iter().map(|(c, _)| c.chars().count()).max().unwrap_or(0);
    let w = if w > 60 { 0 } else { w };
    out.log("Next:");
    for (c, why) in lines {
        out.log(&format!("  {}{}   {}", c, " ".repeat(w.saturating_sub(c.chars().count())), why));
    }
}

pub fn command(f: &Flags, out: &mut Out) -> Result<i32, String> {
    if f.has("help") || f.has("h") {
        out.log(&format!("{}\n\nShows what Hindcast does on a recorded system bundled in the binary: a capacity review, four strategies backtested over the recorded day, and the accuracy record against runs the model never saw. No network, no files. --workspace writes the data (models, recorded days, strategies) to a directory, to run any other command on it.", USAGE));
        return Ok(0);
    }
    let d = load()?;
    if let Some(dir) = f.get("workspace") {
        if dir == "true" {
            return Err(format!("--workspace needs a directory: {}", USAGE));
        }
        return write_workspace(&d, &dir, f.has("json"), out);
    }
    let rev = review(&d)?;
    let bt = backtest(&d)?;
    if f.has("json") {
        let verdicts: Vec<Value> = arr(&bt, &["ranking"])
            .iter()
            .map(|k| {
                let st = arr(&bt, &["strategies"]).into_iter().find(|x| s(x, &["name"]) == s(k, &["name"])).cloned().unwrap_or(Value::Null);
                json!({
                    "name": k["name"], "verdict": k["verdict"], "monthlyDelta": k["monthlyDelta"], "minutesOutOfSloDelta": k["minutesOutOfSloDelta"],
                    "monthly": st["summary"]["monthly"], "minutesOutOfSlo": st["summary"]["minutesOutOfSlo"], "failedRequests": st["summary"]["failedRequests"],
                })
            })
            .collect();
        let backtest = json!({ "model": bt["model"], "window": bt["window"], "slo": bt["slo"], "draws": bt["draws"], "asBuilt": bt["baseline"]["summary"], "strategies": verdicts });
        let next: Vec<Value> = next_lines().into_iter().map(|(c, why)| json!({ "command": c, "why": why })).collect();
        out.log(&pretty(&json!({ "about": ABOUT, "recorded": RECORDED, "review": rev, "backtest": backtest, "accuracy": d.shop_model["accuracy"], "next": next })));
        return Ok(0);
    }
    out.log("");
    out.log(&bold(ABOUT));
    out.log(&dim(RECORDED));
    out.log("");
    out.log(&format!("Capacity review — {}", s(&rev, &["system"])));
    out.log("");
    for l in arr(&rev, &["summary"]) {
        out.log(&s(l, &[]));
    }
    // the backtest and accuracy are the Docker Compose recording, not the cluster reviewed above: say so
    // where the numbers are, since its cost and accuracy differ from the review's
    let mut bt = bt;
    bt["model"] = json!(format!("{} on Docker Compose", s(&bt, &["model"])));
    print_backtest_table(&bt, out);
    out.log(&format!("\n{}", bold(&format!("Accuracy — {} on Docker Compose", s(&d.shop_model, &["name"])))));
    print_accuracy(&d.shop_model, out);
    out.log("");
    print_next(&next_lines(), out);
    Ok(0)
}

/// the data as files: the Docker Compose shop for the backtest commands, the Kubernetes shop as an agent workspace
fn write_workspace(d: &Demo, dir: &str, json_out: bool, out: &mut Out) -> Result<i32, String> {
    let mut files: Vec<(String, String)> = vec![];
    let files_in = bundle()?;
    for (k, b) in &files_in {
        if let Some(p) = k.strip_prefix("shop/") {
            files.push((p.to_string(), String::from_utf8_lossy(b).to_string()));
        }
    }
    // as the agent tools write a workspace: the model indented, the dataset on one line
    files.push(("k8s/model.json".into(), pretty_indent(&d.k8s_model, 1)));
    files.push(("k8s/dataset.json".into(), crate::convert::js_stringify(&d.k8s_dataset)));
    let root = Workspace::new(Some(dir));
    // never over another system's files
    for (p, text) in &files {
        let path = root.dir.join(p);
        if path.exists() && std::fs::read_to_string(&path).map(|t| &t != text).unwrap_or(true) {
            return Err(format!("{} already exists and is not the demo's; pick an empty directory", path.to_string_lossy()));
        }
    }
    for (p, text) in &files {
        let path = root.dir.join(p);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {}", parent.to_string_lossy(), e))?;
        }
        write(&path.to_string_lossy(), text)?;
    }
    let base = dir.trim_end_matches('/');
    let at = |p: &str| format!("{}/{}", base, p);
    let first = d.strategies.first().map(|(f, _)| f.clone()).unwrap_or_default();
    let next: Vec<(String, &str)> = vec![
        (format!("hindcast backtest {} {} {} --scale 2", at("model.json"), at("dataset.json"), at(&format!("strategies/{}", first))), "a strategy over the recorded day at twice its traffic"),
        (format!("hindcast outage {} list", at("model.json")), "public outages to replay against the model"),
        (format!("hindcast headroom {}", at("model.json")), "how much traffic it takes within SLO"),
        (format!("hindcast agent check_node_loss '{{\"workspace\":\"{}\"}}'", at("k8s")), "losing each node at the busiest moment"),
        (format!("hindcast agent verify_change '{{\"workspace\":\"{}\",\"changes\":[{{\"strategy\":{{\"name\":\"frontend x3\",\"changes\":[{{\"service\":\"frontend\",\"replicas\":3}}]}}}}]}}'", at("k8s")), "a change, pass or fail, before it ships"),
    ];
    if json_out {
        let nx: Vec<Value> = next.iter().map(|(c, why)| json!({ "command": c, "why": why })).collect();
        let fl: Vec<Value> = files.iter().map(|(p, _)| json!(root.dir.join(p).to_string_lossy())).collect();
        out.log(&pretty(&json!({ "workspace": root.dir_str(), "files": fl, "next": nx })));
        return Ok(0);
    }
    out.log("");
    out.log(&format!("Wrote the demo's data to {}:", root.dir_str()));
    out.log("  model.json, dataset.json   the Astronomy Shop on Docker Compose: the calibrated model and its recorded day");
    out.log(&format!("  strategies/                {}", d.strategies.iter().map(|(f, _)| f.as_str()).collect::<Vec<_>>().join(", ")));
    out.log(&format!("  k8s/                       {}, as an agent workspace (model.json, dataset.json)", s(&d.k8s_model, &["name"])));
    out.log("");
    print_next(&next, out);
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// the binary's demo data is the committed reference data, byte for byte (build.rs packs it)
    #[test]
    fn bundle_is_the_reference_data() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let files = bundle().unwrap();
        let mut want = vec![("shop/model.json".to_string(), root.join("reference/shop/model.json")), ("shop/dataset.json".to_string(), root.join("reference/shop/dataset.json"))];
        let mut st: Vec<String> = std::fs::read_dir(root.join("reference/shop/strategies")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).filter(|f| f.ends_with(".yaml")).collect();
        st.sort();
        assert_eq!(st.len(), 4);
        for f in st {
            want.push((format!("shop/strategies/{}", f), root.join("reference/shop/strategies").join(&f)));
        }
        want.push(("k8s-shop.json".to_string(), root.join("public/reference/k8s-shop.json")));
        assert_eq!(files.iter().map(|(k, _)| k.clone()).collect::<Vec<_>>(), want.iter().map(|(k, _)| k.clone()).collect::<Vec<_>>());
        for ((k, bytes), (_, path)) in files.iter().zip(&want) {
            assert!(bytes == &std::fs::read(path).unwrap(), "{} differs from {}", k, path.display());
        }
        // and every piece parses as what it is
        let d = load().unwrap();
        model_of(&d.shop_model).unwrap();
        dataset_of(&d.shop_dataset).unwrap();
        model_of(&d.k8s_model).unwrap();
        dataset_of(&d.k8s_dataset).unwrap();
        for (f, y) in &d.strategies {
            crate::strategy::parse_strategy(&parse_yaml(y).unwrap()).unwrap_or_else(|e| panic!("{}: {}", f, e));
        }
        assert!(!super::super::reports::g(&d.k8s_model, &["cluster"]).is_null(), "the Kubernetes model places pods on nodes");
    }
}
