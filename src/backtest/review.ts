import type { Dataset } from './dataset';
import type { Model } from './model';
import * as wasm from './wasm/hindcast_engine.js';

/**
 * The capacity review (engine-rs/src/review/capacity.rs, the same code as the CLI's and the agents'
 * `review_capacity`): headroom and what binds first, the recorded day and 1.5× / 2× days, a node lost
 * at the busiest moment, the limits that bind, the node pool, what to commit to, and the fixes and
 * savings that passed their backtests. Nothing here computes; these are the shapes it answers in.
 */

/** one of the summary's lines: "Risk", "Headroom", "Cost", "Do this", "Trust" (and "Headroom
 *  uncertain", "Also check" where they apply); the sentence keeps its Markdown **emphasis** */
export interface ReviewLine {
  label: string;
  text: string;
}

export interface ReviewDay {
  scale?: number;
  minutesOutOfSlo: number;
  failedRequests: number;
  worst: string;
  holds: boolean;
  monthly?: number;
}

export interface ReviewChange {
  name: string;
  description?: string;
  changes: Record<string, unknown>[];
}

export interface ReviewFix {
  name: string;
  minutesOutOfSloDelta: number;
  failedRequestsDelta: number;
  monthlyDelta: number;
  verdict: 'pass' | 'fail' | 'inconclusive';
  confidence?: 'high' | 'medium' | 'low';
  summary?: string;
  change: ReviewChange;
}

export interface ReviewSaving {
  name: string;
  minutesOutOfSloDelta: number;
  failedRequestsDelta: number;
  monthlyDelta: number;
  verdict: 'pass' | 'fail' | 'inconclusive';
  confidence?: 'high' | 'medium' | 'low';
  summary?: string;
  change: ReviewChange;
}

export interface ReviewStuckCallers {
  node: string;
  minutesOutOfSlo: number;
  failedRequests: number;
  answer: { minutesOutOfSlo: number; failedRequests: number };
  reconnectS: number;
  calls: [string, string][];
  verdict: string;
  cutShort: boolean;
  /** the sentence the report says it in, an assumption */
  said: string;
}

export interface CapacityReview {
  system: string;
  noTraffic?: boolean;
  history: { from: string; to: string; peakRps: number };
  slo: { p99Ms: number; errorRate: number };
  headroom: { rps: number; limitedBy: string | null; overPeak: number | null; limitTrusted: boolean; limitFromCpu?: boolean; atAnyLoad?: string };
  stability: { windows: { from: string; to: string; rps: number; limitedBy: string | null; atAnyLoad?: string }[]; low?: number; high?: number; highOpen?: boolean; uncertain?: boolean; configurations: number };
  today: ReviewDay & { monthly: number };
  trust: { services: number; fit: number; untrusted: string[]; heldOutP99: { error: number; pass: boolean } | null; cpuOnly?: string[]; withoutTraces?: string };
  busier: (ReviewDay & { scale: number })[];
  nodeLoss: {
    survives: boolean;
    worst: { node: string; minutesOutOfSlo: number; failedRequests: number; down: string[] } | null;
    singlePointsOfFailure: string[];
    fix: { change: ReviewChange; survives: boolean; worstAfter: { node: string; minutesOutOfSlo: number; verdict: string; worst: string } | null; monthlyDelta: number } | null;
    ifCallersStayBroken?: ReviewStuckCallers;
  } | null;
  restartRisks?: { service: string; callers: string[] }[];
  throttled: { service: string; kneeShareOfLimit: number; cpuLimit: number; perReplicaRps: number }[];
  memoryNearLimit: { service: string; peakMiB: number; limitMiB: number; share: number; leakMiBPer1000?: number; requestsToLimit?: number }[];
  fixes: ReviewFix[];
  savings: ReviewSaving[];
  nodePool: { nodes: number; autoscaled: boolean; node: { cpu: number; memoryGb: number; perHour: number }; peakFill: number; wouldFit: number; monthlyPerNode: number } | null;
  commitment: { floor: number; unit: string; onDemandMonthly: number; options: { term: string; savesMonthly: number }[]; basis: string } | null;
  /** why there is no commitment to read, where there is none */
  commitmentAbsent?: string;
  combinedSavings: { name: string; monthlyDelta: number; minutesOutOfSloDelta: number; failedRequestsDelta: number; verdict: string; confidence?: 'high' | 'medium' | 'low'; change: ReviewChange } | null;
  summary: ReviewLine[];
  /** the open history's requests per second, bucket by bucket, and its busiest bucket (history.peakRps
   *  is the busiest moment of the history the model was calibrated on, which may be longer) */
  traffic: { start: number; stepS: number; rps: number[]; peakRps: number };
  /** the same review as review_capacity writes it */
  markdown: string;
}

export function reviewCapacity(model: Model, d: Dataset, o: { draws?: number } = {}, onProgress?: (label: string, done: number, total: number) => void): CapacityReview {
  return wasm.reviewCapacity(model, d, o, onProgress) as CapacityReview;
}
