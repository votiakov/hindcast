import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { importBundle } from '../src/backtest/import/manifest';
import { exportPlan, manifestMetrics, runExport, PRESETS } from '../src/backtest/import/promExport';
import { parseTimestamp } from '../src/backtest/import/csv';
import { sliceDataset, type Dataset } from '../src/backtest/dataset';
import { calibrate } from '../src/backtest/calibrate';
import { backtest, type BacktestResult } from '../src/backtest/backtest';
import { accuracyLines, holdoutAccuracy, modelBreakingPoint } from '../src/backtest/accuracy';
import { basePlan } from '../src/backtest/engine';
import { applyStrategy } from '../src/backtest/strategy';
import { backtestMarkdown, headline, prComment } from '../src/backtest/report';
import { backtestHtml } from '../src/backtest/reportHtml';
import { reviveModel, type Model } from '../src/backtest/model';
import { fileAccess } from './files';

/**
 * Backtest commands:
 *   export-prometheus --url http://prom:9090 --start 2026-09-01 --end 2026-09-15 [--step 60] [--preset otel-spanmetrics,cadvisor] [--selector 'namespace="shop"'] --out data/
 *   import        <bottleneck.import.yaml> [--out dataset.json]
 *   calibrate     <dataset.json> [--out model.json] [--p99 500] [--errors 0.01] [--timeout 5000] [--holdout 0.3]
 *   backtest      <model.json> <dataset.json> <strategy.yaml …> [--last 14d] [--draws 30] [--md r.md] [--html r.html] [--comment pr.md] [--json]
 *   headroom      <model.json> [strategy.yaml]
 *   accuracy      <model.json>
 */

type Opt = Record<string, string | true>;
const c = { dim: (s: string) => `\x1b[2m${s}\x1b[0m`, bold: (s: string) => `\x1b[1m${s}\x1b[0m`, red: (s: string) => `\x1b[31m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m`, yellow: (s: string) => `\x1b[33m${s}\x1b[0m` };
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const readAny = (p: string): unknown => (p.endsWith('.json') ? readJson(p) : parseYaml(readFileSync(p, 'utf8')));

function duration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)(s|m|h|d|w)$/.exec(s);
  if (!m) throw new Error(`bad duration "${s}" (e.g. 14d, 6h)`);
  return parseFloat(m[1]) * { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[m[2] as 's']!;
}

export function lastWindow(d: Dataset, span: string): Dataset {
  const buckets = Math.ceil(duration(span) / d.stepS);
  return buckets >= d.n ? d : sliceDataset(d, d.n - buckets, d.n);
}

function printAccuracy(m: Model) {
  if (!m.accuracy.length) {
    console.log(c.yellow('  no accuracy record yet — `bottleneck calibrate --holdout 0.3` measures one'));
    return;
  }
  for (const a of m.accuracy) {
    console.log(`  ${c.bold(a.method === 'reference' ? 'checked against recorded runs' : 'holdout')} ${c.dim(a.label)}`);
    for (const l of accuracyLines(a)) console.log(`  ${l.startsWith('PASS') ? c.green(l.slice(0, 4)) + l.slice(4) : l.startsWith('MISS') ? c.red(l.slice(0, 4)) + l.slice(4) : c.dim(l)}`);
  }
}

function printModel(m: Model) {
  console.log(`\n${c.bold(m.name)} ${c.dim(`· fitted on ${m.fittedOn.buckets} buckets of ${m.fittedOn.stepS}s`)}`);
  const status = { good: c.green('good'), fair: c.yellow('fair'), poor: c.red('poor'), unexplained: c.red('UNEXPLAINED'), 'cost-only': c.dim('cost only') };
  for (const s of Object.values(m.services)) {
    const cap = isFinite(s.capacity.perReplicaRps) ? `${s.capacity.perReplicaRps.toFixed(1)} req/s/replica${s.capacity.band ? c.dim(` (${s.capacity.band[0].toFixed(1)}–${s.capacity.band[1].toFixed(1)})`) : ''}` : c.dim('no limit seen');
    const lim = s.capacity.limit === 'cpu' ? 'CPU' : s.capacity.limit === 'concurrency' ? `${s.capacity.servers} at a time` : '';
    console.log(`  ${s.id.padEnd(24)} ${status[s.fit.status].padEnd(20)} ${cap} ${c.dim(lim)} ${s.cost.source === 'bill' ? c.dim(`$${s.cost.perReplicaHour.toFixed(4)}/replica-h`) : ''}`);
    for (const n of s.fit.notes) console.log(`  ${''.padEnd(24)} ${c.dim(n)}`);
  }
  for (const e of Object.values(m.endpoints)) console.log(`  ${c.bold(e.id)} ${c.dim(`${(e.share * 100).toFixed(0)}% of traffic · ${e.fit.notes.join('; ')}`)}`);
  printAccuracy(m);
  console.log('');
}

function printBacktest(r: BacktestResult) {
  const f$ = (x: number) => `${x < 0 ? '−' : '+'}$${Math.abs(x).toFixed(Math.abs(x) < 100 ? 2 : 0)}`;
  console.log(`\n${c.bold(`Backtest — ${r.model}`)} ${c.dim(`· ${((r.window.end - r.window.start) / 3600).toFixed(1)} h of history · ${r.draws} draws`)}`);
  const b = r.baseline.summary;
  console.log(`  ${c.bold('As built'.padEnd(30))} $${b.monthly.p50.toFixed(0)}/month   ${Math.round(b.minutesOutOfSlo.p50)} min out of SLO   ${Math.round(b.failedRequests.p50).toLocaleString()} failed`);
  for (const k of r.ranking) {
    const s = r.strategies.find((x) => x.name === k.name)!;
    const good = k.minutesOutOfSloDelta <= 0.5;
    console.log(`  ${(good ? c.green : c.yellow)(s.name.padEnd(30))} ${f$(s.delta.monthly.p50)}/month ${c.dim(`(${f$(s.delta.monthly.lo)} … ${f$(s.delta.monthly.hi)})`)}   ${Math.round(s.summary.minutesOutOfSlo.p50)} min out of SLO   ${Math.round(s.summary.failedRequests.p50).toLocaleString()} failed`);
    console.log(`  ${''.padEnd(30)} ${c.dim(headline(s, r.baseline))}`);
  }
  console.log('');
}

export async function backtestCommand(cmd: string, pos: string[], opt: Opt): Promise<boolean> {
  const json = !!opt.json;
  switch (cmd) {
    case 'export-prometheus': {
      const url = String(opt.url ?? 'http://localhost:9090');
      const start = parseTimestamp(String(opt.start));
      const end = opt.end ? parseTimestamp(String(opt.end)) : Date.now() / 1000;
      if (start === null || end === null) throw new Error('--start and --end must be timestamps (ISO or epoch)');
      const presets = String(opt.preset ?? 'otel-spanmetrics,cadvisor').split(',');
      const out = String(opt.out ?? 'telemetry');
      mkdirSync(join(out, 'metrics'), { recursive: true });
      const plan = exportPlan(presets, { window: opt.window ? String(opt.window) : undefined, selector: opt.selector ? String(opt.selector) : undefined });
      const res = await runExport(url, plan, { start, end, stepS: Number(opt.step ?? 60) }, (f, body) => writeFileSync(join(out, 'metrics', f), body));
      const manifest = { name: String(opt.name ?? 'my system'), step: `${Number(opt.step ?? 60)}s`, metrics: manifestMetrics(plan, 'metrics'), traces: [], billing: [] };
      writeFileSync(join(out, 'bottleneck.import.yaml'), `# Written by bottleneck export-prometheus. Add traces (OTLP JSON) and a bill (AWS CUR / GCP export), then:\n#   bottleneck import ${join(out, 'bottleneck.import.yaml')}\n` + toYaml(manifest));
      for (const r of res) console.log(`  ${r.series ? c.green('✓') : c.yellow('·')} ${r.file} ${c.dim(`${r.series} series`)}`);
      console.log(`\n${c.bold('Wrote')} ${join(out, 'bottleneck.import.yaml')} ${c.dim(`(${Object.keys(PRESETS).join(', ')} presets available)`)}\n`);
      return true;
    }
    case 'import': {
      const t0 = Date.now();
      const { dataset, log } = importBundle(parseYaml(readFileSync(pos[0], 'utf8')), fileAccess(pos[0]));
      const out = String(opt.out ?? join(dirname(pos[0]), 'dataset.json'));
      writeFileSync(out, JSON.stringify(dataset));
      if (json) return console.log(JSON.stringify({ log, out }, null, 2)), true;
      for (const l of log) console.log(`  ${c.green('✓')} ${l.what} ${c.dim(relative('.', l.file))}${l.points !== undefined ? c.dim(` · ${l.points.toLocaleString()} points`) : ''}`);
      console.log(`\n${c.bold(dataset.name)}: ${Object.keys(dataset.services).length} services, ${Object.keys(dataset.endpoints).length} endpoints, ${dataset.n} buckets of ${dataset.stepS}s (${((dataset.n * dataset.stepS) / 3600).toFixed(1)} h)${dataset.bill ? `, bill $${dataset.bill.total.toFixed(2)}` : ''} ${c.dim(`→ ${out} in ${Date.now() - t0} ms`)}\n`);
      return true;
    }
    case 'calibrate': {
      const d = readJson<Dataset>(pos[0]);
      const o = {
        ...(opt.p99 || opt.errors ? { slo: { p99Ms: Number(opt.p99 ?? d.hints?.slo?.p99Ms ?? 500), errorRate: Number(opt.errors ?? d.hints?.slo?.errorRate ?? 0.01) } } : {}),
        ...(opt.timeout ? { timeoutMs: Number(opt.timeout) } : {}),
      };
      const m = calibrate(d, o);
      if (opt.holdout) m.accuracy.push(holdoutAccuracy(d, { ...o, holdout: Number(opt.holdout) }));
      const out = String(opt.out ?? pos[0].replace(/dataset(\.json)?$/, 'model.json').replace(/^(?!.*model\.json$)(.*)\.json$/, '$1.model.json'));
      writeFileSync(out, JSON.stringify(m, null, 1));
      if (json) return console.log(JSON.stringify(m, null, 2)), true;
      printModel(m);
      console.log(c.dim(`  model written to ${out}\n`));
      return true;
    }
    case 'backtest': {
      const m = reviveModel(readJson<Model>(pos[0]));
      let d = readJson<Dataset>(pos[1]);
      if (opt.last) d = lastWindow(d, String(opt.last));
      const strategies = pos.slice(2).map(readAny);
      const r = backtest(m, d, strategies, { draws: opt.draws ? Number(opt.draws) : undefined });
      if (opt.md) writeFileSync(String(opt.md), backtestMarkdown(r, m));
      if (opt.html) writeFileSync(String(opt.html), backtestHtml(r, m));
      if (opt.comment) writeFileSync(String(opt.comment), prComment(r, { title: opt.title ? String(opt.title) : undefined, runUrl: opt['run-url'] ? String(opt['run-url']) : undefined }));
      if (opt.out) writeFileSync(String(opt.out), JSON.stringify(r));
      if (json) return console.log(JSON.stringify(r, null, 2)), true;
      printBacktest(r);
      for (const f of [opt.md, opt.html, opt.comment, opt.out].filter(Boolean)) console.log(c.dim(`  written ${f}`));
      // exit 2 when a strategy adds time out of SLO (CI gate)
      process.exitCode = opt.gate && r.strategies.some((s) => s.delta.minutesOutOfSlo.p50 > Number(opt.gate === true ? 0.5 : opt.gate)) ? 2 : 0;
      return true;
    }
    case 'headroom': {
      const m = reviveModel(readJson<Model>(pos[0]));
      const base = basePlan(m);
      const plan = pos[1] ? applyStrategy(m, base, readAny(pos[1])).plan : base;
      const bp = modelBreakingPoint(m, plan);
      if (json) return console.log(JSON.stringify(bp, null, 2)), true;
      console.log(`\nSustains ${c.bold(`${bp.rps.toFixed(1)} req/s`)} with today's endpoint mix within SLO (p99 ≤ ${m.slo.p99Ms} ms, errors ≤ ${(m.slo.errorRate * 100).toFixed(1)}%)${bp.limitedBy ? `, then ${c.yellow(bp.limitedBy)} saturates` : ''}.\n`);
      printAccuracy(m);
      console.log('');
      return true;
    }
    case 'accuracy': {
      const m = reviveModel(readJson<Model>(pos[0]));
      if (json) return console.log(JSON.stringify(m.accuracy, null, 2)), true;
      console.log(`\n${c.bold(m.name)}`);
      printAccuracy(m);
      console.log('');
      return true;
    }
  }
  return false;
}

