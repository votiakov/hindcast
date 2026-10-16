import { beforeEach, describe, expect, it } from 'vitest';
import { useSim } from '../src/sim/store';
import { specToGraph } from '../src/spec/convert';
import type { SectionNode } from '../src/sim/catalog';

const S = () => useSim.getState();
const board = () => S().boards.main;
const shop = {
  version: 1,
  components: [
    { id: 'users', kind: 'client' },
    { id: 'lb', kind: 'lb' },
    { id: 'api-1', kind: 'server' },
    { id: 'db', kind: 'db' },
    { id: 'jobs', kind: 'queue' },
  ],
  connections: ['users -> lb', 'lb -> api-1', 'api-1 -> jobs', { from: 'api-1', to: 'db', latencyMs: 2 }],
};

beforeEach(() => {
  S().setMode('sandbox');
  S().loadGraph('main', specToGraph(shop), 'shop');
});

describe('sections, edited on the board', () => {
  it('group the selection, rename, undo and redo', () => {
    S().addSection('main', ['lb', 'api-1']);
    const sec = () => board().nodes.find((n) => n.type === 'section') as SectionNode | undefined;
    expect(sec()!.data).toEqual({ label: '', members: ['lb', 'api-1'] });
    S().renameSection('main', sec()!.id, 'checkout path');
    expect(sec()!.data.label).toBe('checkout path');
    S().undo('main');
    expect(sec()!.data.label).toBe('');
    S().undo('main');
    expect(sec()).toBeUndefined();
    S().redo('main');
    S().redo('main');
    expect(sec()!.data.label).toBe('checkout path');
  });

  it('only group components that exist, and nothing from an empty selection', () => {
    expect(S().addSection('main', [])).toBeNull();
    expect(S().addSection('main', ['ghost'])).toBeNull();
    expect(board().nodes.some((n) => n.type === 'section')).toBe(false);
  });

  it('copy along with all their members, and frame the copies', () => {
    S().addSection('main', ['lb', 'api-1'], 'front');
    useSim.setState((s) => ({ boards: { ...s.boards, main: { ...s.boards.main, nodes: s.boards.main.nodes.map((n) => ({ ...n, selected: n.id === 'lb' || n.id === 'api-1' })) } } }));
    const clip = S().copySelection('main')!;
    expect(clip.sections).toEqual([{ label: 'front', members: ['lb', 'api-1'] }]);
    S().paste('main', clip);
    const secs = board().nodes.filter((n) => n.type === 'section') as SectionNode[];
    expect(secs).toHaveLength(2);
    const copy = secs.find((x) => !x.data.members.includes('lb'))!;
    expect(copy.data.label).toBe('front');
    expect(copy.data.members).toHaveLength(2);
    for (const m of copy.data.members) expect(board().nodes.some((n) => n.id === m && n.type === 'system')).toBe(true);
  });

  it('are not copied with only part of their members', () => {
    S().addSection('main', ['lb', 'api-1'], 'front');
    useSim.setState((s) => ({ boards: { ...s.boards, main: { ...s.boards.main, nodes: s.boards.main.nodes.map((n) => ({ ...n, selected: n.id === 'lb' })) } } }));
    expect(S().copySelection('main')!.sections).toBeUndefined();
  });
});

describe('a palette click with a component selected', () => {
  const links = () => board().edges.map((e) => `${e.source}>${e.target}`).sort();
  it('puts a cache between the component and its database, the link keeping its latency', () => {
    S().addNode('main', 'cache', { x: 0, y: 0 }, 'api-1');
    const cache = board().nodes.find((n) => n.type === 'system' && n.data.kind === 'cache')!;
    expect(links()).toEqual([`${cache.id}>db`, `api-1>${cache.id}`, 'api-1>jobs', 'lb>api-1', 'users>lb'].sort());
    expect(board().edges.find((e) => e.source === cache.id)!.data).toEqual({ latencyMs: 2 });
    S().undo('main');
    expect(links()).toEqual(['api-1>db', 'api-1>jobs', 'lb>api-1', 'users>lb']);
  });

  it('puts a CDN between the users and what they call', () => {
    S().addNode('main', 'cdn', { x: 0, y: 0 }, 'users');
    const cdn = board().nodes.find((n) => n.type === 'system' && n.data.kind === 'cdn')!;
    expect(links()).toContain(`users>${cdn.id}`);
    expect(links()).toContain(`${cdn.id}>lb`);
    expect(links()).not.toContain('users>lb');
  });

  it('appends any other kind after it, as before', () => {
    S().addNode('main', 'worker', { x: 0, y: 0 }, 'api-1');
    const w = board().nodes.find((n) => n.type === 'system' && n.data.kind === 'worker')!;
    expect(links()).toEqual(['api-1>db', 'api-1>jobs', `api-1>${w.id}`, 'lb>api-1', 'users>lb'].sort());
  });

  it('appends a cache after a component that calls nothing', () => {
    S().addNode('main', 'cache', { x: 0, y: 0 }, 'db');
    const cache = board().nodes.find((n) => n.type === 'system' && n.data.kind === 'cache')!;
    expect(links()).toContain(`db>${cache.id}`);
    expect(links()).toContain('api-1>db');
  });
});

describe('replaying a lesson level', () => {
  it('starts the run again from zero, without the last run\'s readings', () => {
    S().setMode('lesson');
    S().setRunning(true);
    for (let i = 0; i < 40; i++) S().tick(0.25);
    expect(S().lesson.stepT).toBeGreaterThan(0);
    expect(Object.keys(board().nodeStats).length).toBeGreaterThan(0);
    S().setRunning(false);
    S().replayLevel();
    expect(S().lesson.stepT).toBe(0);
    expect(S().simT).toBe(0);
    expect(board().nodeStats).toEqual({});
    expect(board().global.rps).toBe(0);
    expect(S().running).toBe(true);
  });
});
