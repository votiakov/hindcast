/**
 * Hindcast MCP server — exposes the simulation and backtesting engines to AI agents over stdio.
 *
 *   npm run mcp            (Claude Code picks it up from .mcp.json)
 *
 * Two flows:
 *  - a real system: connect_telemetry → collect_telemetry → calibrate_model → verify_change
 *    (an infrastructure change backtested on production history, with a verdict and a confidence)
 *  - a design on paper: list_components → write a spec → verify_design (failures, headroom, cost,
 *    verified fixes) → open_in_app to hand the user a live, visual version.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isMainThread } from 'node:worker_threads';
import { startReplayThreads } from '../src/backtest/parallel';
import { z } from 'zod';
import { breakingPoint, catalog, compare, simulate } from '../src/sim/headless';
import { validateSpec } from '../src/spec/validate';
import { applyVariant, encodePayload } from '../src/spec/convert';
import { ArchitectureSpec, ScenarioSpec, VariantSpec } from '../src/spec/schema';
import { simulateDes } from '../src/sim/des/des';
import { analyzeParallel } from '../src/sim/des/nodePool';
import { optimize } from '../src/sim/optimize';
import { audit } from '../src/sim/audit';
import { auditMarkdown } from '../src/sim/auditReport';
import { importTerraform } from '../src/spec/terraform';
import { importKubernetes } from '../src/spec/kubernetes';
import { parseAllDocuments } from 'yaml';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { reviveModel, type Model } from '../src/backtest/model';
import type { Dataset } from '../src/backtest/dataset';
import { backtest } from '../src/backtest/backtest';
import { backtestMarkdown } from '../src/backtest/report';
import { OUTAGES, outageById, replayOutage } from '../src/backtest/outages';
import { lastWindow } from '../cli/backtest';
import { explainError, TOOLS } from '../agent/tools';
import { Workspace } from '../agent/workspace';
import { appLink } from '../agent/serve';

const APP_URL = process.env.HINDCAST_APP_URL ?? process.env.BOTTLENECK_APP_URL ?? 'http://localhost:5173';

const INSTRUCTIONS = `Hindcast lets an agent check infrastructure decisions before they ship.

REAL SYSTEMS (production telemetry): connect_telemetry (Prometheus URL, plus Jaeger or Tempo for traces, optionally the cloud bill) → collect_telemetry (history into the workspace) → calibrate_model (read its trust report) → suggest_changes for "what should we change / where can we save", and verify_change for any change you propose or are asked about: a strategy, a Kubernetes manifest diff, a Terraform plan, or edited manifests against read_cluster's snapshot. Start a session with model_status: the workspace (./.hindcast) may already hold a fresh model.
Report verify_change results with their verdict AND confidence. "pass" with confidence "low" means the change pushes a service past anything the history showed: say so and recommend a load test instead of calling it safe. Quote the money as a range when the band is wide, and say when prices are list prices rather than the bill. Never present a backtest as a guarantee.
Everything is read-only towards the user's systems; nothing is applied. Credentials are passed as env var names, never as values.

DESIGNS ON PAPER: verify_design checks a spec you wrote (failures, headroom, cost vs budget) and returns fixes as exact spec changes; apply them and verify again until it passes.

ENGINE DETAILS: Hindcast simulates distributed-system architectures under load and failure.
Two engines: "fluid" (queueing model, milliseconds, used for quick checks and search) and "des" (discrete-event, every request simulated: real p50/p99/p99.9, emergent retry storms/timeouts/breakers, seeded). Use analyze for Monte Carlo confidence intervals and optimize_cost for the cheapest sizing that meets an SLO.
Describe a system as an architecture spec: components (id, kind, optional knobs) + connections ([caller, callee]) + optional zones (failure domains).
Kinds: client (traffic source), cdn, lb, gateway, server, worker, function, cache, db, replica, storage, queue, llm (self-hosted GPU), llmapi (hosted model API).
Rules: instances are only reachable behind lb/gateway/queue; db shares reads with replica children and fails over to them; cache/cdn need an origin behind them.
Dynamics: server/worker/llm can autoscale ({ min, max, targetUtil, warmupS, cooldownS }); caches go cold after a restart or flush-cache and re-warm over warmupS (thundering herd on the origin); a connection can carry network latency ({ from, to, latencyMs }).
Scenarios: duration, constant rps or traffic keyframes, readRatio, timed events (kill-id, kill, fail-zone, degrade, inject-errors, inject-latency, flush-cache, restore…), SLO.
For "is this design production-ready / what breaks first / what should we fix", call audit_resilience: it replays every failure mode, grades user impact, and returns verified fixes priced in $/month.
Calibrate to a real system by overriding capacity (req/s per instance), latencyMs and costPerHour per component.
Results are directional: good for comparing designs and finding bottlenecks, not a substitute for load tests.
For real systems with recorded telemetry, use backtest_strategy (replays production history through a calibrated model, with measured accuracy) and replay_outage (famous public outages against that model).`;

const json = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }] });

const server = new McpServer({ name: 'hindcast', version: '1.0.0' }, { instructions: INSTRUCTIONS });

server.registerTool(
  'list_components',
  {
    title: 'List component types',
    description: 'Component kinds with default capacity, latency, price and knobs, plus size tiers and language runtimes. Call this before writing a spec.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => json(catalog()),
);

server.registerTool(
  'validate_architecture',
  {
    title: 'Validate an architecture spec',
    description: 'Schema check plus architectural lint (unreachable instances, caches without origin, dangling connections…).',
    inputSchema: { architecture: ArchitectureSpec },
    annotations: { readOnlyHint: true },
  },
  async ({ architecture }) => json(validateSpec(architecture)),
);

server.registerTool(
  'simulate',
  {
    title: 'Simulate an architecture',
    description:
      'Run one scenario (traffic shape + failure events) against an architecture. Returns SLO compliance, error rate, p99, cost, ranked bottlenecks with plain-English explanations, and an event log. Set include_timeline for a per-second series.',
    inputSchema: {
      architecture: ArchitectureSpec,
      scenario: ScenarioSpec.optional(),
      engine: z.enum(['fluid', 'des']).optional().describe('fluid (default, fast) or des (discrete-event: real percentiles, emergent retry storms)'),
      seed: z.number().int().optional().describe('des only: random seed (same seed → same result)'),
      include_timeline: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ architecture, scenario, engine, seed, include_timeline }) => {
    try {
      const r = engine === 'des' ? simulateDes(architecture, scenario ?? {}, { seed: seed ?? 1 }) : simulate(architecture, scenario ?? {});
      return json({ ...r, timeline: include_timeline ? r.timeline : undefined, timelineSamples: r.timeline.length });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'compare_architectures',
  {
    title: 'Compare architecture variants',
    description:
      'Test hypotheses: run a baseline plus variants (full specs or edit lists: set / add / remove / connect / disconnect) under the same scenario. Returns variants ranked — SLO-compliant first, then by cost — with each one\'s top bottleneck.',
    inputSchema: {
      architecture: ArchitectureSpec,
      variants: z.array(VariantSpec).min(1),
      scenario: ScenarioSpec.optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ architecture, variants, scenario }) => {
    try {
      const { ranked, results } = compare(architecture, variants, scenario ?? {});
      return json({ ranked, details: results.map((r) => ({ name: r.name, summary: r.result.summary, bottlenecks: r.result.bottlenecks })) });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'find_breaking_point',
  {
    title: 'Find the breaking point',
    description: 'Highest constant req/s the architecture sustains within SLO (steady state), and which component limits it.',
    inputSchema: {
      architecture: ArchitectureSpec,
      readRatio: z.number().min(0).max(1).optional(),
      slo: z.object({ maxErrorRate: z.number().optional(), maxP99Ms: z.number().optional() }).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ architecture, readRatio, slo }) => {
    try {
      return json(breakingPoint(architecture, { readRatio, slo }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'analyze',
  {
    title: 'Monte Carlo analysis (discrete-event)',
    description:
      'Run the discrete-event engine N times with different seeds (in parallel) and report means with 95% confidence intervals for error rate, p50/p99/p99.9 and cost, the probability the SLO is met, and which component is the bottleneck how often. Use this before making a claim about a design.',
    inputSchema: {
      architecture: ArchitectureSpec,
      scenario: ScenarioSpec.optional(),
      runs: z.number().int().min(2).max(200).optional().describe('default 20'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ architecture, scenario, runs }) => {
    try {
      return json(await analyzeParallel(architecture, scenario ?? {}, { runs: runs ?? 20 }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'optimize_cost',
  {
    title: 'Find the cheapest configuration that meets the SLO',
    description:
      'Sizes the existing topology (instances, tiers, optionally language runtimes) to the cheapest configuration that meets the SLO under the scenario — growing under-provisioned components and shrinking over-provisioned ones — then verifies with discrete-event Monte Carlo. Returns before/after cost, monthly savings and the exact changes (as a variant you can pass to compare_architectures or open_in_app). Include failure events in the scenario if the result must survive them (e.g. N+1).',
    inputSchema: {
      architecture: ArchitectureSpec,
      scenario: ScenarioSpec.optional(),
      allow_runtimes: z.boolean().optional().describe('may switch server/worker/function runtimes (e.g. node → go)'),
      slo: z.object({ maxErrorRate: z.number().optional(), maxP99Ms: z.number().optional() }).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ architecture, scenario, allow_runtimes, slo }) => {
    try {
      const r = optimize(architecture, (scenario ?? {}) as Record<string, unknown>, { allowRuntimes: allow_runtimes, slo });
      return json({ ...r, spec: undefined, variant: { name: 'optimized', changes: r.changes } });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'audit_resilience',
  {
    title: 'Failure audit: what breaks first, and what it costs',
    description:
      'Replays one minute at the expected load once per production failure mode — every component dying (one instance or all), every zone going dark, each dependency turning slow (+250 ms) or erroring (20 %), caches restarting cold, a 3× traffic surge — plus the breaking point. Grades each incident by user impact (critical / major / minor / ok), detects self-healing and metastable non-recovery, lists the blast radius, and proposes fixes that are verified by re-running the same incident and priced in $/month. Returns a resilience score and a ranked risk register, plus a Markdown report. Ask the user for their expected req/s and what a minute of outage costs them.',
    inputSchema: {
      architecture: ArchitectureSpec,
      rps: z.number().positive().optional().describe('expected load (default: half the breaking point)'),
      read_ratio: z.number().min(0).max(1).optional(),
      slo: z.object({ maxErrorRate: z.number().optional(), maxP99Ms: z.number().optional() }).optional(),
      incident_cost_per_minute: z.number().nonnegative().optional().describe('$ a minute of full outage costs the business'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ architecture, rps, read_ratio, slo, incident_cost_per_minute }) => {
    try {
      const r = audit(architecture, { rps, readRatio: read_ratio, slo, incidentCostPerMinute: incident_cost_per_minute });
      return json({ ...r, findings: r.findings.map(({ scenario: _s, ...f }) => f), report_markdown: auditMarkdown(r) });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'import_terraform',
  {
    title: 'Import an architecture from Terraform',
    description:
      'Convert `terraform show -json` output (state or saved plan) into an architecture spec priced with AWS us-east-1 SKUs. Resolves real wiring (CloudFront origins, ALB listeners → target groups → ASG/ECS/instances, API Gateway integrations, Lambda event sources, RDS replicas) and reports every heuristic it had to use (cache-aside reads, queue producers, hit rates) in `assumptions` — confirm those with the user, then simulate/optimize. Ask the user for request rates and SLOs; Terraform has neither.',
    inputSchema: {
      terraform_json: z.record(z.string(), z.unknown()).describe('parsed JSON of `terraform show -json [plan]`'),
      name: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ terraform_json, name }) => {
    try {
      const r = importTerraform(terraform_json, name);
      return json({ ...r, lint: validateSpec(r.spec).issues });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'import_kubernetes',
  {
    title: 'Import an architecture from Kubernetes manifests',
    description:
      'Convert Kubernetes manifests (kubectl -o yaml, Helm template output, kustomize build — one or many YAML documents) into an architecture spec. Deployments/StatefulSets become components (images identify databases, caches, brokers, inference servers); HPAs become autoscaling; Ingress / LoadBalancer Services become entry points; call edges are inferred from Service names referenced in env vars and args. Every guess is listed in `assumptions` — confirm them with the user, ask for request rates and SLOs, then simulate or audit.',
    inputSchema: {
      manifests_yaml: z.string().describe('the manifests as YAML text (multi-document allowed)'),
      name: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ manifests_yaml, name }) => {
    try {
      const r = importKubernetes(parseAllDocuments(manifests_yaml).map((d) => d.toJS()), name);
      return json({ ...r, lint: validateSpec(r.spec).issues });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'open_in_app',
  {
    title: 'Open in the Hindcast app',
    description:
      'Return a link that opens the architecture in the visual app (sandbox), or — with `compare_with` — side by side with a variant in Compare mode, optionally running a scenario. Use it to turn an analysis into a live demo. The app must be running (npm run dev).',
    inputSchema: {
      architecture: ArchitectureSpec,
      compare_with: VariantSpec.optional(),
      scenario: ScenarioSpec.optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ architecture, compare_with, scenario }) => {
    try {
      if (!compare_with) return json({ url: `${APP_URL}/#spec=${encodePayload(architecture)}` });
      const b = applyVariant(architecture, compare_with);
      return json({ url: `${APP_URL}/#compare=${encodePayload({ a: { title: architecture.name ?? 'baseline', spec: architecture }, b: { title: compare_with.name, spec: b }, scenario })}` });
    } catch (e) {
      return fail(e);
    }
  },
);

// ---- MCP Apps: live canvas rendered inline by hosts that support it (Claude, ChatGPT, …) ----
const CANVAS_URI = 'ui://hindcast/canvas.html';
const CANVAS_FILE = new URL('../dist-mcp/mcp-app.html', import.meta.url);

registerAppTool(
  server,
  'show_architecture',
  {
    title: 'Show the live simulation',
    description:
      'Render the architecture as a live, animated simulation inside the conversation (MCP Apps hosts). With `compare_with`, show both side by side; with a `scenario`, play it on both. Hosts without UI support get a link to the app instead.',
    inputSchema: {
      architecture: ArchitectureSpec,
      compare_with: VariantSpec.optional(),
      scenario: ScenarioSpec.optional(),
    },
    _meta: { ui: { resourceUri: CANVAS_URI } },
  },
  async ({ architecture, compare_with, scenario }) => {
    try {
      const payload = compare_with
        ? { compare: { a: { title: architecture.name ?? 'baseline', spec: architecture }, b: { title: compare_with.name, spec: applyVariant(architecture, compare_with) }, scenario } }
        : { spec: architecture };
      const url = compare_with ? `${APP_URL}/#compare=${encodePayload(payload.compare)}` : `${APP_URL}/#spec=${encodePayload(architecture)}`;
      return {
        content: [{ type: 'text' as const, text: `Rendering ${compare_with ? `${architecture.name ?? 'baseline'} vs ${compare_with.name}` : (architecture.name ?? 'the architecture')} live. Also available at ${url}` }],
        structuredContent: payload,
      };
    } catch (e) {
      return fail(e);
    }
  },
);

registerAppResource(server, 'Hindcast live canvas', CANVAS_URI, { description: 'The Hindcast simulator, rendering a spec or comparison live' }, async () => {
  const html = existsSync(CANVAS_FILE)
    ? readFileSync(CANVAS_FILE, 'utf8')
    : '<!doctype html><body style="font-family:sans-serif;padding:24px">Live canvas not built yet — run <code>npm run build:mcp</code> in the Hindcast repo.</body>';
  return {
    contents: [
      {
        uri: CANVAS_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: html,
        _meta: { ui: { csp: { resourceDomains: ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'] } } },
      },
    ],
  };
});


// ---- backtesting on real data ----
const readModel = (path: string) => reviveModel(JSON.parse(readFileSync(path, 'utf8')) as Model);
const readDataset = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Dataset;

server.registerTool(
  'backtest_strategy',
  {
    title: 'Backtest infrastructure changes on recorded production history',
    description:
      'Replay real traffic through a calibrated model (hindcast calibrate → model.json, hindcast import → dataset.json) with each strategy applied: $ saved/spent per month, minutes out of SLO, failed requests, worst moment and why, with 10th–90th percentile bands, ranked. Strategies are YAML/JSON objects: { name, changes: [{ service, replicas | autoscale | cpu | memoryGb | arch | perf | capacityRps | cache | readReplicas | zone | region } | { endpoint, retries, timeoutMs }] }. Reference models ship in reference/<system>/model.json and dataset.json.',
    inputSchema: {
      model: z.string().optional().describe('path to model.json (default: the workspace model)'),
      dataset: z.string().optional().describe('path to dataset.json (default: the workspace dataset)'),
      strategies: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).describe('strategy objects, or YAML text'),
      last: z.string().optional().describe('only the last part of the history, e.g. "14d", "6h"'),
      draws: z.number().int().min(1).max(100).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ model, dataset, strategies, last, draws }) => {
    try {
      const ws = new Workspace();
      const m = readModel(model ?? ws.path('model.json'));
      let d = readDataset(dataset ?? ws.path('dataset.json'));
      if (last) d = lastWindow(d, last);
      const r = backtest(m, d, strategies.map((s) => (typeof s === 'string' ? parseYaml(s) : s)), { draws: draws ?? 20 });
      return { content: [{ type: 'text' as const, text: backtestMarkdown(r, m) }] };
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'replay_outage',
  {
    title: 'Would this design have survived a famous outage?',
    description: `Replay a public outage's published timeline against a calibrated model, as built and with strategies. Outages: ${OUTAGES.map((o) => `${o.id} (${o.title})`).join('; ')}.`,
    inputSchema: {
      model: z.string().optional().describe('path to model.json (default: the workspace model)'),
      outage: z.enum(OUTAGES.map((o) => o.id) as [string, ...string[]]),
      strategies: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).optional(),
      rps: z.number().positive().optional().describe('your normal load (default: p90 of the model history)'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ model, outage, strategies, rps }) => {
    try {
      const m = readModel(model ?? new Workspace().path('model.json'));
      const o = outageById(outage)!;
      const { replay, result } = replayOutage(m, o, (strategies ?? []).map((s) => (typeof s === 'string' ? parseYaml(s) : s)), { baseRps: rps });
      return json({ outage: o.title, what: o.what, timeline: o.timeline, assumptions: o.assumptions, sources: o.sources, roles: replay.roles, warnings: replay.warnings, report: backtestMarkdown(result, m) });
    } catch (e) {
      return fail(e);
    }
  },
);

// ---- agent tools: real telemetry in, verdicts out (agent/tools.ts, shared with `hindcast agent`) ----
for (const t of TOOLS) {
  server.registerTool(
    t.name,
    { title: t.title, description: t.description, inputSchema: t.input, annotations: { readOnlyHint: t.name === 'model_status' || t.name === 'verify_design' || t.name === 'find_headroom', openWorldHint: t.name === 'connect_telemetry' || t.name === 'collect_telemetry' || t.name === 'read_cluster' } },
    async (args: Record<string, unknown>, extra) => {
      try {
        const ws = new Workspace(args.workspace as string | undefined);
        // phases as progress notifications, when the client asked for them (keeps long calls alive)
        const token = extra._meta?.progressToken;
        const progress = token === undefined ? undefined : async (message: string, done: number, total: number) => {
          await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: done, total, message } });
        };
        const out = (await t.run(args, ws, progress)) as Record<string, unknown>;
        // a verified change opens on the app's backtest screen while this server runs
        const bundle = (out?.reports as { bundle?: string } | undefined)?.bundle;
        if (bundle) out.app = { open: await appLink(ws, bundle), note: 'opens the backtest screen with these strategies over the same history, served from this MCP server while it runs' };
        return json(out);
      } catch (e) {
        return fail(explainError(e));
      }
    },
  );
}

// ---- prompts: the workflows, for hosts that surface MCP prompts as commands ----
server.registerPrompt(
  'verify-infra-change',
  { title: 'Verify an infrastructure change on real history', description: 'Backtest a proposed change (strategy, manifests, Terraform plan) and report a verdict with its confidence', argsSchema: { change: z.string().describe('the change, in words, or a path to manifests / a plan') } },
  ({ change }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Verify this infrastructure change with Hindcast before it ships: ${change}

1. model_status. If there is no model, or the history is older than a week: connect_telemetry (ask me for the Prometheus and Jaeger/Tempo URLs if you don't know them) → collect_telemetry (7d if the data has it) → calibrate_model.
2. Read the calibration trust report. Mention any service the change touches that is "extrapolated" or fits poorly.
3. verify_change with the change as a strategy, a Kubernetes diff, a Terraform plan or edited manifests against read_cluster.
4. Answer in this order: verdict and confidence; $ per month (range, and whether it is the bill or list prices); minutes out of SLO added; the worst moment and why; what would make it safer. Give the app.open link (the backtest screen) and the HTML report path. Do not call a low-confidence pass safe.`,
        },
      },
    ],
  }),
);

server.registerPrompt(
  'check-my-design',
  { title: 'Check a system design', description: 'Write the design as a spec, find what breaks first, and fix it until it passes', argsSchema: { design: z.string().describe('the design, in words'), rps: z.string().optional().describe('expected req/s'), budget: z.string().optional().describe('$ per month') } },
  ({ design, rps, budget }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Check this design with Hindcast: ${design}${rps ? ` at ${rps} req/s` : ''}${budget ? `, budget $${budget}/month` : ''}.

1. list_components, then write the architecture spec (components, connections, zones).
2. verify_design${rps ? ` with rps ${rps}` : ''}${budget ? ` and budgetMonthly ${budget}` : ''}.
3. While it fails: apply the cheapest fix that resolves each critical finding (each fix lists its spec changes) and verify again.
4. Report the final design, what each fix bought and cost, the remaining risks, and the link to open it in the app.`,
        },
      },
    ],
  }),
);

// in a build, replay threads load this same file: only the main thread serves
if (isMainThread) {
  void startReplayThreads();
  await server.connect(new StdioServerTransport());
}
