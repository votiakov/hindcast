import { defaultData, isSystem, type AppNode, type SystemEdge, type SystemNodeData } from '../sim/catalog';
import type { Graph } from '../scenarios/build';
import { ArchitectureSpec, type ChangeSpec, type ComponentSpec, type VariantSpec } from './schema';

const COL = 330;
const ROW = 240;
const NODE_W = 240;
const NODE_H = 190;
const ZONE_PAD = 44;

const DATA_KEYS = ['tier', 'instances', 'runtime', 'hitRate', 'limit', 'batching', 'retries', 'retryPolicy', 'timeoutMs', 'breaker', 'fallback', 'routing', 'fanout', 'stallRate', 'stallMs', 'queueS', 'capacity', 'latencyMs', 'costPerHour', 'autoscale', 'warmupS', 'writePolicy', 'workingSetGb', 'skew', 'shards', 'hotKeyShare', 'ttlS', 'healthCheckS', 'partitions', 'threads', 'bulkhead', 'provisioned', 'prefixes'] as const;

export const pairs = (spec: ArchitectureSpec): [string, string][] => spec.connections.map((c) => (Array.isArray(c) ? [c[0], c[1]] : [c.from, c.to]));
/** connections with their link properties */
export const links = (spec: ArchitectureSpec): { from: string; to: string; latencyMs?: number; calls?: number; carries?: 'reads' | 'writes'; replication?: 'sync' | 'async' }[] =>
  spec.connections.map((c) => (Array.isArray(c) ? { from: c[0], to: c[1] } : c));

export function componentData(c: ComponentSpec): SystemNodeData {
  const d = defaultData(c.kind, c.name ?? c.id);
  for (const k of DATA_KEYS) if (c[k] !== undefined) (d as Record<string, unknown>)[k] = c[k];
  if (d.instances !== undefined && d.down === undefined) d.down = 0;
  return d;
}

/** Layered left-to-right layout: column = longest path from a traffic source. */
function layout(spec: ArchitectureSpec): Map<string, { x: number; y: number }> {
  const ids = spec.components.map((c) => c.id);
  const out = new Map<string, string[]>(ids.map((i) => [i, []]));
  const indeg = new Map<string, number>(ids.map((i) => [i, 0]));
  for (const [a, b] of pairs(spec)) {
    if (!out.has(a) || !out.has(b) || a === b) continue;
    out.get(a)!.push(b);
    indeg.set(b, indeg.get(b)! + 1);
  }
  const depth = new Map<string, number>(ids.map((i) => [i, 0]));
  const queue = ids.filter((i) => indeg.get(i) === 0);
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    seen.add(id);
    for (const k of out.get(id)!) {
      depth.set(k, Math.max(depth.get(k)!, depth.get(id)! + 1));
      indeg.set(k, indeg.get(k)! - 1);
      if (indeg.get(k) === 0) queue.push(k);
    }
  }
  const cols = new Map<number, string[]>();
  for (const id of ids) {
    const d = depth.get(id)!;
    if (!cols.has(d)) cols.set(d, []);
    cols.get(d)!.push(id);
  }
  const tallest = Math.max(...[...cols.values()].map((c) => c.length));
  // a long chain wraps like text, five columns to a band, so an imported system stays readable
  // instead of shrinking to fit one endless row
  const MAX_COLS = 5;
  const bandH = tallest * ROW + ROW;
  const pos = new Map<string, { x: number; y: number }>();
  for (const [d, col] of cols) {
    const offset = ((tallest - col.length) * ROW) / 2;
    const band = cols.size > MAX_COLS + 1 ? Math.floor(d / MAX_COLS) : 0;
    const x = (cols.size > MAX_COLS + 1 ? d % MAX_COLS : d) * COL;
    col.forEach((id, i) => pos.set(id, { x, y: band * bandH + offset + i * ROW }));
  }
  return pos;
}

/** Spec → app graph (auto-laid-out nodes, edges, zone frames around their members). */
export function specToGraph(input: unknown): Graph {
  const spec = ArchitectureSpec.parse(input);
  const pos = layout(spec);
  const nodes: AppNode[] = [];
  for (const z of spec.zones ?? []) {
    const ps = z.members.map((m) => pos.get(m)).filter((p): p is { x: number; y: number } => !!p);
    if (!ps.length) continue;
    const x0 = Math.min(...ps.map((p) => p.x)) - ZONE_PAD;
    const y0 = Math.min(...ps.map((p) => p.y)) - ZONE_PAD - 20;
    const x1 = Math.max(...ps.map((p) => p.x)) + NODE_W + ZONE_PAD;
    const y1 = Math.max(...ps.map((p) => p.y)) + NODE_H + ZONE_PAD;
    nodes.push({ id: z.id, type: 'zone', position: { x: x0, y: y0 }, width: x1 - x0, height: y1 - y0, zIndex: -1, data: { label: z.label ?? z.id } });
  }
  for (const c of spec.components) nodes.push({ id: c.id, type: 'system', position: pos.get(c.id)!, data: componentData(c) });
  (spec.notes ?? []).forEach((n, i) => nodes.push({ id: `note-${i + 1}`, type: 'note', position: { x: n.x, y: n.y }, ...(n.width ? { width: n.width } : {}), data: { text: n.text } }));
  const edges: SystemEdge[] = links(spec).map(({ from: source, to: target, latencyMs, calls, carries, replication }) => {
    const sync = replication === 'sync';
    const has = latencyMs || (calls ?? 1) > 1 || carries || sync;
    return { id: `e-${source}-${target}`, source, target, type: 'flow', ...(has ? { data: { ...(latencyMs ? { latencyMs } : {}), ...((calls ?? 1) > 1 ? { calls } : {}), ...(carries ? { carries } : {}), ...(sync ? { replication: 'sync' } : {}) } } : {}) };
  });
  return { nodes, edges };
}

/** App graph → spec. Zone membership is derived from geometry (node centre inside the frame). */
export function graphToSpec(nodes: AppNode[], edges: SystemEdge[], name?: string): ArchitectureSpec {
  const sys = nodes.filter(isSystem);
  const components: ComponentSpec[] = sys.map((n) => {
    const c: Record<string, unknown> = { id: n.id, kind: n.data.kind };
    if (n.data.name !== n.id) c.name = n.data.name;
    const def = defaultData(n.data.kind, n.data.name) as Record<string, unknown>;
    for (const k of DATA_KEYS) {
      const v = (n.data as Record<string, unknown>)[k];
      if (v !== undefined && v !== def[k] && !(k === 'tier' && v === 'S')) c[k] = v;
    }
    return c as ComponentSpec;
  });
  const zones = nodes
    .filter((n) => n.type === 'zone')
    .map((z) => {
      const w = z.width ?? z.measured?.width ?? 0;
      const h = z.height ?? z.measured?.height ?? 0;
      const members = sys
        .filter((n) => {
          const cx = n.position.x + (n.measured?.width ?? NODE_W) / 2;
          const cy = n.position.y + (n.measured?.height ?? 150) / 2;
          return cx >= z.position.x && cx <= z.position.x + w && cy >= z.position.y && cy <= z.position.y + h;
        })
        .map((n) => n.id);
      return { id: z.id, label: String(z.data.label ?? z.id), members };
    });
  const ids = new Set(sys.map((n) => n.id));
  const notes = nodes.filter((n) => n.type === 'note').map((n) => ({ text: String(n.data.text ?? ''), x: Math.round(n.position.x), y: Math.round(n.position.y), ...(n.width ? { width: Math.round(n.width) } : {}) }));
  return {
    version: 1,
    ...(name ? { name } : {}),
    components,
    connections: edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) =>
        e.data?.latencyMs || Number(e.data?.calls ?? 1) > 1 || e.data?.carries || e.data?.replication === 'sync'
          ? { from: e.source, to: e.target, ...(e.data?.latencyMs ? { latencyMs: Number(e.data.latencyMs) } : {}), ...(Number(e.data?.calls ?? 1) > 1 ? { calls: Number(e.data!.calls) } : {}), ...(e.data?.carries ? { carries: e.data.carries as 'reads' | 'writes' } : {}), ...(e.data?.replication === 'sync' ? { replication: 'sync' as const } : {}) }
          : ([e.source, e.target] as [string, string]),
      ),
    ...(zones.length ? { zones } : {}),
    ...(notes.length ? { notes } : {}),
  };
}

/** Apply a variant (full replacement or edit list) to a base spec. */
export function applyVariant(base: ArchitectureSpec, v: VariantSpec): ArchitectureSpec {
  if (v.spec) return ArchitectureSpec.parse(v.spec);
  const spec: ArchitectureSpec = structuredClone(base);
  for (const ch of v.changes ?? []) applyChange(spec, ch);
  return ArchitectureSpec.parse(spec);
}

function applyChange(spec: ArchitectureSpec, ch: ChangeSpec) {
  const find = (id: string) => {
    const c = spec.components.find((x) => x.id === id);
    if (!c) throw new Error(`change refers to unknown component "${id}"`);
    return c;
  };
  switch (ch.op) {
    case 'set':
      Object.assign(find(ch.id), ch.fields);
      break;
    case 'add':
      if (spec.components.some((x) => x.id === ch.component.id)) throw new Error(`component "${ch.component.id}" already exists`);
      spec.components.push(ch.component);
      if (ch.zone) {
        const z = (spec.zones ?? []).find((x) => x.id === ch.zone);
        if (!z) throw new Error(`change places "${ch.component.id}" in unknown zone "${ch.zone}"`);
        z.members.push(ch.component.id);
      }
      break;
    case 'remove':
      find(ch.id);
      spec.components = spec.components.filter((x) => x.id !== ch.id);
      spec.connections = spec.connections.filter((c) => !(Array.isArray(c) ? c.includes(ch.id) : c.from === ch.id || c.to === ch.id));
      for (const z of spec.zones ?? []) z.members = z.members.filter((m) => m !== ch.id);
      break;
    case 'connect': {
      find(ch.from);
      find(ch.to);
      const { op: _op, from, to, ...props } = ch;
      const has = Object.values(props).some((v) => v !== undefined && v !== 'async');
      // connecting an existing pair sets its link properties
      spec.connections = spec.connections.filter((c) => (Array.isArray(c) ? !(c[0] === from && c[1] === to) : !(c.from === from && c.to === to)));
      spec.connections = [...spec.connections, has ? { from, to, ...Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined && v !== 'async')) } : [from, to]];
      break;
    }
    case 'disconnect':
      spec.connections = spec.connections.filter((c) => (Array.isArray(c) ? !(c[0] === ch.from && c[1] === ch.to) : !(c.from === ch.from && c.to === ch.to)));
      break;
  }
}

/** base64url(JSON) — used in app links (#spec=… / #compare=…) */
export function encodePayload(obj: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodePayload<T = unknown>(s: string): T {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as T;
}

/**
 * Apply variant edits straight to a board, keeping the user's layout: new components are placed
 * next to what they connect to. Used to apply audit fixes with one click.
 */
export function applyChangesToGraph(nodes: AppNode[], edges: SystemEdge[], changes: ChangeSpec[]): { nodes: AppNode[]; edges: SystemEdge[]; added: string[] } {
  let ns = [...nodes];
  let es = [...edges];
  const added: string[] = [];
  const pendingPos = new Map<string, true>();
  const zoned = new Map<string, string>();
  for (const ch of changes) {
    switch (ch.op) {
      case 'set':
        ns = ns.map((n) => (n.id === ch.id && isSystem(n) ? { ...n, data: { ...n.data, ...ch.fields, ...(ch.fields.instances !== undefined ? { down: Math.min(n.data.down ?? 0, ch.fields.instances - 1) } : {}) } } : n));
        break;
      case 'add': {
        if (ch.zone) zoned.set(ch.component.id, ch.zone);
        const data = componentData(ch.component);
        ns = [...ns.map((n) => ({ ...n, selected: false })), { id: ch.component.id, type: 'system', position: { x: 0, y: 0 }, data, selected: true } as AppNode];
        pendingPos.set(ch.component.id, true);
        added.push(ch.component.id);
        break;
      }
      case 'remove':
        ns = ns.filter((n) => n.id !== ch.id);
        es = es.filter((e) => e.source !== ch.id && e.target !== ch.id);
        break;
      case 'connect': {
        const { op: _op, from, to, ...props } = ch;
        const data = Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined && v !== 'async'));
        const has = Object.keys(data).length > 0;
        if (!es.some((e) => e.source === from && e.target === to)) es = [...es, { id: `e-${from}-${to}-${Date.now() % 1e6}-${es.length}`, source: from, target: to, type: 'flow', ...(has ? { data } : {}) }];
        else if (has || props.replication === 'async')
          es = es.map((e) => {
            if (e.source !== from || e.target !== to) return e;
            const next: Record<string, unknown> = { ...e.data, ...data };
            if (props.replication === 'async') delete next.replication;
            return { ...e, data: next };
          });
        break;
      }
      case 'disconnect':
        es = es.filter((e) => !(e.source === ch.from && e.target === ch.to));
        break;
    }
  }
  ns = placeNew(ns, es, [...pendingPos.keys()].filter((id) => !zoned.has(id)));
  // components added into a zone go inside its frame, below what is already there
  for (const [id, zid] of zoned) {
    const z = ns.find((n) => n.id === zid && n.type === 'zone');
    if (!z) continue;
    const inside = ns.filter((n) => n.id !== id && isSystem(n) && n.position.x >= z.position.x && n.position.x < z.position.x + (z.width ?? 0) && n.position.y >= z.position.y && n.position.y < z.position.y + (z.height ?? 0));
    const y = inside.length ? Math.max(...inside.map((n) => n.position.y)) + ROW : z.position.y + 50;
    const x = z.position.x + 30 + (inside.length % 2) * (NODE_W + 30);
    ns = ns.map((n) => (n.id === id ? { ...n, position: { x, y } } : n));
    // the frame grows to hold it
    const bottom = y + NODE_H + 30;
    const right = x + NODE_W + 30;
    ns = ns.map((n) => (n.id === zid ? { ...n, height: Math.max(n.height ?? 0, bottom - n.position.y), width: Math.max(n.width ?? 0, right - n.position.x) } : n));
  }
  return { nodes: ns, edges: es, added };
}

/** position new nodes next to what they connect to, nudged down until the spot is free */
function placeNew(nodes: AppNode[], es: SystemEdge[], ids: string[]): AppNode[] {
  let ns = nodes;
  const pos = (id: string) => ns.find((n) => n.id === id)?.position;
  for (const id of ids) {
    const callers = es.filter((e) => e.target === id && !ids.includes(e.source)).map((e) => pos(e.source)).filter(Boolean) as { x: number; y: number }[];
    const callees = es.filter((e) => e.source === id && !ids.includes(e.target)).map((e) => pos(e.target)).filter(Boolean) as { x: number; y: number }[];
    const anchor = callees.length && callers.length ? { x: (callers[0].x + callees[0].x) / 2, y: callers[0].y } : callers[0] ? { x: callers[0].x + COL, y: callers[0].y } : callees[0] ? { x: callees[0].x - COL, y: callees[0].y } : { x: 0, y: 0 };
    let p = { x: anchor.x, y: anchor.y + (callers.length && callees.length ? ROW : 0) };
    const taken = () => ns.some((n) => n.id !== id && n.type === 'system' && Math.abs(n.position.x - p.x) < NODE_W && Math.abs(n.position.y - p.y) < NODE_H);
    for (let i = 0; i < 12 && taken(); i++) p = { x: p.x, y: p.y + ROW };
    ns = ns.map((n) => (n.id === id ? { ...n, position: p } : n));
  }
  return ns;
}

/**
 * Bring a board in line with an edited spec while keeping its layout: components that already
 * exist keep their position (and zones their frame); new ones are placed next to their neighbours.
 */
export function mergeSpecIntoGraph(input: unknown, current: { nodes: AppNode[]; edges: SystemEdge[] }): { nodes: AppNode[]; edges: SystemEdge[] } {
  const fresh = specToGraph(input);
  const old = new Map(current.nodes.map((n) => [n.id, n]));
  const added: string[] = [];
  let nodes = fresh.nodes.map((n) => {
    const o = old.get(n.id);
    if (!o) {
      if (n.type === 'system') added.push(n.id);
      return n;
    }
    if (n.type === 'zone' && o.type === 'zone') return { ...o, data: { ...o.data, label: n.data.label } } as AppNode;
    // runtime state (alive, instances down, faults) belongs to the board, not the spec
    const keep = isSystem(o) ? { alive: o.data.alive, down: o.data.down, degraded: o.data.degraded, faultRate: o.data.faultRate, faultLatencyMs: o.data.faultLatencyMs, flushes: o.data.flushes } : {};
    return { ...n, position: o.position, ...(isSystem(n) ? { data: { ...n.data, ...keep, down: Math.min(Number(keep.down ?? 0), Math.max(0, (n.data.instances ?? 1) - 1)) } } : {}) } as AppNode;
  });
  nodes = placeNew(nodes, fresh.edges, added);
  const oldEdge = new Map(current.edges.map((e) => [`${e.source}>${e.target}`, e]));
  const edges = fresh.edges.map((e) => {
    const o = oldEdge.get(`${e.source}>${e.target}`);
    return o ? { ...o, data: e.data } : e;
  });
  return { nodes, edges };
}
