import * as wasm from '../../backtest/wasm/hindcast_engine.js';

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
  /** seconds before a replica is promoted, for databases without their own failoverS; null = no automatic failover */
  failoverS: number | null;
  coldStartMs: number;
  /** one-way network hop between components */
  hopMs: number;
  /** safety valve */
  maxEvents: number;
  /** follow a sample of requests hop by hop (off unless given) */
  trace?: TraceConfig;
}

export interface TraceConfig {
  /** journeys kept per component, and failed journeys per component (default 8) */
  perNode?: number;
  /** about this many requests a second are followed (default 40) */
  perSec?: number;
  /** only requests that start in [fromS, toS] */
  fromS?: number;
  toS?: number;
  /** hops per journey (default 64) */
  maxSpans?: number;
}

/** one hop of a request: a call to a component, from the hop at `parent` */
export interface TraceSpan {
  id: string;
  /** the hop that made this call (-1: the user's own) */
  parent: number;
  via: 'call' | 'retry' | 'fanout' | 'failover' | 'routed';
  /** 0 for the first attempt, 1 for the first retry… */
  attempt: number;
  /** ms after the request began */
  sentMs: number;
  arriveMs: number | null;
  startMs: number | null;
  servedMs: number | null;
  endMs: number | null;
  networkMs: number;
  waitMs: number;
  serviceMs: number;
  /** timeout: the caller gave up at its deadline; open: still out when the request ended */
  outcome: 'ok' | 'hit' | 'queued' | 'failed' | 'timeout' | 'open';
  reason: string | null;
  /** the component the failure started at */
  origin: string | null;
  gaveUpMs: number | null;
  deadlineMs: number | null;
}

export interface Journey {
  id: number;
  /** when it began in the run, s */
  atS: number;
  read: boolean;
  ms: number;
  ok: boolean;
  failedAt: string | null;
  reason: string | null;
  truncated: boolean;
  spans: TraceSpan[];
}

export interface TraceReport {
  journeys: Journey[];
  /** per component: indices into journeys through it (a sample), and failed ones */
  byNode: Record<string, { all: number[]; failed: number[]; seen: number; seenFailed: number }>;
}

// ---------------------------------------------------------------------------------------------
// event queue: binary heap keyed by (time, seq)
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// runtime model
// ---------------------------------------------------------------------------------------------

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
    /** p50–p99.9 and the per-second mean/peak p99: successful answers only */
    p99Ms: number;
    p999Ms: number;
    meanP99Ms: number;
    peakP99Ms: number;
    /** the same as p99Ms, under the name both engines use; absent when nothing succeeded */
    p99AnswersMs?: number;
    /** the run's p99 of every request, a failure at the time it took to fail */
    p99WithFailuresMs?: number;
    meanCostPerHour: number;
    peakCostPerHour: number;
    sloCompliance: number;
    sloBreachSeconds: number;
    requests: number;
    failedRequests: number;
    lostWrites?: number;
    deadLetters?: number;
    staleReads?: number;
    maxReplicaLagS?: number;
    worstMomentS: number;
    events: number;
    wallMs: number;
  };
  slo: { maxErrorRate: number; maxP99Ms: number };
  timeline: { t: number; rps: number; errorRate: number; p50Ms: number; p99Ms: number; costPerHour: number }[];
  components: Record<string, { kind: string; peakUtil: number; meanUtil: number; droppedTotal: number; finalStatus: string; note: string | null }>;
  bottlenecks: { id: string; peakUtil: number; droppedTotal: number; note: string | null }[];
  /** why requests failed: the component each failure started at and the cause, most first */
  failures: FailureCause[];
  events: { t: number; what: string }[];
  /** sampled request journeys, when the config asked for them */
  trace?: TraceReport;
}

export interface FailureCause {
  id: string;
  name: string;
  reason: string;
  requests: number;
  /** of all failed requests */
  share: number;
}

export function simulateDes(specInput: unknown, scenarioInput: unknown = {}, cfgIn: Partial<DesConfig> = {}): DesResult {
  return wasm.simulateDes(specInput, scenarioInput, cfgIn) as DesResult;
}
