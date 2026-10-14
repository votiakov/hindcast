// Stand-in telemetry for the agent parity cases (the routes of test/agent.test.ts): Prometheus under
// /prom (and /gappy: two busy stretches), Jaeger under /jaeger, Tempo under /tempo. NOW = 1_791_500_000.
import { createServer } from 'node:http';

const NOW = 1_791_500_000;
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (v) => res.end(JSON.stringify(v));
  if (u.pathname.startsWith('/gappy/')) u.pathname = u.pathname.replace('/gappy/', '/prom/');
  const gappy = req.url.startsWith('/gappy/');
  if (u.pathname === '/prom/api/v1/status/buildinfo') return send({ status: 'success', data: { version: '2.54.1' } });
  if (u.pathname === '/prom/api/v1/label/__name__/values') return send({ status: 'success', data: ['traces_span_metrics_calls_total', 'container_spec_cpu_quota', 'calls_total', 'kube_pod_info'] });
  if (u.pathname === '/prom/api/v1/label/service_name/values') return send({ status: 'success', data: ['api', 'worker'] });
  if (u.pathname === '/prom/api/v1/label/container_label_com_docker_compose_service/values') return send({ status: 'success', data: ['api', 'shop-worker'] });
  if (u.pathname === '/prom/api/v1/label/pod/values') return send({ status: 'success', data: ['api-7d9f8b6c5d-x2x4z', 'worker-0'] });
  if (u.pathname === '/prom/api/v1/query') {
    const q = u.searchParams.get('query') ?? '';
    const t = Number(u.searchParams.get('time'));
    if (q.startsWith('group by (namespace, workload)')) return send({ status: 'success', data: { resultType: 'vector', result: [{ metric: { namespace: 'shop', workload: 'api' }, value: [t, '1'] }, { metric: { namespace: 'shop', workload: 'worker' }, value: [t, '1'] }, { metric: { namespace: 'kube-system', workload: 'coredns' }, value: [t, '1'] }] } });
    const on = gappy ? (t <= NOW - 10 * 3600 && t >= NOW - 12 * 3600) || (t <= NOW - 23 * 3600 && t >= NOW - 26 * 3600) : t <= NOW - 2 * 3600 && t >= NOW - 30 * 3600;
    return send({ status: 'success', data: { resultType: 'vector', result: on ? [{ metric: {}, value: [t, '1200'] }] : [] } });
  }
  if (u.pathname === '/prom/api/v1/query_range') {
    const [a, b, st] = ['start', 'end', 'step'].map((k) => parseFloat(u.searchParams.get(k)));
    const values = [];
    for (let t = a; t <= b; t += st) values.push([t, '1']);
    return send({ status: 'success', data: { resultType: 'matrix', result: [{ metric: { service_name: 'api' }, values }] } });
  }
  if (u.pathname === '/broken/api/v1/label/__name__/values') {
    res.statusCode = 503;
    return res.end('service unavailable: the TSDB is compacting');
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
  if (u.pathname === '/tempo/api/search/tag/service.name/values') return send({ tagValues: [{ value: 'api' }, { value: 'db' }] });
  if (u.pathname === '/tempo/api/search') return send({ traces: [{ traceID: 't1' }, { traceID: 't2' }] });
  if (u.pathname.startsWith('/tempo/api/traces/')) {
    const id = u.pathname.split('/').pop();
    return send({ batches: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'api' } }] }, scopeSpans: [{ spans: [{ traceId: id, spanId: 'a', name: 'GET /y', kind: 2, startTimeUnixNano: '1791490000000000000', endTimeUnixNano: '1791490000050000000' }, { traceId: id, spanId: 'b', parentSpanId: 'a', name: 'SELECT', kind: 3, startTimeUnixNano: '1791490000010000000', endTimeUnixNano: '1791490000040000000', attributes: [{ key: 'db.system', value: { stringValue: 'postgresql' } }] }] }] }] });
  }
  res.statusCode = 404;
  res.end('not found');
});
server.listen(Number(process.argv[2] ?? 19091), '127.0.0.1');
