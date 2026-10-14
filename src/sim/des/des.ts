import { billedInstances, effectiveData, newScaler, stepScaler, type ScalerState } from '../autoscale';
import { KINDS, baseLatencyOf, cacheWarmth, capacityOf, perInstanceCapacity, costOf, requestPrice, instancesUp, isSystem, RUNTIMES, type AppNode, type SystemEdge, type SystemNode, type SystemNodeData } from '../catalog';
import { applyAction } from '../actions';
import { explain, nodeView } from '../../canvas/nodeModel';
import { failoverOrder, type NodeStats } from '../engine';
import { asyncOnly } from '../headless';
import { ArchitectureSpec, ScenarioSpec } from '../../spec/schema';
import { specToGraph } from '../../spec/convert';
import { Histogram } from './histogram';
import { Rng } from './random';
import { withPricing } from '../pricing';

/**
 * Discrete-event simulation (DES) — the analysis engine.
 *
 * Every request is an individual entity. Each component is a pool of `workers` (derived from
 * capacity × service time, Little's law) in front of a bounded FIFO queue; service times are
 * log-normal (long-tailed). Requests are routed, retried, timed out and short-circuited exactly as
 * configured, so retry storms, metastable failures, breaker oscillation and tail latency *emerge*
 * instead of being approximated. Latency percentiles come from real histograms.
 *
 * Same inputs as the fluid engine (architecture spec + scenario), deterministic per seed.
 */

export interface DesConfig {
  seed: number;
  /** coefficient of variation of service times (0 = deterministic, 1 = exponential-like) */
  serviceCv: number;
  /** default bounded queue length, seconds of work */
  queueS: number;
  /** seconds before a replica is promoted; null = no automatic failover */
  failoverS: number | null;
  coldStartMs: number;
  /** one-way network hop between components */
  hopMs: number;
  /** safety valve */
  maxEvents: number;
}

export const DEFAULT_DES: DesConfig = { seed: 1, serviceCv: 0.6, queueS: 1, failoverS: 3, coldStartMs: 400, hopMs: 0.3, maxEvents: 60_000_000 };

const BREAKER = { minCalls: 10, tripFail: 0.5, openS: 5, probe: 0.1, closeFail: 0.1 };
const BACKOFF = { baseMs: 50, cap: 2000 };
const RETRY_BUDGET = { ratio: 0.1, cap: 20 };
const QUEUE_BACKLOG_MAX = 200_000;

// ---------------------------------------------------------------------------------------------
// event queue: binary heap keyed by (time, seq)
// ---------------------------------------------------------------------------------------------

class EventQueue {
  private t: number[] = [];
  private s: number[] = [];
  private f: (() => void)[] = [];
  private seq = 0;

  get size() {
    return this.t.length;
  }

  push(time: number, fn: () => void) {
    const t = this.t;
    const s = this.s;
    const f = this.f;
    let i = t.length;
    const seq = this.seq++;
    t.push(time);
    s.push(seq);
    f.push(fn);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (t[p] < time || (t[p] === time && s[p] < seq)) break;
      t[i] = t[p];
      s[i] = s[p];
      f[i] = f[p];
      i = p;
    }
    t[i] = time;
    s[i] = seq;
    f[i] = fn;
  }

  peekTime(): number {
    return this.t[0];
  }

  pop(): () => void {
    const t = this.t;
    const s = this.s;
    const f = this.f;
    const top = f[0];
    const lt = t.pop()!;
    const ls = s.pop()!;
    const lf = f.pop()!;
    const n = t.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && (t[r] < t[l] || (t[r] === t[l] && s[r] < s[l])) ? r : l;
        if (t[c] > lt || (t[c] === lt && s[c] > ls)) break;
        t[i] = t[c];
        s[i] = s[c];
        f[i] = f[c];
        i = c;
      }
      t[i] = lt;
      s[i] = ls;
      f[i] = lf;
    }
    return top;
  }
}

// ---------------------------------------------------------------------------------------------
// runtime model
// ---------------------------------------------------------------------------------------------

type Done = (ok: boolean) => void;

interface Job {
  read: boolean;
  tIn: number;
  done: Done;
}

interface Win {
  arrivals: number;
  drops: number;
  hits: number;
  busyArea: number;
  maxQueue: number;
  calls: number;
  attempts: number;
  late: number;
  usageReqs: number;
  latency: Histogram;
}

interface DNode {
  idx: number;
  id: string;
  /** node data as configured / changed by actions */
  raw: SystemNodeData;
  /** with dynamics applied (autoscaled instance count) */
  data: SystemNodeData;
  scaler: ScalerState | null;
  /** cache: when it went cold (null = warm) */
  coldAt: number | null;
  flushSeen: number;
  children: number[];
  edgeIds: string[];
  pooled: boolean;
  // service pool
  workers: number;
  svcMeanMs: number;
  busy: number;
  queue: Job[];
  qHead: number;
  queueMax: number;
  lastBusyT: number;
  // rate limiter (gateway, llmapi, function concurrency)
  rate: number;
  tokens: number;
  lastRefill: number;
  // serverless warm pool
  warm: number;
  // db failover
  downSince: number | null;
  // breaker
  br: 'closed' | 'open' | 'half';
  brUntil: number;
  brOk: number;
  brFail: number;
  // retry budget
  retryTokens: number;
  // async queue (kind 'queue')
  backlog: Job[];
  bHead: number;
  inflight: number;
  // stats
  win: Win;
  peakUtil: number;
  utilSum: number;
  utilN: number;
  dropsTotal: number;
  worst: number;
  worstNote: string | null;
  lastStats: NodeStats | null;
}

const newWin = (): Win => ({ arrivals: 0, drops: 0, hits: 0, busyArea: 0, maxQueue: 0, calls: 0, attempts: 0, late: 0, usageReqs: 0, latency: new Histogram() });

export interface DesResult {
  engine: 'des';
  seed: number;
  architecture: string;
  scenario: string;
  summary: {
    durationS: number;
    meanRps: number;
    meanErrorRate: number;
    peakErrorRate: number;
    p50Ms: number;
    p90Ms: number;
    p99Ms: number;
    p999Ms: number;
    meanP99Ms: number;
    peakP99Ms: number;
    meanCostPerHour: number;
    peakCostPerHour: number;
    sloCompliance: number;
    sloBreachSeconds: number;
    requests: number;
    failedRequests: number;
    worstMomentS: number;
    events: number;
    wallMs: number;
  };
  slo: { maxErrorRate: number; maxP99Ms: number };
  timeline: { t: number; rps: number; errorRate: number; p50Ms: number; p99Ms: number; costPerHour: number }[];
  components: Record<string, { kind: string; peakUtil: number; meanUtil: number; droppedTotal: number; finalStatus: string; note: string | null }>;
  bottlenecks: { id: string; peakUtil: number; droppedTotal: number; note: string | null }[];
  events: { t: number; what: string }[];
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** the compiled DES (src/backtest/native.ts sets it) */
let nativeDes: typeof simulateDesTs | null = null;
export function setNativeDes(f: typeof simulateDesTs | null) {
  nativeDes = f;
}

export function simulateDes(specInput: unknown, scenarioInput: unknown = {}, cfgIn: Partial<DesConfig> = {}): DesResult {
  return nativeDes ? nativeDes(specInput, scenarioInput, cfgIn) : simulateDesTs(specInput, scenarioInput, cfgIn);
}

/** the discrete-event run in TypeScript: the reference the Rust one is checked against */
export function simulateDesTs(specInput: unknown, scenarioInput: unknown = {}, cfgIn: Partial<DesConfig> = {}): DesResult {
  const spec = ArchitectureSpec.parse(specInput);
  return withPricing(spec.pricing, () => runDes(spec, scenarioInput, cfgIn));
}

function runDes(spec: ArchitectureSpec, scenarioInput: unknown, cfgIn: Partial<DesConfig>): DesResult {
  const wall0 = performance.now();
  const cfg: DesConfig = { ...DEFAULT_DES, ...cfgIn };
  const sc = ScenarioSpec.parse(scenarioInput);
  const slo = { maxErrorRate: sc.slo?.maxErrorRate ?? 0.01, maxP99Ms: sc.slo?.maxP99Ms ?? 300 };
  const rng = new Rng(cfg.seed);
  const q = new EventQueue();
  let now = 0;
  let processed = 0;

  // ---- graph ----
  const g = specToGraph(spec);
  let appNodes: AppNode[] = g.nodes;
  const edges: SystemEdge[] = g.edges;
  const sys = () => appNodes.filter(isSystem) as SystemNode[];
  const index = new Map<string, number>();
  const nodes: DNode[] = sys().map((n, i) => {
    index.set(n.id, i);
    return {
      idx: i, id: n.id, raw: n.data, data: n.data, children: [], edgeIds: [], pooled: false,
      scaler: n.data.autoscale && KINDS[n.data.kind].scalable ? newScaler(n.data) : null, coldAt: null, flushSeen: n.data.flushes ?? 0,
      workers: 1, svcMeanMs: 1, busy: 0, queue: [], qHead: 0, queueMax: 0, lastBusyT: 0,
      rate: Infinity, tokens: 0, lastRefill: 0, warm: 0, downSince: null,
      br: 'closed', brUntil: 0, brOk: 0, brFail: 0, retryTokens: RETRY_BUDGET.cap,
      backlog: [], bHead: 0, inflight: 0,
      win: newWin(), peakUtil: 0, utilSum: 0, utilN: 0, dropsTotal: 0, worst: -1, worstNote: null, lastStats: null,
    };
  });
  const linkMs = new Map<number, number>();
  for (const e of edges) {
    const a = index.get(e.source);
    const b = index.get(e.target);
    if (a === undefined || b === undefined || a === b) continue;
    if (e.data?.latencyMs) linkMs.set(a * 100_000 + b, Number(e.data.latencyMs));
    nodes[a].children.push(b);
    nodes[a].edgeIds.push(e.id);
    const k = nodes[a].data.kind;
    if (k === 'lb' || k === 'gateway' || k === 'queue' || (nodes[a].data.fanout ?? 1) > 1) nodes[b].pooled = true;
  }

  const up = (n: DNode) => n.data.alive && instancesUp(n.data) > 0;

  /** derive pool size, service time and limits from the node's (possibly changed) data */
  function configure(n: DNode) {
    n.data = effectiveData(n.raw, n.scaler ?? undefined);
    if ((n.raw.kind === 'cache' || n.raw.kind === 'cdn') && (!up(n) || (n.raw.flushes ?? 0) !== n.flushSeen)) n.coldAt = now;
    n.flushSeen = n.raw.flushes ?? 0;
    const d = n.data;
    const reach = n.pooled || d.kind === 'llm' ? instancesUp(d) : Math.min(1, instancesUp(d));
    const cap = Math.max(1e-6, capacityOf(d, reach));
    const lat = Math.max(0.05, baseLatencyOf(d));
    const kind = d.kind;
    if (kind === 'gateway' || kind === 'llmapi') {
      n.rate = d.limit ?? KINDS[kind].capacity;
      n.workers = Infinity;
      n.svcMeanMs = kind === 'llmapi' ? (d.latencyMs ?? KINDS.llmapi.baseLatencyMs) : lat;
    } else if (kind === 'function') {
      n.rate = Infinity;
      n.workers = Math.max(1, Math.round((d.limit ?? 3000) * (lat / 1000)));
      n.svcMeanMs = lat;
    } else {
      n.rate = Infinity;
      n.workers = Math.max(1, Math.round(cap * (lat / 1000)));
      // keep total capacity exact: workers / service time = capacity
      n.svcMeanMs = (n.workers / cap) * 1000;
    }
    n.tokens = Math.min(n.tokens, n.rate);
    // serverless throttles instead of queueing; unlimited pools never queue
    n.queueMax = kind === 'function' || !isFinite(n.workers) ? 0 : Math.max(1, Math.floor(cap * (d.queueS ?? KINDS[kind].queueS ?? cfg.queueS)));
  }
  nodes.forEach((n) => {
    configure(n);
    n.tokens = isFinite(n.rate) ? n.rate * 0.1 : 0;
  });

  // ---- helpers ----
  const at = (dtMs: number, fn: () => void) => q.push(now + dtMs / 1000, fn);
  const setBusy = (n: DNode, delta: number) => {
    n.win.busyArea += n.busy * (now - n.lastBusyT);
    n.lastBusyT = now;
    n.busy += delta;
  };
  const fail = (n: DNode | null, done: Done, ms = 0.5) => {
    if (n) {
      n.win.drops++;
      n.dropsTotal++;
    }
    at(ms, () => done(false));
  };

  // ---- arrival at a component ----
  function arrive(i: number, read: boolean, done: Done) {
    const n = nodes[i];
    const d = n.data;
    n.win.arrivals++;
    const kind = d.kind;

    if (kind === 'db') return arriveDb(n, read, done);
    if (!up(n)) return fail(n, done);

    if (isFinite(n.rate)) {
      n.tokens = Math.min(n.rate, n.tokens + (now - n.lastRefill) * n.rate);
      n.lastRefill = now;
      if (n.tokens < 1) return fail(n, done, 1); // 429
      n.tokens -= 1;
    }

    if (kind === 'queue') {
      if (n.backlog.length - n.bHead >= QUEUE_BACKLOG_MAX) return fail(n, done);
      n.backlog.push({ read, tIn: now, done: () => {} });
      at(baseLatencyOf(d), () => done(true)); // producer gets the ack
      pump(n);
      return;
    }
    if (kind === 'llmapi') {
      // provider capacity is not your problem — only its rate limit and latency are
      at(rng.lognormal(n.svcMeanMs, cfg.serviceCv * 0.5) + (d.faultLatencyMs ?? 0), () => {
        n.win.usageReqs++;
        if (d.faultRate && rng.next() < d.faultRate) return fail(n, done, 0);
        done(true);
      });
      return;
    }
    enqueue(n, { read, tIn: now, done });
  }

  function arriveDb(n: DNode, read: boolean, done: Done) {
    const replicas = n.children.filter((c) => nodes[c].data.kind === 'replica' && up(nodes[c]));
    if (up(n)) {
      n.downSince = null;
      if (read && replicas.length) {
        const pick = Math.floor(rng.next() * (replicas.length + 1));
        if (pick > 0) return hop(replicas[pick - 1], read, done, n.idx);
      }
      return enqueue(n, { read, tIn: now, done });
    }
    if (n.downSince === null) n.downSince = now;
    if (!replicas.length) return fail(n, done);
    const promoted = cfg.failoverS !== null && now - n.downSince >= cfg.failoverS;
    if (!read) return promoted ? hop(replicas[0], read, done, n.idx) : fail(n, done);
    return hop(replicas[Math.floor(rng.next() * replicas.length)], read, done, n.idx);
  }

  /** one call over the network: a hop plus the link's round trip, if it has one */
  const hop = (i: number, read: boolean, done: Done, from = -1) => at(cfg.hopMs + (from >= 0 ? (linkMs.get(from * 100_000 + i) ?? 0) : 0), () => arrive(i, read, done));

  // ---- service pool ----
  function enqueue(n: DNode, job: Job) {
    if (n.busy < n.workers) return start(n, job);
    if (n.queue.length - n.qHead >= n.queueMax) return fail(n, job.done);
    n.queue.push(job);
    const ql = n.queue.length - n.qHead;
    if (ql > n.win.maxQueue) n.win.maxQueue = ql;
  }

  function start(n: DNode, job: Job) {
    setBusy(n, 1);
    let svc = rng.lognormal(n.svcMeanMs, cfg.serviceCv);
    if (n.data.stallRate && rng.next() < n.data.stallRate) svc += n.data.stallMs ?? 0;
    svc += n.data.faultLatencyMs ?? 0;
    if (n.data.kind === 'function') {
      if (n.busy > n.warm) {
        n.warm = n.busy;
        if (cfg.coldStartMs > 0) svc += n.data.runtime ? RUNTIMES[n.data.runtime].coldStartMs : cfg.coldStartMs;
      }
      n.win.usageReqs++;
    }
    at(svc, () => finish(n, job));
  }

  function finish(n: DNode, job: Job) {
    setBusy(n, -1);
    // next in line; shed anything that waited longer than the queue bound
    const bound = (n.data.queueS ?? KINDS[n.data.kind].queueS ?? cfg.queueS) * 1000;
    while (n.qHead < n.queue.length && n.busy < n.workers) {
      const next = n.queue[n.qHead++];
      if ((now - next.tIn) * 1000 > bound) {
        fail(n, next.done);
        continue;
      }
      start(n, next);
    }
    if (n.qHead > 1024 && n.qHead * 2 > n.queue.length) {
      n.queue = n.queue.slice(n.qHead);
      n.qHead = 0;
    }
    afterService(n, job);
  }

  function afterService(n: DNode, job: Job) {
    const kind = n.data.kind;
    if (n.data.faultRate && rng.next() < n.data.faultRate) return fail(n, job.done, 0);
    if (kind === 'cache' || kind === 'cdn') {
      if (rng.next() < (n.data.hitRate ?? 0.85) * cacheWarmth(n.coldAt, now, n.data.warmupS)) {
        n.win.hits++;
        return job.done(true);
      }
      if (!n.children.length) return fail(n, job.done, 0);
    }
    if (kind === 'db' || kind === 'replica') return job.done(true);
    if (!n.children.length) return job.done(kind !== 'lb' && kind !== 'gateway');
    callDownstream(n, job.read, job.done);
  }

  // ---- queue consumers (pull model) ----
  function pump(n: DNode) {
    const consumers = n.children.filter((c) => up(nodes[c]));
    while (n.bHead < n.backlog.length) {
      // pull when some consumer has a free worker
      const free = consumers.find((c) => nodes[c].busy + (nodes[c].queue.length - nodes[c].qHead) < nodes[c].workers);
      if (free === undefined) break;
      const job = n.backlog[n.bHead++];
      n.inflight++;
      arrive(free, job.read, () => {
        n.inflight--;
        pump(n);
      });
    }
    if (n.bHead > 4096 && n.bHead * 2 > n.backlog.length) {
      n.backlog = n.backlog.slice(n.bHead);
      n.bHead = 0;
    }
  }

  // ---- calling children: breaker → retries → deadline → routing ----
  function callDownstream(n: DNode, read: boolean, done: Done) {
    const d = n.data;
    n.win.calls++;
    if (d.breaker && n.br !== 'closed') {
      if (n.br === 'open' && now >= n.brUntil) n.br = 'half';
      if (n.br === 'open' || rng.next() > BREAKER.probe) return at(1, () => done(!!d.fallback));
    }
    const retries = d.retries ?? 0;
    const policy = d.retryPolicy ?? 'immediate';
    if (policy === 'budget') n.retryTokens = Math.min(RETRY_BUDGET.cap, n.retryTokens + RETRY_BUDGET.ratio);

    const attempt = (k: number) => {
      n.win.attempts++;
      let settled = false;
      const settle = (ok: boolean, late = false) => {
        if (settled) return;
        settled = true;
        if (late) n.win.late++;
        if (d.breaker) ok ? n.brOk++ : n.brFail++;
        if (ok) return done(true);
        const canRetry = k < retries && (policy !== 'budget' || n.retryTokens >= 1);
        if (!canRetry) return done(false);
        if (policy === 'budget') n.retryTokens -= 1;
        const delay = policy === 'backoff' ? Math.min(BACKOFF.cap, BACKOFF.baseMs * 2 ** k) * (0.5 + rng.next()) : 1;
        at(delay, () => attempt(k + 1));
      };
      if (d.timeoutMs) at(d.timeoutMs, () => settle(false, true));
      route(n, read, settle);
    };
    attempt(0);
  }

  function route(n: DNode, read: boolean, done: Done) {
    const kind = n.data.kind;
    let kids = n.children;
    if (kind === 'lb' || kind === 'gateway' || kind === 'queue') kids = kids.filter((c) => up(nodes[c]));
    if (!kids.length) return fail(n, done);
    const mode = n.data.routing ?? 'split';
    if (mode === 'fanout') {
      let pending = kids.length;
      let allOk = true;
      for (const c of kids)
        hop(c, read, (ok) => {
          allOk &&= ok;
          if (--pending === 0) done(allOk);
        }, n.idx);
      return;
    }
    if (mode === 'failover') {
      const ordered = failoverOrder(kids.map((k) => ({ k, up: up(nodes[k]), data: nodes[k].data }))).map((x) => x.k);
      const tryAt = (i: number) => hop(ordered[i], read, (ok) => (ok || i + 1 >= ordered.length ? done(ok) : tryAt(i + 1)), n.idx);
      return tryAt(0);
    }
    const degree = Math.max(1, n.data.fanout ?? 1);
    if (degree > 1) {
      // scatter-gather over N partitions; wait for all
      let pending = degree;
      let allOk = true;
      for (let i = 0; i < degree; i++)
        hop(kids[Math.floor(rng.next() * kids.length)], read, (ok) => {
          allOk &&= ok;
          if (--pending === 0) done(allOk);
        }, n.idx);
      return;
    }
    hop(kids[Math.floor(rng.next() * kids.length)], read, done, n.idx);
  }

  // ---- traffic ----
  const tl = sc.traffic?.length ? [...sc.traffic].sort((a, b) => a.at - b.at) : [{ at: 0, rps: sc.rps ?? 500 }];
  const rpsAt = (t: number) => {
    if (t <= tl[0].at) return tl[0].rps;
    for (let i = 1; i < tl.length; i++) if (t <= tl[i].at) return tl[i - 1].rps + ((tl[i].rps - tl[i - 1].rps) * (t - tl[i - 1].at)) / (tl[i].at - tl[i - 1].at);
    return tl[tl.length - 1].rps;
  };
  const clients = nodes.filter((n) => n.data.kind === 'client');
  const userHist = new Histogram();
  const winHist = new Histogram();
  let winReqs = 0;
  let winFail = 0;
  let totalReqs = 0;
  let totalFail = 0;

  /** Poisson arrivals with a time-varying rate: draw a gap; if it overshoots the 250 ms horizon, re-check the rate there without emitting (memoryless, so this is exact thinning). */
  function generate(c: DNode, emit: boolean) {
    const rate = rpsAt(now) / Math.max(1, clients.length);
    if (emit && rate > 0 && c.data.alive) {
      const t0 = now;
      const read = rng.next() < sc.readRatio;
      c.win.arrivals++;
      const finish = (ok: boolean) => {
        const ms = (now - t0) * 1000;
        winReqs++;
        totalReqs++;
        if (ok) {
          winHist.record(ms);
          userHist.record(ms);
        } else {
          winFail++;
          totalFail++;
        }
      };
      if (!c.children.length) finish(false);
      else callDownstream(c, read, finish);
    }
    const gap = rate > 0 ? rng.exp(1 / rate) : Infinity;
    if (gap <= 0.25) q.push(now + gap, () => generate(c, true));
    else q.push(now + 0.25, () => generate(c, false));
  }

  // ---- scenario events ----
  const evLog: DesResult['events'] = [];
  const zones = new Map((spec.zones ?? []).map((z) => [z.id, z.members]));
  for (const ev of sc.events ?? []) {
    q.push(ev.at, () => {
      const r = applyAction(appNodes, ev.action, { inRps: (id) => nodes[index.get(id) ?? -1]?.lastStats?.inRps ?? 0, zoneMembers: (z) => zones.get(z) ?? [] });
      appNodes = r.nodes;
      for (const an of sys()) {
        const n = nodes[index.get(an.id)!];
        n.raw = an.data;
        configure(n);
      }
      evLog.push({ t: r3(now), what: ev.note ?? `${ev.action.type}${'id' in ev.action ? ` ${ev.action.id}` : ''}${r.target && !('id' in ev.action) ? ` → ${r.target}` : ''}` });
    });
  }

  // ---- 1-second sampling: metrics, breakers, warm pools ----
  const timeline: DesResult['timeline'] = [];
  let breach = 0;
  let worst = { t: 0, score: -1 };
  const sample = () => {
    const winS = 1;
    let cost = 0;
    for (const n of nodes) {
      setBusy(n, 0);
      const w = n.win;
      const workers = isFinite(n.workers) ? n.workers : 1;
      const util = n.data.kind === 'queue' ? (n.backlog.length - n.bHead) / QUEUE_BACKLOG_MAX : isFinite(n.rate) ? w.arrivals / Math.max(1e-9, n.rate * winS) : w.busyArea / (workers * winS);
      const billed = n.data.kind === 'function' || n.data.kind === 'llmapi' ? w.usageReqs : n.data.kind === 'client' ? 0 : w.arrivals;
      const usage = billed * requestPrice(n.data) * 3600;
      const costH = costOf(n.scaler ? { ...n.data, instances: billedInstances(n.scaler) } : n.data) + usage;
      cost += costH;
      const stats: NodeStats = {
        inRps: w.arrivals / winS,
        dropRps: w.drops / winS,
        util,
        queue: n.data.kind === 'queue' ? n.backlog.length - n.bHead : n.queue.length - n.qHead,
        latencyMs: 0,
        success: w.arrivals ? 1 - w.drops / w.arrivals : 1,
        hitRps: w.hits / winS,
        reachable: n.pooled ? instancesUp(n.data) : Math.min(1, instancesUp(n.data)),
        lagS: 0,
        coldFrac: 0,
        failover: n.data.kind === 'db' && n.downSince !== null ? (cfg.failoverS !== null && now - n.downSince >= cfg.failoverS ? 'promoted' : 'electing') : 'none',
        costPerHour: costH,
        retryAmp: w.calls ? w.attempts / w.calls : 1,
        breaker: n.data.breaker ? n.br : null,
        lateFrac: w.attempts ? w.late / w.attempts : 0,
        history: [],
        scaling: n.scaler ? { live: n.scaler.live, pending: n.scaler.pending.length, desired: n.scaler.desired } : null,
        warmth: cacheWarmth(n.coldAt, now, n.data.warmupS),
      };
      if ((n.data.kind === 'cache' || n.data.kind === 'cdn') && !up(n)) n.coldAt = now;
      if (n.scaler) {
        const evs = stepScaler(n.scaler, n.raw, now, w.arrivals / winS, perInstanceCapacity(n.raw));
        for (const ev of evs) if (ev.kind !== 'scaled') evLog.push({ t: r3(now), what: `${ev.kind}: ${n.id} ${ev.from} → ${ev.to}` });
        if (evs.length) configure(n);
      }
      n.lastStats = stats;
      n.peakUtil = Math.max(n.peakUtil, util);
      n.utilSum += util;
      n.utilN++;
      const v = nodeView(n.data, stats, true, n.children.length > 0);
      const badness = stats.dropRps + util * 10 + (v.up ? 0 : 1000) + (n.br === 'open' ? 500 : 0) + stats.retryAmp * 20;
      if (badness > n.worst) {
        n.worst = badness;
        n.worstNote = explain(n.data, stats, v)?.text ?? null;
      }
      // breaker state machine on the window's outcomes
      if (n.data.breaker) {
        const total = n.brOk + n.brFail;
        const failRate = total ? n.brFail / total : 0;
        if (n.br === 'closed' && total >= BREAKER.minCalls && failRate > BREAKER.tripFail) [n.br, n.brUntil] = ['open', now + BREAKER.openS];
        else if (n.br === 'half' && total >= 3) {
          if (failRate < BREAKER.closeFail) n.br = 'closed';
          else if (failRate > BREAKER.tripFail) [n.br, n.brUntil] = ['open', now + BREAKER.openS];
        }
        if (n.br !== stats.breaker) evLog.push({ t: r3(now), what: `breaker-${n.br}: ${n.id}` });
        n.brOk = n.brFail = 0;
      }
      if (n.data.kind === 'function') n.warm = Math.max(n.busy, n.warm * Math.exp(-winS / 60));
      n.win = newWin();
    }
    const err = winReqs ? winFail / winReqs : 0;
    const p99 = winHist.quantile(0.99);
    const rps = winReqs / winS;
    timeline.push({ t: r3(now), rps, errorRate: r3(err), p50Ms: Math.round(winHist.quantile(0.5)), p99Ms: Math.round(p99), costPerHour: r3(cost) });
    if (rps > 0.5 && (err > slo.maxErrorRate || p99 > slo.maxP99Ms)) breach += winS;
    const score = err * 10 + p99 / 1000;
    if (score > worst.score) worst = { t: now, score };
    winHist.reset();
    winReqs = winFail = 0;
    if (now + winS <= sc.duration + 1e-9) q.push(now + winS, sample);
  };

  // ---- run ----
  for (const c of clients) q.push(0, () => generate(c, false));
  q.push(1, sample);
  while (q.size && q.peekTime() <= sc.duration + 1e-9) {
    now = q.peekTime();
    q.pop()();
    if (++processed > cfg.maxEvents) {
      evLog.push({ t: r3(now), what: `stopped: event budget (${cfg.maxEvents.toLocaleString('en-US')}) exhausted` });
      break;
    }
  }

  // ---- report ----
  const components: DesResult['components'] = {};
  for (const n of nodes) {
    if (n.data.kind === 'client') continue;
    const v = nodeView(n.data, n.lastStats ?? undefined, true, n.children.length > 0);
    components[n.id] = {
      kind: n.data.kind,
      peakUtil: r3(n.peakUtil),
      meanUtil: r3(n.utilN ? n.utilSum / n.utilN : 0),
      droppedTotal: n.dropsTotal,
      finalStatus: v.failedOver ? 'failed over' : v.up ? v.health : 'down',
      note: n.worstNote,
    };
  }
  const bottlenecks = Object.entries(components)
    .filter(([id, c]) => (c.peakUtil >= 0.7 || c.droppedTotal > 0 || c.finalStatus === 'down') && !(c.droppedTotal === 0 && asyncOnly(id, sys(), edges)))
    .sort((a, b) => b[1].droppedTotal - a[1].droppedTotal || b[1].peakUtil - a[1].peakUtil)
    .slice(0, 5)
    .map(([id, c]) => ({ id, peakUtil: c.peakUtil, droppedTotal: c.droppedTotal, note: c.note }));
  const mean = (k: 'rps' | 'errorRate' | 'p99Ms' | 'costPerHour') => (timeline.length ? timeline.reduce((s, x) => s + x[k], 0) / timeline.length : 0);
  const peak = (k: 'errorRate' | 'p99Ms' | 'costPerHour') => Math.max(0, ...timeline.map((x) => x[k]));

  return {
    engine: 'des',
    seed: cfg.seed,
    architecture: spec.name ?? 'architecture',
    scenario: sc.name ?? (sc.traffic ? 'custom traffic' : `${sc.rps ?? 500} req/s steady`),
    summary: {
      durationS: sc.duration,
      meanRps: Math.round(mean('rps') * 10) / 10,
      meanErrorRate: totalReqs ? r3(totalFail / totalReqs) : 0,
      peakErrorRate: r3(peak('errorRate')),
      p50Ms: Math.round(userHist.quantile(0.5)),
      p90Ms: Math.round(userHist.quantile(0.9)),
      p99Ms: Math.round(userHist.quantile(0.99)),
      p999Ms: Math.round(userHist.quantile(0.999)),
      meanP99Ms: Math.round(mean('p99Ms')),
      peakP99Ms: Math.round(peak('p99Ms')),
      meanCostPerHour: r3(mean('costPerHour')),
      peakCostPerHour: r3(peak('costPerHour')),
      sloCompliance: r3(1 - breach / Math.max(1, timeline.length)),
      sloBreachSeconds: breach,
      requests: totalReqs,
      failedRequests: totalFail,
      worstMomentS: r3(worst.t),
      events: processed,
      wallMs: Math.round(performance.now() - wall0),
    },
    slo,
    timeline,
    components,
    bottlenecks,
    events: evLog,
  };
}
