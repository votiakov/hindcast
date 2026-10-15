import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINE_CONFIG, Engine, type Snapshot } from '../src/sim/engine';
import { specToGraph } from '../src/spec/convert';
import { baseLatencyOf, cacheHitRate, capacityOf, costOf, defaultData, isSystem, KINDS, type Kind, type SystemNodeData } from '../src/sim/catalog';
import { simulateDes } from '../src/sim/des/des';
import { simulate } from '../src/sim/headless';
import { explain, nodeView } from '../src/canvas/nodeModel';
import { readFileSync } from 'node:fs';
import { modelToSpec } from '../src/backtest/toSpec';
import { basePlan } from '../src/backtest/engine';
import { observedReplicas } from '../src/backtest/calibrate';
import { modelBreakingPoint } from '../src/backtest/accuracy';
import { breakingPoint } from '../src/sim/headless';

/**
 * The sandbox's engine against what it claims to model: every component kind on its own against
 * queueing arithmetic, flow conservation and value bounds on generated boards, monotonicity (more
 * capacity never hurts, more load never helps), the numbers the UI shows (TypeScript catalogue)
 * against what the engine computes, and the fluid engine against the discrete-event one.
 */

type Comp = { id: string; kind: Kind } & Partial<SystemNodeData>;
interface Board {
  nodes: ReturnType<typeof specToGraph>['nodes'];
  edges: ReturnType<typeof specToGraph>['edges'];
}
const board = (components: Comp[], connections: [string, string][]): Board => {
  const b = specToGraph({ components, connections });
  // knobs the board's actions set (not spec fields): carried onto the node data
  for (const c of components) for (const k of ['faultRate', 'alive', 'down', 'degraded'] as const) if (c[k] !== undefined) (b.nodes.find((n) => n.id === c.id)!.data as Record<string, unknown>)[k] = c[k];
  return b;
};

/** run the board at a constant load until it settles; the snapshot the UI would show */
function run(b: Board, rps: number, o: { seconds?: number; readRatio?: number; edit?: (t: number, b: Board) => void } = {}): Snapshot & { engine: Engine } {
  const e = new Engine();
  const dt = 0.05;
  const steps = Math.round((o.seconds ?? 60) / dt);
  for (let i = 0; i < steps; i++) {
    o.edit?.(i * dt, b);
    e.step(b.nodes as never, b.edges as never, rps, o.readRatio ?? 0.8, dt, DEFAULT_ENGINE_CONFIG);
  }
  return { ...e.snapshot(b.nodes as never, b.edges as never), engine: e };
}
/** what the board's actions change (kill, inject errors…): node data, not spec fields */
const patch = (b: Board, id: string, p: Partial<SystemNodeData>) => {
  const n = b.nodes.find((x) => x.id === id)!;
  n.data = { ...(n.data as SystemNodeData), ...p };
  return b;
};
const data = (b: Board, id: string) => b.nodes.find((n) => n.id === id)!.data as SystemNodeData;
const edgeRps = (s: Snapshot, from: string, to: string) => s.edgeStats[`e-${from}-${to}`]?.rps ?? NaN;

describe('one component at a time, against queueing arithmetic', () => {
  for (const kind of ['server', 'worker', 'replica', 'llm'] as Kind[]) {
    it(`${kind}: below capacity nothing fails; above it, the excess is shed`, () => {
      const b = board([{ id: 'users', kind: 'client' }, { id: 'x', kind }], [['users', 'x']]);
      const cap = capacityOf(data(b, 'x'));
      const low = run(b, cap * 0.5);
      expect(low.nodeStats.x.success).toBeCloseTo(1, 3);
      expect(low.nodeStats.x.dropRps).toBeLessThan(cap * 0.001);
      expect(low.nodeStats.x.util).toBeCloseTo(0.5, 2);
      // a pool of workers (M/M/c): its own service time plus a wait no longer than one server's (M/M/1)
      const base = baseLatencyOf(data(b, 'x'));
      expect(low.nodeStats.x.latencyMs).toBeGreaterThanOrEqual(base * 0.999);
      expect(low.nodeStats.x.latencyMs).toBeLessThanOrEqual(base / 0.5);
      expect(run(b, cap * 0.9).nodeStats.x.latencyMs).toBeGreaterThan(low.nodeStats.x.latencyMs);
      const high = run(b, cap * 2);
      expect(high.nodeStats.x.success).toBeCloseTo(0.5, 2);
      expect(high.nodeStats.x.dropRps).toBeCloseTo(cap, -Math.log10(cap * 0.01));
      expect(high.global.errorRate).toBeCloseTo(0.5, 2);
    });
  }

  it('a load balancer pools the instances behind it; without one, clients reach a single instance', () => {
    const behind = board([{ id: 'users', kind: 'client' }, { id: 'lb', kind: 'lb' }, { id: 'api', kind: 'server', instances: 4 }], [['users', 'lb'], ['lb', 'api']]);
    const one = KINDS.server.capacity;
    expect(run(behind, one * 3).global.errorRate).toBeLessThan(0.001);
    const direct = board([{ id: 'users', kind: 'client' }, { id: 'api', kind: 'server', instances: 4 }], [['users', 'api']]);
    expect(run(direct, one * 3).global.errorRate).toBeCloseTo(2 / 3, 2);
  });

  it('a cache answers its hit rate and sends the misses to the origin', () => {
    const b = board([{ id: 'users', kind: 'client' }, { id: 'c', kind: 'cache', hitRate: 0.7 }, { id: 'db', kind: 'db' }], [['users', 'c'], ['c', 'db']]);
    const s = run(b, 200, { seconds: 120 });
    // reads (80%) hit 70% of the time; misses and writes reach the origin
    expect(edgeRps(s, 'c', 'db')).toBeCloseTo(200 * (1 - 0.8 * 0.7), 0);
    expect(s.nodeStats.c.hitRps).toBeCloseTo(200 * 0.8 * 0.7, 0);
    expect(s.global.errorRate).toBeLessThan(0.001);
  });

  it('only reads can hit a cache: writes go on to the origin', () => {
    const b = board([{ id: 'users', kind: 'client' }, { id: 'c', kind: 'cache', hitRate: 0.8 }, { id: 'db', kind: 'db' }], [['users', 'c'], ['c', 'db']]);
    // half reads: 40% of everything hits, the other 60% (misses and every write) reaches the database
    expect(edgeRps(run(b, 200, { readRatio: 0.5, seconds: 120 }), 'c', 'db')).toBeCloseTo(120, 0);
    // all writes: the cache saves the database nothing
    expect(edgeRps(run(b, 200, { readRatio: 0, seconds: 60 }), 'c', 'db')).toBeCloseTo(200, 0);
  });

  it('a cache sized against the data it fronts hits what its memory holds of the popular keys', () => {
    const hit = (tier: 'S' | 'M' | 'L', workingSetGb: number, skew?: number) => cacheHitRate({ ...defaultData('cache', 'c'), tier, workingSetGb, skew });
    // 64 GB of 1 KB keys, Zipf 1: the most popular 6.4 / 13 / 26 GB
    expect(hit('S', 64)).toBeCloseTo(0.867, 2);
    expect(hit('M', 64)).toBeCloseTo(0.905, 2);
    expect(hit('L', 64)).toBeCloseTo(0.942, 2);
    // everything fits: only expiry misses; flatter popularity: a small cache helps far less
    expect(hit('S', 5)).toBeCloseTo(0.99, 3);
    expect(hit('S', 64, 0.6)).toBeLessThan(0.5);
    // and the engine uses it: the origin gets the misses of a sized cache
    const b = board([{ id: 'users', kind: 'client' }, { id: 'c', kind: 'cache', workingSetGb: 64 }, { id: 'db', kind: 'db' }], [['users', 'c'], ['c', 'db']]);
    expect(edgeRps(run(b, 200, { readRatio: 1, seconds: 120 }), 'c', 'db')).toBeCloseTo(200 * (1 - hit('S', 64)), 0);
  });

  it('a write-behind cache acknowledges writes at once, flushes them later, and loses the buffer when it dies', () => {
    const spec = { components: [{ id: 'users', kind: 'client' as Kind }, { id: 'c', kind: 'cache' as Kind, hitRate: 0.9, writePolicy: 'behind' as const }, { id: 'db', kind: 'db' as Kind, latencyMs: 200 }], connections: [['users', 'c'], ['c', 'db']] as [string, string][] };
    const b = board(spec.components, spec.connections);
    const s = run(b, 100, { readRatio: 0, seconds: 60 });
    // every write answered at cache speed, and flushed on to the database at the same rate on average
    expect(s.nodeStats.users.latencyMs).toBeLessThan(10);
    expect(edgeRps(s, 'c', 'db')).toBeCloseTo(100, 0);
    expect(s.global.errorRate).toBeLessThan(0.001);
    // the cache dies: the ~5 s of writes it held are gone
    const e = s.engine;
    patch(b, 'c', { alive: false });
    e.step(b.nodes as never, b.edges as never, 100, 0, 0.05, DEFAULT_ENGINE_CONFIG);
    const lost = e.snapshot(b.nodes as never, b.edges as never).global.lostWrites;
    expect(lost).toBeGreaterThan(350);
    expect(lost).toBeLessThan(650);
    // the discrete-event engine loses about as many
    const des = simulateDes(spec, { duration: 40, rps: 100, readRatio: 0, events: [{ at: 30, action: { type: 'kill-id', id: 'c' } }] }, { seed: 1 }).summary.lostWrites ?? 0;
    expect(des).toBeGreaterThan(350);
    expect(des).toBeLessThan(650);
  });

  it('a database shares its reads with its replicas and keeps the writes', () => {
    const b = board([{ id: 'users', kind: 'client' }, { id: 'db', kind: 'db' }, { id: 'r1', kind: 'replica' }, { id: 'r2', kind: 'replica' }], [['users', 'db'], ['db', 'r1'], ['db', 'r2']]);
    const s = run(b, 300, { readRatio: 0.9 });
    // 90% reads over primary + 2 replicas: each replica gets 30% of everything
    expect(edgeRps(s, 'db', 'r1')).toBeCloseTo(90, 0);
    expect(edgeRps(s, 'db', 'r2')).toBeCloseTo(90, 0);
    expect(s.nodeStats.db.inRps).toBeCloseTo(300, 0);
  });

  it('a queue absorbs a burst its consumers cannot keep up with: producers see no errors, the backlog grows', () => {
    const b = board([{ id: 'users', kind: 'client' }, { id: 'q', kind: 'queue' }, { id: 'w', kind: 'worker' }], [['users', 'q'], ['q', 'w']]);
    const drain = capacityOf(data(b, 'w'));
    const s = run(b, drain * 1.5, { seconds: 20 });
    expect(s.global.errorRate).toBeLessThan(0.001);
    // backlog ≈ (λ − drain) × t
    expect(s.nodeStats.q.queue).toBeGreaterThan(drain * 0.5 * 20 * 0.9);
    expect(s.nodeStats.w.dropRps).toBeLessThan(1);
  });

  it('a gateway rejects what is over its rate limit', () => {
    const b = board([{ id: 'users', kind: 'client' }, { id: 'g', kind: 'gateway', limit: 100 }, { id: 'api', kind: 'server' }], [['users', 'g'], ['g', 'api']]);
    const s = run(b, 200);
    expect(s.global.errorRate).toBeCloseTo(0.5, 2);
    expect(edgeRps(s, 'g', 'api')).toBeCloseTo(100, 0);
  });

  it('retries amplify the load on a failing dependency by 1 + f + f² + …', () => {
    const b = patch(board([{ id: 'users', kind: 'client' }, { id: 'api', kind: 'server', retries: 2 }, { id: 'dep', kind: 'server' }], [['users', 'api'], ['api', 'dep']]), 'dep', { faultRate: 0.5 });
    const s = run(b, 50);
    expect(edgeRps(s, 'api', 'dep') / 50).toBeCloseTo(1 + 0.5 + 0.25, 1);
    // end to end: 1 − f³
    expect(s.global.errorRate).toBeCloseTo(0.125, 2);
  });

  it('a dead server fails everything routed to it; a balancer routes around a dead sibling', () => {
    const one = patch(board([{ id: 'users', kind: 'client' }, { id: 'api', kind: 'server' }], [['users', 'api']]), 'api', { alive: false });
    expect(run(one, 50).global.errorRate).toBeCloseTo(1, 3);
    const two = patch(board([{ id: 'users', kind: 'client' }, { id: 'lb', kind: 'lb' }, { id: 'a', kind: 'server' }, { id: 'b', kind: 'server' }], [['users', 'lb'], ['lb', 'a'], ['lb', 'b']]), 'b', { alive: false });
    expect(run(two, 50).global.errorRate).toBeLessThan(0.001);
  });

  it('cost on the board is what the catalogue prices it at', () => {
    for (const kind of Object.keys(KINDS) as Kind[]) {
      if (kind === 'client' || kind === 'function') continue;
      const b = board([{ id: 'users', kind: 'client' }, { id: 'x', kind }], [['users', 'x']]);
      const s = run(b, 1, { seconds: 5 });
      // the fixed price, plus what usage-billed kinds charge for the requests they served
      const usage = (KINDS[kind].costPerRequest ?? 0) * s.nodeStats.x.inRps * 3600;
      expect(s.nodeStats.x.costPerHour, kind).toBeCloseTo(costOf(data(b, 'x')) + usage, 4);
    }
  });
});

// ---- generated boards ----
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
const KINDS_FOR_GEN: Kind[] = ['lb', 'gateway', 'server', 'worker', 'cache', 'db', 'replica', 'queue', 'storage', 'function', 'cdn', 'kv', 'external'];

/** a random layered board: users → … with knobs */
function generate(): { components: Comp[]; connections: [string, string][] } {
  const layers = 2 + Math.floor(rnd() * 4);
  const components: Comp[] = [{ id: 'users', kind: 'client', ...(rnd() < 0.3 ? { retries: 1, timeoutMs: 2000 } : {}) }];
  const connections: [string, string][] = [];
  let prev = ['users'];
  for (let l = 0; l < layers; l++) {
    const width = 1 + Math.floor(rnd() * 3);
    const cur: string[] = [];
    for (let w = 0; w < width; w++) {
      const kind = pick(KINDS_FOR_GEN);
      const id = `${kind}${l}${w}`;
      const c: Comp = { id, kind };
      if (['server', 'worker', 'llm'].includes(kind) && rnd() < 0.5) c.instances = 1 + Math.floor(rnd() * 4);
      if (rnd() < 0.3) c.tier = pick(['S', 'M', 'L'] as const);
      if (rnd() < 0.2) c.retries = 1 + Math.floor(rnd() * 3);
      if (rnd() < 0.15) c.timeoutMs = pick([200, 500, 2000]);
      if (rnd() < 0.15) c.routing = pick(['split', 'fanout', 'failover'] as const);
      if (rnd() < 0.1) c.breaker = true;
      if (rnd() < 0.1) c.faultRate = pick([0.05, 0.3]); // applied as the inject-errors action does
      if ((kind === 'cache' || kind === 'cdn') && rnd() < 0.5) c.hitRate = pick([0.3, 0.9]);
      components.push(c);
      cur.push(id);
      for (const p of prev) if (rnd() < 0.7 || p === prev[prev.length - 1]) connections.push([p, id]);
    }
    prev = cur;
  }
  return { components, connections };
}

describe('generated boards', () => {
  const boards = Array.from({ length: 150 }, generate);

  it('every number on the board is finite and in range', () => {
    const bad: string[] = [];
    boards.forEach((spec, k) => {
      const b = board(spec.components, spec.connections);
      const s = run(b, pick([10, 300, 3000, 30000]), { seconds: 20 });
      const g = s.global;
      if (!(g.errorRate >= 0 && g.errorRate <= 1 + 1e-9) || !isFinite(g.p99) || g.p99 < 0 || !(g.cost >= 0)) bad.push(`#${k} global ${JSON.stringify({ e: g.errorRate, p99: g.p99, cost: g.cost })}`);
      for (const n of b.nodes.filter(isSystem)) {
        const x = s.nodeStats[n.id];
        const why = [
          !(x.success >= -1e-9 && x.success <= 1 + 1e-9) && `success ${x.success}`,
          !(x.inRps >= 0) && `inRps ${x.inRps}`,
          !(x.dropRps >= -1e-9) && `dropRps ${x.dropRps}`,
          x.dropRps > x.inRps * 1.05 + 1 && `drops ${x.dropRps} > in ${x.inRps}`,
          !(x.util >= 0 && isFinite(x.util)) && `util ${x.util}`,
          !(x.latencyMs >= 0 && isFinite(x.latencyMs)) && `latency ${x.latencyMs}`,
          !(x.costPerHour >= 0 && isFinite(x.costPerHour)) && `cost ${x.costPerHour}`,
        ].filter(Boolean);
        if (why.length) bad.push(`#${k} ${n.id}: ${why.join(', ')} — ${JSON.stringify(spec.components.find((c) => c.id === n.id))} out ${JSON.stringify(spec.connections.filter((c) => c[0] === n.id))}`);
      }
    });
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('what arrives at a component is what its callers send it', () => {
    const bad: string[] = [];
    boards.forEach((spec, k) => {
      const b = board(spec.components, spec.connections);
      const s = run(b, 200, { seconds: 40 });
      for (const n of b.nodes.filter(isSystem)) {
        if ((n.data as SystemNodeData).kind === 'client') continue;
        const sent = b.edges.filter((e) => e.target === n.id).reduce((a, e) => a + (s.edgeStats[e.id]?.rps ?? 0), 0);
        const got = s.nodeStats[n.id].inRps;
        if (Math.abs(sent - got) > Math.max(0.5, got * 0.01)) bad.push(`#${k} ${n.id}: callers send ${sent.toFixed(1)}, it receives ${got.toFixed(1)}`);
      }
    });
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('more capacity never makes it worse; more load never makes it better', () => {
    const bad: string[] = [];
    boards.forEach((spec, k) => {
      const rps = pick([50, 500, 5000]);
      const base = run(board(spec.components, spec.connections), rps, { seconds: 40 }).global.errorRate;
      const bigger = spec.components.map((c) => (['server', 'worker', 'llm'].includes(c.kind) ? { ...c, instances: (c.instances ?? 1) * 3 } : { ...c, tier: 'L' as const }));
      const more = run(board(bigger, spec.connections), rps, { seconds: 40 }).global.errorRate;
      const heavier = run(board(spec.components, spec.connections), rps * 3, { seconds: 40 }).global.errorRate;
      if (more > base + 0.02) bad.push(`#${k} at ${rps}/s: ${(base * 100).toFixed(1)}% errors, with 3× capacity ${(more * 100).toFixed(1)}%`);
      if (heavier < base - 0.02) bad.push(`#${k}: ${(base * 100).toFixed(1)}% errors at ${rps}/s, ${(heavier * 100).toFixed(1)}% at 3× the load`);
    });
    expect(bad.slice(0, 10)).toEqual([]);
  });
});

describe('resilience behaviours', () => {
  const U = { id: 'users', kind: 'client' as Kind };
  it("a caller's timeout fails answers slower than it, and only those", () => {
    const spec = (timeoutMs: number) => ({ components: [U, { id: 'api', kind: 'server' as Kind, timeoutMs }, { id: 'dep', kind: 'server' as Kind, latencyMs: 800 }], connections: [['users', 'api'], ['api', 'dep']] as [string, string][] });
    const slow = (timeoutMs: number) => run(board(spec(timeoutMs).components, spec(timeoutMs).connections), 20).global.errorRate;
    // service times vary (lognormal): an 800 ms dependency answers within 500 ms about a quarter of the time
    const des = simulateDes(spec(500), { duration: 60, rps: 20 }, { seed: 1 }).summary.meanErrorRate;
    expect(des).toBeGreaterThan(0.6);
    expect(Math.abs(slow(500) - des)).toBeLessThan(0.1);
    expect(slow(3000)).toBeLessThan(0.01);
  });

  it('an open breaker with a fallback keeps users served while the dependency fails', () => {
    const mk = (breaker: boolean) => patch(board([U, { id: 'api', kind: 'server', breaker, fallback: breaker }, { id: 'dep', kind: 'server' }], [['users', 'api'], ['api', 'dep']]), 'dep', { faultRate: 0.9 });
    expect(run(mk(false), 50).global.errorRate).toBeCloseTo(0.9, 2);
    expect(run(mk(true), 50).global.errorRate).toBeLessThan(0.05);
  });

  it('failover routing sends everything to the first callee, and to the next when it dies', () => {
    const b = board([U, { id: 'api', kind: 'server', routing: 'failover' }, { id: 'a', kind: 'server' }, { id: 'b', kind: 'server' }], [['users', 'api'], ['api', 'a'], ['api', 'b']]);
    const up = run(b, 100);
    expect(edgeRps(up, 'api', 'a')).toBeCloseTo(100, 0);
    expect(edgeRps(up, 'api', 'b')).toBeLessThan(1);
    patch(b, 'a', { alive: false });
    const down = run(b, 100);
    expect(edgeRps(down, 'api', 'b')).toBeCloseTo(100, 0);
    expect(down.global.errorRate).toBeLessThan(0.001);
  });

  it('fanout calls every callee with the whole request, and fails when any of them does', () => {
    const b = board([U, { id: 'api', kind: 'server', routing: 'fanout' }, { id: 'a', kind: 'server' }, { id: 'b', kind: 'server' }], [['users', 'api'], ['api', 'a'], ['api', 'b']]);
    const s = run(b, 100);
    expect(edgeRps(s, 'api', 'a')).toBeCloseTo(100, 0);
    expect(edgeRps(s, 'api', 'b')).toBeCloseTo(100, 0);
    patch(b, 'b', { faultRate: 0.2 });
    expect(run(b, 100).global.errorRate).toBeCloseTo(0.2, 2);
  });

  it('a link that makes N calls per request multiplies the load and needs every call to succeed', () => {
    const spec = { components: [U, { id: 'api', kind: 'server' as Kind }, { id: 'db', kind: 'db' as Kind }], connections: [['users', 'api'], { from: 'api', to: 'db', calls: 10 }] as never };
    const b = specToGraph(spec);
    const s = run(b, 20);
    expect(s.nodeStats.db.inRps).toBeCloseTo(200, 0);
    patch(b, 'db', { faultRate: 0.05 });
    const f = run(b, 20).global.errorRate;
    expect(f).toBeCloseTo(1 - 0.95 ** 10, 2);
    const des = simulateDes(spec, { duration: 60, rps: 20, events: [{ at: 0, action: { type: 'inject-errors', id: 'db', rate: 0.05 } }] }, { seed: 1 }).summary.meanErrorRate;
    expect(Math.abs(des - f)).toBeLessThan(0.05);
  });

  it('links that carry only reads or only writes split a service CQRS-style', () => {
    const spec = {
      components: [U, { id: 'api', kind: 'server' as Kind }, { id: 'cache', kind: 'cache' as Kind, hitRate: 0.9 }, { id: 'rdb', kind: 'db' as Kind }, { id: 'q', kind: 'queue' as Kind }, { id: 'w', kind: 'worker' as Kind }, { id: 'wdb', kind: 'db' as Kind }],
      connections: [['users', 'api'], { from: 'api', to: 'cache', carries: 'reads' }, ['cache', 'rdb'], { from: 'api', to: 'q', carries: 'writes' }, ['q', 'w'], ['w', 'wdb']] as never,
    };
    const b = specToGraph(spec);
    const s = run(b, 100, { readRatio: 0.9 });
    expect(edgeRps(s, 'api', 'cache')).toBeCloseTo(90, 0);
    expect(edgeRps(s, 'api', 'q')).toBeCloseTo(10, 0);
    // the write path dies: only writes fail (10%), and the reads never notice
    patch(b, 'q', { alive: false });
    const f = run(b, 100, { readRatio: 0.9 }).global.errorRate;
    expect(f).toBeCloseTo(0.1, 2);
    const des = simulateDes(spec, { duration: 40, rps: 100, readRatio: 0.9, events: [{ at: 0, action: { type: 'kill-id', id: 'q' } }] }, { seed: 1 }).summary.meanErrorRate;
    expect(Math.abs(des - f)).toBeLessThan(0.03);
  });

  it('split routing shares a request stream evenly', () => {
    const b = board([U, { id: 'lb', kind: 'lb' }, { id: 'a', kind: 'server' }, { id: 'b', kind: 'server' }, { id: 'c', kind: 'server' }], [['users', 'lb'], ['lb', 'a'], ['lb', 'b'], ['lb', 'c']]);
    const s = run(b, 90);
    for (const x of ['a', 'b', 'c']) expect(edgeRps(s, 'lb', x)).toBeCloseTo(30, 0);
  });

  it('an autoscaler adds instances until the load fits its target, then the errors stop', () => {
    const b = board([U, { id: 'lb', kind: 'lb' }, { id: 'api', kind: 'server', instances: 1, autoscale: { min: 1, max: 8, targetUtil: 0.6, warmupS: 5, cooldownS: 30 } }], [['users', 'lb'], ['lb', 'api']]);
    const cap = KINDS.server.capacity;
    const s = run(b, cap * 3, { seconds: 120 });
    const live = s.nodeStats.api.scaling!.live;
    expect(live).toBeGreaterThanOrEqual(5);
    expect(live).toBeLessThanOrEqual(8);
    expect(s.global.errorRate).toBeLessThan(0.01);
    // and gives them back when the load goes
    const e = s.engine;
    for (let i = 0; i < 2400; i++) e.step(b.nodes as never, b.edges as never, cap * 0.3, 0.8, 0.05, DEFAULT_ENGINE_CONFIG);
    expect(e.snapshot(b.nodes as never, b.edges as never).nodeStats.api.scaling!.live).toBeLessThanOrEqual(2);
  });

  it('a database with a replica fails over: errors during the election, then served again', () => {
    const b = board([U, { id: 'api', kind: 'server' }, { id: 'db', kind: 'db' }, { id: 'r', kind: 'replica' }], [['users', 'api'], ['api', 'db'], ['db', 'r']]);
    const e = new Engine();
    const step = (n: number) => {
      for (let i = 0; i < n; i++) e.step(b.nodes as never, b.edges as never, 100, 0.8, 0.05, DEFAULT_ENGINE_CONFIG);
      return e.snapshot(b.nodes as never, b.edges as never);
    };
    expect(step(400).global.errorRate).toBeLessThan(0.001);
    patch(b, 'db', { alive: false });
    // electing (3 s): writes fail (20% of everything); reads go to the replica
    const electing = step(58).global.errorRate;
    expect(electing).toBeGreaterThan(0.15);
    expect(electing).toBeLessThan(0.25);
    expect(step(400).global.errorRate).toBeLessThan(0.01); // promoted
  });

  it('a flushed cache sends every request to its origin, then warms back up', () => {
    const b = board([U, { id: 'c', kind: 'cache', hitRate: 0.9, warmupS: 20 }, { id: 'db', kind: 'db' }], [['users', 'c'], ['c', 'db']]);
    const e = new Engine();
    const step = (n: number) => {
      for (let i = 0; i < n; i++) e.step(b.nodes as never, b.edges as never, 500, 0.8, 0.05, DEFAULT_ENGINE_CONFIG);
      return e.snapshot(b.nodes as never, b.edges as never);
    };
    const warm = 500 * (1 - 0.8 * 0.9);
    expect(edgeRps(step(1200), 'c', 'db')).toBeCloseTo(warm, 0);
    patch(b, 'c', { flushes: 1 } as Partial<SystemNodeData>);
    expect(edgeRps(step(40), 'c', 'db')).toBeGreaterThan(300);
    // re-warms exponentially: 80 s is four warm-up periods, e⁻⁴ of the hits still missing
    const cold = Math.exp(-4);
    expect(Math.abs(edgeRps(step(1600), 'c', 'db') - 500 * (1 - 0.8 * 0.9 * (1 - cold)))).toBeLessThan(2);
  });

  it('link latency adds to what users wait', () => {
    const plain = run(board([U, { id: 'api', kind: 'server' }], [['users', 'api']]), 20).nodeStats.users.latencyMs;
    const b = specToGraph({ components: [U, { id: 'api', kind: 'server' }], connections: [{ from: 'users', to: 'api', latencyMs: 80 }] });
    expect(run(b, 20).nodeStats.users.latencyMs - plain).toBeCloseTo(80, 0);
  });

  it('a serverless function is limited by its concurrency, and cold-starts on a jump', () => {
    const b = board([U, { id: 'fn', kind: 'function', limit: 100 }], [['users', 'fn']]);
    expect(run(b, 200).global.errorRate).toBeCloseTo(0.5, 2);
    const e = new Engine();
    for (let i = 0; i < 400; i++) e.step(b.nodes as never, b.edges as never, 10, 0.8, 0.05, DEFAULT_ENGINE_CONFIG);
    for (let i = 0; i < 4; i++) e.step(b.nodes as never, b.edges as never, 90, 0.8, 0.05, DEFAULT_ENGINE_CONFIG);
    expect(e.snapshot(b.nodes as never, b.edges as never).nodeStats.fn.coldFrac).toBeGreaterThan(0.3);
  });
});

describe('replication, partitions and failover (CAP)', () => {
  // a primary in one zone and its replica in another, 70 ms apart
  const spec = (replication: 'sync' | 'async') => ({
    components: [{ id: 'users', kind: 'client' as Kind }, { id: 'api', kind: 'server' as Kind }, { id: 'db', kind: 'db' as Kind }, { id: 'rep', kind: 'replica' as Kind }],
    connections: [['users', 'api'], ['api', 'db'], { from: 'db', to: 'rep', latencyMs: 70, replication }] as never,
    zones: [{ id: 'east', members: ['db'] }, { id: 'west', members: ['rep'] }],
  });
  const partition = { type: 'partition', a: 'east', b: 'west' } as const;

  it('a synchronous replica adds its round trip to every write, and stops writes when it is cut off', () => {
    const plain = simulate(spec('async'), { duration: 30, rps: 100, readRatio: 0.5 }).summary;
    const sync = simulate(spec('sync'), { duration: 30, rps: 100, readRatio: 0.5 }).summary;
    // every write (half the requests) waits 70 ms + the replica: the middle of the distribution moves most
    expect(sync.meanP99Ms).toBeGreaterThan(plain.meanP99Ms + 10);
    const [dPlain, dSync] = (['async', 'sync'] as const).map((m) => simulateDes(spec(m), { duration: 30, rps: 100, readRatio: 0.5 }, { seed: 1 }).summary);
    expect(dSync.p50Ms - dPlain.p50Ms).toBeGreaterThan(50);
    const cut = simulate(spec('sync'), { duration: 30, rps: 100, readRatio: 0.5, events: [{ at: 5, action: partition }] }).timeline.at(-1)!;
    // half the requests are writes: they all fail; reads keep working on the primary
    expect(cut.errorRate).toBeCloseTo(0.5, 1);
    const des = simulateDes(spec('sync'), { duration: 30, rps: 100, readRatio: 0.5, events: [{ at: 0, action: partition }] }, { seed: 1 }).summary.meanErrorRate;
    expect(des).toBeCloseTo(0.5, 1);
  });

  it('an asynchronous replica keeps writes working through a partition, and falls behind', () => {
    // the app reads the replica directly (writes go to the primary): cut off, it serves stale reads
    const direct = {
      ...spec('async'),
      connections: [['users', 'api'], { from: 'api', to: 'db', carries: 'writes' }, { from: 'api', to: 'rep', carries: 'reads' }, { from: 'db', to: 'rep', latencyMs: 70 }] as never,
    };
    const r = simulate(direct, { duration: 40, rps: 100, readRatio: 0.5, events: [{ at: 10, action: partition }] }).summary;
    expect(r.meanErrorRate).toBeLessThan(0.01);
    // cut off for 30 s: 30 s behind, and the reads it served meanwhile were stale
    expect(r.maxReplicaLagS ?? 0).toBeGreaterThan(28);
    expect(r.staleReads ?? 0).toBeGreaterThan(500);
    const d = simulateDes(direct, { duration: 40, rps: 100, readRatio: 0.5, events: [{ at: 10, action: partition }] }, { seed: 1 }).summary;
    expect(d.maxReplicaLagS ?? 0).toBeGreaterThan(27);
    expect(d.staleReads ?? 0).toBeGreaterThan(500);
  });

  it('failing over to a replica that fell behind loses the writes it never received', () => {
    const events = [{ at: 5, action: partition }, { at: 25, action: { type: 'kill-id', id: 'db' } }, { at: 25.01, action: { type: 'heal-partition' } }];
    // 20 s behind × 50 writes/s ≈ 1,000 writes lost when the replica is promoted
    const f = simulate(spec('async'), { duration: 40, rps: 100, readRatio: 0.5, events }).summary.lostWrites ?? 0;
    expect(f).toBeGreaterThan(800);
    expect(f).toBeLessThan(1200);
    const d = simulateDes(spec('async'), { duration: 40, rps: 100, readRatio: 0.5, events }, { seed: 1 }).summary.lostWrites ?? 0;
    expect(d).toBeGreaterThan(700);
    expect(d).toBeLessThan(1300);
    // synchronous: nothing lost
    expect(simulate(spec('sync'), { duration: 40, rps: 100, readRatio: 0.5, events: [{ at: 25, action: { type: 'kill-id', id: 'db' } }] }).summary.lostWrites ?? 0).toBe(0);
  });
});

describe('sharded databases and hot keys', () => {
  const U = { id: 'users', kind: 'client' as Kind };
  const spec = (shards: number, hotKeyShare?: number) => ({ components: [U, { id: 'db', kind: 'db' as const, shards, ...(hotKeyShare === undefined ? {} : { hotKeyShare }) }], connections: [['users', 'db'] as [string, string]] });
  const fluid = (shards: number, rps: number, hot?: number) => run(specToGraph(spec(shards, hot)), rps).global.errorRate;
  const des = (shards: number, rps: number, hot?: number) => simulateDes(spec(shards, hot), { duration: 40, rps }, { seed: 1 }).summary.meanErrorRate;

  it('N shards: N× the capacity and N× the cost', () => {
    const one = defaultData('db', 'db');
    const four = { ...one, shards: 4 };
    expect(capacityOf(four)).toBeCloseTo(4 * capacityOf(one), 6);
    expect(costOf(four)).toBeCloseTo(4 * costOf(one), 6);
    expect(fluid(1, 3600)).toBeGreaterThan(0.6);
    expect(fluid(4, 3600)).toBeLessThan(0.001);
    expect(des(4, 3600)).toBeLessThan(0.005);
  });

  it('a hot key overloads its shard while the others idle, and more shards do not fix it', () => {
    const cap = capacityOf(defaultData('db', 'db'));
    // 4 shards, 30% on one key: that shard takes 0.3 + 0.7 / 4 = 47.5% of 3,000 req/s
    const excess = (3000 * 0.475 - cap) / 3000;
    expect(fluid(4, 3000)).toBeLessThan(0.001);
    expect(Math.abs(fluid(4, 3000, 0.3) - excess)).toBeLessThan(0.02);
    expect(Math.abs(des(4, 3000, 0.3) - excess)).toBeLessThan(0.03);
    // twice the shards: the hot key is still one key on one shard
    expect(fluid(8, 3000, 0.3)).toBeGreaterThan(0.03);
    expect(des(8, 3000, 0.3)).toBeGreaterThan(0.03);
  });

  it('the hot shard is what the board shows: its utilisation, and the latency it adds', () => {
    const even = run(specToGraph(spec(4)), 2000).nodeStats.db;
    const hot = run(specToGraph(spec(4, 0.3)), 2000).nodeStats.db;
    expect(even.util).toBeCloseTo(0.5, 1);
    expect(hot.util).toBeCloseTo(0.95, 1);
    expect(hot.latencyMs).toBeGreaterThan(even.latencyMs);
  });
});

describe('what the board says about a component matches its numbers', () => {
  it('"Overloaded" only when more arrives than it can take; "hot" only when saturated or shedding', () => {
    const bad: string[] = [];
    for (let k = 0; k < 120; k++) {
      const spec = generate();
      const b = board(spec.components, spec.connections);
      const lastRps = pick([10, 300, 3000, 30000]);
      const s = run(b, lastRps, { seconds: 20 });
      for (const n of b.nodes.filter(isSystem)) {
        const d = n.data as SystemNodeData;
        const st = s.nodeStats[n.id];
        const v = nodeView(d, st, true, b.edges.some((e) => e.source === n.id));
        const x = explain(d, st, v);
        const cap = capacityOf(d, st.reachable);
        if (x?.text.startsWith('Overloaded') && st.inRps < cap * 0.98) bad.push(`${n.id} (${d.kind}): "${x.text}" at ${st.inRps.toFixed(0)}/${cap.toFixed(0)} req/s ${JSON.stringify(spec.components.find((c) => c.id === n.id))} → ${JSON.stringify(spec.connections.filter((c) => c[0] === n.id).map((c) => spec.components.find((x) => x.id === c[1])))}`);
        // users are "hot" when their requests fail (they have no capacity of their own)
        if (d.kind === 'client' && v.health === 'hot' && st.success >= 0.9) bad.push(`users hot at ${(st.success * 100).toFixed(1)}% success`);
        if (d.kind === 'client' && v.health === 'ok' && st.success < 0.99) bad.push(`users "Healthy" at ${(st.success * 100).toFixed(1)}% success`);
        if (d.kind !== 'client' && v.health === 'hot' && st.util < 0.9 && st.dropRps <= Math.max(1, st.inRps * 0.02)) bad.push(`${n.id} (${d.kind}): hot at util ${st.util.toFixed(2)} with no drops`);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });
});

describe('a backtest moment opened on the board', () => {
  for (const f of ['hotrod', 'shop', 'petclinic', 'k8s-shop']) {
    it(`${f}: healthy at the traffic it really served, and breaks where its model does`, () => {
      const { model, dataset } = JSON.parse(readFileSync(`public/reference/${f}.json`, 'utf8'));
      const { spec } = modelToSpec(model, basePlan(model, observedReplicas(dataset, model)));
      const total = (i: number) => Object.values(dataset.endpoints as Record<string, { rps?: (number | null)[] }>).reduce((a, e) => a + (e.rps?.[i] ?? 0), 0);
      const p90 = Array.from({ length: dataset.n }, (_, i) => total(i)).sort((a, b) => a - b)[Math.floor(dataset.n * 0.9)];
      const g = specToGraph(spec);
      expect(run(g, p90).global.errorRate).toBeLessThan(0.01);
      const m = modelBreakingPoint(model);
      // a limit the model fitted as errors growing with load is not something a board can draw
      if (m.limitedBy && !m.limitedBy.startsWith('errors')) {
        const b = breakingPoint(spec, { slo: { maxErrorRate: model.slo.errorRate, maxP99Ms: model.slo.p99Ms } });
        expect(b.maxRps / m.rps).toBeGreaterThan(0.7);
        expect(b.maxRps / m.rps).toBeLessThan(1.4);
      }
    });
  }
});

describe('call cycles', () => {
  it('requests that come back to a component that already ran this tick arrive next tick, not lost', () => {
    // users → lb → a → b, and b calls back into the lb half the time
    const b = board([{ id: 'users', kind: 'client' }, { id: 'lb', kind: 'lb' }, { id: 'a', kind: 'server', capacity: 10000 }, { id: 'b', kind: 'server', capacity: 10000 }, { id: 'c', kind: 'server', capacity: 10000 }], [['users', 'lb'], ['lb', 'a'], ['a', 'b'], ['b', 'lb'], ['b', 'c']]);
    const s = run(b, 100);
    // a sees the users' 100 plus half of everything b handles: a = 100 + a/2 → 200
    expect(s.nodeStats.a.inRps).toBeCloseTo(200, -1);
    expect(edgeRps(s, 'b', 'c')).toBeCloseTo(100, -1);
  });
});

describe('the fluid engine against the discrete-event one', () => {
  const chains: { name: string; spec: { components: Comp[]; connections: [string, string][] } }[] = [
    { name: 'users → api → db', spec: { components: [{ id: 'users', kind: 'client' }, { id: 'api', kind: 'server' }, { id: 'db', kind: 'db' }], connections: [['users', 'api'], ['api', 'db']] } },
    { name: 'users → lb → api×3 → cache → db', spec: { components: [{ id: 'users', kind: 'client' }, { id: 'lb', kind: 'lb' }, { id: 'api', kind: 'server', instances: 3 }, { id: 'cache', kind: 'cache', hitRate: 0.8 }, { id: 'db', kind: 'db' }], connections: [['users', 'lb'], ['lb', 'api'], ['api', 'cache'], ['cache', 'db']] } },
  ];
  for (const c of chains) {
    for (const load of [0.5, 1.5]) {
      it(`${c.name} at ${load}× its breaking point: error rates agree`, () => {
        const b = board(c.spec.components, c.spec.connections);
        // the narrowest capacity on the path
        const cap = Math.min(...b.nodes.filter(isSystem).map((n) => n.data as SystemNodeData).filter((d) => d.kind !== 'client' && d.kind !== 'lb' && d.kind !== 'cache').map((d) => capacityOf(d)));
        const rps = cap * load;
        const fluid = simulate({ components: c.spec.components, connections: c.spec.connections }, { duration: 60, rps }).summary.meanErrorRate;
        const des = simulateDes({ components: c.spec.components, connections: c.spec.connections }, { duration: 60, rps }, { seed: 1 }).summary.meanErrorRate;
        expect(Math.abs(fluid - des), `fluid ${fluid.toFixed(3)} vs des ${des.toFixed(3)}`).toBeLessThan(load < 1 ? 0.01 : 0.08);
      });
    }
  }
});
