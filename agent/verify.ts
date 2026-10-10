import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import type { Dataset } from '../src/backtest/dataset';
import { calibrate, type CalibrateOptions } from '../src/backtest/calibrate';
import { holdoutAccuracy, modelBreakingPoint } from '../src/backtest/accuracy';
import { backtest, type BacktestResult, type Ranged, type StrategyResult } from '../src/backtest/backtest';
import { basePlan, runPlan } from '../src/backtest/engine';
import { observedReplicas, trafficOf } from '../src/backtest/calibrate';
import { applyStrategy, StrategySpec } from '../src/backtest/strategy';
import { reviveModel, type Model } from '../src/backtest/model';
import { backtestMarkdown, headline } from '../src/backtest/report';
import { backtestHtml } from '../src/backtest/reportHtml';
import { readWorkloads, strategyFromDiff } from '../src/backtest/configDiff';
import { strategyFromTerraformPlan } from '../src/backtest/terraformDiff';
import { audit, type AuditResult } from '../src/sim/audit';
import { validateSpec } from '../src/spec/validate';
import { encodePayload } from '../src/spec/convert';
import { iso, seconds, Workspace } from './workspace';

/**
 * The verdicts an agent acts on. Every answer says how far to trust it: which services the change
 * pushes past anything the history showed (their capacity is an extrapolation there), how well the
 * model fits them, where the prices come from, and how the model did on data it never saw.
 */

const APP_URL = process.env.BOTTLENECK_APP_URL ?? 'http://localhost:5173';
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const money = (x: number) => `${x < 0 ? '−' : '+'}$${Math.abs(x).toFixed(Math.abs(x) < 100 ? 2 : 0)}`;
const range = (x: Ranged, f = r2) => ({ p50: f(x.p50), lo: f(x.lo), hi: f(x.hi) });

// ---------------------------------------------------------------------------------------------
// calibrate

export interface ServiceTrust {
  service: string;
  fit: string;
  capacityPerReplica: number | null;
  band: [number, number] | null;
  limit: string;
  replicas: number;
  /** highest share of capacity the history ran it at */
  historyPeakUtil: number | null;
  /** what the capacity rests on */
  basis: 'limit seen in history' | 'extrapolated' | 'no limit seen' | 'not modelled';
  cost: string;
  notes: string[];
}

export interface Calibration {
  model: string;
  fittedOn: { start: string; end: string; hours: number; stepS: number };
  services: ServiceTrust[];
  historyPeakUtil: Record<string, number>;
  traffic: Model['traffic'];
}

const LIMIT_SEEN = 0.85;

/** a phase boundary: report it, and let the event loop flush the notification before more CPU work */
const step = async (progress: ((m: string, d: number, t: number) => Promise<void>) | undefined, message: string, done: number, total: number) => {
  if (!progress) return;
  await progress(message, done, total);
  await new Promise((r) => setImmediate(r));
};

export async function calibrateModel(ws: Workspace, o: { holdout?: number; slo?: { p99Ms: number; errorRate: number }; timeoutMs?: number; listPrices?: boolean } = {}, progress?: (m: string, d: number, t: number) => Promise<void>) {
  const d = ws.readJson<Dataset>('dataset.json');
  await step(progress, `fitting ${Object.keys(d.services).length} services on ${d.n} buckets`, 0, 3);
  const src = ws.sources();
  const opts: CalibrateOptions = {
    ...(o.slo ?? src.system.slo ? { slo: o.slo ?? src.system.slo } : {}),
    ...(o.timeoutMs ?? src.system.timeoutMs ? { timeoutMs: o.timeoutMs ?? src.system.timeoutMs } : {}),
    listPrices: o.listPrices ?? true,
  };
  const m = calibrate(d, opts);
  const warnings: string[] = [];
  const holdout = o.holdout ?? 0.3;
  await step(progress, 'measuring accuracy on the held-back requests', 1, 3);
  if (holdout > 0 && d.n >= 30) {
    try {
      m.accuracy.push(holdoutAccuracy(d, { ...opts, holdout }));
    } catch (e) {
      warnings.push(`holdout accuracy could not be measured: ${(e as Error).message}`);
    }
  } else if (holdout > 0) warnings.push(`only ${d.n} buckets of history: too short to hold any back and measure accuracy`);
  ws.writeJson('model.json', m);

  await step(progress, 'replaying the history for the trust report', 2, 3);
  // replay the history once: how close each service came to its fitted capacity
  const replay = backtest(m, d, [], { draws: 1 });
  const peak = replay.baseline.peakUtil;
  const cal: Calibration = {
    model: m.name,
    fittedOn: { start: iso(m.fittedOn.start), end: iso(m.fittedOn.end), hours: r1((m.fittedOn.end - m.fittedOn.start) / 3600), stepS: m.fittedOn.stepS },
    services: Object.values(m.services).map((s) => trustOf(m, s.id, peak[s.id])),
    historyPeakUtil: Object.fromEntries(Object.entries(peak).map(([k, v]) => [k, r2(v)])),
    traffic: m.traffic,
  };
  ws.writeJson('calibration.json', cal);
  return summary(m, cal, warnings);
}

function trustOf(m: Model, id: string, peak: number | undefined): ServiceTrust {
  const s = m.services[id];
  const cap = isFinite(s.capacity.perReplicaRps) ? s.capacity.perReplicaRps : null;
  const basis: ServiceTrust['basis'] = s.kind === 'external' ? 'not modelled' : cap === null ? 'no limit seen' : (peak ?? 0) >= LIMIT_SEEN || s.capacity.overloadedRps ? 'limit seen in history' : 'extrapolated';
  return {
    service: id,
    fit: s.fit.status,
    capacityPerReplica: cap === null ? null : r2(cap),
    band: s.capacity.band ? [r2(s.capacity.band[0]), r2(s.capacity.band[1])] : null,
    limit: s.capacity.limit === 'cpu' ? 'CPU' : s.capacity.limit === 'concurrency' ? `${s.capacity.servers} at a time (lock / pool)` : 'none seen',
    replicas: s.replicas,
    historyPeakUtil: peak === undefined ? null : r2(peak),
    basis,
    cost: s.hostedBy ? `runs inside ${s.hostedBy}, billed with it` : s.cost.source === 'bill' ? `$${s.cost.perReplicaHour.toFixed(4)}/replica-hour from the bill` : s.cost.source === 'pricing' ? `$${s.cost.perReplicaHour.toFixed(4)}/replica-hour at list price` : 'no price',
    notes: s.fit.notes,
  };
}

function summary(m: Model, cal: Calibration, warnings: string[]) {
  const trusted = cal.services.filter((s) => (s.fit === 'good' || s.fit === 'fair') && s.basis !== 'extrapolated').map((s) => s.service);
  const caution = cal.services.filter((s) => (s.fit === 'good' || s.fit === 'fair') && s.basis === 'extrapolated').map((s) => `${s.service}: capacity extrapolated (history peaked at ${pct(s.historyPeakUtil ?? 0)} of it)`);
  const untrusted = cal.services.filter((s) => s.fit === 'poor' || s.fit === 'unexplained').map((s) => `${s.service}: fit ${s.fit} — ${s.notes[0] ?? ''}`);
  const costOnly = cal.services.filter((s) => s.fit === 'cost-only').map((s) => s.service);
  return {
    model: m.name,
    fittedOn: cal.fittedOn,
    slo: m.slo,
    traffic: m.traffic,
    services: cal.services,
    endpoints: Object.values(m.endpoints).map((e) => ({ endpoint: e.id, share: r2(e.share), slo: e.slo, fit: e.fit.status })),
    accuracy: accuracyOf(m),
    trust: { trusted, caution, untrusted, costOnly },
    warnings,
    files: { model: 'model.json', calibration: 'calibration.json' },
    next: 'verify_change',
  };
}

export function accuracyOf(m: Model) {
  return m.accuracy.map((a) => ({
    method: a.method === 'reference' ? 'recorded runs the model never saw' : 'holdout: the last part of the history, held back',
    label: a.label,
    checks: a.checks.map((c) => ({ metric: c.metric, predicted: r2(c.predicted), measured: r2(c.measured), error: pct(c.error), tolerance: pct(c.tolerance), pass: c.pass, note: c.note })),
  }));
}

// ---------------------------------------------------------------------------------------------
// status

export function modelStatus(ws: Workspace) {
  const src = ws.sources();
  const now = Date.now() / 1000;
  // sources.json holds env var names, never credentials: safe to show as is
  const out: Record<string, unknown> = { workspace: ws.dir, sources: src };
  const warnings: string[] = [];
  let next = 'connect_telemetry';
  if (src.prometheus) next = 'collect_telemetry';
  if (ws.has('dataset.json')) {
    const d = ws.readJson<Dataset>('dataset.json');
    const end = d.start + d.n * d.stepS;
    out.dataset = { window: { start: iso(d.start), end: iso(end), hours: r1((d.n * d.stepS) / 3600), stepS: d.stepS }, services: Object.keys(d.services).length, endpoints: Object.keys(d.endpoints).length, bill: !!d.bill, collectedHoursAgo: r1((now - statSync(ws.path('dataset.json')).mtimeMs / 1000) / 3600) };
    if (now - end > 7 * 86400) warnings.push(`the history ends ${Math.round((now - end) / 86400)} days ago: collect again before trusting it for today's traffic`);
    next = 'calibrate_model';
  }
  if (ws.has('model.json')) {
    const m = reviveModel(ws.readJson<Model>('model.json'));
    const cal = ws.has('calibration.json') ? ws.readJson<Calibration>('calibration.json') : null;
    out.model = cal ? summary(m, cal, []) : { model: m.name, accuracy: accuracyOf(m) };
    next = 'verify_change';
    const misses = m.accuracy.flatMap((a) => a.checks).filter((c) => !c.pass && c.metric !== 'errors');
    if (!m.accuracy.length) warnings.push('accuracy not measured: calibrate_model with holdout > 0 on a longer history');
    if (misses.length) warnings.push(`the model missed ${misses.map((c) => c.metric).join(', ')} on data it never saw — treat those numbers as rough`);
  }
  if (existsSync(ws.path('reports'))) out.reports = readdirSync(ws.path('reports')).sort().slice(-10);
  return { ...out, warnings, next };
}

// ---------------------------------------------------------------------------------------------
// verify a change

export type ChangeInput =
  | { strategy: unknown }
  | { kubernetes: { base: string; head: string } }
  | { terraformPlan: string | Record<string, unknown> }
  | { cluster: { head: string; snapshot?: string } };

const readYamlTexts = (p: string): string[] => {
  if (/^\s*(apiVersion|kind|---)/m.test(p) && p.includes('\n')) return [p];
  if (!existsSync(p)) throw new Error(`${p}: no such file or directory`);
  if (!statSync(p).isDirectory()) return [readFileSync(p, 'utf8')];
  return readdirSync(p).flatMap((f) => (statSync(join(p, f)).isDirectory() ? readYamlTexts(join(p, f)) : /\.(ya?ml|json)$/.test(f) ? [readFileSync(join(p, f), 'utf8')] : []));
};

export function strategiesFrom(ws: Workspace, inputs: ChangeInput[], m: Model): { strategies: StrategySpec[]; notes: string[] } {
  const known = new Set(Object.keys(m.services));
  const strategies: StrategySpec[] = [];
  const notes: string[] = [];
  for (const c of inputs) {
    if ('strategy' in c) {
      const s = StrategySpec.parse(typeof c.strategy === 'string' ? parseYaml(c.strategy) : c.strategy);
      for (const ch of s.changes) if ('service' in ch && !known.has(ch.service)) throw new Error(`strategy "${s.name}": no service "${ch.service}" in the model (services: ${[...known].join(', ')})`);
      strategies.push(s);
    } else if ('kubernetes' in c) {
      const r = strategyFromDiff(readWorkloads(readYamlTexts(c.kubernetes.base)), readWorkloads(readYamlTexts(c.kubernetes.head)), { known });
      notes.push(...r.ignored.map((x) => `kubernetes diff: ${x}`));
      if (r.strategy) strategies.push(r.strategy);
      else notes.push('kubernetes diff: nothing the model can backtest changed (replicas, CPU/memory limits, HPAs, arch)');
    } else if ('terraformPlan' in c) {
      const plan = typeof c.terraformPlan === 'string' ? JSON.parse(readFileSync(c.terraformPlan, 'utf8')) : c.terraformPlan;
      const r = strategyFromTerraformPlan(plan, { known });
      notes.push(...r.mapped.map((x) => `terraform: ${x}`), ...r.ignored.map((x) => `terraform: ${x}`));
      if (r.strategy) strategies.push(r.strategy);
      else notes.push('terraform plan: nothing the model can backtest changed');
    } else if ('cluster' in c) {
      const snap = c.cluster.snapshot ?? latestSnapshot(ws);
      const base = JSON.parse(readFileSync(snap, 'utf8')) as unknown;
      const r = strategyFromDiff(readWorkloads([JSON.stringify(base)]), readWorkloads(readYamlTexts(c.cluster.head)), { known });
      notes.push(`compared with the live cluster snapshot ${snap}`, ...r.ignored.map((x) => `cluster diff: ${x}`));
      if (r.strategy) strategies.push(r.strategy);
      else notes.push('cluster diff: nothing the model can backtest changed');
    }
  }
  return { strategies, notes };
}

function latestSnapshot(ws: Workspace): string {
  const dir = ws.path('cluster');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
  if (!files.length) throw new Error('no cluster snapshot: call read_cluster first');
  return join(dir, files[files.length - 1]);
}

export interface VerifyOptions {
  last?: string;
  /** minutes out of SLO a change may add before it fails (default 0.5) */
  gateMinutes?: number;
  draws?: number;
  report?: boolean;
}

/**
 * Capacity draws that fit a time budget: one replay of this history is timed, and the backtest of
 * `plans` plans gets as many draws as fit in ~40 s (at least 3, at most what was asked). A
 * fortnight of 1-minute buckets replays in seconds, so 30 draws of five plans would take minutes;
 * fewer draws make the 10–90% bands coarser, not the medians wrong.
 */
export function drawsFor(m: Model, d: Dataset, plans: number, requested = 30, budgetMs = 40_000): { draws: number; note?: string } {
  const t0 = performance.now();
  runPlan(basePlan(m, observedReplicas(d, m)), trafficOf(d, m));
  const one = Math.max(1, performance.now() - t0);
  const fit = Math.floor(budgetMs / (plans * one));
  const draws = Math.max(3, Math.min(requested, fit));
  return draws < requested ? { draws, note: `${draws} capacity draws instead of ${requested}: one replay of this ${d.n}-bucket history takes ${Math.round(one)} ms, so the bands are coarser (the medians are not affected). Pass draws to override, or last to shorten the history` } : { draws };
}

export function verifyChange(ws: Workspace, inputs: ChangeInput[], o: VerifyOptions = {}) {
  const m = reviveModel(ws.readJson<Model>('model.json'));
  let d = ws.readJson<Dataset>('dataset.json');
  if (o.last) {
    const buckets = Math.ceil(seconds(o.last) / d.stepS);
    if (buckets < d.n) d = { ...d, ...sliceLast(d, buckets) };
  }
  const cal = ws.has('calibration.json') ? ws.readJson<Calibration>('calibration.json') : null;
  const { strategies, notes } = strategiesFrom(ws, inputs, m);
  if (!strategies.length) return { verdict: 'nothing to verify', notes, results: [] };
  const gate = o.gateMinutes ?? 0.5;
  const budget = o.draws ? { draws: o.draws } : drawsFor(m, d, strategies.length + 1);
  if (budget.note) notes.push(budget.note);
  const r = backtest(m, d, strategies, { draws: budget.draws });
  const base = basePlan(m);
  const before = modelBreakingPoint(m, base);
  const results = r.strategies.map((s, i) => judge(m, r, s, strategies[i], cal, gate, before, modelBreakingPoint(m, applyStrategy(m, base, strategies[i]).plan)));

  let reports: { html: string; markdown: string; bundle: string } | undefined;
  if (o.report !== false) {
    ws.ensure('reports');
    const slug = `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${strategies[0].name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`;
    reports = { html: join(ws.path('reports'), `${slug}.html`), markdown: join(ws.path('reports'), `${slug}.md`), bundle: join(ws.path('reports'), `${slug}.bottleneck.json`) };
    writeFileSync(reports.html, backtestHtml(r, m));
    writeFileSync(reports.markdown, backtestMarkdown(r, m));
    writeFileSync(join(ws.path('reports'), `${slug}.strategies.yaml`), strategies.map((s) => toYaml(s)).join('---\n'));
    // the app's workspace bundle: the same history, model and strategies, to open on the backtest screen
    writeFileSync(reports.bundle, JSON.stringify({ name: m.name, source: `verified by an agent, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, dataset: d, model: m, strategies: strategies.map((s) => toYaml(s)) }));
  }
  const worst = results.some((x) => x.verdict === 'fail') ? 'fail' : results.some((x) => x.verdict === 'inconclusive') ? 'inconclusive' : 'pass';
  return {
    verdict: worst,
    model: { name: m.name, fittedOn: { start: iso(m.fittedOn.start), end: iso(m.fittedOn.end) }, ageDays: r1((Date.now() / 1000 - m.fittedOn.end) / 86400), accuracy: accuracyOf(m) },
    window: { start: iso(r.window.start), end: iso(r.window.end), hours: r1((r.window.end - r.window.start) / 3600) },
    slo: r.slo,
    gate: `fails if it adds more than ${gate} min out of SLO over the window`,
    asBuilt: { monthly: r2(r.baseline.summary.monthly.p50), minutesOutOfSlo: r1(r.baseline.summary.minutesOutOfSlo.p50), failedRequests: Math.round(r.baseline.summary.failedRequests.p50) },
    results,
    ranking: r.ranking,
    notes,
    reports,
  };
}

export function sliceLast(d: Dataset, buckets: number): Partial<Dataset> {
  const k = d.n - buckets;
  const cut = <T>(a: T[] | undefined) => (a ? a.slice(k) : a);
  const services = Object.fromEntries(Object.entries(d.services).map(([id, s]) => [id, Object.fromEntries(Object.entries(s).map(([mm, v]) => [mm, Array.isArray(v) ? cut(v) : v]))]));
  const endpoints = Object.fromEntries(Object.entries(d.endpoints).map(([id, s]) => [id, Object.fromEntries(Object.entries(s).map(([mm, v]) => [mm, Array.isArray(v) ? cut(v) : v]))]));
  return { start: d.start + k * d.stepS, n: buckets, services: services as Dataset['services'], endpoints: endpoints as Dataset['endpoints'] };
}

export function judge(m: Model, r: BacktestResult, s: StrategyResult, spec: StrategySpec, cal: Calibration | null, gate: number, before: { rps: number; limitedBy: string | null }, after: { rps: number; limitedBy: string | null }) {
  const dm = s.delta.minutesOutOfSlo;
  const touched = new Set(spec.changes.flatMap((c) => ('service' in c ? [c.service] : [])));
  const histPeak = cal?.historyPeakUtil ?? r.baseline.peakUtil;
  const costBasis = new Set([...touched].map((id) => m.services[id]?.cost.source ?? 'none'));

  // ---- how far to trust it
  const services = Object.entries(s.peakUtil)
    .filter(([id]) => m.services[id] && isFinite(m.services[id].capacity.perReplicaRps))
    .map(([id, pp]) => {
      const hp = histPeak[id] ?? 0;
      const host = m.services[id].hostedBy;
      const relevant = touched.has(id) || (!!host && touched.has(host)) || pp > 0.6 || pp > Math.max(hp, 0.2) * 1.25;
      const basis = pp <= Math.max(hp, 0.3) * 1.1 ? 'within what the history showed' : hp >= LIMIT_SEEN || m.services[id].capacity.overloadedRps ? 'near a limit the history reached' : 'beyond anything the history showed';
      return { service: id, touched: touched.has(id) || (!!host && touched.has(host)), fit: m.services[id].fit.status, historyPeakUtil: r2(hp), predictedPeakUtil: r2(pp), basis, relevant };
    })
    .filter((x) => x.relevant)
    .map(({ relevant: _r, ...x }) => x);
  const warnings: string[] = [];
  // an object, so the narrowing of a plain `let` doesn't survive the closure
  const conf: { level: 'high' | 'medium' | 'low' } = { level: 'high' };
  const lower = (to: 'medium' | 'low', why: string) => {
    warnings.push(why);
    if (to === 'low' || conf.level === 'high') conf.level = to;
  };
  for (const x of services) {
    const harder = x.predictedPeakUtil > Math.max(x.historyPeakUtil, 0.3) * 1.1;
    // a poorly fitted service the change neither touches nor pushes harder carries the same error on
    // both sides of the comparison: it blurs the absolute numbers more than the difference
    if ((x.fit === 'poor' || x.fit === 'unexplained') && (x.touched || harder)) lower('low', `${x.service}: the model fits it ${x.fit === 'poor' ? 'poorly' : 'not at all'}, and this change ${x.touched ? 'changes it' : 'pushes it harder than the history did'}`);
    else if ((x.fit === 'poor' || x.fit === 'unexplained') && x.predictedPeakUtil > 0.6) lower('medium', `${x.service} fits ${x.fit === 'poor' ? 'poorly' : 'not at all'} and runs near its limit; the change leaves it as it was, so the comparison holds better than the absolute numbers`);
    else if (x.basis === 'beyond anything the history showed' && x.predictedPeakUtil >= 0.8) lower('low', `${x.service} would run at ${pct(x.predictedPeakUtil)} of a capacity the history never tested (peak ${pct(x.historyPeakUtil)}): the outcome rests on an extrapolated limit`);
    else if (x.basis === 'beyond anything the history showed') lower('medium', `${x.service} would run at ${pct(x.predictedPeakUtil)} of capacity, past the history's ${pct(x.historyPeakUtil)}: its capacity there is extrapolated`);
    else if (x.fit === 'fair' && x.touched) lower('medium', `${x.service}: fair fit (latency reproduced within 30%)`);
  }
  const misses = m.accuracy.flatMap((a) => a.checks.map((c) => ({ ...c, method: a.method }))).filter((c) => !c.pass && c.metric !== 'errors');
  if (misses.length) lower('medium', `the model missed ${misses.map((c) => `${c.metric} (${c.method}, off by ${pct(c.error)})`).join(', ')} on data it never saw`);
  if (!m.accuracy.length) lower('medium', 'the model\'s accuracy was never measured');
  const hours = (r.window.end - r.window.start) / 3600;
  if (hours < 24) lower('medium', `only ${r1(hours)} h of history: daily and weekly peaks may be missing`);
  if (costBasis.has('none') && Math.abs(s.delta.monthly.p50) < 0.005) warnings.push('the changed services have no price (no bill, no CPU limit): the cost delta reads $0');
  if (costBasis.has('pricing')) warnings.push('costs are AWS Fargate list prices, not your bill: discounts and Savings Plans are not in them');

  const level = conf.level;
  // ---- verdict
  let verdict: 'pass' | 'fail' | 'inconclusive' = dm.p50 > gate ? 'fail' : dm.hi > gate || level === 'low' ? 'inconclusive' : 'pass';
  const reasons: string[] = [headline(s, r.baseline)];
  if (dm.p50 > gate) reasons.push(`adds ${r1(dm.p50)} min out of SLO (10–90%: ${r1(dm.lo)} … ${r1(dm.hi)})`);
  else if (dm.hi > gate) reasons.push(`no added time out of SLO at the median, but ${r1(dm.hi)} min in the worst 10% of capacity draws`);
  if (verdict === 'inconclusive' && level === 'low' && dm.hi <= gate) reasons.push(`the backtest passes, but confidence is low (${warnings[0]}) — load-test before trusting it`);
  // the SLO minutes can stay put while failures move a lot (the same minutes are out of SLO for
  // another reason): say what happened to the failed requests
  const fb = r.baseline.summary.failedRequests.p50;
  const fd = s.delta.failedRequests.p50;
  if (fb > 0 && Math.abs(fd) > 0.1 * fb) reasons.push(`${fd < 0 ? 'cuts' : 'adds'} ${Math.round(Math.abs(fd)).toLocaleString('en-US')} failed requests (${fd < 0 ? '−' : '+'}${Math.round((Math.abs(fd) / fb) * 100)}% of ${Math.round(fb).toLocaleString('en-US')})${Math.abs(dm.p50) <= 0.5 ? ', though the minutes out of SLO stay the same: something else breaks the SLO in those minutes' : ''}`);
  if (s.worst.service && s.summary.peakP99Ms.p50 > r.slo.p99Ms) reasons.push(`worst at ${iso(s.worst.t)}: ${s.worst.why}`);
  const worse = Object.entries(s.endpoints)
    .filter(([id, e]) => e.minutesOutOfSlo > (r.baseline.endpoints[id]?.minutesOutOfSlo ?? 0) + gate)
    .map(([id, e]) => ({ endpoint: id, minutesOutOfSlo: r1(e.minutesOutOfSlo), asBuilt: r1(r.baseline.endpoints[id]?.minutesOutOfSlo ?? 0), slo: e.slo }));
  if (worse.length) reasons.push(`worse for ${worse.map((w) => w.endpoint).join(', ')} against their own SLOs`);
  if (after.rps < before.rps * 0.9) reasons.push(`headroom drops from ${r1(before.rps)} to ${r1(after.rps)} req/s${m.traffic ? ` (the history peaked at ${r1(m.traffic.peak)})` : ''}`);
  // the change itself cuts headroom below traffic the system has already seen
  if (after.rps < before.rps * 0.9 && after.rps < (m.traffic?.peak ?? 0) && verdict === 'pass') {
    verdict = 'inconclusive';
    reasons.push(`after the change the system sustains ${r1(after.rps)} req/s, below the history's peak of ${r1(m.traffic!.peak)}`);
  }

  return {
    name: s.name,
    verdict,
    summary: headline(s, r.baseline),
    reasons,
    change: spec,
    cost: { monthlyDelta: range(s.delta.monthly), monthly: r2(s.summary.monthly.p50), basis: [...costBasis].map((b) => (b === 'bill' ? 'your bill' : b === 'pricing' ? 'list price' : 'unpriced')).join(', ') || 'unchanged services' },
    reliability: {
      minutesOutOfSloDelta: range(dm, r1),
      minutesOutOfSlo: r1(s.summary.minutesOutOfSlo.p50),
      failedRequestsDelta: range(s.delta.failedRequests, Math.round),
      errorBudgetUsed: { asBuilt: pct(r.baseline.summary.errorBudgetUsed.p50), after: pct(s.summary.errorBudgetUsed.p50) },
      peakP99Ms: Math.round(s.summary.peakP99Ms.p50),
      worst: { at: iso(s.worst.t), p99Ms: Math.round(s.worst.p99Ms), errorRate: r2(s.worst.errorRate), why: s.worst.why },
      incidents: s.incidents.slice(0, 5).map((x) => ({ start: iso(x.start), minutes: r1(x.minutes), peakP99Ms: Math.round(x.peakP99Ms), why: x.why })),
      endpointsWorse: worse,
    },
    headroom: { beforeRps: r1(before.rps), afterRps: r1(after.rps), limitedBy: after.limitedBy, historyPeakRps: m.traffic ? r1(m.traffic.peak) : null },
    confidence: { level, services, warnings },
    notes: s.notes,
    howToRead: `${money(s.delta.monthly.p50)}/month; ${verdict === 'pass' ? 'safe on this history' : verdict === 'fail' ? 'would have broken the SLO' : 'not proven either way'}; confidence ${level}`,
  };
}

// ---------------------------------------------------------------------------------------------
// verify a design (no history needed)

export function verifyDesign(spec: unknown, o: { rps?: number; slo?: { maxP99Ms?: number; maxErrorRate?: number }; budgetMonthly?: number; incidentCostPerMinute?: number } = {}) {
  const input = typeof spec === 'string' ? parseYaml(spec) : spec;
  const v = validateSpec(input);
  const errors = v.issues.filter((i) => i.level === 'error');
  if (!v.ok || errors.length) return { verdict: 'fail', problems: v.issues.map((i) => `${i.level}: ${i.message}`), findings: [], next: 'fix the spec and call verify_design again' };
  const a: AuditResult = audit(input, { rps: o.rps, slo: o.slo, incidentCostPerMinute: o.incidentCostPerMinute });
  const problems: string[] = v.issues.map((i) => `${i.level}: ${i.message}`);
  if (!a.baseline.meetsSlo) problems.push(`at ${a.load.rps} req/s it already misses the SLO: ${(a.baseline.errorRate * 100).toFixed(2)}% errors, p99 ${Math.round(a.baseline.p99Ms)} ms`);
  if (o.budgetMonthly !== undefined && a.baseline.monthly > o.budgetMonthly) problems.push(`costs $${a.baseline.monthly.toLocaleString()}/month, over the $${o.budgetMonthly.toLocaleString()} budget`);
  if (o.rps && a.headroom.maxRps < o.rps * 1.5) problems.push(`headroom only ${a.headroom.ratio.toFixed(1)}× (${Math.round(a.headroom.maxRps)} req/s, then ${a.headroom.limitedBy ?? 'nothing'})`);
  const critical = a.findings.filter((f) => f.severity === 'critical');
  const verdict = !a.baseline.meetsSlo || critical.length || (o.budgetMonthly !== undefined && a.baseline.monthly > o.budgetMonthly) ? 'fail' : a.findings.some((f) => f.severity === 'major') || problems.length ? 'pass with risks' : 'pass';
  return {
    verdict,
    architecture: a.architecture,
    load: a.load,
    slo: a.slo,
    monthly: a.baseline.monthly,
    headroom: { maxRps: Math.round(a.headroom.maxRps), ratio: r1(a.headroom.ratio), limitedBy: a.headroom.limitedBy },
    resilience: { score: a.score, survived: `${a.survived} of ${a.total} incidents within SLO` },
    problems,
    findings: a.findings
      .filter((f) => f.severity !== 'ok')
      .map((f) => ({
        severity: f.severity,
        incident: f.title,
        target: f.target,
        explanation: f.explanation,
        impact: { errorRate: r2(f.impact.errorRate), peakP99Ms: Math.round(f.impact.peakP99Ms), secondsOutOfSlo: f.impact.breachS, recoveryS: f.impact.recoveryS, blastRadius: f.blastRadius },
        fixes: f.fixes.map((x) => ({ title: x.title, why: x.why, monthlyDelta: x.monthlyDelta, after: x.after.severity, changes: x.changes })),
      })),
    caveat: 'A design without production history is checked against catalogue defaults: capacities and prices are typical values, not measured ones. Calibrate on telemetry (collect_telemetry → calibrate_model) for real numbers.',
    link: `${APP_URL}/#spec=${encodePayload(v.spec)}`,
    next: critical.length ? 'apply the fixes (each lists its spec changes) and call verify_design again' : 'done, or open the link for a human to inspect',
  };
}
