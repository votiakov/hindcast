import { KINDS, RUNTIMES, TIERS, isSystem, type AppNode, type SystemEdge, type SystemNode } from './catalog';
import { DEFAULT_ENGINE_CONFIG, Engine, type EngineConfig, type NodeStats } from './engine';
import { applyAction } from './actions';
import { PRICING, getPricing, withPricing } from './pricing';
import { explain, nodeView } from '../canvas/nodeModel';
import { ArchitectureSpec, ScenarioSpec, type VariantSpec } from '../spec/schema';
import { applyVariant, specToGraph } from '../spec/convert';

/**
 * Headless runner: the simulation engine as an analysis tool (CLI, MCP, tests).
 * No React, no store — just spec in, numbers and explanations out.
 */

export interface SimOptions {
  /** simulation step (s) */
  dt?: number;
  /** timeline sample interval (s) */
  sampleEvery?: number;
  cfg?: Partial<EngineConfig>;
}

export interface ComponentReport {
  kind: string;
  /** autoscaled components: instances serving at the end of the run */
  instances?: number;
  /** fed only by queues: saturation shows up as backlog, not as user errors */
  async?: boolean;
  peakUtil: number;
  meanUtil: number;
  peakDropRps: number;
  droppedTotal: number;
  peakLatencyMs: number;
  finalStatus: string;
  /** plain-English note at this component's worst moment */
  note: string | null;
}

export interface SimResult {
  architecture: string;
  scenario: string;
  summary: {
    durationS: number;
    meanRps: number;
    meanErrorRate: number;
    peakErrorRate: number;
    meanP99Ms: number;
    peakP99Ms: number;
    meanCostPerHour: number;
    peakCostPerHour: number;
    /** share of time within SLO */
    sloCompliance: number;
    sloBreachSeconds: number;
    requests: number;
    failedRequests: number;
    worstMomentS: number;
  };
  slo: { maxErrorRate: number; maxP99Ms: number };
  timeline: { t: number; rps: number; errorRate: number; p99Ms: number; costPerHour: number }[];
  components: Record<string, ComponentReport>;
  bottlenecks: { id: string; peakUtil: number; droppedTotal: number; note: string | null }[];
  events: { t: number; what: string }[];
}

const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

/** compiled implementations (src/backtest/native.ts sets them) */
const native: {
  simulate?: typeof simulateTs;
  compare?: typeof compareTs;
  breakingPoint?: typeof breakingPointTs;
  loadCurve?: typeof loadCurveTs;
} = {};
export function setNativeHeadless(n: typeof native | null) {
  for (const k of Object.keys(native) as (keyof typeof native)[]) delete native[k];
  if (n) Object.assign(native, n);
}

/** a component whose every caller is a queue: it works off a backlog, users never wait on it */
export function asyncOnly(id: string, nodes: { id: string; data: { kind: string } }[], edges: { source: string; target: string }[]): boolean {
  const callers = edges.filter((e) => e.target === id).map((e) => nodes.find((n) => n.id === e.source)?.data.kind);
  return callers.length > 0 && callers.every((k) => k === 'queue');
}

function trafficFn(sc: ScenarioSpec): (t: number) => number {
  const tl = sc.traffic?.length ? [...sc.traffic].sort((a, b) => a.at - b.at) : [{ at: 0, rps: sc.rps ?? 500 }];
  return (t) => {
    if (t <= tl[0].at) return tl[0].rps;
    for (let i = 1; i < tl.length; i++) if (t <= tl[i].at) return tl[i - 1].rps + ((tl[i].rps - tl[i - 1].rps) * (t - tl[i - 1].at)) / (tl[i].at - tl[i - 1].at);
    return tl[tl.length - 1].rps;
  };
}

export function simulate(specInput: unknown, scenarioInput: unknown = {}, opts: SimOptions = {}): SimResult {
  return native.simulate ? native.simulate(specInput, scenarioInput, opts) : simulateTs(specInput, scenarioInput, opts);
}

/** the headless run in TypeScript: the reference the Rust one is checked against */
export function simulateTs(specInput: unknown, scenarioInput: unknown = {}, opts: SimOptions = {}): SimResult {
  const spec = ArchitectureSpec.parse(specInput);
  return withPricing(spec.pricing, () => simulateParsed(spec, scenarioInput, opts));
}

function simulateParsed(spec: ArchitectureSpec, scenarioInput: unknown, opts: SimOptions): SimResult {
  const sc = ScenarioSpec.parse(scenarioInput);
  const slo = { maxErrorRate: sc.slo?.maxErrorRate ?? 0.01, maxP99Ms: sc.slo?.maxP99Ms ?? 300 };
  const dt = opts.dt ?? 0.05;
  const sampleEvery = opts.sampleEvery ?? 1;
  const cfg: EngineConfig = { ...DEFAULT_ENGINE_CONFIG, ...opts.cfg };
  const traffic = trafficFn(sc);
  const zones = new Map((spec.zones ?? []).map((z) => [z.id, z.members]));

  const g = specToGraph(spec);
  let nodes: AppNode[] = g.nodes;
  const edges: SystemEdge[] = g.edges;
  const engine = new Engine();
  const pending = [...(sc.events ?? [])].sort((a, b) => a.at - b.at);
  const events: SimResult['events'] = [];
  const timeline: SimResult['timeline'] = [];

  const acc = new Map<string, { utilSum: number; n: number; peakUtil: number; peakDrop: number; dropped: number; peakLat: number; worst: number; worstNote: string | null }>();
  let lastStats: Record<string, NodeStats> = {};
  let sinceSample = sampleEvery;
  let requests = 0;
  let failed = 0;
  let breach = 0;
  let worst = { t: 0, score: -1 };

  const steps = Math.round(sc.duration / dt);
  for (let i = 0; i < steps; i++) {
    const t = i * dt;
    while (pending.length && pending[0].at <= t) {
      const ev = pending.shift()!;
      const r = applyAction(nodes, ev.action, { inRps: (id) => lastStats[id]?.inRps ?? 0, zoneMembers: (id) => zones.get(id) ?? [] });
      nodes = r.nodes;
      events.push({ t: round(t, 2), what: ev.note ?? `${ev.action.type}${'id' in ev.action ? ` ${ev.action.id}` : ''}${r.target && r.target !== ('id' in ev.action ? ev.action.id : '') ? ` → ${r.target}` : ''}` });
    }
    const sys = nodes.filter(isSystem) as SystemNode[];
    for (const e of engine.step(sys, edges, traffic(t), sc.readRatio, dt, cfg)) events.push({ t: round(t + dt, 2), what: `${e.kind}: ${e.name}${e.detail ? ` ${e.detail}` : ""}` });
    const snap = engine.snapshot(sys, edges);
    lastStats = snap.nodeStats;
    const gl = snap.global;

    requests += gl.rps * dt;
    failed += gl.rps * gl.errorRate * dt;
    const ok = gl.errorRate <= slo.maxErrorRate && gl.p99 <= slo.maxP99Ms;
    if (!ok && gl.rps > 0.5) breach += dt;
    const score = gl.errorRate * 10 + gl.p99 / 1000;
    if (score > worst.score) worst = { t, score };

    for (const n of sys) {
      const st = snap.nodeStats[n.id];
      const a = acc.get(n.id) ?? { utilSum: 0, n: 0, peakUtil: 0, peakDrop: 0, dropped: 0, peakLat: 0, worst: -1, worstNote: null };
      a.utilSum += st.util;
      a.n += 1;
      a.peakUtil = Math.max(a.peakUtil, st.util);
      a.peakDrop = Math.max(a.peakDrop, st.dropRps);
      a.dropped += st.dropRps * dt;
      a.peakLat = Math.max(a.peakLat, st.latencyMs);
      const v = nodeView(n.data, st, true, edges.some((e) => e.source === n.id));
      const badness = st.dropRps + st.util * 10 + (v.up ? 0 : 1000) + (st.breaker === 'open' ? 500 : 0) + st.retryAmp * 20;
      if (badness > a.worst) {
        a.worst = badness;
        a.worstNote = explain(n.data, st, v)?.text ?? null;
      }
      acc.set(n.id, a);
    }

    sinceSample += dt;
    if (sinceSample >= sampleEvery - 1e-9) {
      sinceSample = 0;
      timeline.push({ t: round(t + dt, 2), rps: round(gl.rps, 1), errorRate: round(gl.errorRate, 4), p99Ms: round(gl.p99, 0), costPerHour: round(gl.cost, 3) });
    }
  }

  const finalSys = nodes.filter(isSystem) as SystemNode[];
  const components: Record<string, ComponentReport> = {};
  for (const n of finalSys) {
    const a = acc.get(n.id)!;
    const st = lastStats[n.id];
    const v = nodeView(n.data, st, true, edges.some((e) => e.source === n.id));
    components[n.id] = {
      kind: n.data.kind,
      peakUtil: round(a.peakUtil),
      meanUtil: round(a.utilSum / a.n),
      peakDropRps: round(a.peakDrop, 1),
      droppedTotal: Math.round(a.dropped),
      peakLatencyMs: Math.round(a.peakLat),
      finalStatus: v.failedOver ? 'failed over' : v.up ? v.health : 'down',
      note: a.worstNote,
      ...(st?.scaling ? { instances: st.scaling.live } : {}),
      ...(asyncOnly(n.id, finalSys, edges) ? { async: true } : {}),
    };
  }
  const bottlenecks = Object.entries(components)
    .filter(([, c]) => c.kind !== 'client' && (c.peakUtil >= 0.7 || c.droppedTotal > 0 || c.finalStatus === 'down') && !(c.async && c.droppedTotal === 0))
    .sort((a, b) => b[1].droppedTotal - a[1].droppedTotal || b[1].peakUtil - a[1].peakUtil)
    .slice(0, 5)
    .map(([id, c]) => ({ id, peakUtil: c.peakUtil, droppedTotal: c.droppedTotal, note: c.note }));

  const mean = (k: 'rps' | 'errorRate' | 'p99Ms' | 'costPerHour') => (timeline.length ? timeline.reduce((s, x) => s + x[k], 0) / timeline.length : 0);
  const peak = (k: 'errorRate' | 'p99Ms' | 'costPerHour') => Math.max(0, ...timeline.map((x) => x[k]));
  return {
    architecture: spec.name ?? 'architecture',
    scenario: sc.name ?? (sc.traffic ? 'custom traffic' : `${sc.rps ?? 500} req/s steady`),
    summary: {
      durationS: sc.duration,
      meanRps: round(mean('rps'), 1),
      meanErrorRate: round(mean('errorRate'), 4),
      peakErrorRate: round(peak('errorRate'), 4),
      meanP99Ms: Math.round(mean('p99Ms')),
      peakP99Ms: Math.round(peak('p99Ms')),
      meanCostPerHour: round(mean('costPerHour')),
      peakCostPerHour: round(peak('costPerHour')),
      sloCompliance: round(1 - breach / sc.duration),
      sloBreachSeconds: round(breach, 1),
      requests: Math.round(requests),
      failedRequests: Math.round(failed),
      worstMomentS: round(worst.t, 1),
    },
    slo,
    timeline,
    components,
    bottlenecks,
    events,
  };
}

export interface CompareRow {
  name: string;
  meetsSlo: boolean;
  sloCompliance: number;
  meanErrorRate: number;
  peakErrorRate: number;
  peakP99Ms: number;
  meanCostPerHour: number;
  monthlyCost: number;
  topBottleneck: string | null;
}

/** Run a baseline and variants under the same scenario; rank SLO-compliant variants by cost. */
export function compare(baseInput: unknown, variants: VariantSpec[], scenario: unknown = {}, opts: SimOptions = {}): ReturnType<typeof compareTs> {
  return native.compare ? native.compare(baseInput, variants, scenario, opts) : compareTs(baseInput, variants, scenario, opts);
}

export function compareTs(baseInput: unknown, variants: VariantSpec[], scenario: unknown = {}, opts: SimOptions = {}) {
  const base = ArchitectureSpec.parse(baseInput);
  const runs = [{ name: 'baseline', spec: base }, ...variants.map((v) => ({ name: v.name, spec: applyVariant(base, v) }))];
  const results = runs.map((r) => ({ name: r.name, spec: r.spec, result: simulate(r.spec, scenario, opts) }));
  const rows: CompareRow[] = results.map(({ name, result: r }) => ({
    name,
    meetsSlo: r.summary.sloCompliance >= 0.99,
    sloCompliance: r.summary.sloCompliance,
    meanErrorRate: r.summary.meanErrorRate,
    peakErrorRate: r.summary.peakErrorRate,
    peakP99Ms: r.summary.peakP99Ms,
    meanCostPerHour: r.summary.meanCostPerHour,
    monthlyCost: Math.round(r.summary.meanCostPerHour * 730),
    topBottleneck: r.bottlenecks[0] ? `${r.bottlenecks[0].id}: ${r.bottlenecks[0].note ?? `peak ${Math.round(r.bottlenecks[0].peakUtil * 100)}% util`}` : null,
  }));
  const ranked = [...rows].sort((a, b) => Number(b.meetsSlo) - Number(a.meetsSlo) || (a.meetsSlo ? a.meanCostPerHour - b.meanCostPerHour : b.sloCompliance - a.sloCompliance));
  return { ranked, results };
}

/**
 * Highest constant load the architecture sustains within SLO (steady state).
 * Exponential search for an upper bound, then binary search.
 */
type BreakingOpts = { readRatio?: number; slo?: { maxErrorRate?: number; maxP99Ms?: number }; holdS?: number; maxRps?: number; cfg?: Partial<EngineConfig> };
export function breakingPoint(specInput: unknown, opts: BreakingOpts = {}): ReturnType<typeof breakingPointTs> {
  return native.breakingPoint ? native.breakingPoint(specInput, opts) : breakingPointTs(specInput, opts);
}

export function breakingPointTs(specInput: unknown, opts: BreakingOpts = {}) {
  const spec = ArchitectureSpec.parse(specInput);
  const slo = { maxErrorRate: opts.slo?.maxErrorRate ?? 0.01, maxP99Ms: opts.slo?.maxP99Ms ?? 300 };
  const holdS = opts.holdS ?? 25;
  const cap = opts.maxRps ?? 1_000_000;
  const probe = (rps: number) => {
    const r = simulate(spec, { duration: holdS, rps, readRatio: opts.readRatio ?? 0.8, slo }, { cfg: opts.cfg, sampleEvery: 1 });
    const tail = r.timeline.slice(-5);
    const err = tail.reduce((s, x) => s + x.errorRate, 0) / tail.length;
    const p99 = tail.reduce((s, x) => s + x.p99Ms, 0) / tail.length;
    return { ok: err <= slo.maxErrorRate && p99 <= slo.maxP99Ms, r };
  };
  let lo = 0;
  let hi = 50;
  let hiRun = probe(hi);
  while (hiRun.ok && hi < cap) {
    lo = hi;
    hi = Math.min(cap, hi * 2);
    hiRun = probe(hi);
  }
  if (hiRun.ok) return { maxRps: hi, limitedBy: null, note: `sustains the probe ceiling of ${hi} req/s`, slo };
  for (let i = 0; i < 14 && hi - lo > Math.max(5, lo * 0.01); i++) {
    const mid = Math.round((lo + hi) / 2);
    const m = probe(mid);
    if (m.ok) lo = mid;
    else [hi, hiRun] = [mid, m];
  }
  const limiter = hiRun.r.bottlenecks[0] ?? null;
  return { maxRps: lo, firstFailingRps: hi, limitedBy: limiter?.id ?? null, note: limiter?.note ?? null, slo };
}

/** The component catalogue, for tools that need to know what can be built. */
export function catalog() {
  return {
    components: Object.values(KINDS).map((k) => ({
      kind: k.kind,
      label: k.label,
      description: k.description,
      capacityPerInstanceRps: isFinite(k.capacity) ? k.capacity : null,
      baseLatencyMs: k.baseLatencyMs,
      costPerHour: k.costPerHour,
      costPerRequest: k.costPerRequest ?? null,
      sizable: k.tiered,
      scalesHorizontally: !!k.scalable,
    })),
    tiers: TIERS,
    runtimes: RUNTIMES,
    pricing: {
      active: getPricing(),
      profiles: PRICING,
      howTo: 'set `pricing: aws-us-east-1` at the root of a spec to price components as concrete SKUs / usage with cited sources',
    },
    notes: [
      'Numbers are illustrative defaults; override per component with capacity / latencyMs / costPerHour to calibrate to a real system.',
      'Instances are only reachable behind lb, gateway or queue.',
      'db shares reads with replica children; a dead primary with replicas fails over after ~3s.',
    ],
  };
}

export interface CurvePoint {
  rps: number;
  errorRate: number;
  p99Ms: number;
  costPerHour: number;
  /** $ per million successful requests */
  perMillion: number;
  bottleneck: string | null;
}

/** Steady-state behaviour across a range of loads: where latency bends, where errors start, what each request costs. */
type CurveOpts = { maxRps: number; points?: number; readRatio?: number; holdS?: number; cfg?: Partial<EngineConfig> };
export function loadCurve(specInput: unknown, opts: CurveOpts): CurvePoint[] {
  return native.loadCurve ? native.loadCurve(specInput, opts) : loadCurveTs(specInput, opts);
}

export function loadCurveTs(specInput: unknown, opts: CurveOpts): CurvePoint[] {
  const spec = ArchitectureSpec.parse(specInput);
  const n = opts.points ?? 16;
  const out: CurvePoint[] = [];
  for (let i = 1; i <= n; i++) {
    const rps = Math.round((opts.maxRps * i) / n);
    const r = simulate(spec, { duration: opts.holdS ?? 20, rps, readRatio: opts.readRatio ?? 0.8 }, { cfg: opts.cfg });
    const tail = r.timeline.slice(-5);
    const err = tail.reduce((s, x) => s + x.errorRate, 0) / tail.length;
    const p99 = tail.reduce((s, x) => s + x.p99Ms, 0) / tail.length;
    const cost = tail.reduce((s, x) => s + x.costPerHour, 0) / tail.length;
    const ok = rps * (1 - err);
    out.push({ rps, errorRate: round(err, 4), p99Ms: Math.round(p99), costPerHour: round(cost), perMillion: ok > 0 ? round((cost / (ok * 3600)) * 1e6, 4) : 0, bottleneck: r.bottlenecks[0]?.id ?? null });
  }
  return out;
}
