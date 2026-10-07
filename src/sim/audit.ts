import { KINDS, type Kind, type Tier } from './catalog';
import { breakingPoint, loadCurve, simulate, type CurvePoint, type SimResult } from './headless';
import { withPricing } from './pricing';
import { applyVariant, pairs } from '../spec/convert';
import { ArchitectureSpec, type ActionSpec, type ChangeSpec, type ComponentSpec } from '../spec/schema';

/**
 * Failure audit — "what breaks first, and what it costs".
 *
 * Runs the architecture at its expected load, then replays the same minute once per thing that can
 * go wrong in production: every component dying (one instance of a fleet, or the whole thing),
 * every zone going dark, every dependency turning slow or erroring, every cache going cold, a
 * traffic surge — and the load ramp to the breaking point. Each incident is graded by what users
 * would have seen. For the serious ones, candidate fixes are generated, *verified by re-running
 * the same incident*, and priced, so the report reads as a ranked risk register with costed
 * remediations.
 *
 * Incident timeline (simulated seconds): warm up 0–10, fault at 10, fault cleared at 40, observe
 * until 60. Recovery is measured both while the fault is active (self-healing: failover,
 * autoscaling, breakers) and after it is cleared (metastable failures never recover).
 */

export type Severity = 'critical' | 'major' | 'minor' | 'ok';
export type IncidentKind = 'instance' | 'component' | 'zone' | 'slow' | 'errors' | 'cold-cache' | 'surge' | 'headroom';

export interface IncidentImpact {
  /** mean user error rate while the fault is active */
  errorRate: number;
  peakErrorRate: number;
  peakP99Ms: number;
  failedRequests: number;
  /** seconds outside the SLO */
  breachS: number;
  /** seconds from the fault until users are back within SLO without intervention (null = not while the fault lasted) */
  selfHealS: number | null;
  /** seconds from clearing the fault until users are back within SLO (null = never: metastable) */
  recoveryS: number | null;
}

export interface Fix {
  title: string;
  why: string;
  changes: ChangeSpec[];
  /** $/month compared with the current design at expected load */
  monthlyDelta: number;
  after: { severity: Severity; errorRate: number; peakP99Ms: number; failedRequests: number };
}

export interface Finding {
  id: string;
  kind: IncidentKind;
  target: string;
  title: string;
  severity: Severity;
  impact: IncidentImpact;
  /** components that overloaded or went down as a consequence */
  blastRadius: string[];
  explanation: string;
  /** $ lost during the incident at `incidentCostPerMinute` (when given) */
  costAtRisk: number | null;
  fixes: Fix[];
  /** the scenario that reproduces it */
  scenario: Record<string, unknown>;
}

export interface AuditOptions {
  /** expected load; default: half of the breaking point */
  rps?: number;
  readRatio?: number;
  slo?: { maxErrorRate?: number; maxP99Ms?: number };
  /** what a minute of full outage costs the business, for $-at-risk */
  incidentCostPerMinute?: number;
  /** generate and verify fixes (default true) */
  fixes?: boolean;
  /** called as incidents complete */
  onProgress?: (done: number, total: number, label: string) => void;
}

export interface AuditResult {
  architecture: string;
  load: { rps: number; readRatio: number };
  slo: { maxErrorRate: number; maxP99Ms: number };
  baseline: { errorRate: number; p99Ms: number; costPerHour: number; monthly: number; meetsSlo: boolean };
  headroom: { maxRps: number; limitedBy: string | null; note: string | null; ratio: number };
  /** share of incidents that stay within SLO (or heal by themselves quickly), 0–100 */
  score: number;
  survived: number;
  total: number;
  findings: Finding[];
  /** steady-state latency, errors and unit cost from light load to 2× the breaking point */
  curve: CurvePoint[];
  wallMs: number;
}

const FAULT_AT = 10;
const CLEAR_AT = 40;
const END = 60;
const SEV_RANK: Record<Severity, number> = { critical: 3, major: 2, minor: 1, ok: 0 };
const TIERS: Tier[] = ['S', 'M', 'L'];
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function audit(specInput: unknown, opts: AuditOptions = {}): AuditResult {
  const spec = ArchitectureSpec.parse(specInput);
  return withPricing(spec.pricing, () => auditParsed(spec, opts));
}

interface Incident {
  id: string;
  kind: IncidentKind;
  target: string;
  title: string;
  events: { at: number; action: ActionSpec; note?: string }[];
  traffic?: { at: number; rps: number }[];
}

function auditParsed(input: ArchitectureSpec, opts: AuditOptions): AuditResult {
  const t0 = Date.now();
  const slo = { maxErrorRate: opts.slo?.maxErrorRate ?? 0.01, maxP99Ms: opts.slo?.maxP99Ms ?? 300 };
  const readRatio = opts.readRatio ?? 0.8;
  const bp0 = breakingPoint(input, { readRatio, slo });
  const rps = opts.rps ?? Math.max(10, Math.round(bp0.maxRps * 0.5));
  // autoscaled fleets are audited at the size they settle at for this load, not at their minimum
  let spec = input;
  if (input.components.some((c) => c.autoscale)) {
    const warm = simulate(input, { duration: 120, rps, readRatio, slo });
    spec = { ...input, components: input.components.map((c) => (c.autoscale && warm.components[c.id]?.instances ? { ...c, instances: warm.components[c.id].instances } : c)) };
  }
  const bp = spec === input ? bp0 : breakingPoint(spec, { readRatio, slo });
  const byId = new Map(spec.components.map((c) => [c.id, c]));
  const nm = (id: string) => byId.get(id)?.name ?? id;
  const parents = (id: string) => pairs(spec).filter(([, b]) => b === id).map(([a]) => a);
  const children = (id: string) => pairs(spec).filter(([a]) => a === id).map(([, b]) => b);

  const scenarioFor = (inc: Incident) => ({
    name: inc.title,
    duration: END,
    readRatio,
    slo,
    ...(inc.traffic ? { traffic: inc.traffic } : { rps }),
    events: inc.events,
  });
  const run = (s: ArchitectureSpec, inc: Incident) => simulate(s, scenarioFor(inc));

  const base = simulate(spec, { name: 'expected load', duration: 30, rps, readRatio, slo });
  const baseCost = base.summary.meanCostPerHour;
  const tail = base.timeline.slice(-10);
  const baseline = {
    errorRate: r3(avg(tail.map((x) => x.errorRate))),
    p99Ms: Math.round(avg(tail.map((x) => x.p99Ms))),
    costPerHour: r3(baseCost),
    monthly: Math.round(baseCost * 730),
    meetsSlo: avg(tail.map((x) => x.errorRate)) <= slo.maxErrorRate && avg(tail.map((x) => x.p99Ms)) <= slo.maxP99Ms,
  };

  // ---- the incident catalogue ----
  const incidents: Incident[] = [];
  const fault = (action: ActionSpec, restore: ActionSpec) => [
    { at: FAULT_AT, action },
    { at: CLEAR_AT, action: restore },
  ];
  for (const c of spec.components) {
    if (c.kind === 'client') continue;
    const spec_ = KINDS[c.kind as Kind];
    const n = c.instances ?? c.autoscale?.min ?? 1;
    if (spec_.scalable && n > 1) {
      incidents.push({ id: `instance:${c.id}`, kind: 'instance', target: c.id, title: `one ${nm(c.id)} instance dies`, events: fault({ type: 'kill-id', id: c.id }, { type: 'revive-id', id: c.id }) });
    } else {
      incidents.push({ id: `component:${c.id}`, kind: 'component', target: c.id, title: `${nm(c.id)} goes down`, events: fault({ type: 'kill-id', id: c.id }, { type: 'revive-id', id: c.id }) });
    }
    if (c.kind === 'cache' || c.kind === 'cdn') {
      incidents.push({ id: `cold:${c.id}`, kind: 'cold-cache', target: c.id, title: `${nm(c.id)} restarts cold`, events: [{ at: FAULT_AT, action: { type: 'flush-cache', id: c.id } }] });
    }
    if (c.kind !== 'lb' && c.kind !== 'queue') {
      incidents.push({ id: `slow:${c.id}`, kind: 'slow', target: c.id, title: `${nm(c.id)} turns slow (+250 ms)`, events: fault({ type: 'inject-latency', id: c.id, ms: 250 }, { type: 'restore', id: c.id }) });
    }
    if (c.kind !== 'lb' && c.kind !== 'queue' && c.kind !== 'cdn') {
      incidents.push({ id: `errors:${c.id}`, kind: 'errors', target: c.id, title: `${nm(c.id)} fails 20% of requests`, events: fault({ type: 'inject-errors', id: c.id, rate: 0.2 }, { type: 'restore', id: c.id }) });
    }
  }
  for (const z of spec.zones ?? []) {
    incidents.push({ id: `zone:${z.id}`, kind: 'zone', target: z.id, title: `zone ${z.label ?? z.id} goes dark`, events: fault({ type: 'fail-zone', id: z.id }, { type: 'restore-zone', id: z.id }) });
  }
  incidents.push({
    id: 'surge',
    kind: 'surge',
    target: bp.limitedBy ?? 'traffic',
    title: 'traffic surges 3× for 20 s',
    events: [],
    traffic: [
      { at: 0, rps },
      { at: FAULT_AT, rps },
      { at: FAULT_AT + 2, rps: rps * 3 },
      { at: FAULT_AT + 22, rps: rps * 3 },
      { at: FAULT_AT + 24, rps },
      { at: END, rps },
    ],
  });

  const total = incidents.length + 1;
  let done = 0;
  const progress = (label: string) => opts.onProgress?.(++done, total, label);

  const findings: Finding[] = [];
  for (const inc of incidents) {
    const r = run(spec, inc);
    const impact = measure(r, slo, base);
    const severity = grade(impact, inc);
    const f: Finding = {
      id: inc.id,
      kind: inc.kind,
      target: inc.target,
      title: inc.title,
      severity,
      impact,
      blastRadius: blast(r, inc.target),
      explanation: explainIncident(inc, impact, r, severity, nm),
      // failed requests expressed as minutes of full outage, priced
      costAtRisk: opts.incidentCostPerMinute ? Math.round((impact.failedRequests / (rps * 60)) * opts.incidentCostPerMinute) : null,
      fixes: [],
      scenario: scenarioFor(inc),
    };
    if (opts.fixes !== false && SEV_RANK[severity] >= 2) {
      for (const cand of candidateFixes(inc, spec, byId, parents, children, nm)) {
        let variant: ArchitectureSpec;
        try {
          variant = applyVariant(spec, { name: cand.title, changes: cand.changes });
        } catch {
          continue;
        }
        const after = measure(run(variant, inc), slo, base);
        const sevAfter = grade(after, inc);
        const better = SEV_RANK[sevAfter] < SEV_RANK[severity] || after.failedRequests < impact.failedRequests * 0.5;
        if (!better) continue;
        const cost = simulate(variant, { duration: 20, rps, readRatio, slo }).summary.meanCostPerHour;
        f.fixes.push({
          ...cand,
          monthlyDelta: monthly(cost - baseCost),
          after: { severity: sevAfter, errorRate: after.errorRate, peakP99Ms: after.peakP99Ms, failedRequests: after.failedRequests },
        });
      }
      f.fixes.sort((a, b) => SEV_RANK[a.after.severity] - SEV_RANK[b.after.severity] || a.monthlyDelta - b.monthlyDelta);
      f.fixes = f.fixes.slice(0, 3);
    }
    findings.push(f);
    progress(inc.title);
  }

  // ---- headroom ----
  const ratio = bp.maxRps / Math.max(1, rps);
  const headroomSev: Severity = ratio < 1 ? 'critical' : ratio < 1.5 ? 'major' : ratio < 2 ? 'minor' : 'ok';
  const headroom: Finding = {
    id: 'headroom',
    kind: 'headroom',
    target: bp.limitedBy ?? '—',
    title: `load ramps past ${Math.round(bp.maxRps)} req/s`,
    severity: headroomSev,
    impact: { errorRate: 0, peakErrorRate: 0, peakP99Ms: 0, failedRequests: 0, breachS: 0, selfHealS: null, recoveryS: null },
    blastRadius: bp.limitedBy ? [bp.limitedBy] : [],
    explanation: bp.limitedBy
      ? `Sustains ${Math.round(bp.maxRps)} req/s within SLO — ${ratio.toFixed(1)}× the expected ${rps} req/s. ${nm(bp.limitedBy)} gives out first${bp.note ? `: ${bp.note}` : '.'}`
      : `Sustains at least ${Math.round(bp.maxRps)} req/s — no limit found.`,
    costAtRisk: null,
    fixes: [],
    scenario: { duration: 30, rps: Math.round(bp.firstFailingRps ?? bp.maxRps * 1.2), readRatio, slo },
  };
  if (opts.fixes !== false && SEV_RANK[headroomSev] >= 2 && bp.limitedBy) {
    for (const cand of capacityFixes(byId.get(bp.limitedBy), nm)) {
      let variant: ArchitectureSpec;
      try {
        variant = applyVariant(spec, { name: cand.title, changes: cand.changes });
      } catch {
        continue;
      }
      const bp2 = breakingPoint(variant, { readRatio, slo });
      const r2 = bp2.maxRps / Math.max(1, rps);
      if (r2 <= ratio * 1.1) continue;
      const cost = simulate(variant, { duration: 20, rps, readRatio, slo }).summary.meanCostPerHour;
      headroom.fixes.push({
        ...cand,
        why: `${cand.why} Sustains ${Math.round(bp2.maxRps)} req/s (${r2.toFixed(1)}×)${bp2.limitedBy ? `, then ${nm(bp2.limitedBy)} is next` : ''}.`,
        monthlyDelta: monthly(cost - baseCost),
        after: { severity: r2 < 1 ? 'critical' : r2 < 1.5 ? 'major' : r2 < 2 ? 'minor' : 'ok', errorRate: 0, peakP99Ms: 0, failedRequests: 0 },
      });
    }
    headroom.fixes.sort((a, b) => a.monthlyDelta - b.monthlyDelta);
  }
  findings.push(headroom);
  progress('breaking point');

  findings.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || b.impact.failedRequests - a.impact.failedRequests);
  const curve = loadCurve(spec, { maxRps: Math.max(rps * 1.5, bp.maxRps * 2), points: 20, readRatio });
  const graded = findings.filter((f) => f.kind !== 'headroom');
  const survived = graded.filter((f) => f.severity === 'ok' || f.severity === 'minor').length;
  return {
    architecture: spec.name ?? 'architecture',
    load: { rps, readRatio },
    slo,
    baseline,
    headroom: { maxRps: bp.maxRps, limitedBy: bp.limitedBy, note: bp.note, ratio: r3(ratio) },
    score: Math.round((100 * graded.reduce((s, f) => s + (1 - SEV_RANK[f.severity] / 3), 0)) / Math.max(1, graded.length)),
    survived,
    total: graded.length,
    findings,
    curve,
    wallMs: Date.now() - t0,
  };
}

/** $/month from $/h; differences under $5 are simulation noise (autoscaled fleets), not a cost */
const monthly = (perHour: number) => (Math.abs(perHour * 730) < 5 ? 0 : Math.round(perHour * 730));
const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

function measure(r: SimResult, slo: { maxErrorRate: number; maxP99Ms: number }, base: SimResult): IncidentImpact {
  const ok = (x: SimResult['timeline'][number]) => x.errorRate <= slo.maxErrorRate && x.p99Ms <= slo.maxP99Ms;
  // incidents are judged relative to normal: a design already out of SLO only counts what got worse
  const baseErr = avg(base.timeline.slice(-10).map((x) => x.errorRate));
  const during = r.timeline.filter((x) => x.t > FAULT_AT && x.t <= CLEAR_AT);
  const after = r.timeline.filter((x) => x.t > CLEAR_AT);
  const window = r.timeline.filter((x) => x.t > FAULT_AT);
  let selfHealS: number | null = null;
  const firstBad = during.findIndex((x) => !ok(x));
  if (firstBad < 0) selfHealS = 0;
  else {
    for (let i = firstBad; i + 2 < during.length; i++)
      if (ok(during[i]) && ok(during[i + 1]) && ok(during[i + 2])) {
        selfHealS = Math.round(during[i].t - FAULT_AT);
        break;
      }
  }
  let recoveryS: number | null = null;
  for (let i = 0; i + 2 < after.length; i++)
    if (ok(after[i]) && ok(after[i + 1]) && ok(after[i + 2])) {
      recoveryS = Math.round(after[i].t - CLEAR_AT);
      break;
    }
  return {
    errorRate: r3(Math.max(0, avg(during.map((x) => x.errorRate)) - baseErr)),
    peakErrorRate: r3(Math.max(0, ...window.map((x) => x.errorRate))),
    peakP99Ms: Math.round(Math.max(0, ...window.map((x) => x.p99Ms))),
    failedRequests: Math.round(window.reduce((s, x) => s + x.rps * Math.max(0, x.errorRate - baseErr), 0)),
    breachS: window.filter((x) => !ok(x)).length,
    selfHealS,
    recoveryS,
  };
}

function grade(i: IncidentImpact, inc: Incident): Severity {
  const persistent = inc.kind !== 'cold-cache' && inc.kind !== 'surge';
  if (i.recoveryS === null && i.breachS > 3) return 'critical'; // never came back
  if (i.errorRate >= 0.25) return 'critical';
  if (i.breachS === 0) return 'ok';
  // healing on its own within a few seconds (failover, autoscaling) is a blip, not an outage
  if (persistent && i.selfHealS !== null && i.selfHealS <= 8 && i.errorRate < 0.05) return 'minor';
  if (i.breachS <= 3) return 'minor';
  return 'major';
}

function blast(r: SimResult, target: string): string[] {
  return Object.entries(r.components)
    .filter(([id, c]) => id !== target && c.kind !== 'client' && (c.droppedTotal > 0 || c.peakUtil >= 0.95))
    .sort((a, b) => b[1].droppedTotal - a[1].droppedTotal)
    .map(([id]) => id);
}

function explainIncident(inc: Incident, i: IncidentImpact, r: SimResult, sev: Severity, nm: (id: string) => string): string {
  const pct = (x: number) => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`;
  const parts: string[] = [];
  if (sev === 'ok') parts.push(`Absorbed: users stayed within SLO${i.peakP99Ms ? ` (p99 peaked at ${i.peakP99Ms} ms)` : ''}.`);
  else {
    parts.push(`${pct(i.errorRate)} of requests failed while it lasted (peak ${pct(i.peakErrorRate)}), p99 up to ${i.peakP99Ms >= 1000 ? `${(i.peakP99Ms / 1000).toFixed(1)} s` : `${i.peakP99Ms} ms`}.`);
    if (inc.kind === 'surge') {
      if (i.selfHealS !== null && i.selfHealS > 24) parts.push(`Back within SLO ${i.selfHealS - 24} s after the surge ended.`);
    } else if (i.selfHealS !== null && i.selfHealS > 0) parts.push(inc.kind === 'cold-cache' ? `Recovered in ${i.selfHealS} s as the cache re-warmed.` : `Healed by itself after ${i.selfHealS} s.`);
    if (i.recoveryS === null) parts.push('Did not recover after the fault was cleared — a metastable failure: the system stays overloaded by its own retries or backlog.');
    else if (i.recoveryS > 3) parts.push(`Took ${i.recoveryS} s to recover after the fault was cleared.`);
  }
  const top = r.bottlenecks.find((b) => b.id !== inc.target && b.note && !b.note.startsWith('Scaling out'));
  if (sev !== 'ok' && top?.note) parts.push(`Knock-on: ${nm(top.id)} — ${top.note}`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------------------------
// fix generators — every candidate is verified against the incident before it is reported
// ---------------------------------------------------------------------------------------------

type Cand = { title: string; why: string; changes: ChangeSpec[] };

function uniqueId(spec: ArchitectureSpec, base: string) {
  let id = base;
  for (let i = 2; spec.components.some((c) => c.id === id); i++) id = `${base}-${i}`;
  return id;
}

function candidateFixes(
  inc: Incident,
  spec: ArchitectureSpec,
  byId: Map<string, ComponentSpec>,
  parents: (id: string) => string[],
  children: (id: string) => string[],
  nm: (id: string) => string,
): Cand[] {
  const c = byId.get(inc.target);
  const out: Cand[] = [];
  if (inc.kind === 'surge') return [...capacityFixes(c, nm), ...autoscaleFix(c, nm)];
  if (!c) return out;
  const kind = c.kind as Kind;
  const ps = parents(c.id);
  const ks = children(c.id);

  if (inc.kind === 'component' || inc.kind === 'instance') {
    if (KINDS[kind].scalable) {
      const fed = ps.some((p) => ['lb', 'gateway', 'queue'].includes(byId.get(p)?.kind ?? ''));
      const n = c.instances ?? 1;
      if (fed) out.push({ title: `Run ${n + 1} × ${nm(c.id)}`, why: 'One more instance than the load needs (N+1): losing one leaves enough capacity.', changes: [{ op: 'set', id: c.id, fields: { instances: n + 1 } }] });
      else {
        const lb = uniqueId(spec, `${c.id}-lb`);
        out.push({
          title: `Put ${nm(c.id)} behind a load balancer with ${Math.max(2, n + 1)} instances`,
          why: 'Without a load balancer callers know one address; with one, a dead instance is routed around.',
          changes: [
            { op: 'add', component: { id: lb, kind: 'lb', name: `${nm(c.id)}-lb` } },
            ...ps.flatMap((p): ChangeSpec[] => [{ op: 'disconnect', from: p, to: c.id }, { op: 'connect', from: p, to: lb }]),
            { op: 'connect', from: lb, to: c.id },
            { op: 'set', id: c.id, fields: { instances: Math.max(2, n + 1) } },
          ],
        });
      }
    } else if (kind === 'db') {
      const hasReplica = ks.some((k) => byId.get(k)?.kind === 'replica');
      if (!hasReplica) {
        const rep = uniqueId(spec, `${c.id}-replica`);
        out.push({ title: `Add a read replica to ${nm(c.id)}`, why: 'A replica serves reads and is promoted to primary in seconds when the primary dies.', changes: [{ op: 'add', component: { id: rep, kind: 'replica', tier: c.tier, name: `${nm(c.id)}-replica` } }, { op: 'connect', from: c.id, to: rep }] });
      }
    } else if ((kind === 'cache' || kind === 'cdn') && ks.length) {
      // callers bypass a dead cache and go straight to its origin
      out.push({
        title: `Bypass ${nm(c.id)} when it is down`,
        why: 'Callers fail over to the origin instead of failing — the cache is an optimisation, not a dependency.',
        changes: ps.flatMap((p): ChangeSpec[] => [{ op: 'set', id: p, fields: { routing: 'failover' } }, ...ks.filter((k) => !children(p).includes(k)).map((k): ChangeSpec => ({ op: 'connect', from: p, to: k }))]),
      });
    } else if (kind !== 'client') {
      const twin = uniqueId(spec, `${c.id}-b`);
      const { id: _id, ...rest } = c;
      out.push({
        title: `Run a standby ${nm(c.id)}`,
        why: `A second ${KINDS[kind].label.toLowerCase()} that callers fail over to.`,
        changes: [
          { op: 'add', component: { ...rest, id: twin, name: `${nm(c.id)}-standby` } },
          ...ps.flatMap((p): ChangeSpec[] => [{ op: 'connect', from: p, to: twin }, { op: 'set', id: p, fields: { routing: 'failover' } }]),
          ...ks.map((k): ChangeSpec => ({ op: 'connect', from: twin, to: k })),
        ],
      });
    }
  }

  if (inc.kind === 'zone') {
    const z = spec.zones?.find((x) => x.id === inc.target);
    for (const m of z?.members ?? []) {
      const mc = byId.get(m);
      if (mc && KINDS[mc.kind as Kind].scalable) out.push({ title: `Add ${nm(m)} capacity outside ${inc.target}`, why: 'Instances outside the failed zone keep serving.', changes: [{ op: 'set', id: m, fields: { instances: (mc.instances ?? 1) * 2 } }] });
    }
  }

  if (inc.kind === 'slow' || inc.kind === 'errors') {
    for (const p of ps) {
      const pc = byId.get(p);
      if (!pc) continue;
      const fields: Partial<ComponentSpec> = inc.kind === 'slow' ? { timeoutMs: 200, breaker: true, fallback: true } : { retries: 2, retryPolicy: 'budget', breaker: true, fallback: true };
      out.push({
        title: inc.kind === 'slow' ? `Timeout + circuit breaker with fallback on ${p} → ${c.id}` : `Retry budget + circuit breaker with fallback on ${p}`,
        why: inc.kind === 'slow' ? 'Give up quickly on the slow dependency and serve a degraded answer instead of tying up workers.' : 'Retry the occasional failure (within a 10 % budget so retries cannot snowball), cut off a dependency that keeps failing.',
        changes: [{ op: 'set', id: p, fields }],
      });
      if (inc.kind === 'errors') out.push({ title: `2 retries with backoff on ${nm(p)}`, why: 'Most transient errors succeed on a second try; backoff with jitter spreads the extra load.', changes: [{ op: 'set', id: p, fields: { retries: 2, retryPolicy: 'backoff' } }] });
      if (inc.kind === 'errors') out.push({ title: `Retry budget on ${nm(p)}`, why: 'Transient errors are retried; a 10 % budget stops retries from multiplying load.', changes: [{ op: 'set', id: p, fields: { retries: 2, retryPolicy: 'budget' } }] });
    }
  }

  if (inc.kind === 'cold-cache') {
    for (const k of ks) out.push(...capacityFixes(byId.get(k), nm).map((f) => ({ ...f, why: `${f.why} The origin must survive the misses of a cold cache.` })));
    out.push({ title: `Warm ${nm(c.id)} faster`, why: 'Pre-warm on restart (load hot keys) so the stampede is short.', changes: [{ op: 'set', id: c.id, fields: { warmupS: 5 } }] });
  }
  return out;
}

function capacityFixes(c: ComponentSpec | undefined, nm: (id: string) => string = (x) => x): Cand[] {
  if (!c) return [];
  const kind = c.kind as Kind;
  const out: Cand[] = [];
  if (KINDS[kind].scalable) {
    const n = c.instances ?? 1;
    out.push({ title: `Scale ${nm(c.id)} to ${n * 2} instances`, why: 'Double the fleet.', changes: [{ op: 'set', id: c.id, fields: { instances: n * 2 } }] });
  }
  if (KINDS[kind].tiered) {
    const i = TIERS.indexOf((c.tier as Tier) ?? 'S');
    if (i < TIERS.length - 1) out.push({ title: `Size ${nm(c.id)} up to ${TIERS[i + 1]}`, why: 'Bigger instance class: about twice the throughput.', changes: [{ op: 'set', id: c.id, fields: { tier: TIERS[i + 1] } }] });
  }
  if (kind === 'gateway' || kind === 'function' || kind === 'llmapi') {
    out.push({ title: `Raise ${nm(c.id)} limit to ${Math.round((c.limit ?? KINDS[kind].capacity) * 2)}/s`, why: 'The limit, not the hardware, is what fails first.', changes: [{ op: 'set', id: c.id, fields: { limit: Math.round((c.limit ?? KINDS[kind].capacity) * 2) } }] });
  }
  return out;
}

function autoscaleFix(c: ComponentSpec | undefined, nm: (id: string) => string = (x) => x): Cand[] {
  if (!c || !KINDS[c.kind as Kind].scalable || c.autoscale) return [];
  const n = c.instances ?? 1;
  return [{ title: `Autoscale ${nm(c.id)} (${n}–${n * 4}, 15 s warm-up)`, why: 'Pay for the surge only while it lasts — as long as capacity arrives fast enough.', changes: [{ op: 'set', id: c.id, fields: { autoscale: { min: n, max: n * 4, warmupS: 15, cooldownS: 60 } } }] }];
}
