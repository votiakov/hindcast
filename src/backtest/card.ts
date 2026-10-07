import type { BacktestResult } from './backtest';
import { headline } from './report';

/**
 * Everything a Studio card or clip of a backtest needs, downsampled so it travels in a URL or
 * local storage: the measured p99 history, the as-built replay and one strategy over it, the
 * verdict and the accuracy record.
 */
export interface CardData {
  system: string;
  window: { start: number; end: number };
  slo: { p99Ms: number; errorRate: number };
  t: number[];
  measured: (number | null)[];
  asBuilt: number[];
  strategy: { name: string; headline: string; p50: number[]; lo: number[]; hi: number[]; monthlyDelta: number; minutesOutOfSlo: number; minutesDelta: number; failedDelta: number; worst: { t: number; p99Ms: number; why: string } } | null;
  /** cumulative $ saved (positive) or spent (negative) vs as built */
  saved: number[];
  accuracy: { metric: string; error: number; pass: boolean }[];
}

function down<T>(xs: T[], n: number, pick: (seg: T[]) => T): T[] {
  if (xs.length <= n) return xs;
  const out: T[] = [];
  const size = xs.length / n;
  for (let k = 0; k < n; k++) out.push(pick(xs.slice(Math.floor(k * size), Math.max(Math.floor(k * size) + 1, Math.floor((k + 1) * size)))));
  return out;
}
const maxOf = (seg: number[]) => Math.max(...seg);
const maxNull = (seg: (number | null)[]) => {
  const v = seg.filter((x): x is number => x !== null);
  return v.length ? Math.max(...v) : null;
};
const r1 = (x: number) => Math.round(x * 10) / 10;

export function cardData(r: BacktestResult, strategyIndex: number, points = 240): CardData {
  const st = r.strategies[strategyIndex] ?? null;
  const n = Math.min(points, r.t.length);
  const savedFull = st ? r.baseline.series.cumulativeCost.p50.map((b, i) => b - st.series.cumulativeCost.p50[i]) : r.t.map(() => 0);
  return {
    system: r.model,
    window: { start: r.window.start, end: r.window.end },
    slo: r.slo,
    t: down(r.t, n, (s) => s[0]),
    measured: down(r.actual.p99Ms, n, maxNull).map((x) => (x === null ? null : r1(x))),
    asBuilt: down(r.baseline.series.p99Ms.p50, n, maxOf).map(r1),
    strategy: st
      ? {
          name: st.name,
          headline: headline(st, r.baseline),
          p50: down(st.series.p99Ms.p50, n, maxOf).map(r1),
          lo: down(st.series.p99Ms.lo, n, maxOf).map(r1),
          hi: down(st.series.p99Ms.hi, n, maxOf).map(r1),
          monthlyDelta: Math.round(st.delta.monthly.p50 * 100) / 100,
          minutesOutOfSlo: r1(st.summary.minutesOutOfSlo.p50),
          minutesDelta: r1(st.delta.minutesOutOfSlo.p50),
          failedDelta: Math.round(st.delta.failedRequests.p50),
          worst: { t: st.worst.t, p99Ms: Math.round(st.worst.p99Ms), why: st.worst.why },
        }
      : null,
    saved: down(savedFull, n, (s) => s[s.length - 1]).map((x) => Math.round(x * 1000) / 1000),
    accuracy: r.accuracy.flatMap((a) => a.checks).filter((c) => c.metric !== 'errors').map((c) => ({ metric: c.metric, error: Math.round(c.error * 1000) / 1000, pass: c.pass })),
  };
}

/** base64url (URL-safe) for passing card data to the renderer */
export const encodeCard = (c: CardData) => {
  const json = JSON.stringify(c);
  return typeof Buffer !== 'undefined' ? Buffer.from(json).toString('base64url') : btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const decodeCard = (s: string): CardData => JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))));
