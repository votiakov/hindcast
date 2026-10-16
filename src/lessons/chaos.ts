import type { AppNode } from '../sim/catalog';

/**
 * What a level's chaos changed on the board, to put back when the level ends: per node, each data
 * field the chaos touched, as it was before the level's first touch (undefined: it was not set). A
 * level's faults (a dropped share of calls, a degraded database, a dead instance, a cut link, a hot
 * key) belong to that level; the next one starts from its own declared state, as the headless check
 * plays it (src/lessons/verify.ts), with the player's design kept.
 */
export type ChaosUndo = Record<string, Record<string, unknown>>;

/** add what one chaos action changed (the board before and after it) to the record */
export function recordChaos(undo: ChaosUndo, before: AppNode[], after: AppNode[]): ChaosUndo {
  const was = new Map(before.map((n) => [n.id, n.data as Record<string, unknown>]));
  let out = undo;
  for (const n of after) {
    const prev = was.get(n.id);
    const cur = n.data as Record<string, unknown>;
    if (!prev || prev === cur) continue;
    for (const k of new Set([...Object.keys(prev), ...Object.keys(cur)])) {
      if (prev[k] === cur[k] || (out[n.id] && k in out[n.id])) continue;
      out = { ...out, [n.id]: { ...out[n.id], [k]: prev[k] } };
    }
  }
  return out;
}

/** the board with every field a level's chaos touched put back as it was */
export function undoChaos(nodes: AppNode[], undo: ChaosUndo): AppNode[] {
  if (!Object.keys(undo).length) return nodes;
  return nodes.map((n) => {
    const fields = undo[n.id];
    if (!fields) return n;
    const data: Record<string, unknown> = { ...(n.data as Record<string, unknown>) };
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) delete data[k];
      else data[k] = v;
    }
    return { ...n, data } as AppNode;
  });
}
