import { authHeaders, getJson, iso, type Sources } from './workspace';
import type { Span } from '../src/backtest/import/traces';
import { parseJaeger, parseOtlp } from '../src/backtest/import/traces';

/**
 * Talking to live telemetry, read-only: what a Prometheus holds and for how long, which services a
 * Jaeger or Tempo knows, and fetching traces spread over a window (both APIs return the newest
 * traces first, so one big query would only describe the last few minutes).
 */

type PromResp<T> = { status: string; data: T; error?: string };
type PromVector = { resultType: string; result: { metric: Record<string, string>; value: [number, string] }[] };

/** the metric each preset needs, and the label that names services in it */
export const PRESET_SIGNATURE: Record<string, { metric: string; label: string; also?: string }> = {
  'otel-spanmetrics': { metric: 'traces_span_metrics_calls_total', label: 'service_name' },
  'http-server': { metric: 'http_server_request_duration_seconds_count', label: 'service_name' },
  cadvisor: { metric: 'container_spec_cpu_quota', label: 'container_label_com_docker_compose_service' },
  kubernetes: { metric: 'kube_pod_container_resource_limits', label: 'container' },
};

/** metric names seen under older or vendor spellings, which the presets don't query yet */
const NEAR_MISSES: Record<string, string> = {
  calls_total: 'spanmetrics from an older collector (calls_total): rename with a recording rule to traces_span_metrics_calls_total',
  traces_spanmetrics_calls_total: 'spanmetrics from the old spanmetrics processor: rename with a recording rule to traces_span_metrics_calls_total',
  http_server_duration_milliseconds_count: 'OpenTelemetry HTTP metrics under the pre-1.0 name (milliseconds): the http-server preset expects http_server_request_duration_seconds',
  http_server_requests_seconds_count: 'Spring Boot Micrometer metrics: not a preset yet — export them with a CSV mapping',
};

export interface PrometheusProbe {
  url: string;
  ok: boolean;
  version?: string;
  presets: string[];
  nearMisses: string[];
  services: Record<string, string[]>;
  /** where data exists for the main request metric: newest sample and how far back it goes */
  data?: { newest: string; oldestFound: string; hoursFound: number; probes: { at: string; requests10m: number }[] };
  warnings: string[];
}

const LOOKBACKS_H = [0, 1, 6, 24, 72, 168, 336, 720];

export async function probePrometheus(cfg: NonNullable<Sources['prometheus']>, now = Date.now() / 1000): Promise<PrometheusProbe> {
  const h = authHeaders(cfg);
  const api = (path: string, q: Record<string, string> = {}) => {
    const u = new URL(path, cfg.url.endsWith('/') ? cfg.url : cfg.url + '/');
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
    return u.toString();
  };
  const out: PrometheusProbe = { url: cfg.url, ok: false, presets: [], nearMisses: [], services: {}, warnings: [] };
  try {
    const b = await getJson<PromResp<{ version: string }>>(api('api/v1/status/buildinfo'), h, 10_000);
    out.version = b.data?.version;
  } catch (e) {
    // Thanos, Mimir and managed Prometheus often hide buildinfo; the query API is what matters
    out.warnings.push(`buildinfo unavailable (${(e as Error).message.slice(0, 80)}) — fine for Thanos/Mimir/managed Prometheus`);
  }
  const start = String(now - 30 * 86400);
  const names = [...Object.values(PRESET_SIGNATURE).map((p) => p.metric), ...Object.keys(NEAR_MISSES)];
  const found = await getJson<PromResp<string[]>>(api('api/v1/label/__name__/values', { 'match[]': `{__name__=~"${names.join('|')}"}`, start, end: String(now) }), h);
  out.ok = found.status === 'success';
  const have = new Set(found.data ?? []);
  for (const [id, p] of Object.entries(PRESET_SIGNATURE)) {
    if (!have.has(p.metric)) continue;
    const vals = await getJson<PromResp<string[]>>(api(`api/v1/label/${p.label}/values`, { 'match[]': cfg.selector ? `${p.metric}{${cfg.selector}}` : p.metric, start, end: String(now) }), h);
    const svcs = (vals.data ?? []).filter((v) => v && v !== 'POD');
    if (!svcs.length) {
      out.warnings.push(`${p.metric} exists but has no "${p.label}" label${cfg.selector ? ` under ${cfg.selector}` : ''} — the ${id} preset can't name services`);
      continue;
    }
    out.presets.push(id);
    out.services[id] = svcs.sort();
  }
  for (const [n, why] of Object.entries(NEAR_MISSES)) if (have.has(n)) out.nearMisses.push(`${n}: ${why}`);
  if (!out.presets.length) out.warnings.push('no metric any preset reads was found in the last 30 days');

  // when requests flowed: traffic (a rate above zero, not just a counter still being exported)
  // at a few lookbacks, then bisected to ~1% of the gap for the newest and oldest edges
  const main = out.presets.find((p) => p === 'otel-spanmetrics' || p === 'http-server');
  if (main) {
    const m = PRESET_SIGNATURE[main].metric;
    const sel = cfg.selector ? `{${cfg.selector}}` : '';
    const traffic = async (t: number) => {
      const r = await getJson<PromResp<PromVector>>(api('api/v1/query', { query: `sum(increase(${m}${sel}[10m]))`, time: String(t) }), h);
      return Number(r.data?.result?.[0]?.value?.[1] ?? 0);
    };
    const probes: { at: string; requests10m: number }[] = [];
    const active: number[] = [];
    for (const hAgo of LOOKBACKS_H) {
      const t = now - hAgo * 3600;
      const n = await traffic(t);
      probes.push({ at: iso(t), requests10m: Math.round(n) });
      if (n > 0) active.push(t);
    }
    if (active.length) {
      // the edge between an active and an idle time. Traffic comes and goes (busy, idle, busy
      // again), so scan the gap first and bisect only between the outermost active sample and its
      // idle neighbour; plain bisection would stop at the first idle stretch
      const edge = async (on: number, off: number) => {
        const k = 48;
        let last = on;
        let next = off;
        for (let j = 1; j < k; j++) {
          const t = on + ((off - on) * j) / k;
          if ((await traffic(t)) > 0) last = t;
        }
        next = last + (off - on) / k;
        if (Math.sign(next - off) === Math.sign(off - on)) next = off;
        on = last;
        off = next;
        for (let j = 0; j < 8; j++) {
          const mid = (on + off) / 2;
          if ((await traffic(mid)) > 0) on = mid;
          else off = mid;
        }
        return on;
      };
      const newestActive = Math.max(...active);
      const newerIdle = LOOKBACKS_H.map((x) => now - x * 3600).filter((t) => t > newestActive).sort((x, y) => x - y)[0];
      const newest = newerIdle !== undefined ? await edge(newestActive, newerIdle) : newestActive;
      const oldestActive = Math.min(...active);
      const olderIdle = LOOKBACKS_H.map((x) => now - x * 3600).filter((t) => t < oldestActive).sort((x, y) => y - x)[0];
      const oldest = (olderIdle !== undefined ? await edge(oldestActive, olderIdle) : oldestActive) - 600;
      out.data = { newest: iso(newest), oldestFound: iso(oldest), hoursFound: Math.round((newest - oldest) / 360) / 10, probes };
      if (now - newest > 3600) out.warnings.push(`no requests in the last hour — the system is idle or no longer instrumented; the newest traffic is around ${iso(newest)}`);
      if (active.length < LOOKBACKS_H.filter((x) => now - x * 3600 >= oldest).length) out.warnings.push('traffic comes and goes inside the window (idle stretches between busy ones)');
    } else out.warnings.push(`${m} shows no requests in the last 30 days`);
  }
  return out;
}

/** exact match, else a name containing the other ("shop-frontend" ↔ "frontend") */
export function suggestRenames(probe: PrometheusProbe, traceServices: string[] = []): Record<string, string> {
  const canonical = new Set([...(probe.services['otel-spanmetrics'] ?? []), ...(probe.services['http-server'] ?? []), ...traceServices]);
  const out: Record<string, string> = {};
  for (const preset of ['cadvisor', 'kubernetes']) {
    const containers = new Set(probe.services[preset] ?? []);
    for (const raw of containers) {
      if (canonical.has(raw)) continue;
      // "customer-lb" next to a "customer" container is a different component, not a spelling of it
      const hits = [...canonical].filter((c) => !containers.has(c) && (raw.endsWith(`-${c}`) || raw.startsWith(`${c}-`) || raw.endsWith(`_${c}`)));
      if (hits.length === 1) out[raw] = hits[0];
    }
  }
  return out;
}

/** entry-service requests per slice of [start, end]: where the traffic was, so traces are fetched
 *  where there is something to see (a quiet week with one busy hour gets its traces in that hour) */
export async function trafficBySlice(cfg: NonNullable<Sources['prometheus']>, presets: string[], entry: string[], start: number, end: number, slices: number): Promise<number[] | null> {
  const width = Math.max(60, Math.floor((end - start) / slices));
  const m = entry.map((e) => e.replace(/[.*+?^${}()|[\]\\"]/g, '\\\\$&')).join('|');
  const sel = [cfg.selector, `service_name=~"${m}"`].filter(Boolean).join(',');
  const query = presets.includes('otel-spanmetrics') ? `sum(increase(traces_span_metrics_calls_total{span_kind="SPAN_KIND_SERVER",${sel}}[${width}s]))` : presets.includes('http-server') ? `sum(increase(http_server_request_duration_seconds_count{${sel}}[${width}s]))` : null;
  if (!query) return null;
  const u = new URL('api/v1/query_range', cfg.url.endsWith('/') ? cfg.url : cfg.url + '/');
  // each point counts the slice that ends at it
  u.searchParams.set('query', query);
  u.searchParams.set('start', String(start + width));
  u.searchParams.set('end', String(start + width * slices));
  u.searchParams.set('step', `${width}s`);
  const r = await getJson<PromResp<{ result: { values: [number, string][] }[] }>>(u.toString(), authHeaders(cfg));
  const out = new Array(slices).fill(0);
  for (const [t, v] of r.data?.result?.[0]?.values ?? []) {
    const k = Math.round((Number(t) - start) / width) - 1;
    if (k >= 0 && k < slices && isFinite(Number(v))) out[k] = Number(v);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// traces

export interface TraceProbe {
  kind: 'jaeger' | 'tempo';
  url: string;
  ok: boolean;
  services: string[];
  /** services requests enter through (root SERVER spans in a small sample) */
  entry: string[];
  /** services that only ever start traces as clients (load generators, synthetic monitors) */
  clientsOnly: string[];
  edges: string[];
  warnings: string[];
}

/** entry services, client-only services and the call edges of a set of spans */
export function shapeOf(spans: Span[]): { entry: string[]; clientsOnly: string[]; edges: string[] } {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const server = new Set<string>();
  const roots = new Set<string>();
  const edges = new Set<string>();
  const entry = new Set<string>();
  for (const s of spans) {
    if (s.kind === 'server' || s.kind === 'consumer') server.add(s.service);
    if (!s.parentId || !byId.has(s.parentId)) roots.add(s.service);
  }
  // services that start traces and never serve: load generators, synthetic monitors. (An
  // uninstrumented database seen through CLIENT spans has a parent, so it stays.)
  const clientsOnly = [...roots].filter((s) => !server.has(s));
  for (const s of spans) {
    const p = s.parentId ? byId.get(s.parentId) : undefined;
    if (p && p.service !== s.service) edges.add(`${p.service} → ${s.service}`);
    if (s.kind !== 'server') continue;
    // a root SERVER span, or one whose caller is outside the system (a load generator's client span)
    if (!p || clientsOnly.includes(p.service)) entry.add(s.service);
  }
  return { entry: [...entry].sort(), clientsOnly: clientsOnly.sort(), edges: [...edges].sort() };
}

type JaegerTraces = { data: { traceID: string; spans: unknown[]; processes: Record<string, unknown> }[] };

const jaegerTraces = (url: string, h: Record<string, string>, q: Record<string, string>) => {
  const u = new URL('api/traces', url.endsWith('/') ? url : url + '/');
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return getJson<JaegerTraces>(u.toString(), h, 60_000);
};

export async function probeJaeger(cfg: NonNullable<Sources['jaeger']>, now = Date.now() / 1000): Promise<TraceProbe> {
  const h = authHeaders(cfg);
  const out: TraceProbe = { kind: 'jaeger', url: cfg.url, ok: false, services: [], entry: [], clientsOnly: [], edges: [], warnings: [] };
  const s = await getJson<{ data: string[] | null }>(new URL('api/services', cfg.url.endsWith('/') ? cfg.url : cfg.url + '/').toString(), h, 10_000);
  out.ok = true;
  out.services = (s.data ?? []).filter((x) => !x.startsWith('jaeger')).sort();
  if (!out.services.length) out.warnings.push('Jaeger knows no services yet');
  const spans: Span[] = [];
  for (const svc of out.services.slice(0, 25)) {
    const r = await jaegerTraces(cfg.url, h, { service: svc, limit: '20', start: String(Math.floor((now - 7 * 86400) * 1e6)), end: String(Math.floor(now * 1e6)) });
    parseJaeger(r, spans);
  }
  Object.assign(out, shapeOf(spans));
  if (!spans.length) out.warnings.push('no traces in the last 7 days');
  return out;
}

type TempoSearch = { traces?: { traceID: string; rootServiceName?: string; startTimeUnixNano?: string }[] };

const tempoUrl = (base: string, path: string, q: Record<string, string> = {}) => {
  const u = new URL(path, base.endsWith('/') ? base : base + '/');
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return u.toString();
};

export async function probeTempo(cfg: NonNullable<Sources['tempo']>, now = Date.now() / 1000): Promise<TraceProbe> {
  const h = authHeaders(cfg);
  const out: TraceProbe = { kind: 'tempo', url: cfg.url, ok: false, services: [], entry: [], clientsOnly: [], edges: [], warnings: [] };
  const v = await getJson<{ tagValues?: string[] | { value: string }[] }>(tempoUrl(cfg.url, 'api/search/tag/service.name/values'), h, 10_000);
  out.ok = true;
  out.services = (v.tagValues ?? []).map((x) => (typeof x === 'string' ? x : x.value)).sort();
  const spans: Span[] = [];
  // Tempo refuses searches longer than its max (168 h by default): sample the last day
  const ids = await tempoSearch(cfg.url, h, now - 86400, now, 40);
  for (const id of ids.slice(0, 40)) parseOtlp(await getJson(tempoUrl(cfg.url, `api/traces/${id}`), { ...h, Accept: 'application/json' }), spans);
  Object.assign(out, shapeOf(spans));
  if (!spans.length) out.warnings.push('no traces in the last 24 hours');
  return out;
}

async function tempoSearch(url: string, h: Record<string, string>, start: number, end: number, limit: number, service?: string): Promise<string[]> {
  const q: Record<string, string> = { start: String(Math.floor(start)), end: String(Math.ceil(end)), limit: String(limit) };
  if (service) q.q = `{ resource.service.name = "${service}" }`;
  const r = await getJson<TempoSearch>(tempoUrl(url, 'api/search', q), h, 60_000);
  return (r.traces ?? []).map((t) => t.traceID);
}

/**
 * Traces over [start, end], spread evenly: the window is cut into slices and each slice asks for
 * its share, so every part of the history (quiet nights and the overload) is represented.
 * Returns the traces as one Jaeger or OTLP document per line.
 */
export async function fetchTraces(src: { jaeger?: Sources['jaeger']; tempo?: Sources['tempo'] }, entry: string[], start: number, end: number, opts: { maxTraces?: number; slices?: number; weights?: number[] | null } = {}): Promise<{ lines: string[]; traces: number; requests: number; kind: 'jaeger' | 'tempo' }> {
  const max = opts.maxTraces ?? 3000;
  const slices = opts.weights?.length ?? Math.max(1, Math.min(opts.slices ?? 48, Math.floor((end - start) / 60)));
  // traces per slice: by traffic when known (idle slices get none), evenly otherwise
  const w = opts.weights && opts.weights.some((x) => x > 0) ? opts.weights : new Array(slices).fill(1);
  const total = w.reduce((a, x) => a + x, 0);
  const quota = w.map((x) => (x > 0 ? Math.max(2, Math.ceil((max * x) / total / Math.max(1, entry.length))) : 0));
  const seen = new Set<string>();
  const lines: string[] = [];
  let requests = 0;
  if (src.jaeger) {
    const h = authHeaders(src.jaeger);
    for (let k = 0; k < slices; k++) {
      const s = start + ((end - start) * k) / slices;
      const e = start + ((end - start) * (k + 1)) / slices;
      if (!quota[k]) continue;
      for (const svc of entry) {
        requests++;
        const r = await jaegerTraces(src.jaeger.url, h, { service: svc, limit: String(quota[k]), start: String(Math.floor(s * 1e6)), end: String(Math.floor(e * 1e6)) });
        const fresh = (r.data ?? []).filter((t) => !seen.has(t.traceID));
        for (const t of fresh) seen.add(t.traceID);
        if (fresh.length) lines.push(JSON.stringify({ data: fresh }));
      }
    }
    return { lines, traces: seen.size, requests, kind: 'jaeger' };
  }
  if (src.tempo) {
    const h = authHeaders(src.tempo);
    const ids: string[] = [];
    for (let k = 0; k < slices; k++) {
      const s = start + ((end - start) * k) / slices;
      const e = start + ((end - start) * (k + 1)) / slices;
      if (!quota[k]) continue;
      for (const svc of entry) {
        requests++;
        for (const id of await tempoSearch(src.tempo.url, h, s, e, quota[k], svc)) if (!seen.has(id)) seen.add(id), ids.push(id);
      }
    }
    // fetch whole traces, a few at a time
    for (let i = 0; i < ids.length; i += 8) {
      const batch = await Promise.all(ids.slice(i, i + 8).map((id) => getJson(tempoUrl(src.tempo!.url, `api/traces/${id}`), { ...h, Accept: 'application/json' })));
      requests += batch.length;
      for (const doc of batch) lines.push(JSON.stringify(doc));
    }
    return { lines, traces: ids.length, requests, kind: 'tempo' };
  }
  throw new Error('no trace source: connect Jaeger or Tempo, or give trace files');
}
