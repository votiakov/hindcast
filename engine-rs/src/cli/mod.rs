//! The `hindcast` command line, natively (cli/bottleneck.ts): the same commands, flags and output as the
//! Node CLI, on the engine without WebAssembly or Node.

pub mod agent;
pub mod bt;
pub mod design;
pub mod files;
pub mod http;
pub mod mcp;
pub mod reports;
pub mod sim;
pub mod util;

use util::*;

const USAGE: &str = r#"Hindcast CLI — the simulation engine without the UI. (In a checkout of the repository, use "npm run sim --" in place of "hindcast".)

Start here, on a running system (read-only; one command → a capacity review):
  hindcast quickstart      --prometheus http://prom:9090 [--jaeger http://jaeger:16686 | --tempo http://tempo:3200] [--last 24h]

  hindcast validate        <arch.yaml>
  hindcast simulate        <arch.yaml> [scenario.yaml] [--rps 800 | --traffic metrics.csv] [--duration 60] [--engine fluid|des] [--seed 1] [--json]
  hindcast analyze         <arch.yaml> [scenario.yaml] [--runs 20]       (discrete-event Monte Carlo, 95% CIs)
  hindcast optimize        <arch.yaml> [scenario.yaml] [--runtimes] [--out optimized.yaml]
  hindcast compare         <arch.yaml> <variants.yaml> [scenario.yaml] [--json]
  hindcast breaking-point  <arch.yaml> [--p99 300] [--errors 0.01]
  hindcast audit           <arch.yaml> [--rps 500] [--cost-per-min 1000] [--md report.md] [--html report.html]   (what breaks first, and what it costs)
  hindcast link            <arch.yaml> [variants.yaml]     → open in the app
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

For agents (the MCP tools, from a shell; JSON in, JSON out; see docs/agents.md):
  hindcast agent setup [claude|cursor|vscode|desktop|windsurf] [--write]   register the MCP server with an agent host
  hindcast agent list
  hindcast agent <tool> '<json args>' | @args.json | -      e.g. agent connect_telemetry '{"prometheus":{"url":"http://prom:9090"}}'
  tools: connect_telemetry collect_telemetry calibrate_model model_status review_capacity suggest_changes verify_change
         check_node_loss find_headroom verify_design read_cluster

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
    if cmd == "agent" {
        return agent::command(rest, out);
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
    Ok(if cmd.is_empty() { 0 } else { 1 })
}
