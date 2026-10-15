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
  /** seconds before a replica is promoted; null = no automatic failover */
  failoverS: number | null;
  coldStartMs: number;
  /** one-way network hop between components */
  hopMs: number;
  /** safety valve */
  maxEvents: number;
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
    lostWrites?: number;
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
