import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readWorkloads } from '../src/backtest/configDiff';
import { glob } from '../cli/files';
import { probeJaeger, probePrometheus, probeTempo, suggestRenames, type PrometheusProbe, type TraceProbe } from './sources';
import { Sources, Workspace } from './workspace';

/**
 * Connecting is probing: every source is asked what it holds before anything is collected, and
 * the answer says what the model will be able to know (and what it won't).
 */

type SourcesInput = Partial<Omit<Sources, 'system'>> & { system?: Partial<Sources['system']> };

export async function connectTelemetry(ws: Workspace, input: SourcesInput) {
  const cur = ws.sources();
  const next: Sources = Sources.parse({
    ...cur,
    ...Object.fromEntries(Object.entries(input).filter(([k, v]) => k !== 'system' && v !== undefined)),
    system: { ...cur.system, ...(input.system ?? {}) },
  });
  const report: { prometheus?: PrometheusProbe | { url: string; ok: false; error: string }; traces?: TraceProbe | { ok: false; error: string; url: string }; traceFiles?: { patterns: string[]; files: number }; bill?: { file: string; exists: boolean } } = {};
  const problems: string[] = [];

  if (next.prometheus) {
    try {
      report.prometheus = await probePrometheus(next.prometheus);
      if (!report.prometheus.presets.length) problems.push('Prometheus has none of the metrics Bottleneck reads (OpenTelemetry span metrics or HTTP server metrics, plus container metrics)');
    } catch (e) {
      report.prometheus = { url: next.prometheus.url, ok: false, error: (e as Error).message };
      problems.push(`Prometheus at ${next.prometheus.url}: ${(e as Error).message}`);
    }
  } else problems.push('no Prometheus: give prometheus.url (request rates, latency, CPU and limits come from it)');

  if (next.jaeger || next.tempo) {
    const url = (next.jaeger ?? next.tempo)!.url;
    try {
      report.traces = next.jaeger ? await probeJaeger(next.jaeger) : await probeTempo(next.tempo!);
    } catch (e) {
      report.traces = { ok: false, error: (e as Error).message, url };
      problems.push(`traces at ${url}: ${(e as Error).message}`);
    }
  } else if (next.traceFiles?.length) {
    const files = next.traceFiles.flatMap((p) => glob(p));
    report.traceFiles = { patterns: next.traceFiles, files: files.length };
    if (!files.length) problems.push(`no trace files match ${next.traceFiles.join(', ')}`);
  } else problems.push('no traces: give jaeger.url, tempo.url or traceFiles — without them the model has no topology');

  if (next.bill?.cur || next.bill?.gcp) {
    const f = (next.bill.cur ?? next.bill.gcp)!;
    report.bill = { file: f, exists: existsSync(f) };
    if (!existsSync(f)) problems.push(`bill file ${f} does not exist`);
  }

  // container metrics name services differently from traces ("shop-frontend" vs "frontend"): map them
  const suggested: Record<string, string> = {};
  if (report.prometheus && 'presets' in report.prometheus) {
    const traceSvcs = report.traces && 'services' in report.traces ? report.traces.services : [];
    Object.assign(suggested, suggestRenames(report.prometheus, traceSvcs));
    const applied = Object.fromEntries(Object.entries(suggested).filter(([k]) => !(input.system?.rename ?? {})[k]));
    if (Object.keys(applied).length) next.system.rename = { ...applied, ...next.system.rename };
  }
  if (report.traces && 'entry' in report.traces && !next.system.entry?.length && report.traces.entry.length) next.system.entry = report.traces.entry;
  if (report.traces && 'clientsOnly' in report.traces && !next.system.ignore && report.traces.clientsOnly.length) next.system.ignore = report.traces.clientsOnly;

  ws.saveSources(next);
  const ready = !!next.prometheus && report.prometheus !== undefined && 'presets' in report.prometheus && report.prometheus.presets.length > 0;
  return {
    workspace: ws.dir,
    ready,
    system: next.system,
    prometheus: report.prometheus,
    traces: report.traces ?? report.traceFiles ?? null,
    bill: report.bill ?? 'none — services will be priced at AWS Fargate list prices from their CPU and memory limits',
    renamed: suggested,
    problems,
    next: ready ? 'collect_telemetry (choose how much history with `last`, e.g. "7d")' : 'fix the problems above and connect again',
  };
}

// ---------------------------------------------------------------------------------------------

const run = promisify(execFile);

/**
 * A read-only snapshot of a cluster's workloads: `kubectl get deployments,statefulsets,hpa -o json`
 * against an explicitly named context. Nothing else is ever run.
 */
export async function readCluster(ws: Workspace, o: { context: string; namespace?: string; selector?: string }) {
  if (!o.context) throw new Error('name the kube context explicitly (read_cluster never uses the current context)');
  const kubectl = process.env.BOTTLENECK_KUBECTL ?? 'kubectl';
  const args = ['--context', o.context, ...(o.namespace ? ['-n', o.namespace] : ['--all-namespaces']), 'get', 'deployments,statefulsets,horizontalpodautoscalers', ...(o.selector ? ['-l', o.selector] : []), '-o', 'json', '--request-timeout=20s'];
  const { stdout } = await run(kubectl, args, { maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });
  const doc = JSON.parse(stdout) as { items?: unknown[] };
  ws.ensure('cluster');
  const file = join(ws.path('cluster'), `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${o.context.replace(/[^\w.-]+/g, '_')}-${o.namespace ?? 'all'}.json`);
  ws.writeJson(file.slice(ws.dir.length + 1), doc);
  const workloads = [...readWorkloads([stdout]).values()];
  const src = ws.sources();
  src.kube = { context: o.context, ...(o.namespace ? { namespace: o.namespace } : {}) };
  ws.saveSources(src);
  return {
    context: o.context,
    namespace: o.namespace ?? 'all',
    objects: doc.items?.length ?? 0,
    workloads,
    snapshot: file,
    command: `${kubectl} ${args.join(' ')}`,
    next: 'edit manifests, then verify_change with { cluster: { head: "<path to edited manifests>" } } to backtest them against this snapshot',
  };
}
