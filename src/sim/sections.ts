import { isSystem, type AppNode, type SectionNode } from './catalog';

/** room around the members, and above them for the label */
const PAD = 22;
const PAD_TOP = 34;
const CARD_W = 236;
const CARD_H = 150;

/** the section's members still on the board */
export const membersOf = (nodes: AppNode[], s: SectionNode): string[] => {
  const ids = new Set(nodes.filter(isSystem).map((n) => n.id));
  return s.data.members.filter((m) => ids.has(m));
};

/**
 * Sections fit their members: each frame is placed and sized around the components it groups, as they
 * are now (moved, opened, removed). A section with none left is hidden, so undoing a delete brings the
 * frame back with its component. Frames sit behind zones and cards.
 */
export function fitSections(nodes: AppNode[]): AppNode[] {
  if (!nodes.some((n) => n.type === 'section')) return nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return nodes.map((n) => {
    if (n.type !== 'section') return n;
    const ms = n.data.members.map((m) => byId.get(m)).filter((m): m is AppNode => !!m && isSystem(m));
    if (!ms.length) return n.hidden ? n : { ...n, hidden: true };
    const x0 = Math.min(...ms.map((m) => m.position.x)) - PAD;
    const y0 = Math.min(...ms.map((m) => m.position.y)) - PAD_TOP;
    const x1 = Math.max(...ms.map((m) => m.position.x + (m.measured?.width ?? CARD_W))) + PAD;
    const y1 = Math.max(...ms.map((m) => m.position.y + (m.measured?.height ?? CARD_H))) + PAD;
    const w = Math.round(x1 - x0);
    const h = Math.round(y1 - y0);
    if (!n.hidden && n.position.x === x0 && n.position.y === y0 && n.width === w && n.height === h && n.zIndex === -2) return n;
    return { ...n, hidden: false, position: { x: x0, y: y0 }, width: w, height: h, zIndex: -2 };
  });
}
