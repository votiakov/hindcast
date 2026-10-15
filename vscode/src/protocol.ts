import type { Path } from './lineMap';

// What the extension asks the engine, and what comes back (worker thread or CLI alike).

export type Request =
  | { id: number; op: 'validate'; value: unknown }
  | { id: number; op: 'summary'; value: unknown; rps?: number }
  | { id: number; op: 'audit'; value: unknown; rps?: number; costPerMinute?: number };

export interface Validation {
  ok: boolean;
  issues: { level: 'error' | 'warning'; message: string; path?: Path }[];
}

/** a short headless run at the design's traffic */
export interface Summary {
  scenario: string;
  p99Ms: number;
  errorRate: number;
  monthly: number;
  sloCompliance: number;
  slo: { maxErrorRate: number; maxP99Ms: number };
  bottleneck: { id: string; note: string | null } | null;
}

export interface AuditDone {
  markdown: string;
  score: number;
  critical: number;
}

export type Progress = { done: number; total: number; label: string };
