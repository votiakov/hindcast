// The validation report as one HTML page: the Kubernetes runs (verdicts and predicted vs measured
// p99 per run) and the Alibaba production check. Reads reference/k8s/shop/validation/validation.json
// and reference/alibaba/results.json.
//   node reference/k8s/report.mjs [out.html]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const v = JSON.parse(readFileSync(join(ROOT, 'shop/validation/validation.json'), 'utf8'));
const ali = JSON.parse(readFileSync(join(ROOT, '../alibaba/results.json'), 'utf8')).summary;
const out = process.argv[2] ?? join(ROOT, 'shop/validation/report.html');

// keep the page light: rows without their full series, series rounded
const rows = v.rows.map((r) => ({ ...r, series: { measured: r.series.measured.map((x) => [x.rps, x.p99Ms, x.errorRate]), predicted: r.series.predicted.p99Ms, predErr: r.series.predicted.errorRate, replicasPred: r.series.predicted.frontendReplicas, replicasMeas: r.series.frontendReplicas } }));
const data = { slo: v.slo, rows, ali, evaluatedAt: v.evaluatedAt };

const html = `<title>Backtest vs Reality</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Condensed:wght@400;500;600&display=swap">
<style>
/* layout: one reading column; the scorecard and the per-run charts are the page, prose frames them */
:root {
  --bg: #0d1217; --pane: #131b22; --line: #24313c; --dim: #8193a3; --text: #c9d4de; --hi: #e6edf3;
  --amber: #f2a93b; --cyan: #3fc1d9; --pos: #5fc98a; --neg: #ef6b6b; --warn: #e3b341;
  --sans: 'IBM Plex Sans Condensed', 'Arial Narrow', system-ui, sans-serif; --mono: 'IBM Plex Mono', ui-monospace, Menlo, monospace;
  color-scheme: dark;
}
body { background: var(--bg); color: var(--text); font: 16px/1.55 var(--sans); }
.page { max-width: 1040px; margin: 0 auto; padding-inline: 20px; padding-block: 40px 64px; display: grid; gap: 34px; }
header { display: grid; gap: 10px; }
.eyebrow { font: 500 12px var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--amber); }
h1 { font: 600 clamp(30px, 5vw, 46px)/1.08 var(--sans); color: var(--hi); margin: 0; text-wrap: balance; letter-spacing: -.01em; }
h2 { font: 600 22px/1.2 var(--sans); color: var(--hi); margin: 0 0 4px; text-wrap: balance; }
p { margin: 0; max-width: 68ch; }
.lede { font-size: 18px; color: var(--hi); }
.dim { color: var(--dim); }
.mono { font-family: var(--mono); }
section { display: grid; gap: 14px; min-width: 0; }
.score { display: flex; gap: 10px 26px; flex-wrap: wrap; font: 15px var(--mono); }
.score b { font-size: 30px; font-weight: 500; color: var(--hi); display: block; font-family: var(--sans); }
.tw { overflow-x: auto; border: 1px solid var(--line); }
table { border-collapse: collapse; width: 100%; font-size: 14.5px; min-width: 760px; }
th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font: 500 11.5px var(--mono); letter-spacing: .06em; text-transform: uppercase; color: var(--dim); background: var(--pane); }
td.num, .num { font-family: var(--mono); font-variant-numeric: tabular-nums; }
tr:last-child td { border-bottom: 0; }
.v { display: inline-block; font: 500 12px var(--mono); padding: 1px 7px; border: 1px solid; letter-spacing: .04em; }
.v.pass { color: var(--pos); border-color: color-mix(in srgb, var(--pos) 55%, transparent); }
.v.fail { color: var(--neg); border-color: color-mix(in srgb, var(--neg) 55%, transparent); }
.v.inconclusive { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 55%, transparent); }
.ok { color: var(--pos); } .no { color: var(--neg); } .meh { color: var(--warn); }
.runs { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }
.run { background: var(--pane); border: 1px solid var(--line); padding: 12px 12px 8px; display: grid; gap: 6px; min-width: 0; }
.run h3 { margin: 0; font: 600 15.5px var(--sans); color: var(--hi); }
.run .q { font-size: 13.5px; color: var(--dim); }
.run svg { width: 100%; height: auto; display: block; }
.legend { display: flex; gap: 14px; flex-wrap: wrap; font: 12px var(--mono); color: var(--dim); }
.legend i { display: inline-block; width: 14px; height: 2px; vertical-align: middle; margin-right: 6px; }
ul { margin: 0; padding-left: 20px; display: grid; gap: 6px; max-width: 72ch; }
code { font: 13.5px var(--mono); color: var(--hi); }
pre { margin: 0; padding: 12px 14px; background: var(--pane); border: 1px solid var(--line); overflow-x: auto; font: 13px/1.5 var(--mono); color: var(--hi); }
a { color: var(--amber); }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 18px; }
</style>
<div class="page">
<header>
  <div class="eyebrow">Validation · Kubernetes · real traffic · real production telemetry</div>
  <h1>Would the backtest have told you the truth?</h1>
  <p class="lede">A real Kubernetes cluster, real traffic, and five decisions about its frontend. Each decision was first answered from one ordinary day of telemetry, then made for real and measured on every request.</p>
</header>
<section id="score"></section>
<section>
  <h2>The decisions</h2>
  <p class="dim">The model was calibrated on <b>12 July 1995</b>: an ordinary day of NASA's web server log, replayed through the shop at 83× its rate and compressed into 40 minutes. <b>13 July</b> is the launch of Space Shuttle STS-70, a real flash crowd 2.2× the ordinary peak. Before each run, <code>verify_change</code> gave its verdict from the ordinary day alone, replayed at 2.2× for launch day. Reality uses the same gate: more than half a minute out of SLO (p99 ≤ 1 s, errors ≤ 1%) added over the system as built, on the same day.</p>
  <div class="tw"><table id="table"></table></div>
</section>
<section>
  <h2>Predicted and measured p99, run by run</h2>
  <p class="dim">The model replayed over the traffic each run actually received: model error alone, without forecast error. Measured is the p99 of every request k6 made in each 30-second bucket.</p>
  <div class="legend"><span><i style="background:var(--hi)"></i>measured (k6)</span><span><i style="background:var(--cyan)"></i>model</span><span><i style="background:var(--amber)"></i>SLO 1 s</span><span><i style="background:#3a4a58;height:8px"></i>requests/s</span></div>
  <div class="runs" id="runs"></div>
</section>
<section>
  <h2>And on real production telemetry</h2>
  <p>Alibaba's 2021 microservices trace: 12 hours of calls, response times and CPU for every container of ~1,300 services. For the ${ali.services} busiest, the same calibration was fitted on the first ${ali.trainedOn.split(' ')[1]} minutes and asked for each service's CPU over the last ${ali.heldOut.split(' ')[1]}, from its traffic alone.</p>
  <div class="tw"><table id="ali"></table></div>
  <p class="dim">On steady minutes every forecast is within ~7%: production load moves slowly. When it moves, the calibrated model halves the error of both naive forecasts. That is the case a capacity or cost decision is about.</p>
</section>
<section id="learned"></section>
<section>
  <h2>Reproduce it</h2>
  <pre>kind create cluster --config reference/k8s/kind.yaml      # then the stack: reference/k8s/README.md
sh reference/k8s/record-all.sh shop history launch normal-2 launch-2 normal-1 launch-hpa
npx tsx reference/k8s/evaluate.ts shop
sh reference/alibaba/fetch.sh /tmp/alibaba &amp;&amp; npx tsx reference/alibaba/validate.ts /tmp/alibaba</pre>
  <p class="dim mono" id="stamp"></p>
</section>
</div>
<script>
const D = ${JSON.stringify(data)};
const pc = (x) => (x * 100).toFixed(x < 0.01 ? 2 : 1) + '%';
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const verdict = (v) => '<span class="v ' + v + '">' + v + '</span>';
const mark = (ok, v) => (ok ? '<span class="ok">✓</span>' : v === 'inconclusive' ? '<span class="meh">?</span>' : '<span class="no">✗</span>');

// scorecard
const rows = D.rows;
const right = rows.filter((r) => r.agrees.backtest).length;
const inc = rows.filter((r) => r.exAnte.verdict === 'inconclusive').length;
const naive = rows.filter((r) => r.agrees.naive).length;
document.getElementById('score').innerHTML = '<div class="score">' +
  '<span><b>' + right + ' of ' + rows.length + '</b>backtest verdicts matched reality</span>' +
  (inc ? '<span><b>' + inc + '</b>inconclusive: it asked for a load test</span>' : '') +
  '<span><b>' + naive + ' of ' + rows.length + '</b>for the CPU-ratio estimate</span>' +
  '<span><b>' + rows.reduce((a, r) => a + r.measured.requests, 0).toLocaleString('en-US') + '</b>requests measured</span></div>';

// the table
document.getElementById('table').innerHTML = '<tr><th>decision</th><th>reality (k6)</th><th>backtest, before the day</th><th>model, on the day</th><th>CPU ratio</th></tr>' +
  rows.map((r) => '<tr><td>' + esc(r.question) + '<div class="dim mono" style="font-size:12px">' + r.run + '</div></td>' +
    '<td>' + verdict(r.truth) + '<div class="num dim">p99 ' + r.measured.p99Ms + ' ms · ' + pc(r.measured.errorRate) + ' errors · ' + r.measured.minutesOutOfSlo + ' min out</div></td>' +
    '<td>' + mark(r.agrees.backtest, r.exAnte.verdict) + ' ' + verdict(r.exAnte.verdict) + (r.exAnte.confidence ? ' <span class="dim">' + r.exAnte.confidence + ' confidence</span>' : '') + '<div class="num dim">' + (r.exAnte.minutesOutOfSlo ?? '—') + ' min out of SLO predicted</div></td>' +
    '<td class="num">p99 ' + r.exPost.p99Ms + ' ms<div class="dim">' + pc(r.exPost.errorRate) + ' errors · ' + r.exPost.minutesOutOfSlo + ' min out</div></td>' +
    '<td>' + mark(r.agrees.naive, r.naive.verdict) + ' ' + verdict(r.naive.verdict) + '<div class="num dim">' + Math.round(r.naive.predictedPeakUtil * 100) + '% CPU at peak</div></td></tr>').join('');

// per-run charts: requests/s as an area, p99 measured and predicted on a log scale
const W = 460, H = 210, L = 40, R = 8, T = 10, B = 22;
const runs = document.getElementById('runs');
for (const r of rows) {
  const m = r.series.measured;
  const n = Math.min(m.length, r.series.predicted.length);
  const x = (i) => L + (i / Math.max(1, n - 1)) * (W - L - R);
  const lo = Math.log(20), hi = Math.log(6000);
  const y = (v) => T + (H - T - B) * (1 - (Math.log(Math.max(20, Math.min(6000, v))) - lo) / (hi - lo));
  const maxRps = Math.max(1, ...m.map((p) => p[0] ?? 0));
  const ya = (v) => H - B - (v / maxRps) * (H - T - B) * 0.55;
  let area = 'M' + x(0) + ',' + (H - B);
  for (let i = 0; i < n; i++) area += 'L' + x(i).toFixed(1) + ',' + ya(m[i][0] ?? 0).toFixed(1);
  area += 'L' + x(n - 1) + ',' + (H - B) + 'Z';
  const line = (vals) => { let d = ''; let pen = false; for (let i = 0; i < n; i++) { const v = vals(i); if (v == null || !isFinite(v)) { pen = false; continue; } d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1); pen = true; } return d; };
  const ticks = [50, 200, 1000, 5000];
  const svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="p99 over the run, measured and predicted">' +
    '<path d="' + area + '" fill="#3a4a58" opacity=".55"/>' +
    ticks.map((t) => '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(t) + '" y2="' + y(t) + '" stroke="var(--line)"/><text x="' + (L - 6) + '" y="' + (y(t) + 4) + '" text-anchor="end" font-size="11" font-family="IBM Plex Mono, monospace" fill="var(--dim)">' + (t >= 1000 ? t / 1000 + 's' : t) + '</text>').join('') +
    '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(D.slo.p99Ms) + '" y2="' + y(D.slo.p99Ms) + '" stroke="var(--amber)" stroke-dasharray="4 4"/>' +
    '<path d="' + line((i) => m[i][1]) + '" fill="none" stroke="var(--hi)" stroke-width="1.6"/>' +
    '<path d="' + line((i) => r.series.predicted[i]) + '" fill="none" stroke="var(--cyan)" stroke-width="1.8"/>' +
    '<text x="' + L + '" y="' + (H - 6) + '" font-size="11" font-family="IBM Plex Mono, monospace" fill="var(--dim)">0 h</text><text x="' + (W - R) + '" y="' + (H - 6) + '" text-anchor="end" font-size="11" font-family="IBM Plex Mono, monospace" fill="var(--dim)">24 h of the day</text></svg>';
  const el = document.createElement('div');
  el.className = 'run';
  el.innerHTML = '<h3>' + r.run + ' ' + verdict(r.truth) + '</h3><div class="q">' + esc(r.question) + '</div>' + svg +
    '<div class="num dim" style="font-size:12.5px">p99 over the run: measured ' + r.measured.p99Ms + ' ms, model ' + r.exPost.p99Ms + ' ms</div>';
  runs.appendChild(el);
}

// Alibaba
const a = D.ali;
document.getElementById('ali').innerHTML = '<tr><th>minutes</th><th>services</th><th>the model</th><th>CPU per request</th><th>an hour ago</th></tr>' +
  '<tr><td>all held-out minutes</td><td class="num">' + a.services + '</td><td class="num">' + pc(a.medianError.model) + '</td><td class="num">' + pc(a.medianError.perRequestOnly) + '</td><td class="num">' + pc(a.medianError.hourAgo) + '</td></tr>' +
  '<tr><td>traffic moved ≥15% within an hour</td><td class="num">' + a.whenTrafficMoved.services + '</td><td class="num"><b class="ok">' + pc(a.whenTrafficMoved.model) + '</b></td><td class="num">' + pc(a.whenTrafficMoved.perRequestOnly) + '</td><td class="num">' + pc(a.whenTrafficMoved.hourAgo) + '</td></tr>' +
  '<tr><td>traffic above anything in training</td><td class="num">' + a.beyondTraining.services + '</td><td class="num"><b class="ok">' + pc(a.beyondTraining.model) + '</b></td><td class="num">' + pc(a.beyondTraining.perRequestOnly) + '</td><td class="num">—</td></tr>';

document.getElementById('learned').innerHTML = '<h2>What a real cluster taught the product</h2><p>Each of these broke a recording or a prediction, and is fixed for every user\\'s cluster, not just this one.</p><div class="cols"><ul>' +
  '<li><b>Span metrics undercount.</b> Raw URLs in span names made thousands of sparse series; <code>rate()</code> lost 38% of requests at low load. The ingress now counts every request and takes precedence.</li>' +
  '<li><b>…and their latency is noise.</b> The p99 of sparse per-session series read 1.4 s where clients measured 50 ms. Endpoint latency now comes from the traces when span names carry raw URLs, and merged series are combined from their histogram buckets.</li>' +
  '<li><b>Frameworks count twice.</b> Next.js wraps every request in two server spans; the outer one, named only <code>GET</code>, held a third of the traffic.</li></ul><ul>' +
  '<li><b>Traces lose spans.</b> Missing parents made downstream services look like entry points. Orphans now hang under their caller.</li>' +
  '<li><b>Containers aren\\'t services.</b> Metrics are grouped by the workload that owns each pod, kept to the system\\'s namespaces, with CPU requests standing in for missing limits.</li>' +
  '<li><b>Launch day is a question about load.</b> <code>verify_change</code>, the CLI and the app now replay a history at ×N.</li></ul></div>';
document.getElementById('stamp').textContent = 'evaluated ' + D.evaluatedAt.slice(0, 16).replace('T', ' ') + ' UTC · reference/k8s · reference/alibaba';
</script>
`;
writeFileSync(out, html);
console.log(`wrote ${out} (${Math.round(html.length / 1024)} KB)`);
