import { quantile, type DatasetBuilder, type EndpointShape, type ServiceShape, type Topology } from '../dataset';

/**
 * Traces → topology and per-bucket latency.
 *
 * Accepts OpenTelemetry OTLP JSON (collector `file` exporter: one ExportTraceServiceRequest per
 * line, or a single JSON document) and Jaeger JSON (UI "download", `/api/traces`).
 *
 * A *visit* is one service handling one call: a SERVER/CONSUMER span, a span whose service differs
 * from its parent's, or a CLIENT span to an uninstrumented dependency (database, cache, queue) which
 * becomes a virtual service named after `peer.service` / `db.system`. Every other span belongs to the
 * visit above it. Self time = visit duration minus the time covered by its child visits; the
 * critical path through each trace says how many ms of the end-to-end latency each service owns.
 */

export interface Span {
  traceId: string;
  spanId: string;
  parentId: string | null;
  service: string;
  name: string;
  kind: 'server' | 'client' | 'producer' | 'consumer' | 'internal';
  /** ms since epoch (float) */
  start: number;
  end: number;
  error: boolean;
  attrs: Record<string, string | number | boolean>;
}

type AnyAttr = { key: string; value?: Record<string, unknown> };

function otlpValue(v: Record<string, unknown> | undefined): string | number | boolean | undefined {
  if (!v) return undefined;
  if ('stringValue' in v) return String(v.stringValue);
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('boolValue' in v) return Boolean(v.boolValue);
  return undefined;
}

/** ns timestamp string → ms (float) without losing precision past 2^53 */
const nsToMs = (ns: string | number) => (typeof ns === 'number' ? ns / 1e6 : Number(ns.length > 3 ? ns.slice(0, -3) : '0') / 1000);

const KIND_NUM = ['internal', 'internal', 'server', 'client', 'producer', 'consumer'] as const;
function otlpKind(k: unknown): Span['kind'] {
  if (typeof k === 'number') return KIND_NUM[k] ?? 'internal';
  const s = String(k ?? '').toLowerCase().replace('span_kind_', '');
  return (['server', 'client', 'producer', 'consumer'] as const).find((x) => x === s) ?? 'internal';
}

const KEEP = /^(http\.(route|method|request\.method|status_code|response\.status_code|request\.body\.size|response\.body\.size|request_content_length|response_content_length)|rpc\.(system|service|method|request\.size|response\.size)|db\.system|messaging\.(system|message)|peer\.service|server\.address|net\.peer\.name|error|otel\.status_code|span\.kind)/;

export function parseOtlp(doc: unknown, out: Span[] = []): Span[] {
  const rs = (doc as { resourceSpans?: unknown[] }).resourceSpans;
  if (!Array.isArray(rs)) return out;
  for (const r of rs as { resource?: { attributes?: AnyAttr[] }; scopeSpans?: { spans?: unknown[] }[]; instrumentationLibrarySpans?: { spans?: unknown[] }[] }[]) {
    const service = String(otlpValue(r.resource?.attributes?.find((a) => a.key === 'service.name')?.value) ?? 'unknown');
    for (const ss of r.scopeSpans ?? r.instrumentationLibrarySpans ?? []) {
      for (const sp of (ss.spans ?? []) as Record<string, unknown>[]) {
        const attrs: Span['attrs'] = {};
        for (const a of (sp.attributes ?? []) as AnyAttr[]) {
          if (!KEEP.test(a.key)) continue;
          const v = otlpValue(a.value);
          if (v !== undefined) attrs[a.key] = v;
        }
        const status = sp.status as { code?: unknown } | undefined;
        const code = status?.code;
        const httpStatus = Number(attrs['http.response.status_code'] ?? attrs['http.status_code'] ?? 0);
        out.push({
          traceId: String(sp.traceId),
          spanId: String(sp.spanId),
          parentId: sp.parentSpanId ? String(sp.parentSpanId) : null,
          service,
          name: String(sp.name ?? ''),
          kind: otlpKind(sp.kind),
          start: nsToMs(sp.startTimeUnixNano as string),
          end: nsToMs(sp.endTimeUnixNano as string),
          error: code === 2 || code === 'STATUS_CODE_ERROR' || httpStatus >= 500,
          attrs,
        });
      }
    }
  }
  return out;
}

interface JaegerSpan {
  traceID: string;
  spanID: string;
  operationName: string;
  references?: { refType: string; spanID: string }[];
  startTime: number;
  duration: number;
  tags?: { key: string; value: unknown }[];
  processID: string;
}

export function parseJaeger(doc: unknown, out: Span[] = []): Span[] {
  const data = (doc as { data?: { spans: JaegerSpan[]; processes: Record<string, { serviceName: string }> }[] }).data;
  if (!Array.isArray(data)) return out;
  for (const tr of data) {
    for (const sp of tr.spans) {
      const attrs: Span['attrs'] = {};
      let kind: Span['kind'] = 'internal';
      let error = false;
      for (const t of sp.tags ?? []) {
        if (t.key === 'span.kind') kind = otlpKind(t.value);
        else if (t.key === 'error') error = t.value === true || t.value === 'true';
        else if (t.key === 'otel.status_code') error ||= t.value === 'ERROR';
        if (KEEP.test(t.key) && (typeof t.value === 'string' || typeof t.value === 'number' || typeof t.value === 'boolean')) attrs[t.key] = t.value;
      }
      const parent = sp.references?.find((r) => r.refType === 'CHILD_OF') ?? sp.references?.[0];
      out.push({
        traceId: sp.traceID,
        spanId: sp.spanID,
        parentId: parent?.spanID ?? null,
        service: tr.processes[sp.processID]?.serviceName ?? 'unknown',
        name: sp.operationName,
        kind,
        start: sp.startTime / 1000,
        end: (sp.startTime + sp.duration) / 1000,
        error,
        attrs,
      });
    }
  }
  return out;
}

/** JSON lines of OTLP / Jaeger documents, streamed (files larger than a JS string can hold) */
export function parseTraceLines(lines: Iterable<string>, out: Span[] = []): Span[] {
  for (const line of lines) {
    if (!line.trim()) continue;
    const doc = JSON.parse(line);
    if ((doc as { data?: unknown }).data) parseJaeger(doc, out);
    else parseOtlp(doc, out);
  }
  return out;
}

/** any supported trace file: JSON lines of OTLP, one OTLP document, or Jaeger JSON */
export function parseTraceFile(text: string, out: Span[] = []): Span[] {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') && !trimmed.includes('\n{')) {
    const doc = JSON.parse(trimmed);
    if ((doc as { data?: unknown }).data) return parseJaeger(doc, out);
    return parseOtlp(doc, out);
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const doc = JSON.parse(line);
    if ((doc as { data?: unknown }).data) parseJaeger(doc, out);
    else parseOtlp(doc, out);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------

const SQL = new Set(['mysql', 'postgresql', 'postgres', 'mssql', 'oracle', 'sqlite', 'mariadb', 'cockroachdb', 'db2', 'spanner', 'dynamodb', 'mongodb', 'cassandra', 'elasticsearch', 'opensearch']);
const CACHE = new Set(['redis', 'memcached', 'valkey']);

/** what kind of component a span talks to / runs in, from its attributes */
function systemOf(sp: Span): { kind: ServiceShape['kind']; system: string } | null {
  const db = (sp.attrs['db.system'] ?? sp.attrs['db.system.name']) as string | undefined;
  const mq = sp.attrs['messaging.system'] as string | undefined;
  if (db) return { kind: CACHE.has(db) ? 'cache' : 'db', system: db };
  if (mq) return { kind: 'queue', system: mq };
  return null;
}

function dependencyOf(sp: Span): { name: string; kind: ServiceShape['kind']; system?: string } | null {
  const db = (sp.attrs['db.system'] ?? sp.attrs['db.system.name']) as string | undefined;
  const mq = sp.attrs['messaging.system'] as string | undefined;
  const peer = (sp.attrs['peer.service'] ?? sp.attrs['server.address'] ?? sp.attrs['net.peer.name']) as string | undefined;
  if (db) return { name: String(peer ?? db), kind: CACHE.has(db) ? 'cache' : SQL.has(db) ? 'db' : 'db', system: db };
  if (mq) return { name: String(peer ?? mq), kind: 'queue', system: mq };
  if (peer && sp.kind === 'client') return { name: String(peer), kind: 'external' };
  return null;
}

interface Visit {
  service: string;
  kind: ServiceShape['kind'];
  system?: string;
  start: number;
  end: number;
  error: boolean;
  name: string;
  route?: string;
  method?: string;
  bytes: number | null;
  children: Visit[];
  /** set by critical-path pass */
  self: number;
}

function payloadBytes(...spans: (Span | undefined)[]): number | null {
  let total = 0;
  let any = false;
  for (const sp of spans) {
    if (!sp) continue;
    for (const k of ['http.request.body.size', 'http.response.body.size', 'http.request_content_length', 'http.response_content_length', 'messaging.message.body.size', 'messaging.message_payload_size_bytes', 'rpc.request.size', 'rpc.response.size']) {
      const v = Number(sp.attrs[k]);
      if (isFinite(v) && v > 0) (total += v), (any = true);
    }
    if (any) break; // client and server usually report the same body — count it once
  }
  return any ? total : null;
}

/** build the visit tree of one trace */
function visitsOf(spans: Span[], ignore: Set<string>): Visit[] {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const kids = new Map<string, Span[]>();
  for (const s of spans) if (s.parentId && byId.has(s.parentId)) (kids.get(s.parentId) ?? kids.set(s.parentId, []).get(s.parentId)!).push(s);
  const roots = spans.filter((s) => !s.parentId || !byId.has(s.parentId));

  const visits: Visit[] = [];
  const walk = (sp: Span, owner: Visit | null, viaClient: Span | undefined) => {
    const parent = sp.parentId ? byId.get(sp.parentId) : undefined;
    const ignored = ignore.has(sp.service);
    let current = owner;
    if (!ignored) {
      const boundary = !owner || sp.kind === 'server' || sp.kind === 'consumer' || (parent && parent.service !== sp.service);
      const childSpans = kids.get(sp.spanId) ?? [];
      const dep = (sp.kind === 'client' || sp.kind === 'producer') && !childSpans.some((c) => c.service !== sp.service) ? dependencyOf(sp) : null;
      if (boundary || dep) {
        // a service that reports itself (e.g. a tracer named "mysql") still gets its kind from attributes
        const own = dep ?? systemOf(sp);
        const v: Visit = {
          service: dep ? dep.name : sp.service,
          kind: own ? own.kind : 'server',
          system: own?.system,
          start: sp.start,
          end: sp.end,
          error: sp.error,
          name: sp.name,
          route: (sp.attrs['http.route'] as string) ?? undefined,
          method: (sp.attrs['http.request.method'] ?? sp.attrs['http.method']) as string | undefined,
          bytes: payloadBytes(viaClient, sp),
          children: [],
          self: 0,
        };
        if (owner) owner.children.push(v);
        else visits.push(v);
        current = v;
      }
    }
    for (const c of kids.get(sp.spanId) ?? []) walk(c, current, sp.kind === 'client' || sp.kind === 'producer' ? sp : undefined);
  };
  for (const r of roots) walk(r, null, undefined);
  return visits;
}

/** union length of intervals clipped to [lo, hi] */
function covered(iv: [number, number][], lo: number, hi: number): number {
  const xs = iv.map(([a, b]) => [Math.max(lo, a), Math.min(hi, b)] as [number, number]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cs = -Infinity;
  let ce = -Infinity;
  for (const [a, b] of xs) {
    if (a > ce) {
      if (ce > cs) total += ce - cs;
      [cs, ce] = [a, b];
    } else ce = Math.max(ce, b);
  }
  if (ce > cs) total += ce - cs;
  return total;
}

/** ms of the critical path owned by each service, walking back from the end of the visit */
function criticalPath(v: Visit, hi: number, acc: Map<string, number>) {
  const end = Math.min(v.end, hi);
  let cursor = end;
  const kids = [...v.children].sort((a, b) => b.end - a.end);
  for (const k of kids) {
    if (k.start >= cursor) continue;
    const kEnd = Math.min(k.end, cursor);
    acc.set(v.service, (acc.get(v.service) ?? 0) + (cursor - kEnd));
    criticalPath(k, kEnd, acc);
    cursor = Math.max(v.start, k.start);
  }
  acc.set(v.service, (acc.get(v.service) ?? 0) + Math.max(0, cursor - v.start));
}

function selfTimes(v: Visit) {
  v.self = Math.max(0, v.end - v.start - covered(v.children.map((c) => [c.start, c.end]), v.start, v.end));
  v.children.forEach(selfTimes);
}

export interface TraceImportOptions {
  /** bucket size for per-bucket series, s */
  stepS: number;
  /** share of requests traced (1 = all); counts are divided by it */
  sampling?: number;
  /** services to treat as outside the system (load generators, synthetic monitors) */
  ignoreServices?: string[];
  rename?: Record<string, string>;
  /** write per-bucket rps/latency series into the dataset (off when metrics already provide them) */
  series?: { rps: boolean; latency: boolean; endpoints: boolean };
}

export const endpointId = (v: { service: string; name: string; route?: string; method?: string }) => {
  const label = v.route ? `${v.method ? v.method.toUpperCase() + ' ' : ''}${v.route}` : v.name.replace(/^HTTP /, '');
  return `${v.service} ${label}`;
};

/** fold spans into topology + per-bucket series on the builder */
export function buildTopology(spans: Span[], b: DatasetBuilder | null, opts: TraceImportOptions): Topology {
  const ignore = new Set(opts.ignoreServices ?? []);
  const rename = opts.rename ?? {};
  for (const s of spans) if (rename[s.service]) s.service = rename[s.service];
  const sampling = opts.sampling ?? 1;
  const byTrace = new Map<string, Span[]>();
  for (const s of spans) (byTrace.get(s.traceId) ?? byTrace.set(s.traceId, []).get(s.traceId)!).push(s);

  const svc = new Map<string, { n: number; self: number[]; incl: number[]; kind: ServiceShape['kind']; system?: string }>();
  const edges = new Map<string, { calls: number; bytes: number; bytesN: number }>();
  const eps = new Map<string, { service: string; n: number; err: number; dur: number[]; calls: Map<string, number>; visits: Map<string, number>; cp: Map<string, number>; bytes: Map<string, number> }>();
  // per-bucket accumulators
  const step = opts.stepS;
  const sb = new Map<string, Map<number, { n: number; err: number; self: number[]; incl: number[] }>>();
  const eb = new Map<string, Map<number, { n: number; err: number; dur: number[] }>>();
  let tMin = Infinity;
  let tMax = -Infinity;
  let traces = 0;

  for (const tr of byTrace.values()) {
    const roots = visitsOf(tr, ignore);
    for (const root of roots) {
      traces++;
      selfTimes(root);
      const cp = new Map<string, number>();
      criticalPath(root, root.end, cp);
      const id = endpointId(root);
      const ep = eps.get(id) ?? eps.set(id, { service: root.service, n: 0, err: 0, dur: [], calls: new Map(), visits: new Map(), cp: new Map(), bytes: new Map() }).get(id)!;
      ep.n++;
      const dur = root.end - root.start;
      ep.dur.push(dur);
      let failed = false;
      const walk = (v: Visit, parent: Visit | null) => {
        failed ||= v === root && v.error;
        ep.visits.set(v.service, (ep.visits.get(v.service) ?? 0) + 1);
        const s = svc.get(v.service) ?? { n: 0, self: [], incl: [], kind: v.kind, system: v.system };
        svc.set(v.service, s);
        s.n++;
        s.self.push(v.self);
        s.incl.push(v.end - v.start);
        const bucket = Math.floor(v.start / 1000 / step) * step;
        tMin = Math.min(tMin, bucket);
        tMax = Math.max(tMax, bucket);
        const m = sb.get(v.service) ?? sb.set(v.service, new Map()).get(v.service)!;
        const cell = m.get(bucket) ?? m.set(bucket, { n: 0, err: 0, self: [], incl: [] }).get(bucket)!;
        cell.n++;
        cell.err += v.error ? 1 : 0;
        cell.self.push(v.self);
        cell.incl.push(v.end - v.start);
        if (parent) {
          const key = `${parent.service}>${v.service}`;
          ep.calls.set(key, (ep.calls.get(key) ?? 0) + 1);
          const e = edges.get(key) ?? { calls: 0, bytes: 0, bytesN: 0 };
          edges.set(key, e);
          e.calls++;
          if (v.bytes !== null) {
            e.bytes += v.bytes;
            e.bytesN++;
            ep.bytes.set(key, (ep.bytes.get(key) ?? 0) + v.bytes);
          }
        }
        for (const c of v.children) walk(c, v);
      };
      walk(root, null);
      if (failed) ep.err++;
      for (const [k, ms] of cp) ep.cp.set(k, (ep.cp.get(k) ?? 0) + ms);
      const bucket = Math.floor(root.start / 1000 / step) * step;
      const m = eb.get(id) ?? eb.set(id, new Map()).get(id)!;
      const cell = m.get(bucket) ?? m.set(bucket, { n: 0, err: 0, dur: [] }).get(bucket)!;
      cell.n++;
      cell.err += failed ? 1 : 0;
      cell.dur.push(dur);
    }
  }

  const span = isFinite(tMin) ? tMax - tMin + step : 0;
  const services: Record<string, ServiceShape> = {};
  for (const [id, s] of svc) {
    const self = [...s.self].sort((a, b) => a - b);
    const incl = [...s.incl].sort((a, b) => a - b);
    services[id] = {
      spans: s.n,
      selfMeanMs: self.reduce((a, x) => a + x, 0) / self.length,
      selfP50Ms: quantile(self, 0.5),
      selfP99Ms: quantile(self, 0.99),
      meanMs: incl.reduce((a, x) => a + x, 0) / incl.length,
      p99Ms: quantile(incl, 0.99),
      kind: s.kind,
      ...(s.system ? { system: s.system } : {}),
    };
  }
  const endpoints: Record<string, EndpointShape> = {};
  for (const [id, e] of eps) {
    const dur = [...e.dur].sort((a, b) => a - b);
    const per = (m: Map<string, number>) => Object.fromEntries([...m].map(([k, v]) => [k, v / e.n]));
    endpoints[id] = { service: e.service, traces: e.n, calls: per(e.calls), visits: per(e.visits), criticalMs: per(e.cp), meanMs: dur.reduce((a, x) => a + x, 0) / dur.length, p99Ms: quantile(dur, 0.99), bytes: per(e.bytes), errorRate: e.err / e.n };
  }

  if (b) {
    const want = opts.series ?? { rps: true, latency: true, endpoints: true };
    for (const [id, m] of sb) {
      // services the metrics don't cover (uninstrumented databases, caches) still get rates from traces
      const fill = !want.rps && !b.hasService(id, 'rps');
      const fillLat = !want.latency && !b.hasService(id, 'p99Ms');
      for (const [t, c] of m) {
        const self = c.self.sort((x, y) => x - y);
        const incl = c.incl.sort((x, y) => x - y);
        b.addService(id, 'selfMeanMs', t, self.reduce((a, x) => a + x, 0) / self.length);
        b.addService(id, 'selfP99Ms', t, quantile(self, 0.99));
        if (want.rps || fill) {
          b.addService(id, 'rps', t, c.n / step / sampling);
          b.addService(id, 'errorRate', t, c.err / c.n);
        }
        if (want.latency || fillLat) {
          b.addService(id, 'meanMs', t, incl.reduce((a, x) => a + x, 0) / incl.length);
          b.addService(id, 'p50Ms', t, quantile(incl, 0.5));
          b.addService(id, 'p99Ms', t, quantile(incl, 0.99));
        }
      }
    }
    if (want.endpoints)
      for (const [id, m] of eb) {
        const service = endpoints[id].service;
        for (const [t, c] of m) {
          const dur = c.dur.sort((x, y) => x - y);
          b.addEndpoint(id, service, 'rps', t, c.n / step / sampling);
          b.addEndpoint(id, service, 'errorRate', t, c.err / c.n);
          b.addEndpoint(id, service, 'meanMs', t, dur.reduce((a, x) => a + x, 0) / dur.length);
          b.addEndpoint(id, service, 'p50Ms', t, quantile(dur, 0.5));
          b.addEndpoint(id, service, 'p99Ms', t, quantile(dur, 0.99));
        }
      }
  }

  return {
    services,
    edges: [...edges].map(([k, e]) => {
      const [from, to] = k.split('>');
      return { from, to, callsPerS: span ? e.calls / span / sampling : 0, bytesPerCall: e.bytesN ? e.bytes / e.bytesN : null };
    }),
    endpoints,
    start: isFinite(tMin) ? tMin : 0,
    end: isFinite(tMax) ? tMax + step : 0,
    traces,
    ...(opts.sampling ? { sampling: opts.sampling } : {}),
  };
}
