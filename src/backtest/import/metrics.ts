import { CLUSTER_METRICS, type ClusterMetric, type DatasetBuilder, type ServiceMetric } from '../dataset';
import { csvObjects, parseCsv, parseTimestamp } from './csv';
import { templatePath } from './traces';

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

const ENDPOINT_METRICS = new Set(['rps', 'errorRate', 'p50Ms', 'p99Ms', 'meanMs']);

/** convert a raw value to Bottleneck's units (ms for latency, cores for CPU, req/s for rates) */
export function convert(metric: MetricName, v: number, unit: Unit | undefined, periodS: number, scale = 1): { metric: ServiceMetric; v: number } {
  const m = (metric === 'cpuPercent' ? 'cpuCores' : metric) as ServiceMetric;
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
  // cluster-wide series (nodes, everything requested on them) belong to no service
  if ((CLUSTER_METRICS as string[]).includes(map.metric)) return b.addCluster(map.metric as ClusterMetric, t, raw * (map.scale ?? 1));
  const rawSvc = map.service ?? labels[map.by ?? 'service'] ?? labels.service_name ?? labels.application ?? labels.job ?? labels.container ?? labels.app;
  if (!rawSvc) return;
  const service = map.rename?.[rawSvc] ?? rawSvc;
  const { metric, v } = convert(map.metric, raw, map.unit, periodS, map.scale);
  const epLabel = map.endpointBy ? labels[map.endpointBy] : undefined;
  const named = map.endpoint ?? (epLabel ? `${map.methodBy && labels[map.methodBy] ? labels[map.methodBy] + ' ' : ''}${epLabel}` : undefined);
  const endpoint = named && map.template ? `${service} ${templatePath(named)}` : named;
  if (endpoint) {
    if (ENDPOINT_METRICS.has(metric)) b.addEndpoint(endpoint, service, metric as 'rps', t, v);
    return;
  }
  b.addService(service, metric, t, v, map.edge);
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
  if (map.template && map.endpointBy) return importTemplated(b, result, map);
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

/** histogram_quantile over cumulative bucket rates keyed by their `le` ("+Inf" included). Buckets
 *  summed from many sparse series come out non-monotonic (each rate() extrapolates on its own);
 *  like Prometheus, each bucket is raised to the largest count below it. With fewer than `minCount`
 *  observations behind it a p99 is noise, not a tail: null */
export function bucketQuantile(q: number, buckets: Map<string, number>, minCount = 0): number | null {
  const bs = [...buckets.entries()].map(([le, c]) => ({ le: le === '+Inf' ? Infinity : Number(le), c })).filter((x) => !isNaN(x.le)).sort((a, b) => a.le - b.le);
  if (!bs.length) return null;
  for (let i = 1; i < bs.length; i++) bs[i].c = Math.max(bs[i].c, bs[i - 1].c);
  const total = bs[bs.length - 1].c;
  if (!(total > 0) || total < minCount) return null;
  const rank = q * total;
  let prevLe = 0;
  let prevC = 0;
  for (const x of bs) {
    if (x.c >= rank) {
      // past the largest finite bound: the answer is that bound, as Prometheus gives it
      if (x.le === Infinity) return prevLe;
      return prevLe + ((x.le - prevLe) * (rank - prevC)) / Math.max(1e-12, x.c - prevC);
    }
    prevLe = x.le;
    prevC = x.c;
  }
  return prevLe;
}

/** endpoint series whose names template to the same endpoint (one series per user id in a path,
 *  say) merged before they reach the dataset: rates add up, p99 takes the worst, the rest average */
function importTemplated(b: DatasetBuilder, result: PromSeries[], map: SeriesMapping): number {
  const groups = new Map<string, { labels: Record<string, string>; byT: Map<number, number[]>; parts: Map<number, Map<string, number>>; period: number }>();
  for (const s of result) {
    const labels = s.metric ?? {};
    const raw = labels[map.endpointBy!];
    if (!raw) continue;
    const rawSvc = map.service ?? labels[map.by ?? 'service'] ?? labels.service_name ?? labels.application ?? labels.job ?? '';
    const name = `${map.methodBy && labels[map.methodBy] ? labels[map.methodBy] + ' ' : ''}${raw}`;
    const key = `${rawSvc}\u0000${templatePath(name)}`;
    const vals = s.values ?? (s.value ? [s.value] : []);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { labels: { ...labels, [map.endpointBy!]: templatePath(name) }, byT: new Map(), parts: new Map(), period: vals.length > 1 ? Number(vals[1][0]) - Number(vals[0][0]) : 60 }));
    // the part this series carries: a ratio's numerator or denominator, or a histogram bucket
    const part = map.combine === 'ratio' ? labels.part : map.combine === 'histogram' ? labels.le : undefined;
    for (const [ts, raw] of vals) {
      const v = parseFloat(raw);
      if (!isFinite(v)) continue;
      if (part !== undefined) {
        const at = g.parts.get(Number(ts)) ?? g.parts.set(Number(ts), new Map()).get(Number(ts))!;
        at.set(part, (at.get(part) ?? 0) + v);
      } else (g.byT.get(Number(ts)) ?? g.byT.set(Number(ts), []).get(Number(ts))!).push(v);
    }
  }
  if (map.combine) {
    const m = { ...map, methodBy: undefined };
    let points = 0;
    for (const g of groups.values())
      for (const [t, parts] of g.parts) {
        if (map.combine === 'ratio') {
          const den = parts.get('den') ?? 0;
          if (den <= 0) continue;
          emit(b, m, g.labels, t, (parts.get('num') ?? 0) / den, g.period);
          points++;
        } else {
          for (const [q, metric] of [
            [0.5, 'p50Ms'],
            [0.99, 'p99Ms'],
          ] as const) {
            // bucket rates are per second: a p99 wants ~100 requests behind it, a median ~20
            const v = bucketQuantile(q, parts, (q > 0.9 ? 100 : 20) / g.period);
            if (v === null) continue;
            emit(b, { ...m, metric }, g.labels, t, v, g.period);
            points++;
          }
        }
      }
    return points;
  }
  const combine = map.metric === 'rps' || map.metric === 'doneRps' ? (xs: number[]) => xs.reduce((a, x) => a + x, 0) : map.metric === 'p99Ms' || map.metric === 'p95Ms' ? (xs: number[]) => Math.max(...xs) : (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
  // the method is already part of the templated name
  const m = { ...map, methodBy: undefined };
  let points = 0;
  for (const g of groups.values())
    for (const [t, xs] of g.byT) {
      emit(b, m, g.labels, t, combine(xs), g.period);
      points++;
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
