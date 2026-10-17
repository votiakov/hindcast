/** a point and a box in flow coordinates */
export type Pt = { x: number; y: number };
export type Box = { x: number; y: number; w: number; h: number };

/** where a link's label goes: its centre, and whether it had to be lifted over a card to get there */
export interface LabelSpot extends Pt {
  /** no free spot along the link: the label goes where it covers the least card, drawn above the cards on its backing */
  over: boolean;
}

/** room kept between a label and a card */
const GAP = 4;
/** how far apart the spots tried along the link are */
const STEP = 4;
/** how far above or below a link its label may go when there is no room along it */
const LIFT = 120;

/** the corners of an SVG path (M, L and Q's points), as a polyline: enough for a stepped link */
export function pathPoints(d: string): Pt[] {
  const n = (d.match(/-?\d*\.?\d+(?:e-?\d+)?/gi) ?? []).map(Number);
  const pts: Pt[] = [];
  for (let i = 0; i + 1 < n.length; i += 2) {
    const p = { x: n[i], y: n[i + 1] };
    const last = pts[pts.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) pts.push(p);
  }
  return pts;
}

/** how much of b a covers */
const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** the point at distance d along a polyline */
function at(pts: Pt[], d: number): Pt {
  let left = d;
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= len || i === pts.length - 1) {
      const t = len ? Math.min(1, left / len) : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    left -= len;
  }
  return pts[0];
}

/**
 * Where a link's label sits so no card covers it: the middle of the link when that is clear of every
 * card, else the nearest clear spot along the link, either way from the middle; else just above or below
 * the middle, clear of the cards; else the spot along it that covers the least of them, lifted over the cards. `size` is the label's box, `cards` the cards'
 * boxes, all in flow coordinates
 */
export function placeLabel(pts: Pt[], size: { w: number; h: number }, cards: Box[], mid?: Pt): LabelSpot {
  const total = pts.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - pts[i].x, p.y - pts[i].y), 0);
  const centre = mid ?? (pts.length ? at(pts, total / 2) : { x: 0, y: 0 });
  if (pts.length < 2 || !size.w || !size.h) return { ...centre, over: false };
  const covers = (p: Pt) => {
    const box = { x: p.x - size.w / 2 - GAP, y: p.y - size.h / 2 - GAP, w: size.w + 2 * GAP, h: size.h + 2 * GAP };
    return cards.reduce((s, c) => s + overlap(box, c), 0);
  };
  let least = { p: centre, area: covers(centre) };
  if (!least.area) return { ...centre, over: false };
  // the middle as a distance along the link: the closest point of the link to the given centre
  let from = total / 2;
  if (mid) {
    let best = Infinity;
    for (let d = 0; d <= total; d += STEP) {
      const p = at(pts, d);
      const off = Math.hypot(p.x - mid.x, p.y - mid.y);
      if (off < best) [best, from] = [off, d];
    }
  }
  for (let k = 1; k * STEP <= total; k++) {
    for (const d of [from - k * STEP, from + k * STEP]) {
      if (d < 0 || d > total) continue;
      const p = at(pts, d);
      const area = covers(p);
      if (!area) return { ...p, over: false };
      if (area < least.area) least = { p, area };
    }
  }
  // no room along the link (two cards side by side, a gap narrower than the label): just above or
  // below its middle, clear of the cards' titles, before covering any of them
  for (let k = 1; k * STEP <= LIFT; k++) {
    for (const dy of [-k * STEP, k * STEP]) {
      const p = { x: centre.x, y: centre.y + dy };
      if (!covers(p)) return { ...p, over: false };
    }
  }
  return { ...least.p, over: true };
}
