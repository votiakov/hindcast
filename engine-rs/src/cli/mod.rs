//! The `hindcast` command line, natively (cli/bottleneck.ts): the same commands, flags and output as the
//! Node CLI, on the engine without WebAssembly or Node.

pub mod agent;
pub mod bt;
pub mod demo;
pub mod ci;
pub mod design;
pub mod files;
pub mod http;
pub mod mcp;
pub mod reports;
pub mod sim;
pub mod util;

use util::*;

const USAGE: &str = r#"Hindcast CLI — the simulation engine without the UI. (In a checkout of the repository, use "npm run sim --" in place of "hindcast".)

No system handy? A recorded one is built in (no network, no files):
  hindcast demo            [--workspace ./hindcast-demo] [--json]   (the review, a backtest and the accuracy record; --workspace writes the data out)

Start here, on a running system (read-only; one command → a capacity review):
  hindcast quickstart      --prometheus http://prom:9090 [--jaeger http://jaeger:16686 | --tempo http://tempo:3200] [--last 24h]

  hindcast validate        <arch.yaml>
  hindcast simulate        <arch.yaml> [scenario.yaml] [--rps 800 | --traffic metrics.csv] [--duration 60] [--engine fluid|des] [--seed 1] [--json]
                           [--engine des --trace <component> [--failed] [--count 3]]   (sampled requests through it, hop by hop)
  hindcast analyze         <arch.yaml> [scenario.yaml] [--runs 20]       (discrete-event Monte Carlo, 95% CIs)
  hindcast optimize        <arch.yaml> [scenario.yaml] [--runtimes] [--out optimized.yaml]
  hindcast compare         <arch.yaml> <variants.yaml> [scenario.yaml] [--json]
  hindcast breaking-point  <arch.yaml> [--p99 300] [--errors 0.01]
  hindcast audit           <arch.yaml> [--rps 500] [--cost-per-min 1000] [--md report.md] [--html report.html]   (what breaks first, and what it costs)
  hindcast link            <arch.yaml> [variants.yaml]     → open in the app
  hindcast mermaid         <arch.yaml> [--out diagram.mmd]  → a Mermaid flowchart for docs and pull requests
  hindcast import-terraform <terraform-show.json> [--name "My system"] [--out arch.yaml]
  hindcast import-k8s      <manifests.yaml …> [--name "My system"] [--out arch.yaml]      (Deployments, HPAs, StatefulSets, Services, Ingress)
  hindcast catalog
  hindcast mcp            [--http [--port 8787] [--host 127.0.0.1] [--all-tools] [--no-auth]]   (MCP server: stdio, or Streamable HTTP)

Backtesting on real data (files only; see docs/backtest.md):
  hindcast export-prometheus --url http://prom:9090 --start 2026-09-01 --end 2026-09-15 [--step 60] [--preset otel-spanmetrics,cadvisor] --out telemetry/
  hindcast import        <hindcast.import.yaml> [--out dataset.json]
  hindcast calibrate     <dataset.json> [--out model.json] [--p99 500] [--errors 0.01] [--timeout 5000] [--holdout 0.3]
  hindcast backtest      <model.json> <dataset.json> <strategy.yaml …> [--last 14d] [--scale 2 | --peak 400] [--draws 30] [--md r.md] [--html r.html] [--comment pr.md] [--card card.json] [--gate]
  hindcast headroom      <model.json> [strategy.yaml]
  hindcast accuracy      <model.json>
  hindcast outage        <model.json> <outage-id | list> [strategy.yaml …] [--role primary-db=orders-db] [--md r.md] [--html r.html]
  hindcast diff-strategy --base <dir> --head <dir> [--model model.json] [--out strategy.yaml]   (k8s manifests before/after → strategy)
  hindcast verify-change --model model.json --dataset dataset.json (--base <dir> --head <dir> | --terraform-plan plan.json | <strategy.yaml …>)
                         [--baseline-head <dir> | --baseline strategy.yaml] [--last 14d] [--p99 500] [--errors 0.01] [--comment pr.md] [--json result.json]
                         [--fail-on fail|inconclusive|never]   (the verify_change verdict, for CI; a baseline stacks it on an approved change)
  hindcast loadtest plan  [strategy.yaml …] [--base <dir> --head <dir>] [--service frontend[=0.9],…] [--workspace .hindcast] [--scale 1.3] [--out loadtest.k6.js] [--json]
                         (the load test a low-confidence verdict asks for: targets, a step-load k6 script, the follow-up)

For agents (the MCP tools, from a shell; JSON in, JSON out; see docs/agents.md):
  hindcast agent setup [claude|cursor|vscode|desktop|windsurf] [--write]   register the MCP server with an agent host
  hindcast agent list
  hindcast agent <tool> '<json args>' | @args.json | -      e.g. agent connect_telemetry '{"prometheus":{"url":"http://prom:9090"}}'
  tools: connect_telemetry collect_telemetry calibrate_model model_status review_capacity suggest_changes verify_change
         plan_load_test check_node_loss find_headroom verify_design read_cluster

Files may be YAML or JSON. A variants file is either a list of variants or { variants, scenario }."#;

/// run a command line (without the program name); the process exit code
pub fn main(args: Vec<String>) -> i32 {
    let mut out = Out::default();
    let code = match run(&args, &mut out) {
        Ok(c) => c,
        Err(e) => {
            out.err(&e);
            1
        }
    };
    out.flush();
    code
}

fn run(args: &[String], out: &mut Out) -> Result<i32, String> {
    let cmd = args.first().map(|s| s.as_str()).unwrap_or("");
    let rest = if args.is_empty() { &[][..] } else { &args[1..] };
    if matches!(cmd, "--version" | "-V" | "version") {
        out.log(&format!("hindcast {}", mcp::version()));
        return Ok(0);
    }
    // `hindcast <command> --help`: that command's lines of the usage, instead of running it with no arguments
    // (agent, demo, loadtest, quickstart and verify-change print their own)
    if rest.iter().any(|a| a == "--help" || a == "-h") && !matches!(cmd, "agent" | "demo" | "loadtest" | "quickstart" | "verify-change") {
        if let Some(usage) = command_usage(cmd) {
            out.log(&usage);
            return Ok(0);
        }
    }
    // a flag the command doesn't take is refused before it runs: ignored, it would be an answer to a
    // question that wasn't asked (an older binary judged a stacked change without --baseline-head)
    let key = if cmd == "agent" && rest.first().map(|s| s.as_str()) == Some("setup") { "agent setup" } else { cmd };
    if let Some(known) = command_flags(key) {
        unknown_flags(key, &flags(rest), known)?;
    }
    if cmd == "agent" {
        return agent::command(rest, out);
    }
    if cmd == "demo" {
        return demo::command(&flags(rest), out);
    }
    if cmd == "loadtest" {
        return agent::loadtest::command(rest, out);
    }
    if cmd == "quickstart" {
        return agent::quickstart::quickstart(&flags(rest), out);
    }
    if cmd == "mcp" {
        out.flush();
        // over HTTP: hindcast mcp --http [--port 8787] [--host 127.0.0.1] [--all-tools]
        if rest.iter().any(|a| a == "--http") {
            let val = |k: &str| rest.iter().position(|a| a == k).and_then(|i| rest.get(i + 1)).cloned();
            let port = val("--port").and_then(|p| p.parse().ok()).unwrap_or(8787);
            let host = val("--host").unwrap_or_else(|| "127.0.0.1".into());
            return Ok(mcp::serve_http(&host, port, rest.iter().any(|a| a == "--all-tools"), rest.iter().any(|a| a == "--no-auth")));
        }
        return Ok(mcp::serve());
    }
    let f = flags(rest);
    if let Some(code) = ci::command(cmd, &f, out)? {
        return Ok(code);
    }
    if let Some(code) = bt::command(cmd, &f, out)? {
        return Ok(code);
    }
    if let Some(code) = sim::command(cmd, &f, out)? {
        return Ok(code);
    }
    let scenario = |p: Option<&str>, o: &mut Out| sim::scenario_from(p, &f, o);
    if let Some(code) = design::command(cmd, &f, out, &scenario)? {
        return Ok(code);
    }
    out.log(USAGE);
    if !cmd.is_empty() && !matches!(cmd, "help" | "--help" | "-h") {
        out.err(&format!("unknown command \"{}\": the commands are listed above", cmd));
        return Ok(1);
    }
    Ok(0)
}

/// the flags each command reads (besides --help, which every one takes), or None for a name that isn't a command
fn command_flags(cmd: &str) -> Option<&'static [&'static str]> {
    Some(match cmd {
        "demo" => &["workspace", "json", "h"],
        "quickstart" => &["prometheus", "datadog", "dd-env", "dd-api-key-env", "dd-app-key-env", "token-env", "jaeger", "tempo", "topology", "calls", "namespace", "name", "exclude", "include", "p99", "errors", "last", "start", "end", "workspace", "json", "h"],
        "validate" => &["json"],
        "simulate" => &["rps", "duration", "traffic", "engine", "seed", "trace", "failed", "count", "json"],
        "analyze" => &["rps", "duration", "traffic", "runs", "seed", "json"],
        "optimize" => &["rps", "duration", "traffic", "runtimes", "p99", "errors", "out", "json"],
        "compare" => &["rps", "duration", "traffic", "json"],
        "breaking-point" => &["p99", "errors", "json"],
        "audit" => &["rps", "cost-per-min", "p99", "errors", "md", "html", "json"],
        "link" | "catalog" => &[],
        "mermaid" => &["out"],
        "import-terraform" | "import-k8s" => &["name", "out", "json"],
        "mcp" => &["http", "port", "host", "all-tools", "no-auth"],
        "export-prometheus" => &["url", "start", "end", "step", "preset", "selector", "window", "name", "out"],
        "import" => &["out", "json"],
        "calibrate" => &["out", "p99", "errors", "timeout", "holdout", "json"],
        "backtest" => &["last", "scale", "peak", "draws", "md", "html", "comment", "title", "run-url", "out", "card", "card-strategy", "gate", "json"],
        "headroom" | "accuracy" => &["json"],
        "outage" => &["role", "rps", "md", "html", "json"],
        "diff-strategy" => &["base", "head", "model", "name", "out"],
        "verify-change" => &[
            "model", "dataset", "calibration", "base", "head", "terraform-plan", "baseline-head", "baseline", "baseline-terraform-plan", "last", "draws", "gate-minutes", "p99", "errors", "scale", "peak",
            "comment", "json", "md", "html", "outputs", "print-json", "title", "comment-key", "run-url", "fail-on",
        ],
        "loadtest" => &["base", "head", "service", "workspace", "scale", "peak", "last", "margin", "steps", "hold", "mix", "out", "json", "h"],
        // a tool's arguments are its JSON; `agent setup` has flags of its own
        "agent" => &[],
        "agent setup" => &["write", "project", "workspace"],
        _ => return None,
    })
}

/// an error naming the flags `cmd` doesn't take (a near miss suggested) and the ones it does
fn unknown_flags(cmd: &str, f: &Flags, known: &[&str]) -> Result<(), String> {
    let unknown: Vec<String> = f
        .opt
        .keys()
        .filter(|k| k.as_str() != "help" && !known.contains(&k.as_str()))
        .map(|k| match known.iter().filter(|x| **x != "h").map(|x| (edits(k, x), *x)).min() {
            Some((d, near)) if d <= 2 && d < k.len() => format!("--{} (did you mean --{}?)", k, near),
            _ => format!("--{}", k),
        })
        .collect();
    if unknown.is_empty() {
        return Ok(());
    }
    let takes: Vec<String> = known.iter().filter(|x| **x != "h").map(|x| format!("--{}", x)).collect();
    Err(format!(
        "hindcast {}: unknown flag{} {}\n{} (hindcast {} --help)",
        cmd,
        if unknown.len() == 1 { "" } else { "s" },
        unknown.join(", "),
        if takes.is_empty() { "it takes no flags".to_string() } else { format!("it takes {}", takes.join(" ")) },
        cmd.split(' ').next().unwrap_or(cmd)
    ))
}

/// the edit distance between two flag names
fn edits(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut prev = row[0];
        row[0] = i + 1;
        for j in 0..b.len() {
            let cur = row[j + 1];
            row[j + 1] = (prev + usize::from(ca != b[j])).min(row[j] + 1).min(cur + 1);
            prev = cur;
        }
    }
    row[b.len()]
}

/// one command's lines of USAGE (its line and the indented ones continuing it), or None for a command it doesn't list
fn command_usage(cmd: &str) -> Option<String> {
    let lines: Vec<&str> = USAGE.lines().collect();
    let start = lines.iter().position(|l| {
        l.starts_with("  ") && l.trim_start().strip_prefix("hindcast ").and_then(|r| r.split_whitespace().next()) == Some(cmd)
    })?;
    let mut text: Vec<&str> = vec![lines[start].trim_start()];
    for l in &lines[start + 1..] {
        let t = l.trim_start();
        if !l.starts_with("   ") || t.is_empty() || t.starts_with("hindcast ") {
            break;
        }
        text.push(l.strip_prefix("  ").unwrap_or(l));
    }
    Some(format!("{}\n\nEvery command: hindcast --help", text.join("\n")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    fn flag_names(text: &str) -> Vec<String> {
        text.split("--").skip(1).map(|r| r.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-').collect::<String>()).filter(|f| !f.is_empty() && f != "help").collect()
    }

    #[test]
    fn a_flag_the_command_does_not_take_is_refused_with_the_ones_it_does() {
        let mut out = Out::default();
        let e = run(&args(&["verify-change", "--model", "m.json", "--baseline-hed", "x"]), &mut out).unwrap_err();
        assert!(e.starts_with("hindcast verify-change: unknown flag --baseline-hed (did you mean --baseline-head?)\nit takes --model --dataset"), "{}", e);
        assert!(e.ends_with("(hindcast verify-change --help)"), "{}", e);
        let e = run(&args(&["validate", "a.yaml", "--jsn", "--foo-bar-baz"]), &mut out).unwrap_err();
        assert_eq!(e, "hindcast validate: unknown flags --jsn (did you mean --json?), --foo-bar-baz\nit takes --json (hindcast validate --help)");
        let e = run(&args(&["catalog", "--json"]), &mut out).unwrap_err();
        assert_eq!(e, "hindcast catalog: unknown flag --json\nit takes no flags (hindcast catalog --help)");
        let e = run(&args(&["agent", "setup", "cursor", "--wirte"]), &mut out).unwrap_err();
        assert!(e.starts_with("hindcast agent setup: unknown flag --wirte (did you mean --write?)"), "{}", e);
        assert!(e.ends_with("(hindcast agent --help)"), "{}", e);
        let e = run(&args(&["agent", "model_status", "{}", "--workspace", "x"]), &mut out).unwrap_err();
        assert!(e.starts_with("hindcast agent: unknown flag --workspace\nit takes no flags"), "{}", e);
        let e = run(&args(&["agent", "model_status", "{}", "x"]), &mut out).unwrap_err();
        assert!(e.starts_with("hindcast agent model_status: one argument, the JSON (not also \"x\")"), "{}", e);
        // positional arguments and --help are not flags; a name that isn't a command is left to the usage
        assert!(unknown_flags("import-k8s", &flags(&args(&["a.yaml", "b.yaml", "--name", "x", "--help"])), command_flags("import-k8s").unwrap()).is_ok());
        assert!(command_flags("nonsense").is_none());
    }

    #[test]
    fn every_flag_a_usage_shows_is_one_its_command_takes() {
        let mut seen = 0;
        for line in USAGE.lines() {
            let Some(cmd) = line.trim_start().strip_prefix("hindcast ").and_then(|r| r.split_whitespace().next()) else { continue };
            // the agent lines are one each (setup, list, a tool); every other command's continues on the lines below
            let (key, text) = match cmd {
                "agent" if line.contains("agent setup") => ("agent setup", line.to_string()),
                "agent" => ("agent", line.to_string()),
                _ => (cmd, command_usage(cmd).unwrap_or_default()),
            };
            let known = command_flags(key).unwrap_or_else(|| panic!("hindcast {}: no flags declared", key));
            for f in flag_names(&text) {
                assert!(known.contains(&f.as_str()), "hindcast {}: --{} is in the usage and not in command_flags", key, f);
                seen += 1;
            }
        }
        assert!(seen > 80, "{}", seen);
        for (cmd, usage) in [("verify-change", ci::USAGE), ("quickstart", agent::quickstart::USAGE), ("demo", demo::USAGE)] {
            for f in flag_names(usage) {
                assert!(command_flags(cmd).unwrap().contains(&f.as_str()), "hindcast {}: --{}", cmd, f);
            }
        }
    }
}
