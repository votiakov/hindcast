import { availPct, downtimeText, type AuditResult, type Finding, type Severity } from './audit';

/**
 * The audit as one self-contained HTML file (no scripts, no external assets) — to attach to a
 * design review, a ticket or an email. Light and dark aware; prints cleanly.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pct = (n: number) => `${(n * 100).toFixed(n > 0 && n < 0.01 ? 2 : 1)}%`;
const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`);
const money = (n: number) => `${n < 0 ? '−' : n > 0 ? '+' : ''}$${Math.abs(n).toLocaleString('en-US')}`;
const SEV: Record<Severity, string> = { critical: 'Critical', major: 'Major', minor: 'Minor', ok: 'OK' };

function curveSvg(r: AuditResult): string {
  const c = r.curve;
  if (!c || c.length < 2) return '';
  const W = 720;
  const H = 200;
  const P = { l: 44, r: 12, t: 12, b: 28 };
  const maxX = c[c.length - 1].rps;
  const slo = r.slo.maxP99Ms;
  const yMax = Math.max(slo * 3, Math.min(Math.max(...c.map((p) => p.p99Ms)), slo * 6));
  const x = (v: number) => P.l + (v / maxX) * (W - P.l - P.r);
  const yl = (v: number) => H - P.b - (Math.min(v, yMax) / yMax) * (H - P.t - P.b);
  const ye = (v: number) => H - P.b - Math.min(1, v) * (H - P.t - P.b);
  const lat = c.map((p, i) => `${i ? 'L' : 'M'}${x(p.rps).toFixed(1)},${yl(p.p99Ms).toFixed(1)}`).join(' ');
  const err = `M${x(c[0].rps)},${H - P.b} ${c.map((p) => `L${x(p.rps).toFixed(1)},${ye(p.errorRate).toFixed(1)}`).join(' ')} L${x(maxX)},${H - P.b} Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(maxX * f));
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Load curve: p99 latency and error rate against request rate">
  <line x1="${P.l}" x2="${W - P.r}" y1="${yl(slo)}" y2="${yl(slo)}" class="slo"/>
  <text x="${W - P.r}" y="${yl(slo) - 4}" text-anchor="end" class="t">p99 SLO ${slo} ms</text>
  <path d="${err}" class="err"/>
  <path d="${lat}" class="lat"/>
  <line x1="${x(r.load.rps)}" x2="${x(r.load.rps)}" y1="${P.t}" y2="${H - P.b}" class="now"/>
  <text x="${x(r.load.rps) + 4}" y="${P.t + 10}" class="t">expected ${r.load.rps.toLocaleString('en-US')} req/s</text>
  ${r.headroom.maxRps >= 1 && r.headroom.maxRps < maxX ? `<line x1="${x(r.headroom.maxRps)}" x2="${x(r.headroom.maxRps)}" y1="${P.t}" y2="${H - P.b}" class="lim"/><text x="${x(r.headroom.maxRps) + 4}" y="${P.t + 24}" class="t bad">breaks at ${Math.round(r.headroom.maxRps).toLocaleString('en-US')}</text>` : ''}
  <line x1="${P.l}" x2="${W - P.r}" y1="${H - P.b}" y2="${H - P.b}" class="axis"/>
  ${ticks.map((t) => `<text x="${x(t)}" y="${H - 10}" text-anchor="middle" class="t">${t.toLocaleString('en-US')}</text>`).join('')}
  <text x="${P.l - 6}" y="${yl(yMax) + 4}" text-anchor="end" class="t">${ms(Math.round(yMax))}</text>
  <text x="${P.l - 6}" y="${yl(0)}" text-anchor="end" class="t">0</text>
</svg>
<p class="legend"><span class="k lat"></span> p99 latency incl. failures (as timeouts) <span class="k err"></span> share of requests failing (0–100%) · x: req/s, steady state</p>`;
}

function finding(f: Finding): string {
  const i = f.impact;
  const rec = f.kind === 'headroom' ? '' : f.kind === 'surge' ? (i.selfHealS !== null && i.selfHealS > 24 ? `back within SLO ${i.selfHealS - 24} s after the surge` : 'held through the surge') : i.recoveryS === null ? 'never recovers (metastable)' : i.selfHealS !== null && i.selfHealS > 0 ? `heals by itself in ${i.selfHealS} s` : f.severity === 'ok' ? 'absorbed' : i.recoveryS === 0 ? 'recovers when the fault clears' : `recovers ${i.recoveryS} s after the fault clears`;
  return `<section class="f sev-${f.severity}">
  <h3><span class="sev">${SEV[f.severity]}</span> ${esc(f.title)}</h3>
  <p>${esc(f.explanation)}</p>
  ${f.kind !== 'headroom' ? `<p class="facts">peak p99 incl. failures <b>${ms(i.peakP99Ms)}</b> · out of SLO <b>${i.breachS} s</b> · ${rec}${f.costAtRisk ? ` · <b class="bad">$${f.costAtRisk.toLocaleString('en-US')}</b> at risk` : ''}${f.blastRadius.length ? ` · blast radius: ${f.blastRadius.map((b) => `<code>${esc(b)}</code>`).join(' ')}` : ''}</p>` : ''}
  ${f.fixes.length ? `<table class="fixes"><thead><tr><th>verified fix</th><th>after</th><th>$/month</th></tr></thead><tbody>${f.fixes.map((x) => `<tr><td><b>${esc(x.title)}</b><br><span>${esc(x.why)}</span></td><td class="sev-${x.after.severity}">${SEV[x.after.severity]}${x.after.errorRate ? `, ${pct(x.after.errorRate)}` : ''}</td><td class="num">${money(x.monthlyDelta)}</td></tr>`).join('')}</tbody></table>` : ''}
</section>`;
}

export function auditHtml(r: AuditResult, generatedAt = new Date()): string {
  const bad = r.findings.filter((f) => f.severity === 'critical' || f.severity === 'major');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Failure audit — ${esc(r.architecture)}</title>
<style>
:root { --bg:#f7f7f4; --fg:#1b1b19; --mut:#66665f; --line:#dcdcd5; --bad:#c4232b; --warn:#9a6100; --ok:#1d7a3b; --acc:#1f4fd1; --tint:#fbeaea; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --fg:#e6e6e1; --mut:#9a9a92; --line:#2a2f37; --bad:#ff6b6b; --warn:#e3a33a; --ok:#4cc38a; --acc:#7aa2ff; --tint:#3a1a1c; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
main { max-width: 820px; margin: 0 auto; padding: 40px 20px 64px; }
h1 { font-size: 28px; line-height: 1.2; margin: 0 0 6px; letter-spacing: -0.3px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 1px; color: var(--mut); margin: 36px 0 10px; border-bottom: 1px solid var(--line); padding-bottom: 6px; }
h3 { font-size: 16px; margin: 0 0 4px; }
.sub { color: var(--mut); margin: 0 0 24px; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.kpi { padding: 14px 4px; }
.kpi b { display: block; font: 600 30px/1.1 ui-monospace, Menlo, monospace; letter-spacing: -1px; }
.kpi span { color: var(--mut); font-size: 13px; }
.bad { color: var(--bad); } .warn { color: var(--warn); } .good { color: var(--ok); }
svg { width: 100%; height: auto; display: block; }
svg .lat { fill: none; stroke: var(--warn); stroke-width: 2; }
svg .err { fill: var(--tint); stroke: var(--bad); stroke-width: 1; }
svg .slo { stroke: var(--warn); stroke-dasharray: 4 4; opacity: .6; }
svg .now { stroke: var(--fg); opacity: .6; } svg .lim { stroke: var(--bad); stroke-dasharray: 3 3; }
svg .axis { stroke: var(--line); } svg .t { fill: var(--mut); font: 11px ui-monospace, Menlo, monospace; } svg .t.bad { fill: var(--bad); }
.legend { color: var(--mut); font-size: 12px; } .k { display: inline-block; width: 14px; height: 3px; vertical-align: middle; margin: 0 4px 0 10px; } .k.lat { background: var(--warn); } .k.err { background: var(--bad); }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; font-weight: 600; color: var(--mut); font-size: 12px; text-transform: uppercase; letter-spacing: .6px; border-bottom: 1px solid var(--line); padding: 6px 8px 6px 0; }
td { border-bottom: 1px solid var(--line); padding: 8px 8px 8px 0; vertical-align: top; }
td span { color: var(--mut); font-size: 13px; } .num { text-align: right; font-family: ui-monospace, Menlo, monospace; white-space: nowrap; }
.f { padding: 14px 0 14px 14px; border-left: 3px solid var(--line); margin: 0 0 4px; }
.f.sev-critical { border-left-color: var(--bad); } .f.sev-major { border-left-color: var(--warn); } .f.sev-ok { border-left-color: var(--ok); }
.f p { margin: 4px 0; } .facts { color: var(--mut); font-size: 13px; }
.sev { font: 700 11px ui-monospace, Menlo, monospace; text-transform: uppercase; letter-spacing: .5px; margin-right: 6px; }
.sev-critical .sev, td.sev-critical { color: var(--bad); } .sev-major .sev, td.sev-major { color: var(--warn); } .sev-ok .sev, td.sev-ok { color: var(--ok); } .sev-minor .sev { color: var(--mut); }
.fixes { margin-top: 8px; } code { font: 12px ui-monospace, Menlo, monospace; border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }
footer { margin-top: 40px; color: var(--mut); font-size: 12px; border-top: 1px solid var(--line); padding-top: 12px; }
@media print { body { background: #fff; } .f { break-inside: avoid; } }
</style>
</head>
<body>
<main>
<h1>Failure audit — ${esc(r.architecture)}</h1>
<p class="sub">At ${r.load.rps.toLocaleString('en-US')} req/s (${Math.round(r.load.readRatio * 100)}% reads). SLO: errors ≤ ${pct(r.slo.maxErrorRate)}, p99 ≤ ${ms(r.slo.maxP99Ms)}.</p>
<div class="kpis">
  <div class="kpi"><b class="${r.score >= 80 ? 'good' : r.score >= 50 ? 'warn' : 'bad'}">${r.score}<small style="font-size:14px;letter-spacing:0">/100</small></b><span>resilience — survives ${r.survived} of ${r.total} incidents</span></div>
  <div class="kpi"><b>${availPct(r.availability.estimate)}</b><span>availability from SLAs (published), not measured — ${downtimeText(r.availability.downtimeHoursPerYear)} of downtime a year</span></div>
  <div class="kpi"><b>${r.headroom.ratio.toFixed(1)}×</b><span>headroom — ${r.headroom.maxRps >= 1 ? `${Math.round(r.headroom.maxRps).toLocaleString('en-US')} req/s${r.headroom.limitedBy ? `, then ${esc(r.headroom.limitedBy)}` : ''}` : 'misses the SLO at any load'}</span></div>
  <div class="kpi"><b>$${r.baseline.monthly.toLocaleString('en-US')}</b><span>per month at this load${r.baseline.meetsSlo ? '' : ' — <span class="bad">already outside the SLO</span>'}</span></div>
</div>
<h2>Load curve</h2>
${curveSvg(r)}
${bad.length ? `<h2>What breaks first</h2><table><thead><tr><th>incident</th><th>users see</th><th>best verified fix</th><th>$/month</th></tr></thead><tbody>${bad
    .map((f) => `<tr><td class="sev-${f.severity}"><b>${SEV[f.severity]}</b> ${esc(f.title)}</td><td>${f.kind === 'headroom' ? '—' : `${pct(f.impact.errorRate)} errors, peak p99 incl. failures ${ms(f.impact.peakP99Ms)}`}</td><td>${f.fixes[0] ? `${esc(f.fixes[0].title)} → ${SEV[f.fixes[0].after.severity].toLowerCase()}` : '<span>needs a design decision</span>'}</td><td class="num">${f.fixes[0] ? money(f.fixes[0].monthlyDelta) : ''}</td></tr>`)
    .join('')}</tbody></table>` : ''}
<h2>Every incident</h2>
${r.findings.map(finding).join('\n')}
<footer>Generated by Hindcast on ${generatedAt.toISOString().slice(0, 10)}. Each incident: 10 s warm-up, fault at t = 10 s, cleared at t = 40 s, observed to t = 60 s; fixes were verified by re-running the same incident. Results are directional — calibrate capacity, latency and price per component before making claims about a real system.</footer>
</main>
</body>
</html>`;
}
