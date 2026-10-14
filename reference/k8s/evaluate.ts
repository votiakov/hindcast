/**
 * Would the backtest have told you the truth? For every recorded Kubernetes run with a change
 * really applied, compare three answers with what k6 measured on every request:
 *
 *   - the agent's verdict before the change shipped: verify_change on the calibration history
 *     (launch day forecast as the ordinary day at the launch day's ratio, 2.2×)
 *   - the model's prediction over the traffic that actually came (model error alone, no forecast error)
 *   - a naive estimate: the frontend's busiest CPU utilisation in the history, scaled by the change
 *
 * Two models are scored: calibrated on the ordinary day alone, and on the ordinary day plus a
 * 12-minute step load test (the `stress` run) — what a team that load-tests before a launch has.
 *
 *   npx tsx reference/k8s/evaluate.ts [system]     → <system>/validation/validation.json, the README's table,
 *                                                   public/reference/k8s-<system>.json for the app
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { parse, stringify as toYaml } from 'yaml';
import { agent, strategyFromManifests, Workspace } from '../hindcast';
import { reviveModel, type Model } from '../../src/backtest/model';
import { quantile, type Dataset } from '../../src/backtest/dataset';
import { basePlan, mixtureQuantile, runPlan } from '../../src/backtest/engine';
import { applyStrategy } from '../../src/backtest/strategy';
import { observedReplicas, trafficOf } from '../../src/backtest/calibrate';
import { accuracyLines, parseRequestLog, referenceAccuracy, type ReferenceRun, type RequestLog } from '../../src/backtest/accuracy';
import { importBundle } from '../../src/backtest/import/manifest';
import { exportPlan, podsByNodeQuery, workloadRe } from '../../src/backtest/import/promql';
import { nodeLoss } from '../../src/backtest/resilience';
import { fileAccess } from '../../scripts/files';
import type { K8sReference } from './record';
import { loadEngine } from '../../src/backtest/native';

await loadEngine();

const ROOT = dirname(fileURLToPath(import.meta.url));
const STEP = 30;
/** the first two minutes of every run are left out of the scoring, measured and predicted alike:
 *  pods restarted minutes earlier and carts filled during the warm-up — the recording's own
 *  transient, not the day's */
const SETTLE_S = 120;

interface Case {
  run: string;
  /** the as-built run on the same day, for "did the change add minutes out of SLO?" */
  asBuilt: string;
  /** manifests the change leaves (none: the as-built system itself) */
  head?: string;
  /** the forecast an engineer would make before the day: the ordinary day ×scale */
  scale: number;
  question: string;
  /** frontend cores per pod after the change (default: as built, half a core) */
  cpu?: number;
  /** added after the throttle model was designed on the other runs; predicted before it ran */
  oos?: boolean;
}

const LAUNCH = 2.22; // 13 July's busiest 10 minutes over 12 July's, from the log itself
const CASES: Case[] = [
  { run: 'launch', asBuilt: 'launch', scale: LAUNCH, question: 'As built (3 frontend replicas), on launch day?' },
  { run: 'normal-2', asBuilt: 'history', head: 'variants/frontend-2.yaml', scale: 1, question: '2 frontend replicas instead of 3, on an ordinary day?' },
  { run: 'launch-2', asBuilt: 'launch', head: 'variants/frontend-2.yaml', scale: LAUNCH, question: '2 frontend replicas instead of 3, on launch day?' },
  { run: 'normal-1', asBuilt: 'history', head: 'variants/frontend-1.yaml', scale: 1, question: '1 frontend replica, on an ordinary day?' },
  { run: 'launch-hpa', asBuilt: 'launch', head: 'variants/frontend-hpa.yaml', scale: LAUNCH, question: 'An HPA (1–3 replicas at 60% CPU) instead of 3 fixed, on launch day?' },
  { run: 'launch-2c', asBuilt: 'launch', head: 'variants/frontend-2-1cpu.yaml', scale: LAUNCH, cpu: 1, oos: true, question: '2 frontend replicas at 1 core instead of 3 at half a core, on launch day?' },
  { run: 'normal-1c', asBuilt: 'history', head: 'variants/frontend-1-1cpu.yaml', scale: 1, cpu: 1, oos: true, question: '1 frontend replica at 1 core, on an ordinary day?' },
  { run: 'normal-1-750', asBuilt: 'history', head: 'variants/frontend-1-750m.yaml', scale: 1, cpu: 0.75, oos: true, question: '1 frontend replica at 750m, on an ordinary day?' },
  { run: 'launch-x1.3', asBuilt: 'launch-x1.3', scale: LAUNCH * 1.3, oos: true, question: 'As built, on a launch day with 30% more traffic?' },
];
const AS_BUILT_CPU = 0.5;

let SYS = '';
const runDir = (r: string) => join(SYS, 'runs', r);
const meta = (r: string) => JSON.parse(readFileSync(join(runDir(r), 'run.json'), 'utf8')) as { start: number; end: number };
const recorded = (r: string) => existsSync(join(runDir(r), 'run.json'));

/** series added to the kubernetes preset after a collection: filled into a cached dataset from
 *  Prometheus alone (Jaeger doesn't keep traces as long), so the traces it was built on stay */
const LATER_SERIES = ['memory-max.json', 'memory-limit.json', 'cpu-request.json', 'memory-request.json', 'cluster-nodes.json', 'cluster-node-cpu.json', 'cluster-node-memory.json', 'cluster-requested-cpu.json', 'cluster-requested-memory.json'];
async function fillLater(d: Dataset, out: string): Promise<Dataset> {
  const want = exportPlan(['kubernetes'], { window: `${STEP}s` }).map((p) => ({ ...p.query, file: p.query.file.replace(/^kubernetes-/, '') })).filter((q) => LATER_SERIES.includes(q.file));
  const isCluster = (m: string) => m.startsWith('cluster');
  const missing = want.filter((q) => (isCluster(q.mapping.metric) ? !(d.cluster as Record<string, unknown> | undefined)?.[q.mapping.metric] : !Object.values(d.services).some((sv) => (sv as Record<string, unknown>)[q.mapping.metric])));
  const prom = (JSON.parse(readFileSync(join(out, 'sources.json'), 'utf8')) as { prometheus: { url: string; namespaces?: string[] } }).prometheus;
  if (!d.podsByNode) {
    const t = d.start + (d.n - 1) * d.stepS;
    const j = (await (await fetch(`${prom.url}/api/v1/query?query=${encodeURIComponent(podsByNodeQuery(prom.namespaces ?? ['shop']))}&time=${t}`)).json()) as { data: { result: { metric: Record<string, string>; value: [number, string] }[] } };
    const by: Record<string, Record<string, number>> = {};
    for (const r of j.data.result) if (d.services[r.metric.workload]) (by[r.metric.workload] ??= {})[r.metric.node] = Number(r.value[1]);
    if (Object.keys(by).length) {
      d.podsByNode = by;
      writeFileSync(join(out, 'dataset.json'), JSON.stringify(d));
      console.warn(`(${out}: filled podsByNode from Prometheus)`);
    }
  }
  if (!missing.length) return d;
  const promUrl = prom.url;
  for (const q of missing) {
    const u = `${promUrl}/api/v1/query_range?query=${encodeURIComponent(q.query)}&start=${d.start}&end=${d.start + (d.n - 1) * d.stepS}&step=${d.stepS}`;
    const j = (await (await fetch(u)).json()) as { data: { result: { metric: Record<string, string>; values: [number, string][] }[] } };
    for (const r of j.data.result) {
      const sv = (isCluster(q.mapping.metric) ? (d.cluster ??= {}) : d.services[r.metric.workload]) as Record<string, unknown> | undefined;
      if (!sv) continue;
      const xs: (number | null)[] = new Array(d.n).fill(null);
      for (const [t, v] of r.values) {
        const i = Math.round((t - d.start) / d.stepS);
        if (i >= 0 && i < d.n) xs[i] = Number(v);
      }
      sv[q.mapping.metric] = xs;
    }
  }
  writeFileSync(join(out, 'dataset.json'), JSON.stringify(d));
  console.warn(`(${out}: filled ${missing.map((q) => q.mapping.metric).join(', ')} from Prometheus)`);
  return d;
}

/** the telemetry of one or more runs, collected from the live Prometheus and Jaeger with today's code
 *  (the agent's path) the first time, then kept: Jaeger only holds the traces while the cluster runs.
 *  --refresh collects again. Without the cluster and a collection: the files collected during the
 *  recording, imported with today's importer */
const collected = new Map<string, Dataset>();
async function telemetryOf(runs: string[], out: string, settle = false): Promise<Dataset> {
  const key = runs.join('+') + (settle ? ':settled' : '');
  if (collected.has(key)) return collected.get(key)!;
  let d: Dataset;
  if (existsSync(join(out, 'dataset.json')) && !process.argv.includes('--refresh')) {
    d = JSON.parse(readFileSync(join(out, 'dataset.json'), 'utf8')) as Dataset;
    // collected before the trace importer read endpoint medians and p90s: imported again from the
    // files the collection kept (Jaeger no longer has the traces)
    const mp = ['hindcast.import.yaml', 'bottleneck.import.yaml'].map((m) => join(out, 'telemetry', m)).find((x) => existsSync(x));
    if (mp && d.topology && Object.values(d.topology.endpoints).some((e) => e.p50Ms === undefined)) {
      const again = importBundle(parse(readFileSync(mp, 'utf8')), fileAccess(mp)).dataset;
      d = { ...again, ...(d.podsByNode ? { podsByNode: d.podsByNode } : {}), ...(d.nodeZones ? { nodeZones: d.nodeZones } : {}), ...(d.hpa ? { hpa: d.hpa } : {}) };
      writeFileSync(join(out, 'dataset.json'), JSON.stringify(d));
      console.warn(`(${out}: imported again from its collected files)`);
    }
    try {
      d = await fillLater(d, out);
    } catch (e) {
      console.warn(`(${out}: could not fill newer series — ${(e as Error).message.slice(0, 100)})`);
    }
    collected.set(key, d);
    return d;
  }
  const fresh = `${out}.new`;
  try {
    rmSync(fresh, { recursive: true, force: true });
    mkdirSync(fresh, { recursive: true });
    cpSync(join(runDir(runs[0]), 'workspace', 'sources.json'), join(fresh, 'sources.json'));
    const ws = new Workspace(fresh);
    // calibration histories leave out the same settling minutes the scoring leaves out
    const w = runs.map((r) => ({ start: meta(r).start + (settle ? SETTLE_S : 0), end: meta(r).end }));
    agent('collect_telemetry', ws, w.length > 1 ? { windows: w, stepS: STEP, maxTraces: 6000 * w.length } : { ...w[0], stepS: STEP, maxTraces: 6000 });
    d = ws.readJson<Dataset>('dataset.json');
    rmSync(out, { recursive: true, force: true });
    renameSync(fresh, out);
  } catch (e) {
    rmSync(fresh, { recursive: true, force: true });
    const why = (e as Error).message.slice(0, 120);
    // the cluster is gone (it only lives as long as the study): the last collection from it stands
    if (existsSync(join(out, 'dataset.json'))) {
      console.warn(`(${runs.join('+')}: live telemetry unavailable — ${why}; using the last collection, ${out})`);
      d = JSON.parse(readFileSync(join(out, 'dataset.json'), 'utf8')) as Dataset;
      collected.set(key, d);
      return d;
    }
    if (runs.length > 1) throw e;
    console.warn(`(${runs[0]}: live telemetry unavailable — ${why}; using the recorded files)`);
    // hindcast.import.yaml from a collection today; the recorded runs predate the rename
    const tel = join(runDir(runs[0]), 'workspace', 'telemetry');
    const mp = ['hindcast.import.yaml', 'bottleneck.import.yaml'].map((m) => join(tel, m)).find((p) => existsSync(p)) ?? join(tel, 'hindcast.import.yaml');
    d = importBundle(parse(readFileSync(mp, 'utf8')), fileAccess(mp)).dataset;
  }
  collected.set(key, d);
  return d;
}

// committed gzipped; the recorder leaves the plain file
const requestsOf = (r: string) => parseRequestLog(existsSync(join(runDir(r), 'requests.csv')) ? readFileSync(join(runDir(r), 'requests.csv'), 'utf8') : gunzipSync(readFileSync(join(runDir(r), 'requests.csv.gz'))).toString('utf8'));
/** a run's requests after the settling period */
function settled(log: RequestLog, start: number): RequestLog {
  const keep = log.t.map((t) => t >= start + SETTLE_S);
  return { t: log.t.filter((_, k) => keep[k]), ms: log.ms.filter((_, k) => keep[k]), failed: log.failed.filter((_, k) => keep[k]) };
}

/** what k6 measured: p99 and errors over every request, and 30-second buckets out of SLO */
function measured(log: RequestLog, slo: Model['slo']) {
  const ms = [...log.ms].sort((a, b) => a - b);
  const byBucket = new Map<number, { ms: number[]; failed: number }>();
  for (let k = 0; k < log.t.length; k++) {
    const b = Math.floor(log.t[k] / STEP);
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
  return { requests: log.t.length, p99: quantile(ms, 0.99), errorRate: failed / Math.max(1, log.t.length), minutesOutOfSlo: (out * STEP) / 60 };
}

/** what k6 measured per bucket of the run's grid, for the charts */
function measuredSeries(log: RequestLog, start: number, n: number) {
  const b = Array.from({ length: n }, () => ({ ms: [] as number[], failed: 0 }));
  for (let k = 0; k < log.t.length; k++) {
    const i = Math.floor((log.t[k] - start) / STEP);
    if (i < 0 || i >= n) continue;
    b[i].ms.push(log.ms[k]);
    if (log.failed[k]) b[i].failed++;
  }
  return b.map((x) => {
    x.ms.sort((a, c) => a - c);
    return { rps: Math.round((x.ms.length / STEP) * 10) / 10, p99Ms: x.ms.length ? Math.round(quantile(x.ms, 0.99)) : null, errorRate: x.ms.length ? Math.round((x.failed / x.ms.length) * 1e4) / 1e4 : null };
  });
}

/** the model with the change, replayed over the traffic the run actually had (after settling) */
function predicted(m: Model, ws: Workspace, run: Dataset, runStart: number, head: string | undefined, base: string) {
  const strat = head ? strategyFromManifests(base, head, ws.path('model.json')) : undefined;
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
  const i0 = Math.max(0, Math.ceil((runStart + SETTLE_S - run.start) / run.stepS));
  let n = 0;
  let f = 0;
  let out = 0;
  const parts: { w: number; mean: number; p99: number; p50?: number }[] = [];
  for (let i = i0; i < r.t.length; i++) {
    n += r.rps[i];
    f += r.rps[i] * r.errorRate[i];
    if (r.rps[i] > 0 && (r.p99Ms[i] > m.slo.p99Ms || r.errorRate[i] > m.slo.errorRate)) out++;
    for (const e of Object.values(r.endpoints)) if (e.rps[i] > 0) parts.push({ w: e.rps[i], mean: e.meanMs[i], p99: e.p99Ms[i], ...(e.p50Ms[i] > 0 && e.p99Ms[i] < 4000 ? { p50: e.p50Ms[i] } : {}) });
  }
  const series = { rps: r.rps.map((x) => Math.round(x * 10) / 10), p99Ms: r.p99Ms.map((x) => Math.round(x)), errorRate: r.errorRate.map((x) => Math.round(x * 1e4) / 1e4), frontendReplicas: r.services.frontend?.replicas ?? [] };
  return { p99: parts.length ? mixtureQuantile(parts) : 0, errorRate: n > 0 ? f / n : 0, minutesOutOfSlo: (out * run.stepS) / 60, frontendReplicasPeak: Math.max(...(r.services.frontend?.replicas ?? [0])), series };
}

/** the spreadsheet answer: the frontend's busiest CPU share in the history, scaled by the change */
function naive(history: Dataset, replicasAfter: number | 'hpa', scale: number, cpuAfter = AS_BUILT_CPU) {
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
  const util = (peak * scale * repsBefore * AS_BUILT_CPU) / ((replicasAfter === 'hpa' ? 3 : replicasAfter) * cpuAfter);
  return { historyPeakUtil: peak, predictedPeakUtil: util, verdict: util < 1 ? 'pass' : 'fail' };
}

const strategyName = (head: string) => {
  if (head.includes('hpa')) return 'Frontend on an HPA, 1–3 replicas';
  const [, n, cpu] = /frontend-(\d)(?:-(\w+))?\.yaml/.exec(head)!;
  return `Frontend at ${n} replica${n === '1' ? '' : 's'}${cpu ? `, ${cpu.replace('cpu', ' core')} each` : ''}`;
};
const replicasOfHead = (head: string) => Number(/frontend-(\d)/.exec(head)![1]);

/** what verify_change says before the day, from the calibration history alone */
function forecast(c: Case, ws: Workspace, base: string) {
  const head = c.head ? resolve(SYS, c.head) : undefined;
  const traffic = c.scale !== 1 ? { scale: c.scale } : undefined;
  // the replay is the ordinary day, whatever else the model learned from (a load test)
  const window = { start: meta('history').start + SETTLE_S, end: meta('history').end };
  const exAnte = agent('verify_change', ws, { changes: [head ? { kubernetes: { base, head } } : { strategy: { name: 'as built', changes: [] } }], traffic, window, report: false });
  const res = exAnte.results[0];
  const asBuilt = c.run === c.asBuilt;
  const asBuiltMin = exAnte.asBuilt?.minutesOutOfSlo ?? 0;
  return {
    verdict: asBuilt ? (asBuiltMin > 0.5 ? 'fail' : 'pass') : res?.verdict,
    confidence: asBuilt ? null : (res?.confidence.level ?? null),
    minutesOutOfSlo: asBuilt ? asBuiltMin : (res?.reliability.minutesOutOfSlo ?? null),
    peakP99Ms: asBuilt ? null : (res?.reliability.peakP99Ms ?? null),
    monthlyDelta: asBuilt ? null : (res?.cost.monthlyDelta ?? null),
    reasons: asBuilt ? [] : (res?.reasons ?? []),
    warnings: asBuilt ? [] : (res?.confidence.warnings ?? []),
  };
}

const predictionsPath = () => join(SYS, 'validation', 'predictions-oos.json');
type Forecast = ReturnType<typeof forecast>;
function predictionsOf(model: string): Record<string, Forecast> | undefined {
  if (!existsSync(predictionsPath())) return undefined;
  return (JSON.parse(readFileSync(predictionsPath(), 'utf8')) as { models: Record<string, Record<string, Forecast>> }).models[model];
}

/** score one calibrated model on every recorded case */
async function score(label: string, ws: Workspace, base: string, evalDir: string, ordinaryDay: Dataset) {
  const m = reviveModel(ws.readJson<Model>('model.json'));
  // the naive estimate reads the ordinary day's CPU, whatever the model was calibrated on
  const history = ordinaryDay;
  const rows = [];
  for (const c of CASES) {
    if (!recorded(c.run) || !recorded(c.asBuilt)) continue;
    const run = await telemetryOf([c.run], join(evalDir, 'runs', c.run));
    const log = settled(requestsOf(c.run), meta(c.run).start);
    const head = c.head ? resolve(SYS, c.head) : undefined;
    // out-of-sample runs are scored on the verdict committed before they ran, not one computed after
    const committed = c.oos ? predictionsOf(label)?.[c.run] : undefined;
    const now = forecast(c, ws, base);
    if (committed && committed.verdict !== now.verdict) console.warn(`(${label} ${c.run}: predicted ${committed.verdict} before the run; today's code says ${now.verdict})`);
    const exAnte = committed ?? now;
    const actual = measured(log, m.slo);
    const actualBase = measured(settled(requestsOf(c.asBuilt), meta(c.asBuilt).start), m.slo);
    const post = predicted(m, ws, run, meta(c.run).start, head, base);
    const nv = naive(history, !c.head ? 3 : c.head.includes('hpa') ? 'hpa' : replicasOfHead(c.head), c.scale, c.cpu);
    // reality's verdict, judged like verify_change's gate: more than 0.5 min out of SLO added over
    // the as-built system on the same day (for the as-built system itself: more than 0.5 min)
    const added = c.run === c.asBuilt ? actual.minutesOutOfSlo : actual.minutesOutOfSlo - actualBase.minutesOutOfSlo;
    const truth = added > 0.5 ? 'fail' : 'pass';
    const verdict = exAnte.verdict;
    const row = {
      run: c.run,
      question: c.question,
      oos: !!c.oos,
      exAnte,
      exPost: { p99Ms: Math.round(post.p99), errorRate: post.errorRate, minutesOutOfSlo: post.minutesOutOfSlo, frontendReplicasPeak: post.frontendReplicasPeak },
      measured: { p99Ms: Math.round(actual.p99), errorRate: actual.errorRate, minutesOutOfSlo: actual.minutesOutOfSlo, requests: actual.requests, addedOverAsBuilt: Math.round(added * 10) / 10 },
      series: { predicted: post.series, measured: measuredSeries(log, run.start, run.n), frontendReplicas: run.services.frontend?.replicas ?? [] },
      truth,
      naive: nv,
      agrees: { backtest: verdict === truth, naive: nv.verdict === truth },
    };
    rows.push(row);
    console.log(`[${label}] ${c.run.padEnd(11)} truth ${truth.padEnd(4)} | backtest ${String(verdict).padEnd(12)} ${row.agrees.backtest ? '✓' : '✗'} | naive ${nv.verdict.padEnd(4)} ${row.agrees.naive ? '✓' : '✗'} (${Math.round(nv.predictedPeakUtil * 100)}% CPU) | p99 model ${row.exPost.p99Ms} measured ${row.measured.p99Ms} | min out model ${row.exPost.minutesOutOfSlo} measured ${row.measured.minutesOutOfSlo}`);
  }
  return rows;
}

/** a node failure for real (a run with `kill`): what check_node_loss said from the ordinary day and
 *  the placement at the instant of the kill, what the model said on the day's own traffic, and what
 *  the client measured — each against the as-built ordinary day */
async function nodeLossCase(run: string, ws: Workspace, evalDir: string) {
  const m = reviveModel(ws.readJson<Model>('model.json'));
  const info = JSON.parse(readFileSync(join(runDir(run), 'run.json'), 'utf8')) as { start: number; end: number; kill: { node: string; at: number } };
  const ns = 'shop';
  const re = new RegExp(workloadRe());
  const pods: Record<string, Record<string, number>> = {};
  for (const line of readFileSync(join(runDir(run), 'placement.txt'), 'utf8').split('\n')) {
    const [nsp, pod, node, phase] = line.trim().split(/\s+/);
    if (nsp !== ns || phase !== 'Running' || !node) continue;
    const mm = re.exec(pod);
    const w = mm ? (mm[1] ?? mm[2] ?? mm[3]) : pod;
    (pods[w] ??= {})[node] = (pods[w][node] ?? 0) + 1;
  }
  const into = info.kill.at - info.start;
  // before the day: the ordinary day (it starts SETTLE_S into the run's clock)
  const calm = ws.readJson<Dataset>('dataset.json');
  const exAnte = nodeLoss(m, calm, { pods, nodes: [info.kill.node], atS: into - SETTLE_S, draws: 10 }).results[0];
  // on the day: the run's own traffic, the node lost at the moment it was
  const day = await telemetryOf([run], join(evalDir, 'runs', run));
  const onDay = nodeLoss(m, day, { pods, nodes: [info.kill.node], atS: info.kill.at - day.start, draws: 10 }).results[0];
  const actual = measured(settled(requestsOf(run), info.start), m.slo);
  const asBuilt = measured(settled(requestsOf('history'), meta('history').start), m.slo);
  const failedOf = (x: ReturnType<typeof measured>) => Math.round(x.errorRate * x.requests);
  const row = {
    run,
    node: info.kill.node,
    atMinute: Math.round((into / 60) * 10) / 10,
    /** in the ordinary day's clock (the bundled history), and the placement at that instant */
    atS: into - SETTLE_S,
    pods,
    lost: exAnte.lost,
    predicted: { minutesOutOfSlo: exAnte.minutesOutOfSlo, failedRequests: exAnte.failedRequests, verdict: exAnte.verdict, worst: exAnte.worst },
    onTheDay: { minutesOutOfSlo: onDay.minutesOutOfSlo, failedRequests: onDay.failedRequests },
    measured: { minutesOutOfSlo: Math.round((actual.minutesOutOfSlo - asBuilt.minutesOutOfSlo) * 10) / 10, failedRequests: failedOf(actual) - failedOf(asBuilt), errorRate: actual.errorRate, p99Ms: Math.round(actual.p99) },
  };
  console.log(`[node loss] ${run}: ${info.kill.node} at minute ${row.atMinute} — predicted +${row.predicted.minutesOutOfSlo} min, +${row.predicted.failedRequests} failed; on the day +${row.onTheDay.minutesOutOfSlo} min, +${row.onTheDay.failedRequests}; measured +${row.measured.minutesOutOfSlo} min, +${row.measured.failedRequests} failed`);
  return row;
}

async function calibrated(name: string, runs: string[], evalDir: string, slo: Model['slo']) {
  const dir = join(evalDir, name);
  mkdirSync(dir, { recursive: true });
  cpSync(join(runDir(runs[0]), 'workspace', 'sources.json'), join(dir, 'sources.json'));
  const ws = new Workspace(dir);
  ws.writeJson('dataset.json', await telemetryOf(runs, join(evalDir, 'collected', runs.join('+')), true), false);
  const trust = agent('calibrate_model', ws, { slo, holdout: runs.length > 1 ? 0 : 0.3 });
  return { ws, trust };
}

async function main() {
  const system = process.argv[2] ?? 'shop';
  SYS = join(ROOT, system);
  const cfg = parse(readFileSync(join(SYS, 'reference.yaml'), 'utf8')) as K8sReference;
  if (!recorded('history')) throw new Error('record the history run first');
  const evalDir = join(SYS, 'validation');
  // models are rebuilt every time; collected telemetry is kept (refreshed when the cluster is up)
  mkdirSync(evalDir, { recursive: true });
  for (const f of readdirSync(evalDir)) if (!['collected', 'runs', 'predictions-oos.json'].includes(f)) rmSync(join(evalDir, f), { recursive: true, force: true });
  const base = resolve(SYS, 'shop.yaml');

  const calm = await calibrated('calm', ['history'], evalDir, cfg.slo);
  const models: { id: string; label: string; rows: Awaited<ReturnType<typeof score>>; trust: unknown }[] = [{ id: 'calm', label: 'calibrated on the ordinary day', rows: await score('calm', calm.ws, base, evalDir, calm.ws.readJson<Dataset>('dataset.json')), trust: calm.trust }];
  if (recorded('stress')) {
    const tested = await calibrated('load-tested', ['history', 'stress'], evalDir, cfg.slo);
    models.push({ id: 'load-tested', label: 'calibrated on the ordinary day and a 12-minute load test', rows: await score('load-tested', tested.ws, base, evalDir, calm.ws.readJson<Dataset>('dataset.json')), trust: tested.trust });
  }

  // --predict: write down what each model says about the out-of-sample runs before they are recorded
  if (process.argv.includes('--predict')) {
    const out = { madeAt: new Date().toISOString(), commit: spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), models: {} as Record<string, Record<string, Forecast>> };
    for (const mod of models) {
      const ws = new Workspace(join(evalDir, mod.id));
      out.models[mod.id] = {};
      for (const c of CASES.filter((x) => x.oos)) {
        out.models[mod.id][c.run] = forecast(c, ws, base);
        const f = out.models[mod.id][c.run];
        console.log(`[${mod.id}] ${c.run.padEnd(13)} predicts ${String(f.verdict).padEnd(12)} ${f.confidence ?? ''} ${f.minutesOutOfSlo ?? ''} min — ${c.question}`);
      }
    }
    if (existsSync(predictionsPath()) && !process.argv.includes('--force')) throw new Error(`${predictionsPath()} exists: predictions are made once (--force to redo before any run is recorded)`);
    writeFileSync(predictionsPath(), JSON.stringify(out, null, 1));
    console.log(`wrote ${predictionsPath()}`);
    return;
  }

  // the model the app bundles: the best history a team would have, with its accuracy on every run it never saw
  const best = recorded('stress') ? new Workspace(join(evalDir, 'load-tested')) : calm.ws;
  const m = reviveModel(best.readJson<Model>('model.json'));
  const refRuns: ReferenceRun[] = [];
  const strategies: string[] = [];
  for (const c of CASES) {
    if (!recorded(c.run)) continue;
    const head = c.head ? resolve(SYS, c.head) : undefined;
    const spec = head ? (strategyFromManifests(base, head, best.path('model.json')) as Record<string, unknown> | undefined) : undefined;
    if (spec && !strategies.some((y) => y.includes(`name: ${strategyName(c.head!)}\n`))) {
      spec.name = strategyName(c.head!);
      spec.description = `${c.head} — the manifests applied for real (${CASES.filter((x) => x.head === c.head).map((x) => x.run).join(', ')})`;
      strategies.push(toYaml(spec));
    }
    refRuns.push({ label: c.run, dataset: await telemetryOf([c.run], join(evalDir, 'runs', c.run)), requests: requestsOf(c.run), strategy: spec });
  }
  if (refRuns.length) m.accuracy.push(referenceAccuracy(m, refRuns, `recorded Kubernetes runs the model never saw: ${refRuns.map((r) => r.label).join(', ')}`));
  for (const a of m.accuracy) {
    console.log(`\n${a.method}: ${a.label}`);
    for (const l of accuracyLines(a)) console.log('  ' + l);
  }
  m.name = cfg.name;
  best.writeJson('model.json', m, false);
  // the app replays the ordinary day; the model learned from it and the load test
  const history = calm.ws.readJson<Dataset>('dataset.json');
  const pub = join(ROOT, '..', '..', 'public', 'reference');
  // the node failures recorded for real travel with the bundle: the app replays them from the
  // placement at the instant of the kill, and shows what was measured
  const nodeLosses = [];
  for (const [run, r] of Object.entries(cfg.runs)) if (r.kill && recorded(run)) nodeLosses.push(await nodeLossCase(run, calm.ws, evalDir));
  writeFileSync(join(pub, `k8s-${system}.json`), JSON.stringify({ nodeLosses: nodeLosses.map((x) => ({ node: x.node, atS: x.atS, pods: x.pods, predicted: x.predicted, measured: x.measured })), name: cfg.name, source: `reference/k8s/${system} — a kind cluster, NASA's 12 July 1995 traffic${recorded('stress') ? ' and a load test' : ''}, recorded ${new Date(history.start * 1000).toISOString().slice(0, 10)}`, dataset: history, model: m, strategies }));
  const indexPath = join(pub, 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { id: string; label: string }[];
  const entry = { id: `k8s-${system}`, label: `${cfg.name} (reference)` };
  writeFileSync(indexPath, JSON.stringify([...index.filter((x) => x.id !== entry.id), entry], null, 1));

  writeFileSync(join(evalDir, 'validation.json'), JSON.stringify({ system: cfg.name, slo: cfg.slo, settleS: SETTLE_S, models, nodeLosses, evaluatedAt: new Date().toISOString() }, null, 1));

  // the README's results tables, one per model
  const pc = (v: number) => `${(v * 100).toFixed(v < 0.01 ? 2 : 1)}%`;
  const mark = (v: string | null | undefined, ok: boolean) => `${v ?? '—'} ${ok ? '✅' : v === 'inconclusive' ? '⚠️' : '❌'}`;
  type Row = (typeof models)[number]['rows'][number];
  const row = (r: Row) => `| \`${r.run}\` | ${r.question} | **${r.truth}**: p99 ${r.measured.p99Ms} ms, errors ${pc(r.measured.errorRate)}, ${r.measured.minutesOutOfSlo} min out of SLO | ${mark(r.exAnte.verdict, r.agrees.backtest)}${r.exAnte.confidence ? ` (${r.exAnte.confidence} confidence)` : ''}, ${r.exAnte.minutesOutOfSlo ?? '—'} min | p99 ${r.exPost.p99Ms} ms, errors ${pc(r.exPost.errorRate)}, ${r.exPost.minutesOutOfSlo} min | ${mark(r.naive.verdict, r.agrees.naive)} at ${Math.round(r.naive.predictedPeakUtil * 100)}% CPU |`;
  const tally = (rows: Row[]) => `Backtest verdicts: **${rows.filter((r) => r.agrees.backtest).length} right**, ${rows.filter((r) => r.exAnte.verdict === 'inconclusive').length} inconclusive (it said to load-test), ${rows.filter((r) => !r.agrees.backtest && r.exAnte.verdict !== 'inconclusive').length} wrong, of ${rows.length}. Naive CPU ratio: ${rows.filter((r) => r.agrees.naive).length} right.`;
  const head = ['| run | question | measured (k6, every request) | backtest before the day | model on the day’s real traffic | naive CPU ratio |', '|---|---|---|---|---|---|'];
  const md = models
    .map((mod) => {
      const ins = mod.rows.filter((r) => !r.oos);
      const oos = mod.rows.filter((r) => r.oos);
      return [
        `**${mod.label[0].toUpperCase()}${mod.label.slice(1)}:**`,
        '',
        ...head,
        ...ins.map(row),
        '',
        tally(ins),
        ...(oos.length ? ['', `*Out of sample* — added after the throttle model was designed on the runs above; the verdicts are the ones committed in \`validation/predictions-oos.json\` before each run was recorded:`, '', ...head, ...oos.map(row), '', tally(oos)] : []),
      ].join('\n');
    })
    .join('\n\n');
  const nl = nodeLosses.length
    ? [
        '',
        '**A node failure, for real:** check_node_loss from the ordinary day and the pod placement at the instant of the kill, the model on the day’s own traffic, and the client’s measurement — each against the as-built ordinary day.',
        '',
        '| run | node lost | services left with no replica | predicted before | model on the day | measured |',
        '|---|---|---|---|---|---|',
        ...nodeLosses.map((x) => `| \`${x.run}\` | ${x.node} at minute ${x.atMinute} | ${x.lost.filter((l) => l.down).map((l) => l.service).join(', ') || '—'} | +${x.predicted.minutesOutOfSlo} min, +${x.predicted.failedRequests.toLocaleString('en-US')} failed | +${x.onTheDay.minutesOutOfSlo} min, +${x.onTheDay.failedRequests.toLocaleString('en-US')} failed | +${x.measured.minutesOutOfSlo} min, +${x.measured.failedRequests.toLocaleString('en-US')} failed |`),
      ].join('\n')
    : '';
  const readme = join(ROOT, 'README.md');
  writeFileSync(readme, readFileSync(readme, 'utf8').replace(/<!-- RESULTS -->[\s\S]*<!-- \/RESULTS -->/, `<!-- RESULTS -->\n${md}\n${nl}\n\nThe first ${SETTLE_S / 60} minutes of every run are left out of the scoring, measured and predicted alike (pods restarted minutes earlier). Generated by \`npx tsx reference/k8s/evaluate.ts\`, ${new Date().toISOString().slice(0, 10)}.\n<!-- /RESULTS -->`));
  console.log(`\nwrote ${join(evalDir, 'validation.json')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
