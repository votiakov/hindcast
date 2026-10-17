// A Datadog API for the Datadog connector's golden cases, built from the documented request and
// response shapes only (docs.datadoghq.com/api/latest/metrics and /service-dependencies) — no live
// Datadog account was used to record it. It answers:
//   GET /api/v1/metrics?from=            { metrics: [...], from }
//   GET /api/v1/query?from=&to=&query=   { status, res_type, series: [{ metric, scope, tag_set, pointlist: [[ms, v]] … }] }
//   GET /api/v1/service_dependencies?env=&start=&end=   { service: { calls: [...] } }
// with DD-API-KEY and DD-APPLICATION-KEY required (403 otherwise). Queries are evaluated for real:
// `<space agg>:<metric>{tag:value,…} by {tags}` with .as_count() and .rollup(method, seconds); past
// 350 points the rollup is coarsened, as the docs say Datadog does.
// Worlds, by path prefix: /shop — APM in env prod (and a small staging), latency distributions, the
// Agent's kubelet and kube-state metrics, ingress-nginx, service dependencies; its first query is
// answered 429 with X-RateLimit-Reset, once. /nodeps — the same services with only the legacy
// trace.<span>.duration, the container check's metrics instead of kubelet's, no throttling, no ingress,
// and no service dependencies (404).
// Every value is a function of time alone, so two runs see the same history.
// node test/cli-fixtures/mock-datadog.mjs [port]   (default 19690; 0 for a free one, printed)
import { createServer } from 'node:http';

const NOW = 1_791_500_000;
const DAY = 86400;
const MI = 1024 * 1024;
// sine from + and × only, so every platform gets the same bits (Node's Math.sin can differ in the last
// bit between x64 and arm64, and a value on a rounding boundary then changes the golden outputs)
const sin = (x) => {
  x -= 2 * Math.PI * Math.floor(x / (2 * Math.PI) + 0.5);
  const x2 = x * x;
  let term = x, sum = x;
  for (let k = 1; k <= 12; k++) { term *= -x2 / ((2 * k) * (2 * k + 1)); sum += term; }
  return sum;
};
const load = (t) => 40 * (1 + 0.5 * sin((2 * Math.PI * (t % DAY)) / DAY)) + (Math.floor(t / 30) % 5) * 0.4;
const busy = (t) => t >= NOW - 2 * DAY && t <= NOW;

// latency in seconds, as the trace.<span> distribution reports it
const catalogMean = (L) => 0.004 + 0.00004 * L;
const cartMean = (L) => 0.006 + 0.00005 * L;
const frontMean = (L) => 0.02 + 0.0001 * L + 0.6 * cartMean(L) + 1.2 * catalogMean(L);

/** APM: one entry per span name × service × env × resource: requests/s, error ratio, mean and p99 (s) */
const APM = [
  ...[
    ['GET /', 0.5],
    ['GET /product/?', 0.35],
    ['POST /cart', 0.15],
  ].map(([r, k]) => ({ span: 'http.request', service: 'frontend', env: 'prod', resource: r, rate: (L) => k * L, err: () => (r === 'POST /cart' ? 0.01 : 0.001), mean: (L) => frontMean(L) * (r === 'GET /' ? 0.8 : 1.2), p99: (L) => 3 * frontMean(L) * (r === 'GET /' ? 0.8 : 1.2) })),
  { span: 'http.request', service: 'frontend', env: 'staging', resource: 'GET /', rate: () => 0.5, err: () => 0, mean: () => 0.03, p99: () => 0.09 },
  ...[
    ['/cart.CartService/GetCart', 0.4],
    ['/cart.CartService/AddItem', 0.2],
  ].map(([r, k]) => ({ span: 'grpc.server', service: 'cart', env: 'prod', resource: r, rate: (L) => k * L, err: () => 0.001, mean: cartMean, p99: (L) => 2.5 * cartMean(L) })),
  ...[
    ['GET /products', 0.7],
    ['GET /products/?', 0.5],
  ].map(([r, k]) => ({ span: 'http.request', service: 'catalog', env: 'prod', resource: r, rate: (L) => k * L, err: () => 0, mean: catalogMean, p99: (L) => 3 * catalogMean(L) })),
  // client spans: their trace metrics count calls made, not requests served
  { span: 'postgres.query', service: 'postgres', env: 'prod', resource: 'SELECT * FROM products WHERE id = ?', rate: (L) => 1.2 * L, err: () => 0, mean: () => 0.002, p99: () => 0.006 },
  { span: 'redis.command', service: 'redis', env: 'prod', resource: 'HGET', rate: (L) => 1.2 * L, err: () => 0, mean: () => 0.0005, p99: () => 0.001 },
];

/** pods: namespace, owner, cpu in cores at load L, limits and requests, memory, network, throttling */
const POD = (ns, owner, pod, x) => ({ ns, owner, pod, ...x });
const PODS = [
  ...['shop-frontend-6f7d8c9b5d-a1b2c', 'shop-frontend-6f7d8c9b5d-d3f4g'].map((p) => POD('shop', { kube_deployment: 'shop-frontend' }, p, { cpu: (L) => (0.08 + 0.003 * L) / 2, limit: 1, request: 0.5, mem: (L) => (220 + 0.4 * L) * MI, memLimit: 512 * MI, memRequest: 256 * MI, tx: (L) => 2000 * L, throttled: () => 0.005 })),
  POD('shop', { kube_deployment: 'cart' }, 'cart-58b9c7d6f4-h5j6k', { cpu: (L) => 0.02 + 0.005 * L, limit: 0.5, request: 0.25, mem: (L) => (140 + 0.3 * L) * MI, memLimit: 256 * MI, memRequest: 128 * MI, tx: (L) => 800 * L, throttled: (L) => Math.max(0.003, (0.02 + 0.005 * L) / 0.5 - 0.5) }),
  POD('shop', { kube_deployment: 'catalog' }, 'catalog-7c8d9f6b5c-m7n8p', { cpu: (L) => 0.02 + 0.004 * L, limit: 1, request: 0.5, mem: () => 180 * MI, memLimit: 512 * MI, memRequest: 256 * MI, tx: (L) => 3000 * L, throttled: () => 0.002 }),
  POD('shop', { kube_stateful_set: 'postgres' }, 'postgres-0', { cpu: (L) => 0.05 + 0.002 * L, limit: 2, request: 1, mem: () => 900 * MI, memLimit: 2048 * MI, memRequest: 1024 * MI, tx: (L) => 5000 * L, throttled: () => 0.001 }),
  // another system's job, and the Agent itself (a DaemonSet: no Deployment or StatefulSet tag)
  POD('jobs', { kube_deployment: 'batch-report' }, 'batch-report-5d6f7b8c9d-q1w2e', { cpu: () => 0.3, limit: 1, request: 1, mem: () => 300 * MI, memLimit: 1024 * MI, memRequest: 512 * MI, tx: () => 100, throttled: () => 0.001 }),
  POD('datadog', { kube_daemon_set: 'datadog-agent' }, 'datadog-agent-x7k2p', { cpu: () => 0.05, limit: 0.5, request: 0.2, mem: () => 200 * MI, memLimit: 512 * MI, memRequest: 256 * MI, tx: () => 500, throttled: () => 0.001 }),
];
const READY = [
  ['kubernetes_state.deployment.replicas_available', { kube_namespace: 'shop', kube_deployment: 'shop-frontend' }, 2],
  ['kubernetes_state.deployment.replicas_available', { kube_namespace: 'shop', kube_deployment: 'cart' }, 1],
  ['kubernetes_state.deployment.replicas_available', { kube_namespace: 'shop', kube_deployment: 'catalog' }, 1],
  ['kubernetes_state.deployment.replicas_available', { kube_namespace: 'jobs', kube_deployment: 'batch-report' }, 1],
  ['kubernetes_state.statefulset.replicas_ready', { kube_namespace: 'shop', kube_stateful_set: 'postgres' }, 1],
];
const DEPS = { frontend: { calls: ['cart', 'catalog'] }, cart: { calls: ['redis'] }, catalog: { calls: ['postgres'] }, postgres: { calls: [] }, redis: { calls: [] } };

const WORLDS = {
  shop: { distributions: true, kubelet: true, throttling: true, ingress: true, deps: true, limited: true },
  nodeps: { distributions: false, kubelet: false, throttling: false, ingress: false, deps: false, limited: false, envs: ['prod'] },
};

/**
 * every raw series of a world: [metric, tags, kind, f(t, interval, rollup)] where kind says how
 * space aggregation treats it ('count' per bucket, 'gauge', 'dist' a distribution's [rate, mean, p99])
 */
function raw(w) {
  const out = [];
  const apm = APM.filter((a) => !w.envs || w.envs.includes(a.env));
  for (const a of apm) {
    const tags = { service: a.service, env: a.env, resource_name: a.resource, resource: a.resource, version: '1.4.2' };
    out.push([`trace.${a.span}.hits`, tags, 'count', (t) => a.rate(load(t))]);
    out.push([`trace.${a.span}.errors`, tags, 'count', (t) => a.rate(load(t)) * a.err(load(t))]);
    // the legacy duration: the spans' total time per second
    out.push([`trace.${a.span}.duration`, tags, 'count', (t) => a.rate(load(t)) * a.mean(load(t))]);
    if (w.distributions) out.push([`trace.${a.span}`, tags, 'dist', (t) => [a.rate(load(t)), a.mean(load(t)), a.p99(load(t))]]);
  }
  for (const p of PODS) {
    const tags = { kube_namespace: p.ns, ...p.owner, pod_name: p.pod, kube_container_name: 'app' };
    const g = (m, f) => out.push([m, tags, 'gauge', f]);
    if (w.kubelet) {
      g('kubernetes.cpu.usage.total', (t) => p.cpu(load(t)) * 1e9);
      g('kubernetes.cpu.limits', () => p.limit);
      g('kubernetes.cpu.requests', () => p.request);
      g('kubernetes.memory.usage', (t) => p.mem(load(t)));
      g('kubernetes.memory.limits', () => p.memLimit);
      g('kubernetes.memory.requests', () => p.memRequest);
      g('kubernetes.network.tx_bytes', (t) => p.tx(load(t)));
    } else {
      g('container.cpu.usage', (t) => p.cpu(load(t)) * 1e9);
      g('container.cpu.limit', () => p.limit * 1e9);
      g('container.memory.usage', (t) => p.mem(load(t)));
      g('container.memory.limit', () => p.memLimit);
      out.push(['container.cpu.throttled.periods', tags, 'count', (t) => 10 * p.throttled(load(t))]);
    }
    if (w.throttling) {
      // CFS periods per second: ten at the default 100 ms period, the throttled share of them
      out.push(['kubernetes.cpu.cfs.periods', tags, 'count', () => 10]);
      out.push(['kubernetes.cpu.cfs.throttled.periods', tags, 'count', (t) => 10 * p.throttled(load(t))]);
    }
  }
  for (const [m, tags, v] of READY) out.push([m, tags, 'gauge', () => v]);
  if (w.ingress) {
    out.push(['nginx_ingress.controller.requests', { service: 'frontend', status: '200', kube_namespace: 'shop' }, 'count', (t) => 0.998 * load(t)]);
    out.push(['nginx_ingress.controller.requests', { service: 'frontend', status: '503', kube_namespace: 'shop' }, 'count', (t) => 0.002 * load(t)]);
  }
  return out;
}

/** `sum:metric{a:b,c:d} by {x,y}.as_count().rollup(sum, 60)` */
function parse(q) {
  const m = /^(\w+):([\w.]+)\{([^}]*)\}(?: by \{([^}]*)\})?((?:\.\w+\([^)]*\))*)$/.exec(q.trim());
  if (!m) return null;
  const filter = m[3].split(',').map((x) => x.trim()).filter((x) => x && x !== '*').map((x) => x.split(':'));
  const by = (m[4] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const mods = m[5] ?? '';
  const roll = /\.rollup\(([^)]*)\)/.exec(mods)?.[1].split(',').map((x) => x.trim());
  const method = roll && isNaN(Number(roll[0])) ? roll[0] : 'avg';
  const secs = roll ? Number(roll[roll.length - 1]) : NaN;
  return { agg: m[1], metric: m[2], filter, by, asCount: mods.includes('.as_count()'), method, secs: isNaN(secs) ? 0 : secs };
}

function evaluate(w, q, from, to) {
  const p = parse(q);
  if (!p) return { status: 400, body: { errors: [`Error parsing query: ${q}`] } };
  // the interval: what the rollup asks for, coarsened past 350 points
  let interval = p.secs || 60;
  if ((to - from) / interval > 350) interval = Math.ceil((to - from) / 350 / interval) * interval;
  const src = raw(w).filter(([m, tags]) => m === p.metric && p.filter.every(([k, v]) => tags[k] === v));
  const groups = new Map();
  for (const s of src) {
    const key = p.by.filter((k) => s[1][k] !== undefined).map((k) => `${k}:${s[1][k]}`);
    const k = key.join(',');
    if (!groups.has(k)) groups.set(k, { tags: key, members: [] });
    groups.get(k).members.push(s);
  }
  const series = [];
  for (const { tags, members } of [...groups.values()].sort((a, b) => a.tags.join().localeCompare(b.tags.join()))) {
    const pointlist = [];
    for (let t = Math.floor(from / interval) * interval; t < to; t += interval) {
      const mid = t + interval / 2;
      if (!busy(mid)) continue;
      const vals = members.map(([, , kind, f]) => {
        if (kind === 'dist') return f(mid);
        const v = f(mid);
        if (kind === 'count') return p.asCount || p.method === 'sum' ? v * interval : v;
        if (p.method === 'max') return v * 1.05;
        return v;
      });
      let v;
      if (members[0][2] === 'dist') {
        const total = vals.reduce((s, x) => s + x[0], 0);
        if (p.agg === 'avg') v = total > 0 ? vals.reduce((s, x) => s + x[0] * x[1], 0) / total : null;
        else if (p.agg.startsWith('p')) v = Math.max(...vals.map((x) => x[2]));
        else if (p.agg === 'count') v = total * interval;
        else v = null;
      } else if (p.agg === 'sum') v = vals.reduce((s, x) => s + x, 0);
      else if (p.agg === 'avg') v = vals.reduce((s, x) => s + x, 0) / vals.length;
      else if (p.agg === 'max') v = Math.max(...vals);
      else if (p.agg === 'min') v = Math.min(...vals);
      pointlist.push([t * 1000, v === null ? null : Math.round(v * 1e6) / 1e6]);
    }
    const scope = tags.length ? tags.join(',') : p.filter.map((x) => x.join(':')).join(',') || '*';
    series.push({
      aggr: p.agg, display_name: p.metric, end: (pointlist.at(-1)?.[0] ?? to * 1000) + interval * 1000 - 1000, expression: `${p.agg}:${p.metric}{${scope}}`,
      interval, length: pointlist.length, metric: p.metric, pointlist, query_index: 0, scope, start: pointlist[0]?.[0] ?? from * 1000, tag_set: tags, unit: null,
    });
  }
  return { status: 200, body: { status: 'ok', res_type: 'time_series', resp_version: 1, query: q, message: '', from_date: from * 1000, to_date: to * 1000, group_by: p.by, series } };
}

const limited = new Set();
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const [, world, ...rest] = u.pathname.split('/');
  const path = '/' + rest.join('/');
  const w = WORLDS[world];
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  if (!w) return send(404, { errors: ['Not found'] });
  if (!req.headers['dd-api-key'] || !req.headers['dd-application-key']) return send(403, { errors: ['Forbidden'] });
  const n = (k) => Number(u.searchParams.get(k));
  if (path === '/api/v1/metrics') {
    const names = [...new Set(raw(w).map((s) => s[0]))].sort();
    return send(200, { metrics: names, from: u.searchParams.get('from') });
  }
  if (path === '/api/v1/query') {
    // the first query of a world that is rate limited: 429, once
    if (w.limited && !limited.has(world)) {
      limited.add(world);
      return send(429, { errors: ['Too many requests'] }, { 'X-RateLimit-Limit': '1600', 'X-RateLimit-Period': '3600', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1', 'X-RateLimit-Name': 'query' });
    }
    if (!u.searchParams.get('query') || isNaN(n('from')) || isNaN(n('to'))) return send(400, { errors: ['from, to and query are required'] });
    const r = evaluate(w, u.searchParams.get('query'), n('from'), n('to'));
    return send(r.status, r.body);
  }
  if (path === '/api/v1/service_dependencies') {
    if (!w.deps) return send(404, { errors: ['Not found'] });
    if (!u.searchParams.get('env')) return send(400, { errors: ['env is required'] });
    if (u.searchParams.get('env') !== 'prod') return send(200, {});
    return send(200, DEPS);
  }
  send(404, { errors: ['Not found'] });
});
// port 0: a free one, announced on stdout (the golden scripts run several checkouts side by side)
server.listen(Number(process.argv[2] ?? 19690), '127.0.0.1', () => console.log(`listening on ${server.address().port}`));
