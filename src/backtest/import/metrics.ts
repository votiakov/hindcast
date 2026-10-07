import type { DatasetBuilder, ServiceMetric } from '../dataset';
import { csvObjects, parseCsv, parseTimestamp } from './csv';

/**
 * Metric exports → dataset points.
 *
 *  - Prometheus `GET /api/v1/query_range` responses (matrix JSON), one query per file
 *  - long CSV:  timestamp,service,metric,value[,endpoint]
 *  - wide CSV:  timestamp,<column>,<column>…  (Grafana / CloudWatch console / Datadog downloads)
 *  - CloudWatch `GetMetricData` JSON (MetricDataResults)
 *
 * A mapping tells Bottleneck what each series *is*: which metric, which service (or endpoint),
 * and how to convert units.
 */

export type MetricName = ServiceMetric | 'cpuPercent';
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
}

const ENDPOINT_METRICS = new Set(['rps', 'errorRate', 'p50Ms', 'p99Ms', 'meanMs']);

/** convert a raw value to Bottleneck's units (ms for latency, cores for CPU, req/s for rates) */
export function convert(metric: MetricName, v: number, unit: Unit | undefined, periodS: number, scale = 1): { metric: ServiceMetric; v: number } {
  const m: ServiceMetric = metric === 'cpuPercent' ? 'cpuCores' : metric;
  let x = v;
  const latency = m.endsWith('Ms');
  if (latency) x = unit === 's' ? v * 1000 : unit === 'us' ? v / 1000 : v;
  else if (metric === 'cpuPercent' || unit === 'percent') x = v / 100;
  else if (unit === 'millicores') x = v / 1000;
  else if (unit === 'rpm') x = v / 60;
  else if (unit === 'count-per-period') x = v / Math.max(1, periodS);
  if (m === 'errorRate' && unit === undefined && x > 1) x = x / 100; // percentages without a unit
  return { metric: m, v: x * scale };
}

function emit(b: DatasetBuilder, map: SeriesMapping, labels: Record<string, string>, t: number, raw: number, periodS: number) {
  const rawSvc = map.service ?? labels[map.by ?? 'service'] ?? labels.service_name ?? labels.job ?? labels.container ?? labels.app;
  if (!rawSvc) return;
  const service = map.rename?.[rawSvc] ?? rawSvc;
  const { metric, v } = convert(map.metric, raw, map.unit, periodS, map.scale);
  const epLabel = map.endpointBy ? labels[map.endpointBy] : undefined;
  const endpoint = map.endpoint ?? (epLabel ? `${map.methodBy && labels[map.methodBy] ? labels[map.methodBy] + ' ' : ''}${epLabel}` : undefined);
  if (endpoint) {
    if (ENDPOINT_METRICS.has(metric)) b.addEndpoint(endpoint, service, metric as 'rps', t, v);
    return;
  }
  b.addService(service, metric, t, v);
}

interface PromSeries {
  metric: Record<string, string>;
  values?: [number, string][];
  value?: [number, string];
}

/** Prometheus query_range (or instant query) JSON */
export function importPrometheus(b: DatasetBuilder, json: unknown, map: SeriesMapping): number {
  const root = json as { data?: { result?: PromSeries[] }; result?: PromSeries[] } | PromSeries[];
  const result = Array.isArray(root) ? root : root.data?.result ?? root.result;
  if (!Array.isArray(result)) throw new Error('not a Prometheus query response (expected data.result)');
  let points = 0;
  for (const s of result) {
    const vals = s.values ?? (s.value ? [s.value] : []);
    const period = vals.length > 1 ? Number(vals[1][0]) - Number(vals[0][0]) : 60;
    for (const [ts, raw] of vals) {
      const v = parseFloat(raw);
      if (!isFinite(v)) continue; // NaN from histogram_quantile on empty buckets
      emit(b, map, s.metric ?? {}, Number(ts), v, period);
      points++;
    }
  }
  return points;
}

/** long CSV: timestamp, service, metric, value [, endpoint]; metric names as in ServiceSeries */
export function importLongCsv(b: DatasetBuilder, text: string, defaults: Partial<SeriesMapping> = {}): number {
  const rows = csvObjects(text);
  let points = 0;
  for (const r of rows) {
    const t = parseTimestamp(r.timestamp ?? r.time ?? r.ts);
    const v = parseFloat(r.value);
    if (t === null || !isFinite(v)) continue;
    const metric = (r.metric ?? defaults.metric) as MetricName;
    emit(b, { ...defaults, metric, unit: (r.unit as Unit) || defaults.unit, service: r.service || defaults.service, endpoint: r.endpoint || undefined }, {}, t, v, 60);
    points++;
  }
  return points;
}

/** wide CSV: first column time, one column per series; `columns` maps a header to its meaning */
export function importWideCsv(b: DatasetBuilder, text: string, columns: Record<string, SeriesMapping>): number {
  const rows = parseCsv(text);
  if (rows.length < 2) return 0;
  const head = rows[0].map((h) => h.trim());
  const times = rows.slice(1).map((r) => parseTimestamp(r[0]));
  const ts = times.filter((t): t is number => t !== null).sort((a, b) => a - b);
  const period = ts.length > 1 ? ts[1] - ts[0] : 60;
  let points = 0;
  head.forEach((h, j) => {
    if (j === 0) return;
    const map = columns[h] ?? Object.entries(columns).find(([k]) => k.endsWith('*') && h.startsWith(k.slice(0, -1)))?.[1];
    if (!map) return;
    rows.slice(1).forEach((r, i) => {
      const t = times[i];
      const v = parseFloat(r[j]);
      if (t === null || !isFinite(v)) return;
      emit(b, map, {}, t, v, period);
      points++;
    });
  });
  return points;
}

interface CwResult {
  Id: string;
  Label?: string;
  Timestamps: (string | number)[];
  Values: number[];
}

/**
 * CloudWatch GetMetricData output. Series are matched by Id or Label through `map`; without a
 * mapping, an Id of the form `<service>__<metric>` (e.g. `checkout__p99Ms`) is understood.
 * Sum statistics (RequestCount, HTTPCode_Target_5XX_Count) want `unit: count-per-period`.
 */
export function importCloudWatch(b: DatasetBuilder, json: unknown, map: Record<string, SeriesMapping> = {}): number {
  const res = (json as { MetricDataResults?: CwResult[] }).MetricDataResults ?? (Array.isArray(json) ? (json as { MetricDataResults?: CwResult[] }[]).flatMap((p) => p.MetricDataResults ?? []) : undefined);
  if (!res) throw new Error('not a CloudWatch GetMetricData response (expected MetricDataResults)');
  let points = 0;
  for (const r of res) {
    let m = map[r.Id] ?? (r.Label ? map[r.Label] : undefined);
    if (!m) {
      const parts = r.Id.split('__');
      if (parts.length === 2) m = { service: parts[0], metric: parts[1] as MetricName };
      else continue;
    }
    const times = r.Timestamps.map(parseTimestamp);
    const sorted = times.filter((t): t is number => t !== null).sort((a, b) => a - b);
    const period = sorted.length > 1 ? sorted[1] - sorted[0] : 60;
    r.Values.forEach((v, i) => {
      const t = times[i];
      if (t === null || !isFinite(v)) return;
      emit(b, m!, {}, t, v, period);
      points++;
    });
  }
  return points;
}
