import { describe, expect, it } from 'vitest';
import { DatasetBuilder, regrid, sliceDataset, type Dataset } from '../src/backtest/dataset';
import { bucketQuantile, importCloudWatch, importLongCsv, importPrometheus, importWideCsv } from '../src/backtest/import/metrics';
import { buildTopology, parseTraceFile, type Span } from '../src/backtest/import/traces';
import { parseCur, parseGcpBilling, summariseBill } from '../src/backtest/import/billing';
import { parseCsv } from '../src/backtest/import/csv';
import { importBundle } from '../src/backtest/import/manifest';
import { exportPlan } from '../src/backtest/import/promExport';
import { erlangC, mmcWait } from '../src/backtest/queueing';
import { calibrate, trafficOf } from '../src/backtest/calibrate';
import { basePlan, runPlan } from '../src/backtest/engine';
import { applyStrategy } from '../src/backtest/strategy';
import { backtest } from '../src/backtest/backtest';
import type { Model } from '../src/backtest/model';

const T0 = 1_790_000_000;

describe('importers', () => {
  it('parses quoted CSV', () => {
    expect(parseCsv('a,b\n"x, y","he said ""hi"""\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'he said "hi"'],
    ]);
  });

  it('reads a Prometheus query_range matrix with unit conversion', () => {
    const b = new DatasetBuilder();
    const json = { status: 'success', data: { resultType: 'matrix', result: [{ metric: { service_name: 'api' }, values: [[T0, '0.120'], [T0 + 60, '0.240'], [T0 + 120, 'NaN']] }] } };
    expect(importPrometheus(b, json, { metric: 'p99Ms', by: 'service_name', unit: 's' })).toBe(2);
    const d = b.build({ name: 't' });
    expect(d.stepS).toBe(60);
    expect(d.services.api.p99Ms).toEqual([120, 240]);
  });

  it('reads endpoint series from Prometheus labels', () => {
    const b = new DatasetBuilder();
    importPrometheus(b, { data: { result: [{ metric: { service_name: 'api', http_route: '/orders', http_request_method: 'POST' }, values: [[T0, '5']] }] } }, { metric: 'rps', by: 'service_name', endpointBy: 'http_route', methodBy: 'http_request_method' });
    expect(b.build({ name: 't' }).endpoints['POST /orders']).toMatchObject({ service: 'api', rps: [5] });
  });

  it('reads CloudWatch GetMetricData (sum per period → req/s)', () => {
    const b = new DatasetBuilder();
    const json = { MetricDataResults: [{ Id: 'req', Label: 'api RequestCount', Timestamps: ['2026-09-14T12:01:00Z', '2026-09-14T12:00:00Z'], Values: [1200, 600], StatusCode: 'Complete' }, { Id: 'api__cpuPercent', Timestamps: ['2026-09-14T12:00:00Z'], Values: [50] }] };
    importCloudWatch(b, json, { req: { service: 'api', metric: 'rps', unit: 'count-per-period' } });
    const d = b.build({ name: 't' });
    expect(d.services.api.rps).toEqual([10, 20]);
    expect(d.services.api.cpuCores?.[0]).toBe(0.5);
  });

  it('reads long and wide CSV', () => {
    const b = new DatasetBuilder();
    importLongCsv(b, 'timestamp,service,metric,value\n2026-09-14T12:00:00Z,api,rps,12\n2026-09-14T12:01:00Z,api,rps,14\n');
    importWideCsv(b, 'time,api p99,db cpu\n2026-09-14T12:00:00Z,0.2,40\n2026-09-14T12:01:00Z,0.3,60\n', { 'api p99': { metric: 'p99Ms', service: 'api', unit: 's' }, 'db cpu': { metric: 'cpuPercent', service: 'db', scale: 2 } });
    const d = b.build({ name: 't' });
    expect(d.services.api.rps).toEqual([12, 14]);
    expect(d.services.api.p99Ms).toEqual([200, 300]);
    expect(d.services.db.cpuCores).toEqual([0.8, 1.2]);
  });

  const span = (traceId: string, spanId: string, parent: string | null, name: string, kind: number, start: number, end: number, attrs: Record<string, string | number> = {}) => ({
    traceId,
    spanId,
    ...(parent ? { parentSpanId: parent } : {}),
    name,
    kind,
    startTimeUnixNano: String(BigInt(Math.round(start * 1e6))),
    endTimeUnixNano: String(BigInt(Math.round(end * 1e6))),
    attributes: Object.entries(attrs).map(([key, v]) => ({ key, value: typeof v === 'number' ? { intValue: String(v) } : { stringValue: v } })),
  });
  const rs = (service: string, spans: unknown[]) => ({ resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] }, scopeSpans: [{ spans }] });
  const ms = T0 * 1000;
  // web → api (server) → db (uninstrumented client span), and api → cache twice in parallel
  const traceDoc = (id: string, t: number) =>
    JSON.stringify({
      resourceSpans: [
        rs('web', [span(id, 'a1', null, 'GET /checkout', 2, t, t + 100, { 'http.route': '/checkout', 'http.request.method': 'GET', 'http.response.body.size': 2000 }), span(id, 'a2', 'a1', 'POST', 3, t + 5, t + 95)]),
        rs('api', [
          span(id, 'b1', 'a2', 'POST /pay', 2, t + 10, t + 90, { 'http.request.body.size': 300 }),
          span(id, 'b2', 'b1', 'SELECT', 3, t + 20, t + 60, { 'db.system': 'postgresql', 'peer.service': 'orders-db' }),
          span(id, 'b3', 'b1', 'GET', 3, t + 62, t + 70, { 'db.system': 'redis' }),
          span(id, 'b4', 'b1', 'GET', 3, t + 62, t + 72, { 'db.system': 'redis' }),
        ]),
      ],
    });

  it('builds topology, critical path and payloads from OTLP traces', () => {
    const spans = parseTraceFile([traceDoc('t1', ms), traceDoc('t2', ms + 30_000)].join('\n'));
    const b = new DatasetBuilder();
    const topo = buildTopology(spans, b, { stepS: 60 });
    expect(Object.keys(topo.services).sort()).toEqual(['api', 'orders-db', 'redis', 'web']);
    expect(topo.services['orders-db'].kind).toBe('db');
    expect(topo.services.redis.kind).toBe('cache');
    const ep = topo.endpoints['web GET /checkout'];
    expect(ep.traces).toBe(2);
    expect(ep.visits).toMatchObject({ web: 1, api: 1, 'orders-db': 1, redis: 2 });
    expect(ep.calls['api>redis']).toBe(2);
    // critical path sums to the request duration; only one of the two parallel redis calls is on it
    const cp = Object.values(ep.criticalMs).reduce((a, x) => a + x, 0);
    expect(cp).toBeCloseTo(100, 5);
    expect(ep.criticalMs.redis).toBeCloseTo(10, 5);
    expect(ep.criticalMs['orders-db']).toBeCloseTo(40, 5);
    expect(topo.services.api.selfMeanMs).toBeCloseTo(80 - 40 - 10, 5);
    expect(ep.bytes['web>api']).toBe(300);
    const d = b.build({ name: 't', stepS: 60 });
    expect(d.endpoints['web GET /checkout'].rps?.[0]).toBeCloseTo(2 / 60, 6);
  });

  it('measures the real trace sampling against request metrics and rescales trace-only rates', () => {
    const traces = Array.from({ length: 20 }, (_, k) => traceDoc(`s${k}`, ms + k * 2000)).join('\n');
    // metrics say web served 20 requests in the minute; traces claim sampling 0.5 but hold all 20
    const files: Record<string, string> = { 'rps.json': JSON.stringify({ data: { result: [{ metric: { service_name: 'web' }, values: [[T0, String(20 / 60)]] }] } }), 't.jsonl': traces };
    const { dataset } = importBundle({ name: 's', step: '1m', metrics: [{ prometheus: 'rps.json', metric: 'rps', by: 'service_name' }], traces: [{ file: 't.jsonl', sampling: 0.5 }] }, { read: (p) => files[p], glob: (p) => (files[p] ? [p] : []) });
    expect(dataset.topology!.samplingCheck).toBeCloseTo(2, 5);
    // the database is only seen in traces: 20 calls in the minute, not 40
    expect(dataset.services['orders-db'].rps![0]).toBeCloseTo(20 / 60, 5);
    expect(dataset.services['orders-db'].doneRps![0]).toBeCloseTo(20 / 60, 5);
  });

  it('hangs a span whose parent was dropped under its caller instead of counting a request of its own', () => {
    const sp = (id: string, parent: string | null, service: string, kind: Span['kind'], start: number, end: number, name = 'op'): Span => ({ traceId: 't1', spanId: id, parentId: parent, service, name, kind, start, end, error: false, attrs: {} });
    const spans = [sp('1', null, 'frontend', 'server', 0, 100, 'GET /checkout'), sp('2', '1', 'frontend', 'client', 5, 90), sp('3', '2', 'checkout', 'server', 6, 89), sp('4', 'dropped', 'cart', 'server', 20, 30, 'GetCart')];
    const topo = buildTopology(spans, null, { stepS: 60 });
    expect(Object.keys(topo.endpoints)).toHaveLength(1);
    expect(topo.edges.map((e) => `${e.from}>${e.to}`)).toContain('checkout>cart');
  });

  it('takes the route from a framework span and ignores background roots', () => {
    const t0 = ms;
    const doc = JSON.stringify({
      resourceSpans: [
        rs('frontend', [
          span('n1', 'r', null, 'GET', 2, t0, t0 + 20, { 'http.method': 'GET', 'http.target': '/api/products/HQTGWGPNH4' }),
          span('n1', 'h', 'r', 'GET /api/products/HQTGWGPNH4', 2, t0 + 1, t0 + 19, { 'http.method': 'GET' }),
          span('n1', 'x', 'h', 'executing api route (pages) /api/products/[productId]', 1, t0 + 2, t0 + 18),
          span('n2', 'r2', null, 'GET', 2, t0, t0 + 10, { 'http.method': 'GET', 'http.target': '/api/orders/12345?x=1' }),
          span('n3', 'd', null, 'dns.lookup', 1, t0, t0 + 5),
        ]),
      ],
    });
    const topo = buildTopology(parseTraceFile(doc), null, { stepS: 60 });
    expect(Object.keys(topo.endpoints).sort()).toEqual(['frontend GET /api/orders/{id}', 'frontend GET /api/products/[productId]']);
    // the framework's own SERVER span is part of the same visit
    expect(topo.endpoints['frontend GET /api/products/[productId]'].visits.frontend).toBe(1);
  });

  it('reads Jaeger JSON', () => {
    const doc = { data: [{ traceID: 'x', spans: [{ traceID: 'x', spanID: '1', operationName: 'HTTP GET /dispatch', startTime: T0 * 1e6, duration: 50_000, tags: [{ key: 'span.kind', value: 'server' }], processID: 'p1' }, { traceID: 'x', spanID: '2', operationName: 'SQL SELECT', references: [{ refType: 'CHILD_OF', spanID: '1' }], startTime: T0 * 1e6 + 1000, duration: 30_000, tags: [], processID: 'p2' }], processes: { p1: { serviceName: 'frontend' }, p2: { serviceName: 'mysql' } } }] };
    const topo = buildTopology(parseTraceFile(JSON.stringify(doc)), null, { stepS: 10 });
    expect(topo.endpoints['frontend GET /dispatch'].visits.mysql).toBe(1);
    expect(topo.services.frontend.selfMeanMs).toBeCloseTo(20, 5);
  });

  it('reads AWS CUR (legacy and 2.0) and attributes by tag', () => {
    const legacy = `lineItem/LineItemType,lineItem/UsageStartDate,lineItem/UsageEndDate,lineItem/ProductCode,lineItem/UsageType,lineItem/ResourceId,lineItem/UsageAmount,lineItem/UnblendedCost,product/instanceType,resourceTags/user:service
Usage,2026-09-14T12:00:00Z,2026-09-14T13:00:00Z,AmazonEC2,BoxUsage:m7g.large,i-1,1,0.0816,m7g.large,api
Usage,2026-09-14T12:00:00Z,2026-09-14T13:00:00Z,AWSDataTransfer,USE1-DataTransfer-Out-Bytes,i-1,10,0.9,,api
Usage,2026-09-14T12:00:00Z,2026-09-14T13:00:00Z,AmazonRDS,InstanceUsage:db.r7g.large,db-1,1,0.239,db.r7g.large,
Tax,2026-09-14T12:00:00Z,2026-09-14T13:00:00Z,AmazonEC2,,,,5,,
`;
    const lines = parseCur(legacy, { tag: 'user:service', resources: { 'db-1': 'db' } });
    expect(lines).toHaveLength(3);
    const bill = summariseBill(lines, 'aws-cur');
    expect(bill.components.api.byCategory).toEqual({ compute: 0.0816, transfer: 0.9 });
    expect(bill.components.db.total).toBeCloseTo(0.239);
    const v2 = `line_item_line_item_type,line_item_usage_start_date,line_item_usage_end_date,line_item_usage_type,line_item_resource_id,line_item_usage_amount,line_item_unblended_cost,resource_tags
Usage,2026-09-14T12:00:00Z,2026-09-14T13:00:00Z,BoxUsage:m7g.large,i-2,1,0.0816,"{""user_service"":""web""}"
`;
    expect(parseCur(v2, { tag: 'user:service' })[0].component).toBe('web');
  });

  it('reads the GCP billing export (CSV and JSON lines)', () => {
    const csv = `service.description,sku.description,usage_start_time,usage_end_time,cost,usage.amount,labels\nCompute Engine,C4A Instance Core running in Americas,2026-09-14 12:00:00 UTC,2026-09-14 13:00:00 UTC,0.04,3600,"[{""key"":""app"",""value"":""api""}]"\n`;
    const l = parseGcpBilling(csv, { tag: 'app' });
    expect(l[0]).toMatchObject({ component: 'api', category: 'compute', cost: 0.04 });
    const jl = JSON.stringify({ service: { description: 'Networking' }, sku: { description: 'Network Inter Zone Data Transfer Out' }, usage_start_time: '2026-09-14T12:00:00Z', cost: 0.01, labels: [{ key: 'app', value: 'api' }] });
    expect(parseGcpBilling(jl, { tag: 'app' })[0].category).toBe('transfer');
  });

  it('imports a bundle from a manifest', () => {
    const files: Record<string, string> = {
      'm/rps.json': JSON.stringify({ data: { result: [{ metric: { svc: 'API' }, values: [[T0, '10'], [T0 + 60, '20']] }] } }),
      'm/cpu.csv': 'timestamp,service,metric,value\n' + `${T0},api,cpuCores,0.2\n${T0 + 60},api,cpuCores,0.4\n`,
    };
    const { dataset } = importBundle({ name: 'b', step: '1m', rename: { API: 'api' }, metrics: [{ prometheus: 'm/rps.json', metric: 'rps', by: 'svc' }, { csv: 'm/cpu.csv' }] }, { read: (p) => files[p], glob: (p) => (files[p] ? [p] : []) });
    expect(dataset.services.api.rps).toEqual([10, 20]);
    expect(dataset.services.api.cpuCores).toEqual([0.2, 0.4]);
  });

  it('regrids and slices', () => {
    const b = new DatasetBuilder();
    for (let i = 0; i < 6; i++) b.addService('a', 'rps', T0 + i * 10, i);
    const d = b.build({ name: 't' });
    expect(regrid(d, 30).services.a.rps).toEqual([1, 4]);
    expect(sliceDataset(d, 2, 4).services.a.rps).toEqual([2, 3]);
  });
});

describe('edge metrics (ingress-nginx)', () => {
  const prom = (metric: Record<string, string>, values: [number, string][]) => ({ status: 'success', data: { resultType: 'matrix', result: [{ metric, values }] } });
  it('the edge count replaces span metrics for the same service, and endpoint rates are scaled to it', () => {
    const files: Record<string, unknown> = {
      'spans-rps.json': prom({ service_name: 'frontend' }, [[0, '60'], [60, '60']]),
      'spans-ep.json': { status: 'success', data: { result: [{ metric: { service_name: 'frontend', span_name: 'GET /a' }, values: [[0, '30'], [60, '45']] }, { metric: { service_name: 'frontend', span_name: 'GET /b' }, values: [[0, '30'], [60, '15']] }] } },
      'edge-rps.json': prom({ exported_service: 'frontend' }, [[0, '100'], [60, '120']]),
    };
    const fs = { read: (f: string) => JSON.stringify(files[f]), glob: (p: string) => [p] };
    const { dataset, log } = importBundle(
      {
        name: 'x',
        step: '60s',
        metrics: [
          { prometheus: 'spans-rps.json', metric: 'rps', by: 'service_name' },
          { prometheus: 'spans-ep.json', metric: 'rps', by: 'service_name', endpointBy: 'span_name', template: true },
          { prometheus: 'edge-rps.json', metric: 'rps', by: 'exported_service', edge: true },
        ],
      },
      fs,
    );
    expect(dataset.services.frontend.rps).toEqual([100, 120]);
    // each bucket carries the edge's count, split by the endpoints' shares over neighbouring buckets
    // (75 of 120 span-metric requests went to /a): sparse per-bucket shares are noise
    const a = dataset.endpoints['frontend GET /a'].rps as number[];
    const b = dataset.endpoints['frontend GET /b'].rps as number[];
    expect(a[0] + b[0]).toBeCloseTo(100, 6);
    expect(a[1] + b[1]).toBeCloseTo(120, 6);
    expect(a[0] / 100).toBeCloseTo(75 / 120, 6);
    expect(log.some((l) => /counted 55% of the requests the edge saw/.test(l.what))).toBe(true);
  });
});

describe('Spring Boot (Micrometer) preset', () => {
  it('names services by application tag or scrape job, skips Actuator, and reads per-URI endpoints', () => {
    const plan = exportPlan(['spring'], { window: '1m', entry: ['petclinic'] });
    expect(plan.every((p) => p.query.query.includes('uri!~"/actuator.*"'))).toBe(true);
    expect(plan.some((p) => p.query.file === 'spring-endpoint-latency.json' && p.query.mapping.combine === 'histogram')).toBe(true);
    const prom = (result: unknown[]) => JSON.stringify({ status: 'success', data: { result } });
    const files: Record<string, string> = {
      'rps.json': prom([{ metric: { application: 'petclinic', job: 'petclinic-svc' }, values: [[0, '40']] }, { metric: { job: 'billing' }, values: [[0, '5']] }]),
      'ep.json': prom([{ metric: { application: 'petclinic', job: 'x', uri: '/owners/{ownerId}', method: 'GET' }, values: [[0, '30']] }, { metric: { application: 'petclinic', job: 'x', uri: '/vets', method: 'GET' }, values: [[0, '10']] }]),
    };
    const { dataset } = importBundle({ name: 'x', step: '60s', metrics: [{ prometheus: 'rps.json', metric: 'rps', by: 'application' }, { prometheus: 'ep.json', metric: 'rps', by: 'application', endpointBy: 'uri', methodBy: 'method', template: true }] }, { read: (f: string) => files[f], glob: (p: string) => [p] });
    expect(dataset.services.petclinic.rps).toEqual([40]);
    expect(dataset.services.billing.rps).toEqual([5]);
    expect(Object.keys(dataset.endpoints).sort()).toEqual(['petclinic GET /owners/{ownerId}', 'petclinic GET /vets']);
  });
});

describe('templated endpoint series merged from their parts', () => {
  it('computes p99 from summed buckets, not the worst series, and ratios as Σnum/Σden', () => {
    // 100 fast requests on one session's series, 1 slow one on another: the endpoint's p99 is fast
    const bucket = (span: string, le: string, v: number) => ({ metric: { service_name: 'shop', span_name: span, le }, values: [[0, String(v)]] });
    const hist = { status: 'success', data: { result: [bucket('GET /cart?s=1', '10', 100), bucket('GET /cart?s=1', '1000', 100), bucket('GET /cart?s=1', '+Inf', 100), bucket('GET /cart?s=2', '10', 0), bucket('GET /cart?s=2', '1000', 1), bucket('GET /cart?s=2', '+Inf', 1)] } };
    const b = new DatasetBuilder();
    importPrometheus(b, hist, { metric: 'p99Ms', unit: 'ms', by: 'service_name', endpointBy: 'span_name', template: true, combine: 'histogram' });
    const ratio = { status: 'success', data: { result: [{ metric: { service_name: 'shop', span_name: 'GET /cart?s=1', part: 'num' }, values: [[0, '1']] }, { metric: { service_name: 'shop', span_name: 'GET /cart?s=1', part: 'den' }, values: [[0, '99']] }, { metric: { service_name: 'shop', span_name: 'GET /cart?s=2', part: 'den' }, values: [[0, '1']] }] } };
    importPrometheus(b, ratio, { metric: 'errorRate', unit: 'ratio', by: 'service_name', endpointBy: 'span_name', template: true, combine: 'ratio' });
    const d = b.build({ name: 'x', stepS: 60 });
    const ep = Object.values(d.endpoints)[0];
    expect(ep.p99Ms![0]).toBeLessThan(10);
    expect(ep.errorRate![0]).toBeCloseTo(0.01, 6);
  });
  it('repairs non-monotonic buckets and refuses a p99 with too few requests behind it', () => {
    const m = new Map([['50', 10], ['75', 8], ['100', 10], ['+Inf', 10]]);
    expect(bucketQuantile(0.99, m)).toBeLessThanOrEqual(75);
    expect(bucketQuantile(0.99, m, 100)).toBeNull();
  });
});

describe('frameworks with two server spans per request', () => {
  it('drops the method-only span-metric series when routed ones exist and traces show two server spans per visit', () => {
    const sp = (tr: string, id: string, parent: string | null, name: string, kind: Span['kind'], route?: string) => ({ traceId: tr, spanId: id, parentId: parent, service: 'frontend', name, kind, start: 0, end: 10, error: false, attrs: route ? { 'http.route': route } : {} });
    const traces = [sp('a', '1', null, 'GET', 'server'), sp('a', '2', '1', 'GET /api/cart', 'server', '/api/cart'), sp('b', '3', null, 'GET', 'server'), sp('b', '4', '3', 'GET /api/x', 'server', '/api/x')];
    const files: Record<string, string> = {
      'ep.json': JSON.stringify({ status: 'success', data: { result: [{ metric: { service_name: 'frontend', span_name: 'GET' }, values: [[0, '20']] }, { metric: { service_name: 'frontend', span_name: 'GET /api/cart' }, values: [[0, '10']] }, { metric: { service_name: 'frontend', span_name: 'GET /api/x' }, values: [[0, '10']] }] } }),
      't.jsonl': traces.map((t) => JSON.stringify({ resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'frontend' } }] }, scopeSpans: [{ spans: [{ traceId: t.traceId, spanId: t.spanId, ...(t.parentId ? { parentSpanId: t.parentId } : {}), name: t.name, kind: 'SPAN_KIND_SERVER', startTimeUnixNano: '0', endTimeUnixNano: '10000000', attributes: Object.entries(t.attrs).map(([key, v]) => ({ key, value: { stringValue: v } })) }] }] }] })).join('\n'),
    };
    const fs = { read: (f: string) => files[f], glob: (p: string) => [p] };
    const { dataset } = importBundle({ name: 'x', step: '60s', metrics: [{ prometheus: 'ep.json', metric: 'rps', by: 'service_name', endpointBy: 'span_name', template: true }], traces: [{ file: 't.jsonl', series: { endpoints: false } }] }, fs);
    expect(Object.keys(dataset.endpoints).sort()).toEqual(['frontend GET /api/cart', 'frontend GET /api/x']);
  });
});

describe('queueing', () => {
  it('Erlang C matches M/M/1', () => {
    expect(erlangC(1, 0.5)).toBeCloseTo(0.5);
    // M/M/1, K=10, λ=5: mean wait ρ/(μ−λ) = 0.5/5 s = 100 ms
    expect(mmcWait(5, 1, 10).meanMs).toBeCloseTo(100, 6);
    expect(mmcWait(10, 1, 10).meanMs).toBe(Infinity);
    // more servers at the same total capacity wait less
    expect(mmcWait(8, 8, 10).meanMs).toBeLessThan(mmcWait(8, 1, 10).meanMs);
  });
});

/** a synthetic system with a known truth, recorded the way calibrate() expects */
function synthetic(truth: { K: number; c: number; S: number }, peak = 0.9): Dataset {
  const n = 240;
  const stepS = 15;
  const truthModel: Model = {
    version: 1,
    name: 'truth',
    timeoutMs: 5000,
    slo: { p99Ms: 500, errorRate: 0.01 },
    services: {
      api: { id: 'api', kind: 'server', replicas: 2, cpuLimit: 1, memoryGb: 1, cpu: { base: 0.02, perReq: 0.9 / truth.K, r2: 1 }, capacity: { limit: 'concurrency', servers: truth.c, perReplicaRps: truth.K }, self: { mean: truth.S, p99: truth.S * 3 }, tail: 1, cost: { perReplicaHour: 0.1, perRequest: 0, cpuShare: 0.8, arch: 'x86', source: 'bill' }, fit: { status: 'good', samples: 0, notes: [] } },
    },
    endpoints: {
      'api GET /x': { id: 'api GET /x', service: 'api', share: 1, visits: { api: 1 }, calls: {}, weights: { api: 1 }, overheadMs: 5, baseExcessMs: truth.S * 2, tail: 1, errorRate: 0, bytes: {}, egressBytes: 0, slo: { p99Ms: 500, errorRate: 0.01 }, fit: { status: 'good', samples: 0, notes: [] } },
    },
    transfer: { crossZoneGb: 0.01, crossRegionGb: 0.02, internetGb: 0.09, source: '' },
    unattributedPerHour: 0,
    accuracy: [],
    fittedOn: { start: T0, end: T0 + n * stepS, stepS, buckets: n },
  };
  const rps = Array.from({ length: n }, (_, i) => 2 * truth.K * peak * (0.3 + 0.7 * Math.sin((Math.PI * i) / n) ** 2));
  const r = runPlan(basePlan(truthModel), { start: T0, stepS, n, endpoints: { 'api GET /x': rps } });
  const s = r.services.api;
  return {
    version: 1,
    name: 'synthetic',
    start: T0,
    stepS,
    n,
    services: { api: { rps: s.rps, selfMeanMs: s.selfMeanMs, selfP99Ms: s.selfP99Ms, replicas: s.replicas, cpuCores: s.cpuCores, cpuLimitCores: new Array(n).fill(1) } },
    endpoints: { 'api GET /x': { service: 'api', rps, p99Ms: r.endpoints['api GET /x'].p99Ms, meanMs: r.endpoints['api GET /x'].meanMs, errorRate: r.endpoints['api GET /x'].errorRate } },
    topology: { services: { api: { spans: 1000, selfMeanMs: truth.S, selfP50Ms: truth.S, selfP99Ms: truth.S * 3, meanMs: truth.S, p99Ms: truth.S * 3, kind: 'server' } }, edges: [], endpoints: { 'api GET /x': { service: 'api', traces: 1000, calls: {}, visits: { api: 1 }, criticalMs: { api: truth.S }, meanMs: truth.S + 5, p99Ms: truth.S * 3, bytes: {}, errorRate: 0 } }, start: T0, end: T0 + n * stepS, traces: 1000 },
    bill: { source: 'aws-cur', currency: 'USD', start: T0, end: T0 + n * stepS, total: 0.1 * 2 * (n * stepS) / 3600, components: { api: { total: 0.1 * 2 * (n * stepS) / 3600, byCategory: { compute: 0.1 * 2 * (n * stepS) / 3600 }, usage: {}, skus: [] } }, unattributed: 0 },
    sources: [],
  };
}

describe('calibration', () => {
  it('recovers a concurrency limit from latency under load', () => {
    const d = synthetic({ K: 40, c: 4, S: 20 });
    const m = calibrate(d, { bootstrap: 10 });
    const api = m.services.api;
    expect(api.capacity.perReplicaRps).toBeGreaterThan(40 * 0.9);
    expect(api.capacity.perReplicaRps).toBeLessThan(40 * 1.1);
    expect(api.fit.status).toBe('good');
    expect(api.cost.perReplicaHour).toBeCloseTo(0.1, 3);
    expect(api.capacity.band![0]).toBeLessThanOrEqual(api.capacity.band![1]);
    expect(m.endpoints['api GET /x'].fit.p99Mape!).toBeLessThan(0.15);
  });

  it('extrapolates the CPU limit when load never came close', () => {
    const d = synthetic({ K: 40, c: 4, S: 20 }, 0.3);
    const m = calibrate(d, { bootstrap: 0 });
    expect(m.services.api.capacity.limit).toBe('cpu');
    expect(m.services.api.capacity.perReplicaRps).toBeGreaterThan(30);
  });
});

describe('strategies and backtest', () => {
  const d = synthetic({ K: 40, c: 4, S: 20 }, 1.1);
  const m = calibrate(d, { bootstrap: 10, slo: { p99Ms: 300, errorRate: 0.01 } });

  it('applies changes with notes', () => {
    const base = basePlan(m);
    const a = applyStrategy(m, base, { name: 'x', changes: [{ service: 'api', replicas: 4, arch: 'arm' }, { endpoint: '*', retries: { attempts: 2, budget: 0.1 } }] });
    expect(a.plan.services.api.replicas).toBe(4);
    expect(a.plan.services.api.replicaHour).toBeCloseTo(base.services.api.replicaHour * 0.8);
    expect(a.plan.endpoints['api GET /x'].retries).toEqual({ attempts: 2, budget: 0.1 });
    expect(a.notes.join(' ')).toMatch(/Graviton/);
    expect(() => applyStrategy(m, base, { name: 'bad', changes: [{ service: 'nope', replicas: 1 }] })).toThrow(/no service/);
  });

  it('ranks strategies: more replicas remove the overload, at a price', () => {
    const r = backtest(m, d, [{ name: 'four', changes: [{ service: 'api', replicas: 4 }] }, { name: 'one', changes: [{ service: 'api', replicas: 1 }] }], { draws: 5 });
    expect(r.baseline.summary.minutesOutOfSlo.p50).toBeGreaterThan(0);
    const four = r.strategies.find((s) => s.name === 'four')!;
    const one = r.strategies.find((s) => s.name === 'one')!;
    expect(four.summary.minutesOutOfSlo.p50).toBe(0);
    expect(four.delta.monthly.p50).toBeGreaterThan(0);
    expect(one.delta.monthly.p50).toBeLessThan(0);
    expect(one.delta.minutesOutOfSlo.p50).toBeGreaterThan(0);
    expect(r.ranking[0].name).toBe('four');
    expect(r.baseline.worst.why).toMatch(/api at \d+% of capacity/);
    expect(r.baseline.series.cumulativeCost.p50.at(-1)).toBeCloseTo(r.baseline.summary.cost.p50, 6);
  });

  it('replays the history at another load, as built and every strategy alike', () => {
    const calm = backtest(m, d, [{ name: 'four', changes: [{ service: 'api', replicas: 4 }] }], { draws: 3 });
    const double = backtest(m, d, [{ name: 'four', changes: [{ service: 'api', replicas: 4 }] }], { draws: 3, load: { scale: 2 } });
    expect(double.load?.factor).toBe(2);
    expect(calm.load).toBeUndefined();
    expect(double.baseline.summary.minutesOutOfSlo.p50).toBeGreaterThan(calm.baseline.summary.minutesOutOfSlo.p50);
    expect(double.strategies[0].summary.minutesOutOfSlo.p50).toBeGreaterThan(calm.strategies[0].summary.minutesOutOfSlo.p50);
    // peakRps: the busiest bucket lands on the asked rate
    const peak = backtest(m, d, [], { draws: 1, load: { peakRps: 100 } });
    expect(peak.load!.peakRps).toBeCloseTo(100, 6);
  });

  it('autoscaling follows the load and bills the replicas it runs', () => {
    const r = backtest(m, d, [{ name: 'auto', changes: [{ service: 'api', autoscale: { min: 1, max: 6, targetCpu: 0.6, warmupS: 30, cooldownS: 120 } }] }], { draws: 1 });
    const reps = r.strategies[0].series.replicas.api;
    expect(Math.max(...reps)).toBeGreaterThan(Math.min(...reps));
    expect(r.strategies[0].events.some((e) => /scale out/.test(e.what))).toBe(true);
  });
});

describe('memory limits and CPU quota throttling', () => {
  const MiB = 2 ** 20;
  /** the synthetic service, with a working set that grows with load and a 512 MiB limit */
  const withMemory = (peak: number) => {
    const d = synthetic({ K: 40, c: 4, S: 20 }, peak);
    const api = d.services.api;
    api.memoryMaxBytes = api.rps!.map((r, i) => (200 + 0.8 * (r! / api.replicas![i]!)) * MiB + (i === 7 ? 6 * MiB : 0));
    api.memoryLimitBytes = new Array(d.n).fill(512 * MiB);
    return d;
  };

  it('fits the working set against load and prices the limit, not what was used', () => {
    const m = calibrate(withMemory(0.6), { bootstrap: 0 });
    const mem = m.services.api.memory!;
    expect(mem.limit).toBeCloseTo(0.5, 6);
    expect(mem.perReq * 1024).toBeCloseTo(0.8, 1);
    expect(mem.spike * 1024).toBeGreaterThan(4);
    expect(m.services.api.memoryGb).toBeCloseTo(0.5, 6);
  });

  it('OOM-kills a limit below the working set, and passes one above it', () => {
    const d = withMemory(0.6);
    const m = calibrate(d, { bootstrap: 0 });
    const r = backtest(m, d, [{ name: 'tight', changes: [{ service: 'api', memoryGb: 0.18 }] }, { name: 'trim', changes: [{ service: 'api', memoryGb: 0.3 }] }], { draws: 1 });
    const tight = r.strategies.find((x) => x.name === 'tight')!;
    const trim = r.strategies.find((x) => x.name === 'trim')!;
    expect(tight.delta.minutesOutOfSlo.p50).toBeGreaterThan(10);
    expect(tight.worst.why).toMatch(/api OOM-killed/);
    expect(tight.events.some((e) => /OOM-killed/.test(e.what))).toBe(true);
    expect(trim.delta.minutesOutOfSlo.p50).toBe(0);
    expect(trim.delta.monthly.p50).toBeLessThan(0);
  });

  it('stops CPU-bound capacity where quota throttling takes over, not at the limit', () => {
    // many workers: latency stays flat until the limit, so only CPU tells where it is
    const plain = synthetic({ K: 40, c: 64, S: 20 }, 0.3);
    const throttled = synthetic({ K: 40, c: 64, S: 20 }, 0.3);
    const api = throttled.services.api;
    // throttled share rising exponentially with CPU use: 25% at 70% of the limit
    api.cpuThrottled = api.cpuCores!.map((c, i) => 0.25 * Math.exp(5 * (c! / api.replicas![i]! - 0.7)));
    const a = calibrate(plain, { bootstrap: 0 }).services.api;
    const b = calibrate(throttled, { bootstrap: 0 }).services.api;
    expect(b.capacity.throttle?.knee).toBeCloseTo(0.7, 1);
    expect(b.capacity.perReplicaRps).toBeLessThan(a.capacity.perReplicaRps * 0.8);
    expect(b.fit.notes.join(' ')).toMatch(/CPU quota throttling/);
  });
});

describe('Kubernetes nodes', () => {
  const GiB = 2 ** 30;
  /** the synthetic service on a node pool: 2-core / 8 GiB nodes, 1 core + 2 GiB requested per replica,
   *  others' pods asking for 1 core */
  const onNodes = (autoscaled: boolean) => {
    const d = synthetic({ K: 40, c: 4, S: 20 }, 0.6);
    const api = d.services.api;
    api.cpuRequestCores = new Array(d.n).fill(1);
    api.memoryRequestBytes = new Array(d.n).fill(2 * GiB);
    const reps = api.replicas!.map((r) => r ?? 2);
    const reqCpu = reps.map((r) => r * 1 + 1);
    d.cluster = {
      clusterNodes: reqCpu.map((c, i) => (autoscaled ? Math.ceil(c / 2) + (i % 7 === 0 ? 1 : 0) : 3)),
      clusterNodeCpu: new Array(d.n).fill(2),
      clusterNodeMemoryBytes: new Array(d.n).fill(8 * GiB),
      clusterRequestedCpu: reqCpu,
      clusterRequestedMemoryBytes: reps.map((r) => r * 2 * GiB + GiB),
    };
    return d;
  };

  it('prices compute by the nodes, and a fixed pool saves nothing when requests shrink', () => {
    const d = onNodes(false);
    const m = calibrate(d, { bootstrap: 0 });
    expect(m.cluster?.autoscaled).toBe(false);
    expect(m.cluster?.other.cpu).toBeCloseTo(1, 6);
    expect(m.services.api.cost.source).toBe('bill'); // the bill wins where there is one
    delete d.bill;
    const m2 = calibrate(d, { bootstrap: 0 });
    expect(m2.services.api.cost.source).toBe('nodes');
    const r = backtest(m2, d, [{ name: 'half', changes: [{ service: 'api', cpuRequest: 0.5 }] }], { draws: 1 });
    expect(r.strategies[0].delta.monthly.p50).toBeCloseTo(0, 6);
    expect(r.baseline.cluster?.peakNodes).toBe(3);
  });

  it('on an autoscaled pool, requests that need fewer nodes save the nodes', () => {
    const d = onNodes(true);
    delete d.bill;
    const m = calibrate(d, { bootstrap: 0 });
    expect(m.cluster?.autoscaled).toBe(true);
    // 2 replicas × 1 core + 1 core of others' pods fill 1.5 nodes (2 running); at 0.25 cores, 0.75 (1)
    const r = backtest(m, d, [{ name: 'half', changes: [{ service: 'api', cpuRequest: 0.25 }] }, { name: 'more', changes: [{ service: 'api', replicas: 4 }] }], { draws: 1 });
    const half = r.strategies.find((x) => x.name === 'half')!;
    const more = r.strategies.find((x) => x.name === 'more')!;
    expect(half.delta.monthly.p50).toBeLessThan(0);
    expect(half.cluster!.meanNodes).toBeLessThan(r.baseline.cluster!.meanNodes);
    expect(more.cluster!.peakNodes).toBeGreaterThan(r.baseline.cluster!.peakNodes);
  });
});

describe('strategy from a config diff', () => {
  const dep = (name: string, replicas: number, cpu: string, arch?: string) => `apiVersion: apps/v1
kind: Deployment
metadata: { name: ${name} }
spec:
  replicas: ${replicas}
  template:
    spec:
      ${arch ? `nodeSelector: { kubernetes.io/arch: ${arch} }` : ''}
      containers:
        - name: app
          resources: { limits: { cpu: "${cpu}", memory: 512Mi } }
`;
  const hpa = `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: api }
spec:
  scaleTargetRef: { kind: Deployment, name: api }
  minReplicas: 2
  maxReplicas: 8
  metrics: [{ type: Resource, resource: { name: cpu, target: { type: Utilization, averageUtilization: 60 } } }]
`;
  it('turns replica, CPU, arch and HPA changes into a strategy', async () => {
    const { readWorkloads, strategyFromDiff, cpuQuantity, memQuantity } = await import('../src/backtest/configDiff');
    expect(cpuQuantity('500m')).toBe(0.5);
    expect(memQuantity('512Mi')).toBe(0.5);
    const before = readWorkloads([dep('api', 3, '1') + '---\n' + dep('db', 1, '2') + '---\n' + dep('web', 2, '500m')]);
    const after = readWorkloads([dep('api', 3, '1', 'arm64') + '---\n' + hpa + '---\n' + dep('db', 1, '4') + '---\n' + dep('web', 2, '500m')]);
    const { strategy } = strategyFromDiff(before, after);
    expect(strategy!.changes).toEqual([
      { service: 'api', autoscale: { min: 2, max: 8, targetCpu: 0.6, cooldownS: 300, warmupS: 30 }, arch: 'arm' },
      { service: 'db', cpu: 4 },
    ]);
    expect(strategyFromDiff(before, before).strategy).toBeNull();
  });

  it('reads requests apart from limits: a request cut alone, and a limit change that carries its request', async () => {
    const { readWorkloads, strategyFromDiff } = await import('../src/backtest/configDiff');
    const w = (req: string, lim: string) => `apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: app
          resources: { requests: { cpu: "${req}", memory: 256Mi }, limits: { cpu: "${lim}", memory: 512Mi } }
`;
    const before = readWorkloads([w('500m', '1')]);
    expect(strategyFromDiff(before, readWorkloads([w('250m', '1')])).strategy!.changes).toEqual([{ service: 'api', cpuRequest: 0.25 }]);
    // limits only: requests default to them, and move with them
    const lim = (cpu: string) => w(cpu, cpu).replace(/requests: \{[^}]*\}, /, '');
    expect(strategyFromDiff(readWorkloads([lim('1')]), readWorkloads([lim('2')])).strategy!.changes).toEqual([{ service: 'api', cpu: 2 }]);
  });
});

describe('public-outage replays', () => {
  it('replays every outage against a model, with faults on the right roles', async () => {
    const { OUTAGES, replayOutage } = await import('../src/backtest/outages');
    const m = calibrate(synthetic({ K: 40, c: 4, S: 20 }, 0.5), { bootstrap: 0 });
    expect(OUTAGES.length).toBeGreaterThanOrEqual(3);
    for (const o of OUTAGES) {
      const { replay, result } = replayOutage(m, o, [], { draws: 1 });
      expect(replay.dataset.n).toBe(Math.round((o.minutes * 60) / o.stepS));
      expect(o.sources.length).toBeGreaterThan(0);
      expect(result.baseline.events.length + replay.warnings.length).toBeGreaterThan(0);
    }
    // the Cloudflare regex cuts edge capacity to 3%: the single api service melts down
    const cf = replayOutage(m, OUTAGES.find((o) => o.id.startsWith('cloudflare'))!, [], { draws: 1 });
    expect(cf.replay.roles.edge).toEqual(['api']);
    expect(cf.result.baseline.summary.minutesOutOfSlo.p50).toBeGreaterThan(15);
  });
});

describe('endpoints and data transfer', () => {
  const svc = (id: string, zone: string, extra: Partial<Model['services'][string]> = {}): Model['services'][string] => ({ id, kind: 'server', replicas: 1, cpuLimit: 1, memoryGb: 1, cpu: null, capacity: { limit: 'none', servers: 1, perReplicaRps: Infinity }, self: { mean: 10, p99: 30 }, tail: 1, cost: { perReplicaHour: 0.1, perRequest: 0, cpuShare: 0.8, arch: 'x86', source: 'bill' }, placement: { zone }, fit: { status: 'good', samples: 0, notes: [] }, ...extra });
  const ep = (id: string, calls: Record<string, number>, bytes: Record<string, number>, slo = { p99Ms: 500, errorRate: 0.01 }): Model['endpoints'][string] => ({ id, service: 'web', share: 0.5, visits: { web: 1, api: calls['web>api'] ?? 0 }, calls, weights: { web: 1, api: calls['web>api'] ?? 0 }, overheadMs: 0, baseExcessMs: 10, tail: 1, errorRate: 0, bytes, egressBytes: 50_000, slo, fit: { status: 'good', samples: 0, notes: [] } });
  const model: Model = {
    version: 1, name: 'zones', timeoutMs: 5000, slo: { p99Ms: 500, errorRate: 0.01 },
    services: { web: svc('web', 'a'), api: svc('api', 'b') },
    endpoints: { 'web GET /a': ep('web GET /a', { 'web>api': 3 }, { 'web>api': 3 * 200_000 }), 'web GET /b': ep('web GET /b', {}, {}, { p99Ms: 15, errorRate: 0.01 }) },
    transfer: { crossZoneGb: 0.01, crossRegionGb: 0.02, internetGb: 0.09, source: '' }, unattributedPerHour: 0.05, accuracy: [], fittedOn: { start: T0, end: T0 + 3600, stepS: 60, buckets: 60 },
  };
  const d: Dataset = { version: 1, name: 'z', start: T0, stepS: 60, n: 60, services: {}, endpoints: { 'web GET /a': { service: 'web', rps: new Array(60).fill(100) }, 'web GET /b': { service: 'web', rps: new Array(60).fill(100) } }, sources: [] };

  it('attributes every dollar to an endpoint and prices cross-zone bytes', () => {
    const r = backtest(model, d, [{ name: 'same zone', changes: [{ service: 'api', zone: 'a' }] }], { draws: 1, observed: false });
    const total = r.baseline.summary.cost.p50;
    const perEp = Object.values(r.baseline.endpoints).reduce((a, e) => a + e.cost, 0);
    expect(perEp).toBeCloseTo(total, 6);
    // /a calls the api 3× with 200 kB each across zones: 100 req/s × 600 kB × 2 × $0.01/GB for an hour
    const xzone = (100 * 3600 * 600_000 / 2 ** 30) * 0.02;
    expect(r.strategies[0].delta.cost.p50).toBeCloseTo(-xzone, 2);
    expect(r.baseline.endpoints['web GET /a'].costPerMillion).toBeGreaterThan(r.baseline.endpoints['web GET /b'].costPerMillion);
    // /b has its own tight SLO (15 ms p99) and breaks it all hour; /a meets the global one
    expect(r.baseline.endpoints['web GET /b'].minutesOutOfSlo).toBe(60);
    expect(r.baseline.endpoints['web GET /a'].minutesOutOfSlo).toBe(0);
  });
});

describe('strategies from the board and from audit fixes', () => {
  it('turns board edits into a strategy the backtest can run', async () => {
    const { modelToSpec } = await import('../src/backtest/toSpec');
    const { specDiffToStrategy, fixToStrategy } = await import('../src/backtest/fromBoard');
    const m = calibrate(synthetic({ K: 40, c: 4, S: 20 }, 0.8), { bootstrap: 0 });
    const { spec } = modelToSpec(m, basePlan(m));
    expect(spec.components.find((c) => c.id === 'api')).toMatchObject({ kind: 'server', instances: 2 });
    expect(spec.connections).toContainEqual(['users', 'api-lb']);
    const edited = { ...spec, components: [...spec.components.map((c) => (c.id === 'api' ? { ...c, instances: 3, tier: 'M' as const } : c)), { id: 'redis', kind: 'cache' as const, hitRate: 0.7 }], connections: [...spec.connections.filter((c) => !(Array.isArray(c) && c[0] === 'users')), ['users', 'redis'] as [string, string], ['redis', 'api-lb'] as [string, string]] };
    const { strategy } = specDiffToStrategy('edits', spec, edited, m);
    expect(strategy!.changes).toEqual([{ service: 'api', replicas: 3, cpu: 2, cache: { hitRate: 0.7 } }]);
    const fix = fixToStrategy('Autoscale the API', spec, [{ op: 'set', id: 'api', fields: { autoscale: { min: 2, max: 6, targetUtil: 0.6 } } }], m);
    expect(fix.strategy!.changes[0]).toMatchObject({ service: 'api', autoscale: { min: 2, max: 6, targetCpu: 0.6 } });
    expect(() => backtest(m, synthetic({ K: 40, c: 4, S: 20 }, 0.8), [strategy, fix.strategy], { draws: 1 })).not.toThrow();
  });
});

describe('accuracy measurement', () => {
  it('finds the breaking point where failure persists, ignoring a lone noisy plateau', async () => {
    const { crossing } = await import('../src/backtest/accuracy');
    expect(crossing([{ rps: 1, score: 0.5 }, { rps: 2, score: 1.2 }, { rps: 3, score: 0.8 }, { rps: 4, score: 0.9 }, { rps: 5, score: 1.1 }, { rps: 6, score: 3 }])).toBeGreaterThan(4);
    expect(crossing([{ rps: 1, score: 0.5 }, { rps: 2, score: 0.5 }])).toBe(2);
    // log-linear interpolation: score 0.5 → 2 crosses 1 halfway in log space
    expect(crossing([{ rps: 10, score: 0.5 }, { rps: 20, score: 2 }])).toBeCloseTo(15, 5);
  });

  it('pools every request of a window for p99, and scores load-test plateaus the same way for model and measurement', async () => {
    const { windowP99, plateauBreakingPoint, parseRequestLog } = await import('../src/backtest/accuracy');
    const d = synthetic({ K: 40, c: 4, S: 20 }, 0.6);
    const m = calibrate(d, { bootstrap: 0 });
    const r = runPlan(basePlan(m), trafficOf(d, m));
    // a request log consistent with the model: 30 requests per 15 s bucket at the predicted p99
    let csv = 't,ms,failed,endpoint\n';
    for (let i = 0; i < d.n; i++) for (let k = 0; k < 30; k++) csv += `${d.start + i * d.stepS + k * 0.5},${k === 29 ? r.endpoints['api GET /x'].p99Ms[i] * 1.2 : 10},0,"api GET /x"\n`;
    const log = parseRequestLog(csv);
    const w = windowP99(r, log, d.start, d.stepS);
    expect(w.rows.length).toBeGreaterThan(5);
    expect(w.rows.every((x) => x.n >= 200)).toBe(true);
    const shape = [{ t: 0, rps: 10 }, { t: 300, rps: 10 }, { t: 305, rps: 20 }, { t: 600, rps: 20 }];
    const bp = plateauBreakingPoint(r, log, d.start, d.stepS, shape, { p99Ms: 1e6, errorRate: 0.5 });
    expect(bp.plateaus.length).toBe(2);
    expect(bp.measured).toBe(bp.plateaus[1].rps); // never broke: the last plateau
  });
});

describe('endpoint matching', () => {
  it('matches the same route across frameworks and sources', async () => {
    const { sameEndpoint } = await import('../src/backtest/calibrate');
    expect(sameEndpoint('frontend GET /api/products/{productId}', 'frontend GET /api/products/[productId]')).toBe(true);
    expect(sameEndpoint('app GET /owners/:id', 'app GET /owners/{ownerId}')).toBe(true);
    expect(sameEndpoint('frontend GET /api/data/', 'frontend GET /api/data')).toBe(true);
    expect(sameEndpoint('frontend HTTP GET /dispatch', 'frontend GET /dispatch')).toBe(true);
    expect(sameEndpoint('frontend GET /api/cart', 'frontend POST /api/cart')).toBe(false);
  });
});

describe('metastable failures', () => {
  it('once overloaded, finishes only its overloaded rate until the backlog is gone', () => {
    const d = synthetic({ K: 40, c: 4, S: 20 }, 0.5);
    const m = calibrate(d, { bootstrap: 0 });
    const plan = basePlan(m);
    plan.services.api.perReplicaRps = 40;
    const n = 60;
    // 10 minutes at 30/s, a minute at 50/s, then 20/s
    const rps = Array.from({ length: n }, (_, i) => (i < 20 ? 60 : i < 24 ? 100 : 40));
    const healthy = runPlan(plan, { start: 0, stepS: 15, n, endpoints: { 'api GET /x': rps } });
    plan.services.api.overloadedRps = 15;
    const meta = runPlan(plan, { start: 0, stepS: 15, n, endpoints: { 'api GET /x': rps } });
    const after = (r: typeof meta) => r.endpoints['api GET /x'].errorRate.slice(40).reduce((a, x) => a + x, 0);
    // the ordinary service has recovered by then; the metastable one is still failing at 20 req/s per replica
    expect(after(healthy)).toBeLessThan(0.1);
    expect(after(meta)).toBeGreaterThan(after(healthy) + 1);
  });

  it('a CPU-bound collapse moves with the cores: a resize scales the overloaded rate too', () => {
    const m = calibrate(synthetic({ K: 40, c: 4, S: 20 }, 0.5), { bootstrap: 0 });
    m.services.api.capacity = { limit: 'cpu', servers: 1, perReplicaRps: 40, overloadedRps: 20 };
    m.services.api.cpu = { base: 0.2, perReq: 0.02, r2: 1 };
    m.services.api.cpuLimit = 1;
    const plan = basePlan(m);
    const { plan: p } = applyStrategy(m, plan, { name: 'double', changes: [{ service: 'api', cpu: 1.8 }] });
    // (1.8 − 0.2) / (1 − 0.2) = ×2 of the CPU left for requests
    expect(p.services.api.perReplicaRps).toBeCloseTo(plan.services.api.perReplicaRps * 2, 6);
    expect(p.services.api.overloadedRps).toBeCloseTo(40, 6);
  });
});
