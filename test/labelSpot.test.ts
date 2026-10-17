import { describe, expect, it } from 'vitest';
import { getSmoothStepPath, Position } from '@xyflow/react';
import { pathPoints, placeLabel, type Box } from '../src/canvas/labelSpot';

const card = (x: number, y: number, w = 230, h = 150): Box => ({ x, y, w, h });
const label = { w: 150, h: 20 };
const inside = (p: { x: number; y: number }, b: Box) => p.x - label.w / 2 < b.x + b.w && p.x + label.w / 2 > b.x && p.y - label.h / 2 < b.y + b.h && p.y + label.h / 2 > b.y;

describe('link labels keep clear of the cards', () => {
  it('reads a stepped link as its corners', () => {
    const [d] = getSmoothStepPath({ sourceX: 0, sourceY: 0, sourcePosition: Position.Right, targetX: 300, targetY: 100, targetPosition: Position.Left, borderRadius: 6, offset: 20 });
    const pts = pathPoints(d);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 300, y: 100 });
    // only horizontal and vertical runs, with a bend's corner between them
    expect(pts.some((p) => p.x === 150 && p.y === 0)).toBe(true);
    expect(pts.some((p) => p.x === 150 && p.y === 100)).toBe(true);
  });

  it('stays at the middle when nothing is there', () => {
    const spot = placeLabel([{ x: 0, y: 0 }, { x: 400, y: 0 }], label, [card(-230, -75), card(400, -75)]);
    expect(spot).toEqual({ x: 200, y: 0, over: false });
  });

  it('keeps the middle it is given when that is clear', () => {
    const spot = placeLabel([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 300 }], label, [], { x: 100, y: 150 });
    expect(spot).toEqual({ x: 100, y: 150, over: false });
  });

  it('moves along the link, the shortest way, off a card that sits on its middle', () => {
    // a third card on the middle of a long link: the label goes to the nearer side of it
    const block = card(260, -75, 230, 150);
    const spot = placeLabel([{ x: 0, y: 0 }, { x: 800, y: 0 }], label, [block], { x: 360, y: 0 });
    expect(spot.over).toBe(false);
    expect(inside(spot, block)).toBe(false);
    expect(spot.y).toBe(0);
    expect(spot.x).toBeLessThanOrEqual(260 - label.w / 2 - 4);
    expect(spot.x).toBeGreaterThan(260 - label.w / 2 - 4 - 8);
  });

  it('moves past a card that sits beside the link', () => {
    // the middle of the link is on its vertical run, beside a tall card: the label slides down the run below it
    const cards = [card(-230, -75), card(110, -40, 230, 240)];
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 300 }, { x: 400, y: 300 }];
    const spot = placeLabel(pts, label, cards, { x: 100, y: 150 });
    expect(spot.over).toBe(false);
    for (const c of cards) expect(inside(spot, c)).toBe(false);
    expect(spot.x).toBe(100);
    expect(spot.y).toBeGreaterThanOrEqual(200 + label.h / 2 + 4);
    expect(spot.y).toBeLessThan(200 + label.h / 2 + 4 + 4);
  });

  it('follows a bend onto the next run', () => {
    // the whole vertical run is beside the card: the first free spot is round the corner, on the lower run
    const cards = [card(-230, -75), card(110, -40, 230, 360)];
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 300 }, { x: 600, y: 300 }];
    const spot = placeLabel(pts, label, cards, { x: 100, y: 150 });
    expect(spot.over).toBe(false);
    expect(spot.y).toBe(300);
    expect(spot.x).toBeGreaterThanOrEqual(340 + label.w / 2 + 4);
  });

  it('with no room along the link, goes just above the cards rather than over their titles', () => {
    // two cards 60 apart: a 150-wide label covers both anywhere along the link, but above them is free
    const cards = [card(-230, -75), card(60, -75)];
    const spot = placeLabel([{ x: 0, y: 0 }, { x: 60, y: 0 }], label, cards);
    expect(spot.over).toBe(false);
    expect(spot.x).toBe(30);
    expect(spot.y + label.h / 2 + 4).toBeLessThanOrEqual(-75);
  });

  it('with no room along the link or near it, goes where it covers the least and is lifted over the cards', () => {
    // cards far taller than the label may move: nowhere near the link is clear
    const tall = (x: number): Box => ({ x, y: -400, w: 230, h: 800 });
    const spot = placeLabel([{ x: 0, y: 0 }, { x: 60, y: 0 }], label, [tall(-230), tall(60)]);
    expect(spot).toEqual({ x: 30, y: 0, over: true });
  });

  it('places nothing before the label has a size', () => {
    expect(placeLabel([{ x: 0, y: 0 }, { x: 60, y: 0 }], { w: 0, h: 0 }, [card(0, 0)], { x: 30, y: 0 })).toEqual({ x: 30, y: 0, over: false });
  });
});
