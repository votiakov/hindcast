import { z } from 'zod';
import { DatasetBuilder, type Dataset } from '../dataset';
import { importCloudWatch, importLongCsv, importPrometheus, importWideCsv, type SeriesMapping } from './metrics';
import { buildTopology, parseTraceFile, parseTraceLines, type Span } from './traces';
import { parseCur, parseGcpBilling, summariseBill, type BillLine } from './billing';
import { parseTimestamp } from './csv';

/**
 * Import manifest (`bottleneck.import.yaml`): which files hold what. Everything is a file —
 * Bottleneck never connects to a live system.
 */

const duration = z.union([z.number().positive(), z.string().regex(/^\d+(\.\d+)?(ms|s|m|h|d)$/)]).transform((v) => {
  if (typeof v === 'number') return v;
  const n = parseFloat(v);
  const u = v.replace(/^[\d.]+/, '');
  return n * ({ ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 } as Record<string, number>)[u];
});

const Mapping = z.object({
  metric: z.enum(['rps', 'errorRate', 'p50Ms', 'p95Ms', 'p99Ms', 'meanMs', 'selfMeanMs', 'selfP99Ms', 'cpuCores', 'cpuPercent', 'cpuLimitCores', 'replicas', 'netTxBps', 'netRxBps', 'memoryBytes']),
  service: z.string().optional(),
  endpoint: z.string().optional(),
  by: z.string().optional(),
  endpointBy: z.string().optional(),
  methodBy: z.string().optional(),
  unit: z.enum(['ms', 's', 'us', 'percent', 'ratio', 'cores', 'millicores', 'bytes', 'rps', 'rpm', 'count-per-period']).optional(),
  scale: z.number().optional(),
});

const MetricSource = z.union([
  Mapping.extend({ prometheus: z.string().describe('query_range JSON file (glob ok)') }),
  Mapping.partial({ metric: true }).extend({ csv: z.string().describe('long CSV: timestamp,service,metric,value[,endpoint]') }),
  z.object({ wide: z.string(), columns: z.record(z.string(), Mapping) }),
  z.object({ cloudwatch: z.string(), map: z.record(z.string(), Mapping).optional() }),
]);

export const ImportManifest = z.object({
  name: z.string(),
  step: duration.optional().describe('bucket size; default = native resolution of the metrics'),
  window: z.object({ start: z.union([z.string(), z.number()]).optional(), end: z.union([z.string(), z.number()]).optional() }).optional(),
  rename: z.record(z.string(), z.string()).optional().describe('raw service name → id, applied to every source'),
  metrics: z.array(MetricSource).default([]),
  traces: z
    .array(
      z.object({
        file: z.string(),
        sampling: z.number().min(0).max(1).optional(),
        ignore: z.array(z.string()).optional().describe('services outside the system, e.g. the load generator'),
        series: z.object({ rps: z.boolean(), latency: z.boolean(), endpoints: z.boolean() }).partial().optional().describe('which per-bucket series to take from traces (default: those the metrics lack)'),
      }),
    )
    .default([]),
  billing: z
    .array(
      z.union([
        z.object({ cur: z.string(), tag: z.string().optional(), resources: z.record(z.string(), z.string()).optional(), rename: z.record(z.string(), z.string()).optional() }),
        z.object({ gcp: z.string(), tag: z.string().optional(), resources: z.record(z.string(), z.string()).optional(), rename: z.record(z.string(), z.string()).optional() }),
      ]),
    )
    .default([]),
  placement: z.record(z.string(), z.object({ zone: z.string().optional(), region: z.string().optional() })).optional(),
  model: z
    .object({
      slo: z.object({ p99Ms: z.number().positive(), errorRate: z.number().min(0).max(1) }).optional(),
      timeoutMs: z.number().positive().optional().describe('client deadline: slower answers count as failures'),
      hostedBy: z.record(z.string(), z.string()).optional().describe('in-process dependencies seen in traces → the service they run in'),
      services: z.record(z.string(), z.object({ kind: z.enum(['server', 'db', 'cache', 'queue', 'external', 'lb']).optional(), servers: z.number().int().positive().optional(), perReplicaRps: z.number().positive().optional(), arch: z.enum(['x86', 'arm']).optional() })).optional(),
    })
    .optional()
    .describe('modelling hints used by calibrate'),
});
export type ImportManifest = z.infer<typeof ImportManifest>;

export interface FileAccess {
  read(path: string): string;
  /** expand a glob (or return [path]) */
  glob(pattern: string): string[];
  /** stream a file line by line (large trace files); falls back to read() */
  lines?(path: string): Iterable<string>;
}

export interface ImportLog {
  file: string;
  what: string;
  points?: number;
}

export function importBundle(manifestInput: unknown, fs: FileAccess): { dataset: Dataset; log: ImportLog[] } {
  const m = ImportManifest.parse(manifestInput);
  const b = new DatasetBuilder();
  const log: ImportLog[] = [];
  const rename = m.rename ?? {};
  const withRename = <T extends SeriesMapping>(x: T): T => ({ ...x, rename: { ...rename, ...x.rename } });

  for (const src of m.metrics) {
    if ('prometheus' in src) {
      const { prometheus, ...map } = src;
      for (const f of fs.glob(prometheus)) log.push({ file: f, what: `prometheus ${map.metric}`, points: importPrometheus(b, JSON.parse(fs.read(f)), withRename(map as SeriesMapping)) });
    } else if ('csv' in src) {
      const { csv, ...map } = src;
      for (const f of fs.glob(csv)) log.push({ file: f, what: 'metrics CSV', points: importLongCsv(b, fs.read(f), withRename(map as SeriesMapping)) });
    } else if ('wide' in src) {
      const cols = Object.fromEntries(Object.entries(src.columns).map(([k, v]) => [k, withRename(v as SeriesMapping)]));
      for (const f of fs.glob(src.wide)) log.push({ file: f, what: 'metrics CSV (wide)', points: importWideCsv(b, fs.read(f), cols) });
    } else {
      const map = Object.fromEntries(Object.entries(src.map ?? {}).map(([k, v]) => [k, withRename(v as SeriesMapping)]));
      for (const f of fs.glob(src.cloudwatch)) log.push({ file: f, what: 'cloudwatch', points: importCloudWatch(b, JSON.parse(fs.read(f)), map) });
    }
  }

  const haveMetric = (metric: 'rps' | 'p99Ms') => b.has(metric);
  const stepS = m.step ?? 60;
  let topology;
  for (const src of m.traces) {
    const spans: Span[] = [];
    const files = fs.glob(src.file);
    for (const f of files) {
      if (fs.lines && /\.(jsonl|ndjson)$/.test(f)) parseTraceLines(fs.lines(f), spans);
      else parseTraceFile(fs.read(f), spans);
    }
    const series = { rps: src.series?.rps ?? !haveMetric('rps'), latency: src.series?.latency ?? !haveMetric('p99Ms'), endpoints: src.series?.endpoints ?? true };
    topology = buildTopology(spans, b, { stepS, sampling: src.sampling, ignoreServices: src.ignore, rename, series });
    log.push({ file: files.join(', '), what: `traces: ${topology.traces.toLocaleString()} requests, ${Object.keys(topology.services).length} services, ${Object.keys(topology.endpoints).length} endpoints`, points: spans.length });
  }

  const ws = m.window?.start !== undefined ? parseTimestamp(m.window.start) ?? undefined : undefined;
  const we = m.window?.end !== undefined ? parseTimestamp(m.window.end) ?? undefined : undefined;
  b.sources = log.map((l) => `${l.what} — ${l.file}`);
  const dataset = b.build({ name: m.name, stepS: m.step, start: ws, end: we });
  if (topology) dataset.topology = topology;

  const lines: BillLine[] = [];
  let source: 'aws-cur' | 'gcp-billing' = 'aws-cur';
  for (const src of m.billing) {
    const map = { tag: src.tag, resources: src.resources, rename: { ...rename, ...src.rename } };
    if ('cur' in src) for (const f of fs.glob(src.cur)) {
      const l = parseCur(fs.read(f), map);
      lines.push(...l);
      log.push({ file: f, what: `AWS CUR: ${l.length} lines` });
    }
    else for (const f of fs.glob(src.gcp)) {
      source = 'gcp-billing';
      const l = parseGcpBilling(fs.read(f), map);
      lines.push(...l);
      log.push({ file: f, what: `GCP billing: ${l.length} lines` });
    }
  }
  if (lines.length) dataset.bill = summariseBill(lines, source, dataset);
  if (m.placement) dataset.placement = m.placement;
  if (m.model) dataset.hints = m.model;
  dataset.sources = log.map((l) => `${l.what} — ${l.file}`);
  return { dataset, log };
}
