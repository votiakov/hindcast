// A stand-in Prometheus for the CLI parity harness: query_range answers derived from the query
// text alone (so two runs see the same data); a query mentioning "nginx" finds nothing.
import { createServer } from 'node:http';

const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.endsWith('/api/v1/query_range')) {
    const q = u.searchParams.get('query') ?? '';
    const start = Number(u.searchParams.get('start'));
    const end = Number(u.searchParams.get('end'));
    const step = parseFloat(u.searchParams.get('step') ?? '60');
    if (q.includes('nginx')) return res.end(JSON.stringify({ status: 'success', data: { resultType: 'matrix', result: [] } }));
    const by = /by \(([^)]*)\)/.exec(q)?.[1]?.split(',')[0]?.trim() || 'job';
    const result = ['frontend', 'cart', 'db'].map((name, k) => {
      const values = [];
      for (let t = start; t <= end; t += step) values.push([t, String(((hash(q) % 997) / 10 + k * 1.5 + ((t / step) % 7) * 0.25).toFixed(3))]);
      return { metric: { [by]: name, ...(k === 1 ? { extra: 'x' } : {}) }, values };
    });
    return res.end(JSON.stringify({ status: 'success', data: { resultType: 'matrix', result } }));
  }
  res.statusCode = 404;
  res.end('not found');
});
// port 0: a free one, announced on stdout (the golden scripts run several checkouts side by side)
server.listen(Number(process.argv[2] ?? 19090), '127.0.0.1', () => console.log(`listening on ${server.address().port}`));
