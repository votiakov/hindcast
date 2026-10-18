/**
 * Leave one run out: what the backtest says about each recorded change when the model is calibrated on
 * everything else that was recorded. For every scored question (evaluate.ts's cases), the model is
 * calibrated twice and asked before the day, as verify_change is asked in evaluate.ts:
 *
 *   - `history`: on the ordinary day alone, as the published scores are
 *   - `others`: on the ordinary day and every other recorded run, stitched into one history (each run's
 *     own window, settled, back to back) — except the run being predicted and every recording of its
 *     configuration on its day, and of the as-built configuration it is compared with on that day.
 *     What a team with months of telemetry, past busy days among them, would calibrate on
 *
 * Both replay the ordinary day (×the forecast), so only what the model learned differs. Each verdict
 * is scored against the measured truth evaluate.ts recorded in validation.json (the same gate), beside
 * the plain CPU-ratio rule's answer from the same file.
 *
 * In sample: this was built while the calibration was changed, and runs the code of the checkout. It
 * never writes predictions or validation.json; its record goes to <system>/validation/loo-<label>.json
 * (not committed), and the table it prints is what reference/k8s/README.md quotes.
 *
 *   npx tsx reference/k8s/loo.ts [shop|petclinic] [--label before] [--only run,run] [--jobs 4] [--keep]
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { SHOP_CASES, type Case } from './cases';
import type { Dataset } from '../../src/backtest/dataset';

const ROOT = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(ROOT, '..', '..', 'bin', 'hindcast');
/** the first two minutes of every run are left out, as evaluate.ts leaves them out */
const SETTLE_S = 120;
/** empty buckets between two stitched runs: a restart, as between two recordings */
const GAP = 10;
const GATE_MINUTES = 0.5;

const arg = (k: string, d?: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const system = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'shop';
const SYS = join(ROOT, system);
const cfg = parse(readFileSync(join(SYS, 'reference.yaml'), 'utf8')) as { slo: { p99Ms: number; errorRate: number }; runs: Record<string, { day?: string; scale?: string; manifests: string; steps?: unknown }>; evaluation?: { manifests: string; cases: Case[] } };
const CASES: Case[] = system === 'shop' ? SHOP_CASES : cfg.evaluation!.cases;
const base = resolve(SYS, cfg.evaluation?.manifests ?? 'shop.yaml');
type Meta = { start: number; end: number };
const meta = (r: string) => JSON.parse(readFileSync(join(SYS, 'runs', r, 'run.json'), 'utf8')) as Meta;
const recorded = (r: string) => existsSync(join(SYS, 'runs', r, 'run.json'));

/** the hindcast CLI's agent tool, asynchronously (the cases run side by side) */
function agent<T>(tool: string, dir: string, args: Record<string, unknown>): Promise<T> {
  return new Promise((ok, fail) => {
    const p = spawn(BIN, ['agent', tool, JSON.stringify({ workspace: dir, ...args })], { env: { ...process.env, NO_COLOR: '1' } });
    let out = '';
    let err = '';
    p.stdout.on('data', (b) => (out += b));
    p.stderr.on('data', (b) => (err += b));
    p.on('close', (code) => (code === 0 ? ok(JSON.parse(out) as T) : fail(new Error(`${tool}: ${(err || out).trim().slice(-400)}`))));
  });
}

/** a run's telemetry as evaluate.ts scores it: today's import where evaluate.ts keeps one, else the
 *  collection made when it was recorded. The load test sits in the history + load test collection */
function telemetry(r: string): Dataset {
  const at = [join(SYS, 'validation', 'runs', r, 'dataset.json'), join(SYS, 'runs', r, 'workspace', 'dataset.json')].find(existsSync);
  if (at) return JSON.parse(readFileSync(at, 'utf8')) as Dataset;
  const both = join(SYS, 'validation', 'collected', `history+${r}`, 'dataset.json');
  if (existsSync(both)) return JSON.parse(readFileSync(both, 'utf8')) as Dataset;
  throw new Error(`${r}: no dataset`);
}

/** one run's buckets after its settling minutes */
function settled(r: string): { d: Dataset; from: number; to: number } {
  const d = r === 'history' ? (JSON.parse(readFileSync(join(SYS, 'validation', 'collected', 'history', 'dataset.json'), 'utf8')) as Dataset) : telemetry(r);
  const m = meta(r);
  const from = Math.max(0, Math.ceil((m.start + SETTLE_S - d.start) / d.stepS));
  const to = Math.min(d.n, Math.floor((m.end - d.start) / d.stepS) + 1);
  return { d, from, to };
}

/** runs stitched back to back into one history on the first one's clock (the ordinary day's
 *  topology, hints and placement): where each one landed, in buckets */
function stitch(runs: string[]): { d: Dataset; at: Record<string, [number, number]> } {
  const parts = runs.map((r) => ({ r, ...settled(r) }));
  const first = parts[0].d;
  const n = parts.reduce((a, p) => a + (p.to - p.from), 0) + GAP * (parts.length - 1);
  const out: Dataset = { ...first, start: first.start + parts[0].from * first.stepS, n, services: {}, endpoints: {}, cluster: undefined };
  const at: Record<string, [number, number]> = {};
  const fill = (into: Record<string, unknown>, from: Record<string, unknown> | undefined, k0: number, a: number, b: number) => {
    for (const [key, v] of Object.entries(from ?? {})) {
      if (!Array.isArray(v)) continue;
      const xs = (into[key] ??= new Array(n).fill(null)) as (number | null)[];
      for (let i = a; i < b; i++) xs[k0 + i - a] = (v[i] as number | null) ?? null;
    }
  };
  type Loose = Record<string, Record<string, unknown>>;
  const [services, endpoints, cluster] = [out.services as unknown as Loose, out.endpoints as unknown as Loose, {} as Record<string, unknown>];
  let k = 0;
  for (const p of parts) {
    if (p.d.stepS !== first.stepS) throw new Error(`${p.r}: ${p.d.stepS} s buckets, the history has ${first.stepS}`);
    for (const [id, s] of Object.entries(p.d.services as unknown as Loose)) fill((services[id] ??= {}), s, k, p.from, p.to);
    for (const [id, e] of Object.entries(p.d.endpoints as unknown as Loose)) fill((endpoints[id] ??= { service: e.service }), e, k, p.from, p.to);
    if (p.d.cluster) fill(cluster, p.d.cluster as unknown as Record<string, unknown>, k, p.from, p.to);
    at[p.r] = [out.start + k * first.stepS, out.start + (k + p.to - p.from) * first.stepS];
    k += p.to - p.from + GAP;
  }
  if (Object.keys(cluster).length) out.cluster = cluster as Dataset['cluster'];
  return { d: out, at };
}

/** every run that recorded `run`'s configuration on its day: the run and its repeats */
const sameDay = (run: string) => {
  const r = cfg.runs[run];
  return Object.keys(cfg.runs).filter((x) => cfg.runs[x].day === r.day && cfg.runs[x].scale === r.scale && cfg.runs[x].manifests === r.manifests);
};

type CpuCheck = { verdict: string; service: string; predictedPeakUtil: number };
type Said = { verdict: string; confidence: string | null; leans: string | null; minutesOutOfSlo: number | null; reasons: string[]; cpuCheck?: CpuCheck };
type Calibrated = { dir: string; window: Meta };

async function calibrated(name: string, runs: string[], scratch: string): Promise<Calibrated> {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  cpSync(join(SYS, 'runs', 'history', 'workspace', 'sources.json'), join(dir, 'sources.json'));
  const { d, at } = stitch(runs);
  writeFileSync(join(dir, 'dataset.json'), JSON.stringify(d));
  await agent('calibrate_model', dir, { slo: cfg.slo, holdout: runs.length > 1 ? 0 : 0.3 });
  return { dir, window: { start: at.history[0], end: at.history[1] } };
}

/** verify_change before the day, as evaluate.ts asks it */
async function forecast(c: Case, cal: Calibrated): Promise<Said> {
  const head = c.head ? resolve(SYS, c.head) : undefined;
  const baseline = c.baseline ? resolve(SYS, c.baseline) : undefined;
  const from = baseline ?? base;
  const traffic = c.scale !== 1 ? { scale: c.scale } : undefined;
  const v = await agent<{ results: { verdict: string; confidence: { level: string }; leans?: string; reliability: { minutesOutOfSlo: number }; reasons: string[]; cpuCheck?: CpuCheck }[]; asBuilt: { minutesOutOfSlo: number; failedRequests: number; requests: number } }>('verify_change', cal.dir, {
    changes: [head ? { kubernetes: { base: from, head } } : { strategy: { name: 'as built', changes: [] } }],
    ...(baseline ? { baseline: { kubernetes: { base, head: baseline } } } : {}),
    traffic,
    window: cal.window,
    // a fixed number of capacity draws: verify_change fits them to a time budget, which cases run side by side would shrink
    draws: 30,
    report: false,
  });
  if (c.run === c.asBuilt) {
    const a = v.asBuilt;
    const fails = a.minutesOutOfSlo > GATE_MINUTES || a.failedRequests > Math.max(1, a.requests * cfg.slo.errorRate);
    return { verdict: fails ? 'fail' : 'pass', confidence: null, leans: null, minutesOutOfSlo: a.minutesOutOfSlo, reasons: [] };
  }
  const r = v.results[0];
  return { verdict: r.verdict, confidence: r.confidence.level, leans: r.leans ?? null, minutesOutOfSlo: r.reliability.minutesOutOfSlo, reasons: r.reasons, ...(r.cpuCheck ? { cpuCheck: r.cpuCheck } : {}) };
}

async function pool<T>(xs: (() => Promise<T>)[], jobs: number): Promise<T[]> {
  const out: T[] = new Array(xs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, xs.length) }, async () => {
    while (next < xs.length) {
      const k = next++;
      out[k] = await xs[k]();
    }
  }));
  return out;
}

async function main() {
  const label = arg('--label', 'now')!;
  const only = arg('--only')?.split(',');
  const jobs = Number(arg('--jobs', '4'));
  // --keep: leave the calibrated workspaces for a look (their path is printed)
  const keep = process.argv.includes('--keep');
  const truthOf = Object.fromEntries((JSON.parse(readFileSync(join(SYS, 'validation', 'validation.json'), 'utf8')) as { models: { id: string; rows: { run: string; truth: string; naive: { verdict: string; predictedPeakUtil: number } }[] }[] }).models[0].rows.map((r) => [r.run, r]));
  // every recorded run with telemetry the model could have been calibrated on (not the recorder's smoke test)
  const all = Object.keys(cfg.runs).filter((r) => r !== 'smoke' && recorded(r)).filter((r) => { try { telemetry(r); return true; } catch { return false; } }).sort((a, b) => meta(a).start - meta(b).start);
  const cases = CASES.filter((c) => recorded(c.run) && truthOf[c.run] && (!only || only.includes(c.run)));
  const scratch = mkdtempSync(join(tmpdir(), `hindcast-loo-${system}-`));
  try {
    const alone = await calibrated('history', ['history'], scratch);
    const rows = await pool(cases.map((c) => async () => {
      const out = new Set([c.run, c.asBuilt, ...(c.asBuiltAlso ? [c.asBuiltAlso] : [])].flatMap(sameDay));
      const others = ['history', ...all.filter((r) => r !== 'history' && !out.has(r))];
      const cal = await calibrated(c.run, others, scratch);
      const [history, rest] = [await forecast(c, alone), await forecast(c, cal)];
      if (!keep) rmSync(cal.dir, { recursive: true, force: true });
      const t = truthOf[c.run];
      console.warn(`${c.run}: truth ${t.truth}; history ${history.verdict}${history.leans ? ` (leans ${history.leans})` : ''}; others ${rest.verdict}${rest.leans ? ` (leans ${rest.leans})` : ''} — calibrated on ${others.length} runs, left out ${[...out].join(', ')}`);
      return { run: c.run, oos: c.oos ?? 0, truth: t.truth, rule: { verdict: t.naive.verdict, predictedPeakUtil: t.naive.predictedPeakUtil }, leftOut: [...out], calibratedOn: others, history, others: rest };
    }), jobs);
    const file = join(SYS, 'validation', `loo-${label}.json`);
    writeFileSync(file, JSON.stringify({ system, label, madeAt: new Date().toISOString(), rows }, null, 1));
    const tally = (pick: (r: (typeof rows)[number]) => Said, rs: typeof rows) => {
      const said = rs.map((r) => ({ v: pick(r), t: r.truth }));
      const hedged = said.filter((x) => x.v.verdict === 'inconclusive');
      return `${said.filter((x) => x.v.verdict === x.t).length} right, ${said.filter((x) => x.v.verdict !== x.t && x.v.verdict !== 'inconclusive').length} wrong, ${hedged.length} inconclusive (${hedged.filter((x) => (x.v.leans ?? 'pass') === x.t).length} leaning right)`;
    };
    const mark = (v: Said, t: string) => `${v.verdict}${v.verdict === 'inconclusive' && v.leans ? ` → ${v.leans}` : ''}${v.verdict === t ? ' ✅' : v.verdict === 'inconclusive' ? ' ⚠️' : ' ❌'}`;
    console.log(`\n| run | measured | CPU rule | ordinary day alone | every other run |\n|---|---|---|---|---|`);
    for (const r of rows) console.log(`| \`${r.run}\`${r.oos ? '' : ' (in sample)'} | ${r.truth} | ${r.rule.verdict}${r.rule.verdict === r.truth ? ' ✅' : ' ❌'} | ${mark(r.history, r.truth)} | ${mark(r.others, r.truth)} |`);
    for (const [what, rs] of [['every scored run', rows], ['the out-of-sample runs', rows.filter((r) => r.oos)]] as const) {
      console.log(`\n${what} (${rs.length}): ordinary day alone ${tally((r) => r.history, rs)}; every other run ${tally((r) => r.others, rs)}; CPU rule ${rs.filter((r) => r.rule.verdict === r.truth).length} right, ${rs.filter((r) => r.rule.verdict !== r.truth).length} wrong`);
    }
    console.log(`\nwrote ${file}`);
  } finally {
    if (keep) console.warn(`workspaces kept in ${scratch}`);
    else rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
