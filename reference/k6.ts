import { quantile } from '../src/backtest/dataset';
import { csvObjects } from '../src/backtest/import/csv';

/**
 * k6 CSV output → long-format endpoint series (what a load balancer's access metrics would show):
 * per bucket and endpoint, req/s, error rate (non-2xx/3xx or timeout) and latency quantiles.
 * The k6 request tag `name` is the endpoint id, e.g. "frontend GET /dispatch".
 */
export function k6ToLongCsv(text: string, opts: { stepS: number }): string {
  const cells = new Map<string, { n: number; failed: number; dur: number[] }>();
  for (const r of csvObjects(text)) {
    if (r.metric_name !== 'http_req_duration' && r.metric_name !== 'http_req_failed') continue;
    const t = Math.floor(Number(r.timestamp) / opts.stepS) * opts.stepS;
    const key = `${t}|${r.name}`;
    const c = cells.get(key) ?? cells.set(key, { n: 0, failed: 0, dur: [] }).get(key)!;
    if (r.metric_name === 'http_req_duration') {
      c.dur.push(Number(r.metric_value));
      c.n++;
    } else c.failed += Number(r.metric_value);
  }
  const rows = ['timestamp,service,endpoint,metric,value'];
  for (const [key, c] of [...cells].sort()) {
    const [t, name] = key.split('|');
    const service = name.split(' ')[0];
    const d = c.dur.sort((a, b) => a - b);
    const put = (m: string, v: number) => rows.push(`${t},${service},"${name}",${m},${Math.round(v * 1000) / 1000}`);
    put('rps', c.n / opts.stepS);
    put('errorRate', c.n ? c.failed / c.n : 0);
    put('meanMs', d.reduce((a, x) => a + x, 0) / Math.max(1, d.length));
    put('p50Ms', quantile(d, 0.5));
    put('p99Ms', quantile(d, 0.99));
  }
  return rows.join('\n') + '\n';
}
