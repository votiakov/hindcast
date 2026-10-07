import { defaultData, type AppNode, type Kind, type SystemEdge, type SystemNodeData } from '../sim/catalog';

export interface Graph {
  nodes: AppNode[];
  edges: SystemEdge[];
}

type NodeSpec = [id: string, kind: Kind, x: number, y: number, extra?: Partial<SystemNodeData>];
type ZoneSpec = [id: string, label: string, x: number, y: number, w: number, h: number];

/** Compact graph literal: nodes, edges as [source, target], optional zones (drawn behind). */
export function graph(nodes: NodeSpec[], edges: [string, string][], zones: ZoneSpec[] = []): Graph {
  return {
    nodes: [
      ...zones.map(([id, label, x, y, w, h]): AppNode => ({ id, type: 'zone', position: { x, y }, width: w, height: h, zIndex: -1, data: { label } })),
      ...nodes.map(([id, kind, x, y, extra]): AppNode => ({ id, type: 'system', position: { x, y }, data: { ...defaultData(kind, id), ...extra } })),
    ],
    edges: edges.map(([source, target]) => ({ id: `e-${source}-${target}`, source, target, type: 'flow' })),
  };
}

/** column x positions for left-to-right layouts */
export const X = [0, 330, 660, 990, 1320, 1650];
