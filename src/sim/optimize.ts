import {  type Analysis } from './des/analyze';
import { ArchitectureSpec, type ChangeSpec } from '../spec/schema';
import * as wasm from '../backtest/wasm/hindcast_engine.js';

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

export function optimize(specInput: unknown, scenario: Record<string, unknown>, opts: OptimizeOptions = {}): OptimizeResult {
  return wasm.optimize(specInput, scenario, opts) as OptimizeResult;
}
