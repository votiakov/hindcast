import type { XYPosition } from '@xyflow/react';
import { isSystem, type AppNode } from '../sim/catalog';

/** phones: a board reads top to bottom instead of left to right */
export const narrowScreen = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 700px)').matches;

/** how far a board's rows spread across (its y to x) and its columns down (its x to y) on a phone */
export interface Turn {
  across: number;
  down: number;
}

/** the chain turned to read downwards: a column of the board becomes a row on the phone */
export const turned = (p: XYPosition, t: Turn): XYPosition => ({ x: p.y * t.across, y: p.x * t.down });
/** back from the phone's layout to the board's */
export const unturned = (p: XYPosition, t: Turn): XYPosition => ({ x: p.y / t.down, y: p.x / t.across });

/** a card as the turn sees it: a closed card's size, so opening one (wider, taller) does not move the others */
const CARD_W = 236;
const CARD_H = 170;
/** room between two cards side by side, and between two stacked (a link's label sits there) */
const GAP_X = 30;
const GAP_Y = 44;
/** a chain's own wobble (one card a little higher than the next) stays a small step, as on Live */
const ACROSS = 0.5;
/** the closest columns of a chain come down the phone a closed card and a link label apart, no further */
const DOWN = 0.5;
/** the band two cards share down the phone before they are spread, judged at a usual column spacing */
const BAND = 0.72;

/**
 * How much to spread a board when it is turned: as little as the cards allow, so they are drawn as big as
 * the phone can. Two cards in the same column, or nearly, must clear each other across the phone, which a
 * fan-out's rows need more room for than a chain's wobble; two that end up in the same band across it
 * must clear each other down it, with room for the label of the link between them
 */
export function turnFor(nodes: AppNode[]): Turn {
  const cards = nodes.filter((n) => isSystem(n) || n.type === 'note').map((n) => n.position);
  let across = ACROSS;
  for (const a of cards)
    for (const b of cards) {
      const [dx, dy] = [Math.abs(a.x - b.x), Math.abs(a.y - b.y)];
      if (dy > 1 && dx * BAND < CARD_H + GAP_Y) across = Math.max(across, (CARD_W + GAP_X) / dy);
    }
  let down = DOWN;
  for (const a of cards)
    for (const b of cards) {
      const [dx, dy] = [Math.abs(a.x - b.x), Math.abs(a.y - b.y)];
      if (dx > 1 && dy * across < CARD_W + GAP_X) down = Math.max(down, (CARD_H + GAP_Y) / dx);
    }
  return { across: Math.min(2, across), down: Math.min(2, down) };
}

/**
 * The board laid out for a phone, worked out from the saved positions each time it is drawn (nothing is
 * stored: the desktop layout stays as the user left it). Cards and notes turn about their corner; a
 * zone turns its frame and grows to hold the cards that were in it, as they are drawn now. Sections fit
 * their members afterwards, as on any board
 */
export function phoneLayout(nodes: AppNode[], t: Turn = turnFor(nodes)): AppNode[] {
  const placed = nodes.map((n) => (n.type === 'zone' || n.type === 'section' ? n : { ...n, position: turned(n.position, t) }));
  return placed.map((n) => {
    if (n.type !== 'zone') return n;
    const w = n.width ?? n.measured?.width ?? 0;
    const h = n.height ?? n.measured?.height ?? 0;
    const at = turned(n.position, t);
    let [x0, y0, x1, y1] = [at.x, at.y, at.x + h * t.across, at.y + w * t.down];
    nodes.forEach((m, j) => {
      if (!isSystem(m)) return;
      const cx = m.position.x + (m.measured?.width ?? 230) / 2;
      const cy = m.position.y + (m.measured?.height ?? 150) / 2;
      if (cx < n.position.x || cx > n.position.x + w || cy < n.position.y || cy > n.position.y + h) return;
      const p = placed[j].position;
      [x0, y0] = [Math.min(x0, p.x - 20), Math.min(y0, p.y - 20)];
      [x1, y1] = [Math.max(x1, p.x + CARD_W + 20), Math.max(y1, p.y + CARD_H + 20)];
    });
    // an empty zone keeps the least size a zone can be resized to, so its label still fits
    return { ...n, position: { x: x0, y: y0 }, width: Math.round(Math.max(260, x1 - x0)), height: Math.round(Math.max(180, y1 - y0)) };
  });
}
