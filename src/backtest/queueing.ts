/**
 * M/M/c queueing (Erlang C) — waiting time for a pool of `c` identical servers with total
 * capacity `K` req/s (each server: K/c), arrivals `lambda` req/s.
 */

/** Erlang C: probability an arrival has to wait */
export function erlangC(c: number, a: number): number {
  // a = offered load in Erlangs (lambda / mu); stable only for a < c
  if (a <= 0) return 0;
  if (a >= c) return 1;
  // iterative Erlang B, then convert to C (numerically stable for large c)
  let b = 1;
  for (let k = 1; k <= c; k++) b = (a * b) / (k + a * b);
  const rho = a / c;
  return b / (1 - rho + rho * b);
}

export interface Wait {
  /** mean wait in queue, ms */
  meanMs: number;
  /** 99th-percentile wait in queue, ms */
  p99Ms: number;
  /** utilisation lambda / K */
  rho: number;
}

/** steady-state wait for lambda < K; at or beyond capacity returns Infinity */
export function mmcWait(lambda: number, c: number, K: number): Wait {
  if (!isFinite(K)) return { meanMs: 0, p99Ms: 0, rho: 0 };
  const rho = lambda / K;
  if (rho >= 1) return { meanMs: Infinity, p99Ms: Infinity, rho };
  const n = Math.max(1, Math.round(c));
  const mu = K / n;
  const C = erlangC(n, lambda / mu);
  const gap = K - lambda; // req/s of spare capacity
  const meanMs = (C / gap) * 1000;
  // P(W > t) = C · e^(−gap·t)
  const p99Ms = C > 0.01 ? (Math.log(C / 0.01) / gap) * 1000 : 0;
  return { meanMs, p99Ms, rho };
}

/** combine independent latency contributions summarised as (mean, p99): means add, tails add in quadrature */
export function combine(parts: { mean: number; p99: number; weight?: number }[]): { mean: number; p99: number } {
  let mean = 0;
  let ex2 = 0;
  for (const p of parts) {
    const w = p.weight ?? 1;
    mean += w * p.mean;
    ex2 += (w * Math.max(0, p.p99 - p.mean)) ** 2;
  }
  return { mean, p99: mean + Math.sqrt(ex2) };
}
