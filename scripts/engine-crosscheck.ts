// The fluid engine against the discrete-event one on 200 generated boards: lists every board whose
// error rates differ by more than 5 points. Then a second, separately seeded set of 100 boards that
// includes search, vector, archive and edge (the first set is left as it was, so its count stays
// comparable). npx tsx scripts/engine-crosscheck.ts
//
// The one board of the first set still past 5 points, #101 (200/s: users > queue00, users > function01
// t500 fanout > queue10 + worker11, queue00 > worker11; fluid 14.3%, DES 30.0%), is a modelling limit,
// not a bug. Half the users' requests are enqueued and answered at once; the other half's calls to
// worker11 arrive at exactly its capacity (100/s against 100/s) and the queue's messages may only take
// what those leave idle. At a load of exactly 1 the wait in front of a pool has no steady state: the
// queue of calls wanders up to its 1 s limit and back, so how many outlast the function's 500 ms deadline
// depends on the path a run takes. The DES gives 30%, 45% and 29% for seeds 1–3; the fluid engine, which
// holds the M/M/c wait at 98% load (no longer than the 1 s bound), a steady 14.3%. Below a load of 1
// they agree (at 120, 160 and 180 req/s: fluid 0.0/0.0/0.3%, DES 0.0/0.0/0.0%). The other two boards that disagreed were bugs, fixed:
// #19 and #82 (a deadline over a fast branch and a failing slow one counted the slow one's lateness
// against the fast one's answers too) and #101's first half (the queue pushed its consumer's whole
// capacity at it, dropping its calls, instead of the consumer pulling with what the calls left free).
import { loadEngine } from '../src/backtest/native';
import { simulateDes } from '../src/sim/des/des';
import { simulate } from '../src/sim/headless';
await loadEngine();
const lcg = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
let rnd = lcg(11);
const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
const KINDS = ['lb', 'gateway', 'server', 'worker', 'cache', 'db', 'replica', 'queue', 'storage', 'function', 'cdn'];
const NEW_KINDS = [...KINDS, 'search', 'vector', 'archive', 'edge'];
function generate(kinds = KINDS) {
  const comps: any[] = [{ id: 'users', kind: 'client' }];
  const conns: [string, string][] = [];
  let prev = ['users'];
  const layers = 2 + Math.floor(rnd() * 3);
  for (let l = 0; l < layers; l++) {
    const cur: string[] = [];
    const width = 1 + Math.floor(rnd() * 2);
    for (let w = 0; w < width; w++) {
      const kind = pick(kinds);
      const id = `${kind}${l}${w}`;
      const c: any = { id, kind };
      if (['server', 'worker'].includes(kind) && rnd() < 0.5) c.instances = 1 + Math.floor(rnd() * 3);
      if (rnd() < 0.2) c.retries = 1 + Math.floor(rnd() * 2);
      if (rnd() < 0.15) c.timeoutMs = pick([200, 500, 2000]);
      if (rnd() < 0.15) c.routing = pick(['fanout', 'failover']);
      if ((kind === 'cache' || kind === 'cdn') && rnd() < 0.5) c.hitRate = pick([0.3, 0.9]);
      // the new kinds' knobs (never drawn in the first set: its sequence is unchanged)
      if (kind === 'search' || kind === 'vector') c.instances = 1 + Math.floor(rnd() * 3);
      if (kind === 'search' && rnd() < 0.5) c.refreshS = pick([1, 30]);
      if (kind === 'vector' && rnd() < 0.5) c.recall = pick([0.9, 0.99]);
      if (kind === 'vector' && rnd() < 0.5) c.vectorsM = pick([1, 10]);
      if (kind === 'archive' && rnd() < 0.3) c.retrieval = pick(['expedited', 'standard']);
      if (kind === 'edge' && rnd() < 0.5) c.edgeShare = pick([0.2, 0.8]);
      if (kind === 'edge' && rnd() < 0.5) c.cpuMs = pick([0.5, 4]);
      comps.push(c); cur.push(id);
      for (const p of prev) if (rnd() < 0.6 || p === prev[prev.length - 1]) conns.push([p, id]);
    }
    prev = cur;
  }
  return { components: comps, connections: conns };
}
const describe = (spec: ReturnType<typeof generate>) =>
  `${spec.components.map((c: any) => c.id + (c.instances ? 'x' + c.instances : '') + (c.retries ? ' r' + c.retries : '') + (c.timeoutMs ? ' t' + c.timeoutMs : '') + (c.routing ? ' ' + c.routing : '') + (c.hitRate ? ' h' + c.hitRate : '') + (c.refreshS ? ' refresh' + c.refreshS : '') + (c.recall ? ' recall' + c.recall : '') + (c.vectorsM ? ' ' + c.vectorsM + 'M' : '') + (c.retrieval ? ' ' + c.retrieval : '') + (c.edgeShare ? ' share' + c.edgeShare : '') + (c.cpuMs ? ' cpu' + c.cpuMs : '')).join(', ')} | ${spec.connections.map((c) => c.join('>')).join(' ')}`;
// Latency: the successful answers' p50 and p99 over the run (the DES's histogram; the fluid engine's
// per-tick answer mixtures pooled the same way), on the boards both engines serve healthily (under 5%
// errors in both). The DES's percentiles are a sample: the same board gives a p99 8% apart between
// seeds at the median, and 60% apart for one board in ten — the ones whose p99 sits where two modes
// meet (a cache's hits and misses, a function's warm and cold answers), so that a few answers either
// way move it from one mode to the other. So the noise band is measured, board by board: the range of
// five seeds. Past it, the fluid engine is allowed 25% for being an approximation: its answer shape
// (40% above the mean, exponential to and past the p99) is within 2–7% of the DES's lognormal service
// times from p50 to p99.9 (p50 0.87 vs 0.86 × mean, p90 1.79 vs 1.75, p99.9 4.43 vs 4.75), and its M/M/c waits scaled for that variability (Allen–Cunneen) are off by
// 10–20% at high load; plus 5 ms for what neither engine resolves (the DES's 0.3 ms hops, its 2.5%
// histogram buckets, rounding). Boards with a component at a load of 0.97 or more are counted apart:
// there the wait has no steady state over a 40 s run (an M/M/c queue relaxes in about
// 1 / (capacity × (1 − √load)²): 44 s for a 100/s pool at 0.97, eight minutes at 0.99), so the DES's
// percentiles depend on the path a run takes and the fluid engine's on its 98% cap (#101 above, for
// errors). The generator makes many: 200 req/s split two ways is exactly a 100/s worker's capacity.
//
// What disagreed, and which engine was right (each checked by hand on a one- or two-component board):
//  - Functions: the fluid engine cold-started rate × 4 s of requests on a jump (its warm pool was a
//    request rate lagging demand by 4 s) and spread them over every answer's mean, so a function's p50
//    read 43 ms instead of 31 ms and the run's p99 357 ms at any rate. The DES is right: a request that
//    finds no idle environment starts one, cold, so a jump from nothing to 200/s cold-starts about
//    200 × (0.4 + 0.035) ≈ 87 (1.1% of a 40 s run: p99 ≈ 430 ms at 20 and 200 req/s, 116 ms at 2000/s,
//    where the 105 environments of the concurrency limit fill and the rest are throttled, 1% errors).
//    Fixed: environments are counted, busy ones by Little's law, starting ones until their cold start
//    ends; a cold start is a slow mode of the answers.
//  - Edge: its locally answered requests were not a mode of their own, so users > edge > server read
//    p50 25 ms (the server's) where half the answers take 3 ms. DES right; fixed.
//  - Overloaded pools: the M/M/c wait at 98% load was added on top of a full backlog, and its spread
//    reached past the queue's bound, so a 100/s worker offered 300/s answered p50 1.3 s, p99 2.6 s. The
//    DES sheds a request that would wait past the bound (1 s): p50 ≈ 1.04 s, p99 ≈ 1.2 s (the bound
//    plus a service time's spread). Fixed: the wait is capped at the bound, its spread at what is left.
//    (Below the bound the two still add: near a load of 1 the queue's random walk sits on top of the
//    drift, and the breaking point stays under capacity.)

const SEEDS = 5;
const TOLERANCE = 0.25;
const FLOOR_MS = 5;
const SATURATED = 0.97;
function crosscheck(n: number, kinds: string[], label: string) {
  const rows: string[] = [];
  const slow: string[] = [];
  let withNew = 0;
  let healthy = 0;
  let saturated = 0;
  for (let k = 0; k < n; k++) {
    const spec = generate(kinds);
    if (spec.components.some((c: any) => !KINDS.includes(c.kind) && c.kind !== 'client')) withNew++;
    const rps = pick([20, 200, 2000]);
    try {
      const fr = simulate(spec, { duration: 40, rps }, { answers: true });
      const f = fr.summary;
      const d = simulateDes(spec, { duration: 40, rps }, { seed: 1 }).summary;
      const diff = Math.abs(f.meanErrorRate - d.meanErrorRate);
      if (diff > 0.05) rows.push(`#${k} ${rps}/s fluid ${(f.meanErrorRate * 100).toFixed(1)}% des ${(d.meanErrorRate * 100).toFixed(1)}%  ${describe(spec)}`);
      if (f.meanErrorRate >= 0.05 || d.meanErrorRate >= 0.05 || !fr.answers) continue;
      if (Object.values(fr.components).some((c) => c.meanUtil >= SATURATED && !c.async && !['client', 'queue', 'stream'].includes(c.kind))) {
        saturated++;
        continue;
      }
      healthy++;
      const ds = [d, ...Array.from({ length: SEEDS - 1 }, (_, s) => simulateDes(spec, { duration: 40, rps }, { seed: s + 2 }).summary)];
      const out: string[] = [];
      for (const [q, fluid] of [['p50', fr.answers.p50Ms], ['p99', fr.answers.p99Ms]] as const) {
        const des = ds.map((x) => (q === 'p50' ? x.p50Ms : x.p99Ms));
        const lo = Math.min(...des) / (1 + TOLERANCE) - FLOOR_MS;
        const hi = Math.max(...des) * (1 + TOLERANCE) + FLOOR_MS;
        if (fluid < lo || fluid > hi) out.push(`${q} fluid ${fluid} ms des ${Math.min(...des)}–${Math.max(...des)}`);
      }
      if (out.length) slow.push(`#${k} ${rps}/s ${out.join(', ')}  ${describe(spec)}`);
    } catch (e) { rows.push(`#${k} threw ${(e as Error).message}`); }
  }
  console.log(rows.length, `of ${n} disagree by >5 points${label}${kinds === KINDS ? '' : ` (${withNew} with a search, vector, archive or edge component)`}`);
  if (rows.length) console.log(rows.join('\n'));
  console.log(slow.length, `of ${healthy} healthy boards disagree on latency (p50 or p99 outside the DES's ${SEEDS}-seed range ±${TOLERANCE * 100}% + ${FLOOR_MS} ms; ${saturated} more at a load ≥ ${SATURATED} left out)${label}`);
  if (slow.length) console.log(slow.join('\n'));
}
crosscheck(200, KINDS, '');
rnd = lcg(29);
crosscheck(100, NEW_KINDS, ' — the set with the new kinds');
