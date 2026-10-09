import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { stringify as toYaml } from 'yaml';
import { importBundle } from '../src/backtest/import/manifest';
import { exportPlan, manifestMetrics, runExport } from '../src/backtest/import/promExport';
import { parseTraceFile, parseTraceLines, type Span } from '../src/backtest/import/traces';
import type { Dataset } from '../src/backtest/dataset';
import { fileAccess, glob, readLines } from '../cli/files';
import { fetchTraces, probeJaeger, probePrometheus, probeTempo, shapeOf } from './sources';
import { authHeaders, iso, seconds, Workspace } from './workspace';

/**
 * One collection: query Prometheus over a window, fetch traces spread over the same window, add the
 * bill if there is one, write the import manifest and import it into `dataset.json`. What each
 * service ended up with is reported, so an agent can see what the model will and won't know.
 */

export interface CollectOptions {
  /** how much history: "6h", "14d" (default 24h, or what the data covers) */
  last?: string;
  start?: string | number;
  end?: string | number;
  /** bucket size, seconds (default: the window / ~1000, at least 30 s) */
  stepS?: number;
  maxTraces?: number;
}

const STEPS = [30, 60, 120, 300, 600, 900, 1800, 3600];

const toEpoch = (v: string | number) => (typeof v === 'number' ? (v > 1e12 ? v / 1000 : v) : Date.parse(v) / 1000);

export interface Coverage {
  service: string;
  has: string[];
  missing: string[];
  /** share of buckets with a request rate */
  filled: number;
}

export async function collect(ws: Workspace, o: CollectOptions = {}) {
  const src = ws.sources();
  if (!src.prometheus) throw new Error('no Prometheus connected — call connect_telemetry with prometheus.url first');
  const warnings: string[] = [];
  const now = Date.now() / 1000;
  const probe = await probePrometheus(src.prometheus, now);
  if (!probe.presets.length) throw new Error(`Prometheus at ${src.prometheus.url} has none of the metrics the presets read. ${probe.nearMisses.join(' ')}`);
  const presets = src.prometheus.presets?.length ? src.prometheus.presets : probe.presets;

  // ---- window and step
  let end = o.end !== undefined ? toEpoch(o.end) : now;
  if (o.end === undefined && probe.data && Date.parse(probe.data.newest) / 1000 < now - 3600) {
    end = Date.parse(probe.data.newest) / 1000;
    warnings.push(`no request metrics in the last hour: the window ends at the newest data, ${iso(end)}`);
  }
  let start = o.start !== undefined ? toEpoch(o.start) : end - seconds(o.last ?? '24h');
  if (o.start === undefined && !o.last && probe.data) start = Math.max(start, Date.parse(probe.data.oldestFound) / 1000);
  if (!(end > start)) throw new Error(`empty window ${iso(start)} … ${iso(end)}`);
  const stepS = o.stepS ?? STEPS.find((s) => (end - start) / s <= 1200) ?? 3600;
  const rateWindow = `${Math.max(60, stepS)}s`;

  // ---- traces first: they say which services requests enter through
  const tel = ws.path('telemetry');
  rmSync(tel, { recursive: true, force: true });
  ws.ensure('telemetry', 'metrics');
  ws.ensure('telemetry', 'traces');
  let traceFiles: string[] = [];
  let traceNote = '';
  let entry = src.system.entry;
  let ignore = src.system.ignore;
  if (src.jaeger || src.tempo) {
    const kind = src.jaeger ? 'jaeger' : 'tempo';
    if (!entry?.length) {
      // a small sample of recent traces says which services requests enter through
      const shape = src.jaeger ? await probeJaeger(src.jaeger, end) : await probeTempo(src.tempo!, end);
      entry = shape.entry;
      ignore ??= shape.clientsOnly;
    }
    if (!entry?.length) throw new Error(`could not tell which services requests enter through from ${kind}: give system.entry in connect_telemetry`);
    const got = await fetchTraces(src, entry, start, end, { maxTraces: o.maxTraces });
    const f = join(tel, 'traces', `${kind}.jsonl`);
    writeFileSync(f, got.lines.join('\n') + '\n');
    traceFiles = [f];
    traceNote = `${got.traces.toLocaleString()} traces from ${kind} through ${entry.join(', ')} (${got.requests} requests)`;
    if (got.traces < 50) warnings.push(`only ${got.traces} traces in the window — topology and self times rest on few requests`);
  } else if (src.traceFiles?.length) {
    traceFiles = src.traceFiles.flatMap((p) => glob(p)).map((p) => resolve(p));
    if (!traceFiles.length) throw new Error(`no trace files match ${src.traceFiles.join(', ')}`);
    if (!entry?.length || !ignore) {
      const spans: Span[] = [];
      for (const f of traceFiles.slice(0, 3)) {
        if (/\.(jsonl|ndjson)$/.test(f)) {
          let n = 0;
          for (const line of readLines(f)) {
            if (n++ > 2000) break;
            if (line.trim()) parseTraceLines([line], spans);
          }
        } else parseTraceFile(readFileSync(f, 'utf8'), spans);
      }
      const shape = shapeOf(spans);
      entry ??= shape.entry;
      ignore ??= shape.clientsOnly;
    }
    traceNote = `${traceFiles.length} trace file(s)`;
  } else warnings.push('no traces: without them the model has no topology (which service calls which). Connect Jaeger or Tempo, or give trace files');

  // ---- metrics
  const plan = exportPlan(presets, { window: rateWindow, selector: src.prometheus.selector, entry });
  const exported = await runExport(src.prometheus.url, plan, { start, end, stepS }, (file, body) => writeFileSync(join(tel, 'metrics', file), body), authHeaders(src.prometheus));
  const empty = exported.filter((e) => !e.series).map((e) => e.file);
  const endpointSeries = exported.some((e) => /endpoint-rps/.test(e.file) && e.series > 0);
  if (!endpointSeries && entry?.length) warnings.push(`no endpoint-level request metrics for ${entry.join(', ')}: endpoint rates come from the traces, scaled by the measured sampling share`);

  // ---- manifest
  const rel = (p: string) => (isAbsolute(p) ? relative(tel, p) : p);
  const manifest = {
    name: src.system.name,
    step: `${stepS}s`,
    ...(src.system.rename && Object.keys(src.system.rename).length ? { rename: src.system.rename } : {}),
    metrics: manifestMetrics(plan, 'metrics'),
    traces: traceFiles.length
      ? [{ file: traceFiles.length === 1 ? rel(traceFiles[0]) : rel(traceFiles[0]).replace(/[^/]+$/, '*'), ...(ignore?.length ? { ignore } : {}), series: { rps: false, latency: false, endpoints: !endpointSeries } }]
      : [],
    billing: src.bill?.cur ? [{ cur: resolve(src.bill.cur), ...(src.bill.tag ? { tag: src.bill.tag } : {}), ...(src.bill.resources ? { resources: src.bill.resources } : {}) }] : src.bill?.gcp ? [{ gcp: resolve(src.bill.gcp), ...(src.bill.tag ? { tag: src.bill.tag } : {}) }] : [],
    ...(src.system.placement ? { placement: src.system.placement } : {}),
    model: {
      ...(src.system.slo ? { slo: src.system.slo } : {}),
      ...(src.system.timeoutMs ? { timeoutMs: src.system.timeoutMs } : {}),
      ...(src.system.hostedBy ? { hostedBy: src.system.hostedBy } : {}),
    },
  };
  const manifestPath = join(tel, 'bottleneck.import.yaml');
  writeFileSync(manifestPath, `# Written by Bottleneck collect_telemetry, ${iso(now)}: ${iso(start)} … ${iso(end)}\n` + toYaml(manifest));

  // ---- import
  const { dataset, log } = importBundle(manifest, fileAccess(manifestPath));
  for (const id of src.system.exclude ?? []) {
    delete dataset.services[id];
    if (dataset.bill) delete dataset.bill.components[id];
    for (const [eid, e] of Object.entries(dataset.endpoints)) if (e.service === id) delete dataset.endpoints[eid];
  }
  // services the metrics name but no trace touches: another system on the same Prometheus, or a
  // component nothing traces (a load balancer, a database seen only through its container)
  if (dataset.topology) {
    const traced = new Set([...Object.keys(dataset.topology.services), ...Object.keys(src.system.hostedBy ?? {})]);
    const named = new Set(dataset.topology.edges.flatMap((e) => [e.from, e.to]));
    const loose = Object.keys(dataset.services).filter((id) => !traced.has(id) && !named.has(id));
    // traced but without a container of its own: a managed service outside the cluster, or a library
    // inside its caller's process (then it scales with the caller: system.hostedBy)
    for (const [id, shape] of Object.entries(dataset.topology.services)) {
      if (src.system.hostedBy?.[id] || dataset.services[id]?.cpuCores?.some((v) => v !== null)) continue;
      const callers = [...new Set(dataset.topology.edges.filter((e) => e.to === id).map((e) => e.from))];
      if (callers.length === 1 && shape.kind !== 'server') warnings.push(`${id} (${shape.kind}) is traced but has no container metrics: a managed service, or running inside ${callers[0]}'s process. If it runs inside ${callers[0]}, connect_telemetry with system.hostedBy { "${id}": "${callers[0]}" } so it scales with it`);
    }
    if (loose.length) warnings.push(`in the metrics but in no trace: ${loose.join(', ')}. If they belong to another system, connect_telemetry with system.exclude; if they are part of this one (load balancers, databases), they are priced but not modelled for latency`);
  }
  ws.writeJson('dataset.json', dataset, false);
  // the model fitted on an older dataset no longer matches it
  rmSync(ws.path('model.json'), { force: true });
  rmSync(ws.path('calibration.json'), { force: true });
  src.system.entry = entry;
  if (ignore?.length) src.system.ignore = ignore;
  ws.saveSources(src);

  const coverage = coverageOf(dataset);
  for (const c of coverage) {
    if (c.missing.includes('cpuLimitCores') && c.has.includes('cpuCores')) warnings.push(`${c.service}: CPU use but no CPU limit — capacity can't come from CPU, and resize strategies can't be priced`);
  }
  if (!dataset.bill) warnings.push('no bill: calibrate_model prices services at AWS Fargate list prices from their CPU and memory limits');
  return {
    window: { start: iso(dataset.start), end: iso(dataset.start + dataset.n * dataset.stepS), stepS: dataset.stepS, buckets: dataset.n, hours: Math.round((dataset.n * dataset.stepS) / 360) / 10 },
    presets,
    entry,
    ignored: ignore ?? [],
    traces: traceNote || null,
    services: Object.keys(dataset.services).length,
    endpoints: Object.keys(dataset.endpoints),
    coverage,
    emptyQueries: empty,
    imported: log.map((l) => `${l.what}${l.points !== undefined ? ` (${l.points.toLocaleString()} points)` : ''}`),
    bill: dataset.bill ? `$${dataset.bill.total.toFixed(2)} over the bill window` : null,
    warnings,
    files: { manifest: manifestPath, dataset: ws.path('dataset.json') },
    next: 'calibrate_model',
  };
}

const KEY_METRICS = ['rps', 'errorRate', 'p99Ms', 'cpuCores', 'cpuLimitCores', 'replicas', 'memoryBytes'];

export function coverageOf(d: Dataset): Coverage[] {
  const virtual = new Set(Object.entries(d.topology?.services ?? {}).filter(([, s]) => s.kind !== 'server').map(([id]) => id));
  return Object.entries(d.services).map(([id, s]) => {
    const rec = s as Record<string, (number | null)[] | undefined>;
    const has = KEY_METRICS.filter((m) => rec[m]?.some((v) => v !== null));
    const rps = rec.rps ?? [];
    return {
      service: id,
      has: [...has, ...(d.topology?.services[id] ? ['traces'] : [])],
      missing: virtual.has(id) ? [] : KEY_METRICS.filter((m) => !has.includes(m)),
      filled: rps.length ? Math.round((rps.filter((v) => v !== null).length / rps.length) * 100) / 100 : 0,
    };
  });
}
