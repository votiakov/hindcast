import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { connectTelemetry, readCluster } from './connect';
import { collect } from './collect';
import { calibrateModel, modelStatus, verifyChange, verifyDesign, type ChangeInput } from './verify';
import { Workspace } from './workspace';
import { suggestChanges } from './suggest';
import { reviveModel, type Model } from '../src/backtest/model';
import { basePlan } from '../src/backtest/engine';
import { applyStrategy } from '../src/backtest/strategy';
import { modelBreakingPoint } from '../src/backtest/accuracy';
import { nodeLoss } from '../src/backtest/resilience';
import { reviewCapacity } from './review';
import type { Dataset } from '../src/backtest/dataset';

/**
 * The agent tools, defined once: the MCP server registers them, and `hindcast agent <tool>`
 * runs them from a shell (for agents without MCP, scripts and CI). Every tool is read-only towards
 * the user's systems: it queries Prometheus, Jaeger/Tempo and (read_cluster) the Kubernetes API,
 * and writes only inside the workspace directory.
 */

export interface AgentTool {
  name: string;
  title: string;
  description: string;
  input: z.ZodRawShape;
  run: (args: Record<string, unknown>, ws: Workspace, progress?: Progress) => Promise<unknown> | unknown;
}

/** long tools report their phases (MCP progress notifications; ignored from the shell) */
export type Progress = (message: string, done: number, total: number) => Promise<void>;

const auth = {
  tokenEnv: z.string().optional().describe('env var holding a bearer token (the token itself never goes in the workspace)'),
  basicAuthEnv: z.string().optional().describe('env var holding "user:password"'),
  headersEnv: z.record(z.string(), z.string()).optional().describe('header → env var, e.g. { "X-Scope-OrgID": "TENANT" }'),
};
const slo = z.object({ p99Ms: z.number().positive(), errorRate: z.number().min(0).max(1) });
const workspace = z.string().optional().describe('workspace directory (default ./.hindcast, or $HINDCAST_WORKSPACE)');

const change = z.union([
  z.object({ strategy: z.union([z.string(), z.record(z.string(), z.unknown())]).describe('a strategy object or YAML: { name, changes: [{ service, replicas | autoscale | cpu | memoryGb | cpuRequest | memoryRequestGb | arch | perf | capacityRps | cache | readReplicas | zone | region } | { endpoint, retries, timeoutMs }] }') }),
  z.object({ kubernetes: z.object({ base: z.string().describe('manifests before: a directory, a file, or YAML text'), head: z.string().describe('manifests after') }) }),
  z.object({ terraformPlan: z.union([z.string(), z.record(z.string(), z.unknown())]).describe('path to `terraform show -json plan.out` output, or the JSON itself') }),
  z.object({ cluster: z.object({ head: z.string().describe('the edited manifests (directory, file or YAML text)'), snapshot: z.string().optional().describe('a read_cluster snapshot (default: the latest)') }) }),
]);

export const TOOLS: AgentTool[] = [
  {
    name: 'connect_telemetry',
    title: 'Connect to telemetry (Prometheus, Jaeger/Tempo, bill)',
    description:
      'Point Hindcast at the system\'s live telemetry and probe it, read-only: which metric presets Prometheus supports, which services it names, how far back data goes; which services Jaeger or Tempo knows and which ones requests enter through. Saves the connection in the workspace (credentials only as env var names). Call this first; calling it again merges new settings. Returns problems to fix and what the model will be able to know.',
    input: {
      workspace,
      prometheus: z.object({ url: z.string().url(), selector: z.string().optional().describe('label matchers added to every query, e.g. cluster="prod-eu"'), namespaces: z.array(z.string()).optional().describe('Kubernetes namespaces the system runs in (default: the namespaces holding the traced services)'), presets: z.array(z.enum(['otel-spanmetrics', 'http-server', 'spring', 'ingress-nginx', 'cadvisor', 'kubernetes'])).optional().describe('default: every preset whose metrics exist'), ...auth }).optional(),
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
      windows: z
        .array(z.object({ start: z.union([z.string(), z.number()]), end: z.union([z.string(), z.number()]) }))
        .optional()
        .describe('several windows instead of one — an ordinary week plus a load test, say. A calm history never shows where latency turns; one load test in it teaches the model'),
    },
    run: (a, ws, progress) => collect(ws, a as Parameters<typeof collect>[1], progress),
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
    run: (a, ws, progress) => calibrateModel(ws, a as Parameters<typeof calibrateModel>[1], progress),
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
      window: z
        .object({ start: z.union([z.string(), z.number()]), end: z.union([z.string(), z.number()]) })
        .optional()
        .describe('replay only this part of the history — the ordinary week, when the history also holds a load test (the model still learned from all of it)'),
      traffic: z
        .object({ scale: z.number().positive().optional(), peakRps: z.number().positive().optional() })
        .optional()
        .describe('replay the history at another load — scale ×N, or peakRps for its busiest moment — to ask "does it survive launch day / Black Friday?"; the as-built system sees the same load'),
    },
    run: (a, ws) => verifyChange(ws, a.changes as ChangeInput[], a as Parameters<typeof verifyChange>[2]),
  },
  {
    name: 'suggest_changes',
    title: 'What should we change? Fixes and savings, backtested',
    description:
      'Generates candidate changes from the history itself and backtests them all: services that ran out of capacity get fixes (more replicas — of the host for an in-process dependency —, more CPU or CPU autoscaling when CPU-bound); services that idled get savings (fewer replicas, smaller CPU, Graviton). Returns the fixes that cut minutes out of SLO and the savings that pass, cheapest first, each with its verdict and confidence, the passing savings tried together, and what was rejected. Use it for "what should we change?", "where can we save?" or after a fail, then verify_change the one to ship.',
    input: {
      workspace,
      goal: z.enum(['reliability', 'cost', 'both']).optional().describe('fixes, savings, or both (default)'),
      last: z.string().optional(),
      draws: z.number().int().min(1).max(50).optional().describe('capacity draws per candidate (default 12)'),
      gateMinutes: z.number().min(0).optional(),
      idleBelow: z.number().min(0.05).max(0.8).optional().describe('a service is idle below this share of capacity at its busiest (default 0.35)'),
    },
    run: (a, ws, progress) => suggestChanges(ws, a as Parameters<typeof suggestChanges>[1], progress),
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
    name: 'review_capacity',
    title: 'Capacity review: headroom, busier days, node loss, binding limits, fixes and savings',
    description:
      'The capacity review a platform team does by hand, from the calibrated history, every number backtested: headroom over the busiest moment and what saturates first; whether 1.5× and 2× today\'s traffic hold; what losing a node at the peak costs and the single points of failure (Kubernetes), with the replicas that fix it; services held back by CPU quota throttling or near their memory limit; and the fixes and savings that pass. Writes a Markdown report into the workspace. Use it for "how are we doing?", "weekly capacity review", "are we ready for next week?".',
    input: { workspace, draws: z.number().int().min(1).max(30).optional().describe('capacity draws per replay (default 12)') },
    run: (a, ws, progress) => reviewCapacity(ws, a as { draws?: number }, progress),
  },
  {
    name: 'check_node_loss',
    title: 'Does it survive losing a Kubernetes node at its busiest?',
    description:
      'Replays the history\'s busiest moment with each node gone: every pod on it disappears at once (from kube_pod_info placement at the end of the history), services left with no replica are down, the rest serve on what is left, and Kubernetes brings the pods back after NotReady plus the default 300 s eviction toleration and a start (or never, when a fixed node pool has no room). Returns per node what it takes down, the minutes out of SLO and failed requests it adds, and the services one node failure takes out entirely. With a strategy, its replica changes are spread evenly over the nodes. Use it for "can we lose a node?", "is 2 replicas enough?", "where are our single points of failure?".',
    input: {
      workspace,
      strategy: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().describe('check under this strategy instead of as built'),
      traffic: z.object({ scale: z.number().positive().optional(), peakRps: z.number().positive().optional() }).optional().describe('at another load (launch day: scale 2)'),
      recoverS: z.number().positive().optional().describe('seconds until replacement pods serve (default 380)'),
      zones: z.boolean().optional().describe('lose a whole availability zone (every node in it) instead of one node — zones come from the nodes\' provider ids (AWS, GCP)'),
    },
    run: (a, ws) => {
      const m = reviveModel(ws.readJson<Model>('model.json'));
      const d = ws.readJson<Dataset>('dataset.json');
      const strategy = typeof a.strategy === 'string' ? parseYaml(a.strategy) : a.strategy;
      return nodeLoss(m, d, { strategy, load: a.traffic as { scale?: number; peakRps?: number } | undefined, recoverS: a.recoverS as number | undefined, zones: a.zones as boolean | undefined });
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
