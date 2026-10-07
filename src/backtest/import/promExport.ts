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
  queries: (o: { window: string; selector: string }) => PresetQuery[];
}

const SERVER = 'span_kind="SPAN_KIND_SERVER"';

export const PRESETS: Record<string, Preset> = {
  'otel-spanmetrics': {
    id: 'otel-spanmetrics',
    description: 'RED metrics from the OpenTelemetry Collector spanmetrics connector (traces_span_metrics_*)',
    queries: ({ window: w, selector: sel }) => {
      const s = [SERVER, sel].filter(Boolean).join(',');
      return [
        { file: 'rps.json', query: `sum by (service_name) (rate(traces_span_metrics_calls_total{${s}}[${w}]))`, mapping: { metric: 'rps', by: 'service_name' } },
        { file: 'errors.json', query: `sum by (service_name) (rate(traces_span_metrics_calls_total{${s},status_code="STATUS_CODE_ERROR"}[${w}])) / sum by (service_name) (rate(traces_span_metrics_calls_total{${s}}[${w}]))`, mapping: { metric: 'errorRate', by: 'service_name', unit: 'ratio' } },
        { file: 'p50.json', query: `histogram_quantile(0.5, sum by (service_name, le) (rate(traces_span_metrics_duration_milliseconds_bucket{${s}}[${w}])))`, mapping: { metric: 'p50Ms', by: 'service_name', unit: 'ms' } },
        { file: 'p99.json', query: `histogram_quantile(0.99, sum by (service_name, le) (rate(traces_span_metrics_duration_milliseconds_bucket{${s}}[${w}])))`, mapping: { metric: 'p99Ms', by: 'service_name', unit: 'ms' } },
      ];
    },
  },
  'http-server': {
    id: 'http-server',
    description: 'OpenTelemetry HTTP semantic-convention metrics (http_server_request_duration_seconds_*)',
    queries: ({ window: w, selector: sel }) => {
      const s = sel ? `{${sel}}` : '';
      const se = sel ? `${sel},` : '';
      return [
        { file: 'rps.json', query: `sum by (service_name) (rate(http_server_request_duration_seconds_count${s}[${w}]))`, mapping: { metric: 'rps', by: 'service_name' } },
        { file: 'errors.json', query: `sum by (service_name) (rate(http_server_request_duration_seconds_count{${se}http_response_status_code=~"5.."}[${w}])) / sum by (service_name) (rate(http_server_request_duration_seconds_count${s}[${w}]))`, mapping: { metric: 'errorRate', by: 'service_name', unit: 'ratio' } },
        { file: 'p99.json', query: `histogram_quantile(0.99, sum by (service_name, le) (rate(http_server_request_duration_seconds_bucket${s}[${w}])))`, mapping: { metric: 'p99Ms', by: 'service_name', unit: 's' } },
        { file: 'endpoint-rps.json', query: `sum by (service_name, http_route, http_request_method) (rate(http_server_request_duration_seconds_count${s}[${w}]))`, mapping: { metric: 'rps', by: 'service_name', endpointBy: 'http_route', methodBy: 'http_request_method' } },
        { file: 'endpoint-p99.json', query: `histogram_quantile(0.99, sum by (service_name, http_route, http_request_method, le) (rate(http_server_request_duration_seconds_bucket${s}[${w}])))`, mapping: { metric: 'p99Ms', by: 'service_name', endpointBy: 'http_route', methodBy: 'http_request_method', unit: 's' } },
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

export interface ExportPlan {
  preset: string;
  query: PresetQuery;
}

export function exportPlan(presets: string[], opts: { window?: string; selector?: string } = {}): ExportPlan[] {
  return presets.flatMap((p) => {
    const preset = PRESETS[p];
    if (!preset) throw new Error(`unknown preset "${p}" — one of ${Object.keys(PRESETS).join(', ')}`);
    return preset.queries({ window: opts.window ?? '1m', selector: opts.selector ?? '' }).map((query) => ({ preset: p, query: { ...query, file: `${p}-${query.file}` } }));
  });
}

/** run the plan against a live Prometheus (Node or browser fetch) */
export async function runExport(url: string, plan: ExportPlan[], range: { start: number; end: number; stepS: number }, write: (file: string, body: string) => void) {
  const out: { file: string; series: number }[] = [];
  for (const p of plan) {
    const u = new URL('/api/v1/query_range', url);
    u.searchParams.set('query', p.query.query);
    u.searchParams.set('start', String(range.start));
    u.searchParams.set('end', String(range.end));
    u.searchParams.set('step', `${range.stepS}s`);
    const r = await fetch(u);
    if (!r.ok) throw new Error(`${p.query.file}: Prometheus answered ${r.status} ${await r.text()}`);
    const body = await r.text();
    write(p.query.file, body);
    out.push({ file: p.query.file, series: (JSON.parse(body) as { data?: { result?: unknown[] } }).data?.result?.length ?? 0 });
  }
  return out;
}

/** the `metrics:` block of an import manifest for an export plan */
export const manifestMetrics = (plan: ExportPlan[], dir: string) => plan.map((p) => ({ prometheus: `${dir}/${p.query.file}`, ...p.query.mapping }));
