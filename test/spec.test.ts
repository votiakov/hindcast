import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { graphToSpec, specToGraph, applyVariant } from '../src/spec/convert';
import { validateSpec } from '../src/spec/validate';
import { ArchitectureSpec } from '../src/spec/schema';
import { importTerraform } from '../src/spec/terraform';
import { shop } from './fixtures';

describe('spec', () => {
  it('round-trips spec → graph → spec', () => {
    const g = specToGraph(shop);
    const back = graphToSpec(g.nodes, g.edges, 'Web shop');
    expect(back.components.map((c) => c.id)).toEqual(shop.components.map((c) => c.id));
    expect(back.connections).toHaveLength(3);
    expect(back.components.find((c) => c.id === 'api')?.instances).toBe(4);
  });

  it('validates the bundled examples', () => {
    for (const f of ['shop.yaml']) {
      const r = validateSpec(parse(readFileSync(`examples/${f}`, 'utf8')));
      expect(r.ok, JSON.stringify(r.issues)).toBe(true);
    }
  });

  it('flags a connection to an unknown component', () => {
    const r = validateSpec({ ...shop, connections: [...shop.connections, ['api', 'ghost']] });
    expect(r.ok).toBe(false);
  });

  it('applies variant edit lists', () => {
    const v = applyVariant(ArchitectureSpec.parse(shop), { name: 'cache', changes: [{ op: 'add', component: { id: 'redis', kind: 'cache' } }, { op: 'disconnect', from: 'api', to: 'db' }, { op: 'connect', from: 'api', to: 'redis' }, { op: 'connect', from: 'redis', to: 'db' }] });
    expect(v.components.map((c) => c.id)).toContain('redis');
    expect(v.connections).toHaveLength(4);
  });

  it('imports the example terraform state', () => {
    const r = importTerraform(JSON.parse(readFileSync('examples/terraform/shop.tfstate.json', 'utf8')));
    expect(r.spec.components.length).toBeGreaterThan(2);
    expect(validateSpec(r.spec).ok).toBe(true);
  });
});

import { parseAllDocuments } from 'yaml';
import { importKubernetes } from '../src/spec/kubernetes';

describe('kubernetes import', () => {
  const docs = parseAllDocuments(readFileSync('examples/kubernetes/shop.yaml', 'utf8')).map((d) => d.toJS());
  const r = importKubernetes(docs, 'shop');
  const byId = new Map(r.spec.components.map((c) => [c.id, c]));

  it('maps workloads by image and HPAs to autoscaling', () => {
    expect(byId.get('postgres')?.kind).toBe('db');
    expect(byId.get('redis')?.kind).toBe('cache');
    expect(byId.get('rabbitmq')?.kind).toBe('queue');
    expect(byId.get('web')?.autoscale).toMatchObject({ min: 3, max: 12, targetUtil: 0.65 });
    expect(byId.get('postgres-replica-1')?.kind).toBe('replica');
  });

  it('wires ingress, env references, queue consumers and cache-aside', () => {
    const conns = r.spec.connections.map((c) => (Array.isArray(c) ? c.join('>') : `${c.from}>${c.to}`));
    expect(conns).toEqual(expect.arrayContaining(['users>shop', 'shop>web', 'web>redis', 'redis>postgres', 'web>rabbitmq', 'rabbitmq>mailer']));
    expect(byId.get('mailer')?.kind).toBe('worker');
  });

  it('produces a valid spec', () => {
    expect(validateSpec(r.spec).ok).toBe(true);
  });

  it('gives a plain Postgres StatefulSet no automatic failover, and an operator one the default', () => {
    expect(byId.get('postgres')?.failoverS).toBe(1800);
    expect(r.assumptions.some((a) => a.includes('no automatic failover'))).toBe(true);
    const patroni = docs.map((d) => (d.kind === 'StatefulSet' && d.metadata.name === 'postgres' ? { ...d, spec: { ...d.spec, template: { ...d.spec.template, spec: { containers: [{ name: 'postgres', image: 'ghcr.io/zalando/spilo-16:3.2-p2' }] } } } } : d));
    const p = importKubernetes(patroni, 'shop');
    expect(p.spec.components.find((c) => c.id === 'postgres')?.failoverS).toBeUndefined();
    expect(p.assumptions.some((a) => a.includes('automatic failover assumed'))).toBe(true);
  });
});

import { parseTrafficCsv } from '../src/spec/trafficCsv';

describe('traffic csv', () => {
  it('reads a day of metrics with ISO timestamps and compresses it', () => {
    const t = parseTrafficCsv(readFileSync('examples/traffic-day.csv', 'utf8'), { maxDurationS: 300 });
    expect(t.spanS).toBeGreaterThan(23 * 3600);
    expect(t.compression).toBeGreaterThan(250);
    expect(t.traffic.at(-1)!.at).toBeCloseTo(300, 0);
    expect(t.peak).toBeGreaterThan(1000);
  });
  it('accepts epoch-ms and per-second rows, skipping headers', () => {
    const t = parseTrafficCsv('time,rps\n1700000000000,100\n1700000010000,250\n1700000020000,90\n');
    expect(t.compression).toBe(1);
    expect(t.traffic.map((x) => x.at)).toEqual([0, 10, 20]);
    expect(t.peak).toBe(250);
  });
});

describe('notes on the board', () => {
  it('travel through the spec and back, and the engines ignore them', async () => {
    const { graphToSpec, specToGraph } = await import('../src/spec/convert');
    const { simulate } = await import('../src/sim/headless');
    const spec = { version: 1, components: [{ id: 'u', kind: 'client' }, { id: 'api', kind: 'server' }], connections: [['u', 'api']], notes: [{ text: 'one server, for now', x: 10, y: -120 }] };
    const g = specToGraph(spec);
    const note = g.nodes.find((n) => n.type === 'note')!;
    expect(note.data).toEqual({ text: 'one server, for now' });
    expect(graphToSpec(g.nodes, g.edges).notes).toEqual([{ text: 'one server, for now', x: 10, y: -120 }]);
    expect(simulate(spec as never, { duration: 5, rps: 50 } as never).summary.meanErrorRate).toBe(0);
  });
});

// every knob the schema accepts survives the engine's key lists (a new knob missing from one of
// them is silently dropped: the canonical spec, the board, the engine)
describe('component keys', () => {
  const keys = Object.keys(ArchitectureSpec.shape.components.element.shape).filter((k) => !['id', 'kind', 'name'].includes(k)).sort();
  const listed = (file: string, name: string) => {
    const m = readFileSync(file, 'utf8').match(new RegExp(`${name}(?::[^=]*)? = \\[([^\\]]*)\\]`));
    return m![1].split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter((k) => k && !['id', 'kind', 'name'].includes(k)).sort();
  };
  it('the CLI canonical spec keeps every one', () => expect(listed('engine-rs/src/cli/sim.rs', 'const COMPONENT_KEYS')).toEqual(keys));
  it('the engine reads every one', () => expect(listed('engine-rs/src/sim/spec.rs', 'const DATA_KEYS')).toEqual(keys));
  it('the board keeps every one', () => expect(listed('src/spec/convert.ts', 'const DATA_KEYS')).toEqual(keys));
});

// the same for a link's properties: the canonical spec and the connect edit keep each one
describe('connection keys', () => {
  const object = ArchitectureSpec.shape.connections.element.options[2] as unknown as { shape: Record<string, unknown> };
  const keys = Object.keys(object.shape).filter((k) => k !== 'from' && k !== 'to').sort();
  const lists = (file: string) => [...readFileSync(file, 'utf8').matchAll(/for k in \[([^\]]*"latencyMs"[^\]]*)\]/g)].map((m) => m[1].split(',').map((x) => x.trim().replace(/^"|"$/g, '')).filter((k) => k !== 'from' && k !== 'to').sort());
  it('the CLI canonical spec keeps every one', () => expect(lists('engine-rs/src/cli/sim.rs')).toEqual([keys]));
  it('the connect edit keeps every one', () => expect(lists('engine-rs/src/cli/design.rs')).toEqual([keys]));
  it('a link round-trips through the board', () => {
    for (const reconnect of [240, 'until-restart'] as const) {
      const spec = { version: 1 as const, components: [{ id: 'api', kind: 'server' as const }, { id: 'cart', kind: 'server' as const }], connections: [{ from: 'api', to: 'cart', reconnect }] };
      expect(ArchitectureSpec.safeParse(spec).success).toBe(true);
      const g = specToGraph(spec);
      expect(graphToSpec(g.nodes, g.edges).connections).toEqual([{ from: 'api', to: 'cart', reconnect }]);
    }
    expect(ArchitectureSpec.safeParse({ components: [{ id: 'a', kind: 'server' }], connections: [{ from: 'a', to: 'a', reconnect: 'never' }] }).success).toBe(false);
  });
});
