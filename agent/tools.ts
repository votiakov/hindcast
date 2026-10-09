import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { connectTelemetry, readCluster } from './connect';
import { collect } from './collect';
import { calibrateModel, modelStatus, verifyChange, verifyDesign, type ChangeInput } from './verify';
import { Workspace } from './workspace';
import { reviveModel, type Model } from '../src/backtest/model';
import { basePlan } from '../src/backtest/engine';
import { applyStrategy } from '../src/backtest/strategy';
import { modelBreakingPoint } from '../src/backtest/accuracy';

/**
 * The agent tools, defined once: the MCP server registers them, and `bottleneck agent <tool>`
 * runs them from a shell (for agents without MCP, scripts and CI). Every tool is read-only towards
 * the user's systems: it queries Prometheus, Jaeger/Tempo and (read_cluster) the Kubernetes API,
 * and writes only inside the workspace directory.
 */

export interface AgentTool {
  name: string;
  title: string;
  description: string;
  input: z.ZodRawShape;
  run: (args: Record<string, unknown>, ws: Workspace) => Promise<unknown> | unknown;
}

const auth = {
  tokenEnv: z.string().optional().describe('env var holding a bearer token (the token itself never goes in the workspace)'),
  basicAuthEnv: z.string().optional().describe('env var holding "user:password"'),
  headersEnv: z.record(z.string(), z.string()).optional().describe('header → env var, e.g. { "X-Scope-OrgID": "TENANT" }'),
};
const slo = z.object({ p99Ms: z.number().positive(), errorRate: z.number().min(0).max(1) });
const workspace = z.string().optional().describe('workspace directory (default ./.bottleneck, or $BOTTLENECK_WORKSPACE)');

const change = z.union([
  z.object({ strategy: z.union([z.string(), z.record(z.string(), z.unknown())]).describe('a strategy object or YAML: { name, changes: [{ service, replicas | autoscale | cpu | memoryGb | arch | perf | capacityRps | cache | readReplicas | zone | region } | { endpoint, retries, timeoutMs }] }') }),
  z.object({ kubernetes: z.object({ base: z.string().describe('manifests before: a directory, a file, or YAML text'), head: z.string().describe('manifests after') }) }),
  z.object({ terraformPlan: z.union([z.string(), z.record(z.string(), z.unknown())]).describe('path to `terraform show -json plan.out` output, or the JSON itself') }),
  z.object({ cluster: z.object({ head: z.string().describe('the edited manifests (directory, file or YAML text)'), snapshot: z.string().optional().describe('a read_cluster snapshot (default: the latest)') }) }),
]);

export const TOOLS: AgentTool[] = [
  {
    name: 'connect_telemetry',
    title: 'Connect to telemetry (Prometheus, Jaeger/Tempo, bill)',
    description:
      'Point Bottleneck at the system\'s live telemetry and probe it, read-only: which metric presets Prometheus supports, which services it names, how far back data goes; which services Jaeger or Tempo knows and which ones requests enter through. Saves the connection in the workspace (credentials only as env var names). Call this first; calling it again merges new settings. Returns problems to fix and what the model will be able to know.',
    input: {
      workspace,
      prometheus: z.object({ url: z.string().url(), selector: z.string().optional().describe('label matchers added to every query, e.g. namespace="shop"'), presets: z.array(z.enum(['otel-spanmetrics', 'http-server', 'cadvisor', 'kubernetes'])).optional().describe('default: every preset whose metrics exist'), ...auth }).optional(),
      jaeger: z.object({ url: z.string().url().describe('Jaeger query UI/API base, e.g. http://jaeger:16686'), ...auth }).optional(),
      tempo: z.object({ url: z.string().url().describe('Tempo HTTP API base, e.g. http://tempo:3200'), ...auth }).optional(),
      traceFiles: z.array(z.string()).optional().describe('OTLP JSON lines or Jaeger JSON files (globs ok), instead of a trace backend'),
      bill: z.object({ cur: z.string().optional().describe('AWS Cost and Usage Report CSV'), gcp: z.string().optional().describe('GCP billing export'), tag: z.string().optional().describe('cost-allocation tag naming the component, e.g. user:service'), resources: z.record(z.string(), z.string()).optional() }).optional(),
      system: z
        .object({
          name: z.string().optional(),
          slo: slo.optional().describe('system SLO (default p99 500 ms, errors 1%)'),
          timeoutMs: z.number().positive().optional().describe('client deadline: slower answers count as failures'),
          rename: z.record(z.string(), z.string()).optional().describe('raw service names → one id across sources'),
          hostedBy: z.record(z.string(), z.string()).optional().describe('in-process dependencies seen in traces → the service they run in'),
          entry: z.array(z.string()).optional().describe('services requests enter through (default: found in traces)'),
          ignore: z.array(z.string()).optional().describe('services outside the system, e.g. load generators (default: client-only services in traces)'),
          exclude: z.array(z.string()).optional().describe('services to drop from the collected history: another system sharing the Prometheus (collect_telemetry lists services no trace touches)'),
        })
        .optional(),
    },
    run: (a, ws) => connectTelemetry(ws, a as Parameters<typeof connectTelemetry>[1]),
  },
  {
    name: 'collect_telemetry',
    title: 'Collect history from the connected telemetry',
    description:
      'Query Prometheus over a window, fetch traces spread across it from Jaeger/Tempo, add the bill, and import everything into the workspace dataset. Reports per service which signals exist (request rate, errors, p99, CPU, CPU limit, replicas, traces) and what is missing. Longer history with a busy peak makes a better model: one overload in the history is worth more than a month of quiet days.',
    input: {
      workspace,
      last: z.string().optional().describe('how much history, e.g. "6h", "7d", "14d" (default 24h, or what the data covers)'),
      start: z.union([z.string(), z.number()]).optional().describe('window start (ISO or epoch s), instead of last'),
      end: z.union([z.string(), z.number()]).optional().describe('window end (default now, or the newest data)'),
      stepS: z.number().int().positive().optional().describe('bucket size in seconds (default: window / ~1000, at least 30)'),
      maxTraces: z.number().int().positive().optional().describe('traces to fetch, spread over the window (default 3000)'),
    },
    run: (a, ws) => collect(ws, a as Parameters<typeof collect>[1]),
  },
  {
    name: 'calibrate_model',
    title: 'Calibrate a model of the system from the collected history',
    description:
      'Fit the model: capacity per replica (with its band) and what limits it (CPU, a lock or pool), latency, errors and cost per service; endpoint paths from traces. Holds back the last part of the history to measure accuracy on data the model never saw. Returns a trust report: services whose limit the history actually reached, services whose capacity is extrapolated, and services the model cannot explain. Read it before relying on verify_change.',
    input: {
      workspace,
      holdout: z.number().min(0).max(0.6).optional().describe('share of the history held back to measure accuracy (default 0.3; 0 to skip)'),
      slo: slo.optional(),
      timeoutMs: z.number().positive().optional(),
      listPrices: z.boolean().optional().describe('price services without a bill line at AWS Fargate list prices (default true)'),
    },
    run: (a, ws) => calibrateModel(ws, a as Parameters<typeof calibrateModel>[1]),
  },
  {
    name: 'model_status',
    title: 'What the workspace holds',
    description: 'Connections, the collected history (window, age), the model (fit and trust per service, accuracy), recent reports, warnings (stale history, unmeasured accuracy) and the next step. Cheap: call it at the start of a session to see what is already there.',
    input: { workspace },
    run: (_a, ws) => modelStatus(ws),
  },
  {
    name: 'verify_change',
    title: 'Verify an infrastructure change against real history',
    description:
      'Backtest one or more changes over the collected history, before they ship: $ per month saved or spent (with its 10–90% band), minutes out of SLO added or removed, failed requests, the worst moment and why, endpoints that get worse, headroom before and after. A change is a strategy (object or YAML), a Kubernetes manifest diff (base/head), a Terraform plan (`terraform show -json`), or edited manifests against the live cluster snapshot from read_cluster. Each result has verdict pass | fail | inconclusive and a confidence (high | medium | low) that says which services the change pushes past anything the history showed. Writes an HTML and Markdown report for a human.',
    input: {
      workspace,
      changes: z.array(change).min(1),
      last: z.string().optional().describe('only the last part of the history, e.g. "7d"'),
      gateMinutes: z.number().min(0).optional().describe('minutes out of SLO a change may add before it fails (default 0.5)'),
      draws: z.number().int().min(1).max(100).optional().describe('capacity draws for the bands (default 30)'),
    },
    run: (a, ws) => verifyChange(ws, a.changes as ChangeInput[], a as Parameters<typeof verifyChange>[2]),
  },
  {
    name: 'find_headroom',
    title: 'How much more traffic the system can take',
    description: 'The req/s the calibrated model sustains within SLO with today\'s endpoint mix, and which service saturates first — as built, and optionally with a strategy applied.',
    input: { workspace, strategy: z.union([z.string(), z.record(z.string(), z.unknown())]).optional() },
    run: (a, ws) => {
      const m = reviveModel(ws.readJson<Model>('model.json'));
      const base = basePlan(m);
      const now = modelBreakingPoint(m, base);
      const out: Record<string, unknown> = { asBuilt: { rps: Math.round(now.rps * 10) / 10, limitedBy: now.limitedBy }, historyPeakRps: m.traffic?.peak, slo: m.slo };
      if (a.strategy) {
        const spec = typeof a.strategy === 'string' ? parseYaml(a.strategy) : a.strategy;
        const after = modelBreakingPoint(m, applyStrategy(m, base, spec).plan);
        out.withStrategy = { rps: Math.round(after.rps * 10) / 10, limitedBy: after.limitedBy };
      }
      return out;
    },
  },
  {
    name: 'verify_design',
    title: 'Verify a system design (no history needed)',
    description:
      'Check an architecture spec an agent wrote or proposes: validate it, simulate it at the expected load, replay every failure (instance and component deaths, zone loss, slow and erroring dependencies, cold caches, a 3× surge), measure headroom and cost against a budget. Verdict pass | pass with risks | fail, with findings and verified fixes that list the exact spec changes to apply. Use list_components to write the spec. Numbers come from catalogue defaults unless the spec overrides capacity, latency and cost.',
    input: {
      spec: z.union([z.string(), z.record(z.string(), z.unknown())]).describe('architecture spec, object or YAML'),
      rps: z.number().positive().optional().describe('expected load (default: half the breaking point)'),
      slo: z.object({ maxP99Ms: z.number().positive().optional(), maxErrorRate: z.number().min(0).max(1).optional() }).optional(),
      budgetMonthly: z.number().positive().optional().describe('$ per month the design must fit in'),
      incidentCostPerMinute: z.number().positive().optional().describe('what a minute of outage costs, to price risk'),
    },
    run: (a) => verifyDesign(a.spec, a as Parameters<typeof verifyDesign>[1]),
  },
  {
    name: 'read_cluster',
    title: 'Snapshot a Kubernetes cluster\'s workloads (read-only)',
    description:
      'Run `kubectl get deployments,statefulsets,hpa -o json` against an explicitly named context and save the snapshot: replicas, CPU and memory limits, autoscalers and architecture per workload. Never uses the current context implicitly and never runs anything but get. Then verify_change with { cluster: { head } } backtests edited manifests against what is running.',
    input: { workspace, context: z.string().describe('kube context name — required, never implied'), namespace: z.string().optional(), selector: z.string().optional().describe('label selector') },
    run: (a, ws) => readCluster(ws, a as Parameters<typeof readCluster>[1]),
  },
];

export const toolByName = (name: string) => TOOLS.find((t) => t.name === name);

/** errors an agent can act on: zod issues as "path: message" lines instead of a JSON dump */
export function explainError(e: unknown): string {
  if (e instanceof z.ZodError) return `invalid input:\n${e.issues.map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')}`;
  return e instanceof Error ? e.message : String(e);
}

export async function runTool(name: string, args: Record<string, unknown>) {
  const t = toolByName(name);
  if (!t) throw new Error(`no tool "${name}" — one of ${TOOLS.map((x) => x.name).join(', ')}`);
  const parsed = z.object(t.input).parse(args) as Record<string, unknown>;
  return t.run(parsed, new Workspace(parsed.workspace as string | undefined));
}
