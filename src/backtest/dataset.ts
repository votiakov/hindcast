/**
 * Telemetry dataset: everything Hindcast learned from real files, on one regular time grid.
 *
 * Importers (Prometheus, CloudWatch, OpenTelemetry, billing exports) each produce raw points;
 * `DatasetBuilder` buckets them onto the grid. Missing values are `null` (JSON-safe), never 0 —
 * "no data" and "no traffic" must stay distinguishable for calibration.
 */

export type Num = number | null;

/** per-service measurements; every array has `n` entries */
export interface ServiceSeries {
  /** requests per second arriving at the service */
  rps?: Num[];
  /** requests per second finishing (from trace end times) — under overload, this is the capacity */
  doneRps?: Num[];
  /** share of requests that failed (0..1) */
  errorRate?: Num[];
  /** inclusive latency (span/server duration, includes downstream calls), ms */
  p50Ms?: Num[];
  p95Ms?: Num[];
  p99Ms?: Num[];
  meanMs?: Num[];
  /** self time (inclusive minus waiting on children), from traces, ms */
  selfMeanMs?: Num[];
  selfP99Ms?: Num[];
  /** CPU used, cores (sum over replicas) */
  cpuCores?: Num[];
  /** CPU limit per replica, cores */
  cpuLimitCores?: Num[];
  /** replicas serving */
  replicas?: Num[];
  /** network bytes sent per second (all replicas) */
  netTxBps?: Num[];
  netRxBps?: Num[];
  /** memory working set, bytes (sum over replicas) */
  memoryBytes?: Num[];
  /** the largest container's working set at its highest within the bucket, bytes: what an OOM kill compares */
  memoryMaxBytes?: Num[];
  /** memory limit per container, bytes */
  memoryLimitBytes?: Num[];
  /** what each replica asks the scheduler for (Kubernetes requests): what node capacity is spent on */
  cpuRequestCores?: Num[];
  memoryRequestBytes?: Num[];
  /** share of CFS periods in which the CPU limit throttled the containers (0–1): the limit binds
   *  in bursts even when average CPU sits below it */
  cpuThrottled?: Num[];
}

export type ServiceMetric = keyof ServiceSeries;
export const SERVICE_METRICS: ServiceMetric[] = ['rps', 'doneRps', 'errorRate', 'p50Ms', 'p95Ms', 'p99Ms', 'meanMs', 'selfMeanMs', 'selfP99Ms', 'cpuCores', 'cpuLimitCores', 'replicas', 'netTxBps', 'netRxBps', 'memoryBytes', 'memoryMaxBytes', 'memoryLimitBytes', 'cpuRequestCores', 'memoryRequestBytes', 'cpuThrottled'];

/** the nodes a Kubernetes cluster ran on, and what every pod on them asked for */
export interface ClusterSeries {
  /** nodes */
  clusterNodes?: Num[];
  /** allocatable CPU (cores) and memory (bytes) per node, on average */
  clusterNodeCpu?: Num[];
  clusterNodeMemoryBytes?: Num[];
  /** requests of every running pod on the cluster, the system's own and everyone else's */
  clusterRequestedCpu?: Num[];
  clusterRequestedMemoryBytes?: Num[];
}
export type ClusterMetric = keyof ClusterSeries;
export const CLUSTER_METRICS: ClusterMetric[] = ['clusterNodes', 'clusterNodeCpu', 'clusterNodeMemoryBytes', 'clusterRequestedCpu', 'clusterRequestedMemoryBytes'];

/** an endpoint as users see it: a route on the entry service */
export interface EndpointSeries {
  /** service that receives the request */
  service: string;
  rps?: Num[];
  errorRate?: Num[];
  p50Ms?: Num[];
  p99Ms?: Num[];
  meanMs?: Num[];
}

/** one caller → callee relationship observed in traces */
export interface TraceEdge {
  from: string;
  to: string;
  /** calls per second over the whole window */
  callsPerS: number;
  /** mean request + response payload per call, bytes (null if unknown) */
  bytesPerCall: number | null;
}

/** what one request to an endpoint does, on average (from traces) */
export interface EndpointShape {
  service: string;
  /** traces seen for this endpoint */
  traces: number;
  /** calls per request, per edge key "from>to" */
  calls: Record<string, number>;
  /** visits per request per service (root = 1) */
  visits: Record<string, number>;
  /** mean ms per request spent by each service on the critical path */
  criticalMs: Record<string, number>;
  /** mean end-to-end duration, p99, ms */
  meanMs: number;
  p99Ms: number;
  /** the same over the quietest buckets only: the baseline before any queueing (a history with an
   *  overload or a load test in it would otherwise put the overload into the baseline) */
  /** median and p90 of the traced requests (shape the latency distribution between mean and p99) */
  p50Ms?: number;
  p90Ms?: number;
  lowP50Ms?: number;
  lowP90Ms?: number;
  lowMeanMs?: number;
  lowP99Ms?: number;
  /** bytes moved per request per edge key */
  bytes: Record<string, number>;
  /** share of traces with an error */
  errorRate: number;
}

export interface ServiceShape {
  spans: number;
  /** self time per visit (exclusive of child calls), ms */
  selfMeanMs: number;
  selfP50Ms: number;
  selfP99Ms: number;
  /** inclusive time per visit, ms */
  meanMs: number;
  p99Ms: number;
  /** inferred from span attributes (db.system, messaging.system, …) */
  kind: 'server' | 'db' | 'cache' | 'queue' | 'external' | 'client';
  /** technology hint, e.g. "redis", "mysql" */
  system?: string;
  /** SERVER spans per visit (> 1 when a framework adds its own, e.g. Next.js): span metrics overcount by this */
  serverSpansPerVisit?: number;
}

export interface Topology {
  services: Record<string, ServiceShape>;
  edges: TraceEdge[];
  endpoints: Record<string, EndpointShape>;
  /** trace window covered, epoch seconds */
  start: number;
  end: number;
  traces: number;
  /** share of requests that were traced (sampling), if known */
  sampling?: number;
  /** traced ÷ measured requests where metrics also count them (1 = the stated sampling was exact) */
  samplingCheck?: number;
  /** services whose span-metric rates were divided by their SERVER spans per visit */
  rateCorrected?: Record<string, number>;
}

export type CostCategory = 'compute' | 'requests' | 'transfer' | 'storage' | 'other';

export interface BillComponent {
  /** total $ over the bill window */
  total: number;
  byCategory: Partial<Record<CostCategory, number>>;
  /** usage per category, in the provider's unit (hours, requests, GB) */
  usage: Partial<Record<CostCategory, number>>;
  /** instance types / SKUs seen */
  skus: string[];
  /** $ per bucket on the dataset grid (null where the bill has no line) */
  series?: Num[];
}

export interface Bill {
  source: 'aws-cur' | 'gcp-billing';
  currency: string;
  start: number;
  end: number;
  total: number;
  components: Record<string, BillComponent>;
  /** spend that could not be attributed to a component */
  unattributed: number;
}

export interface Placement {
  zone?: string;
  region?: string;
}

export interface Dataset {
  version: 1;
  name: string;
  /** epoch seconds of the first bucket start */
  start: number;
  stepS: number;
  n: number;
  services: Record<string, ServiceSeries>;
  endpoints: Record<string, EndpointSeries>;
  topology?: Topology;
  bill?: Bill;
  placement?: Record<string, Placement>;
  cluster?: ClusterSeries;
  /** pods per node per service at the end of the window (Kubernetes): what losing a node takes */
  podsByNode?: Record<string, Record<string, number>>;
  /** the zone of each node, where the provider id tells it (AWS, GCP) */
  nodeZones?: Record<string, string>;
  /** HorizontalPodAutoscalers at the end of the window, by the workload they scale */
  hpa?: Record<string, { min: number; max: number; targetCpu?: number }>;
  /** where each piece came from, for the report */
  sources: string[];
  /** modelling hints from the import manifest (SLO, client deadline, in-process dependencies…) */
  hints?: {
    slo?: { p99Ms: number; errorRate: number };
    timeoutMs?: number;
    hostedBy?: Record<string, string>;
    services?: Record<string, { kind?: 'server' | 'db' | 'cache' | 'queue' | 'external' | 'lb'; servers?: number; perReplicaRps?: number; arch?: 'x86' | 'arm' }>;
    /** the node pool, where the metrics can't tell: its node price, and whether it autoscales */
    cluster?: { nodePriceHour?: number; autoscaled?: boolean; provisionS?: number };
    /** endpoints with their own SLO */
    endpoints?: Record<string, { slo?: { p99Ms: number; errorRate: number } }>;
  };
}

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** slice a dataset to buckets [from, to) */
export function sliceDataset(d: Dataset, from: number, to: number): Dataset {
  const cut = (a: Num[] | undefined) => a?.slice(from, to);
  const services: Record<string, ServiceSeries> = {};
  for (const [id, s] of Object.entries(d.services)) {
    const o: ServiceSeries = {};
    for (const m of SERVICE_METRICS) if (s[m]) o[m] = cut(s[m]);
    services[id] = o;
  }
  const endpoints: Record<string, EndpointSeries> = {};
  for (const [id, e] of Object.entries(d.endpoints)) endpoints[id] = { service: e.service, rps: cut(e.rps), errorRate: cut(e.errorRate), p50Ms: cut(e.p50Ms), p99Ms: cut(e.p99Ms), meanMs: cut(e.meanMs) };
  // the bill's totals follow the slice: each component's spend scales with its share of the series
  let bill: Bill | undefined;
  if (d.bill) {
    const start = d.start + from * d.stepS;
    const end = d.start + Math.min(d.n, to) * d.stepS;
    const frac = Math.max(0, Math.min(1, (Math.min(end, d.bill.end) - Math.max(start, d.bill.start)) / Math.max(1, d.bill.end - d.bill.start)));
    const components: Bill['components'] = {};
    let total = 0;
    for (const [k, c] of Object.entries(d.bill.components)) {
      const all = (c.series ?? []).reduce<number>((a, v) => a + (v ?? 0), 0);
      const part = (cut(c.series) ?? []).reduce<number>((a, v) => a + (v ?? 0), 0);
      const f = c.series ? (all > 0 ? part / all : 0) : frac;
      const scale = <T extends Partial<Record<CostCategory, number>>>(o: T) => Object.fromEntries(Object.entries(o).map(([cat, v]) => [cat, (v ?? 0) * f])) as T;
      components[k] = { ...c, total: c.total * f, byCategory: scale(c.byCategory), usage: scale(c.usage), series: cut(c.series) };
      total += c.total * f;
    }
    bill = { ...d.bill, start: Math.max(start, d.bill.start), end: Math.min(end, d.bill.end), components, unattributed: d.bill.unattributed * frac, total: total + d.bill.unattributed * frac };
  }
  const cluster = d.cluster ? (Object.fromEntries(Object.entries(d.cluster).map(([k, v]) => [k, cut(v)])) as ClusterSeries) : undefined;
  return { ...d, start: d.start + from * d.stepS, n: Math.max(0, Math.min(d.n, to) - from), services, endpoints, bill, ...(cluster ? { cluster } : {}) };
}
