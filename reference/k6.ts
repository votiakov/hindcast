import { quantile } from '../src/backtest/dataset';
import { readLines } from '../scripts/files';

/**
 * k6 CSV output (streamed — Poisson thinning makes it large) → what the reference runs keep:
 *  - every request: time, duration, failed, endpoint (`requests.csv`, the ground truth for accuracy)
 *  - long-format endpoint series, as a load balancer's access metrics would show them (`client.csv`)
 * The k6 request tag `name` is the endpoint id, e.g. "frontend GET /dispatch".
 */

export interface Request {
  t: number;
  ms: number;
  failed: boolean;
  endpoint: string;
}

export function readK6(path: string): Request[] {
  const out: Request[] = [];
  let head: string[] | null = null;
  let iName = -1;
  let iMetric = -1;
  let iT = -1;
  let iV = -1;
  let pending: Request | null = null;
  for (const line of readLines(path)) {
    if (!head) {
      head = line.split(',');
      iName = head.indexOf('name');
      iMetric = head.indexOf('metric_name');
      iT = head.indexOf('timestamp');
      iV = head.indexOf('metric_value');
      continue;
    }
    // only request rows matter; skip the per-iteration noise cheaply
    if (!line.startsWith('http_req_duration') && !line.startsWith('http_req_failed')) continue;
    const f = line.split(',');
    if (f[iMetric] === 'http_req_duration') {
      if (pending) out.push(pending);
      pending = { t: Number(f[iT]), ms: Number(f[iV]), failed: false, endpoint: f[iName] };
    } else if (pending) {
      pending.failed = Number(f[iV]) > 0;
      out.push(pending);
      pending = null;
    }
  }
  if (pending) out.push(pending);
  return out;
}

export function requestsCsv(reqs: Request[]): string {
  return 't,ms,failed,endpoint\n' + reqs.map((r) => `${r.t},${r.ms.toFixed(1)},${r.failed ? 1 : 0},"${r.endpoint}"`).join('\n') + '\n';
}

export function clientCsv(reqs: Request[], stepS: number): string {
  const cells = new Map<string, { n: number; failed: number; dur: number[] }>();
  for (const r of reqs) {
    const key = `${Math.floor(r.t / stepS) * stepS}|${r.endpoint}`;
    const c = cells.get(key) ?? cells.set(key, { n: 0, failed: 0, dur: [] }).get(key)!;
    c.n++;
    c.failed += r.failed ? 1 : 0;
    c.dur.push(r.ms);
  }
  const rows = ['timestamp,service,endpoint,metric,value'];
  for (const [key, c] of [...cells].sort()) {
    const [t, name] = key.split('|');
    const service = name.split(' ')[0];
    const d = c.dur.sort((a, b) => a - b);
    const put = (m: string, v: number) => rows.push(`${t},${service},"${name}",${m},${Math.round(v * 1000) / 1000}`);
    put('rps', c.n / stepS);
    put('errorRate', c.n ? c.failed / c.n : 0);
    put('meanMs', d.reduce((a, x) => a + x, 0) / Math.max(1, d.length));
    put('p50Ms', quantile(d, 0.5));
    put('p99Ms', quantile(d, 0.99));
  }
  return rows.join('\n') + '\n';
}
