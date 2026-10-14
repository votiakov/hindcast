import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { initSync, importBundle as importBundleRs, readWorkloads as readWorkloadsRs, strategyFromDiff as strategyFromDiffRs } from '../src/backtest/wasm/hindcast_engine.js';
import { readWorkloadsTs, strategyFromDiffTs, yamlDocuments } from '../src/backtest/configDiff';
import { instanceTypeTs, strategyFromTerraformPlanTs } from '../src/backtest/terraformDiff';
import * as W from '../src/backtest/wasm/hindcast_engine.js';
import { importBundleTs, ImportManifest } from '../src/backtest/import/manifest';
import { fileAccess } from '../cli/files';

/**
 * The Rust importers (engine-rs/src/import) against the TypeScript ones: every import manifest in the
 * repository goes through both, and the datasets and logs must agree.
 */
type Diff = { where: string; ts: unknown; rs: unknown };

function compare(a: unknown, b: unknown, where: string, out: Diff[]) {
  if (out.length > 20) return;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return;
    if (a === b) return;
    const tol = 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
    if (!(Math.abs(a - b) <= tol)) out.push({ where, ts: a, rs: b });
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return void out.push({ where: `${where}.length`, ts: a.length, rs: b.length });
    for (let i = 0; i < a.length; i++) compare(a[i], b[i], `${where}[${i}]`, out);
    return;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined).sort();
    const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined && (b as Record<string, unknown>)[k] !== null).sort();
    const ka2 = ka.filter((k) => (a as Record<string, unknown>)[k] !== null || kb.includes(k));
    if (ka2.join() !== kb.join()) return void out.push({ where: `${where} keys`, ts: ka2, rs: kb });
    for (const k of kb) compare((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${where}.${k}`, out);
    return;
  }
  if (a !== b) out.push({ where, ts: a, rs: b });
}

function manifests(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) manifests(p, out);
    else if (/^(bottleneck|hindcast)\.import\.yaml$/.test(e)) out.push(p);
  }
  return out;
}

beforeAll(() => initSync({ module: readFileSync('src/backtest/wasm/hindcast_engine_bg.wasm') }));

const all = [...manifests('demos'), ...manifests('reference')].sort();

describe.each(all)('Rust import matches TypeScript on %s', (path) => {
  it('dataset and log', () => {
    const m = ImportManifest.parse(parse(readFileSync(path, 'utf8')));
    const fs = fileAccess(path);
    const ts = importBundleTs(m, fs);
    const rs = importBundleRs(m, fs);
    const diffs: Diff[] = [];
    compare(JSON.parse(JSON.stringify(ts)), JSON.parse(JSON.stringify(rs)), 'import', diffs);
    expect(diffs).toEqual([]);
  });
});

const k8s = ['examples/backtest-ci/deploy/hotrod.yaml', 'examples/kubernetes/shop.yaml', 'reference/k8s/shop/shop.yaml', ...(existsSync('reference/k8s/shop/variants') ? readdirSync('reference/k8s/shop/variants').map((f) => `reference/k8s/shop/variants/${f}`) : [])].filter(existsSync);

describe('Rust config diff matches TypeScript', () => {
  // each manifest alone, and the reference shop with every variant laid over it (later documents win)
  const sets: [string, string[]][] = [...k8s.map((f): [string, string[]] => [f, [readFileSync(f, 'utf8')]]), ...k8s.filter((f) => f.includes('/variants/')).map((f): [string, string[]] => [`shop + ${f}`, [readFileSync('reference/k8s/shop/shop.yaml', 'utf8'), readFileSync(f, 'utf8')]])];
  it.each(sets)('workloads of %s', (_, texts) => {
    const diffs: Diff[] = [];
    compare(JSON.parse(JSON.stringify([...readWorkloadsTs(texts)])), readWorkloadsRs(yamlDocuments(texts)), 'workloads', diffs);
    expect(diffs).toEqual([]);
  });
  it('the strategy between every pair', () => {
    const diffs: Diff[] = [];
    for (const [a, ta] of sets)
      for (const [b, tb] of sets) {
        const wa = readWorkloadsTs(ta);
        const wb = readWorkloadsTs(tb);
        const known = new Set([...wa.keys()].slice(1));
        for (const opts of [{}, { known }, { name: 'x' }]) {
          const ts = strategyFromDiffTs(wa, wb, opts);
          const rs = strategyFromDiffRs([...wa], [...wb], (opts as { name?: string }).name, 'known' in opts ? [...known] : undefined);
          compare(JSON.parse(JSON.stringify(ts)), rs, `${a} → ${b}`, diffs);
        }
      }
    expect(diffs).toEqual([]);
  });
});

describe('Rust Terraform plan reading matches TypeScript', () => {
  it('instance types', () => {
    const diffs: Diff[] = [];
    for (const t of ['m7g.xlarge', 'db.r6g.large', 'c5.2xlarge', 't3.micro', 't4g.nano', 't3.2xlarge', 't3.4xlarge', 'x2gd.metal', 'cache.r7g.12xlarge', 'im4gn.large', 'z1d.large', 'm5', '', 'weird', 'db.m5.24xlarge', 'r8g.48xlarge'])
      compare(JSON.parse(JSON.stringify(instanceTypeTs(t))), W.instanceType(t), t, diffs);
    expect(diffs).toEqual([]);
  });

  // plans built from every resource type the reader knows, in many combinations
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];
  const maybe = <T,>(x: T, p = 0.5): T | undefined => (rnd() < p ? x : undefined);
  const names = ['customer', 'frontend', 'route', 'driver', 'orders-api', 'db', 'cache'];
  const side = (type: string, name: string): Record<string, unknown> | null => {
    const tags = pick([undefined, {}, { 'hindcast:service': pick(names) }, { 'bottleneck-service': pick(names) }, { 'hindcast:service': '' }]);
    switch (type) {
      case 'aws_ecs_service': return { name, desired_count: pick([1, 2, 3, '4', null, '']), tags };
      case 'aws_ecs_task_definition': return { family: name, cpu: pick(['256', '1024', 2048, null]), memory: pick(['512', '2048', 4096, undefined]), runtime_platform: pick([[{ cpu_architecture: 'ARM64' }], [{ cpu_architecture: 'X86_64' }], [], undefined, { cpu_architecture: 'arm64' }]) };
      case 'aws_autoscaling_group': return { name, min_size: pick([1, 2, 3]), max_size: pick([2, 3, 10]), desired_capacity: pick([undefined, 2, 5]), tags_all: tags };
      case 'aws_launch_template': case 'aws_instance': return { name, instance_type: pick(['m5.large', 'm7g.large', 'c6g.2xlarge', 't3.micro', '', undefined]) };
      case 'aws_db_instance': return { identifier: name, instance_class: pick(['db.r6g.large', 'db.m5.xlarge']), replicate_source_db: maybe(pick(['db', 'orders-db']), 0.3) };
      case 'aws_rds_cluster_instance': return { identifier: name, instance_class: pick(['db.r6g.large', 'db.r5.2xlarge']) };
      case 'google_cloud_run_v2_service': return { name, labels: tags, template: [{ scaling: [{ min_instance_count: pick([0, 1, undefined]), max_instance_count: pick([10, 100, undefined]) }], containers: [{ resources: [{ limits: { cpu: pick(['1', '2', '500m']), memory: pick(['512Mi', '1Gi', '2G']) } }] }] }] };
      case 'google_cloud_run_service': return { name, template: [{ metadata: [{ annotations: { 'autoscaling.knative.dev/minScale': pick(['1', '0', undefined]), 'autoscaling.knative.dev/maxScale': pick(['5', '50']) } }], spec: [{ containers: [{ resources: [{ limits: { cpu: '1', memory: pick(['256Mi', '1Gi']) } }] }] }] }] };
      case 'kubernetes_deployment': case 'kubernetes_stateful_set_v1': return { metadata: [{ name, annotations: maybe({ 'hindcast.dev/service': pick(names) }, 0.3) }], spec: [{ replicas: pick([1, 2, 3, undefined]), template: [{ spec: [{ node_selector: maybe({ 'kubernetes.io/arch': pick(['arm64', 'amd64']) }), container: [{ resources: [{ limits: maybe({ cpu: pick(['1', '750m']), memory: '1Gi' }), requests: { cpu: pick(['250m', '1']), memory: pick(['512Mi', '2Gi']) } }] }] }] }] }] };
      case 'aws_appautoscaling_target': return { resource_id: `service/prod/${name}`, min_capacity: pick([1, 2]), max_capacity: pick([4, 8, undefined]), tags: maybe({ 'hindcast:service': pick(names) }, 0.2) };
      case 'aws_appautoscaling_policy': return { resource_id: `service/prod/${name}`, target_tracking_scaling_policy_configuration: [{ target_value: pick([50, 70, undefined]), scale_in_cooldown: maybe(pick([60, 120])), predefined_metric_specification: [{ predefined_metric_type: pick(['ECSServiceAverageCPUUtilization', 'ECSServiceAverageMemoryUtilization']) }] }] };
      default: return { bucket: name };
    }
  };
  const types = ['aws_ecs_service', 'aws_ecs_task_definition', 'aws_autoscaling_group', 'aws_launch_template', 'aws_instance', 'aws_db_instance', 'aws_rds_cluster_instance', 'google_cloud_run_v2_service', 'google_cloud_run_service', 'kubernetes_deployment', 'kubernetes_stateful_set_v1', 'aws_appautoscaling_target', 'aws_appautoscaling_policy', 'aws_s3_bucket'];
  const plans = Array.from({ length: 400 }, () => ({
    resource_changes: Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => {
      const type = pick(types);
      const name = pick(names);
      const act = pick([['update'], ['create'], ['delete'], ['no-op'], ['create', 'delete']]);
      return { address: `${type}.${name}`, type, name, change: { actions: act, before: act[0] === 'create' && act.length === 1 ? null : side(type, name), after: act[0] === 'delete' ? null : side(type, name) } };
    }),
  }));

  it('400 generated plans, with and without the model services known', () => {
    const diffs: Diff[] = [];
    plans.forEach((plan0, i) => {
      const plan = JSON.parse(JSON.stringify(plan0));
      for (const opts of [{}, { known: new Set(['customer', 'frontend', 'route', 'driver', 'orders']) }, { name: 'n' }] as { name?: string; known?: Set<string> }[]) {
        const ts = strategyFromTerraformPlanTs(plan, opts);
        const rs = W.strategyFromTerraformPlan(plan, opts.name, opts.known ? [...opts.known] : undefined);
        compare(JSON.parse(JSON.stringify(ts)), rs, `plan ${i} ${JSON.stringify(Object.keys(opts))}`, diffs);
      }
    });
    expect(diffs).toEqual([]);
    // the corpus reaches the branches that matter
    const all = plans.map((p) => JSON.stringify(strategyFromTerraformPlanTs(JSON.parse(JSON.stringify(p))))).join('\n');
    for (const w of ['autoscale', 'readReplicas', 'arch', 'memoryGb', 'replicas', 'matches no service', 'destroyed', 'not something the backtest models']) expect(all + JSON.stringify(plans.map((p) => strategyFromTerraformPlanTs(JSON.parse(JSON.stringify(p)), { known: new Set(['customer']) })))).toContain(w);
  });
});
