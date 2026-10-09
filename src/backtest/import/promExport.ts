import type { SeriesMapping } from './metrics';

/**
 * Standard Prometheus queries for the metrics Bottleneck needs, grouped in presets that match
 * common setups. `bottleneck export-prometheus` runs them against a Prometheus URL and writes one
 * query_range JSON per query plus the `metrics:` block of an import manifest — after that,
 * everything works from files.
 */

export interface PresetQuery {
  file: string;
  query: string;
  mapping: SeriesMapping;
}

export interface Preset {
  id: string;
  description: string;
  queries: (o: { window: string; selector: string; entry?: string[] }) => PresetQuery[];
}

const SERVER = 'span_kind="SPAN_KIND_SERVER"';

export const PRESETS: Record<string, Preset> = {
  'otel-spanmetrics': {
    id: 'otel-spanmetrics',
    description: 'RED metrics from the OpenTelemetry Collector spanmetrics connector (traces_span_metrics_*)',
    queries: ({ window: w, selector: sel, entry }) => {
      const s = [SERVER, sel].filter(Boolean).join(',');
      return [
        { file: 'rps.json', query: `sum by (service_name) (rate(traces_span_metrics_calls_total{${s}}[${w}]))`, mapping: { metric: 'rps', by: 'service_name' } },
        // `or … * 0`: a service without a single error still gets an error rate (0), not a missing series
        { file: 'errors.json', query: `(sum by (service_name) (rate(traces_span_metrics_calls_total{${s},status_code="STATUS_CODE_ERROR"}[${w}])) or sum by (service_name) (rate(traces_span_metrics_calls_total{${s}}[${w}])) * 0) / sum by (service_name) (rate(traces_span_metrics_calls_total{${s}}[${w}]))`, mapping: { metric: 'errorRate', by: 'service_name', unit: 'ratio' } },
        { file: 'p50.json', query: `histogram_quantile(0.5, sum by (service_name, le) (rate(traces_span_metrics_duration_milliseconds_bucket{${s}}[${w}])))`, mapping: { metric: 'p50Ms', by: 'service_name', unit: 'ms' } },
        { file: 'p99.json', query: `histogram_quantile(0.99, sum by (service_name, le) (rate(traces_span_metrics_duration_milliseconds_bucket{${s}}[${w}])))`, mapping: { metric: 'p99Ms', by: 'service_name', unit: 'ms' } },
        { file: 'mean.json', query: `sum by (service_name) (rate(traces_span_metrics_duration_milliseconds_sum{${s}}[${w}])) / sum by (service_name) (rate(traces_span_metrics_duration_milliseconds_count{${s}}[${w}]))`, mapping: { metric: 'meanMs', by: 'service_name', unit: 'ms' } },
        ...endpointQueries(entry, (e) => {
          const se = `${s},${e}`;
          const ep = { by: 'service_name', endpointBy: 'span_name', template: true } as const;
          return [
            { file: 'endpoint-rps.json', query: `sum by (service_name, span_name) (rate(traces_span_metrics_calls_total{${se}}[${w}]))`, mapping: { metric: 'rps', ...ep } },
            { file: 'endpoint-errors.json', query: `(sum by (service_name, span_name) (rate(traces_span_metrics_calls_total{${se},status_code="STATUS_CODE_ERROR"}[${w}])) or sum by (service_name, span_name) (rate(traces_span_metrics_calls_total{${se}}[${w}])) * 0) / sum by (service_name, span_name) (rate(traces_span_metrics_calls_total{${se}}[${w}]))`, mapping: { metric: 'errorRate', unit: 'ratio', ...ep } },
            { file: 'endpoint-p50.json', query: `histogram_quantile(0.5, sum by (service_name, span_name, le) (rate(traces_span_metrics_duration_milliseconds_bucket{${se}}[${w}])))`, mapping: { metric: 'p50Ms', unit: 'ms', ...ep } },
            { file: 'endpoint-p99.json', query: `histogram_quantile(0.99, sum by (service_name, span_name, le) (rate(traces_span_metrics_duration_milliseconds_bucket{${se}}[${w}])))`, mapping: { metric: 'p99Ms', unit: 'ms', ...ep } },
            { file: 'endpoint-mean.json', query: `sum by (service_name, span_name) (rate(traces_span_metrics_duration_milliseconds_sum{${se}}[${w}])) / sum by (service_name, span_name) (rate(traces_span_metrics_duration_milliseconds_count{${se}}[${w}]))`, mapping: { metric: 'meanMs', unit: 'ms', ...ep } },
          ];
        }),
      ];
    },
  },
  'http-server': {
    id: 'http-server',
    description: 'OpenTelemetry HTTP semantic-convention metrics (http_server_request_duration_seconds_*)',
    queries: ({ window: w, selector: sel, entry }) => {
      const s = sel ? `{${sel}}` : '';
      const se = sel ? `${sel},` : '';
      const es = entry?.length ? `{${[sel, entryMatcher(entry)].filter(Boolean).join(',')}}` : s;
      return [
        { file: 'rps.json', query: `sum by (service_name) (rate(http_server_request_duration_seconds_count${s}[${w}]))`, mapping: { metric: 'rps', by: 'service_name' } },
        { file: 'errors.json', query: `sum by (service_name) (rate(http_server_request_duration_seconds_count{${se}http_response_status_code=~"5.."}[${w}])) / sum by (service_name) (rate(http_server_request_duration_seconds_count${s}[${w}]))`, mapping: { metric: 'errorRate', by: 'service_name', unit: 'ratio' } },
        { file: 'p99.json', query: `histogram_quantile(0.99, sum by (service_name, le) (rate(http_server_request_duration_seconds_bucket${s}[${w}])))`, mapping: { metric: 'p99Ms', by: 'service_name', unit: 's' } },
        { file: 'endpoint-rps.json', query: `sum by (service_name, http_route, http_request_method) (rate(http_server_request_duration_seconds_count${es}[${w}]))`, mapping: { metric: 'rps', by: 'service_name', endpointBy: 'http_route', methodBy: 'http_request_method', ...(entry?.length ? { template: true } : {}) } },
        { file: 'endpoint-p99.json', query: `histogram_quantile(0.99, sum by (service_name, http_route, http_request_method, le) (rate(http_server_request_duration_seconds_bucket${es}[${w}])))`, mapping: { metric: 'p99Ms', by: 'service_name', endpointBy: 'http_route', methodBy: 'http_request_method', unit: 's', ...(entry?.length ? { template: true } : {}) } },
        { file: 'endpoint-mean.json', query: `sum by (service_name, http_route, http_request_method) (rate(http_server_request_duration_seconds_sum${es}[${w}])) / sum by (service_name, http_route, http_request_method) (rate(http_server_request_duration_seconds_count${es}[${w}]))`, mapping: { metric: 'meanMs', by: 'service_name', endpointBy: 'http_route', methodBy: 'http_request_method', unit: 's', ...(entry?.length ? { template: true } : {}) } },
      ];
    },
  },
  cadvisor: {
    id: 'cadvisor',
    description: 'Container CPU, limits, replicas and network from cAdvisor (Docker Compose labels)',
    queries: ({ window: w, selector: sel }) => {
      const by = 'container_label_com_docker_compose_service';
      const s = sel ? `{${sel}}` : '';
      return [
        { file: 'cpu.json', query: `sum by (${by}) (rate(container_cpu_usage_seconds_total${s}[${w}]))`, mapping: { metric: 'cpuCores', by } },
        { file: 'cpu-limit.json', query: `max by (${by}) (container_spec_cpu_quota${s} / container_spec_cpu_period${s})`, mapping: { metric: 'cpuLimitCores', by } },
        { file: 'replicas.json', query: `count by (${by}) (container_memory_working_set_bytes${s})`, mapping: { metric: 'replicas', by } },
        { file: 'net-tx.json', query: `sum by (${by}) (rate(container_network_transmit_bytes_total${s}[${w}]))`, mapping: { metric: 'netTxBps', by } },
        { file: 'memory.json', query: `sum by (${by}) (container_memory_working_set_bytes${s})`, mapping: { metric: 'memoryBytes', by } },
      ];
    },
  },
  kubernetes: {
    id: 'kubernetes',
    description: 'Pod CPU, limits, replicas and network from kubelet/cAdvisor + kube-state-metrics, grouped by owning workload (label `container`)',
    queries: ({ window: w, selector: sel }) => {
      const s = [`container!=""`, `container!="POD"`, sel].filter(Boolean).join(',');
      return [
        { file: 'cpu.json', query: `sum by (container) (rate(container_cpu_usage_seconds_total{${s}}[${w}]))`, mapping: { metric: 'cpuCores', by: 'container' } },
        { file: 'cpu-limit.json', query: `max by (container) (kube_pod_container_resource_limits{resource="cpu",${s}})`, mapping: { metric: 'cpuLimitCores', by: 'container' } },
        { file: 'replicas.json', query: `count by (container) (kube_pod_container_status_ready{${s}} == 1)`, mapping: { metric: 'replicas', by: 'container' } },
        { file: 'net-tx.json', query: `sum by (pod) (rate(container_network_transmit_bytes_total{${sel ? sel : 'pod!=""'}}[${w}]))`, mapping: { metric: 'netTxBps', by: 'pod' } },
      ];
    },
  },
};

/** service_name=~"a|b" for the services requests enter through */
const entryMatcher = (entry: string[]) => `service_name=~"${entry.map((e) => e.replace(/[.*+?^${}()|[\]\\"]/g, '\\\\$&')).join('|')}"`;

/** endpoint-level queries only make sense for the services requests enter through: every other
 *  service's spans are calls inside a request, and counting them would count requests twice */
const endpointQueries = (entry: string[] | undefined, make: (matcher: string) => PresetQuery[]): PresetQuery[] => (entry?.length ? make(entryMatcher(entry)) : []);

export interface ExportPlan {
  preset: string;
  query: PresetQuery;
}

export function exportPlan(presets: string[], opts: { window?: string; selector?: string; entry?: string[] } = {}): ExportPlan[] {
  return presets.flatMap((p) => {
    const preset = PRESETS[p];
    if (!preset) throw new Error(`unknown preset "${p}" — one of ${Object.keys(PRESETS).join(', ')}`);
    return preset.queries({ window: opts.window ?? '1m', selector: opts.selector ?? '', entry: opts.entry }).map((query) => ({ preset: p, query: { ...query, file: `${p}-${query.file}` } }));
  });
}

/** run the plan against a live Prometheus (Node or browser fetch) */
export async function runExport(url: string, plan: ExportPlan[], range: { start: number; end: number; stepS: number }, write: (file: string, body: string) => void, headers: Record<string, string> = {}) {
  const out: { file: string; series: number }[] = [];
  for (const p of plan) {
    // relative to the base URL, so path prefixes (Thanos, Mimir's /prometheus) survive
    const u = new URL('api/v1/query_range', url.endsWith('/') ? url : url + '/');
    u.searchParams.set('query', p.query.query);
    u.searchParams.set('start', String(range.start));
    u.searchParams.set('end', String(range.end));
    u.searchParams.set('step', `${range.stepS}s`);
    const r = await fetch(u, { headers });
    if (!r.ok) throw new Error(`${p.query.file}: Prometheus answered ${r.status} ${await r.text()}`);
    const body = await r.text();
    write(p.query.file, body);
    out.push({ file: p.query.file, series: (JSON.parse(body) as { data?: { result?: unknown[] } }).data?.result?.length ?? 0 });
  }
  return out;
}

/** the `metrics:` block of an import manifest for an export plan */
export const manifestMetrics = (plan: ExportPlan[], dir: string) => plan.map((p) => ({ prometheus: `${dir}/${p.query.file}`, ...p.query.mapping }));
