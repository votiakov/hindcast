// Prometheus servers with no traces behind them, for the quickstart-without-traces cases (served by
// mock-telemetry.mjs): /kps holds what kube-prometheus-stack and ingress-nginx export — no app metrics,
// no mesh; /istio and /linkerd hold the same cluster metrics plus a mesh's proxy metrics; /spanmetrics
// holds OpenTelemetry span metrics with the peer's address as a dimension, /spanmetrics-bare the same
// spans without it. Every series is a function of time alone, so two runs see the same history.
const NOW = 1_791_500_000;
const DAY = 86400;
const MI = 1024 * 1024;
/** requests per second through the front door: a day's curve and a little texture */
const load = (t) => 40 * (1 + 0.5 * Math.sin((2 * Math.PI * (t % DAY)) / DAY)) + (Math.floor(t / 30) % 5) * 0.4;
const busy = (t) => t >= NOW - 2 * DAY && t <= NOW;

// workload → pods, nodes, and its container metrics at load L
const WORLDS = {
  kps: {
    names: ['kube_pod_info', 'nginx_ingress_controller_requests', 'container_spec_cpu_quota'],
    workloads: {
      web: { ns: 'shop', pods: ['web-7d9f8b6c5d-x2x4z', 'web-7d9f8b6c5d-k8m2p'], nodes: ['node-a', 'node-b'], cpu: (L) => 0.06 + 0.004 * L, limit: 0.5, mem: (L) => 2 * (200 + 0.5 * L) * MI, memLimit: 512 * MI, throttled: () => 0.01 },
      api: { ns: 'shop', pods: ['api-5c6d7f8b9c-q7w2e'], nodes: ['node-a'], cpu: (L) => 0.02 + 0.0065 * L, limit: 0.5, mem: (L) => (150 + 1.2 * L) * MI, memLimit: 256 * MI, throttled: (L) => Math.max(0.003, ((0.02 + 0.0065 * L) / 0.5 - 0.55) * 1.2) },
      worker: { ns: 'shop', pods: ['worker-0'], nodes: ['node-b'], cpu: (L, t) => 0.05 + 0.01 * (Math.floor(t / 60) % 3), limit: 0.2, mem: () => 120 * MI, memLimit: 256 * MI, throttled: () => 0.002 },
      'ingress-nginx-controller': { ns: 'ingress-nginx', pods: ['ingress-nginx-controller-6b7c8d9f5d-zz2xq'], nodes: ['node-a'], cpu: (L) => 0.01 + 0.001 * L, limit: 1, mem: () => 90 * MI, memLimit: 512 * MI, throttled: () => 0.001 },
    },
    // what the ingress saw per Service: req/s, error ratio, p99 and mean in seconds
    ingress: { web: { rps: (L) => L, errors: () => 0.001, p99: (L) => 0.12 + 0.004 * Math.max(0, L - 50), mean: (L) => 0.045 + 0.0005 * L } },
  },
  istio: {
    names: ['kube_pod_info', 'istio_requests_total', 'container_spec_cpu_quota'],
    workloads: {
      frontend: { ns: 'shop', pods: ['frontend-6f7d8c9b5d-a1b2c', 'frontend-6f7d8c9b5d-d3f4g'], nodes: ['node-a', 'node-b'], cpu: (L) => 0.08 + 0.003 * L, limit: 1, mem: (L) => 2 * (220 + 0.4 * L) * MI, memLimit: 512 * MI, throttled: () => 0.005 },
      cart: { ns: 'shop', pods: ['cart-58b9c7d6f4-h5j6k'], nodes: ['node-a'], cpu: (L) => 0.02 + 0.005 * L, limit: 0.5, mem: (L) => (140 + 0.3 * L) * MI, memLimit: 256 * MI, throttled: (L) => Math.max(0.003, ((0.02 + 0.005 * L) / 0.5 - 0.5)) },
      catalog: { ns: 'shop', pods: ['catalog-7c8d9f6b5c-m7n8p'], nodes: ['node-b'], cpu: (L) => 0.02 + 0.004 * L, limit: 1, mem: () => 180 * MI, memLimit: 512 * MI, throttled: () => 0.002 },
      'istio-ingressgateway': { ns: 'istio-system', pods: ['istio-ingressgateway-5d6f7b8c9d-q1w2e'], nodes: ['node-a'], cpu: (L) => 0.02 + 0.001 * L, limit: 2, mem: () => 100 * MI, memLimit: 1024 * MI, throttled: () => 0.001 },
    },
    // the sidecars' view: calls between workloads, and what each served (latency in ms)
    edges: [
      { from: 'istio-ingressgateway', to: 'frontend', protocol: 'http', rate: (L) => L },
      { from: 'frontend', to: 'cart', protocol: 'grpc', rate: (L) => L },
      { from: 'frontend', to: 'catalog', protocol: 'http', rate: (L) => 2 * L },
    ],
    served: {
      catalog: { rps: (L) => 2 * L, mean: (L) => 4 + 0.04 * L },
      cart: { rps: (L) => L, mean: (L) => 6 + 0.05 * L },
      frontend: { rps: (L) => L, mean: (L) => 20 + 0.1 * L + (6 + 0.05 * L) + 2 * (4 + 0.04 * L) },
    },
  },
  // Linkerd: outbound counters name the destination; users is a StatefulSet; gRPC shows as grpc_status
  linkerd: {
    names: ['kube_pod_info', 'response_total', 'container_spec_cpu_quota'],
    workloads: {
      web: { ns: 'shop', kind: 'deployment', pods: ['web-6d7f8c9b5d-p1q2r', 'web-6d7f8c9b5d-s3t4u'], nodes: ['node-a', 'node-b'], cpu: (L) => 0.05 + 0.003 * L, limit: 1, mem: (L) => 2 * (200 + 0.3 * L) * MI, memLimit: 512 * MI, throttled: () => 0.004 },
      orders: { ns: 'shop', kind: 'deployment', pods: ['orders-7f8d9c6b5d-v5w6x'], nodes: ['node-a'], cpu: (L) => 0.02 + 0.004 * L, limit: 0.5, mem: (L) => (160 + 0.2 * L) * MI, memLimit: 256 * MI, throttled: () => 0.003 },
      users: { ns: 'shop', kind: 'statefulset', pods: ['users-0'], nodes: ['node-b'], cpu: (L) => 0.03 + 0.002 * L, limit: 1, mem: () => 300 * MI, memLimit: 1024 * MI, throttled: () => 0.002 },
      'ingress-nginx-controller': { ns: 'ingress-nginx', kind: 'deployment', pods: ['ingress-nginx-controller-6b7c8d9f5d-zz2xq'], nodes: ['node-a'], cpu: (L) => 0.01 + 0.001 * L, limit: 1, mem: () => 90 * MI, memLimit: 512 * MI, throttled: () => 0.001 },
    },
    edges: [
      { from: 'ingress-nginx-controller', to: 'web', protocol: 'http', rate: (L) => L },
      { from: 'web', to: 'orders', protocol: 'grpc', rate: (L) => L },
      { from: 'orders', to: 'users', protocol: 'http', rate: (L) => 3 * L },
    ],
    served: {
      users: { rps: (L) => 3 * L, mean: (L) => 2 + 0.02 * L },
      orders: { rps: (L) => L, mean: (L) => 5 + 0.04 * L + 3 * (2 + 0.02 * L) },
      web: { rps: (L) => L, mean: (L) => 25 + 0.1 * L + (5 + 0.04 * L + 3 * (2 + 0.02 * L)) },
    },
  },
  // OpenTelemetry span metrics, no traces: frontend calls catalog over gRPC (client and server spans
  // share the RPC name) and cart over HTTP (a client span named "GET" alone); cart calls redis, which
  // has no spans of its own; frontend calls Stripe. Where the connector keeps the peer's address as a
  // dimension (server.address, net.peer.name, peer.service) it names the callee
  spanmetrics: {
    names: ['kube_pod_info', 'traces_span_metrics_calls_total', 'container_spec_cpu_quota'],
    peer: true,
    workloads: {
      frontend: { ns: 'shop', pods: ['frontend-6f7d8c9b5d-a1b2c', 'frontend-6f7d8c9b5d-d3f4g'], nodes: ['node-a', 'node-b'], cpu: (L) => 0.08 + 0.003 * L, limit: 1, mem: (L) => 2 * (220 + 0.4 * L) * MI, memLimit: 512 * MI, throttled: () => 0.005 },
      cart: { ns: 'shop', pods: ['cart-58b9c7d6f4-h5j6k'], nodes: ['node-a'], cpu: (L) => 0.02 + 0.005 * L, limit: 0.5, mem: (L) => (140 + 0.3 * L) * MI, memLimit: 256 * MI, throttled: () => 0.003 },
      catalog: { ns: 'shop', pods: ['catalog-7c8d9f6b5c-m7n8p'], nodes: ['node-b'], cpu: (L) => 0.02 + 0.004 * L, limit: 1, mem: () => 180 * MI, memLimit: 512 * MI, throttled: () => 0.002 },
      redis: { ns: 'shop', pods: ['redis-0'], nodes: ['node-b'], cpu: (L) => 0.01 + 0.002 * L, limit: 0.5, mem: () => 60 * MI, memLimit: 256 * MI, throttled: () => 0.001 },
    },
    // server spans: what each service answered, by span name (latency in ms)
    servers: {
      frontend: { span: 'GET /', rps: (L) => L, mean: (L) => 20 + 0.1 * L + (6 + 0.05 * L + 2 * (0.5 + 0.005 * L)) + 2 * (4 + 0.04 * L) + 0.1 * 80 },
      cart: { span: 'GET /cart', rps: (L) => L, mean: (L) => 6 + 0.05 * L + 2 * (0.5 + 0.005 * L) },
      catalog: { span: 'oteldemo.CatalogService/ListProducts', rps: (L) => 2 * L, mean: (L) => 4 + 0.04 * L },
    },
    // client spans: caller, span name, the peer dimensions it carries, calls per second and ms per call
    clients: [
      { from: 'frontend', span: 'oteldemo.CatalogService/ListProducts', peer: {}, rate: (L) => 2 * L, ms: (L) => 4 + 0.04 * L },
      { from: 'frontend', span: 'GET', peer: { server_address: 'cart.shop.svc.cluster.local:8080' }, rate: (L) => L, ms: (L) => 6 + 0.05 * L + 2 * (0.5 + 0.005 * L) },
      { from: 'frontend', span: 'POST', peer: { peer_service: 'stripe', server_address: 'api.stripe.com:443' }, rate: (L) => 0.1 * L, ms: () => 80 },
      { from: 'cart', span: 'HGET', peer: { net_peer_name: 'redis' }, rate: (L) => 2 * L, ms: (L) => 0.5 + 0.005 * L },
    ],
  },
};
// the same spans with the connector's default dimensions: no peer address on any of them
WORLDS['spanmetrics-bare'] = { ...WORLDS.spanmetrics, peer: false };
/** a client span's labels, keeping the peer dimensions the query groups by and the world exports */
const clientLabels = (w, c, q) => ({ service_name: c.from, span_name: c.span, ...Object.fromEntries(Object.entries(w.peer ? c.peer : {}).filter(([k]) => by(q, true).includes(k))) });
/** Linkerd's labels for a workload, by its kind, on either end of a call */
const lk = (w, id, pre = '') => ({ [`${pre}${w.workloads[id]?.kind ?? 'deployment'}`]: id });

/** the first label a query groups by, or all of them */
const by = (q, all = false) => {
  const l = (/by \(([^)]*)\)/.exec(q)?.[1] ?? '').split(',').map((x) => x.trim());
  return all ? l : l[0] ?? '';
};
const workloads = (w) => Object.entries(w.workloads);
const app = (w) => workloads(w).filter(([, x]) => x.ns === 'shop');

/** the value of one range query's series at t: [labels, value] pairs */
function at(w, q, t) {
  const L = load(t);
  const per = (f) => app(w).map(([id, x]) => [{ [by(q)]: id }, f(x, id)]);
  if (q.includes('nginx_ingress_controller')) {
    const s = Object.entries(w.ingress ?? {});
    const v = (k) => s.map(([id, x]) => [{ exported_service: id }, x[k](L)]);
    if (q.includes('histogram_quantile')) return v('p99');
    if (q.includes('_sum')) return v('mean');
    if (q.includes('status=~')) return v('errors');
    return v('rps');
  }
  if (q.includes('traces_span_metrics')) {
    // per endpoint: none here, so each service is one endpoint
    if (q.includes('span_name')) return [];
    if (q.includes('SPAN_KIND_CLIENT')) {
      // what each caller's client spans took: ms per second
      const out = new Map();
      for (const c of w.clients) out.set(c.from, (out.get(c.from) ?? 0) + c.rate(L) * c.ms(L));
      return [...out].map(([id, v]) => [{ service_name: id }, v]);
    }
    const s = Object.entries(w.servers);
    const v = (f) => s.map(([id, x]) => [{ service_name: id }, f(x)]);
    if (q.includes('STATUS_CODE_ERROR')) return v(() => 0.001);
    if (q.includes('histogram_quantile(0.99')) return v((x) => x.mean(L) * 2.5);
    if (q.includes('histogram_quantile(0.5')) return v((x) => x.mean(L) * 0.8);
    if (q.includes('_sum')) return v((x) => x.mean(L));
    return v((x) => x.rps(L));
  }
  if (q.includes('response_total') || q.includes('response_latency_ms')) {
    if (q.includes('direction="outbound"')) {
      const out = new Map();
      for (const e of w.edges) out.set(e.from, (out.get(e.from) ?? 0) + e.rate(L) * w.served[e.to].mean(L));
      return [...out].map(([id, v]) => [{ workload: id }, v]);
    }
    const s = Object.entries(w.served ?? {});
    const v = (f) => s.map(([id, x]) => [{ workload: id }, f(x)]);
    if (q.includes('histogram_quantile')) return v((x) => x.mean(L) * 2.5);
    if (q.includes('_sum')) return v((x) => x.mean(L));
    if (q.includes('classification="failure"')) return v(() => 0.001);
    return v((x) => x.rps(L));
  }
  if (q.includes('istio_') && q.includes('reporter="source"')) {
    // what each caller's sidecar timed of its calls: ms per second
    const out = new Map();
    for (const e of w.edges) out.set(e.from, (out.get(e.from) ?? 0) + e.rate(L) * w.served[e.to].mean(L));
    return [...out].map(([id, v]) => [{ source_workload: id }, v]);
  }
  if (q.includes('istio_')) {
    const s = Object.entries(w.served ?? {});
    const v = (f) => s.map(([id, x]) => [{ destination_workload: id }, f(x)]);
    if (q.includes('histogram_quantile')) return v((x) => x.mean(L) * 2.5);
    if (q.includes('_sum')) return v((x) => x.mean(L));
    if (q.includes('response_code=~')) return v(() => 0.002);
    return v((x) => x.rps(L));
  }
  if (q.includes('container_cpu_cfs_throttled')) return per((x) => x.throttled(L, t));
  if (q.includes('container_cpu_usage_seconds_total')) return per((x) => x.cpu(L, t));
  if (q.includes('kube_pod_container_resource_limits{resource="cpu"')) return per((x) => x.limit);
  if (q.includes('kube_pod_status_ready')) return per((x) => x.pods.length);
  if (q.includes('container_network_transmit')) return per((x) => 1000 + 200 * L);
  if (q.includes('max_over_time(container_memory_working_set_bytes')) return per((x) => x.mem(L, t) / x.pods.length * 1.05);
  if (q.includes('container_memory_working_set_bytes')) return per((x) => x.mem(L, t));
  if (q.includes('kube_pod_container_resource_limits{resource="memory"')) return per((x) => x.memLimit);
  if (q.startsWith('max by (workload)') && q.includes('resource="cpu"')) return per((x) => x.limit / 2);
  if (q.startsWith('max by (workload)') && q.includes('resource="memory"')) return per((x) => x.memLimit / 2);
  if (q.startsWith('count(kube_node_info')) return [[{}, 2]];
  if (q.includes('kube_node_status_allocatable{resource="cpu"')) return [[{}, 4]];
  if (q.includes('kube_node_status_allocatable{resource="memory"')) return [[{}, 16 * 1024 * MI]];
  if (q.includes('kube_pod_container_resource_requests{resource="cpu"')) return [[{}, 2.5]];
  if (q.includes('kube_pod_container_resource_requests{resource="memory"')) return [[{}, 3 * 1024 * MI]];
  return [];
}

/** a rate's increase over [t − w, t]: the area under it, a minute at a time */
const area = (rate, t, w) => {
  let s = 0;
  for (let x = t - w + 30; x <= t; x += 60) s += busy(x) ? rate(load(x)) * 60 : 0;
  return s;
};

export function promOnly(kind, path, params, send) {
  const w = WORLDS[kind];
  if (path === '/api/v1/status/buildinfo') return send({ status: 'success', data: { version: '2.54.1' } });
  if (path === '/api/v1/label/__name__/values') return send({ status: 'success', data: w.names });
  const lv = /^\/api\/v1\/label\/([^/]+)\/values$/.exec(path)?.[1];
  if (lv === 'pod') return send({ status: 'success', data: workloads(w).flatMap(([, x]) => x.pods) });
  if (lv === 'exported_service') return send({ status: 'success', data: Object.keys(w.ingress ?? {}) });
  if (lv === 'destination_workload' && kind === 'istio') return send({ status: 'success', data: Object.keys(w.served ?? {}).sort() });
  if (lv === 'deployment' && kind === 'linkerd') return send({ status: 'success', data: workloads(w).filter(([, x]) => x.kind === 'deployment').map(([id]) => id).sort() });
  if (lv === 'service_name' && w.servers) return send({ status: 'success', data: Object.keys(w.servers).sort() });
  // the peer dimensions client spans carry, where the connector keeps them
  if (lv && w.clients && w.peer) return send({ status: 'success', data: [...new Set(w.clients.map((c) => c.peer[lv]).filter(Boolean))].sort() });
  if (lv) return send({ status: 'success', data: [] });
  const q = params.get('query') ?? '';
  const vector = (rows, t) => send({ status: 'success', data: { resultType: 'vector', result: rows.map(([metric, v]) => ({ metric, value: [t, String(v)] })) } });
  if (path === '/api/v1/query') {
    const t = Number(params.get('time'));
    const win = Number(/\[(\d+)s\]/.exec(q)?.[1] ?? 0);
    if (q.startsWith('group by (namespace, workload)')) return vector(workloads(w).map(([id, x]) => [{ namespace: x.ns, workload: id }, 1]), t);
    // the probe: is there traffic at t
    if (q.startsWith('sum(increase(')) return vector(busy(t) ? [[{}, load(t) * 600]] : [], t);
    if (q.includes('increase(traces_span_metrics_calls_total') && q.includes('SPAN_KIND_CLIENT')) return vector(w.clients.map((c) => [clientLabels(w, c, q), area(c.rate, t, win)]), t);
    if (q.includes('increase(traces_span_metrics_calls_total')) return vector(Object.entries(w.servers).map(([id, x]) => [{ service_name: id, span_name: x.span }, area(x.rps, t, win)]), t);
    if (q.includes('last_over_time(traces_span_metrics_calls_total')) return vector(Object.entries(w.servers).map(([id, x]) => [{ service_name: id, span_name: x.span }, 1]), t);
    if (q.includes('increase(istio_requests_total')) return vector((w.edges ?? []).map((e) => [{ source_workload: e.from, destination_workload: e.to, request_protocol: e.protocol }, area(e.rate, t, win)]), t);
    if (q.includes('increase(response_total') && q.includes('direction="outbound"'))
      return vector((w.edges ?? []).map((e) => [{ ...lk(w, e.from), ...lk(w, e.to, 'dst_'), ...(e.protocol === 'grpc' ? { grpc_status: '0' } : {}) }, area(e.rate, t, win)]), t);
    if (q.includes('increase(response_total')) return vector(Object.entries(w.served ?? {}).map(([id, x]) => [lk(w, id), area(x.rps, t, win)]), t);
    if (q.includes('increase(nginx_ingress_controller_requests')) return vector(Object.entries(w.ingress ?? {}).map(([id, x]) => [{ exported_service: id }, area(x.rps, t, win)]), t);
    if (q.startsWith('count by (workload, node)')) return vector(workloads(w).flatMap(([id, x]) => x.nodes.map((node) => [{ workload: id, node }, 1])), t);
    if (q === 'kube_node_info') return vector(['node-a', 'node-b'].map((node, k) => [{ node, provider_id: `aws:///us-east-1${'ab'[k]}/i-0${k}` }, 1]), t);
    return vector([], t);
  }
  if (path === '/api/v1/query_range') {
    const [a, b, st] = ['start', 'end', 'step'].map((k) => parseFloat(params.get(k)));
    const series = new Map();
    for (let t = a; t <= b; t += st) {
      if (!busy(t)) continue;
      for (const [metric, v] of at(w, q, t)) {
        const k = JSON.stringify(metric);
        if (!series.has(k)) series.set(k, { metric, values: [] });
        series.get(k).values.push([t, String(Math.round(v * 1e6) / 1e6)]);
      }
    }
    return send({ status: 'success', data: { resultType: 'matrix', result: [...series.values()] } });
  }
  return null;
}
