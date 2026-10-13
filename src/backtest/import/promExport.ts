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
  queries: (o: { window: string; selector: string; entry?: string[]; namespaces?: string[] }) => PresetQuery[];
}

/**
 * A pod's owning workload from its name: Deployments name pods <name>-<replicaset hash>-<5>,
 * StatefulSets <name>-<ordinal>, DaemonSets and Jobs <name>-<5> (Kubernetes' safe alphabet).
 * Grouping by workload rather than container name keeps two Deployments that both call their
 * container "app" apart, and folds sidecars (istio-proxy, linkerd-proxy) into the pod they serve.
 */
const SAFE = '[bcdfghjklmnpqrstvwxz2456789]';
export const WORKLOAD_RE = `^(?:(.+)-${SAFE}{6,10}-${SAFE}{5}|(.+)-[0-9]+|(.+)-${SAFE}{5})$`;
const workload = (expr: string) => `label_replace(${expr}, "workload", "$1$2$3", "pod", "${WORKLOAD_RE}")`;
const nsMatcher = (namespaces?: string[]) => (namespaces?.length ? `namespace=~"${namespaces.map((n) => n.replace(/[.*+?^${}()|[\]\\"]/g, '\\\\$&')).join('|')}"` : '');

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
            // parts, merged after templating: one series per session id or product id in a span
            // name can't be averaged or maxed into the endpoint's error rate, mean or p99
            { file: 'endpoint-errors.json', query: `label_replace(sum by (service_name, span_name) (rate(traces_span_metrics_calls_total{${se},status_code="STATUS_CODE_ERROR"}[${w}])), "part", "num", "", "") or label_replace(sum by (service_name, span_name) (rate(traces_span_metrics_calls_total{${se}}[${w}])), "part", "den", "", "")`, mapping: { metric: 'errorRate', unit: 'ratio', ...ep, combine: 'ratio' } },
            { file: 'endpoint-latency.json', query: `sum by (service_name, span_name, le) (rate(traces_span_metrics_duration_milliseconds_bucket{${se}}[${w}]))`, mapping: { metric: 'p99Ms', unit: 'ms', ...ep, combine: 'histogram' } },
            { file: 'endpoint-mean.json', query: `label_replace(sum by (service_name, span_name) (rate(traces_span_metrics_duration_milliseconds_sum{${se}}[${w}])), "part", "num", "", "") or label_replace(sum by (service_name, span_name) (rate(traces_span_metrics_duration_milliseconds_count{${se}}[${w}])), "part", "den", "", "")`, mapping: { metric: 'meanMs', unit: 'ms', ...ep, combine: 'ratio' } },
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
  'ingress-nginx': {
    id: 'ingress-nginx',
    description: 'Requests, errors and latency at the edge from ingress-nginx (nginx_ingress_controller_*), per backend Service: every request, including those that never reach a pod',
    queries: ({ window: w, selector: sel, namespaces }) => {
      // the operator relabels the controller's own namespace into `namespace`; the backend's is exported_namespace
      const ns = namespaces?.length ? nsMatcher(namespaces).replace(/^namespace=/, 'exported_namespace=') : '';
      const s = [`exported_service!=""`, ns, sel].filter(Boolean).join(',');
      const by = 'exported_service';
      const m = { by, edge: true } as const;
      return [
        { file: 'rps.json', query: `sum by (${by}) (rate(nginx_ingress_controller_requests{${s}}[${w}]))`, mapping: { metric: 'rps', ...m } },
        // 499: the client gave up waiting — a failed request as far as the user is concerned
        { file: 'errors.json', query: `(sum by (${by}) (rate(nginx_ingress_controller_requests{${s},status=~"5..|499"}[${w}])) or sum by (${by}) (rate(nginx_ingress_controller_requests{${s}}[${w}])) * 0) / sum by (${by}) (rate(nginx_ingress_controller_requests{${s}}[${w}]))`, mapping: { metric: 'errorRate', unit: 'ratio', ...m } },
        { file: 'p99.json', query: `histogram_quantile(0.99, sum by (${by}, le) (rate(nginx_ingress_controller_request_duration_seconds_bucket{${s}}[${w}])))`, mapping: { metric: 'p99Ms', unit: 's', ...m } },
        { file: 'mean.json', query: `sum by (${by}) (rate(nginx_ingress_controller_request_duration_seconds_sum{${s}}[${w}])) / sum by (${by}) (rate(nginx_ingress_controller_request_duration_seconds_count{${s}}[${w}]))`, mapping: { metric: 'meanMs', unit: 's', ...m } },
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
    description: 'Pod CPU, limits (or requests, where no limit is set), ready replicas and network from kubelet/cAdvisor + kube-state-metrics, grouped by owning workload (Deployment, StatefulSet, DaemonSet)',
    queries: ({ window: w, selector: sel, namespaces }) => {
      const pod = [`pod!=""`, nsMatcher(namespaces), sel].filter(Boolean).join(',');
      const ctr = [`container!=""`, `container!="POD"`, pod].join(',');
      const perPod = (m: string) => `sum by (namespace, pod, workload) (${workload(`${m}{resource="cpu",${pod}}`)})`;
      return [
        { file: 'cpu.json', query: `sum by (workload) (${workload(`rate(container_cpu_usage_seconds_total{${ctr}}[${w}])`)})`, mapping: { metric: 'cpuCores', by: 'workload' } },
        // many clusters set CPU requests but no limits: then the request is the best size there is
        { file: 'cpu-limit.json', query: `max by (workload) (${perPod('kube_pod_container_resource_limits')}) or max by (workload) (${perPod('kube_pod_container_resource_requests')})`, mapping: { metric: 'cpuLimitCores', by: 'workload' } },
        { file: 'replicas.json', query: `count by (workload) (${workload(`kube_pod_status_ready{condition="true",${pod}} == 1`)})`, mapping: { metric: 'replicas', by: 'workload' } },
        { file: 'net-tx.json', query: `sum by (workload) (${workload(`rate(container_network_transmit_bytes_total{${pod}}[${w}])`)})`, mapping: { metric: 'netTxBps', by: 'workload' } },
        { file: 'memory.json', query: `sum by (workload) (${workload(`container_memory_working_set_bytes{${ctr}}`)})`, mapping: { metric: 'memoryBytes', by: 'workload' } },
        { file: 'throttled.json', query: `sum by (workload) (${workload(`rate(container_cpu_cfs_throttled_periods_total{${ctr}}[${w}])`)}) / sum by (workload) (${workload(`rate(container_cpu_cfs_periods_total{${ctr}}[${w}])`)})`, mapping: { metric: 'cpuThrottled', by: 'workload', unit: 'ratio' } },
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

export function exportPlan(presets: string[], opts: { window?: string; selector?: string; entry?: string[]; namespaces?: string[] } = {}): ExportPlan[] {
  return presets.flatMap((p) => {
    const preset = PRESETS[p];
    if (!preset) throw new Error(`unknown preset "${p}" — one of ${Object.keys(PRESETS).join(', ')}`);
    return preset.queries({ window: opts.window ?? '1m', selector: opts.selector ?? '', entry: opts.entry, namespaces: opts.namespaces }).map((query) => ({ preset: p, query: { ...query, file: `${p}-${query.file}` } }));
  });
}

/** run the plan against a live Prometheus (Node or browser fetch). Long ranges are split into
 *  chunks under Prometheus' 11,000 points per series and stitched back together. */
export async function runExport(url: string, plan: ExportPlan[], range: { start: number; end: number; stepS: number }, write: (file: string, body: string) => void, headers: Record<string, string> = {}) {
  const out: { file: string; series: number }[] = [];
  const span = 10_000 * range.stepS;
  for (const p of plan) {
    const merged = new Map<string, { metric: Record<string, string>; values: [number, string][] }>();
    for (let t0 = range.start; t0 < range.end || t0 === range.start; t0 += span) {
      const t1 = Math.min(range.end, t0 + span - range.stepS);
      // relative to the base URL, so path prefixes (Thanos, Mimir's /prometheus) survive
      const u = new URL('api/v1/query_range', url.endsWith('/') ? url : url + '/');
      u.searchParams.set('query', p.query.query);
      u.searchParams.set('start', String(t0));
      u.searchParams.set('end', String(Math.max(t0, t1)));
      u.searchParams.set('step', `${range.stepS}s`);
      const r = await fetch(u, { headers });
      if (!r.ok) throw new Error(`${p.query.file}: Prometheus answered ${r.status} ${await r.text()}`);
      const body = (await r.json()) as { data?: { result?: { metric: Record<string, string>; values?: [number, string][] }[] } };
      for (const series of body.data?.result ?? []) {
        const key = JSON.stringify(series.metric);
        const m = merged.get(key) ?? merged.set(key, { metric: series.metric, values: [] }).get(key)!;
        m.values.push(...(series.values ?? []));
      }
      if (t1 >= range.end) break;
    }
    write(p.query.file, JSON.stringify({ status: 'success', data: { resultType: 'matrix', result: [...merged.values()] } }));
    out.push({ file: p.query.file, series: merged.size });
  }
  return out;
}

/** the `metrics:` block of an import manifest for an export plan */
export const manifestMetrics = (plan: ExportPlan[], dir: string) => plan.map((p) => ({ prometheus: `${dir}/${p.query.file}`, ...p.query.mapping }));
