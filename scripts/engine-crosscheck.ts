// The fluid engine against the discrete-event one on 200 generated boards: lists every board whose
// error rates differ by more than 5 points. npx tsx scripts/engine-crosscheck.ts
import { loadEngine } from '../src/backtest/native';
import { simulateDes } from '../src/sim/des/des';
import { simulate } from '../src/sim/headless';
await loadEngine();
let seed = 11;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
const KINDS = ['lb', 'gateway', 'server', 'worker', 'cache', 'db', 'replica', 'queue', 'storage', 'function', 'cdn'];
function generate() {
  const comps: any[] = [{ id: 'users', kind: 'client' }];
  const conns: [string, string][] = [];
  let prev = ['users'];
  const layers = 2 + Math.floor(rnd() * 3);
  for (let l = 0; l < layers; l++) {
    const cur: string[] = [];
    const width = 1 + Math.floor(rnd() * 2);
    for (let w = 0; w < width; w++) {
      const kind = pick(KINDS);
      const id = `${kind}${l}${w}`;
      const c: any = { id, kind };
      if (['server', 'worker'].includes(kind) && rnd() < 0.5) c.instances = 1 + Math.floor(rnd() * 3);
      if (rnd() < 0.2) c.retries = 1 + Math.floor(rnd() * 2);
      if (rnd() < 0.15) c.timeoutMs = pick([200, 500, 2000]);
      if (rnd() < 0.15) c.routing = pick(['fanout', 'failover']);
      if ((kind === 'cache' || kind === 'cdn') && rnd() < 0.5) c.hitRate = pick([0.3, 0.9]);
      comps.push(c); cur.push(id);
      for (const p of prev) if (rnd() < 0.6 || p === prev[prev.length - 1]) conns.push([p, id]);
    }
    prev = cur;
  }
  return { components: comps, connections: conns };
}
const rows: string[] = [];
for (let k = 0; k < 200; k++) {
  const spec = generate();
  const rps = pick([20, 200, 2000]);
  try {
    const f = simulate(spec, { duration: 40, rps }).summary;
    const d = simulateDes(spec, { duration: 40, rps }, { seed: 1 }).summary;
    const diff = Math.abs(f.meanErrorRate - d.meanErrorRate);
    if (diff > 0.05) rows.push(`#${k} ${rps}/s fluid ${(f.meanErrorRate * 100).toFixed(1)}% des ${(d.meanErrorRate * 100).toFixed(1)}%  ${spec.components.map((c: any) => c.id + (c.instances ? 'x' + c.instances : '') + (c.retries ? ' r' + c.retries : '') + (c.timeoutMs ? ' t' + c.timeoutMs : '') + (c.routing ? ' ' + c.routing : '') + (c.hitRate ? ' h' + c.hitRate : '')).join(', ')} | ${spec.connections.map((c) => c.join('>')).join(' ')}`);
  } catch (e) { rows.push(`#${k} threw ${(e as Error).message}`); }
}
console.log(rows.length, 'of 200 disagree by >5 points');
console.log(rows.join('\n'));
