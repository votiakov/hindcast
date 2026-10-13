/**
 * Would the backtest have told you the truth? For every recorded Kubernetes run with a change
 * really applied, compare three things with what k6 measured on every request:
 *
 *   - the agent's verdict before the change shipped: verify_change on the calibration day's history
 *     (launch day forecast as the calibration day at the launch day's ratio, 2.2×)
 *   - the model's prediction over the traffic that actually came (model error alone, no forecast error)
 *   - a naive estimate: the frontend's busiest CPU utilisation in the history, scaled by the change
 *
 *   npx tsx reference/k8s/evaluate.ts <system>          writes runs/../validation.json and .md
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { Workspace } from '../../agent/workspace';
import { calibrateModel, strategiesFrom, verifyChange } from '../../agent/verify';
import { collect } from '../../agent/collect';
import { reviveModel, type Model } from '../../src/backtest/model';
import type { Dataset } from '../../src/backtest/dataset';
import { quantile } from '../../src/backtest/dataset';
import { basePlan, runPlan } from '../../src/backtest/engine';
import { applyStrategy } from '../../src/backtest/strategy';
import { observedReplicas, trafficOf } from '../../src/backtest/calibrate';
import { accuracyLines, parseRequestLog, pooledP99, referenceAccuracy, type ReferenceRun, type RequestLog } from '../../src/backtest/accuracy';
import { stringify as toYaml } from 'yaml';
import type { K8sReference } from './record';
import { importBundle } from '../../src/backtest/import/manifest';
import { fileAccess } from '../../cli/files';

const ROOT = dirname(fileURLToPath(import.meta.url));

/** a run's telemetry, collected again with today's code from the live Prometheus and Jaeger (the
 *  agent's path; both keep every run). Without the cluster: the files the recording collected,
 *  imported with today's importer */
const collected = new Map<string, Dataset>();
async function importRun(dir: string, out: string): Promise<Dataset> {
  if (collected.has(dir)) return collected.get(dir)!;
  const meta = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as { start: number; end: number };
  let d: Dataset;
  try {
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    cpSync(join(dir, 'workspace', 'sources.json'), join(out, 'sources.json'));
    const ws = new Workspace(out);
    await collect(ws, { start: meta.start, end: meta.end, stepS: 30, maxTraces: 6000 });
    d = ws.readJson<Dataset>('dataset.json');
  } catch (e) {
    console.warn(`(${dir}: live telemetry unavailable — ${(e as Error).message.slice(0, 120)}; using the recorded files)`);
    const mp = join(dir, 'workspace', 'telemetry', 'bottleneck.import.yaml');
    d = importBundle(parse(readFileSync(mp, 'utf8')), fileAccess(mp)).dataset;
  }
  collected.set(dir, d);
  return d;
}

interface Case {
  run: string;
  /** the as-built run on the same day, for "did the change add minutes out of SLO?" */
  asBuilt: string;
  /** manifests the change leaves (none: the as-built system itself) */
  head?: string;
  /** the forecast an engineer would make before the day: the calibration day ×scale */
  scale: number;
  question: string;
}

// the calibration run (EVAL_HISTORY=smoke checks the script without the 47-minute recording)
const HIST = process.env.EVAL_HISTORY ?? 'history';
const LAUNCH = 2.22; // 13 July's busiest 10 minutes over 12 July's, from the log itself
const CASES: Case[] = [
  { run: 'launch', asBuilt: 'launch', scale: LAUNCH, question: 'As built, on launch day?' },
  { run: 'normal-2', asBuilt: HIST, head: 'variants/frontend-2.yaml', scale: 1, question: '2 frontend replicas instead of 3, on an ordinary day?' },
  { run: 'launch-2', asBuilt: 'launch', head: 'variants/frontend-2.yaml', scale: LAUNCH, question: '2 frontend replicas instead of 3, on launch day?' },
  { run: 'normal-1', asBuilt: HIST, head: 'variants/frontend-1.yaml', scale: 1, question: '1 frontend replica, on an ordinary day?' },
  { run: 'launch-hpa', asBuilt: 'launch', head: 'variants/frontend-hpa.yaml', scale: LAUNCH, question: 'An HPA (1–3 replicas at 60% CPU) instead of 3 fixed, on launch day?' },
];

/** what k6 measured per bucket of the run's grid: requests/s, p99, error rate */
function measuredSeries(log: RequestLog, start: number, n: number, stepS = 30) {
  const b = Array.from({ length: n }, () => ({ ms: [] as number[], failed: 0 }));
  for (let k = 0; k < log.t.length; k++) {
    const i = Math.floor((log.t[k] - start) / stepS);
    if (i < 0 || i >= n) continue;
    b[i].ms.push(log.ms[k]);
    if (log.failed[k]) b[i].failed++;
  }
  return b.map((x) => {
    x.ms.sort((a, c) => a - c);
    return { rps: Math.round((x.ms.length / stepS) * 10) / 10, p99Ms: x.ms.length ? Math.round(quantile(x.ms, 0.99)) : null, errorRate: x.ms.length ? Math.round((x.failed / x.ms.length) * 1e4) / 1e4 : null };
  });
}

/** what k6 measured: p99 and errors over every request, and 30-second buckets out of SLO */
function measured(log: RequestLog, slo: Model['slo'], stepS = 30) {
  const ms = [...log.ms].sort((a, b) => a - b);
  const byBucket = new Map<number, { ms: number[]; failed: number }>();
  for (let k = 0; k < log.t.length; k++) {
    const b = Math.floor(log.t[k] / stepS);
    const x = byBucket.get(b) ?? byBucket.set(b, { ms: [], failed: 0 }).get(b)!;
    x.ms.push(log.ms[k]);
    if (log.failed[k]) x.failed++;
  }
  let out = 0;
  for (const x of byBucket.values()) {
    if (x.ms.length < 30) continue;
    x.ms.sort((a, b) => a - b);
    if (quantile(x.ms, 0.99) > slo.p99Ms || x.failed / x.ms.length > slo.errorRate) out++;
  }
  const failed = log.failed.filter(Boolean).length;
  return { requests: log.t.length, p99: quantile(ms, 0.99), errorRate: failed / log.t.length, minutesOutOfSlo: (out * stepS) / 60 };
}

/** the model with the change, replayed over the traffic the run actually had */
function predicted(m: Model, ws: Workspace, run: Dataset, log: RequestLog, head: string | undefined, base: string) {
  const strat = head ? strategiesFrom(ws, [{ kubernetes: { base, head } }], m).strategies[0] : undefined;
  const plan = strat ? applyStrategy(m, basePlan(m), strat).plan : basePlan(m);
  // a fixed replica count was really applied: replay the counts the run had (pods start seconds
  // apart); an autoscaler is predicted, never copied from the run
  const obs = observedReplicas(run, m);
  for (const [id, s] of Object.entries(plan.services))
    if (!s.autoscale && obs[id]) {
      s.replicas = null;
      s.observedReplicas = obs[id];
    }
  const r = runPlan(plan, trafficOf(run, m));
  let n = 0;
  let f = 0;
  let out = 0;
  for (let i = 0; i < r.t.length; i++) {
    n += r.rps[i];
    f += r.rps[i] * r.errorRate[i];
    if (r.rps[i] > 0 && (r.p99Ms[i] > m.slo.p99Ms || r.errorRate[i] > m.slo.errorRate)) out++;
  }
  const pool = pooledP99(r, log, run.start, run.stepS);
  const peakReplicas = Math.max(...(r.services.frontend?.replicas ?? [0]));
  // per bucket, for the charts: offered load, predicted p99 and errors, frontend replicas
  const series = { t: r.t, rps: r.rps.map((x) => Math.round(x * 10) / 10), p99Ms: r.p99Ms.map((x) => Math.round(x)), errorRate: r.errorRate.map((x) => Math.round(x * 1e4) / 1e4), frontendReplicas: r.services.frontend?.replicas ?? [] };
  return { p99: pool.predicted, errorRate: n > 0 ? f / n : 0, minutesOutOfSlo: (out * run.stepS) / 60, frontendReplicasPeak: peakReplicas, series };
}

/** the spreadsheet answer: the frontend's busiest CPU share in the history, scaled by the change */
function naive(history: Dataset, replicasAfter: number | 'hpa', scale: number) {
  const f = history.services.frontend;
  let peak = 0;
  for (let i = 0; i < history.n; i++) {
    const cpu = f.cpuCores?.[i];
    const lim = f.cpuLimitCores?.[i];
    const reps = f.replicas?.[i];
    if (cpu == null || !lim || !reps) continue;
    peak = Math.max(peak, cpu / (lim * reps));
  }
  const repsBefore = Math.max(...(f.replicas ?? []).filter((x): x is number => x !== null));
  const after = replicasAfter === 'hpa' ? 3 : replicasAfter;
  const util = (peak * scale * repsBefore) / after;
  return { historyPeakUtil: peak, predictedPeakUtil: util, verdict: util < 1 ? 'pass' : 'fail' };
}

async function main() {
  const system = process.argv[2] ?? 'shop';
  const sysDir = join(ROOT, system);
  const cfg = parse(readFileSync(join(sysDir, 'reference.yaml'), 'utf8')) as K8sReference;
  const runDir = (r: string) => join(sysDir, 'runs', r);
  if (!existsSync(join(runDir(HIST), 'workspace', 'dataset.json'))) throw new Error(`record the ${HIST} run first`);

  // the agent's workspace: the calibration day's telemetry, calibrated as calibrate_model does it
  const evalDir = join(sysDir, 'validation');
  rmSync(evalDir, { recursive: true, force: true });
  mkdirSync(evalDir, { recursive: true });
  cpSync(join(runDir(HIST), 'workspace'), join(evalDir, 'workspace'), { recursive: true });
  const ws = new Workspace(join(evalDir, 'workspace'));
  ws.writeJson('dataset.json', await importRun(runDir(HIST), join(evalDir, 'runs', HIST)), false);
  rmSync(ws.path('model.json'), { force: true });
  const cal = await calibrateModel(ws, { slo: cfg.slo, holdout: 0.3 });
  const m = reviveModel(ws.readJson<Model>('model.json'));
  const history = ws.readJson<Dataset>('dataset.json');
  const base = resolve(sysDir, 'shop.yaml');

  const rows = [];
  const measuredCache = new Map<string, ReturnType<typeof measured>>();
  const meas = (run: string) => {
    if (!measuredCache.has(run)) measuredCache.set(run, measured(parseRequestLog(readFileSync(join(runDir(run), 'requests.csv'), 'utf8')), m.slo));
    return measuredCache.get(run)!;
  };
  for (const c of CASES) {
    if (!existsSync(join(runDir(c.run), 'run.json'))) {
      console.log(`(${c.run} not recorded yet — skipped)`);
      continue;
    }
    const run = await importRun(runDir(c.run), join(evalDir, 'runs', c.run));
    const log = parseRequestLog(readFileSync(join(runDir(c.run), 'requests.csv'), 'utf8'));
    const head = c.head ? resolve(sysDir, c.head) : undefined;

    // before the day: what verify_change says from the calibration day alone
    const exAnte = head
      ? verifyChange(ws, [{ kubernetes: { base, head } }], { traffic: c.scale !== 1 ? { scale: c.scale } : undefined, report: false })
      : verifyChange(ws, [{ strategy: { name: 'as built', changes: [] } }], { traffic: c.scale !== 1 ? { scale: c.scale } : undefined, report: false });
    const res = exAnte.results[0];
    const asBuiltMin = exAnte.asBuilt?.minutesOutOfSlo ?? 0;

    const actual = meas(c.run);
    const actualBase = meas(c.asBuilt);
    const post = predicted(m, ws, run, log, head, base);
    const replicasAfter = !c.head ? 3 : c.head.includes('hpa') ? ('hpa' as const) : Number(/frontend-(\d)/.exec(c.head)![1]);
    const nv = naive(history, replicasAfter, c.scale);
    // reality's verdict, judged like verify_change's gate: more than 0.5 min out of SLO added over
    // the as-built system on the same day (the as-built system itself: any minute out of SLO)
    const added = c.run === c.asBuilt ? actual.minutesOutOfSlo : actual.minutesOutOfSlo - actualBase.minutesOutOfSlo;
    const truth = added > 0.5 ? 'fail' : 'pass';
    const predictedVerdict = c.run === c.asBuilt ? (asBuiltMin > 0.5 ? 'fail' : 'pass') : res?.verdict;
    rows.push({
      run: c.run,
      question: c.question,
      exAnte: {
        verdict: predictedVerdict,
        confidence: res?.confidence.level ?? null,
        minutesOutOfSlo: c.run === c.asBuilt ? asBuiltMin : (res?.reliability.minutesOutOfSlo ?? null),
        monthlyDelta: c.run === c.asBuilt ? null : (res?.cost.monthlyDelta ?? null),
        worst: c.run === c.asBuilt ? null : (res?.reliability.worst ?? null),
        summary: res?.summary ?? null,
      },
      exPost: { p99Ms: Math.round(post.p99), errorRate: post.errorRate, minutesOutOfSlo: post.minutesOutOfSlo, frontendReplicasPeak: post.frontendReplicasPeak },
      series: { predicted: post.series, measured: measuredSeries(log, run.start, run.n, run.stepS), frontendReplicas: run.services.frontend?.replicas ?? [] },
      measured: { p99Ms: Math.round(actual.p99), errorRate: actual.errorRate, minutesOutOfSlo: actual.minutesOutOfSlo, requests: actual.requests, addedOverAsBuilt: Math.round(added * 10) / 10 },
      truth,
      naive: nv,
      agrees: { backtest: predictedVerdict === truth, naive: nv.verdict === truth },
    });
    const last = rows[rows.length - 1];
    console.log(`${c.run.padEnd(11)} truth ${truth.padEnd(4)} | backtest ${String(predictedVerdict).padEnd(4)} ${last.agrees.backtest ? '✓' : '✗'} | naive ${nv.verdict.padEnd(4)} ${last.agrees.naive ? '✓' : '✗'} (${Math.round(nv.predictedPeakUtil * 100)}% CPU) | p99 pred ${last.exPost.p99Ms} meas ${last.measured.p99Ms} | min out pred ${last.exPost.minutesOutOfSlo} meas ${last.measured.minutesOutOfSlo}`);
  }
  // the model's accuracy record: every recorded run it never saw, the change really applied
  const refRuns: ReferenceRun[] = [];
  const strategies: string[] = [];
  for (const c of CASES) {
    if (!existsSync(join(runDir(c.run), 'run.json'))) continue;
    const head = c.head ? resolve(sysDir, c.head) : undefined;
    const spec = head ? strategiesFrom(ws, [{ kubernetes: { base, head } }], m).strategies[0] : undefined;
    if (spec) {
      spec.name = c.head!.includes('hpa') ? 'Frontend on an HPA, 1–3 replicas' : `Frontend at ${/frontend-(\d)/.exec(c.head!)![1]} replica${c.head!.includes('-1') ? '' : 's'}`;
      spec.description = `${c.head} — the manifests applied for real in run ${c.run}`;
      const y = toYaml(spec);
      if (!strategies.includes(y)) strategies.push(y);
    }
    refRuns.push({ label: c.run, dataset: await importRun(runDir(c.run), join(evalDir, 'runs', c.run)), requests: parseRequestLog(readFileSync(join(runDir(c.run), 'requests.csv'), 'utf8')), strategy: spec });
  }
  if (refRuns.length) m.accuracy.push(referenceAccuracy(m, refRuns, `recorded Kubernetes runs the model never saw: ${refRuns.map((r) => r.label).join(', ')}`));
  for (const a of m.accuracy) {
    console.log(`\n${a.method}: ${a.label}`);
    for (const l of accuracyLines(a)) console.log('  ' + l);
  }
  m.name = cfg.name;
  ws.writeJson('model.json', m, false);
  // the app's bundled reference
  const pub = join(ROOT, '..', '..', 'public', 'reference');
  writeFileSync(join(pub, `k8s-${system}.json`), JSON.stringify({ name: cfg.name, source: `reference/k8s/${system} — a kind cluster, NASA's 12 July 1995 traffic, recorded ${new Date(history.start * 1000).toISOString().slice(0, 10)}`, dataset: history, model: m, strategies }));
  const indexPath = join(pub, 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { id: string; label: string }[];
  const entry = { id: `k8s-${system}`, label: `${cfg.name} (reference)` };
  writeFileSync(indexPath, JSON.stringify([...index.filter((x) => x.id !== entry.id), entry], null, 1));

  const out = { system: cfg.name, slo: cfg.slo, calibratedOn: 'history (12 July 1995, as built)', trust: cal, rows, evaluatedAt: new Date().toISOString() };
  writeFileSync(join(evalDir, 'validation.json'), JSON.stringify(out, null, 1));

  // the README's results table
  const pc = (v: number) => `${(v * 100).toFixed(v < 0.01 ? 2 : 1)}%`;
  const verdict = (v: string | null | undefined, ok: boolean) => `${v ?? '—'} ${ok ? '✅' : v === 'inconclusive' ? '⚠️' : '❌'}`;
  const md = [
    '| run | question | measured (k6, every request) | backtest before the day | model on the day’s real traffic | naive CPU ratio |',
    '|---|---|---|---|---|---|',
    ...rows.map((r) => `| \`${r.run}\` | ${r.question} | **${r.truth}** — p99 ${r.measured.p99Ms} ms, errors ${pc(r.measured.errorRate)}, ${r.measured.minutesOutOfSlo} min out of SLO | ${verdict(r.exAnte.verdict, r.agrees.backtest)}${r.exAnte.confidence ? ` (${r.exAnte.confidence} confidence)` : ''}, ${r.exAnte.minutesOutOfSlo ?? '—'} min | p99 ${r.exPost.p99Ms} ms, errors ${pc(r.exPost.errorRate)}, ${r.exPost.minutesOutOfSlo} min | ${verdict(r.naive.verdict, r.agrees.naive)} at ${Math.round(r.naive.predictedPeakUtil * 100)}% CPU |`),
    '',
    `Backtest verdicts: **${rows.filter((r) => r.agrees.backtest).length} right**, ${rows.filter((r) => r.exAnte.verdict === 'inconclusive').length} inconclusive (it said to load-test), ${rows.filter((r) => !r.agrees.backtest && r.exAnte.verdict !== 'inconclusive').length} wrong, of ${rows.length}. Naive CPU ratio: ${rows.filter((r) => r.agrees.naive).length} right of ${rows.length}. Generated by \`npx tsx reference/k8s/evaluate.ts\`, ${new Date().toISOString().slice(0, 10)}.`,
  ].join('\n');
  const readme = join(ROOT, 'README.md');
  writeFileSync(readme, readFileSync(readme, 'utf8').replace(/<!-- RESULTS -->[\s\S]*<!-- \/RESULTS -->/, `<!-- RESULTS -->\n${md}\n<!-- /RESULTS -->`));
  console.log(`\nwrote ${join(evalDir, 'validation.json')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
