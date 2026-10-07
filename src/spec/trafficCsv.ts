/**
 * Traffic from a metrics export: CSV / TSV with a time column and a request-rate column
 * (Prometheus, CloudWatch, Datadog exports all fit). Times may be seconds, epoch seconds/ms or
 * ISO timestamps; rates are req/s (or per-minute counts with `perMinute`).
 * Long series are compressed in time to keep a run watchable — the factor is reported.
 */

export interface TrafficSeries {
  traffic: { at: number; rps: number }[];
  /** real seconds per simulated second (1 = real time) */
  compression: number;
  spanS: number;
  peak: number;
}

function parseTime(v: string): number | null {
  const t = v.trim().replace(/^"|"$/g, '');
  if (!t) return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    const n = parseFloat(t);
    return n > 1e12 ? n / 1000 : n; // epoch ms → s
  }
  const d = Date.parse(t);
  return isNaN(d) ? null : d / 1000;
}

export function parseTrafficCsv(text: string, opts: { maxDurationS?: number; perMinute?: boolean } = {}): TrafficSeries {
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.split(/[,\t;]/).map((c) => c.trim()))
    .filter((r) => r.length >= 2 && r.some((c) => c));
  const pts: { t: number; v: number }[] = [];
  for (const r of rows) {
    const t = parseTime(r[0]);
    const v = parseFloat(r[r.length > 2 ? r.findIndex((c, i) => i > 0 && !isNaN(parseFloat(c))) : 1]);
    if (t === null || !isFinite(v)) continue; // header or junk
    pts.push({ t, v: opts.perMinute ? v / 60 : v });
  }
  if (pts.length < 2) throw new Error('need at least two rows of "time, requests per second"');
  pts.sort((a, b) => a.t - b.t);
  const t0 = pts[0].t;
  const spanS = pts[pts.length - 1].t - t0;
  const max = opts.maxDurationS ?? 300;
  const compression = spanS > max ? spanS / max : 1;
  // thin to ≤ 400 keyframes
  const step = Math.max(1, Math.ceil(pts.length / 400));
  const traffic = pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map((p) => ({ at: Math.round(((p.t - t0) / compression) * 100) / 100, rps: Math.max(0, Math.round(p.v * 10) / 10) }));
  return { traffic, compression, spanS, peak: Math.max(...traffic.map((x) => x.rps)) };
}
