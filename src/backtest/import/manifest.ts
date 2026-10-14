import { z } from 'zod';
import {  type Dataset } from '../dataset';
import * as wasm from '../wasm/hindcast_engine.js';

/**
 * Import manifest (`hindcast.import.yaml`; `bottleneck.import.yaml` before the rename): which files hold what. Everything is a file —
 * Hindcast never connects to a live system.
 */

const duration = z.union([z.number().positive(), z.string().regex(/^\d+(\.\d+)?(ms|s|m|h|d)$/)]).transform((v) => {
  if (typeof v === 'number') return v;
  const n = parseFloat(v);
  const u = v.replace(/^[\d.]+/, '');
  return n * ({ ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 } as Record<string, number>)[u];
});

const Mapping = z.object({
  metric: z.enum(['rps', 'doneRps', 'errorRate', 'p50Ms', 'p95Ms', 'p99Ms', 'meanMs', 'selfMeanMs', 'selfP99Ms', 'cpuCores', 'cpuPercent', 'cpuLimitCores', 'replicas', 'netTxBps', 'netRxBps', 'memoryBytes', 'memoryMaxBytes', 'memoryLimitBytes', 'cpuRequestCores', 'memoryRequestBytes', 'cpuThrottled', 'clusterNodes', 'clusterNodeCpu', 'clusterNodeMemoryBytes', 'clusterRequestedCpu', 'clusterRequestedMemoryBytes']),
  service: z.string().optional(),
  endpoint: z.string().optional(),
  by: z.string().optional(),
  endpointBy: z.string().optional(),
  methodBy: z.string().optional(),
  unit: z.enum(['ms', 's', 'us', 'percent', 'ratio', 'cores', 'millicores', 'bytes', 'rps', 'rpm', 'count-per-period']).optional(),
  scale: z.number().optional(),
  template: z.boolean().optional().describe('endpoint ids spelled as traces spell them, query strings dropped and ids templated; merged series'),
  edge: z.boolean().optional().describe('measured at the edge (ingress, load balancer): replaces span-metric and trace values for the same service and metric'),
  combine: z.enum(['ratio', 'histogram']).optional().describe('templated series returned as parts: ratio (part="num"/"den") or histogram buckets (le) — merged before the value is computed'),
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
      endpoints: z.record(z.string(), z.object({ slo: z.object({ p99Ms: z.number().positive(), errorRate: z.number().min(0).max(1) }).optional() })).optional().describe('endpoints with their own SLO, by endpoint id'),
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
  /** a large file as raw blocks of bytes, each valid until the next is asked for (the compiled importer splits the lines itself) */
  chunks?(path: string): Iterable<Uint8Array>;
}

export interface ImportLog {
  file: string;
  what: string;
  points?: number;
}

export type ImportResult = { dataset: Dataset; log: ImportLog[] };

/** import everything a manifest names */
export function importBundle(manifestInput: unknown, fs: FileAccess): ImportResult {
  const m = ImportManifest.parse(manifestInput);
  return wasm.importBundle(m, fs) as ImportResult;
}
