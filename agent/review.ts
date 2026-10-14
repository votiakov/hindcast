import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Dataset } from '../src/backtest/dataset';
import { reviveModel, type Model } from '../src/backtest/model';
import { backtest } from '../src/backtest/backtest';
import { basePlan } from '../src/backtest/engine';
import { modelBreakingPoint } from '../src/backtest/accuracy';
import { nodeLoss } from '../src/backtest/resilience';
import { suggestChanges } from './suggest';
import { iso, type Workspace, nowDate } from './workspace';

/**
 * The capacity review a platform team does by hand, from the calibrated history: how much headroom
 * there is over the busiest moment, whether a busier day holds, what one node failure costs, which
 * services sit on CPU quota or near their memory limit, and the fixes and savings that pass — each
 * backtested. One Markdown report in the workspace, and the same as data.
 */
export async function reviewCapacity(ws: Workspace, o: { draws?: number } = {}, progress?: (m: string, d: number, t: number) => Promise<void>) {
  const say = (m: string, k: number) => progress?.(m, k, 5) ?? Promise.resolve();
  const m = reviveModel(ws.readJson<Model>('model.json'));
  const d = ws.readJson<Dataset>('dataset.json');
  const draws = o.draws ?? 12;
  const r1 = (x: number) => Math.round(x * 10) / 10;

  await say('headroom', 0);
  const head = modelBreakingPoint(m, basePlan(m));
  const peak = m.traffic?.peak ?? 0;

  await say('busier days', 1);
  const busier = [1.5, 2].map((scale) => {
    const r = backtest(m, d, [], { draws, load: { scale } });
    const b = r.baseline;
    return { scale, minutesOutOfSlo: r1(b.summary.minutesOutOfSlo.p50), failedRequests: Math.round(b.summary.failedRequests.p50), worst: b.worst.why, holds: b.summary.minutesOutOfSlo.p50 <= 0.5 };
  });

  await say('losing a node', 2);
  const nodes = Object.values(m.services).some((s) => s.pods) ? nodeLoss(m, d, { draws: Math.min(draws, 8) }) : null;

  // what the calibration noticed: quota throttling and memory close to the limit
  const throttled = Object.values(m.services)
    .filter((s) => s.capacity.throttle)
    .map((s) => ({ service: s.id, kneeShareOfLimit: Math.round(s.capacity.throttle!.knee * 100) / 100, cpuLimit: s.cpuLimit, perReplicaRps: r1(s.capacity.perReplicaRps) }));
  const memory = Object.values(m.services)
    .filter((s) => s.memory?.limit && s.memory.peak / s.memory.limit >= 0.75)
    .map((s) => ({ service: s.id, peakMiB: Math.round(s.memory!.peak * 1024), limitMiB: Math.round(s.memory!.limit! * 1024), share: Math.round((s.memory!.peak / s.memory!.limit!) * 100) / 100 }));

  await say('fixes and savings', 3);
  const sug = (await suggestChanges(ws, { draws })) as Awaited<ReturnType<typeof suggestChanges>> & { nodeLoss?: { fix?: { change: { changes: unknown[] }; survives: boolean; monthlyDelta: number } | null } };

  // the node pool: how full the requests keep it at the busiest moment, and what a smaller one would hold
  const c = m.cluster;
  let pool: { nodes: number; autoscaled: boolean; node: { cpu: number; memoryGb: number; perHour: number }; peakFill: number; wouldFit: number; monthlyPerNode: number } | null = null;
  if (c) {
    const asBuilt = backtest(m, d, [], { draws: 1 }).baseline.cluster;
    if (asBuilt) {
      const fill = Math.max(asBuilt.peakRequestedCpu / (asBuilt.peakNodes * c.node.cpu), asBuilt.peakRequestedMemoryGb / (asBuilt.peakNodes * c.node.memoryGb));
      // nodes the busiest moment's requests need, with one node of slack for a failure and spreading
      const need = Math.max(1, Math.ceil(Math.max(asBuilt.peakRequestedCpu / c.node.cpu, asBuilt.peakRequestedMemoryGb / c.node.memoryGb) - 1e-9)) + 1;
      pool = { nodes: asBuilt.peakNodes, autoscaled: c.autoscaled, node: { cpu: c.node.cpu, memoryGb: Math.round(c.node.memoryGb * 10) / 10, perHour: c.node.perHour }, peakFill: Math.round(fill * 100) / 100, wouldFit: need, monthlyPerNode: Math.round(c.node.perHour * 730) };
    }
  }

  await say('writing the report', 4);
  const out = {
    system: m.name,
    history: { from: iso(d.start), to: iso(d.start + d.n * d.stepS), peakRps: r1(peak) },
    slo: m.slo,
    headroom: { rps: r1(head.rps), limitedBy: head.limitedBy, overPeak: peak > 0 ? Math.round((head.rps / peak) * 100) / 100 : null },
    busier,
    nodeLoss: nodes ? { survives: nodes.survives, worst: nodes.results[0] ? { node: nodes.results[0].node, minutesOutOfSlo: nodes.results[0].minutesOutOfSlo, failedRequests: nodes.results[0].failedRequests, down: nodes.results[0].lost.filter((l) => l.down).map((l) => l.service) } : null, singlePointsOfFailure: nodes.singlePointsOfFailure.map((x) => x.service), fix: sug.nodeLoss?.fix ?? null } : null,
    throttled,
    memoryNearLimit: memory,
    fixes: sug.fixes.slice(0, 5).map((f) => ({ name: f.name, minutesOutOfSloDelta: f.minutesOutOfSloDelta, monthlyDelta: f.monthlyDelta })),
    savings: sug.savings.slice(0, 8).map((x) => ({ name: x.name, monthlyDelta: x.monthlyDelta, verdict: x.verdict })),
    nodePool: pool,
    combinedSavings: sug.combinedSavings ? { name: sug.combinedSavings.name, monthlyDelta: sug.combinedSavings.monthlyDelta, verdict: sug.combinedSavings.verdict } : null,
  };
  const md = reviewMarkdown(out);
  ws.ensure('reports');
  const file = join(ws.path('reports'), `capacity-review-${nowDate().toISOString().slice(0, 10)}.md`);
  writeFileSync(file, md);
  return { ...out, report: file, markdown: md };
}

type Review = Omit<Awaited<ReturnType<typeof reviewCapacity>>, 'report' | 'markdown'>;

export function reviewMarkdown(r: Review): string {
  const usd = (x: number) => `${x < 0 ? '−' : '+'}$${Math.abs(Math.round(x)).toLocaleString('en-US')}/month`;
  const L: string[] = [`# Capacity review — ${r.system}`, '', `History ${r.history.from} … ${r.history.to}, busiest moment ${r.history.peakRps} req/s. SLO: p99 ≤ ${r.slo.p99Ms} ms, errors ≤ ${(r.slo.errorRate * 100).toFixed(1)}%.`, ''];
  L.push('## Headroom', '');
  L.push(`Within SLO up to **${r.headroom.rps} req/s**${r.headroom.overPeak ? ` — ${r.headroom.overPeak}× the busiest moment` : ''}; ${r.headroom.limitedBy ?? 'nothing'} saturates first.`, '');
  for (const b of r.busier) L.push(`- **${b.scale}× today's traffic:** ${b.holds ? 'holds' : `${b.minutesOutOfSlo} min out of SLO, ${b.failedRequests.toLocaleString('en-US')} failed requests — ${b.worst}`}`);
  L.push('');
  if (r.nodeLoss) {
    L.push('## Losing a node at the busiest moment', '');
    if (r.nodeLoss.survives) L.push('Survives the loss of any one node.');
    else if (r.nodeLoss.worst) L.push(`Losing **${r.nodeLoss.worst.node}** costs ${r.nodeLoss.worst.minutesOutOfSlo} min out of SLO and ${r.nodeLoss.worst.failedRequests.toLocaleString('en-US')} failed requests${r.nodeLoss.worst.down.length ? `: ${r.nodeLoss.worst.down.join(', ')} ${r.nodeLoss.worst.down.length === 1 ? 'has' : 'have'} no replica left` : ''}.`);
    if (r.nodeLoss.singlePointsOfFailure.length) L.push('', `Single points of failure (every replica on one node): ${r.nodeLoss.singlePointsOfFailure.join(', ')}.`);
    if (r.nodeLoss.fix) L.push('', `Fix, backtested: ${(r.nodeLoss.fix.change.changes as { service: string; replicas?: number }[]).map((c) => `${c.service}${c.replicas ? ` → ${c.replicas}` : ''}`).join(', ')}, spread over the nodes — ${r.nodeLoss.fix.survives ? 'survives every node' : 'still fails a node'}, ${usd(r.nodeLoss.fix.monthlyDelta)}.`);
    L.push('');
  }
  if (r.throttled.length || r.memoryNearLimit.length) {
    L.push('## Limits that bind', '');
    for (const t of r.throttled) L.push(`- **${t.service}** is held back by its CPU quota: throttling takes over at ${Math.round(t.kneeShareOfLimit * 100)}% of its ${t.cpuLimit}-core limit (${t.perReplicaRps} req/s per replica)`);
    for (const x of r.memoryNearLimit) L.push(`- **${x.service}** peaked at ${x.peakMiB} MiB of its ${x.limitMiB} MiB memory limit (${Math.round(x.share * 100)}%)`);
    L.push('');
  }
  if (r.fixes.length) {
    L.push('## Fixes that pass', '');
    for (const f of r.fixes) L.push(`- ${f.name}: ${f.minutesOutOfSloDelta} min out of SLO, ${usd(f.monthlyDelta)}`);
    L.push('');
  }
  if (r.nodePool) {
    const p = r.nodePool;
    L.push('## Node pool', '');
    L.push(`${p.nodes} node${p.nodes === 1 ? '' : 's'} of ${p.node.cpu} cores and ${p.node.memoryGb} GiB, ${p.autoscaled ? 'autoscaled' : 'a fixed pool'}. At the busiest moment every pod's requests fill **${Math.round(p.peakFill * 100)}%** of it.`);
    if (!p.autoscaled && p.wouldFit < p.nodes) L.push('', `Request cuts save nothing on a fixed pool. ${p.wouldFit} nodes would hold the busiest moment's requests with one node to spare, about $${((p.nodes - p.wouldFit) * p.monthlyPerNode).toLocaleString('en-US')}/month less — check it with node loss before shrinking.`);
    L.push('');
  }
  if (r.savings.length) {
    L.push('## Savings that pass', '');
    for (const s of r.savings) L.push(`- ${s.name}: ${usd(s.monthlyDelta)}`);
    if (r.combinedSavings) L.push(`- **All of them together:** ${usd(r.combinedSavings.monthlyDelta)}, ${r.combinedSavings.verdict}`);
    L.push('');
  }
  L.push('Every number is a replay of the recorded history through the calibrated model; `verify_change` the one you ship for its full evidence.');
  return L.join('\n') + '\n';
}
