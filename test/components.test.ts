import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINE_CONFIG, Engine } from '../src/sim/engine';
import { graphToSpec, specToGraph } from '../src/spec/convert';
import { validateSpec } from '../src/spec/validate';
import { KINDS, capacityOf, defaultData, type Kind } from '../src/sim/catalog';
import { simulateDes } from '../src/sim/des/des';
import { audit } from '../src/sim/audit';
import { explain, nodeView } from '../src/canvas/nodeModel';

/**
 * Every component kind, the same way: set up the way it is meant to be used, then checked against
 * what it claims — its defaults validate, below its capacity nothing fails, past it the excess is
 * shed (or queued) in both engines alike, the board says why, the spec round-trips, and the audit
 * replays its failure and has something to propose.
 */

type C = { id: string; kind: Kind } & Record<string, unknown>;
interface Harness {
  /** the minimal correct setup around the component under test, `x` */
  comps: C[];
  conns: [string, string][];
  /** the req/s at the users that saturates `x` */
  cap: number;
  readRatio?: number;
  /** past capacity: the excess is shed (errors), or queued (backlog, no errors) */
  over: 'shed' | 'queue';
  /** what overloads first and should say so (default: `x` itself) */
  focus?: string;
}

const U: C = { id: 'users', kind: 'client' };
const sink = (id: string, kind: Kind = 'server'): C => ({ id, kind, capacity: 1e7, latencyMs: 1 });
const alone = (kind: Kind, extra: Record<string, unknown> = {}): Harness => {
  const x = { id: 'x', kind, ...extra } as C;
  return { comps: [U, x], conns: [['users', 'x']], cap: capacityOf({ ...defaultData(kind, 'x'), ...extra } as never), over: 'shed' };
};

const HARNESS: Record<Exclude<Kind, 'client'>, Harness> = {
  server: alone('server'),
  worker: alone('worker'),
  storage: alone('storage'),
  db: alone('db'),
  replica: alone('replica'),
  llm: alone('llm'),
  function: alone('function'),
  llmapi: alone('llmapi'),
  external: alone('external'),
  kv: alone('kv'),
  // a cluster: its nodes share the queries without a balancer in front
  search: alone('search', { instances: 2 }),
  vector: alone('vector'),
  archive: alone('archive'),
  // runs on every request, answers half itself: past its capacity it sheds before the origin sees anything
  edge: { comps: [U, { id: 'x', kind: 'edge' }, sink('origin')], conns: [['users', 'x'], ['x', 'origin']], cap: KINDS.edge.capacity, over: 'shed' },
  // past what its subscriber drains: producers are still answered, the subscriber falls behind
  stream: { comps: [U, { id: 'x', kind: 'stream' }, { id: 'w', kind: 'worker' }], conns: [['users', 'x'], ['x', 'w']], cap: KINDS.worker.capacity, over: 'queue' },
  // a name that only answers: what is behind it overloads, and the board says so there
  dns: { comps: [U, { id: 'x', kind: 'dns' }, { id: 'app', kind: 'server' }], conns: [['users', 'x'], ['x', 'app']], cap: KINDS.server.capacity, over: 'shed', focus: 'app' },
  lb: { comps: [U, { id: 'x', kind: 'lb' }, sink('app')], conns: [['users', 'x'], ['x', 'app']], cap: KINDS.lb.capacity, over: 'shed' },
  gateway: { comps: [U, { id: 'x', kind: 'gateway' }, sink('app')], conns: [['users', 'x'], ['x', 'app']], cap: 1500, over: 'shed' },
  cache: { comps: [U, { id: 'x', kind: 'cache' }, sink('origin', 'db')], conns: [['users', 'x'], ['x', 'origin']], cap: KINDS.cache.capacity, readRatio: 1, over: 'shed' },
  cdn: { comps: [U, { id: 'x', kind: 'cdn' }, sink('origin')], conns: [['users', 'x'], ['x', 'origin']], cap: KINDS.cdn.capacity, readRatio: 1, over: 'shed' },
  queue: { comps: [U, { id: 'x', kind: 'queue' }, { id: 'w', kind: 'worker' }], conns: [['users', 'x'], ['x', 'w']], cap: KINDS.worker.capacity, over: 'queue' },
};

const spec = (h: Harness) => ({ version: 1 as const, name: 'harness', components: h.comps, connections: h.conns });

function fluid(h: Harness, rps: number, seconds = 60) {
  const b = specToGraph(spec(h));
  const e = new Engine();
  for (let i = 0; i < seconds / 0.05; i++) e.step(b.nodes as never, b.edges as never, rps, h.readRatio ?? 0.8, 0.05, DEFAULT_ENGINE_CONFIG);
  return e.snapshot(b.nodes as never, b.edges as never);
}
const des = (h: Harness, rps: number) => simulateDes(spec(h), { duration: 40, rps, readRatio: h.readRatio ?? 0.8 }, { seed: 7 }).summary;

for (const [kind, h] of Object.entries(HARNESS) as [Exclude<Kind, 'client'>, Harness][]) {
  describe(`component: ${kind}`, () => {
    it('its defaults make a valid spec, and the spec round-trips through the board', () => {
      const v = validateSpec(spec(h));
      expect(v.ok, JSON.stringify(v.issues)).toBe(true);
      const g = specToGraph(spec(h));
      const back = graphToSpec(g.nodes, g.edges, 'harness');
      expect(specToGraph(back).nodes.map((n) => n.data)).toEqual(g.nodes.map((n) => n.data));
      const d = defaultData(kind, 'x');
      expect(KINDS[kind].baseLatencyMs).toBeGreaterThan(0);
      expect(capacityOf(d)).toBeGreaterThan(0);
    });

    it('below its capacity nothing fails, in either engine', () => {
      const f = fluid(h, h.cap * 0.5);
      expect(f.global.errorRate).toBeLessThan(0.005);
      const d = des(h, h.cap * 0.5);
      expect(d.meanErrorRate).toBeLessThan(0.01);
      // the engines agree on what users wait, within the DES's sampling and a hop
      expect(Math.abs(f.global.p99 - d.p99Ms)).toBeLessThan(Math.max(25, 0.35 * d.p99Ms));
    });

    it(h.over === 'shed' ? 'past its capacity the excess is shed, alike in both engines' : 'past its consumers’ capacity producers see no errors; the backlog grows', () => {
      const f = fluid(h, h.cap * 2);
      const d = des(h, h.cap * 2);
      if (h.over === 'shed') {
        expect(f.global.errorRate).toBeGreaterThan(0.4);
        expect(f.global.errorRate).toBeLessThan(0.6);
        expect(Math.abs(f.global.errorRate - d.meanErrorRate)).toBeLessThan(0.06);
      } else {
        expect(f.global.errorRate).toBeLessThan(0.005);
        expect(d.meanErrorRate).toBeLessThan(0.01);
        expect(f.nodeStats.x.queue).toBeGreaterThan(h.cap * 10);
      }
    });

    it('the board says what is happening to it when it is overloaded', () => {
      const f = fluid(h, h.cap * 2);
      const id = h.focus ?? 'x';
      const node = specToGraph(spec(h)).nodes.find((n) => n.id === id)!;
      const st = f.nodeStats[id];
      const v = nodeView(node.data as never, st, true, h.conns.some(([a]) => a === id));
      expect(v.health === 'hot' || h.over === 'queue').toBe(true);
      const note = explain(node.data as never, st, v);
      expect(note, `${kind}: no explanation when overloaded`).not.toBeNull();
      expect(note!.text.length).toBeGreaterThan(20);
    });

    it('the audit replays its failure and has a fix to propose', () => {
      const r = audit(spec(h), { rps: h.cap * 0.5 });
      const own = r.findings.filter((f) => f.target === 'x');
      expect(own.length, `${kind}: no incident targets it`).toBeGreaterThan(0);
      const death = own.find((f) => f.kind === 'component' || f.kind === 'instance');
      expect(death, `${kind}: its death is not replayed`).toBeDefined();
      // a DNS provider's outage has a remedy (a second provider) that is named, not modelled
      if (kind === 'dns') expect(death!.explanation).toContain('second DNS provider');
      else if (death!.severity === 'critical' || death!.severity === 'major') expect(death!.fixes.length, `${kind}: dies with nothing to propose`).toBeGreaterThan(0);
    });
  });
}

describe('a third-party API answers itself: it never calls your components', () => {
  // a link drawn out of the provider (by mistake, or a webhook drawn as a call) carries nothing
  for (const kind of ['external', 'llmapi'] as Kind[]) {
    const h: Harness = { comps: [U, { id: 'x', kind }, { id: 'app', kind: 'server', capacity: 10 }], conns: [['users', 'x'], ['x', 'app']], cap: 0, over: 'shed' };
    it(`${kind}: no load reaches what it links to, in either engine, and validate flags the link`, () => {
      // 50 req/s (half the provider's default limit) would overload `app` fivefold if the provider passed it on
      const f = fluid(h, 50);
      expect(f.nodeStats.x.inRps).toBeGreaterThan(45);
      expect(f.nodeStats.app.inRps).toBe(0);
      expect(f.global.errorRate).toBeLessThan(0.005);
      expect(f.global.p99).toBeLessThan(KINDS[kind].baseLatencyMs * 4);
      expect(des(h, 50).meanErrorRate).toBeLessThan(0.01);
      const v = validateSpec(spec(h));
      expect(v.ok).toBe(true);
      expect(v.issues.map((i) => i.message)).toContainEqual(expect.stringContaining(`${kind} "x" is a third-party API`));
    });
  }
});

describe('a key-value store: the table scales, a partition does not', () => {
  const kvSpec = (limit: number, hotKeyShare?: number) => ({ components: [U, { id: 'x', kind: 'kv' as Kind, limit, ...(hotKeyShare ? { hotKeyShare } : {}) }], connections: [['users', 'x'] as [string, string]] });
  const h = (limit: number, hot?: number): Harness => ({ ...spec({ comps: [], conns: [], cap: 0, over: 'shed' }), comps: kvSpec(limit, hot).components, conns: kvSpec(limit, hot).connections, cap: limit, over: 'shed' });

  it('a hot key is throttled at one partition’s 3,000 reads / 1,000 writes a second — reads first — in both engines', () => {
    // 20,000 req/s, 80% reads, 30% for one key: 4,800 reads and 1,200 writes a second for one partition.
    // Reads cost a third of a write and take the tokens first: 3,000 reads fill the partition, writes starve
    const want = (20000 * 0.3 - 3000) / 20000;
    expect(Math.abs(fluid(h(40000, 0.3), 20000).global.errorRate - want)).toBeLessThan(0.02);
    expect(Math.abs(des(h(40000, 0.3), 20000).meanErrorRate - want)).toBeLessThan(0.03);
  });

  it('raising the table’s limit does not help the hot key; without one, the same load is served', () => {
    expect(fluid(h(100000, 0.3), 20000).global.errorRate).toBeGreaterThan(0.12);
    expect(fluid(h(40000), 20000).global.errorRate).toBeLessThan(0.001);
  });
});

describe('DNS: failover waits for the health check, then for the caches', () => {
  // two regions behind a name; us-east dies at 5 s
  const regions = (ttlS: number) => ({
    components: [U, { id: 'x', kind: 'dns' as Kind, routing: 'failover', ttlS, healthCheckS: 10 }, { id: 'east', kind: 'server' as Kind, capacity: 1e5 }, { id: 'west', kind: 'server' as Kind, capacity: 1e5 }],
    connections: [['users', 'x'], ['x', 'east'], ['x', 'west']] as [string, string][],
  });
  const sc = { duration: 60, rps: 200, events: [{ at: 5, action: { type: 'kill-id' as const, id: 'east' } }] };
  const fluidMean = (ttl: number) => {
    const b = specToGraph(regions(ttl));
    const e = new Engine();
    let failed = 0;
    for (let i = 0; i < 1200; i++) {
      if (i === 100) b.nodes.find((n) => n.id === 'east')!.data = { ...(b.nodes.find((n) => n.id === 'east')!.data as object), alive: false } as never;
      e.step(b.nodes as never, b.edges as never, 200, 0.8, 0.05, DEFAULT_ENGINE_CONFIG);
      failed += e.snapshot(b.nodes as never, b.edges as never).global.errorRate;
    }
    return failed / 1200;
  };

  it('every client fails until the check notices, then fewer as cached answers expire over the TTL', () => {
    // 10 s of everyone, then a TTL of falling off: (10 + TTL / 2) s of the 60 out
    for (const ttl of [20, 5]) {
      const want = (10 + ttl / 2) / 60;
      expect(Math.abs(fluidMean(ttl) - want), `fluid, TTL ${ttl}`).toBeLessThan(0.02);
      expect(Math.abs(simulateDes(regions(ttl), sc, { seed: 3 }).summary.meanErrorRate - want), `DES, TTL ${ttl}`).toBeLessThan(0.03);
    }
  });

  it('round-robin answers lose only the dead region’s share while they last', () => {
    const rr = { ...regions(20), components: regions(20).components.map((c) => (c.id === 'x' ? { id: 'x', kind: 'dns' as Kind, ttlS: 20, healthCheckS: 10 } : c)) };
    const d = simulateDes(rr, sc, { seed: 3 }).summary.meanErrorRate;
    expect(Math.abs(d - (10 + 10) / 60 / 2)).toBeLessThan(0.03);
  });
});

describe('a stream: every subscriber reads everything, at its own pace', () => {
  const two = { components: [U, { id: 'x', kind: 'stream' as Kind }, { id: 'fast', kind: 'worker' as Kind, instances: 4 }, { id: 'slow', kind: 'worker' as Kind }], connections: [['users', 'x'], ['x', 'fast'], ['x', 'slow']] as [string, string][] };

  it('each subscriber gets every message; a slow one falls behind without slowing the others or failing producers', () => {
    const b = specToGraph(two);
    const e = new Engine();
    for (let i = 0; i < 1200; i++) e.step(b.nodes as never, b.edges as never, 200, 0.8, 0.05, DEFAULT_ENGINE_CONFIG);
    const s = e.snapshot(b.nodes as never, b.edges as never);
    expect(s.edgeStats['e-x-fast'].rps).toBeCloseTo(200, 0);
    expect(s.edgeStats['e-x-slow'].rps).toBeCloseTo(100, 0); // all it can drain
    expect(s.nodeStats.x.lagS).toBeGreaterThan(50);
    expect(s.global.errorRate).toBeLessThan(0.001);
    const d = simulateDes(two, { duration: 40, rps: 200 }, { seed: 5 });
    expect(d.summary.meanErrorRate).toBeLessThan(0.005);
    expect(d.components.fast.meanUtil).toBeGreaterThan(0.4);
    expect(d.components.fast.meanUtil).toBeLessThan(0.6);
    expect(d.components.slow.meanUtil).toBeGreaterThan(0.9);
  });

  it('a subscriber cannot use more consumers than the stream has partitions', () => {
    const sub = (partitions: number) => ({ components: [U, { id: 'x', kind: 'stream' as Kind, partitions }, { id: 'w', kind: 'worker' as Kind, instances: 8 }], connections: [['users', 'x'], ['x', 'w']] as [string, string][] });
    for (const [p, util] of [[2, 0.25], [8, 0.75]] as const) {
      const b = specToGraph(sub(p));
      const e = new Engine();
      for (let i = 0; i < 1200; i++) e.step(b.nodes as never, b.edges as never, 600, 0.8, 0.05, DEFAULT_ENGINE_CONFIG);
      // 8 workers can drain 800/s; with 2 partitions only 2 of them get one
      expect(e.snapshot(b.nodes as never, b.edges as never).edgeStats['e-x-w'].rps, `fluid, ${p} partitions`).toBeCloseTo(Math.min(600, p * 100), 0);
      expect(Math.abs(simulateDes(sub(p), { duration: 40, rps: 600 }, { seed: 5 }).components.w.meanUtil - util), `DES, ${p} partitions`).toBeLessThan(0.06);
    }
  });

  it('a queue splits the messages between its consumers; a stream gives each all of them', () => {
    const q = { ...two, components: two.components.map((c) => (c.id === 'x' ? { id: 'x', kind: 'queue' as Kind } : c)) };
    const b = specToGraph(q);
    const e = new Engine();
    for (let i = 0; i < 1200; i++) e.step(b.nodes as never, b.edges as never, 200, 0.8, 0.05, DEFAULT_ENGINE_CONFIG);
    const s = e.snapshot(b.nodes as never, b.edges as never);
    expect(s.edgeStats['e-x-fast'].rps + s.edgeStats['e-x-slow'].rps).toBeCloseTo(200, 0);
  });
});

describe('what a card says, for the first mistakes a learner makes', () => {
  const run = (components: C[], connections: [string, string][], rps: number) => {
    const b = specToGraph({ components, connections } as never);
    const e = new Engine();
    for (let i = 0; i < 400; i++) e.step(b.nodes as never, b.edges as never, rps, 0.8, 0.05, DEFAULT_ENGINE_CONFIG);
    const snap = e.snapshot(b.nodes as never, b.edges as never);
    return (id: string) => {
      const d = b.nodes.find((n) => n.id === id)!.data as never;
      const v = nodeView(d, snap.nodeStats[id], true, b.edges.some((x) => x.source === id));
      return { text: explain(d, snap.nodeStats[id], v)?.text ?? '', v };
    };
  };

  it('instances added without a load balancer: the overload says only one of them gets traffic, and why', () => {
    const card = run([U, { id: 'api', kind: 'server', instances: 4 }], [['users', 'api']], 700)('api');
    expect(card.text).toMatch(/^Overloaded/);
    expect(card.text).toContain('Only 1 of its 4 instances get traffic: without a load balancer');
  });

  it('behind a load balancer, the overload says nothing about reach', () => {
    const card = run([U, { id: 'lb', kind: 'lb' }, { id: 'api', kind: 'server', instances: 2 }], [['users', 'lb'], ['lb', 'api']], 900)('api');
    expect(card.text).toMatch(/^Overloaded/);
    expect(card.text).not.toContain('instances get traffic');
  });

  it('a DNS name with nothing behind it says so, not that clients hold a stale answer; its capacity reads "no limit"', () => {
    const card = run([U, { id: 'dns', kind: 'dns' }], [['users', 'dns']], 100)('dns');
    expect(card.text).toMatch(/^Nothing behind this name/);
    expect(card.v.stats.find((s) => s.label === 'cap')?.value).toBe('no limit');
  });
});
