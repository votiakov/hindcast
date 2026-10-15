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
      const node = specToGraph(spec(h)).nodes.find((n) => n.id === 'x')!;
      const st = f.nodeStats.x;
      const v = nodeView(node.data as never, st, true, h.conns.some(([a]) => a === 'x'));
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
      if (death!.severity === 'critical' || death!.severity === 'major') expect(death!.fixes.length, `${kind}: dies with nothing to propose`).toBeGreaterThan(0);
    });
  });
}
