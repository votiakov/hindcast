import type { Graph } from '../scenarios/build';

/**
 * Local design library: the sandbox autosaves, and named designs can be saved / reopened.
 * Browser storage only — nothing leaves the machine. Every access is guarded: storage can be
 * unavailable (private windows, blocked site data) and the app must still work.
 */

export interface SavedDesign {
  id: string;
  name: string;
  updatedAt: number;
  graph: Graph;
}

const LIB = 'bottleneck.designs.v1';
const CUR = 'bottleneck.sandbox.v1';

const read = <T,>(k: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};
const write = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
    return true;
  } catch {
    return false;
  }
};

/** strip render-only fields so saved graphs are small and stable */
export function cleanGraph(g: Graph): Graph {
  return {
    nodes: g.nodes.map(({ id, type, position, data, width, height, zIndex }) => ({ id, type, position, data, ...(width ? { width } : {}), ...(height ? { height } : {}), ...(zIndex !== undefined ? { zIndex } : {}) }) as Graph['nodes'][number]),
    edges: g.edges.map(({ id, source, target, type, data }) => ({ id, source, target, type, ...(data ? { data } : {}) })),
  };
}

export const listDesigns = (): SavedDesign[] => read<SavedDesign[]>(LIB, []).sort((a, b) => b.updatedAt - a.updatedAt);

export function saveDesign(name: string, graph: Graph, id?: string): SavedDesign {
  const all = listDesigns();
  const d: SavedDesign = { id: id ?? `d${Date.now().toString(36)}`, name, updatedAt: Date.now(), graph: cleanGraph(graph) };
  write(LIB, [d, ...all.filter((x) => x.id !== d.id)]);
  return d;
}

export const deleteDesign = (id: string) => write(LIB, listDesigns().filter((x) => x.id !== id));

export const readAutosave = (): { name: string; designId?: string; graph: Graph } | null => read(CUR, null);
export const writeAutosave = (name: string, graph: Graph, designId?: string) => write(CUR, { name, designId, graph: cleanGraph(graph) });
