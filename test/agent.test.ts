import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatasetBuilder } from '../src/backtest/dataset';
import { importPrometheus } from '../src/backtest/import/metrics';
import { parseOtlp, templatePath, type Span } from '../src/backtest/import/traces';
import { exportPlan, runExport, WORKLOAD_RE } from '../src/backtest/import/promExport';
import { holdoutCut } from '../src/backtest/accuracy';
import { instanceType, strategyFromTerraformPlan } from '../src/backtest/terraformDiff';
import { probeJaeger, probePrometheus, shapeOf, suggestRenames } from '../agent/sources';
import { Workspace } from '../agent/workspace';
import { calibrateModel, modelStatus, verifyChange, verifyDesign } from '../agent/verify';
import { connectTelemetry, readCluster } from '../agent/connect';
import { explainError, runTool, TOOLS } from '../agent/tools';
import { appLink } from '../agent/serve';
import { suggestChanges } from '../agent/suggest';
import { StrategySpec } from '../src/backtest/strategy';

const T0 = 1_790_000_000;

describe('endpoint names from metrics', () => {
  it('templates span and route names the way traces spell endpoints', () => {
    expect(templatePath('GET /api/cart?sessionId=k6-user-1&currencyCode=USD')).toBe('GET /api/cart');
    expect(templatePath('GET /api/products/0PUK6V6EV0')).toBe('GET /api/products/{id}');
    expect(templatePath('HTTP GET /orders/123/items')).toBe('GET /orders/{id}/items');
    expect(templatePath('oteldemo.CartService/AddItem')).toBe('oteldemo.CartService/AddItem');
  });

  it('merges series that template to the same endpoint: rates add up, p99 takes the worst', () => {
    const series = (name: string, v: string) => ({ metric: { service_name: 'frontend', span_name: name }, values: [[T0, v]] as [number, string][] });
    const b = new DatasetBuilder();
    importPrometheus(b, { data: { result: [series('GET /api/cart?u=1', '2'), series('GET /api/cart?u=2', '3'), series('GET /', '1')] } }, { metric: 'rps', by: 'service_name', endpointBy: 'span_name', template: true });
    importPrometheus(b, { data: { result: [series('GET /api/cart?u=1', '120'), series('GET /api/cart?u=2', '300')] } }, { metric: 'p99Ms', by: 'service_name', endpointBy: 'span_name', template: true });
    const d = b.build({ name: 't' });
    expect(d.endpoints['frontend GET /api/cart']).toMatchObject({ service: 'frontend', rps: [5], p99Ms: [300] });
    expect(d.endpoints['frontend GET /'].rps).toEqual([1]);
  });

  it('groups Kubernetes metrics by owning workload, scoped to the system\'s namespaces', () => {
    const plan = exportPlan(['kubernetes', 'ingress-nginx'], { namespaces: ['shop'] });
    const cpu = plan.find((p) => p.query.file === 'kubernetes-cpu.json')!.query;
    expect(cpu.mapping.by).toBe('workload');
    expect(cpu.query).toContain('namespace=~"shop"');
    expect(cpu.query).toContain('label_replace');
    // no CPU limits on the cluster: requests stand in
    expect(plan.find((p) => p.query.file === 'kubernetes-cpu-limit.json')!.query.query).toMatch(/kube_pod_container_resource_limits.* or .*kube_pod_container_resource_requests/);
    // the ingress' own namespace is `namespace`; the backend's is exported_namespace
    const edge = plan.find((p) => p.query.file === 'ingress-nginx-rps.json')!.query;
    expect(edge.query).toContain('exported_namespace=~"shop"');
    expect(edge.mapping.edge).toBe(true);
    const re = new RegExp(WORKLOAD_RE);
    const name = (pod: string) => { const m = re.exec(pod); return m ? (m[1] ?? m[2] ?? m[3]) : null; };
    expect(name('frontend-7557bb77cf-5xjb6')).toBe('frontend');
    expect(name('product-catalog-65dbdfdbb6-tcgw2')).toBe('product-catalog');
    expect(name('postgres-0')).toBe('postgres');
    expect(name('node-exporter-x7k2p')).toBe('node-exporter');
  });

  it('asks Prometheus for endpoint series only on the services requests enter through', () => {
    const plan = exportPlan(['otel-spanmetrics'], { entry: ['frontend'] });
    const ep = plan.filter((p) => p.query.file.includes('endpoint'));
    expect(ep.length).toBeGreaterThan(0);
    for (const p of ep) expect(p.query.query).toContain('service_name=~"frontend"');
    expect(exportPlan(['otel-spanmetrics']).some((p) => p.query.file.includes('endpoint'))).toBe(false);
    // a service without errors still gets an error rate of 0
    expect(plan.find((p) => p.query.file.endsWith('-errors.json'))!.query.query).toContain(' or ');
  });
});

describe('trace shape', () => {
  const span = (id: string, parent: string | null, service: string, kind: Span['kind']): Span => ({ traceId: 't', spanId: id, parentId: parent, service, name: 'x', kind, start: 0, end: 1, error: false, attrs: {} });
  it('finds entry services and load generators, and keeps uninstrumented databases', () => {
    const s = shapeOf([span('1', null, 'loadgen', 'client'), span('2', '1', 'api', 'server'), span('3', '2', 'api', 'client'), span('4', '3', 'mysql', 'client'), span('5', null, 'worker', 'server')]);
    expect(s.entry).toEqual(['api', 'worker']);
    expect(s.clientsOnly).toEqual(['loadgen']);
    expect(s.edges).toContain('api → mysql');
  });

  it('treats a span whose parent never arrived as a broken link, not an entry service', () => {
    const t = (trace: string, id: string, parent: string | null, service: string, kind: Span['kind'], start = 0): Span => ({ ...span(id, parent, service, kind), traceId: trace, start });
    // checkout's client span to cart was dropped; cart's server span still names it as parent
    const s = shapeOf([t('a', '1', null, 'frontend', 'server'), t('a', '2', '1', 'frontend', 'client'), t('a', '3', '2', 'checkout', 'server'), t('a', '5', 'lost', 'cart', 'server'), t('b', '9', 'gone', 'gateway', 'server', 0), t('b', '10', 'gone2', 'api', 'server', 1)]);
    expect(s.entry).toEqual(['frontend', 'gateway']);
  });

  it('reads Tempo\'s trace JSON (batches, and v2 trace.resourceSpans)', () => {
    const rs = [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'api' } }] }, scopeSpans: [{ spans: [{ traceId: 'AAE=', spanId: 'AQ==', name: 'GET /x', kind: 'SPAN_KIND_SERVER', startTimeUnixNano: '1000000000', endTimeUnixNano: '1005000000' }] }] }];
    expect(parseOtlp({ batches: rs })).toMatchObject([{ service: 'api', kind: 'server', start: 1000, end: 1005 }]);
    expect(parseOtlp({ trace: { resourceSpans: rs } })).toHaveLength(1);
  });

  it('maps container names onto service names, but not a load balancer onto its backend', () => {
    const probe = { url: '', ok: true, presets: [], nearMisses: [], warnings: [], services: { 'otel-spanmetrics': ['customer', 'frontend', 'worker'], cadvisor: ['customer', 'customer-lb', 'shop-frontend', 'shop-worker', 'frontend'] } };
    expect(suggestRenames(probe)).toEqual({ 'shop-worker': 'worker' });
  });
});

describe('Terraform plan → strategy', () => {
  it('reads instance types', () => {
    expect(instanceType('m7g.xlarge')).toEqual({ cpu: 4, memoryGb: 16, arch: 'arm' });
    expect(instanceType('db.r6g.large')).toMatchObject({ cpu: 2, memoryGb: 16, arch: 'arm' });
    expect(instanceType('c5.2xlarge')).toMatchObject({ cpu: 8, arch: 'x86' });
    expect(instanceType('t3.micro')).toMatchObject({ cpu: 2, memoryGb: 1 });
  });

  const plan = {
    resource_changes: [
      { address: 'aws_ecs_service.customer', type: 'aws_ecs_service', name: 'customer', change: { actions: ['update'], before: { name: 'customer', desired_count: 1 }, after: { name: 'customer', desired_count: 2 } } },
      { address: 'aws_ecs_task_definition.frontend', type: 'aws_ecs_task_definition', name: 'frontend', change: { actions: ['create', 'delete'], before: { family: 'frontend', cpu: '1024', memory: '2048', runtime_platform: [{ cpu_architecture: 'X86_64' }] }, after: { family: 'frontend', cpu: '1024', memory: '2048', runtime_platform: [{ cpu_architecture: 'ARM64' }] } } },
      { address: 'aws_appautoscaling_target.route', type: 'aws_appautoscaling_target', name: 'route', change: { actions: ['create'], before: null, after: { resource_id: 'service/prod/route', min_capacity: 1, max_capacity: 4 } } },
      { address: 'aws_appautoscaling_policy.route_cpu', type: 'aws_appautoscaling_policy', name: 'route_cpu', change: { actions: ['create'], before: null, after: { resource_id: 'service/prod/route', target_tracking_scaling_policy_configuration: [{ target_value: 55, predefined_metric_specification: [{ predefined_metric_type: 'ECSServiceAverageCPUUtilization' }] }] } } },
      { address: 'aws_ecs_service.route', type: 'aws_ecs_service', name: 'route', change: { actions: ['update'], before: { name: 'route', desired_count: 1 }, after: { name: 'route', desired_count: 1, tags: {} } } },
      { address: 'aws_s3_bucket.logs', type: 'aws_s3_bucket', name: 'logs', change: { actions: ['update'], before: { bucket: 'logs' }, after: { bucket: 'logs' } } },
      { address: 'aws_ecs_service.search', type: 'aws_ecs_service', name: 'search', change: { actions: ['create'], before: null, after: { name: 'search', desired_count: 2 } } },
    ],
  };

  it('turns ECS, task definition and autoscaling changes into one strategy', () => {
    const r = strategyFromTerraformPlan(plan, { known: new Set(['customer', 'frontend', 'route', 'driver']) });
    expect(r.strategy!.changes).toEqual(
      expect.arrayContaining([
        { service: 'customer', replicas: 2 },
        { service: 'frontend', arch: 'arm' },
        expect.objectContaining({ service: 'route', autoscale: expect.objectContaining({ min: 1, max: 4, targetCpu: 0.55 }) }),
      ]),
    );
    expect(r.ignored.join('\n')).toMatch(/aws_s3_bucket\.logs/);
    expect(r.ignored.join('\n')).toMatch(/aws_ecs_service\.search: new/);
  });
});

// ---------------------------------------------------------------------------------------------
// live sources, mocked

let server: Server;
let rangeCalls = 0;
let base = '';
const NOW = 1_791_500_000;
beforeAll(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    const send = (v: unknown) => res.end(JSON.stringify(v));
    // /gappy: two busy stretches with an idle day between them
    if (u.pathname.startsWith('/gappy/')) u.pathname = u.pathname.replace('/gappy/', '/prom/');
    const gappy = req.url!.startsWith('/gappy/');
    if (u.pathname === '/prom/api/v1/status/buildinfo') return send({ status: 'success', data: { version: '2.54.1' } });
    if (u.pathname === '/prom/api/v1/label/__name__/values') return send({ status: 'success', data: ['traces_span_metrics_calls_total', 'container_spec_cpu_quota', 'calls_total'] });
    if (u.pathname === '/prom/api/v1/label/service_name/values') return send({ status: 'success', data: ['api', 'worker'] });
    if (u.pathname === '/prom/api/v1/label/container_label_com_docker_compose_service/values') return send({ status: 'success', data: ['api', 'shop-worker'] });
    if (u.pathname === '/prom/api/v1/query') {
      // traffic between 30 h and 2 h ago
      const t = Number(u.searchParams.get('time'));
      const on = gappy ? (t <= NOW - 10 * 3600 && t >= NOW - 12 * 3600) || (t <= NOW - 23 * 3600 && t >= NOW - 26 * 3600) : t <= NOW - 2 * 3600 && t >= NOW - 30 * 3600;
      return send({ status: 'success', data: { resultType: 'vector', result: on ? [{ metric: {}, value: [t, '1200'] }] : [] } });
    }
    if (u.pathname === '/prom/api/v1/query_range') {
      rangeCalls++;
      const [a, b, st] = ['start', 'end', 'step'].map((k) => parseFloat(u.searchParams.get(k)!));
      const values: [number, string][] = [];
      for (let t = a; t <= b; t += st) values.push([t, '1']);
      return send({ status: 'success', data: { resultType: 'matrix', result: [{ metric: { service_name: 'api' }, values }] } });
    }
    if (u.pathname === '/jaeger/api/services') return send({ data: ['api', 'loadgen', 'jaeger-all-in-one'] });
    if (u.pathname === '/jaeger/api/traces')
      return send({
        data: [
          {
            traceID: 'a1',
            processes: { p1: { serviceName: 'loadgen' }, p2: { serviceName: 'api' } },
            spans: [
              { traceID: 'a1', spanID: 's1', references: [], processID: 'p1', operationName: 'GET', startTime: 1, duration: 10, tags: [{ key: 'span.kind', value: 'client' }] },
              { traceID: 'a1', spanID: 's2', references: [{ refType: 'CHILD_OF', spanID: 's1' }], processID: 'p2', operationName: 'GET /x', startTime: 2, duration: 8, tags: [{ key: 'span.kind', value: 'server' }] },
            ],
          },
        ],
      });
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

describe('long histories', () => {
  it('splits a range past 11,000 points per series into chunks and stitches them', async () => {
    rangeCalls = 0;
    const files: Record<string, string> = {};
    const [r] = await runExport(`${base}/prom`, exportPlan(['otel-spanmetrics']).slice(0, 1), { start: T0, end: T0 + 25_000 * 60, stepS: 60 }, (f, b) => (files[f] = b));
    expect(rangeCalls).toBe(3);
    const values = JSON.parse(files[r.file]).data.result[0].values as [number, string][];
    expect(values).toHaveLength(25_001);
    expect(new Set(values.map((v) => v[0])).size).toBe(25_001);
  });

  it('holds back the last 30% of the requests, not of the time', () => {
    const rps = [...new Array(70).fill(0), ...new Array(30).fill(10)];
    const d = { n: 100, endpoints: { e: { service: 'api', rps } } } as unknown as Parameters<typeof holdoutCut>[0];
    expect(holdoutCut(d, 0.3)).toBe(91);
    const busy = { n: 100, endpoints: { e: { service: 'api', rps: new Array(100).fill(5) } } } as unknown as Parameters<typeof holdoutCut>[0];
    expect(holdoutCut(busy, 0.3)).toBe(70);
  });
});

describe('probing live telemetry', () => {
  it('finds the presets, the services and when traffic flowed', async () => {
    const p = await probePrometheus({ url: `${base}/prom` }, NOW);
    expect(p.version).toBe('2.54.1');
    expect(p.presets).toEqual(['otel-spanmetrics', 'cadvisor']);
    expect(p.nearMisses[0]).toMatch(/calls_total/);
    // bisected edges: within ~1% of the gap between probes
    expect(Math.abs(Date.parse(p.data!.newest) / 1000 - (NOW - 2 * 3600))).toBeLessThan(1200);
    expect(Math.abs(Date.parse(p.data!.oldestFound) / 1000 - (NOW - 30 * 3600))).toBeLessThan(3600);
    expect(p.warnings.join(' ')).toMatch(/no requests in the last hour/);
    expect(suggestRenames(p)).toEqual({ 'shop-worker': 'worker' });
  });

  it('finds the newest traffic when it came and went', async () => {
    const p = await probePrometheus({ url: `${base}/gappy` }, NOW);
    expect(Math.abs(Date.parse(p.data!.newest) / 1000 - (NOW - 10 * 3600))).toBeLessThan(600);
    expect(Math.abs(Date.parse(p.data!.oldestFound) / 1000 - (NOW - 26 * 3600))).toBeLessThan(1800);
    expect(p.warnings.join(' ')).toMatch(/comes and goes/);
  });

  it('asks Jaeger which services requests enter through', async () => {
    const j = await probeJaeger({ url: `${base}/jaeger` }, NOW);
    expect(j.services).toEqual(['api', 'loadgen']);
    expect(j.entry).toEqual(['api']);
    expect(j.clientsOnly).toEqual(['loadgen']);
  });

  it('connect_telemetry saves the connection, applies renames and says what is missing', async () => {
    const ws = new Workspace(mkdtempSync(join(tmpdir(), 'bn-ws-')));
    const r = await connectTelemetry(ws, { prometheus: { url: `${base}/prom`, tokenEnv: 'BN_TEST_TOKEN' }, jaeger: { url: `${base}/jaeger` } });
    // the token env var isn't set: say so instead of sending an empty header
    expect(r.ready).toBe(false);
    expect(r.problems.join(' ')).toMatch(/BN_TEST_TOKEN is not set/);
    process.env.BN_TEST_TOKEN = 'secret';
    const ok = await connectTelemetry(ws, { prometheus: { url: `${base}/prom`, tokenEnv: 'BN_TEST_TOKEN' } });
    expect(ok.ready).toBe(true);
    expect(ok.system.rename).toEqual({ 'shop-worker': 'worker' });
    expect(ok.system.entry).toEqual(['api']);
    expect(readFileSync(ws.path('sources.json'), 'utf8')).not.toContain('secret');
    rmSync(ws.dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------------------------
// the verdicts, on the recorded HotROD history

describe('verify_change on real history (HotROD)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bn-hotrod-'));
  const ws = new Workspace(dir);
  beforeAll(() => {
    copyFileSync('reference/hotrod/dataset.json', ws.path('dataset.json'));
    ws.saveSources({ system: { name: 'HotROD', slo: { p99Ms: 1000, errorRate: 0.03 }, timeoutMs: 5000 } } as never);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('calibrates with a trust report, reporting its phases', async () => {
    const phases: string[] = [];
    const c = await calibrateModel(ws, {}, async (m) => void phases.push(m));
    expect(phases).toHaveLength(3);
    const mysql = c.services.find((s) => s.service === 'mysql')!;
    expect(mysql.basis).toBe('limit seen in history');
    expect(mysql.cost).toMatch(/runs inside customer/);
    expect(c.services.find((s) => s.service === 'frontend')!.basis).toBe('extrapolated');
    expect(c.accuracy.length).toBe(1);
    expect(c.next).toBe('verify_change');
  }, 120_000);

  it('fails retries without a budget and passes Graviton, with evidence', async () => {
    const y = (f: string) => readFileSync(`reference/hotrod/strategies/${f}`, 'utf8');
    const r = verifyChange(ws, [{ strategy: y('2-graviton.yaml') }, { strategy: y('4-client-retries.yaml') }], { draws: 10 });
    const [grav, retry] = r.results;
    expect(retry.verdict).toBe('fail');
    expect(retry.reliability.minutesOutOfSloDelta.p50).toBeGreaterThan(3);
    expect(retry.reasons.join(' ')).toMatch(/adds .* min out of SLO/);
    expect(grav.verdict).not.toBe('fail');
    expect(grav.cost.monthlyDelta.p50).toBeLessThan(0);
    expect(grav.cost.basis).toBe('your bill');
    expect(['high', 'medium', 'low']).toContain(grav.confidence.level);
    expect(r.reports!.html).toMatch(/\.html$/);
    expect(readFileSync(r.reports!.html, 'utf8')).toContain('<html');
    // the app's workspace bundle, served on loopback to the app's origin only
    const bundle = JSON.parse(readFileSync(r.reports!.bundle, 'utf8'));
    expect(bundle.strategies).toHaveLength(2);
    expect(bundle.dataset.n).toBeGreaterThan(10);
    const link = await appLink(ws, r.reports!.bundle);
    expect(link).toMatch(/^http:\/\/localhost:5173\/#backtest=http%3A%2F%2F127\.0\.0\.1%3A\d+%2F.*\.bottleneck\.json$/);
    const url = decodeURIComponent(link.split('#backtest=')[1]);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect((await res.json()).model.name).toBe(bundle.model.name);
    expect((await fetch(url.replace(/[^/]+$/, 'sources.json'))).status).toBe(404);
  }, 120_000);

  it('flags a change that runs a service past anything the history showed', () => {
    const r = verifyChange(ws, [{ strategy: { name: 'Frontend on 0.02 cores', changes: [{ service: 'frontend', cpu: 0.02 }] } }], { draws: 5, report: false });
    const fe = r.results[0].confidence.services.find((s: { service: string }) => s.service === 'frontend')!;
    expect(fe.basis).toBe('beyond anything the history showed');
    expect(r.results[0].confidence.level).toBe('low');
    expect(r.results[0].verdict).not.toBe('pass');
  }, 120_000);

  it('verifies a Terraform plan, a manifest diff and edited manifests against the live cluster', async () => {
    writeFileSync(join(dir, 'plan.json'), JSON.stringify({ resource_changes: [{ address: 'aws_ecs_service.customer', type: 'aws_ecs_service', name: 'customer', change: { actions: ['update'], before: { name: 'customer', desired_count: 1 }, after: { name: 'customer', desired_count: 2 } } }] }));
    const deploy = (name: string, replicas: number, cpu: string) => `apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: ${name} }\nspec:\n  replicas: ${replicas}\n  template:\n    spec:\n      containers:\n        - name: ${name}\n          resources: { limits: { cpu: "${cpu}", memory: 128Mi } }\n`;
    const r = verifyChange(ws, [{ terraformPlan: join(dir, 'plan.json') }, { kubernetes: { base: deploy('customer', 1, '500m'), head: deploy('customer', 1, '250m') } }], { draws: 5, report: false });
    expect(r.results.map((x: { change: { changes: unknown[] } }) => x.change.changes[0])).toEqual([{ service: 'customer', replicas: 2 }, { service: 'customer', cpu: 0.25 }]);

    // a stub kubectl: read_cluster runs only `get … -o json` against the named context
    const kubectl = join(dir, 'kubectl');
    writeFileSync(join(dir, 'kubectl.log'), '');
    writeFileSync(kubectl, `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(join(dir, 'kubectl.log'))}, process.argv.slice(2).join(' ') + '\\n');\nconsole.log(JSON.stringify({ kind: 'List', items: [${JSON.stringify(JSON.stringify({ kind: 'Deployment', metadata: { name: 'customer' }, spec: { replicas: 1, template: { spec: { containers: [{ name: 'customer', resources: { limits: { cpu: '500m', memory: '128Mi' } } }] } } } }))}].map(JSON.parse) }));\n`);
    chmodSync(kubectl, 0o755);
    process.env.BOTTLENECK_KUBECTL = kubectl;
    await expect(readCluster(ws, { context: '' })).rejects.toThrow(/explicitly/);
    const snap = await readCluster(ws, { context: 'kind-test', namespace: 'shop' });
    expect(snap.workloads).toEqual([expect.objectContaining({ service: 'customer', replicas: 1, cpu: 0.5 })]);
    expect(readFileSync(join(dir, 'kubectl.log'), 'utf8').trim()).toBe('--context kind-test -n shop get deployments,statefulsets,horizontalpodautoscalers -o json --request-timeout=20s');
    const c = verifyChange(ws, [{ cluster: { head: deploy('customer', 3, '500m') } }], { draws: 5, report: false });
    expect(c.results[0].change.changes[0]).toEqual({ service: 'customer', replicas: 3 });
    delete process.env.BOTTLENECK_KUBECTL;
  }, 120_000);

  it('suggest_changes fixes what saturated and finds savings that pass together', async () => {
    const r = await suggestChanges(ws, { draws: 4 });
    expect(r.saturated.map((x) => x.service)).toContain('mysql');
    // mysql runs inside customer: the fix is more customer replicas, and it cuts failed requests
    const fix = r.fixes.find((f) => f.name.startsWith('customer: 1 → 2 replicas'))!;
    expect(fix).toBeTruthy();
    expect(fix.failedRequestsDelta).toBeLessThan(0);
    expect(r.savings.length).toBeGreaterThan(0);
    for (const s of r.savings) expect(s.verdict).toBe('pass');
    if (r.combinedSavings) expect(r.combinedSavings.monthlyDelta).toBeLessThanOrEqual(Math.min(...r.savings.map((s) => s.monthlyDelta)));
  }, 120_000);

  it('model_status says what the workspace holds and what to do next', () => {
    const s = modelStatus(ws) as { next: string; warnings: string[]; model: { trust: Record<'trusted' | 'caution' | 'untrusted', string[]> }; dataset: { window: { hours: number } } };
    expect(s.next).toBe('verify_change');
    // every service lands in one of the three lists
    expect(Object.values(s.model.trust).flat().join(' ')).toMatch(/mysql/);
    expect(s.dataset.window.hours).toBeCloseTo(0.7, 1);
    expect(Array.isArray(s.warnings)).toBe(true);
  });

  it('runs every tool through the shared registry (MCP and `bottleneck agent`)', async () => {
    expect(TOOLS.map((t) => t.name)).toEqual(['connect_telemetry', 'collect_telemetry', 'calibrate_model', 'model_status', 'verify_change', 'suggest_changes', 'find_headroom', 'verify_design', 'read_cluster']);
    const h = (await runTool('find_headroom', { workspace: dir, strategy: { name: 'x', changes: [{ service: 'customer', replicas: 2 }] } })) as { asBuilt: { rps: number; limitedBy: string } };
    expect(h.asBuilt.rps).toBeGreaterThan(3);
    await expect(runTool('nope', {})).rejects.toThrow(/no tool/);
  }, 120_000);
});

describe('strategy input from agents', () => {
  it('accepts the architecture spellings agents use', () => {
    const s = StrategySpec.parse({ name: 'g', changes: [{ service: 'a', arch: 'arm64' }, { service: 'b', arch: 'Graviton' }, { service: 'c', arch: 'amd64' }] });
    expect(s.changes.map((c) => ('arch' in c ? c.arch : null))).toEqual(['arm', 'arm', 'x86']);
  });

  it('says which field is wrong, and what the change takes', () => {
    const r = StrategySpec.safeParse({ name: 'r', changes: [{ endpoint: '*', retries: {} }] });
    expect(r.success).toBe(false);
    const msg = explainError(r.error);
    expect(msg).toMatch(/changes\.0\.retries\.attempts/);
    expect(msg).toMatch(/an endpoint change takes endpoint, retries \{ attempts, budget\? \}/);
    expect(msg).not.toMatch(/invalid_union/);
  });
});

describe('verify_design', () => {
  it('fails a single database at its limit and returns fixes as spec changes', () => {
    const r = verifyDesign(
      { name: 'shop', components: [{ id: 'users', kind: 'client' }, { id: 'lb', kind: 'lb' }, { id: 'api', kind: 'server', instances: 2 }, { id: 'db', kind: 'db' }], connections: [['users', 'lb'], ['lb', 'api'], ['api', 'db']] },
      { rps: 400 },
    ) as { verdict: string; findings: { severity: string; fixes: { changes: unknown[] }[] }[]; link: string };
    expect(['fail', 'pass with risks']).toContain(r.verdict);
    expect(r.findings.some((f) => f.fixes.some((x) => x.changes.length > 0))).toBe(true);
    expect(r.link).toMatch(/#spec=/);
  }, 120_000);

  it('rejects a spec that does not validate', () => {
    expect(verifyDesign({ name: 'x', components: [{ id: 'a', kind: 'nope' }], connections: [] }).verdict).toBe('fail');
  });
});
