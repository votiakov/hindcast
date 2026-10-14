import type { ArchitectureSpec } from './schema';
import * as wasm from '../backtest/wasm/hindcast_engine.js';

/**
 * Terraform → architecture spec.
 *
 * Input: the JSON from `terraform show -json` (a state or a saved plan). Terraform describes
 * resources, not call paths, so the call graph is reconstructed from real references where they
 * exist (target-group ARNs, CloudFront origins, API Gateway integrations, Lambda event sources)
 * and from conventional heuristics otherwise. Every heuristic is reported in `assumptions`.
 */

export interface ImportResult {
  spec: ArchitectureSpec;
  assumptions: string[];
  skipped: string[];
  mapped: { resource: string; component: string }[];
}

export function importTerraform(doc: unknown, name?: string): ImportResult {
  return wasm.importTerraform(doc, name) as ImportResult;
}
