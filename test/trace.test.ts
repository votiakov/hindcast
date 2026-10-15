import { describe, expect, it } from 'vitest';
import { traceRequest } from '../src/ui/traceRequest';
import type { AppNode, SystemEdge } from '../src/sim/catalog';
import { defaultData } from '../src/sim/catalog';
import type { EdgeStats, NodeStats } from '../src/sim/engine';

const node = (id: string, kind: Parameters<typeof defaultData>[0]): AppNode => ({ id, type: 'system', position: { x: 0, y: 0 }, data: defaultData(kind, id) });
const st = (o: Partial<NodeStats>) => ({ inRps: 100, dropRps: 0, hitRps: 0, ownMs: 10, ...o }) as NodeStats;

describe('a request, hop by hop', () => {
  const nodes = [node('u', 'client'), node('api', 'server'), node('cache', 'cache'), node('db', 'db')];
  const edges: SystemEdge[] = [
    { id: 'e1', source: 'u', target: 'api', data: { latencyMs: 2 } },
    { id: 'e2', source: 'api', target: 'cache' },
    { id: 'e3', source: 'cache', target: 'db' },
  ];
  const edgeStats: Record<string, EdgeStats> = { e1: { rps: 100, errRatio: 0, util: 0 }, e2: { rps: 100, errRatio: 0, util: 0 }, e3: { rps: 20, errRatio: 0, util: 0 } };

  it('splits each hop into network, queue and service, and stops where the request is answered', () => {
    const stats = { u: st({}), api: st({ ownMs: 40 }), cache: st({ hitRps: 80, ownMs: 1 }), db: st({ ownMs: 12 }) };
    // rand 0.99: no failure, no cache hit — the request goes all the way to the database
    const all = traceRequest(nodes, edges, stats, edgeStats, () => 0.99);
    expect(all.map((h) => h.id)).toEqual(['api', 'cache', 'db']);
    const api = all[0];
    expect(api.networkMs).toBe(2);
    expect(api.serviceMs + api.queuedMs).toBeCloseTo(40, 6);
    expect(api.queuedMs).toBeGreaterThan(0);
    // rand 0.5: the cache answers (80% hits)
    expect(traceRequest(nodes, edges, stats, edgeStats, () => 0.5).map((h) => [h.id, h.hit ?? false])).toEqual([['api', false], ['cache', true]]);
    // a component dropping every request is where it ends
    const failing = traceRequest(nodes, edges, { ...stats, api: st({ dropRps: 100 }) }, edgeStats, () => 0.5);
    expect(failing).toHaveLength(1);
    expect(failing[0].failed).toBe(true);
  });
});
