import { describe, expect, it } from 'vitest';
import { graphToSpec, mergeSpecIntoGraph, specToGraph } from '../src/spec/convert';
import { validateSpec } from '../src/spec/validate';
import { simulate, toMermaid } from '../src/sim/headless';
import { fitSections } from '../src/sim/sections';
import type { AppNode, SectionNode } from '../src/sim/catalog';

/** sections: a labelled frame around components, for reading the design; the engines ignore them */
const spec = {
  version: 1,
  components: [
    { id: 'users', kind: 'client' },
    { id: 'lb', kind: 'lb' },
    { id: 'api', kind: 'server', instances: 4 },
    { id: 'orders', kind: 'db' },
    { id: 'cache', kind: 'cache' },
    { id: 'worker', kind: 'worker' },
  ],
  connections: ['users -> lb', 'lb -> api', 'api -> orders', 'api -> cache', 'api -> worker'],
  zones: [{ id: 'az-a', label: 'us-east-1a', members: ['cache', 'worker'] }],
  sections: [{ label: 'checkout path', members: ['lb', 'api', 'orders'] }],
};

describe('sections on the board', () => {
  it('travel through the spec and back', () => {
    const g = specToGraph(spec);
    const s = g.nodes.find((n) => n.type === 'section') as SectionNode;
    expect(s.data).toEqual({ label: 'checkout path', members: ['lb', 'api', 'orders'] });
    const back = graphToSpec(g.nodes, g.edges);
    expect(back.sections).toEqual(spec.sections);
    // zones are still zones
    expect(back.zones?.[0].members.sort()).toEqual(['cache', 'worker']);
  });

  it('drop members that are gone, and a section with none left', () => {
    const g = specToGraph(spec);
    const nodes = g.nodes.filter((n) => n.id !== 'orders');
    expect(graphToSpec(nodes, g.edges).sections).toEqual([{ label: 'checkout path', members: ['lb', 'api'] }]);
    const none = g.nodes.filter((n) => !['lb', 'api', 'orders'].includes(n.id));
    expect(graphToSpec(none, g.edges).sections).toBeUndefined();
  });

  it('are ignored by the engines', () => {
    const { sections: _s, ...plain } = spec;
    const a = simulate(spec as never, { duration: 10, rps: 200, seed: 1 } as never).summary;
    const b = simulate(plain as never, { duration: 10, rps: 200, seed: 1 } as never).summary;
    expect(a).toEqual(b);
  });

  it('warn about a member that is not a component', () => {
    const v = validateSpec({ ...spec, sections: [{ label: 'x', members: ['api', 'ghost'] }] });
    expect(v.ok).toBe(true);
    expect(v.issues).toContainEqual({ level: 'warning', message: 'section "x" lists unknown member "ghost"', path: ['sections', 0, 'members', 1] });
  });

  it('fit their members, wherever they are moved', () => {
    const g = specToGraph(spec);
    const fitted = fitSections(g.nodes);
    const s = fitted.find((n) => n.type === 'section')!;
    const ms = g.nodes.filter((n) => ['lb', 'api', 'orders'].includes(n.id));
    for (const m of ms) {
      expect(m.position.x).toBeGreaterThan(s.position.x);
      expect(m.position.y).toBeGreaterThan(s.position.y);
      expect(m.position.x + 236).toBeLessThan(s.position.x + s.width!);
    }
    const far = { x: s.position.x + s.width! + 400, y: s.position.y + s.height! + 300 };
    const moved = g.nodes.map((n) => (n.id === 'orders' ? ({ ...n, position: far } as AppNode) : n));
    const s2 = fitSections(moved).find((n) => n.type === 'section')!;
    expect(s2.position.x + s2.width!).toBe(far.x + 236 + 22);
    expect(s2.position.y + s2.height!).toBe(far.y + 150 + 22);
    // none left: hidden, kept for undo
    expect(fitSections(g.nodes.filter((n) => !['lb', 'api', 'orders'].includes(n.id))).find((n) => n.type === 'section')!.hidden).toBe(true);
  });

  it('keep their frame through a YAML edit', () => {
    const g = specToGraph(spec);
    const merged = mergeSpecIntoGraph({ ...spec, sections: [{ label: 'renamed', members: ['lb', 'api'] }] }, g);
    expect(merged.nodes.find((n) => n.type === 'section')!.data).toEqual({ label: 'renamed', members: ['lb', 'api'] });
  });

  it('become dotted subgraphs in Mermaid, next to the zone', () => {
    const m = toMermaid(spec);
    expect(m).toContain('subgraph section_checkout_path["checkout path"]');
    expect(m).toContain('subgraph zone_az_a["us-east-1a"]');
    expect(m).toContain('style section_checkout_path stroke-dasharray: 4 4');
  });
});
