import { baseLatencyOf, isSystem, type AppNode, type SystemEdge } from '../sim/catalog';
import type { EdgeStats, NodeStats } from '../sim/engine';

export interface Hop {
  id: string;
  name: string;
  kind: string;
  /** network round trip to reach it, ms */
  networkMs: number;
  /** waiting in its queue, ms */
  queuedMs: number;
  /** its own work, ms */
  serviceMs: number;
  /** a cache that answered it here */
  hit?: boolean;
  /** it failed here: its share of requests that fail, if the walk picked a failure */
  failed?: boolean;
}

/**
 * One request, hop by hop, as the board runs now: from a user, each next component picked in
 * proportion to the traffic on the links (a cache answers its hit share, a failing component fails
 * its share), each hop's own time split into queue wait and service. A sample of what the averages
 * add up to — press again for another.
 */
export function traceRequest(nodes: AppNode[], edges: SystemEdge[], stats: Record<string, NodeStats>, edgeStats: Record<string, EdgeStats>, rand: () => number = Math.random): Hop[] {
  const sys = nodes.filter(isSystem);
  const byId = new Map(sys.map((n) => [n.id, n]));
  const users = sys.filter((n) => n.data.kind === 'client' && !n.data.everyS && (stats[n.id]?.inRps ?? 0) > 0);
  if (!users.length) return [];
  const pickBy = <T,>(xs: T[], w: (x: T) => number): T | undefined => {
    const total = xs.reduce((s, x) => s + Math.max(0, w(x)), 0);
    if (total <= 0) return xs[Math.floor(rand() * xs.length)];
    let r = rand() * total;
    for (const x of xs) if ((r -= Math.max(0, w(x))) <= 0) return x;
    return xs[xs.length - 1];
  };
  let at = pickBy(users, (u) => stats[u.id]?.inRps ?? 0)!;
  const hops: Hop[] = [];
  const seen = new Set<string>([at.id]);
  for (let guard = 0; guard < 32; guard++) {
    const out = edges.filter((e) => e.source === at.id && byId.has(e.target) && !seen.has(e.target));
    if (!out.length) break;
    const e = pickBy(out, (x) => edgeStats[x.id]?.rps ?? 0)!;
    const n = byId.get(e.target)!;
    seen.add(n.id);
    const st = stats[n.id];
    const own = st?.ownMs ?? baseLatencyOf(n.data);
    const service = Math.min(own, baseLatencyOf(n.data));
    const hop: Hop = { id: n.id, name: n.data.name, kind: n.data.kind, networkMs: Number(e.data?.latencyMs ?? 0), queuedMs: Math.max(0, own - service), serviceMs: service };
    hops.push(hop);
    // it fails here with the share it drops; a cache answers its hits; a queue answers the producer
    const failShare = st && st.inRps > 0 ? Math.min(1, st.dropRps / st.inRps) : 0;
    if (rand() < failShare) {
      hop.failed = true;
      break;
    }
    if ((n.data.kind === 'cache' || n.data.kind === 'cdn') && st && st.inRps > 0 && rand() < st.hitRps / st.inRps) {
      hop.hit = true;
      break;
    }
    if (n.data.kind === 'queue' || n.data.kind === 'stream') break;
    at = n;
  }
  return hops;
}
