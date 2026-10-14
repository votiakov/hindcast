import { parseAllDocuments } from 'yaml';
import type { StrategySpec } from './strategy';
import * as wasm from './wasm/hindcast_engine.js';

/**
 * A pull request changes deployment config; the backtest needs a strategy. This reads the
 * Kubernetes manifests before and after the change and writes the strategy that says what changed:
 * replica counts, CPU / memory limits, HorizontalPodAutoscalers, and the CPU architecture
 * (nodeSelector / affinity on kubernetes.io/arch).
 *
 * Workloads map to model services by the `hindcast.dev/service` annotation (or the pre-rename
 * `bottleneck.dev/service`), else by name.
 */

export interface WorkloadConfig {
  service: string;
  replicas?: number;
  cpu?: number;
  memoryGb?: number;
  /** replicas kept apart by node (topologySpreadConstraints or podAntiAffinity on kubernetes.io/hostname) */
  spread?: boolean;
  /** requests (Kubernetes defaults them to the limits when only limits are set) */
  cpuRequest?: number;
  memoryRequestGb?: number;
  arch?: 'x86' | 'arm';
  autoscale?: { min: number; max: number; targetCpu?: number; scaleDownS?: number };
}

/** "500m" → 0.5, "2" → 2 */
export function cpuQuantity(q: unknown): number | undefined {
  if (q === undefined || q === null) return undefined;
  const s = String(q).trim();
  if (s.endsWith('m')) return parseFloat(s) / 1000;
  const v = parseFloat(s);
  return isFinite(v) ? v : undefined;
}

/** "512Mi" → 0.5, "2Gi" → 2, "1G" → 0.93 (GiB) */
export function memQuantity(q: unknown): number | undefined {
  if (q === undefined || q === null) return undefined;
  const m = /^([\d.]+)\s*(Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(String(q).trim());
  if (!m) return undefined;
  const mult: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };
  return (parseFloat(m[1]) * (m[2] ? mult[m[2]] : 1)) / 2 ** 30;
}

/** every YAML document in the texts, as plain values */
export function yamlDocuments(yamlTexts: string[]): unknown[] {
  const docs: unknown[] = [];
  for (const t of yamlTexts) for (const d of parseAllDocuments(t)) docs.push(d.toJS());
  return docs;
}

export function readWorkloads(yamlTexts: string[]): Map<string, WorkloadConfig> {
  return new Map(wasm.readWorkloads(yamlDocuments(yamlTexts)) as [string, WorkloadConfig][]);
}

/** the strategy that turns `before` into `after`, or null when nothing the model knows changed */
export function strategyFromDiff(before: Map<string, WorkloadConfig>, after: Map<string, WorkloadConfig>, opts: { name?: string; known?: Set<string> } = {}): { strategy: StrategySpec | null; ignored: string[] } {
  return wasm.strategyFromDiff([...before], [...after], opts.name, opts.known ? [...opts.known] : undefined);
}
