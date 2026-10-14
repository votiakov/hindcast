// Fetching an export plan from a live Prometheus, for the reference recorders. The plan itself (the
// queries) comes from the engine: src/backtest/import/promql.ts.
import type { ExportPlan } from '../src/backtest/import/promql';

/** run the plan against a live Prometheus (Node or browser fetch). Long ranges are split into
 *  chunks under Prometheus' 11,000 points per series and stitched back together. */
export async function runExport(url: string, plan: ExportPlan[], range: { start: number; end: number; stepS: number }, write: (file: string, body: string) => void, headers: Record<string, string> = {}) {
  const out: { file: string; series: number }[] = [];
  const span = 10_000 * range.stepS;
  for (const p of plan) {
    const merged = new Map<string, { metric: Record<string, string>; values: [number, string][] }>();
    for (let t0 = range.start; t0 < range.end || t0 === range.start; t0 += span) {
      const t1 = Math.min(range.end, t0 + span - range.stepS);
      // relative to the base URL, so path prefixes (Thanos, Mimir's /prometheus) survive
      const u = new URL('api/v1/query_range', url.endsWith('/') ? url : url + '/');
      u.searchParams.set('query', p.query.query);
      u.searchParams.set('start', String(t0));
      u.searchParams.set('end', String(Math.max(t0, t1)));
      u.searchParams.set('step', `${range.stepS}s`);
      const r = await fetch(u, { headers });
      if (!r.ok) throw new Error(`${p.query.file}: Prometheus answered ${r.status} ${await r.text()}`);
      const body = (await r.json()) as { data?: { result?: { metric: Record<string, string>; values?: [number, string][] }[] } };
      for (const series of body.data?.result ?? []) {
        const key = JSON.stringify(series.metric);
        const m = merged.get(key) ?? merged.set(key, { metric: series.metric, values: [] }).get(key)!;
        m.values.push(...(series.values ?? []));
      }
      if (t1 >= range.end) break;
    }
    write(p.query.file, JSON.stringify({ status: 'success', data: { resultType: 'matrix', result: [...merged.values()] } }));
    out.push({ file: p.query.file, series: merged.size });
  }
  return out;
}
