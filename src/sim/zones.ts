import { isSystem, type AppNode } from './catalog';

/** the components inside a zone's frame (membership is geometry: a component's centre inside it) */
export function nodesInZone(nodes: AppNode[], zoneId: string): string[] {
  const z = nodes.find((n) => n.id === zoneId);
  if (!z) return [];
  const w = z.width ?? z.measured?.width ?? 0;
  const h = z.height ?? z.measured?.height ?? 0;
  return nodes
    .filter((n) => {
      if (!isSystem(n)) return false;
      const cx = n.position.x + (n.measured?.width ?? 230) / 2;
      const cy = n.position.y + (n.measured?.height ?? 150) / 2;
      return cx >= z.position.x && cx <= z.position.x + w && cy >= z.position.y && cy <= z.position.y + h;
    })
    .map((n) => n.id);
}
