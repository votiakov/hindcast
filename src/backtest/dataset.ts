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

export const bucketTimes = (d: Pick<Dataset, 'start' | 'stepS' | 'n'>) => Array.from({ length: d.n }, (_, i) => d.start + i * d.stepS);

export function emptySeries(n: number): Num[] {
  return new Array(n).fill(null);
}

/** mean of the non-null values */
export function meanOf(a: Num[] | undefined): number | null {
  if (!a) return null;
  let s = 0;
  let k = 0;
  for (const v of a) if (v !== null && isFinite(v)) (s += v), k++;
  return k ? s / k : null;
}

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Accumulates raw (time, value) points per series and averages them into grid buckets.
 * Latency quantiles are averaged too (a reasonable estimate when export step ≤ bucket).
 */
export class DatasetBuilder {
  private svc = new Map<string, Map<ServiceMetric, Map<number, { s: number; k: number }>>>();
  private ep = new Map<string, { service: string; m: Map<string, Map<number, { s: number; k: number }>> }>();
  sources: string[] = [];
  minT = Infinity;
  maxT = -Infinity;

  /** (service, metric) pairs an edge source (a load balancer, an ingress) measured: those counts
   *  see every request, so they replace what span metrics or traces said instead of averaging with it */
  private edge = new Set<string>();
  /** services with at least one series measured at the edge */
  edgeServices = new Set<string>();

  addService(service: string, metric: ServiceMetric, t: number, v: number, edge = false) {
    if (!isFinite(v) || !isFinite(t)) return;
    const key = `${service}\u0000${metric}`;
    if (edge && !this.edge.has(key)) {
      this.edge.add(key);
      this.edgeServices.add(service);
      this.svc.get(service)?.delete(metric);
    } else if (!edge && this.edge.has(key)) return;
    let m = this.svc.get(service);
    if (!m) this.svc.set(service, (m = new Map()));
    let s = m.get(metric);
    if (!s) m.set(metric, (s = new Map()));
    const p = s.get(t) ?? { s: 0, k: 0 };
    p.s += v;
    p.k += 1;
    s.set(t, p);
    this.minT = Math.min(this.minT, t);
    this.maxT = Math.max(this.maxT, t);
  }

  private cl = new Map<ClusterMetric, Map<number, { s: number; k: number }>>();
  addCluster(metric: ClusterMetric, t: number, v: number) {
    if (!isFinite(v) || !isFinite(t)) return;
    let s = this.cl.get(metric);
    if (!s) this.cl.set(metric, (s = new Map()));
    const p = s.get(t) ?? { s: 0, k: 0 };
    p.s += v;
    p.k += 1;
    s.set(t, p);
  }

  addEndpoint(endpoint: string, service: string, metric: 'rps' | 'errorRate' | 'p50Ms' | 'p99Ms' | 'meanMs', t: number, v: number) {
    if (!isFinite(v) || !isFinite(t)) return;
    let e = this.ep.get(endpoint);
    if (!e) this.ep.set(endpoint, (e = { service, m: new Map() }));
    let s = e.m.get(metric);
    if (!s) e.m.set(metric, (s = new Map()));
    const p = s.get(t) ?? { s: 0, k: 0 };
    p.s += v;
    p.k += 1;
    s.set(t, p);
    this.minT = Math.min(this.minT, t);
    this.maxT = Math.max(this.maxT, t);
  }

  services() {
    return [...this.svc.keys()];
  }

  /** does this service have this metric yet? */
  hasService(service: string, metric: ServiceMetric) {
    return !!this.svc.get(service)?.has(metric);
  }

  /** does any service have this metric yet? */
  has(metric: ServiceMetric) {
    return [...this.svc.values()].some((m) => m.has(metric));
  }

  build(opts: { name: string; stepS?: number; start?: number; end?: number }): Dataset {
    if (!isFinite(this.minT)) throw new Error('no data points were imported');
    const times = new Set<number>();
    for (const m of this.svc.values()) for (const s of m.values()) for (const t of s.keys()) times.add(t);
    const sorted = [...times].sort((a, b) => a - b);
    let native = Infinity;
    for (let i = 1; i < sorted.length; i++) if (sorted[i] - sorted[i - 1] > 0) native = Math.min(native, sorted[i] - sorted[i - 1]);
    const stepS = opts.stepS ?? (isFinite(native) ? Math.max(1, native) : 60);
    const start = Math.floor((opts.start ?? this.minT) / stepS) * stepS;
    const end = opts.end ?? this.maxT;
    const n = Math.max(1, Math.floor((end - start) / stepS) + 1);
    const grid = (src: Map<number, { s: number; k: number }>): Num[] => {
      const acc = Array.from({ length: n }, () => ({ s: 0, k: 0 }));
      for (const [t, p] of src) {
        const i = Math.floor((t - start) / stepS);
        if (i < 0 || i >= n) continue;
        acc[i].s += p.s;
        acc[i].k += p.k;
      }
      return acc.map((a) => (a.k ? a.s / a.k : null));
    };
    const services: Record<string, ServiceSeries> = {};
    for (const [id, m] of this.svc) {
      const s: ServiceSeries = {};
      for (const [metric, pts] of m) s[metric] = grid(pts);
      services[id] = s;
    }
    const endpoints: Record<string, EndpointSeries> = {};
    for (const [id, e] of this.ep) {
      const s: EndpointSeries = { service: e.service };
      for (const [metric, pts] of e.m) (s as unknown as Record<string, Num[]>)[metric] = grid(pts);
      endpoints[id] = s;
    }
    const cluster: ClusterSeries = {};
    for (const [metric, pts] of this.cl) cluster[metric] = grid(pts);
    return { version: 1, name: opts.name, start, stepS, n, services, endpoints, ...(this.cl.size ? { cluster } : {}), sources: this.sources };
  }
}

/** re-grid a dataset to a coarser step (averaging), e.g. 15 s scrape data → 1 min buckets */
export function regrid(d: Dataset, stepS: number): Dataset {
  if (stepS <= d.stepS) return d;
  const f = Math.round(stepS / d.stepS);
  const n = Math.ceil(d.n / f);
  const coarse = (a: Num[] | undefined): Num[] | undefined => {
    if (!a) return undefined;
    const out: Num[] = [];
    for (let i = 0; i < n; i++) {
      let s = 0;
      let k = 0;
      for (let j = i * f; j < Math.min(a.length, (i + 1) * f); j++) if (a[j] !== null) (s += a[j] as number), k++;
      out.push(k ? s / k : null);
    }
    return out;
  };
  const services: Record<string, ServiceSeries> = {};
  for (const [id, s] of Object.entries(d.services)) {
    const o: ServiceSeries = {};
    for (const m of SERVICE_METRICS) if (s[m]) o[m] = coarse(s[m]);
    services[id] = o;
  }
  const endpoints: Record<string, EndpointSeries> = {};
  for (const [id, e] of Object.entries(d.endpoints)) endpoints[id] = { service: e.service, rps: coarse(e.rps), errorRate: coarse(e.errorRate), p50Ms: coarse(e.p50Ms), p99Ms: coarse(e.p99Ms), meanMs: coarse(e.meanMs) };
  const bill = d.bill ? { ...d.bill, components: Object.fromEntries(Object.entries(d.bill.components).map(([k, c]) => [k, { ...c, series: c.series ? coarse(c.series)!.map((v) => (v === null ? null : v * f)) : undefined }])) } : undefined;
  const cluster = d.cluster ? (Object.fromEntries(Object.entries(d.cluster).map(([k, v]) => [k, coarse(v)])) as ClusterSeries) : undefined;
  return { ...d, stepS: d.stepS * f, n, services, endpoints, bill, ...(cluster ? { cluster } : {}) };
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
