/**
 * Bottleneck CLI — the simulation engine without the UI.
 *
 *   npm run sim -- validate        <arch.yaml>
 *   npm run sim -- simulate        <arch.yaml> [scenario.yaml] [--rps 800] [--duration 60] [--engine fluid|des] [--seed 1] [--json]
 *   npm run sim -- analyze         <arch.yaml> [scenario.yaml] [--runs 20]       (discrete-event Monte Carlo, 95% CIs)
 *   npm run sim -- optimize        <arch.yaml> [scenario.yaml] [--runtimes] [--out optimized.yaml]
 *   npm run sim -- compare         <arch.yaml> <variants.yaml> [scenario.yaml] [--json]
 *   npm run sim -- breaking-point  <arch.yaml> [--p99 300] [--errors 0.01]
 *   npm run sim -- link            <arch.yaml> [variants.yaml]     → open in the app
 *   npm run sim -- import-terraform <terraform-show.json> [--name "My system"] [--out arch.yaml]
 *   npm run sim -- catalog
 *
 * Files may be YAML or JSON. A variants file is either a list of variants or { variants, scenario }.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { simulateDes, type DesResult } from '../src/sim/des/des';
import { analyzeParallel } from '../src/sim/des/nodePool';
import type { Analysis } from '../src/sim/des/analyze';
import { optimize } from '../src/sim/optimize';
import { importTerraform } from '../src/spec/terraform';
import { breakingPoint, catalog, compare, simulate, type SimResult } from '../src/sim/headless';
import { validateSpec } from '../src/spec/validate';
import { applyVariant, encodePayload } from '../src/spec/convert';
import { ArchitectureSpec, VariantSpec } from '../src/spec/schema';

const APP_URL = process.env.BOTTLENECK_APP_URL ?? 'http://localhost:5173';

const load = (path: string): unknown => {
  const text = readFileSync(path, 'utf8');
  return path.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
};

const pct = (n: number) => `${(n * 100).toFixed(n < 0.1 && n > 0 ? 2 : 1)}%`;
const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${n}ms`);
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));
const c = { dim: (s: string) => `\x1b[2m${s}\x1b[0m`, bold: (s: string) => `\x1b[1m${s}\x1b[0m`, red: (s: string) => `\x1b[31m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m`, yellow: (s: string) => `\x1b[33m${s}\x1b[0m` };

function flags(argv: string[]) {
  const pos: string[] = [];
  const opt: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) opt[k] = argv[++i];
      else opt[k] = true;
    } else pos.push(argv[i]);
  }
  return { pos, opt };
}

function printResult(r: SimResult) {
  const s = r.summary;
  const ok = s.sloCompliance >= 0.99;
  console.log(`\n${c.bold(r.architecture)} ${c.dim('·')} ${r.scenario} ${c.dim(`· ${s.durationS}s simulated`)}`);
  console.log(`  SLO (errors ≤ ${pct(r.slo.maxErrorRate)}, p99 ≤ ${ms(r.slo.maxP99Ms)}): ${ok ? c.green(`met ${pct(s.sloCompliance)} of the time`) : c.red(`met only ${pct(s.sloCompliance)} of the time (${s.sloBreachSeconds}s in breach)`)}`);
  console.log(`  errors  mean ${pct(s.meanErrorRate)}  peak ${pct(s.peakErrorRate)}   ${c.dim(`${s.failedRequests.toLocaleString()} of ${s.requests.toLocaleString()} requests failed`)}`);
  console.log(`  p99     mean ${ms(s.meanP99Ms)}  peak ${ms(s.peakP99Ms)}   ${c.dim(`worst moment at t=${s.worstMomentS}s`)}`);
  console.log(`  cost    $${s.meanCostPerHour.toFixed(2)}/h  ${c.dim(`≈ $${Math.round(s.meanCostPerHour * 730).toLocaleString()}/month`)}`);
  if (r.bottlenecks.length) {
    console.log(`\n  ${c.bold('Bottlenecks')}`);
    for (const b of r.bottlenecks) console.log(`  ${c.yellow(pad(b.id, 14))} peak ${pad(pct(b.peakUtil), 7)} dropped ${pad(b.droppedTotal.toLocaleString(), 8)} ${c.dim(b.note ?? '')}`);
  }
  if (r.events.length) {
    console.log(`\n  ${c.bold('Events')}`);
    for (const e of r.events.slice(0, 20)) console.log(`  ${c.dim(pad(`t=${e.t}s`, 9))} ${e.what}`);
  }
  console.log('');
}

function printDes(r: DesResult) {
  printResult(r as unknown as SimResult);
  const s = r.summary;
  console.log(`  ${c.bold('Latency (discrete-event, successful requests)')}  p50 ${ms(s.p50Ms)}  p90 ${ms(s.p90Ms)}  p99 ${ms(s.p99Ms)}  p99.9 ${ms(s.p999Ms)}`);
  console.log(`  ${c.dim(`seed ${r.seed} · ${s.events.toLocaleString()} events in ${s.wallMs} ms`)}\n`);
}

function printAnalysis(a: Analysis) {
  const m = a.metrics;
  const f = (x: { mean: number; ci95: number }, fmt: (n: number) => string) => `${fmt(x.mean)} ${c.dim(`± ${fmt(x.ci95)}`)}`;
  console.log(`\n${c.bold(a.architecture)} ${c.dim('·')} ${a.scenario} ${c.dim(`· ${a.runs} runs · ${a.events.toLocaleString()} events · ${a.wallMs} ms`)}`);
  const ok = a.pSloMet >= 0.95;
  console.log(`  SLO met in ${ok ? c.green(pct(a.pSloMet)) : c.red(pct(a.pSloMet))} of runs ${c.dim(`(time-in-SLO ${pct(m.sloCompliance.mean)} ± ${pct(m.sloCompliance.ci95)})`)}`);
  console.log(`  errors   ${f(m.errorRate, pct)}   ${c.dim(`peak ${pct(m.peakErrorRate.mean)}`)}`);
  console.log(`  latency  p50 ${f(m.p50Ms, ms)}   p99 ${f(m.p99Ms, ms)}   p99.9 ${f(m.p999Ms, ms)}`);
  console.log(`  cost     $${m.costPerHour.mean.toFixed(2)}/h ${c.dim(`≈ $${Math.round(m.costPerHour.mean * 730).toLocaleString()}/month`)}`);
  for (const b of a.bottlenecks) console.log(`  ${c.yellow(pad(b.id, 14))} top bottleneck in ${pct(b.share)} of runs ${c.dim(b.note ?? '')}`);
  console.log('');
}

function variantsFile(path: string): { variants: VariantSpec[]; scenario?: unknown } {
  const raw = load(path) as unknown;
  if (Array.isArray(raw)) return { variants: raw.map((v) => VariantSpec.parse(v)) };
  const o = raw as { variants: unknown[]; scenario?: unknown };
  return { variants: o.variants.map((v) => VariantSpec.parse(v)), scenario: o.scenario };
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = flags(rest);
  const json = !!opt.json;
  const scenarioFrom = (path?: string) => {
    const base = (path ? load(path) : {}) as Record<string, unknown>;
    if (opt.rps) base.rps = Number(opt.rps);
    if (opt.duration) base.duration = Number(opt.duration);
    return base;
  };

  switch (cmd) {
    case 'validate': {
      const v = validateSpec(load(pos[0]));
      if (json) return console.log(JSON.stringify(v, null, 2));
      if (!v.issues.length) console.log(c.green('✓ valid, no issues'));
      for (const i of v.issues) console.log(`${i.level === 'error' ? c.red('error  ') : c.yellow('warning')} ${i.message}`);
      process.exitCode = v.ok ? 0 : 1;
      return;
    }
    case 'simulate': {
      if (opt.engine === 'des') {
        const r = simulateDes(load(pos[0]), scenarioFrom(pos[1]), { seed: opt.seed ? Number(opt.seed) : 1 });
        return json ? console.log(JSON.stringify(r, null, 2)) : printDes(r);
      }
      const r = simulate(load(pos[0]), scenarioFrom(pos[1]));
      return json ? console.log(JSON.stringify(r, null, 2)) : printResult(r);
    }
    case 'analyze': {
      return analyzeParallel(load(pos[0]), scenarioFrom(pos[1]), { runs: opt.runs ? Number(opt.runs) : 20, seed: opt.seed ? Number(opt.seed) : 1 }).then((a) => (json ? console.log(JSON.stringify(a, null, 2)) : printAnalysis(a)));
    }
    case 'optimize': {
      const r = optimize(load(pos[0]), scenarioFrom(pos[1]) as Record<string, unknown>, { allowRuntimes: !!opt.runtimes, slo: { maxP99Ms: opt.p99 ? Number(opt.p99) : undefined, maxErrorRate: opt.errors ? Number(opt.errors) : undefined } });
      if (opt.out) writeFileSync(String(opt.out), toYaml(r.spec));
      if (json) return console.log(JSON.stringify({ ...r, spec: undefined }, null, 2));
      console.log(`\n${r.feasible ? c.green('✓ SLO can be met') : c.red('✗ SLO cannot be met by sizing alone — change the design')}  ${c.dim(`(${r.evaluations} simulations)`)}`);
      console.log(`  before  $${r.before.monthly.toLocaleString()}/month, in SLO ${pct(r.before.sloCompliance)} of the time`);
      console.log(`  after   $${r.after.monthly.toLocaleString()}/month, in SLO ${pct(r.after.sloCompliance)} of the time   ${r.monthlySavings >= 0 ? c.green(`saves $${r.monthlySavings.toLocaleString()}/month`) : c.yellow(`costs $${(-r.monthlySavings).toLocaleString()}/month more`)}`);
      if (r.changes.length) console.log(`\n  ${c.bold('Changes')}\n${r.changes.map((ch) => `  • ${ch.op === 'set' ? `${ch.id}: ${Object.entries(ch.fields).map(([k, v]) => `${k} → ${v}`).join(', ')}` : JSON.stringify(ch)}`).join('\n')}`);
      console.log(`\n  ${c.bold('How it got there')}\n${r.log.map((l) => `  ${c.dim(l)}`).join('\n')}`);
      if (opt.out) console.log(`\n  optimized spec written to ${opt.out}`);
      console.log('');
      return;
    }
    case 'compare': {
      const vf = variantsFile(pos[1]);
      const { ranked } = compare(load(pos[0]), vf.variants, pos[2] ? scenarioFrom(pos[2]) : { ...((vf.scenario as object) ?? {}), ...scenarioFrom() });
      if (json) return console.log(JSON.stringify(ranked, null, 2));
      console.log(`\n${c.bold(pad('#', 3) + pad('variant', 32) + pad('SLO', 8) + pad('errors', 9) + pad('peak p99', 10) + pad('$/month', 10))}top bottleneck`);
      ranked.forEach((r, i) => {
        const slo = r.meetsSlo ? c.green(pad('met', 8)) : c.red(pad(pct(r.sloCompliance), 8));
        console.log(`${pad(String(i + 1), 3)}${pad(r.name, 32)}${slo}${pad(pct(r.meanErrorRate), 9)}${pad(ms(r.peakP99Ms), 10)}${pad(`$${r.monthlyCost.toLocaleString()}`, 10)}${c.dim(r.topBottleneck ?? '—')}`);
      });
      console.log('');
      return;
    }
    case 'breaking-point': {
      const r = breakingPoint(load(pos[0]), { slo: { maxP99Ms: opt.p99 ? Number(opt.p99) : undefined, maxErrorRate: opt.errors ? Number(opt.errors) : undefined } });
      if (json) return console.log(JSON.stringify(r, null, 2));
      console.log(`\nSustains ${c.bold(`${r.maxRps.toLocaleString()} req/s`)} within SLO (errors ≤ ${pct(r.slo.maxErrorRate)}, p99 ≤ ${ms(r.slo.maxP99Ms)}).`);
      if (r.limitedBy) console.log(`Limited by ${c.yellow(r.limitedBy)} — ${c.dim(r.note ?? '')}`);
      console.log('');
      return;
    }
    case 'link': {
      const base = ArchitectureSpec.parse(load(pos[0]));
      if (pos[1]) {
        const vf = variantsFile(pos[1]);
        const v = vf.variants[0];
        return console.log(`${APP_URL}/#compare=${encodePayload({ a: { title: base.name ?? 'baseline', spec: base }, b: { title: v.name, spec: applyVariant(base, v) }, scenario: vf.scenario })}`);
      }
      return console.log(`${APP_URL}/#spec=${encodePayload(base)}`);
    }
    case 'import-terraform': {
      const r = importTerraform(JSON.parse(readFileSync(pos[0], 'utf8')), opt.name ? String(opt.name) : undefined);
      const yaml = toYaml(r.spec);
      if (opt.out) writeFileSync(String(opt.out), yaml);
      if (json) return console.log(JSON.stringify(r, null, 2));
      if (!opt.out) console.log(yaml);
      console.error(c.bold(`\nImported ${r.spec.components.length - 1} components from ${r.mapped.length} resources`) + (opt.out ? ` → ${opt.out}` : ''));
      if (r.assumptions.length) console.error(`${c.yellow('Assumptions — review these:')}\n${r.assumptions.map((a) => `  • ${a}`).join('\n')}`);
      if (r.skipped.length) console.error(c.dim(`Not modelled (no request path): ${r.skipped.join(', ')}`));
      return;
    }
    case 'catalog':
      return console.log(JSON.stringify(catalog(), null, 2));
    default:
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 13).map((l) => l.replace(/^ \*\s?/, '')).join('\n'));
      process.exitCode = cmd ? 1 : 0;
  }
}

main();
