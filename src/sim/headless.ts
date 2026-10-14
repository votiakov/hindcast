import { KINDS, RUNTIMES, TIERS } from './catalog';
import {  type EngineConfig } from './engine';
import { PRICING, getPricing } from './pricing';
import { ArchitectureSpec, type VariantSpec } from '../spec/schema';
import * as wasm from '../backtest/wasm/hindcast_engine.js';

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

export function simulate(specInput: unknown, scenarioInput: unknown = {}, opts: SimOptions = {}): SimResult {
  return wasm.simulate(specInput, scenarioInput, opts) as SimResult;
}

export interface CompareResult {
  ranked: CompareRow[];
  results: { name: string; spec: ArchitectureSpec; result: SimResult }[];
}

export interface BreakingPoint {
  maxRps: number;
  firstFailingRps?: number;
  limitedBy: string | null;
  note: string | null;
  slo: { maxErrorRate: number; maxP99Ms: number };
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
export function compare(baseInput: unknown, variants: VariantSpec[], scenario: unknown = {}, opts: SimOptions = {}): CompareResult {
  return wasm.compareVariants(baseInput, variants, scenario, opts) as CompareResult;
}

/**
 * Highest constant load the architecture sustains within SLO (steady state).
 * Exponential search for an upper bound, then binary search.
 */
type BreakingOpts = { readRatio?: number; slo?: { maxErrorRate?: number; maxP99Ms?: number }; holdS?: number; maxRps?: number; cfg?: Partial<EngineConfig> };
export function breakingPoint(specInput: unknown, opts: BreakingOpts = {}): BreakingPoint {
  return wasm.breakingPoint(specInput, opts) as BreakingPoint;
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
  return wasm.loadCurve(specInput, opts) as CurvePoint[];
}
