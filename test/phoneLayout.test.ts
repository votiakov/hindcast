import { describe, expect, it } from 'vitest';
import { phoneLayout, turnFor, turned, unturned } from '../src/canvas/phoneLayout';
import { TEMPLATES } from '../src/scenarios/templates';
import { isSystem, type AppNode } from '../src/sim/catalog';

/** a closed card, as the turn reckons one */
const W = 236;
const H = 170;
const clash = (a: AppNode, b: AppNode) => Math.abs(a.position.x - b.position.x) < W && Math.abs(a.position.y - b.position.y) < H;

describe('a board turned for a phone', () => {
  it('turns every template so it reads downwards, with no two cards on top of each other', () => {
    for (const t of TEMPLATES) {
      const nodes = t.graph.nodes as AppNode[];
      const out = phoneLayout(nodes);
      const cards = out.filter(isSystem);
      for (let i = 0; i < cards.length; i++)
        for (let j = i + 1; j < cards.length; j++) {
          const [a, b] = [nodes.find((n) => n.id === cards[i].id)!, nodes.find((n) => n.id === cards[j].id)!];
          // two cards that overlapped on the board itself may overlap on the phone too
          if (clash(a, b)) continue;
          expect(clash(cards[i], cards[j]), `${t.id}: ${cards[i].id} and ${cards[j].id}`).toBe(false);
        }
      // a chain left to right on the board runs top to bottom on the phone
      for (const e of t.graph.edges) {
        const [s, d] = [nodes.find((n) => n.id === e.source)!, nodes.find((n) => n.id === e.target)!];
        if (d.position.x > s.position.x + 1) expect(out.find((n) => n.id === d.id)!.position.y).toBeGreaterThan(out.find((n) => n.id === s.id)!.position.y);
      }
    }
  });

  it('leaves the saved layout as it was', () => {
    const nodes = TEMPLATES[0].graph.nodes as AppNode[];
    const before = JSON.stringify(nodes);
    phoneLayout(nodes);
    expect(JSON.stringify(nodes)).toBe(before);
  });

  it('spreads a fan-out across the phone, and a chain only as much as its wobble', () => {
    const card = (id: string, x: number, y: number) => ({ id, type: 'system', position: { x, y }, data: { kind: 'server', name: id, tier: 'S', alive: true } }) as AppNode;
    const chain = turnFor([card('a', 0, 200), card('b', 330, 160), card('c', 660, 200)]);
    expect(chain.across).toBe(0.5);
    const fan = turnFor([card('a', 0, 230), card('b', 330, 0), card('c', 330, 230), card('d', 330, 460)]);
    expect(fan.across * 230).toBeGreaterThanOrEqual(W + 30);
  });

  it('maps a point there and back', () => {
    const t = { across: 1.1, down: 0.6 };
    const back = unturned(turned({ x: 330, y: 120 }, t), t);
    expect(back.x).toBeCloseTo(330);
    expect(back.y).toBeCloseTo(120);
  });

  it('keeps a zone around the cards it held', () => {
    const t = TEMPLATES.find((x) => x.graph.nodes.some((n) => n.type === 'zone'))!;
    expect(t).toBeTruthy();
    const nodes = t.graph.nodes as AppNode[];
    const out = phoneLayout(nodes);
    for (const z of nodes.filter((n) => n.type === 'zone')) {
      const zw = z.width ?? 0;
      const zh = z.height ?? 0;
      const tz = out.find((n) => n.id === z.id)!;
      for (const m of nodes.filter(isSystem)) {
        const [cx, cy] = [m.position.x + 115, m.position.y + 75];
        if (cx < z.position.x || cx > z.position.x + zw || cy < z.position.y || cy > z.position.y + zh) continue;
        const p = out.find((n) => n.id === m.id)!.position;
        expect(p.x).toBeGreaterThanOrEqual(tz.position.x);
        expect(p.y).toBeGreaterThanOrEqual(tz.position.y);
        expect(p.x + W).toBeLessThanOrEqual(tz.position.x + (tz.width ?? 0));
        expect(p.y + H).toBeLessThanOrEqual(tz.position.y + (tz.height ?? 0));
      }
    }
  });
});
