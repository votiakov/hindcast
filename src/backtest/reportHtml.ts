import type { BacktestResult, Band, StrategyResult } from './backtest';
import type { Model } from './model';
import type { Num } from './dataset';
import { backtestMarkdown, headline } from './report';

/**
 * Self-contained HTML backtest report: the history as measured, the model's "as built" replay and
 * every strategy drawn over it with bands, then the ranking, incidents, model and accuracy.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const COLORS = ['#c2410c', '#1d4ed8', '#15803d', '#7c3aed', '#be185d'];

interface Line {
  label: string;
  color: string;
  values?: Num[];
  band?: Band;
  dash?: boolean;
}

function chart(title: string, t: number[], lines: Line[], opts: { unit: (v: number) => string; log?: boolean; threshold?: { v: number; label: string } }): string {
  const W = 960;
  const H = 200;
  const L = 56;
  const R = 12;
  const T = 14;
  const B = 24;
  const all: number[] = [];
  for (const l of lines) {
    for (const v of l.values ?? []) if (v !== null && isFinite(v)) all.push(v);
    for (const v of l.band?.hi ?? []) if (isFinite(v)) all.push(v);
  }
  if (opts.threshold) all.push(opts.threshold.v);
  const max = Math.max(1e-9, ...all) * 1.08;
  const min = opts.log ? Math.max(1, Math.min(...all.filter((v) => v > 0)) * 0.8) : 0;
  const x = (i: number) => L + ((W - L - R) * i) / Math.max(1, t.length - 1);
  const y = (v: number) => (opts.log ? T + (H - T - B) * (1 - (Math.log(Math.max(min, v)) - Math.log(min)) / (Math.log(max) - Math.log(min))) : T + (H - T - B) * (1 - v / max));
  const path = (vals: Num[]) => {
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null || !isFinite(v)) return void (pen = false);
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const area = (b: Band) => `M${b.hi.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('L')}L${b.lo.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).reverse().join('L')}Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => (opts.log ? Math.exp(Math.log(min) + f * (Math.log(max) - Math.log(min))) : f * max));
  const times = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (t.length - 1)));
  const fmtT = (s: number) => new Date(s * 1000).toISOString().slice(5, 16).replace('T', ' ');
  return `<figure><figcaption>${esc(title)}</figcaption><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">
${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 4}" class="ax" text-anchor="end">${opts.unit(v)}</text>`).join('')}
${times.map((i) => `<text x="${x(i)}" y="${H - 6}" class="ax" text-anchor="middle">${fmtT(t[i])}</text>`).join('')}
${opts.threshold ? `<line x1="${L}" x2="${W - R}" y1="${y(opts.threshold.v)}" y2="${y(opts.threshold.v)}" class="slo"/><text x="${W - R}" y="${y(opts.threshold.v) - 4}" class="ax" text-anchor="end">${esc(opts.threshold.label)}</text>` : ''}
${lines.filter((l) => l.band).map((l) => `<path d="${area(l.band!)}" fill="${l.color}" opacity="0.14"/>`).join('')}
${lines.map((l) => `<path d="${path(l.values ?? l.band!.p50)}" fill="none" stroke="${l.color}" stroke-width="${l.label === 'measured' ? 1.2 : 1.6}"${l.dash ? ' stroke-dasharray="4 3"' : ''}/>`).join('')}
</svg><div class="legend">${lines.map((l) => `<span><i style="background:${l.color}"></i>${esc(l.label)}</span>`).join('')}</div></figure>`;
}

export function backtestHtml(r: BacktestResult, model: Model): string {
  const strategies: (StrategyResult & { color: string })[] = r.strategies.map((s, i) => ({ ...s, color: COLORS[i % COLORS.length] }));
  const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);
  const pct = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;
  const usd = (v: number) => `$${v < 10 ? v.toFixed(2) : Math.round(v).toLocaleString('en-US')}`;
  const measured: Line = { label: 'measured', color: '#111827', values: r.actual.p99Ms };
  const asBuilt = (k: 'p99Ms' | 'errorRate' | 'costPerHour' | 'cumulativeCost' | 'errorBudget'): Line => ({ label: 'as built (model)', color: '#6b7280', band: r.baseline.series[k], dash: true });
  const strat = (k: 'p99Ms' | 'errorRate' | 'costPerHour' | 'cumulativeCost' | 'errorBudget') => strategies.map((s) => ({ label: s.name, color: s.color, band: s.series[k] }));
  const md = backtestMarkdown(r, model);
  const checks = r.accuracy.flatMap((a) => a.checks).filter((c) => c.metric !== 'errors');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Backtest — ${esc(r.model)}</title>
<style>
:root{--ink:#111827;--mute:#6b7280;--rule:#e5e7eb;--bg:#fbfaf7}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 "IBM Plex Sans",ui-sans-serif,system-ui,sans-serif}
main{max-width:1000px;margin:0 auto;padding:32px 16px 64px}h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:32px 0 8px;text-transform:uppercase;letter-spacing:.06em}
.sub{color:var(--mute)}figure{margin:16px 0}figcaption{font-weight:600;margin-bottom:4px}svg{width:100%;height:auto;display:block}
.grid{stroke:var(--rule)}.slo{stroke:#b91c1c;stroke-dasharray:2 3}.ax{fill:var(--mute);font:10px "IBM Plex Mono",ui-monospace,monospace}
.legend{display:flex;gap:16px;flex-wrap:wrap;color:var(--mute);font-size:12px}.legend i{display:inline-block;width:10px;height:2px;margin-right:6px;vertical-align:middle}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid var(--rule);padding:6px 8px;text-align:left;vertical-align:top}th{font-weight:600;color:var(--mute)}
.num{font-family:"IBM Plex Mono",ui-monospace,monospace;white-space:nowrap}.pass{color:#15803d}.miss{color:#b91c1c}
.verdict{font-size:16px;margin:12px 0;border-left:3px solid var(--ink);padding-left:12px}
details{margin-top:24px}pre{white-space:pre-wrap;font-size:12px}
</style></head><body><main>
<h1>Backtest — ${esc(r.model)}</h1>
<div class="sub">${new Date(r.window.start * 1000).toISOString().slice(0, 16).replace('T', ' ')} → ${new Date(r.window.end * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC · ${r.window.stepS}s buckets · ${r.draws} draws · bands = 10th–90th percentile · SLO p99 ≤ ${r.slo.p99Ms} ms, errors ≤ ${pct(r.slo.errorRate)}</div>
${strategies.map((s) => `<p class="verdict"><b style="color:${s.color}">${esc(s.name)}</b> ${esc(headline(s, r.baseline))}.</p>`).join('')}
${chart('p99 latency', r.t, [measured, asBuilt('p99Ms'), ...strat('p99Ms')], { unit: ms, log: true, threshold: { v: r.slo.p99Ms, label: 'SLO' } })}
${chart('Errors', r.t, [{ ...measured, values: r.actual.errorRate }, asBuilt('errorRate'), ...strat('errorRate')], { unit: pct, threshold: { v: r.slo.errorRate, label: 'SLO' } })}
${chart('Cost, $/hour', r.t, [{ ...measured, label: 'measured (bill)', values: r.actual.costPerHour }, asBuilt('costPerHour'), ...strat('costPerHour')], { unit: usd })}
${chart('Cumulative cost, $', r.t, [asBuilt('cumulativeCost'), ...strat('cumulativeCost')], { unit: usd })}
${chart('Error budget used', r.t, [asBuilt('errorBudget'), ...strat('errorBudget')], { unit: pct, threshold: { v: 1, label: 'budget' } })}
<h2>Model accuracy</h2>
${checks.length ? `<table><tr><th>check</th><th>predicted</th><th>measured</th><th>off by</th><th>target</th><th>what</th></tr>${checks.map((c) => `<tr><td>${c.metric}</td><td class="num">${c.metric === 'cost' ? usd(c.predicted) : c.metric === 'breaking-point' ? `${c.predicted.toFixed(1)} req/s` : ms(c.predicted)}</td><td class="num">${c.metric === 'cost' ? usd(c.measured) : c.metric === 'breaking-point' ? `${c.measured.toFixed(1)} req/s` : ms(c.measured)}</td><td class="num ${c.pass ? 'pass' : 'miss'}">${(c.error * 100).toFixed(1)}%</td><td class="num">≤ ${c.tolerance * 100}%</td><td>${esc(c.note)}</td></tr>`).join('')}</table>` : '<p class="sub">No accuracy record for this model yet.</p>'}
<details><summary>Full report (Markdown)</summary><pre>${esc(md)}</pre></details>
</main></body></html>`;
}
