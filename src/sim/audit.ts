import {  type CurvePoint } from './headless';
import {  type ChangeSpec } from '../spec/schema';
import * as wasm from '../backtest/wasm/hindcast_engine.js';

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

export function audit(specInput: unknown, opts: AuditOptions = {}): AuditResult {
  const { onProgress, ...o } = opts;
  return wasm.audit(specInput, o, onProgress) as AuditResult;
}

// ---------------------------------------------------------------------------------------------
// fix generators — every candidate is verified against the incident before it is reported
// ---------------------------------------------------------------------------------------------
