import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { stringify as toYaml } from 'yaml';
import { importBundle } from '../src/backtest/import/manifest';
import { exportPlan, manifestMetrics, podsByNodeQuery, runExport, zoneOfProviderId } from '../src/backtest/import/promExport';
import { parseTraceFile, parseTraceLines, templatePath, type Span } from '../src/backtest/import/traces';
import type { Dataset } from '../src/backtest/dataset';
import { fileAccess, glob, readLines } from '../cli/files';
import { fetchTraces, probeJaeger, probePrometheus, probeTempo, shapeOf, trafficBySlice } from './sources';
import { authHeaders, iso, seconds, Workspace } from './workspace';

/**
 * One collection: query Prometheus over a window, fetch traces spread over the same window, add the
 * bill if there is one, write the import manifest and import it into `dataset.json`. What each
 * service ended up with is reported, so an agent can see what the model will and won't know.
 */

export interface CollectOptions {
  /** how much history: "6h", "14d" (default 24h, or what the data covers) */
  last?: string;
  start?: string | number;
  end?: string | number;
  /** bucket size, seconds (default: the window / ~1000, at least 30 s) */
  stepS?: number;
  maxTraces?: number;
  /** several windows instead of one — an ordinary week plus last month's load test, say: the
   *  model learns from all of them, and the gaps between them stay empty */
  windows?: { start: string | number; end: string | number }[];
}

const STEPS = [30, 60, 120, 300, 600, 900, 1800, 3600];
// (2880 buckets a day at 30 s; 20,160 at 60 s is two weeks)

const toEpoch = (v: string | number) => (typeof v === 'number' ? (v > 1e12 ? v / 1000 : v) : Date.parse(v) / 1000);

export interface Coverage {
  service: string;
  has: string[];
  missing: string[];
  /** share of buckets with a request rate */
  filled: number;
}

export async function collect(ws: Workspace, o: CollectOptions = {}, progress?: (m: string, d: number, t: number) => Promise<void>) {
  const say = (m: string, k: number) => progress?.(m, k, 4) ?? Promise.resolve();
  const src = ws.sources();
  if (!src.prometheus) throw new Error('no Prometheus connected — call connect_telemetry with prometheus.url first');
  const warnings: string[] = [];
  const now = Date.now() / 1000;
  const probe = await probePrometheus(src.prometheus, now);
  if (!probe.presets.length) throw new Error(`Prometheus at ${src.prometheus.url} has none of the metrics the presets read. ${probe.nearMisses.join(' ')}`);
  const presets = src.prometheus.presets?.length ? src.prometheus.presets : probe.presets;

  // ---- window and step
  const windows = o.windows?.length ? o.windows.map((w) => ({ start: toEpoch(w.start), end: toEpoch(w.end) })).sort((a, b) => a.start - b.start) : null;
  if (windows) for (const w of windows) if (!(w.end > w.start)) throw new Error(`empty window ${iso(w.start)} … ${iso(w.end)}`);
  let end = windows ? windows[windows.length - 1].end : o.end !== undefined ? toEpoch(o.end) : now;
  if (!windows && o.end === undefined && probe.data && Date.parse(probe.data.newest) / 1000 < now - 3600) {
    end = Date.parse(probe.data.newest) / 1000;
    warnings.push(`no request metrics in the last hour: the window ends at the newest data, ${iso(end)}`);
  }
  let start = windows ? windows[0].start : o.start !== undefined ? toEpoch(o.start) : end - seconds(o.last ?? '24h');
  if (!windows && o.start === undefined && !o.last && probe.data) start = Math.max(start, Date.parse(probe.data.oldestFound) / 1000);
  if (!(end > start)) throw new Error(`empty window ${iso(start)} … ${iso(end)}`);
  const parts = windows ?? [{ start, end }];
  const covered = parts.reduce((a, w) => a + w.end - w.start, 0);
  // fine buckets: a three-minute overload is the most valuable part of a history, and wide buckets
  // average it away. 30 s up to a day, 60 s up to two weeks, then whatever keeps ~20k buckets
  const stepS = o.stepS ?? STEPS.find((s) => (end - start) / s <= 20_160) ?? 3600;
  const rateWindow = `${Math.max(60, stepS)}s`;

  await say(windows ? `${windows.length} windows, ${iso(start)} … ${iso(end)}, in ${stepS} s buckets` : `window ${iso(start)} … ${iso(end)} in ${stepS} s buckets`, 0);
  // ---- traces first: they say which services requests enter through
  const tel = ws.path('telemetry');
  rmSync(tel, { recursive: true, force: true });
  ws.ensure('telemetry', 'metrics');
  ws.ensure('telemetry', 'traces');
  let traceFiles: string[] = [];
  let traceNote = '';
  let entry = src.system.entry;
  let ignore = src.system.ignore;
  if (src.jaeger || src.tempo) {
    const kind = src.jaeger ? 'jaeger' : 'tempo';
    if (!entry?.length) {
      // a small sample of recent traces says which services requests enter through
      const shape = src.jaeger ? await probeJaeger(src.jaeger, end) : await probeTempo(src.tempo!, end);
      entry = shape.entry;
      ignore ??= shape.clientsOnly;
    }
    if (!entry?.length) throw new Error(`could not tell which services requests enter through from ${kind}: give system.entry in connect_telemetry`);
    await say('fetching traces', 1);
    // spread the traces by where the traffic was: 96 slices, weighted by entry requests
    // at least a minute per slice: the weights and the fetches must cut the window the same way
    let traces = 0;
    let requests = 0;
    for (const [k, w] of parts.entries()) {
      const slices = Math.max(1, Math.min(96, Math.floor((w.end - w.start) / 60)));
      const weights = await trafficBySlice(src.prometheus, presets, entry, w.start, w.end, slices).catch(() => null);
      // each window gets traces in proportion to its length
      const got = await fetchTraces(src, entry, w.start, w.end, { maxTraces: Math.max(50, Math.round(((o.maxTraces ?? 3000) * (w.end - w.start)) / covered)), weights, slices });
      const f = join(tel, 'traces', parts.length > 1 ? `${kind}-w${k}.jsonl` : `${kind}.jsonl`);
      writeFileSync(f, got.lines.join('\n') + '\n');
      traceFiles.push(f);
      traces += got.traces;
      requests += got.requests;
    }
    traceNote = `${traces.toLocaleString('en-US')} traces from ${kind} through ${entry.join(', ')} (${requests} requests)`;
    if (traces < 50) warnings.push(`only ${traces} traces in the window — topology and self times rest on few requests`);
  } else if (src.traceFiles?.length) {
    traceFiles = src.traceFiles.flatMap((p) => glob(p)).map((p) => resolve(p));
    if (!traceFiles.length) throw new Error(`no trace files match ${src.traceFiles.join(', ')}`);
    if (!entry?.length || !ignore) {
      const spans: Span[] = [];
      for (const f of traceFiles.slice(0, 3)) {
        if (/\.(jsonl|ndjson)$/.test(f)) {
          let n = 0;
          for (const line of readLines(f)) {
            if (n++ > 2000) break;
            if (line.trim()) parseTraceLines([line], spans);
          }
        } else parseTraceFile(readFileSync(f, 'utf8'), spans);
      }
      const shape = shapeOf(spans);
      entry ??= shape.entry;
      ignore ??= shape.clientsOnly;
    }
    traceNote = `${traceFiles.length} trace file(s)`;
  } else warnings.push('no traces: without them the model has no topology (which service calls which). Connect Jaeger or Tempo, or give trace files');

  // ---- metrics
  await say('querying Prometheus', 2);
  const plan = exportPlan(presets, { window: rateWindow, selector: src.prometheus.selector, entry, namespaces: src.prometheus.namespaces });
  // one directory per window when there are several; the manifest globs across them
  const dirOf = (k: number) => (parts.length > 1 ? join(tel, 'metrics', `w${k}`) : join(tel, 'metrics'));
  const exported: { file: string; series: number }[] = [];
  for (const [k, w] of parts.entries()) {
    mkdirSync(dirOf(k), { recursive: true });
    const got = await runExport(src.prometheus.url, plan, { start: w.start, end: w.end, stepS }, (file, body) => writeFileSync(join(dirOf(k), file), body), authHeaders(src.prometheus));
    for (const g of got) {
      const e = exported.find((x) => x.file === g.file);
      if (e) e.series = Math.max(e.series, g.series);
      else exported.push({ ...g });
    }
  }
  const empty = exported.filter((e) => !e.series).map((e) => e.file);
  const endpointSeries = exported.some((e) => /endpoint-rps/.test(e.file) && e.series > 0);
  if (!endpointSeries && entry?.length) warnings.push(`no endpoint-level request metrics for ${entry.join(', ')}: endpoint rates come from the traces, scaled by the measured sampling share`);

  // span names that carry raw URLs ("GET /api/cart?sessionId=…") make a series per session and per
  // id: each one sparse, and latency quantiles over sparse series are noise (on the Kubernetes
  // reference, a cart p99 of 1.4 s where clients measured 50 ms). Their counts still add up; their
  // latency does not — endpoint latency then comes from the traces' call paths
  let rawUrls: string | null = null;
  const epRps = plan.find((p) => /endpoint-rps\.json$/.test(p.query.file));
  if (epRps) {
    try {
      const doc = JSON.parse(readFileSync(join(dirOf(0), epRps.query.file), 'utf8')) as { data?: { result?: { metric: Record<string, string> }[] } };
      // templatePath reads "<METHOD> <path>"; the service goes in front of the result
      const names = (doc.data?.result ?? []).map((r) => ({ svc: r.metric.service_name ?? '', name: r.metric.span_name ?? r.metric.http_route ?? '' }));
      const templates = new Set(names.map((n) => `${n.svc} ${templatePath(n.name)}`));
      if (names.length >= 30 && names.length >= 3 * templates.size) rawUrls = `${names.length} span-name series for ${templates.size} endpoints`;
    } catch {
      /* no endpoint series */
    }
  }
  const metricsPlan = rawUrls ? plan.filter((p) => !/endpoint-(latency|mean|p50|p99)\.json$/.test(p.query.file)) : plan;
  if (rawUrls) warnings.push(`span names on ${entry?.join(', ')} carry raw URLs (${rawUrls}): per-endpoint latency from span metrics is unusable, so it comes from the traces' call paths instead. Naming server spans by route (http.route) fixes it at the source`);

  // ---- manifest
  const rel = (p: string) => (isAbsolute(p) ? relative(tel, p) : p);
  const manifest = {
    name: src.system.name,
    step: `${stepS}s`,
    ...(src.system.rename && Object.keys(src.system.rename).length ? { rename: src.system.rename } : {}),
    metrics: manifestMetrics(metricsPlan, parts.length > 1 ? 'metrics/*' : 'metrics'),
    traces: traceFiles.length
      ? [{ file: traceFiles.length === 1 ? rel(traceFiles[0]) : rel(traceFiles[0]).replace(/[^/]+$/, '*'), ...(ignore?.length ? { ignore } : {}), series: { rps: false, latency: false, endpoints: !endpointSeries } }]
      : [],
    billing: src.bill?.cur ? [{ cur: resolve(src.bill.cur), ...(src.bill.tag ? { tag: src.bill.tag } : {}), ...(src.bill.resources ? { resources: src.bill.resources } : {}) }] : src.bill?.gcp ? [{ gcp: resolve(src.bill.gcp), ...(src.bill.tag ? { tag: src.bill.tag } : {}) }] : [],
    ...(src.system.placement ? { placement: src.system.placement } : {}),
    model: {
      ...(src.system.slo ? { slo: src.system.slo } : {}),
      ...(src.system.timeoutMs ? { timeoutMs: src.system.timeoutMs } : {}),
      ...(src.system.hostedBy ? { hostedBy: src.system.hostedBy } : {}),
    },
  };
  const manifestPath = join(tel, 'hindcast.import.yaml');
  writeFileSync(manifestPath, `# Written by Hindcast collect_telemetry, ${iso(now)}: ${parts.map((w) => `${iso(w.start)} … ${iso(w.end)}`).join(', ')}\n` + toYaml(manifest));

  // ---- import
  await say('importing', 3);
  const { dataset, log } = importBundle(manifest, fileAccess(manifestPath));
  for (const id of src.system.exclude ?? []) {
    delete dataset.services[id];
    if (dataset.bill) delete dataset.bill.components[id];
    for (const [eid, e] of Object.entries(dataset.endpoints)) if (e.service === id) delete dataset.endpoints[eid];
  }
  // Kubernetes: which node each replica ran on at the end of the window
  if (presets.includes('kubernetes')) {
    try {
      const u = `${src.prometheus.url.replace(/\/$/, '')}/api/v1/query?query=${encodeURIComponent(podsByNodeQuery(src.prometheus.namespaces))}&time=${end}`;
      const j = (await (await fetch(u, { headers: authHeaders(src.prometheus) })).json()) as { data?: { result?: { metric: Record<string, string>; value: [number, string] }[] } };
      const by: Record<string, Record<string, number>> = {};
      for (const r of j.data?.result ?? []) {
        const id = src.system.rename?.[r.metric.workload] ?? r.metric.workload;
        if (!dataset.services[id]) continue;
        (by[id] ??= {})[r.metric.node] = Number(r.value[1]);
      }
      if (Object.keys(by).length) dataset.podsByNode = by;
      // the zone of each node, from its provider id (AWS and GCP put it there); without it only
      // zone loss is unavailable
      const ni = await (async () => {
        try {
          return (await (await fetch(`${src.prometheus!.url.replace(/\/$/, '')}/api/v1/query?query=${encodeURIComponent('kube_node_info')}&time=${end}`, { headers: authHeaders(src.prometheus) })).json()) as { data?: { result?: { metric: Record<string, string> }[] } };
        } catch {
          return { data: { result: [] } };
        }
      })();
      const zones: Record<string, string> = {};
      for (const r of ni.data?.result ?? []) {
        const z = zoneOfProviderId(r.metric.provider_id);
        if (z && r.metric.node) zones[r.metric.node] = z;
      }
      if (Object.keys(zones).length) dataset.nodeZones = zones;
      // HorizontalPodAutoscalers, by the workload they scale
      const hpa = await hpaSpecs(src.prometheus!.url, authHeaders(src.prometheus), end, src.prometheus!.namespaces);
      for (const id of Object.keys(hpa)) if (!dataset.services[src.system.rename?.[id] ?? id]) delete hpa[id];
      if (Object.keys(hpa).length) dataset.hpa = Object.fromEntries(Object.entries(hpa).map(([k, v]) => [src.system.rename?.[k] ?? k, v]));
    } catch {
      warnings.push('could not read which node each pod runs on (kube_pod_info): node-loss checks are unavailable');
    }
  }
  // services the metrics name but no trace touches: another system on the same Prometheus, or a
  // component nothing traces (a load balancer, a database seen only through its container)
  if (dataset.topology) {
    const traced = new Set([...Object.keys(dataset.topology.services), ...Object.keys(src.system.hostedBy ?? {})]);
    const named = new Set(dataset.topology.edges.flatMap((e) => [e.from, e.to]));
    const loose = Object.keys(dataset.services).filter((id) => !traced.has(id) && !named.has(id));
    // traced but without a container of its own: a managed service outside the cluster, or a library
    // inside its caller's process (then it scales with the caller: system.hostedBy)
    for (const [id, shape] of Object.entries(dataset.topology.services)) {
      if (src.system.hostedBy?.[id] || dataset.services[id]?.cpuCores?.some((v) => v !== null)) continue;
      const callers = [...new Set(dataset.topology.edges.filter((e) => e.to === id).map((e) => e.from))];
      if (callers.length === 1 && shape.kind !== 'server') warnings.push(`${id} (${shape.kind}) is traced but has no container metrics: a managed service, or running inside ${callers[0]}'s process. If it runs inside ${callers[0]}, connect_telemetry with system.hostedBy { "${id}": "${callers[0]}" } so it scales with it`);
    }
    if (loose.length) warnings.push(`in the metrics but in no trace: ${loose.join(', ')}. If they belong to another system, connect_telemetry with system.exclude; if they are part of this one (load balancers, databases), they are priced but not modelled for latency`);
  }
  ws.writeJson('dataset.json', dataset, false);
  // the model fitted on an older dataset no longer matches it
  rmSync(ws.path('model.json'), { force: true });
  rmSync(ws.path('calibration.json'), { force: true });
  src.system.entry = entry;
  if (ignore?.length) src.system.ignore = ignore;
  ws.saveSources(src);

  const coverage = coverageOf(dataset);
  for (const c of coverage) {
    if (c.missing.includes('cpuLimitCores') && c.has.includes('cpuCores')) warnings.push(`${c.service}: CPU use but no CPU limit — capacity can't come from CPU, and resize strategies can't be priced`);
  }
  if (!dataset.bill) warnings.push('no bill: calibrate_model prices services at AWS Fargate list prices from their CPU and memory limits');
  return {
    window: { start: iso(dataset.start), end: iso(dataset.start + dataset.n * dataset.stepS), stepS: dataset.stepS, buckets: dataset.n, hours: Math.round((dataset.n * dataset.stepS) / 360) / 10 },
    presets,
    entry,
    ignored: ignore ?? [],
    traces: traceNote || null,
    services: Object.keys(dataset.services).length,
    endpoints: Object.keys(dataset.endpoints),
    coverage,
    emptyQueries: empty,
    imported: log.map((l) => `${l.what}${l.points !== undefined ? ` (${l.points.toLocaleString('en-US')} points)` : ''}`),
    bill: dataset.bill ? `$${dataset.bill.total.toFixed(2)} over the bill window` : null,
    warnings,
    files: { manifest: manifestPath, dataset: ws.path('dataset.json') },
    next: 'calibrate_model',
  };
}

const KEY_METRICS = ['rps', 'errorRate', 'p99Ms', 'cpuCores', 'cpuLimitCores', 'replicas', 'memoryBytes'];

export function coverageOf(d: Dataset): Coverage[] {
  const virtual = new Set(Object.entries(d.topology?.services ?? {}).filter(([, s]) => s.kind !== 'server').map(([id]) => id));
  return Object.entries(d.services).map(([id, s]) => {
    const rec = s as Record<string, (number | null)[] | undefined>;
    const has = KEY_METRICS.filter((m) => rec[m]?.some((v) => v !== null));
    const rps = rec.rps ?? [];
    return {
      service: id,
      has: [...has, ...(d.topology?.services[id] ? ['traces'] : [])],
      missing: virtual.has(id) ? [] : KEY_METRICS.filter((m) => !has.includes(m)),
      filled: rps.length ? Math.round((rps.filter((v) => v !== null).length / rps.length) * 100) / 100 : 0,
    };
  });
}

/** the HorizontalPodAutoscalers kube-state-metrics knows at one instant, by the workload they scale */
export async function hpaSpecs(url: string, headers: Record<string, string>, at: number, namespaces?: string[]) {
  const ns = namespaces?.length ? `{namespace=~"${namespaces.join('|')}"}` : '';
  const q = async (expr: string) => {
    try {
      const j = (await (await fetch(`${url.replace(/\/$/, '')}/api/v1/query?query=${encodeURIComponent(expr)}&time=${at}`, { headers })).json()) as { data?: { result?: { metric: Record<string, string>; value: [number, string] }[] } };
      return j.data?.result ?? [];
    } catch {
      return [];
    }
  };
  const key = (m: Record<string, string>) => `${m.namespace}/${m.horizontalpodautoscaler}`;
  const target = new Map((await q(`kube_horizontalpodautoscaler_info${ns}`)).map((r) => [key(r.metric), r.metric.scaletargetref_name]));
  const min = new Map((await q(`kube_horizontalpodautoscaler_spec_min_replicas${ns}`)).map((r) => [key(r.metric), Number(r.value[1])]));
  const max = new Map((await q(`kube_horizontalpodautoscaler_spec_max_replicas${ns}`)).map((r) => [key(r.metric), Number(r.value[1])]));
  const cpu = new Map((await q(`kube_horizontalpodautoscaler_spec_target_metric${ns ? ns.replace('}', ',metric_name="cpu",metric_target_type="utilization"}') : '{metric_name="cpu",metric_target_type="utilization"}'}`)).map((r) => [key(r.metric), Number(r.value[1])]));
  const out: Record<string, { min: number; max: number; targetCpu?: number }> = {};
  for (const [k, w] of target) if (w && max.has(k)) out[w] = { min: min.get(k) ?? 1, max: max.get(k)!, ...(cpu.has(k) ? { targetCpu: cpu.get(k)! / 100 } : {}) };
  return out;
}
