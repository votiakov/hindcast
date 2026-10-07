import { KINDS, RUNTIME_KINDS, RUNTIMES, type Runtime, type Tier } from './catalog';
import { simulate } from './headless';
import { analyze, type Analysis } from './des/analyze';
import { withPricing } from './pricing';
import { ArchitectureSpec, type ChangeSpec, type ComponentSpec } from '../spec/schema';

/**
 * Cost optimizer: find the cheapest configuration of the *existing* topology that meets the SLO.
 *
 * Knobs: instance counts, size tiers and (optionally) language runtimes. Topology is never
 * changed — adding a cache or a queue is a design decision for a human (or an AI) to propose
 * as a variant; the optimizer then sizes it.
 *
 *  1. grow   — while the SLO is missed, apply the move with the best SLO gain per extra $/h
 *  2. shrink — remove capacity anywhere it is not needed (this is where over-provisioned
 *              systems get cheaper)
 *  3. verify — Monte Carlo with the discrete-event engine
 */

export interface OptimizeOptions {
  slo?: { maxErrorRate?: number; maxP99Ms?: number };
  allowRuntimes?: boolean;
  maxInstances?: number;
  /** DES runs used to verify the result (0 = skip) */
  verifyRuns?: number;
  maxIterations?: number;
}

export interface OptimizeResult {
  feasible: boolean;
  before: { costPerHour: number; monthly: number; sloCompliance: number };
  after: { costPerHour: number; monthly: number; sloCompliance: number };
  monthlySavings: number;
  changes: ChangeSpec[];
  spec: ArchitectureSpec;
  log: string[];
  verification: Analysis | null;
  evaluations: number;
}

const TIER_ORDER: Tier[] = ['S', 'M', 'L'];

interface Eval {
  ok: boolean;
  compliance: number;
  err: number;
  p99: number;
  cost: number;
  hot: string[];
}

export function optimize(specInput: unknown, scenario: Record<string, unknown>, opts: OptimizeOptions = {}): OptimizeResult {
  const parsed = ArchitectureSpec.parse(specInput);
  return withPricing(parsed.pricing, () => optimizeParsed(parsed, scenario, opts));
}

function optimizeParsed(base: ArchitectureSpec, scenario: Record<string, unknown>, opts: OptimizeOptions): OptimizeResult {
  const slo = { maxErrorRate: opts.slo?.maxErrorRate ?? 0.01, maxP99Ms: opts.slo?.maxP99Ms ?? 300 };
  const sc = { ...scenario, slo };
  const maxInst = opts.maxInstances ?? 64;
  const log: string[] = [];
  let evaluations = 0;

  const evaluate = (s: ArchitectureSpec): Eval => {
    evaluations++;
    const r = simulate(s, sc, { sampleEvery: 1 });
    return {
      ok: r.summary.sloCompliance >= 0.99,
      compliance: r.summary.sloCompliance,
      err: r.summary.meanErrorRate,
      p99: r.summary.meanP99Ms,
      cost: r.summary.meanCostPerHour,
      hot: Object.entries(r.components)
        .filter(([, c]) => c.peakUtil >= 0.6 || c.droppedTotal > 0 || c.finalStatus === 'down')
        .sort((a, b) => b[1].peakUtil - a[1].peakUtil)
        .map(([id]) => id),
    };
  };
  const quality = (e: Eval) => e.compliance * 1000 - e.err * 100 - Math.min(e.p99, 10_000) / 1000;

  type Move = { label: string; apply: (c: ComponentSpec) => boolean };
  const growMoves = (c: ComponentSpec): Move[] => {
    const m: Move[] = [];
    const spec = KINDS[c.kind];
    if (spec.scalable)
      m.push({
        label: 'instances+',
        apply: (x) => {
          const n = x.instances ?? 1;
          if (n >= maxInst) return false;
          x.instances = Math.min(maxInst, n + Math.max(1, Math.round(n * 0.15)));
          return true;
        },
      });
    if (spec.tiered)
      m.push({
        label: 'tier up',
        apply: (x) => {
          const i = TIER_ORDER.indexOf(x.tier ?? 'S');
          if (i >= TIER_ORDER.length - 1) return false;
          x.tier = TIER_ORDER[i + 1];
          return true;
        },
      });
    if (opts.allowRuntimes && RUNTIME_KINDS.includes(c.kind))
      for (const r of Object.keys(RUNTIMES) as Runtime[])
        m.push({
          label: `runtime ${r}`,
          apply: (x) => {
            const cur = RUNTIMES[x.runtime ?? 'node'].throughput;
            if (RUNTIMES[r].throughput <= cur) return false;
            x.runtime = r;
            return true;
          },
        });
    return m;
  };
  const shrinkMoves = (c: ComponentSpec): Move[] => {
    const m: Move[] = [];
    if (KINDS[c.kind].scalable && (c.instances ?? 1) > 1) m.push({ label: 'instances−1', apply: (x) => ((x.instances = (x.instances ?? 1) - 1), true) });
    if (KINDS[c.kind].tiered && (c.tier ?? 'S') !== 'S') m.push({ label: 'tier down', apply: (x) => ((x.tier = TIER_ORDER[TIER_ORDER.indexOf(x.tier ?? 'S') - 1]), true) });
    return m;
  };
  const tryMove = (s: ArchitectureSpec, id: string, mv: Move): ArchitectureSpec | null => {
    const next: ArchitectureSpec = structuredClone(s);
    const c = next.components.find((x) => x.id === id)!;
    return mv.apply(c) ? next : null;
  };
  const mutable = (s: ArchitectureSpec) => s.components.filter((c) => c.kind !== 'client' && growMoves(c).length);

  const start = evaluate(base);
  let cur = base;
  let curE = start;
  log.push(`start: ${start.ok ? 'meets' : 'misses'} SLO (${Math.round(start.compliance * 100)}% of the time), $${start.cost.toFixed(2)}/h`);

  // ---- grow ----
  for (let it = 0; !curE.ok && it < (opts.maxIterations ?? 60); it++) {
    const focus = curE.hot.length ? cur.components.filter((c) => curE.hot.includes(c.id)) : mutable(cur);
    let best: { s: ArchitectureSpec; e: Eval; label: string; value: number } | null = null;
    for (const c of focus.length ? focus : mutable(cur)) {
      for (const mv of growMoves(c)) {
        const s = tryMove(cur, c.id, mv);
        if (!s) continue;
        const e = evaluate(s);
        const gain = quality(e) - quality(curE);
        if (gain <= 0) continue;
        const value = gain / Math.max(0.005, e.cost - curE.cost);
        if (!best || value > best.value) best = { s, e, label: `${c.id}: ${mv.label}`, value };
      }
    }
    if (!best) {
      log.push('grow: no single change improves the SLO — the topology itself is the limit');
      // the most common structural blocker: instances nobody can reach
      const fed = new Set(cur.connections.map((c) => (Array.isArray(c) ? c : [c.from, c.to])).filter(([a]) => ['lb', 'gateway', 'queue'].includes(cur.components.find((x) => x.id === a)?.kind ?? '')).map(([, b]) => b));
      for (const id of curE.hot) {
        const c = cur.components.find((x) => x.id === id);
        if (c && KINDS[c.kind].scalable && !fed.has(id)) log.push(`hint: put a load balancer in front of "${id}" — without one, extra instances receive no traffic`);
      }
      break;
    }
    cur = best.s;
    curE = best.e;
    log.push(`grow: ${best.label} → ${Math.round(curE.compliance * 100)}% in SLO, $${curE.cost.toFixed(2)}/h`);
  }

  // ---- shrink ----
  if (curE.ok) {
    let improved = true;
    while (improved) {
      improved = false;
      for (const c of cur.components) {
        for (const mv of shrinkMoves(c)) {
          const s = tryMove(cur, c.id, mv);
          if (!s) continue;
          const e = evaluate(s);
          if (e.ok && e.cost < curE.cost - 1e-6) {
            cur = s;
            curE = e;
            improved = true;
            log.push(`shrink: ${c.id}: ${mv.label} → $${curE.cost.toFixed(2)}/h`);
            break;
          }
        }
      }
    }
  }

  // ---- diff ----
  const changes: ChangeSpec[] = [];
  for (const c of cur.components) {
    const o = base.components.find((x) => x.id === c.id)!;
    const fields: Record<string, unknown> = {};
    if ((c.instances ?? 1) !== (o.instances ?? 1)) fields.instances = c.instances;
    if ((c.tier ?? 'S') !== (o.tier ?? 'S')) fields.tier = c.tier;
    if ((c.runtime ?? undefined) !== (o.runtime ?? undefined)) fields.runtime = c.runtime;
    if (Object.keys(fields).length) changes.push({ op: 'set', id: c.id, fields });
  }

  const verification = curE.ok && (opts.verifyRuns ?? 10) > 0 ? analyze(cur, sc, { runs: opts.verifyRuns ?? 10 }) : null;
  if (verification) log.push(`verify (discrete-event, ${verification.runs} runs): SLO met in ${Math.round(verification.pSloMet * 100)}% of runs, p99 ${verification.metrics.p99Ms.mean}±${verification.metrics.p99Ms.ci95}ms`);

  return {
    feasible: curE.ok,
    before: { costPerHour: start.cost, monthly: Math.round(start.cost * 730), sloCompliance: start.compliance },
    after: { costPerHour: curE.cost, monthly: Math.round(curE.cost * 730), sloCompliance: curE.compliance },
    monthlySavings: Math.round((start.cost - curE.cost) * 730),
    changes,
    spec: cur,
    log,
    verification,
    evaluations,
  };
}
