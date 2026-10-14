import type { ClusterMetric, ServiceMetric } from '../dataset';
import * as wasm from '../wasm/hindcast_engine.js';

/**
 * The Prometheus queries Hindcast exports (`hindcast export-prometheus`, collect_telemetry), from the
 * engine: for scripts that fetch them themselves (reference/promExport.ts).
 */

export type MetricName = ServiceMetric | ClusterMetric | 'cpuPercent';
export type Unit = 'ms' | 's' | 'us' | 'percent' | 'ratio' | 'cores' | 'millicores' | 'bytes' | 'rps' | 'rpm' | 'count-per-period';

export interface SeriesMapping {
  metric: MetricName;
  /** service id; if omitted, taken from the label named by `by` */
  service?: string;
  /** endpoint id (endpoint-level series), or the label holding it */
  endpoint?: string;
  /** label (Prometheus) that names the service, default "service" */
  by?: string;
  /** label that names the endpoint (e.g. http_route) — makes this an endpoint series */
  endpointBy?: string;
  /** label holding the HTTP method, prefixed to the endpoint id */
  methodBy?: string;
  unit?: Unit;
  /** extra multiplier after unit conversion (e.g. vCPUs for a CPU % series) */
  scale?: number;
  /** service rename map: raw label value → service id */
  rename?: Record<string, string>;
  /** endpoint ids as traces spell them ("<service> <METHOD> <path>"), with query strings dropped and
   *  ids templated; series that template to the same endpoint are merged (rates summed, p99 the max,
   *  the rest averaged) */
  template?: boolean;
  /** measured at the edge (an ingress or load balancer): sees every request, so it wins over span
   *  metrics and traces for the same service and metric */
  edge?: boolean;
  /** how templated series merge when the query returns their parts rather than the finished value:
   *  `ratio` — series labelled part="num" and part="den", merged as Σnum / Σden (error rates, means);
   *  `histogram` — bucket rates labelled `le`, summed per bucket, then p50 and p99 as
   *  histogram_quantile computes them. A p99 can't be merged from p99s: the worst of forty sparse
   *  per-session series is not the endpoint's p99 */
  combine?: 'ratio' | 'histogram';
}

export interface PresetQuery {
  file: string;
  query: string;
  mapping: SeriesMapping;
}

export interface ExportPlan {
  preset: string;
  query: PresetQuery;
}

/** the queries of the named presets, each file named <preset>-<file> */
export const exportPlan = (presets: string[], opts: { window?: string; selector?: string; entry?: string[]; namespaces?: string[] } = {}): ExportPlan[] => wasm.exportPlan(presets, opts) as ExportPlan[];

/** the `metrics:` block of an import manifest for an export plan */
export const manifestMetrics = (plan: ExportPlan[], dir: string) => plan.map((p) => ({ prometheus: `${dir}/${p.query.file}`, ...p.query.mapping }));

/** pods per node per workload, at one instant: which replicas a node failure takes with it */
export const podsByNodeQuery = (namespaces: string[] = []) => wasm.podsByNodeQuery(namespaces);

/** the zone of a node from its provider id (AWS, GCP), else null */
export const zoneOfProviderId = (id: string | undefined): string | null => wasm.zoneOfProviderId(id) ?? null;

/** the pattern that takes a pod name back to its workload */
export const workloadRe = () => wasm.workloadRe();
