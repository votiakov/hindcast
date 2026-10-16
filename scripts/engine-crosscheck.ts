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
//  - Retries after rejections: a retry cost a whole answer's time (latency × attempts), so behind a
//    worker shedding two thirds of its calls a 1.2 s p99 read 1.5 s. A shed call fails in 0.5 ms (the
//    DES's); fixed: each component carries how long its failures take (at once when shed, the deadline
//    when late, the failed calls' time when downstream failed), and a retry costs that.
//  - The lower half of an answer: below its mean the fluid shape was exponential, with far too many
//    answers near zero, so a p50 that falls between a cache's hits and the slower answers behind it
//    read 9 ms where it is 27 (#132). DES right (its service times are lognormal); fixed with a
//    lognormal's body below the mean, of the mean and p99 the fluid engine has (deadlines shorter than
//    the mean answer use it too).
// Still apart, as an approximation: #1 (users > function00 t200 > function10, users > worker01 >
// function10 at 20 req/s; p99 fluid 311 ms, DES 410–500). Its p99 is the boundary between warm and
// cold answers, and the DES cold-starts function10 twice: once for the worker's calls, again 0.4 s
// later when function00's own cold starts end and release their calls at once. The fluid engine passes
// a request through a component within the tick, so both reach function10 together and it cold-starts
// once: fewer cold answers, a p99 just inside the warm mode.
//
// The third set (retry policies, an injected error rate, a capacity dip) found, each checked by hand:
//  - Backoff: the fluid engine counted 30% of backed-off retries as load (1 + 0.3 × (Σfᵏ − 1)) while
//    crediting all of them with success. A 50% failing database behind 2 retries gets 1 + 0.5 + 0.25 =
//    1.75 attempts per call whatever the delay (the DES: 1.81; the fluid engine had 1.225): backoff
//    delays a retry, it does not skip it. Behind a 1 s deadline, users at 100/s and a 250/s database
//    whose 10 s queue is still 3 s deep after a stall at 30%: two retries keep 300 attempts/s arriving,
//    every one waits past the deadline, and the database never catches up — with or without backoff
//    (the DES: 100% errors to the end; the fluid engine with backoff saw 160/s and recovered). Fixed.
//  - Retried answers: a retry's time was added to every answer's mean, so the 16% of answers that took
//    a second attempt (users > storage failing 20%, one retry: p99 ≈ the 94th percentile of two
//    answers' time, 2 × 38 ms × 1.33 ≈ 101 ms; the DES 108) did not show: p99 76. DES right; fixed (now 106):
//    an answer that took k retries is a mode of its own, after k failed attempts and backoff waits.
//  - A component's own failures (inject-errors) were counted as failing at once (0.5 ms); the DES fails
//    them at the end of the work, so a retry after one costs a whole answer's time. DES right; fixed.
//  - Four mixture parts were too few once retries are modes (#10: cold starts × retries; the slowest
//    mode merged into a faster one, p99 256 where the DES's five seeds give 329–513): eight. Fixed.
// Still apart in the third set, as approximations: #12 is a cold-start cascade like #1 (it is as far
// apart with every retry and fault removed: fluid 366 ms, DES 580–640). #5 (users with 2 retries and
// backoff over a CDN with 1 retry and backoff, 2000/s: p99 fluid 278 ms, DES 391–410) stacks two layers
// of retries: each layer alone agrees (users only: 236 against 298; CDN only: 162 against 169), but
// the fluid engine carries a failed call's time as a mean with no spread of its own, so the slowest
// answers — up to six attempts and their jittered waits — come out too fast.

const SEEDS = 5;
const TOLERANCE = 0.25;
const FLOOR_MS = 5;
const SATURATED = 0.97;
// The third set exercises retries under failure: every caller with retries gets a policy (immediate,
// backoff or a 10% budget), the users a deadline half the time, one component fails a share of its
// answers for the whole run, and another runs at 30% of its capacity from 10 s to 20 s (separately
// seeded: the first two sets are unchanged).
function withFaults(spec: ReturnType<typeof generate>) {
  const callers = new Set(spec.connections.map((c) => c[0]));
  for (const c of spec.components) {
    if (c.kind !== 'client' && callers.has(c.id) && c.retries === undefined && rnd() < 0.4) c.retries = 1 + Math.floor(rnd() * 2);
    if (c.retries) c.retryPolicy = pick(['immediate', 'backoff', 'budget']);
  }
  const users = spec.components[0];
  if (rnd() < 0.5) users.timeoutMs = pick([500, 1000, 2000]);
  if (rnd() < 0.6) { users.retries = 1 + Math.floor(rnd() * 2); users.retryPolicy = pick(['immediate', 'backoff', 'budget']); }
  const rest = spec.components.slice(1);
  const events: { at: number; action: Record<string, unknown> }[] = [{ at: 0, action: { type: 'inject-errors', id: pick(rest).id, rate: pick([0.03, 0.2]) } }];
  const slow = pick(rest).id;
  events.push({ at: 10, action: { type: 'degrade', id: slow, factor: 0.3 } }, { at: 20, action: { type: 'degrade', id: slow, factor: 1 } });
  return events;
}
const describeFaults = (events: { action: Record<string, unknown> }[]) => events.length ? ` | errors ${events[0].action.id} ${events[0].action.rate}, ${events[1].action.id} at 30% 10–20 s` : '';
const describeRetries = (spec: ReturnType<typeof generate>) => spec.components.filter((c: any) => c.retryPolicy).map((c: any) => `${c.id} ${c.retryPolicy}`).join(', ');

function crosscheck(n: number, kinds: string[], label: string, faults = false) {
  const rows: string[] = [];
  const slow: string[] = [];
  let withNew = 0;
  let healthy = 0;
  let saturated = 0;
  for (let k = 0; k < n; k++) {
    const spec = generate(kinds);
    const events = faults ? withFaults(spec) : [];
    const scenario = (rps: number) => (faults ? { duration: 40, rps, events } : { duration: 40, rps });
    if (spec.components.some((c: any) => !KINDS.includes(c.kind) && c.kind !== 'client')) withNew++;
    const rps = pick([20, 200, 2000]);
    try {
      const fr = simulate(spec, scenario(rps), { answers: true });
      const f = fr.summary;
      const d = simulateDes(spec, scenario(rps), { seed: 1 }).summary;
      const diff = Math.abs(f.meanErrorRate - d.meanErrorRate);
      if (diff > 0.05) rows.push(`#${k} ${rps}/s fluid ${(f.meanErrorRate * 100).toFixed(1)}% des ${(d.meanErrorRate * 100).toFixed(1)}%  ${describe(spec)}${faults ? ` | ${describeRetries(spec)}${describeFaults(events)}` : ''}`);
      if (f.meanErrorRate >= 0.05 || d.meanErrorRate >= 0.05 || !fr.answers) continue;
      if (Object.values(fr.components).some((c) => c.meanUtil >= SATURATED && !c.async && !['client', 'queue', 'stream'].includes(c.kind))) {
        saturated++;
        continue;
      }
      healthy++;
      const ds = [d, ...Array.from({ length: SEEDS - 1 }, (_, s) => simulateDes(spec, scenario(rps), { seed: s + 2 }).summary)];
      const out: string[] = [];
      for (const [q, fluid] of [['p50', fr.answers.p50Ms], ['p99', fr.answers.p99Ms]] as const) {
        const des = ds.map((x) => (q === 'p50' ? x.p50Ms : x.p99Ms));
        const lo = Math.min(...des) / (1 + TOLERANCE) - FLOOR_MS;
        const hi = Math.max(...des) * (1 + TOLERANCE) + FLOOR_MS;
        if (fluid < lo || fluid > hi) out.push(`${q} fluid ${fluid} ms des ${Math.min(...des)}–${Math.max(...des)}`);
      }
      if (out.length) slow.push(`#${k} ${rps}/s ${out.join(', ')}  ${describe(spec)}${faults ? ` | ${describeRetries(spec)}${describeFaults(events)}` : ''}`);
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
rnd = lcg(47);
crosscheck(100, KINDS, ' — the set with retry policies, faults and a capacity dip', true);
