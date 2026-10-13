import type { BacktestResult, Ranged, StrategyResult } from './backtest';
import type { AccuracyRecord, Model } from './model';
import { accuracyLines } from './accuracy';

/** Plain-text renderings of a backtest: Markdown report and the pull-request comment. */

const money = (x: number) => `${x < 0 ? '−' : ''}$${Math.abs(x) >= 100 ? Math.round(Math.abs(x)).toLocaleString('en-US') : Math.abs(x).toFixed(2)}`;
const signed = (x: number) => `${x > 0 ? '+' : x < 0 ? '−' : '±'}$${Math.abs(x) >= 100 ? Math.round(Math.abs(x)).toLocaleString('en-US') : Math.abs(x).toFixed(2)}`;
const range = (r: Ranged, f: (x: number) => string) => (f(r.lo) === f(r.hi) ? f(r.p50) : `${f(r.p50)} (${f(r.lo)} … ${f(r.hi)})`);
const mins = (x: number) => `${Math.round(x)} min`;
const when = (t: number) => {
  const d = new Date(t * 1000);
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} at ${d.toISOString().slice(11, 16)} UTC`;
};

/** one-sentence verdict, e.g. "saves $410/month; on Sep 14 at 12:03 it would have caused 9 minutes of errors" */
export function headline(s: StrategyResult, base: StrategyResult): string {
  const dm = s.delta.monthly.p50;
  const money = Math.abs(dm) < 1 ? 'costs the same' : dm < 0 ? `saves $${Math.round(-dm).toLocaleString('en-US')}/month` : `costs $${Math.round(dm).toLocaleString('en-US')}/month more`;
  const newInc = s.incidents.filter((i) => !base.incidents.some((b) => b.start < i.end && i.start < b.end));
  if (newInc.length) {
    const w = [...newInc].sort((a, b) => b.minutes - a.minutes || b.peakP99Ms - a.peakP99Ms)[0];
    const total = Math.max(w.minutes, s.delta.minutesOutOfSlo.p50);
    const mins = (x: number) => `${Math.max(1, Math.round(x))} minute${Math.max(1, Math.round(x)) === 1 ? '' : 's'}`;
    if (total < w.minutes + 0.5) return `${money}; on ${when(w.start)} it would have caused ${mins(w.minutes)} out of SLO (${w.why})`;
    return `${money}; it would have caused ${mins(total)} out of SLO, the worst on ${when(w.start)} (${w.why})`;
  }
  const ds = s.delta.minutesOutOfSlo.p50;
  if (ds < -0.5) return `${money} and removes ${Math.round(-ds)} minute${Math.round(-ds) === 1 ? '' : 's'} out of SLO from the history`;
  if (ds > 0.5) return `${money} and adds ${Math.round(ds)} minutes out of SLO`;
  return `${money}, with no change in time out of SLO`;
}

function accuracyBlock(acc: AccuracyRecord[]): string[] {
  if (!acc.length) return ['_No accuracy record yet — run `bottleneck accuracy` (holdout) to measure how well the model predicts this system._'];
  const out: string[] = [];
  for (const a of acc) {
    out.push(`**${a.method === 'reference' ? 'Checked against recorded runs' : 'Holdout'}** — ${a.label}`, '');
    out.push('| check | predicted | measured | off by | target | |', '|---|---|---|---|---|---|');
    for (const c of a.checks) {
      if (c.metric === 'errors') continue;
      const u = c.metric === 'cost' ? (x: number) => `$${x.toFixed(x < 10 ? 3 : 0)}` : c.metric === 'breaking-point' ? (x: number) => `${x.toFixed(1)} req/s` : (x: number) => `${Math.round(x)} ms`;
      out.push(`| ${c.metric} | ${u(c.predicted)} | ${u(c.measured)} | ${(c.error * 100).toFixed(1)}% | ≤ ${c.tolerance * 100}% | ${c.pass ? '✅' : '⚠️'} |`);
    }
    out.push('');
  }
  return out;
}

export function backtestMarkdown(r: BacktestResult, model: Model): string {
  const hours = (r.window.end - r.window.start) / 3600;
  const L: string[] = [];
  L.push(`# Backtest — ${r.model}`, '');
  L.push(`Replayed **${hours >= 48 ? `${(hours / 24).toFixed(1)} days` : `${hours.toFixed(1)} hours`}** of real traffic (${new Date(r.window.start * 1000).toISOString().slice(0, 16)} → ${new Date(r.window.end * 1000).toISOString().slice(0, 16)} UTC, ${r.window.stepS}s buckets) through the calibrated model, ${r.draws} draws per strategy. Ranges are 10th–90th percentiles.`, '');
  if (r.load) L.push(`**Load ×${r.load.factor.toFixed(2)}**: the history replayed at ${r.load.factor.toFixed(2)}× its traffic (busiest moment ${Math.round(r.load.peakRps)} req/s), the same daily shape and spikes — as built and every strategy alike.`, '');
  L.push(`SLO: p99 ≤ ${r.slo.p99Ms} ms and errors ≤ ${(r.slo.errorRate * 100).toFixed(1)}%.`, '');
  L.push('## Ranking', '');
  L.push('| # | strategy | $/month vs as built | minutes out of SLO | failed requests | verdict |', '|---|---|---|---|---|---|');
  L.push(`| – | As built | ${money(r.baseline.summary.monthly.p50)}/month | ${range(r.baseline.summary.minutesOutOfSlo, mins)} | ${range(r.baseline.summary.failedRequests, (x) => Math.round(x).toLocaleString('en-US'))} | |`);
  r.ranking.forEach((k, i) => {
    const s = r.strategies.find((x) => x.name === k.name)!;
    L.push(`| ${i + 1} | ${s.name} | ${range(s.delta.monthly, signed)} | ${range(s.summary.minutesOutOfSlo, mins)} | ${range(s.summary.failedRequests, (x) => Math.round(x).toLocaleString('en-US'))} | ${headline(s, r.baseline)} |`);
  });
  L.push('');
  for (const s of [r.baseline, ...r.strategies]) {
    L.push(`## ${s.name}`, '');
    if (s.description) L.push(s.description, '');
    for (const n of s.notes) L.push(`- ${n}`);
    if (s.notes.length) L.push('');
    L.push(`- cost over the window ${range(s.summary.cost, money)} · ${money(s.summary.monthly.p50)}/month`);
    L.push(`- ${range(s.summary.minutesOutOfSlo, mins)} out of SLO, ${range(s.summary.failedRequests, (x) => Math.round(x).toLocaleString('en-US'))} failed requests, ${(s.summary.errorBudgetUsed.p50 * 100).toFixed(0)}% of the error budget`);
    L.push(`- worst moment: ${when(s.worst.t)} — p99 ${Math.round(s.worst.p99Ms)} ms, ${(s.worst.errorRate * 100).toFixed(1)}% errors; ${s.worst.why}`);
    if (s.incidents.length) {
      L.push('', '| from | minutes | peak p99 | peak errors | why |', '|---|---|---|---|---|');
      for (const i of s.incidents.slice(0, 12)) L.push(`| ${when(i.start)} | ${i.minutes.toFixed(1)} | ${Math.round(i.peakP99Ms)} ms | ${(i.peakErrorRate * 100).toFixed(1)}% | ${i.why} |`);
      if (s.incidents.length > 12) L.push(`| … | ${s.incidents.length - 12} more | | | |`);
    }
    L.push('');
  }
  L.push('## Endpoints', '', '| endpoint | SLO | | requests | failed | min out of own SLO | $ per 1M requests |', '|---|---|---|---|---|---|---|');
  for (const id of Object.keys(r.baseline.endpoints)) {
    for (const s of [r.baseline, ...r.strategies]) {
      const e = s.endpoints[id];
      if (!e) continue;
      L.push(`| ${s === r.baseline ? id : ''} | ${s === r.baseline ? `p99 ≤ ${e.slo.p99Ms} ms, err ≤ ${(e.slo.errorRate * 100).toFixed(1)}%` : ''} | ${s.name} | ${Math.round(e.requests).toLocaleString('en-US')} | ${Math.round(e.failedRequests).toLocaleString('en-US')} | ${e.minutesOutOfSlo.toFixed(1)} | $${e.costPerMillion.toFixed(e.costPerMillion < 10 ? 3 : 2)} |`);
    }
  }
  L.push('');
  L.push('## Model', '');
  L.push('| component | capacity / replica | limited by | replicas | $/replica-h | fit | notes |', '|---|---|---|---|---|---|---|');
  for (const s of Object.values(model.services)) {
    const cap = isFinite(s.capacity.perReplicaRps) ? `${s.capacity.perReplicaRps.toFixed(1)} req/s${s.capacity.band ? ` (${s.capacity.band[0].toFixed(1)}–${s.capacity.band[1].toFixed(1)})` : ''}` : '—';
    L.push(`| ${s.id}${s.hostedBy ? ` (in ${s.hostedBy})` : ''} | ${cap} | ${s.capacity.limit === 'none' ? '—' : s.capacity.limit === 'cpu' ? 'CPU' : `concurrency (${s.capacity.servers})`} | ${s.hostedBy ? '—' : s.replicas} | ${s.cost.source === 'none' ? '—' : `$${s.cost.perReplicaHour.toFixed(4)}`} | ${s.fit.status}${s.fit.latencyMape !== undefined ? ` · ${(s.fit.latencyMape * 100).toFixed(0)}%` : ''} | ${s.fit.notes.filter((n) => !n.startsWith('replaying')).join('; ')} |`);
  }
  L.push('');
  L.push('## Accuracy', '', ...accuracyBlock(r.accuracy));
  return L.join('\n') + '\n';
}

/** the comment a CI check posts on a pull request */
export function prComment(r: BacktestResult, opts: { title?: string; runUrl?: string } = {}): string {
  const days = (r.window.end - r.window.start) / 86400;
  const hrs = Math.round(days * 24);
  const span = days >= 1.5 ? `the last ${Math.round(days)} days` : days >= 1 ? 'the last day' : hrs > 1 ? `the last ${hrs} hours` : `the last ${Math.max(1, Math.round(days * 1440))} minutes`;
  const L: string[] = [];
  L.push(`### ${opts.title ?? 'Hindcast backtest'}`, '');
  for (const s of r.strategies) L.push(`**${s.name}** ${headline(s, r.baseline)}.`, '');
  L.push(`<sub>Replayed ${span} of production traffic${r.load ? ` at ×${r.load.factor.toFixed(2)} its load (busiest moment ${Math.round(r.load.peakRps)} req/s)` : ''} through the calibrated model · ${r.draws} draws · ranges are 10th–90th percentiles</sub>`, '');
  L.push('| | $/month | minutes out of SLO | failed requests | worst moment |', '|---|---|---|---|---|');
  const row = (s: StrategyResult, d?: boolean) => `| ${s.name} | ${d ? range(s.delta.monthly, signed) : money(s.summary.monthly.p50)} | ${range(s.summary.minutesOutOfSlo, mins)} | ${range(s.summary.failedRequests, (x) => Math.round(x).toLocaleString('en-US'))} | ${when(s.worst.t)} · ${s.worst.why} |`;
  L.push(row(r.baseline));
  for (const s of r.strategies) L.push(row(s, true));
  L.push('');
  const checks = r.accuracy.flatMap((a) => a.checks).filter((c) => c.metric !== 'errors');
  if (checks.length) L.push(`<details><summary>Model accuracy: ${checks.filter((c) => c.pass).length}/${checks.length} checks within target</summary>`, '', '```', ...r.accuracy.flatMap(accuracyLines), '```', '</details>', '');
  else L.push('<sub>⚠️ No accuracy record for this model yet.</sub>', '');
  if (opts.runUrl) L.push(`<sub>[Full report](${opts.runUrl})</sub>`);
  return L.join('\n') + '\n';
}
