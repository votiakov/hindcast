import type { Kind } from './catalog';

/** Things a lesson, scenario or episode script can do to a board. */
export type SimAction =
  | { type: 'kill'; kind: Kind; pick: 'busiest' | 'random' }
  | { type: 'revive-all' }
  | { type: 'kill-id'; id: string }
  | { type: 'revive-id'; id: string }
  | { type: 'fail-zone'; id: string }
  | { type: 'restore-zone'; id: string }
  /** brownout: node keeps running at `factor` × capacity until restored */
  | { type: 'degrade'; id: string; factor: number }
  | { type: 'restore'; id: string };

import { KINDS, instancesUp, isSystem, type AppNode, type SystemNodeData } from './catalog';

export interface ActionContext {
  /** current per-node request rate, used to pick the "busiest" target */
  inRps?: (id: string) => number;
  /** component ids inside a zone */
  zoneMembers: (zoneId: string) => string[];
}

export interface ActionResult {
  nodes: AppNode[];
  /** human-readable consequences, e.g. for toasts and event logs */
  notes: { tone: 'bad' | 'good' | 'info'; text: string }[];
  target: string | null;
}

const setData = (nodes: AppNode[], id: string, patch: Partial<SystemNodeData>): AppNode[] =>
  nodes.map((n) => (n.id === id && isSystem(n) ? { ...n, data: { ...n.data, ...patch } } : n));

function kill(nodes: AppNode[], id: string): ActionResult {
  const n = nodes.find((x) => x.id === id);
  if (!n || !isSystem(n)) return { nodes, notes: [], target: null };
  if (KINDS[n.data.kind].scalable && instancesUp(n.data) > 1)
    return { nodes: setData(nodes, id, { down: (n.data.down ?? 0) + 1 }), notes: [{ tone: 'bad', text: `💥 ${n.data.name}: 1 instance down` }], target: id };
  return { nodes: setData(nodes, id, { alive: false }), notes: [{ tone: 'bad', text: `💀 ${n.data.name} is DOWN` }], target: id };
}

/** Pure: apply a scripted action to a graph. Used by the app store and the headless runner. */
export function applyAction(nodes: AppNode[], a: SimAction, ctx: ActionContext): ActionResult {
  switch (a.type) {
    case 'revive-all':
      return {
        nodes: nodes.map((n) => (isSystem(n) ? { ...n, data: { ...n.data, alive: true, down: 0, degraded: undefined } } : n.type === 'zone' ? ({ ...n, data: { ...n.data, failed: false } } as AppNode) : n)),
        notes: [{ tone: 'good', text: '✅ Everything restored' }],
        target: 'all',
      };
    case 'kill-id':
      return kill(nodes, a.id);
    case 'revive-id':
      return { nodes: setData(nodes, a.id, { alive: true, down: 0 }), notes: [], target: a.id };
    case 'degrade':
      return { nodes: setData(nodes, a.id, { degraded: a.factor }), notes: [{ tone: 'bad', text: `🐢 ${a.id} degraded to ${Math.round(a.factor * 100)}% capacity` }], target: a.id };
    case 'restore':
      return { nodes: setData(nodes, a.id, { degraded: undefined }), notes: [], target: a.id };
    case 'fail-zone':
    case 'restore-zone': {
      const failed = a.type === 'fail-zone';
      const inside = new Set(ctx.zoneMembers(a.id));
      return {
        nodes: nodes.map((n) => {
          if (n.id === a.id) return { ...n, data: { ...n.data, failed } } as AppNode;
          if (inside.has(n.id) && isSystem(n)) return { ...n, data: { ...n.data, alive: !failed, down: 0 } };
          return n;
        }),
        notes: [{ tone: failed ? 'bad' : 'good', text: failed ? `⚡ zone ${a.id} is down` : `✅ zone ${a.id} restored` }],
        target: a.id,
      };
    }
    case 'kill': {
      const candidates = nodes.filter((n): n is AppNode & { type: 'system' } => isSystem(n) && n.data.kind === a.kind && n.data.alive && instancesUp(n.data) > 0);
      if (!candidates.length) return { nodes, notes: [], target: null };
      const rps = ctx.inRps ?? (() => 0);
      const pick = a.pick === 'busiest' ? candidates.reduce((best, n) => (rps(n.id) > rps(best.id) ? n : best)) : candidates[Math.floor(Math.random() * candidates.length)];
      return kill(nodes, pick.id);
    }
  }
}
