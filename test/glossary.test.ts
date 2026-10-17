import { describe, expect, it } from 'vitest';
import { GLOSSARY, withTerms } from '../src/content/glossary';

describe('glossary', () => {
  it('underlines the first use of each term, longest match first', () => {
    const parts = withTerms('Retry amplification ×2: retries multiply the load; the p99 and the p99 again.');
    const terms = parts.filter((p) => typeof p !== 'string') as { term: string }[];
    expect(terms.map((t) => t.term)).toEqual(['Retry amplification', 'retries', 'p99']);
    expect(parts.map((p) => (typeof p === 'string' ? p : p.term)).join('')).toBe('Retry amplification ×2: retries multiply the load; the p99 and the p99 again.');
  });

  it('the explanations on search, vector, archive and edge nodes link their terms', async () => {
    const { specToGraph } = await import('../src/spec/convert');
    const { DEFAULT_ENGINE_CONFIG, Engine } = await import('../src/sim/engine');
    const { explain, nodeView } = await import('../src/canvas/nodeModel');
    const terms = (c: Record<string, unknown>, rps: number, readRatio = 0.9) => {
      const b = specToGraph({ components: [{ id: 'users', kind: 'client' }, { id: 'x', ...c } as never, { id: 'o', kind: 'server' }], connections: c.kind === 'edge' ? [['users', 'x'], ['x', 'o']] : [['users', 'x']] });
      const e = new Engine();
      for (let i = 0; i < 400; i++) e.step(b.nodes as never, b.edges as never, rps, readRatio, 0.05, DEFAULT_ENGINE_CONFIG);
      const st = e.snapshot(b.nodes as never, b.edges as never).nodeStats.x;
      const d = b.nodes.find((n) => n.id === 'x')!.data as never;
      const text = explain(d, st, nodeView(d, st, true, c.kind === 'edge'))?.text ?? '';
      return withTerms(text).filter((p) => typeof p !== 'string').map((p) => (p as { term: string }).term.toLowerCase());
    };
    expect(terms({ kind: 'search', refreshS: 30 }, 100)).toContain('refresh interval');
    expect(terms({ kind: 'vector', recall: 0.99 }, 50)).toEqual(expect.arrayContaining(['recall', 'ann']));
    expect(terms({ kind: 'vector', vectorsM: 10 }, 28)).toContain('hnsw');
    expect(terms({ kind: 'archive', retrieval: 'expedited' }, 2, 1)).toContain('restore');
    expect(terms({ kind: 'archive', limit: 10 }, 50, 1)).toContain('cold storage');
    expect(terms({ kind: 'edge', cpuMs: 4 }, 50)).toEqual(expect.arrayContaining(['cpu limit', 'edge function']));
    for (const t of ['refresh interval', 'recall', 'ANN', 'HNSW', 'cold storage', 'restore', 'edge function', 'CPU limit']) expect(GLOSSARY[t], t).toBeDefined();
  });

  it('the first lesson explains the words it is built on', async () => {
    const { lesson1 } = await import('../src/lessons/lesson1');
    const terms = (s: string) => withTerms(s).filter((p) => typeof p !== 'string').map((p) => (p as { term: string }).term.toLowerCase());
    const [, hn, viral, chaos] = lesson1.steps;
    expect(terms(hn.story)).toContain('req/s');
    expect(terms(hn.hint!)).toEqual(expect.arrayContaining(['instances', 'load balancer', 'headroom']));
    expect(terms(viral.hint!)).toContain('bottleneck');
    expect(terms(chaos.hint!)).toContain('n+1');
  });

  it('every definition is a sentence or two', () => {
    for (const [t, d] of Object.entries(GLOSSARY)) {
      expect(d, t).toMatch(/[.%”]$/);
      expect(d.length, t).toBeLessThan(220);
    }
  });
});
