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
