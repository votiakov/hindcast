import type { StrategySpec } from './strategy';
import { cpuQuantity, memQuantity } from './configDiff';

/**
 * A Terraform plan (`terraform show -json plan.out`) → the strategy it amounts to, so an agent that
 * edits Terraform can backtest its own change before anyone applies it. Reads, before and after:
 *
 *  - aws_ecs_service: desired_count
 *  - aws_ecs_task_definition: cpu, memory, runtime_platform.cpu_architecture
 *  - aws_appautoscaling_target + aws_appautoscaling_policy (ECS target tracking on CPU)
 *  - aws_autoscaling_group: desired / min / max; aws_launch_template and aws_instance: instance_type
 *  - aws_db_instance / aws_rds_cluster_instance: instance_class, read replicas
 *  - google_cloud_run_v2_service / google_cloud_run_service: scaling and container limits
 *  - kubernetes_deployment(_v1) / kubernetes_stateful_set(_v1): replicas and container limits
 *
 * Resources map to model services by the `hindcast:service` tag or label (`hindcast.dev/service`,
 * `hindcast-service`, or the pre-rename `bottleneck:*` forms), else by name.
 * Anything else that changes is listed as ignored, with the reason.
 */

type Obj = Record<string, unknown>;
const o = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Obj) : {});
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const first = (x: unknown): Obj => o(arr(x)[0] ?? x);
const num = (x: unknown): number | undefined => (x === null || x === undefined || x === '' ? undefined : isFinite(Number(x)) ? Number(x) : undefined);

export interface ResourceChange {
  address: string;
  type: string;
  name: string;
  change: { actions: string[]; before: Obj | null; after: Obj | null };
}

interface Workload {
  replicas?: number;
  cpu?: number;
  memoryGb?: number;
  arch?: 'x86' | 'arm';
  autoscale?: { min?: number; max?: number; targetCpu?: number; cooldownS?: number };
  readReplicas?: number;
}

/** Graviton instance families (m6g, c7g, r8g, t4g, x2gd, im4gn …) */
const ARM_FAMILY = /^(?:db\.|cache\.)?[a-z]+\d+g[a-z]*\./;
const SIZE_VCPU: Record<string, number> = { nano: 2, micro: 2, small: 2, medium: 1, large: 2, xlarge: 4, '2xlarge': 8, '3xlarge': 12, '4xlarge': 16, '6xlarge': 24, '8xlarge': 32, '9xlarge': 36, '12xlarge': 48, '16xlarge': 64, '18xlarge': 72, '24xlarge': 96, '32xlarge': 128, '48xlarge': 192, metal: 96 };
const SIZE_GB_PER_VCPU: Record<string, number> = { c: 2, m: 4, r: 8, x: 16, t: 2 };

type NativeTerraform = {
  instanceType: (t: string) => { cpu?: number; memoryGb?: number; arch: 'x86' | 'arm' };
  strategyFromTerraformPlan: (plan: unknown, name?: string, known?: string[]) => { strategy: StrategySpec | null; ignored: string[]; mapped: string[] };
};
let native: NativeTerraform | null = null;
/** the compiled engine's Terraform reading (src/backtest/native.ts) */
export function setNativeTerraform(n: NativeTerraform | null) {
  native = n;
}

/** an EC2 / RDS / ElastiCache instance type → vCPU, memory and architecture (approximate for odd families) */
export function instanceType(t: string): { cpu?: number; memoryGb?: number; arch: 'x86' | 'arm' } {
  return native ? native.instanceType(t) : instanceTypeTs(t);
}

export function instanceTypeTs(t: string): { cpu?: number; memoryGb?: number; arch: 'x86' | 'arm' } {
  const bare = t.replace(/^(db|cache)\./, '');
  const [family = '', size = ''] = bare.split('.');
  const arch = ARM_FAMILY.test(t) ? 'arm' : 'x86';
  const burst = family.startsWith('t');
  const cpu = burst ? (size === 'nano' || size === 'micro' || size === 'small' || size === 'medium' || size === 'large' ? 2 : SIZE_VCPU[size]) : SIZE_VCPU[size];
  const perVcpu = SIZE_GB_PER_VCPU[family[0]];
  const tMem: Record<string, number> = { nano: 0.5, micro: 1, small: 2, medium: 4, large: 8, xlarge: 16, '2xlarge': 32 };
  const memoryGb = burst ? tMem[size] : cpu && perVcpu ? cpu * perVcpu : undefined;
  return { cpu, memoryGb, arch };
}

/** the tag/label naming a resource's model service; the pre-rename bottleneck ones still count */
const SERVICE_TAGS = ['hindcast:service', 'hindcast.dev/service', 'hindcast-service', 'bottleneck:service', 'bottleneck.dev/service', 'bottleneck-service'];
const SERVICE_ANNOTATIONS = ['hindcast.dev/service', 'bottleneck.dev/service'];

const tagOf = (v: Obj | null): string | undefined => {
  if (!v) return undefined;
  for (const k of ['tags', 'tags_all', 'labels', 'user_labels']) {
    const t = o(v[k]);
    const s = SERVICE_TAGS.map((k) => t[k]).find((x) => x);
    if (s) return String(s);
  }
  const meta = first(v.metadata);
  const ann = o(meta.annotations);
  const a = SERVICE_ANNOTATIONS.map((k) => ann[k]).find((x) => x);
  if (a) return String(a);
  return undefined;
};

const nameOf = (r: ResourceChange, v: Obj | null): string => {
  const meta = first(v?.metadata);
  return String(tagOf(v) ?? v?.name ?? v?.family ?? meta.name ?? v?.identifier ?? r.name);
};

function readWorkload(r: ResourceChange, v: Obj | null): { service: string; w: Workload } | null {
  if (!v) return null;
  const service = nameOf(r, v);
  switch (r.type) {
    case 'aws_ecs_service':
      return { service, w: { replicas: num(v.desired_count) } };
    case 'aws_ecs_task_definition': {
      const cpuUnits = num(v.cpu);
      const memMib = num(v.memory);
      const arch = String(first(v.runtime_platform).cpu_architecture ?? 'X86_64').toUpperCase() === 'ARM64' ? 'arm' : 'x86';
      return { service, w: { cpu: cpuUnits !== undefined ? cpuUnits / 1024 : undefined, memoryGb: memMib !== undefined ? memMib / 1024 : undefined, arch } };
    }
    case 'aws_autoscaling_group': {
      const min = num(v.min_size);
      const max = num(v.max_size);
      return { service, w: { replicas: num(v.desired_capacity) ?? min, ...(min !== undefined && max !== undefined && min !== max ? { autoscale: { min, max } } : {}) } };
    }
    case 'aws_launch_template':
    case 'aws_instance': {
      const t = v.instance_type ? instanceTypeTs(String(v.instance_type)) : undefined;
      return t ? { service, w: { cpu: t.cpu, memoryGb: t.memoryGb, arch: t.arch } } : null;
    }
    case 'aws_db_instance':
    case 'aws_rds_cluster_instance': {
      const t = v.instance_class ? instanceTypeTs(String(v.instance_class)) : undefined;
      return t ? { service, w: { cpu: t.cpu, memoryGb: t.memoryGb, arch: t.arch } } : null;
    }
    case 'google_cloud_run_v2_service': {
      const tpl = first(v.template);
      const scaling = first(tpl.scaling);
      const limits = o(first(first(tpl.containers).resources).limits);
      return { service, w: { cpu: cpuQuantity(limits.cpu), memoryGb: memQuantity(limits.memory), autoscale: { min: num(scaling.min_instance_count) ?? 0, max: num(scaling.max_instance_count) ?? 100 } } };
    }
    case 'google_cloud_run_service': {
      const tpl = first(v.template);
      const ann = o(first(tpl.metadata).annotations);
      const limits = o(first(first(first(tpl.spec).containers).resources).limits);
      return { service, w: { cpu: cpuQuantity(limits.cpu), memoryGb: memQuantity(limits.memory), autoscale: { min: num(ann['autoscaling.knative.dev/minScale']) ?? 0, max: num(ann['autoscaling.knative.dev/maxScale']) ?? 100 } } };
    }
    case 'kubernetes_deployment':
    case 'kubernetes_deployment_v1':
    case 'kubernetes_stateful_set':
    case 'kubernetes_stateful_set_v1': {
      const spec = first(v.spec);
      const pod = first(first(spec.template).spec);
      const c = first(pod.container);
      const res = first(c.resources);
      const limits = { ...o(res.requests), ...o(res.limits) };
      const sel = o(pod.node_selector);
      return { service, w: { replicas: num(spec.replicas) ?? 1, cpu: cpuQuantity(limits.cpu), memoryGb: memQuantity(limits.memory), arch: sel['kubernetes.io/arch'] === 'arm64' ? 'arm' : 'x86' } };
    }
  }
  return null;
}

/** "service/<cluster>/<name>" → name */
const ecsServiceFromResourceId = (id: unknown) => (typeof id === 'string' && id.startsWith('service/') ? id.split('/').pop() : undefined);

function autoscaling(changes: ResourceChange[], side: 'before' | 'after'): Map<string, NonNullable<Workload['autoscale']>> {
  const out = new Map<string, NonNullable<Workload['autoscale']>>();
  const byAddress = new Map<string, string>();
  for (const r of changes) {
    const v = r.change[side];
    if (r.type !== 'aws_appautoscaling_target' || !v) continue;
    const svc = tagOf(v) ?? ecsServiceFromResourceId(v.resource_id);
    if (!svc) continue;
    out.set(svc, { min: num(v.min_capacity), max: num(v.max_capacity) });
    byAddress.set(String(v.resource_id), svc);
  }
  for (const r of changes) {
    const v = r.change[side];
    if (r.type !== 'aws_appautoscaling_policy' || !v) continue;
    const svc = byAddress.get(String(v.resource_id)) ?? ecsServiceFromResourceId(v.resource_id);
    const cfg = first(v.target_tracking_scaling_policy_configuration);
    const metric = String(first(cfg.predefined_metric_specification).predefined_metric_type ?? '');
    if (!svc || !metric.includes('CPU')) continue;
    const a = out.get(svc) ?? {};
    out.set(svc, { ...a, targetCpu: (num(cfg.target_value) ?? 60) / 100, ...(num(cfg.scale_in_cooldown) !== undefined ? { cooldownS: num(cfg.scale_in_cooldown) } : {}) });
  }
  return out;
}

const READS = new Set(['aws_db_instance']);

/** match a resource's service name to a model service: exact, then by containment ("orders-api" ↔ "orders") */
export function matchService(name: string, known?: Set<string>): string | undefined {
  if (!known) return name;
  if (known.has(name)) return name;
  const n = name.toLowerCase();
  const hits = [...known].filter((k) => n.includes(k.toLowerCase()) || k.toLowerCase().includes(n));
  return hits.length === 1 ? hits[0] : undefined;
}

export function strategyFromTerraformPlan(plan: unknown, opts: { name?: string; known?: Set<string> } = {}): { strategy: StrategySpec | null; ignored: string[]; mapped: string[] } {
  return native ? native.strategyFromTerraformPlan(plan, opts.name, opts.known ? [...opts.known] : undefined) : strategyFromTerraformPlanTs(plan, opts);
}

export function strategyFromTerraformPlanTs(plan: unknown, opts: { name?: string; known?: Set<string> } = {}): { strategy: StrategySpec | null; ignored: string[]; mapped: string[] } {
  const changes = arr(o(plan).resource_changes).map((x) => x as ResourceChange).filter((r) => r?.change && !(r.change.actions.length === 1 && r.change.actions[0] === 'no-op'));
  const ignored: string[] = [];
  const mapped: string[] = [];
  const before = new Map<string, Workload>();
  const after = new Map<string, Workload>();
  const merge = (m: Map<string, Workload>, svc: string, w: Workload) => {
    const cur = m.get(svc) ?? {};
    for (const [k, v] of Object.entries(w)) if (v !== undefined) (cur as Record<string, unknown>)[k] = v;
    m.set(svc, cur);
  };
  const resolve = (r: ResourceChange, raw: string): string | undefined => {
    const svc = matchService(raw, opts.known);
    if (!svc) ignored.push(`${r.address}: "${raw}" matches no service in the model — tag it hindcast:service`);
    return svc;
  };
  // read replicas of a database: new aws_db_instance resources pointing at a source
  const replicaCount = (side: 'before' | 'after') => {
    const counts = new Map<string, number>();
    for (const r of changes) {
      const v = r.change[side];
      if (!v || !READS.has(r.type) || !v.replicate_source_db) continue;
      const src = String(v.replicate_source_db);
      const owner = changes.find((x) => x.change[side]?.identifier === src || x.name === src);
      const svc = owner ? nameOf(owner, owner.change[side]) : src;
      counts.set(svc, (counts.get(svc) ?? 0) + 1);
    }
    return counts;
  };

  const handled = new Set(['aws_appautoscaling_target', 'aws_appautoscaling_policy']);
  for (const r of changes) {
    if (handled.has(r.type)) continue;
    if (READS.has(r.type) && (r.change.after?.replicate_source_db || r.change.before?.replicate_source_db)) continue;
    const b = readWorkload(r, r.change.before);
    const a = readWorkload(r, r.change.after);
    if (!a && !b) {
      ignored.push(`${r.address}: ${r.type} is not something the backtest models (${r.change.actions.join('/')})`);
      continue;
    }
    if (!b && a) {
      ignored.push(`${r.address}: new ${r.type} — not in the model yet`);
      continue;
    }
    if (b && !a) {
      ignored.push(`${r.address}: ${r.type} destroyed — not modelled`);
      continue;
    }
    const svc = resolve(r, a!.service);
    if (!svc) continue;
    mapped.push(`${r.address} → ${svc}`);
    merge(before, svc, b!.w);
    merge(after, svc, a!.w);
  }
  for (const [side, m] of [['before', before], ['after', after]] as const)
    for (const [raw, a] of autoscaling(changes, side)) {
      const svc = matchService(raw, opts.known);
      if (!svc) continue;
      merge(m, svc, { autoscale: { ...(m.get(svc)?.autoscale ?? {}), ...a } });
    }
  for (const [side, m] of [['before', before], ['after', after]] as const)
    for (const [raw, n] of replicaCount(side)) {
      const svc = matchService(raw, opts.known);
      if (svc) merge(m, svc, { readReplicas: n });
    }

  const out: StrategySpec['changes'] = [];
  const said: string[] = [];
  for (const [svc, a] of after) {
    const b = before.get(svc) ?? {};
    const ch: Record<string, unknown> = { service: svc };
    if (a.autoscale && JSON.stringify(a.autoscale) !== JSON.stringify(b.autoscale) && a.autoscale.max !== undefined) {
      const min = a.autoscale.min ?? 1;
      ch.autoscale = { min, max: a.autoscale.max, targetCpu: a.autoscale.targetCpu ?? 0.6, cooldownS: a.autoscale.cooldownS ?? 300, warmupS: 60, metricWindowS: 60 };
      said.push(`${svc} autoscale ${min}–${a.autoscale.max} @ ${Math.round((a.autoscale.targetCpu ?? 0.6) * 100)}% CPU`);
    } else if (a.replicas !== undefined && a.replicas !== b.replicas && !a.autoscale) {
      ch.replicas = a.replicas;
      said.push(`${svc} ${b.replicas ?? '?'} → ${a.replicas} replicas`);
    }
    if (a.cpu !== undefined && a.cpu !== b.cpu) {
      ch.cpu = a.cpu;
      said.push(`${svc} CPU ${b.cpu ?? '?'} → ${a.cpu}`);
    }
    if (a.memoryGb !== undefined && a.memoryGb !== b.memoryGb) {
      ch.memoryGb = Math.round(a.memoryGb * 1000) / 1000;
      said.push(`${svc} memory ${b.memoryGb?.toFixed(2) ?? '?'} → ${a.memoryGb.toFixed(2)} GB`);
    }
    if (a.arch && a.arch !== (b.arch ?? 'x86')) {
      ch.arch = a.arch;
      said.push(`${svc} → ${a.arch === 'arm' ? 'Graviton (Arm)' : 'x86'}`);
    }
    if (a.readReplicas !== undefined && a.readReplicas !== (b.readReplicas ?? 0)) {
      ch.readReplicas = a.readReplicas;
      said.push(`${svc} ${b.readReplicas ?? 0} → ${a.readReplicas} read replicas`);
    }
    if (Object.keys(ch).length > 1) out.push(ch as StrategySpec['changes'][number]);
  }
  if (!out.length) return { strategy: null, ignored, mapped };
  return { strategy: { name: opts.name ?? said.join('; '), description: 'from the Terraform plan', changes: out }, ignored, mapped };
}
