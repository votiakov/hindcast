import type { ArchitectureSpec, ComponentSpec } from './schema';

/**
 * Terraform → architecture spec.
 *
 * Input: the JSON from `terraform show -json` (a state or a saved plan). Terraform describes
 * resources, not call paths, so the call graph is reconstructed from real references where they
 * exist (target-group ARNs, CloudFront origins, API Gateway integrations, Lambda event sources)
 * and from conventional heuristics otherwise. Every heuristic is reported in `assumptions`.
 */

interface TfResource {
  address: string;
  type: string;
  name: string;
  index?: number | string;
  values: Record<string, unknown>;
}

interface TfModule {
  resources?: TfResource[];
  child_modules?: TfModule[];
}

export interface ImportResult {
  spec: ArchitectureSpec;
  assumptions: string[];
  skipped: string[];
  mapped: { resource: string; component: string }[];
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown, d: number) => (typeof v === 'number' && isFinite(v) ? v : d);
const arr = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

function collect(root: unknown): TfResource[] {
  const r = root as { values?: { root_module?: TfModule }; planned_values?: { root_module?: TfModule } };
  const mod = r.planned_values?.root_module ?? r.values?.root_module;
  if (!mod) throw new Error('not a `terraform show -json` document (no values.root_module / planned_values.root_module)');
  const out: TfResource[] = [];
  const walk = (m: TfModule) => {
    out.push(...(m.resources ?? []).filter((x) => (x as { mode?: string }).mode !== 'data'));
    (m.child_modules ?? []).forEach(walk);
  };
  walk(mod);
  return out;
}

/** instance size → tier: up to large = S, xlarge = M, 2xlarge and above = L */
function tierOf(instanceType: string): 'S' | 'M' | 'L' {
  const size = instanceType.split('.').pop() ?? '';
  if (/^\d+xlarge$/.test(size) || size === 'metal') return 'L';
  if (size === 'xlarge') return 'M';
  return 'S';
}

const isGpu = (instanceType: string) => /^(g\d|p\d|inf\d|trn\d)/.test(instanceType.replace(/^(db|cache|ml)\./, ''));

const lambdaRuntime = (rt: string): ComponentSpec['runtime'] =>
  rt.startsWith('nodejs') ? 'node' : rt.startsWith('python') ? 'python' : rt.startsWith('java') ? 'java' : rt.startsWith('go') ? 'go' : undefined;

/** resources that carry wiring (read in pass 2), not components */
const REFERENCE_TYPES = new Set([
  'aws_lb_target_group', 'aws_alb_target_group', 'aws_lb_listener', 'aws_alb_listener', 'aws_lb_listener_rule', 'aws_lb_target_group_attachment',
  'aws_launch_template', 'aws_launch_configuration', 'aws_lambda_event_source_mapping', 'aws_lambda_permission',
  'aws_apigatewayv2_integration', 'aws_apigatewayv2_route', 'aws_apigatewayv2_stage', 'aws_api_gateway_integration', 'aws_api_gateway_resource', 'aws_api_gateway_method',
]);

const slug = (s: string) => s.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'x';

export function importTerraform(doc: unknown, name?: string): ImportResult {
  const resources = collect(doc);
  const components: ComponentSpec[] = [];
  const edges = new Set<string>();
  const assumptions: string[] = [];
  const skipped: string[] = [];
  const mapped: ImportResult['mapped'] = [];
  const byArn = new Map<string, string>(); // ARN / id / dns name → component id
  const ids = new Set<string>();

  const add = (r: TfResource, c: Omit<ComponentSpec, 'id'> & { id?: string }) => {
    let id = c.id ?? slug(`${r.name}${r.index !== undefined ? `-${r.index}` : ''}`);
    while (ids.has(id)) id = `${id}-${r.type.split('_').pop()}`;
    ids.add(id);
    const comp = { ...c, id } as ComponentSpec;
    components.push(comp);
    mapped.push({ resource: r.address, component: id });
    for (const k of ['arn', 'id', 'dns_name', 'domain_name', 'bucket_regional_domain_name', 'api_endpoint', 'name', 'url', 'invoke_arn']) {
      const v = str(r.values[k]);
      if (v) byArn.set(v, id);
    }
    return comp;
  };
  const connect = (a: string | undefined, b: string | undefined) => a && b && a !== b && edges.add(`${a}→${b}`);
  const find = (ref: string) => {
    if (!ref) return undefined;
    if (byArn.has(ref)) return byArn.get(ref);
    for (const [k, v] of byArn) if (k && (ref.includes(k) || k.includes(ref))) return v;
    return undefined;
  };

  // launch templates / configurations: instance types for ASGs
  const ltType = new Map<string, string>();
  for (const r of resources.filter((x) => x.type === 'aws_launch_template' || x.type === 'aws_launch_configuration')) {
    const t = str(r.values.instance_type);
    for (const k of ['id', 'name', 'arn']) if (str(r.values[k])) ltType.set(str(r.values[k]), t);
  }

  // ---- pass 1: components ----
  const entry: string[] = [];
  const compute: string[] = [];
  const dbs: string[] = [];
  const caches: string[] = [];
  const queues: string[] = [];
  for (const r of resources) {
    const v = r.values;
    switch (r.type) {
      case 'aws_cloudfront_distribution':
        entry.push(add(r, { kind: 'cdn', hitRate: 0.6 }).id);
        assumptions.push(`${r.address}: CDN hit rate assumed 60% — set hitRate from CloudFront metrics`);
        break;
      case 'aws_lb':
      case 'aws_alb': {
        const internal = v.internal === true;
        const c = add(r, { kind: 'lb' });
        if (!internal) entry.push(c.id);
        break;
      }
      case 'aws_apigatewayv2_api':
      case 'aws_api_gateway_rest_api':
        entry.push(add(r, { kind: 'gateway', limit: 10_000 }).id);
        assumptions.push(`${r.address}: gateway rate limit assumed 10,000 req/s (AWS default account throttle)`);
        break;
      case 'aws_autoscaling_group': {
        const lt = (arr<Record<string, unknown>>(v.launch_template)[0] ?? {}) as Record<string, unknown>;
        const type = ltType.get(str(lt.id)) ?? ltType.get(str(lt.name)) ?? ltType.get(str(v.launch_configuration)) ?? '';
        const n = num(v.desired_capacity, num(v.min_size, 1));
        const min = Math.max(1, num(v.min_size, n));
        const max = Math.max(min, num(v.max_size, n));
        const warmupS = num(v.default_instance_warmup, num(v.health_check_grace_period, 120));
        const scales = max > min;
        const c = add(r, {
          kind: isGpu(type) ? 'llm' : 'server',
          instances: Math.max(1, n),
          ...(type && !isGpu(type) ? { tier: tierOf(type) } : {}),
          ...(scales ? { autoscale: { min, max: Math.min(500, max), targetUtil: 0.6, warmupS: Math.min(900, warmupS), cooldownS: 300 } } : {}),
        });
        compute.push(c.id);
        if (!type) assumptions.push(`${r.address}: instance type not resolvable — sized as S`);
        if (scales) assumptions.push(`${r.address}: autoscaling ${min}–${max} assumed target-tracking at 60% CPU, ${Math.min(900, warmupS)} s warm-up, 300 s scale-in cooldown — check your scaling policy`);
        break;
      }
      case 'aws_ecs_service': {
        const c = add(r, { kind: 'server', instances: Math.max(1, num(v.desired_count, 1)) });
        compute.push(c.id);
        assumptions.push(`${r.address}: ECS task capacity uses the API-server default (250 req/s per task) — calibrate \`capacity\``);
        break;
      }
      case 'aws_instance': {
        const type = str(v.instance_type);
        const c = add(r, { kind: isGpu(type) ? 'llm' : 'server', ...(isGpu(type) ? {} : { tier: tierOf(type) }) });
        compute.push(c.id);
        break;
      }
      case 'aws_lambda_function': {
        const rt = lambdaRuntime(str(v.runtime));
        const conc = num(v.reserved_concurrent_executions, -1);
        const c = add(r, { kind: 'function', ...(rt ? { runtime: rt } : {}), ...(conc > 0 ? { limit: conc * 10 } : {}) });
        compute.push(c.id);
        break;
      }
      case 'aws_db_instance': {
        const cls = str(v.instance_class);
        const src = str(v.replicate_source_db);
        const c = add(r, { kind: src ? 'replica' : 'db', tier: tierOf(cls) });
        if (src) (c as ComponentSpec & { _src?: string })._src = src;
        else dbs.push(c.id);
        if (v.multi_az === true) assumptions.push(`${r.address}: Multi-AZ standby is not modelled as a separate node (it doubles RDS cost in reality)`);
        break;
      }
      case 'aws_rds_cluster':
        dbs.push(add(r, { kind: 'db' }).id);
        break;
      case 'aws_rds_cluster_instance':
        // writer is represented by the cluster; extra instances become replicas
        (add(r, { kind: 'replica', tier: tierOf(str(v.instance_class)) }) as ComponentSpec & { _src?: string })._src = str(v.cluster_identifier);
        break;
      case 'aws_elasticache_replication_group':
      case 'aws_elasticache_cluster':
        caches.push(add(r, { kind: 'cache', tier: tierOf(str(v.node_type)), hitRate: 0.85 }).id);
        assumptions.push(`${r.address}: cache hit rate assumed 85% — set hitRate from CacheHits / (CacheHits + CacheMisses)`);
        break;
      case 'aws_sqs_queue':
        queues.push(add(r, { kind: 'queue' }).id);
        break;
      case 'aws_s3_bucket':
        // only buckets that serve traffic (CloudFront origins) are added later
        byArn.set(str(v.bucket_regional_domain_name) || str(v.bucket), `s3:${str(v.bucket)}`);
        break;
      default:
        if (r.type.startsWith('aws_') && !REFERENCE_TYPES.has(r.type)) skipped.push(r.address);
    }
  }

  // ---- pass 2: real references ----
  const tgTargets = new Map<string, string[]>(); // target group ARN → component ids
  for (const r of resources) {
    const v = r.values;
    if (r.type === 'aws_autoscaling_group') for (const tg of arr<string>(v.target_group_arns)) tgTargets.set(tg, [...(tgTargets.get(tg) ?? []), find(str(v.arn)) ?? find(str(v.name))!]);
    if (r.type === 'aws_ecs_service') for (const lb of arr<Record<string, unknown>>(v.load_balancer)) tgTargets.set(str(lb.target_group_arn), [...(tgTargets.get(str(lb.target_group_arn)) ?? []), find(str(v.id)) ?? find(str(v.name))!]);
    if (r.type === 'aws_lb_target_group_attachment') tgTargets.set(str(v.target_group_arn), [...(tgTargets.get(str(v.target_group_arn)) ?? []), find(str(v.target_id))!].filter(Boolean));
  }
  const tgOwner = new Map<string, string>(); // target group ARN → lb id (via listeners)
  for (const r of resources.filter((x) => x.type === 'aws_lb_listener' || x.type === 'aws_alb_listener')) {
    const lbId = find(str(r.values.load_balancer_arn));
    for (const a of arr<Record<string, unknown>>(r.values.default_action)) if (lbId && str(a.target_group_arn)) tgOwner.set(str(a.target_group_arn), lbId);
  }
  for (const [tg, targets] of tgTargets) {
    const lbId = tgOwner.get(tg) ?? (components.filter((c) => c.kind === 'lb').length === 1 ? components.find((c) => c.kind === 'lb')!.id : undefined);
    for (const t of targets) connect(lbId, t);
  }
  for (const r of resources.filter((x) => x.type === 'aws_cloudfront_distribution')) {
    const cdnId = find(str(r.values.arn)) ?? find(str(r.values.id));
    for (const o of arr<Record<string, unknown>>(r.values.origin)) {
      const dn = str(o.domain_name);
      let target = find(dn);
      if (target?.startsWith('s3:')) {
        const bucket = target.slice(3);
        const id = slug(bucket);
        if (!ids.has(id)) {
          ids.add(id);
          components.push({ id, kind: 'storage' });
          mapped.push({ resource: `aws_s3_bucket (${bucket})`, component: id });
        }
        target = id;
      }
      if (target) connect(cdnId, target);
      else assumptions.push(`${r.address}: origin ${dn} not found in this state`);
    }
  }
  for (const r of resources.filter((x) => x.type === 'aws_apigatewayv2_integration' || x.type === 'aws_api_gateway_integration')) {
    const api = find(str(r.values.api_id)) ?? find(str(r.values.rest_api_id));
    const target = find(str(r.values.integration_uri)) ?? find(str(r.values.uri));
    connect(api, target);
  }
  for (const r of resources.filter((x) => x.type === 'aws_lambda_event_source_mapping')) connect(find(str(r.values.event_source_arn)), find(str(r.values.function_name)));
  for (const c of components as (ComponentSpec & { _src?: string })[]) {
    if (c.kind === 'replica' && c._src) connect(find(c._src) ?? dbs[0], c.id);
    delete c._src;
  }

  // ---- pass 3: heuristics ----
  const hasIn = (id: string) => [...edges].some((e) => e.endsWith(`→${id}`));
  const hasOut = (id: string) => [...edges].some((e) => e.startsWith(`${id}→`));
  components.unshift({ id: 'users', kind: 'client' });
  ids.add('users');
  const entries = entry.filter((id) => !hasIn(id));
  const roots = entries.length ? entries : compute.filter((id) => !hasIn(id));
  for (const id of roots) connect('users', id);
  if (!entries.length) assumptions.push('no public entry point (CloudFront / internet-facing LB / API Gateway) found — users call compute directly');
  for (const id of entries) {
    if (hasOut(id)) continue;
    for (const t of compute.filter((c) => !hasIn(c))) connect(id, t);
    assumptions.push(`${id}: routes to ${compute.filter((c) => !hasIn(c) || [...edges].includes(`${id}→${c}`)).join(', ') || 'nothing'} (no explicit target found)`);
  }
  const consumers = new Set([...edges].filter((e) => queues.some((q) => e.startsWith(`${q}→`))).map((e) => e.split('→')[1]));
  const web = compute.filter((c) => !consumers.has(c));
  for (const c of compute) {
    if (caches.length === 1 && dbs.length) {
      connect(c, caches[0]);
      for (const d of dbs) connect(caches[0], d);
    } else for (const d of dbs) connect(c, d);
  }
  if (compute.length && dbs.length) assumptions.push(caches.length === 1 ? `every service reads through ${caches[0]} (cache-aside) into ${dbs.join(', ')}` : `every service calls ${dbs.join(', ')} directly`);
  for (const q of queues) {
    for (const w of web) connect(w, q);
    if (web.length) assumptions.push(`${q}: produced by ${web.join(', ')} (Terraform has no producer references)`);
  }

  const known = new Set(components.map((c) => c.id));
  const connections = [...edges].map((e) => e.split('→') as [string, string]).filter(([a, b]) => known.has(a) && known.has(b));
  return {
    spec: { version: 1, name: name ?? 'Imported from Terraform', pricing: 'aws-us-east-1', components, connections },
    assumptions: [...new Set(assumptions)],
    skipped,
    mapped,
  };
}
