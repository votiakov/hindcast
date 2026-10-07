/**
 * Bottleneck MCP server — exposes the simulation engine to AI assistants over stdio.
 *
 *   npm run mcp            (Claude Code picks it up from .mcp.json)
 *
 * Typical flow for an assistant: list_components → describe the user's system as an
 * architecture spec → validate_architecture → simulate / compare_architectures /
 * find_breaking_point → open_in_app to hand the user a live, visual version.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { existsSync, readFileSync } from 'node:fs';

const APP_URL = process.env.BOTTLENECK_APP_URL ?? 'http://localhost:5173';

const INSTRUCTIONS = `Bottleneck simulates distributed-system architectures under load and failure.
Two engines: "fluid" (queueing model, milliseconds, used for quick checks and search) and "des" (discrete-event, every request simulated: real p50/p99/p99.9, emergent retry storms/timeouts/breakers, seeded). Use analyze for Monte Carlo confidence intervals and optimize_cost for the cheapest sizing that meets an SLO.
Describe a system as an architecture spec: components (id, kind, optional knobs) + connections ([caller, callee]) + optional zones (failure domains).
Kinds: client (traffic source), cdn, lb, gateway, server, worker, function, cache, db, replica, storage, queue, llm (self-hosted GPU), llmapi (hosted model API).
Rules: instances are only reachable behind lb/gateway/queue; db shares reads with replica children and fails over to them; cache/cdn need an origin behind them.
Dynamics: server/worker/llm can autoscale ({ min, max, targetUtil, warmupS, cooldownS }); caches go cold after a restart or flush-cache and re-warm over warmupS (thundering herd on the origin); a connection can carry network latency ({ from, to, latencyMs }).
Scenarios: duration, constant rps or traffic keyframes, readRatio, timed events (kill-id, kill, fail-zone, degrade, inject-errors, inject-latency, flush-cache, restore…), SLO.
For "is this design production-ready / what breaks first / what should we fix", call audit_resilience: it replays every failure mode, grades user impact, and returns verified fixes priced in $/month.
Calibrate to a real system by overriding capacity (req/s per instance), latencyMs and costPerHour per component.
Results are directional: good for comparing designs and finding bottlenecks, not a substitute for load tests.`;

const json = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }] });

const server = new McpServer({ name: 'bottleneck', version: '1.0.0' }, { instructions: INSTRUCTIONS });

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
  'open_in_app',
  {
    title: 'Open in the Bottleneck app',
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
const CANVAS_URI = 'ui://bottleneck/canvas.html';
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

registerAppResource(server, 'Bottleneck live canvas', CANVAS_URI, { description: 'The Bottleneck simulator, rendering a spec or comparison live' }, async () => {
  const html = existsSync(CANVAS_FILE)
    ? readFileSync(CANVAS_FILE, 'utf8')
    : '<!doctype html><body style="font-family:sans-serif;padding:24px">Live canvas not built yet — run <code>npm run build:mcp</code> in the Bottleneck repo.</body>';
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

await server.connect(new StdioServerTransport());
