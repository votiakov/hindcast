import type { AuditResult, Finding } from '../sim/audit';
import type { Graph } from '../scenarios/build';
import type { SimAction } from '../sim/actions';
import { applyChangesToGraph } from '../spec/convert';
import type { Beat, Episode } from './episodes';

const pct = (n: number) => `${(n * 100).toFixed(n > 0 && n < 0.01 ? 2 : n < 0.1 ? 1 : 0)}%`;
const money = (n: number) => `$${Math.abs(n).toLocaleString('en-US')}`;
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/**
 * A failure-audit incident as a Studio clip. With a verified fix it is a comparison: the design as it
 * is on the left, the fixed design on the right, the same incident hitting both — the numbers in the
 * outro are the audit's own measurements.
 */
export function episodeFromFinding(f: Finding, r: AuditResult, design: Graph, name: string, fixIndex = 0): Episode {
  const sc = f.scenario as { duration: number; rps?: number; traffic?: { at: number; rps: number }[]; events?: { at: number; action: SimAction }[] };
  const fix = f.fixes[fixIndex];
  const events = sc.events ?? [];
  const timeline = sc.traffic ?? [
    { at: 0, rps: sc.rps ?? r.load.rps },
    { at: sc.duration, rps: sc.rps ?? r.load.rps },
  ];
  const boards = fix ? (['A', 'B'] as const) : (['main'] as const);
  const targetVisible = f.kind !== 'surge' && f.kind !== 'zone' && f.kind !== 'headroom';
  const beats: Beat[] = [{ at: 0, caption: `${r.load.rps.toLocaleString('en-US')} req/s — a normal day.` }];
  events.forEach((ev, i) =>
    beats.push({
      at: ev.at,
      caption: i === 0 ? `${f.title}.` : 'Fault cleared. Does it come back?',
      do: boards.map((b) => ({ board: b, action: ev.action })),
      ...(targetVisible && fix ? { focus: { board: 'A' as const, nodes: i === 0 ? [f.target, ...f.blastRadius.slice(0, 2)] : null } } : {}),
    }),
  );
  if (f.kind === 'surge') beats.push({ at: 12, caption: 'Traffic triples.' }, { at: 34, caption: 'The surge ends.' });
  beats.sort((a, b) => a.at - b.at);

  const hook = f.kind === 'surge' ? 'Traffic triples for 20 seconds.\nWhat breaks?' : `What happens when\n${f.title}?`;
  const base: Omit<Episode, 'layout' | 'outro'> = {
    id: `audit-${f.id.replace(/[^a-z0-9]+/gi, '-')}-${Date.now().toString(36)}`,
    series: 'Failure audit',
    hook,
    readRatio: r.load.readRatio,
    timeline,
    beats,
    metrics: ['errors', 'p99', 'cost'],
  };
  if (!fix) {
    return {
      ...base,
      layout: 'single',
      main: design,
      outro: { title: cap(f.title), lines: [f.explanation] },
    };
  }
  const fixed = applyChangesToGraph(design.nodes, design.edges, fix.changes);
  return {
    ...base,
    layout: 'compare',
    a: { title: name, graph: design },
    b: { title: fix.title, graph: { nodes: fixed.nodes.map((n) => ({ ...n, selected: false })), edges: fixed.edges } },
    outro: {
      title: fix.monthlyDelta > 0 ? `${money(fix.monthlyDelta)} a month buys this outage away.` : fix.monthlyDelta < 0 ? `The fix is ${money(fix.monthlyDelta)} a month cheaper.` : 'The fix costs nothing extra a month.',
      lines: [`A — as built: ${pct(f.impact.errorRate)} of requests failed while it lasted.`, `B — ${fix.title}: ${pct(fix.after.errorRate)} failed. ${fix.why}`],
    },
  };
}
