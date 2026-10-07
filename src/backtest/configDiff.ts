import { parseAllDocuments } from 'yaml';
import type { StrategySpec } from './strategy';

/**
 * A pull request changes deployment config; the backtest needs a strategy. This reads the
 * Kubernetes manifests before and after the change and writes the strategy that says what changed:
 * replica counts, CPU / memory limits, HorizontalPodAutoscalers, and the CPU architecture
 * (nodeSelector / affinity on kubernetes.io/arch).
 *
 * Workloads map to model services by the `bottleneck.dev/service` annotation, else by name.
 */

export interface WorkloadConfig {
  service: string;
  replicas?: number;
  cpu?: number;
  memoryGb?: number;
  arch?: 'x86' | 'arm';
  autoscale?: { min: number; max: number; targetCpu?: number; scaleDownS?: number };
}

type Obj = Record<string, unknown>;
const o = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Obj) : {});
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

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

export function readWorkloads(yamlTexts: string[]): Map<string, WorkloadConfig> {
  const docs: Obj[] = [];
  for (const t of yamlTexts) for (const d of parseAllDocuments(t)) {
    const x = o(d.toJS());
    if (x.kind === 'List') docs.push(...arr(x.items).map(o));
    else if (x.kind) docs.push(x);
  }
  const out = new Map<string, WorkloadConfig>();
  const byName = new Map<string, string>();
  for (const d of docs) {
    if (!['Deployment', 'StatefulSet', 'ReplicaSet'].includes(String(d.kind))) continue;
    const meta = o(d.metadata);
    const name = String(meta.name);
    const service = String(o(meta.annotations)['bottleneck.dev/service'] ?? name);
    const spec = o(d.spec);
    const pod = o(o(spec.template).spec);
    const c = o(arr(pod.containers)[0]);
    const limits = o(o(c.resources).limits);
    const requests = o(o(c.resources).requests);
    const sel = o(pod.nodeSelector);
    const archLabel = sel['kubernetes.io/arch'] ?? sel['beta.kubernetes.io/arch'] ?? (JSON.stringify(pod.affinity ?? {}).includes('arm64') ? 'arm64' : undefined);
    out.set(service, {
      service,
      replicas: spec.replicas === undefined ? 1 : Number(spec.replicas),
      cpu: cpuQuantity(limits.cpu ?? requests.cpu),
      memoryGb: memQuantity(limits.memory ?? requests.memory),
      arch: archLabel === 'arm64' ? 'arm' : 'x86',
    });
    byName.set(name, service);
  }
  for (const d of docs) {
    if (d.kind !== 'HorizontalPodAutoscaler') continue;
    const spec = o(d.spec);
    const target = byName.get(String(o(spec.scaleTargetRef).name));
    if (!target) continue;
    const metric = arr(spec.metrics).map(o).find((m) => o(o(m.resource)).name === 'cpu');
    const util = metric ? Number(o(o(o(metric.resource).target)).averageUtilization ?? o(metric.resource).targetAverageUtilization) : Number(spec.targetCPUUtilizationPercentage ?? 80);
    const down = o(o(o(spec.behavior).scaleDown)).stabilizationWindowSeconds;
    const w = out.get(target)!;
    w.autoscale = { min: Number(spec.minReplicas ?? 1), max: Number(spec.maxReplicas), targetCpu: isFinite(util) ? util / 100 : 0.8, ...(down !== undefined ? { scaleDownS: Number(down) } : {}) };
  }
  return out;
}

/** the strategy that turns `before` into `after`, or null when nothing the model knows changed */
export function strategyFromDiff(before: Map<string, WorkloadConfig>, after: Map<string, WorkloadConfig>, opts: { name?: string; known?: Set<string> } = {}): { strategy: StrategySpec | null; ignored: string[] } {
  const changes: StrategySpec['changes'] = [];
  const ignored: string[] = [];
  const said: string[] = [];
  for (const [svc, b] of after) {
    const a = before.get(svc);
    if (!a) {
      ignored.push(`${svc}: new workload — not in the model yet`);
      continue;
    }
    if (opts.known && !opts.known.has(svc)) {
      ignored.push(`${svc}: no service of that name in the model (annotate it with bottleneck.dev/service)`);
      continue;
    }
    const ch: Record<string, unknown> = { service: svc };
    if (b.autoscale && JSON.stringify(b.autoscale) !== JSON.stringify(a.autoscale)) {
      ch.autoscale = { min: b.autoscale.min, max: b.autoscale.max, targetCpu: b.autoscale.targetCpu, ...(b.autoscale.scaleDownS !== undefined ? { cooldownS: b.autoscale.scaleDownS } : { cooldownS: 300 }), warmupS: 30 };
      said.push(`${svc} autoscale ${b.autoscale.min}–${b.autoscale.max} @ ${Math.round((b.autoscale.targetCpu ?? 0.8) * 100)}% CPU`);
    } else if (!b.autoscale && a.autoscale) {
      ch.replicas = b.replicas ?? 1;
      said.push(`${svc} fixed at ${b.replicas} replicas (autoscaler removed)`);
    } else if (!b.autoscale && b.replicas !== a.replicas) {
      ch.replicas = b.replicas;
      said.push(`${svc} ${a.replicas} → ${b.replicas} replicas`);
    }
    if (b.cpu !== undefined && b.cpu !== a.cpu) {
      ch.cpu = b.cpu;
      said.push(`${svc} CPU ${a.cpu ?? '?'} → ${b.cpu}`);
    }
    if (b.memoryGb !== undefined && b.memoryGb !== a.memoryGb) {
      ch.memoryGb = Math.round(b.memoryGb * 1000) / 1000;
      said.push(`${svc} memory ${a.memoryGb?.toFixed(2) ?? '?'} → ${b.memoryGb.toFixed(2)} GiB`);
    }
    if (b.arch !== a.arch) {
      ch.arch = b.arch;
      said.push(`${svc} → ${b.arch === 'arm' ? 'Graviton (arm64)' : 'x86'}`);
    }
    if (Object.keys(ch).length > 1) changes.push(ch as StrategySpec['changes'][number]);
  }
  for (const svc of before.keys()) if (!after.has(svc)) ignored.push(`${svc}: workload removed — not modelled`);
  if (!changes.length) return { strategy: null, ignored };
  return { strategy: { name: opts.name ?? said.join('; '), description: 'from the pull request diff', changes }, ignored };
}
