// The fluid engine against the discrete-event one on 200 generated boards: lists every board whose
// error rates differ by more than 5 points. Then a second, separately seeded set of 100 boards that
// includes search, vector, archive and edge (the first set is left as it was, so its count stays
// comparable). npx tsx scripts/engine-crosscheck.ts
//
// The one board of the first set still past 5 points, #101 (200/s: users > queue00, users > function01
// t500 fanout > queue10 + worker11, queue00 > worker11; fluid 16.5%, DES 30.0%), is a modelling limit,
// not a bug. Half the users' requests are enqueued and answered at once; the other half's calls to
// worker11 arrive at exactly its capacity (100/s against 100/s) and the queue's messages may only take
// what those leave idle. At a load of exactly 1 the wait in front of a pool has no steady state: the
// queue of calls wanders up to its 1 s limit and back, so how many outlast the function's 500 ms deadline
// depends on the path a run takes. The DES gives 30%, 45% and 29% for seeds 1–3; the fluid engine, which
// holds the M/M/c wait at 98% load, a steady 16.5%. Below a load of 1 they agree (at 120, 160 and 180
// req/s: fluid 0.0/0.0/0.3%, DES 0.0/0.0/0.0%). The other two boards that disagreed were bugs, fixed:
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
function crosscheck(n: number, kinds: string[], label: string) {
  const rows: string[] = [];
  let withNew = 0;
  for (let k = 0; k < n; k++) {
    const spec = generate(kinds);
    if (spec.components.some((c: any) => !KINDS.includes(c.kind) && c.kind !== 'client')) withNew++;
    const rps = pick([20, 200, 2000]);
    try {
      const f = simulate(spec, { duration: 40, rps }).summary;
      const d = simulateDes(spec, { duration: 40, rps }, { seed: 1 }).summary;
      const diff = Math.abs(f.meanErrorRate - d.meanErrorRate);
      if (diff > 0.05) rows.push(`#${k} ${rps}/s fluid ${(f.meanErrorRate * 100).toFixed(1)}% des ${(d.meanErrorRate * 100).toFixed(1)}%  ${describe(spec)}`);
    } catch (e) { rows.push(`#${k} threw ${(e as Error).message}`); }
  }
  console.log(rows.length, `of ${n} disagree by >5 points${label}${kinds === KINDS ? '' : ` (${withNew} with a search, vector, archive or edge component)`}`);
  if (rows.length) console.log(rows.join('\n'));
}
crosscheck(200, KINDS, '');
rnd = lcg(29);
crosscheck(100, NEW_KINDS, ' — the set with the new kinds');
