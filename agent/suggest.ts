import type { Dataset } from '../src/backtest/dataset';
import { modelBreakingPoint } from '../src/backtest/accuracy';
import { backtest } from '../src/backtest/backtest';
import { basePlan } from '../src/backtest/engine';
import { applyStrategy, type StrategySpec } from '../src/backtest/strategy';
import { reviveModel, type Model } from '../src/backtest/model';
import { drawsFor, judge, sliceLast, type Calibration } from './verify';
import { seconds, type Workspace } from './workspace';

/**
 * "What should we change?" Candidates come from the history itself: the services that ran out of
 * capacity get fixes (more replicas — of the host, for an in-process dependency —, more CPU or
 * CPU autoscaling when CPU is what limits them); the services that idled get savings (fewer
 * replicas, smaller CPU, Graviton). Every candidate is backtested and judged like verify_change,
 * and the savings that pass are tried together, because two safe cuts can be unsafe at once.
 */

export interface SuggestOptions {
  goal?: 'reliability' | 'cost' | 'both';
  last?: string;
  draws?: number;
  gateMinutes?: number;
  /** below this share of capacity at its busiest, a service counts as idle (default 0.35) */
  idleBelow?: number;
}

const SATURATED = 0.85;
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

export async function suggestChanges(ws: Workspace, o: SuggestOptions = {}, progress?: (m: string, d: number, t: number) => Promise<void>) {
  const say = async (m: string, k: number) => {
    if (!progress) return;
    await progress(m, k, 3);
    await new Promise((r) => setImmediate(r));
  };
  const m = reviveModel(ws.readJson<Model>('model.json'));
  let d = ws.readJson<Dataset>('dataset.json');
  if (o.last) {
    const k = Math.ceil(seconds(o.last) / d.stepS);
    if (k < d.n) d = { ...d, ...sliceLast(d, k) };
  }
  const cal = ws.has('calibration.json') ? ws.readJson<Calibration>('calibration.json') : null;
  const goal = o.goal ?? 'both';
  const idle = o.idleBelow ?? 0.35;
  const asBuilt = backtest(m, d, [], { draws: 1 }).baseline;
  const peak = asBuilt.peakUtil;

  const fixes: StrategySpec[] = [];
  const savings: StrategySpec[] = [];
  const seen = new Set<string>();
  const add = (list: StrategySpec[], s: StrategySpec) => {
    const key = JSON.stringify(s.changes);
    if (seen.has(key)) return;
    seen.add(key);
    list.push(s);
  };
  const saturated = Object.entries(peak).filter(([id, u]) => u >= SATURATED && m.services[id] && isFinite(m.services[id].capacity.perReplicaRps));
  if (goal !== 'cost')
    for (const [id] of saturated) {
      const s = m.services[id];
      const host = s.hostedBy ?? id;
      const h = m.services[host];
      if (!h || h.kind === 'external') continue;
      const via = s.hostedBy ? ` (${id} runs inside ${host})` : '';
      const r = Math.max(1, Math.round(h.replicas));
      add(fixes, { name: `${host}: ${r} → ${r + 1} replicas${via}`, changes: [{ service: host, replicas: r + 1 }] });
      if (r >= 2) add(fixes, { name: `${host}: ${r} → ${r * 2} replicas${via}`, changes: [{ service: host, replicas: r * 2 }] });
      if (s.capacity.limit === 'cpu' && h.cpuLimit) {
        add(fixes, { name: `${host}: CPU ${h.cpuLimit} → ${r2(h.cpuLimit * 2)} per replica`, changes: [{ service: host, cpu: r2(h.cpuLimit * 2) }] });
        add(fixes, { name: `${host}: autoscale ${r}–${Math.max(r * 3, r + 2)} on 60% CPU`, changes: [{ service: host, autoscale: { min: r, max: Math.max(r * 3, r + 2), targetCpu: 0.6 } }] });
      }
    }
  if (goal !== 'reliability')
    for (const [id, s] of Object.entries(m.services)) {
      if (s.hostedBy || s.kind === 'external' || s.cost.perReplicaHour <= 0 || s.fit.status === 'cost-only') continue;
      // a host is only idle if what runs inside it is too
      const inside = Object.values(m.services).filter((x) => x.hostedBy === id).map((x) => peak[x.id] ?? 0);
      const busiest = Math.max(peak[id] ?? 0, ...inside);
      if (busiest >= idle) continue;
      const r = Math.max(1, Math.round(s.replicas));
      if (r >= 2) add(savings, { name: `${id}: ${r} → ${r - 1} replicas`, changes: [{ service: id, replicas: r - 1 }] });
      if (s.cpuLimit && s.cpuLimit >= 0.5 && s.capacity.limit !== 'concurrency') add(savings, { name: `${id}: CPU ${s.cpuLimit} → ${r2(s.cpuLimit / 2)} per replica`, changes: [{ service: id, cpu: r2(s.cpuLimit / 2) }] });
      if (s.cost.arch !== 'arm') add(savings, { name: `${id} on Graviton`, changes: [{ service: id, arch: 'arm' }] });
    }

  const gate = o.gateMinutes ?? 0.5;
  const base = basePlan(m);
  const before = modelBreakingPoint(m, base);
  const notes: string[] = [];
  const evaluate = (list: StrategySpec[]) => {
    if (!list.length) return [];
    const budget = o.draws ? { draws: o.draws } : drawsFor(m, d, list.length + 1, 12, 25_000);
    if (budget.note && !notes.includes(budget.note)) notes.push(budget.note);
    const r = backtest(m, d, list, { draws: budget.draws });
    return r.strategies.map((s, i) => {
      const j = judge(m, r, s, list[i], cal, gate, before, modelBreakingPoint(m, applyStrategy(m, base, list[i]).plan));
      return {
        name: j.name,
        change: list[i],
        verdict: j.verdict,
        confidence: j.confidence.level,
        monthlyDelta: j.cost.monthlyDelta.p50,
        costBasis: j.cost.basis,
        minutesOutOfSloDelta: j.reliability.minutesOutOfSloDelta.p50,
        failedRequestsDelta: j.reliability.failedRequestsDelta.p50,
        summary: j.summary,
        caveats: j.confidence.warnings.slice(0, 2),
      };
    });
  };
  await say(`backtesting ${fixes.length} fixes`, 0);
  const fixResults = evaluate(fixes);
  await say(`backtesting ${savings.length} savings`, 1);
  const saveResults = evaluate(savings);
  await say('trying the safe savings together', 2);

  // the savings that pass, together
  const safe = saveResults.filter((s) => s.verdict === 'pass' && s.monthlyDelta < 0);
  let combined: ReturnType<typeof evaluate>[number] | null = null;
  if (safe.length >= 2) {
    const byService = new Map<string, Record<string, unknown>>();
    // one change per service: the biggest saving wins if two touch the same service, plus arch
    for (const s of [...safe].sort((a, b) => a.monthlyDelta - b.monthlyDelta))
      for (const ch of s.change.changes as Record<string, unknown>[]) {
        const cur = byService.get(String(ch.service)) ?? { service: ch.service };
        for (const [k, v] of Object.entries(ch)) if (k !== 'service' && !(k in cur)) cur[k] = v;
        byService.set(String(ch.service), cur);
      }
    combined = evaluate([{ name: `All safe savings together (${safe.length})`, changes: [...byService.values()] as StrategySpec['changes'] }])[0];
  }

  const minutes = asBuilt.summary.minutesOutOfSlo.p50;
  // a fix helps when it cuts time out of SLO, or failed requests by a tenth: an SLO broken by
  // something else in the same minutes (errors unrelated to capacity) can hide a real improvement
  const failedBase = asBuilt.summary.failedRequests.p50;
  const helps = (f: (typeof fixResults)[number]) => f.minutesOutOfSloDelta < -0.5 || (failedBase > 0 && f.failedRequestsDelta < -0.1 * failedBase);
  const helpful = fixResults.filter(helps).sort((a, b) => a.minutesOutOfSloDelta - b.minutesOutOfSloDelta || a.failedRequestsDelta - b.failedRequestsDelta || a.monthlyDelta - b.monthlyDelta);
  return {
    asBuilt: { minutesOutOfSlo: r1(minutes), monthly: r2(asBuilt.summary.monthly.p50), failedRequests: Math.round(asBuilt.summary.failedRequests.p50) },
    saturated: saturated.map(([id, u]) => ({ service: id, historyPeakUtil: r2(u), limit: m.services[id].capacity.limit, hostedBy: m.services[id].hostedBy ?? null })),
    fixes: helpful,
    savings: saveResults.filter((s) => s.verdict === 'pass' && s.monthlyDelta < 0).sort((a, b) => a.monthlyDelta - b.monthlyDelta),
    combinedSavings: combined,
    rejected: [...fixResults.filter((f) => !helpful.includes(f)), ...saveResults.filter((s) => !(s.verdict === 'pass' && s.monthlyDelta < 0))].map((x) => ({ name: x.name, verdict: x.verdict, summary: x.summary })),
    notes: [
      ...notes,
      minutes < 0.5 && goal !== 'cost' ? 'the system stayed within its SLO over this history: there was nothing to fix' : null,
      !saturated.length && goal !== 'cost' ? 'no service came near its capacity in this history' : null,
      'candidates are generated from the history (saturated services get capacity, idle ones get cuts); verify_change anything else you have in mind',
    ].filter(Boolean),
    next: 'verify_change the one you would ship, for its full evidence and the app link',
  };
}
