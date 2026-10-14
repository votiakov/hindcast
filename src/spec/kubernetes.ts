import type { ArchitectureSpec, ComponentSpec } from './schema';
import type { ImportResult } from './terraform';

/**
 * Kubernetes manifests → architecture spec.
 *
 * Input: the parsed documents of one or more manifests (`kubectl get … -o yaml`, Helm output,
 * kustomize build). Workloads become components (Deployments, StatefulSets, DaemonSets); a
 * HorizontalPodAutoscaler becomes `autoscale`; images tell databases, caches and brokers apart;
 * Ingresses and LoadBalancer Services become entry points. Manifests do not record who calls whom,
 * so call edges come from references in container env vars / args / config to other Services'
 * names — every such guess is listed in `assumptions`.
 */

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const a = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const s = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const slug = (x: string) => x.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'x';

const WORKLOADS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'DeploymentConfig', 'Rollout']);
const SKIP = new Set(['ConfigMap', 'Secret', 'ServiceAccount', 'Role', 'RoleBinding', 'ClusterRole', 'ClusterRoleBinding', 'Namespace', 'PersistentVolumeClaim', 'PersistentVolume', 'NetworkPolicy', 'PodDisruptionBudget', 'CronJob', 'Job', 'StorageClass', 'CustomResourceDefinition']);

/** what a container image most likely is */
function classify(image: string): { kind: ComponentSpec['kind']; why: string } | null {
  const i = image.toLowerCase().split('@')[0];
  const name = i.split('/').pop()!.split(':')[0];
  if (/^(postgres|postgresql|mysql|mariadb|mongo|mongodb|cockroach|cassandra|scylla|timescaledb|clickhouse)/.test(name) || /bitnami\/(postgresql|mysql|mongodb)/.test(i)) return { kind: 'db', why: `${name} image` };
  if (/^(redis|valkey|memcached|keydb|dragonfly)/.test(name)) return { kind: 'cache', why: `${name} image` };
  if (/^(rabbitmq|kafka|nats|pulsar|activemq|redpanda|elasticmq)/.test(name)) return { kind: 'queue', why: `${name} image` };
  if (/^(minio|seaweedfs)/.test(name)) return { kind: 'storage', why: `${name} image` };
  if (/^(nginx|envoy|haproxy|traefik|kong|caddy)$/.test(name) || /ingress-nginx/.test(i)) return { kind: 'lb', why: `${name} image` };
  if (/^(vllm|tgi|text-generation-inference|triton|ollama)/.test(name) || /vllm|text-generation-inference|tritonserver/.test(i)) return { kind: 'llm', why: `${name} image` };
  return null;
}

/** container CPU request → size tier */
function tierOfCpu(cpu: string): 'S' | 'M' | 'L' | undefined {
  if (!cpu) return undefined;
  const cores = cpu.endsWith('m') ? parseFloat(cpu) / 1000 : parseFloat(cpu);
  if (!isFinite(cores)) return undefined;
  return cores <= 1 ? 'S' : cores <= 2 ? 'M' : 'L';
}

const runtimeOf = (image: string): ComponentSpec['runtime'] => {
  const i = image.toLowerCase();
  if (/node|bun|deno/.test(i)) return 'node';
  if (/python|django|flask|fastapi|uvicorn|gunicorn/.test(i)) return 'python';
  if (/java|openjdk|temurin|corretto|spring|jvm/.test(i)) return 'java';
  if (/golang|distroless\/static/.test(i)) return 'go';
  if (/rust/.test(i)) return 'rust';
  return undefined;
};

interface Workload {
  id: string;
  name: string;
  kindName: string;
  labels: Obj;
  replicas: number;
  containers: Obj[];
  comp: ComponentSpec;
}

let nativeKubernetes: ((...a: Parameters<typeof importKubernetesTs>) => ImportResult) | null = null;
/** the compiled engine's reader (src/backtest/native.ts) */
export function setNativeKubernetes(f: typeof nativeKubernetes) {
  nativeKubernetes = f;
}

export function importKubernetes(docsIn: unknown[], name?: string): ImportResult {
  return nativeKubernetes ? nativeKubernetes(docsIn, name) : importKubernetesTs(docsIn, name);
}

export function importKubernetesTs(docsIn: unknown[], name?: string): ImportResult {
  // flatten `List` documents and drop empties
  const docs: Obj[] = [];
  for (const d of docsIn) {
    const x = o(d);
    if (x.kind === 'List') docs.push(...a<Obj>(x.items));
    else if (x.kind) docs.push(x);
  }
  if (!docs.length) throw new Error('no Kubernetes objects found (expected documents with apiVersion and kind)');

  const assumptions: string[] = [];
  const skipped: string[] = [];
  const mapped: ImportResult['mapped'] = [];
  const components: ComponentSpec[] = [];
  const edges: [string, string][] = [];
  const used = new Set<string>(['users']);
  const uid = (base: string) => {
    let id = slug(base);
    for (let i = 2; used.has(id); i++) id = `${slug(base)}-${i}`;
    used.add(id);
    return id;
  };
  const meta = (d: Obj) => o(d.metadata);
  const ref = (d: Obj) => `${d.kind}/${s(meta(d).name)}`;

  // ---- workloads ----
  const workloads: Workload[] = [];
  for (const d of docs) {
    const kind = s(d.kind);
    if (!WORKLOADS.has(kind)) continue;
    const spec = o(d.spec);
    const tpl = o(o(spec.template).spec);
    const containers = a<Obj>(tpl.containers);
    const main = containers[0] ?? {};
    const image = s(main.image);
    const n = s(meta(d).name);
    const cls = classify(image);
    const replicas = kind === 'DaemonSet' ? 3 : Math.max(1, Number(spec.replicas ?? 1));
    if (kind === 'DaemonSet') assumptions.push(`${ref(d)}: DaemonSet modelled as 3 instances (one per node) — set your node count`);
    const tier = tierOfCpu(s(o(o(main.resources).requests).cpu));
    let comp: ComponentSpec;
    if (cls?.kind === 'db') {
      comp = { id: uid(n), kind: 'db', ...(tier ? { tier } : {}) };
      assumptions.push(`${ref(d)}: database (${cls.why})${replicas > 1 ? `; ${replicas - 1} replica pod${replicas > 2 ? 's' : ''} modelled as read replicas` : ''}`);
    } else if (cls?.kind === 'cache') {
      comp = { id: uid(n), kind: 'cache', hitRate: 0.85, ...(tier ? { tier } : {}) };
      assumptions.push(`${ref(d)}: cache (${cls.why}), hit rate assumed 85%`);
    } else if (cls) {
      comp = { id: uid(n), kind: cls.kind, ...(cls.kind === 'llm' ? { instances: replicas } : {}) };
      assumptions.push(`${ref(d)}: ${cls.kind} (${cls.why})`);
    } else {
      const rt = runtimeOf(image);
      comp = { id: uid(n), kind: 'server', instances: replicas, ...(tier ? { tier } : {}), ...(rt ? { runtime: rt } : {}) };
    }
    if (n !== comp.id) comp.name = n;
    components.push(comp);
    mapped.push({ resource: ref(d), component: comp.id });
    workloads.push({ id: comp.id, name: n, kindName: kind, labels: o(o(o(spec.template).metadata).labels), replicas, containers, comp });
    if (comp.kind === 'db' && replicas > 1)
      for (let i = 1; i < replicas; i++) {
        const rid = uid(`${n}-replica-${i}`);
        components.push({ id: rid, kind: 'replica', ...(tier ? { tier } : {}) });
        edges.push([comp.id, rid]);
      }
  }
  if (!workloads.length) throw new Error('no workloads found (Deployment, StatefulSet, DaemonSet…)');

  // ---- services: name → workload ----
  const svcTarget = new Map<string, Workload>();
  const lbServices: { name: string; w: Workload }[] = [];
  const matches = (sel: Obj, labels: Obj) => Object.keys(sel).length > 0 && Object.entries(sel).every(([k, v]) => labels[k] === v);
  for (const d of docs) {
    if (d.kind !== 'Service') continue;
    const spec = o(d.spec);
    const w = workloads.find((x) => matches(o(spec.selector), x.labels));
    if (!w) {
      skipped.push(ref(d));
      continue;
    }
    svcTarget.set(s(meta(d).name), w);
    if (spec.type === 'LoadBalancer' || spec.type === 'NodePort') lbServices.push({ name: s(meta(d).name), w });
  }
  // the workload's own name also resolves (common in compose-style setups)
  for (const w of workloads) if (!svcTarget.has(w.name)) svcTarget.set(w.name, w);

  // ---- HPAs → autoscale ----
  for (const d of docs) {
    if (d.kind !== 'HorizontalPodAutoscaler') continue;
    const spec = o(d.spec);
    const target = s(o(spec.scaleTargetRef).name);
    const w = workloads.find((x) => x.name === target);
    if (!w || w.comp.kind !== 'server') {
      skipped.push(ref(d));
      continue;
    }
    const min = Math.max(1, Number(spec.minReplicas ?? 1));
    const max = Math.max(min, Number(spec.maxReplicas ?? min));
    const util = Number(a<Obj>(spec.metrics).map((m) => o(o(m.resource).target).averageUtilization ?? o(m.resource).targetAverageUtilization).find((x) => typeof x === 'number') ?? spec.targetCPUUtilizationPercentage ?? 60) / 100;
    w.comp.autoscale = { min, max, targetUtil: Math.min(0.95, Math.max(0.1, util)), warmupS: 20, cooldownS: 300 };
    w.comp.instances = Math.min(max, Math.max(min, w.comp.instances ?? min));
    assumptions.push(`${ref(d)}: autoscaling ${min}–${max} at ${Math.round(util * 100)}% CPU; pod warm-up assumed 20 s (add 60–120 s if the cluster must add a node), scale-in after 300 s`);
  }

  // ---- entry points ----
  const entries: string[] = [];
  for (const d of docs) {
    if (d.kind !== 'Ingress' && d.kind !== 'Gateway' && d.kind !== 'HTTPRoute') continue;
    if (d.kind === 'Gateway') continue;
    const backends = new Set<string>();
    if (d.kind === 'Ingress') {
      const spec = o(d.spec);
      const def = s(o(o(spec.defaultBackend).service).name) || s(o(spec.backend).serviceName);
      if (def) backends.add(def);
      for (const r of a<Obj>(spec.rules)) for (const p of a<Obj>(o(r.http).paths)) backends.add(s(o(o(p.backend).service).name) || s(o(p.backend).serviceName));
    } else for (const r of a<Obj>(o(d.spec).rules)) for (const b of a<Obj>(r.backendRefs)) backends.add(s(b.name));
    const targets = [...backends].map((b) => svcTarget.get(b)).filter((x): x is Workload => !!x);
    if (!targets.length) {
      skipped.push(ref(d));
      continue;
    }
    const id = uid(s(meta(d).name) || 'ingress');
    components.push({ id, kind: 'lb', ...(id !== s(meta(d).name) ? { name: s(meta(d).name) } : {}) });
    mapped.push({ resource: ref(d), component: id });
    entries.push(id);
    for (const t of new Set(targets)) edges.push([id, t.id]);
  }
  if (!entries.length)
    for (const l of lbServices) {
      const id = uid(`${l.name}-lb`);
      components.push({ id, kind: 'lb', name: l.name });
      entries.push(id);
      edges.push([id, l.w.id]);
      assumptions.push(`Service/${l.name}: type LoadBalancer — modelled as the entry load balancer`);
    }
  if (!entries.length) {
    const front = workloads.filter((w) => w.comp.kind === 'server').slice(0, 1);
    for (const w of front) entries.push(w.id);
    if (front.length) assumptions.push(`no Ingress or LoadBalancer Service — users are assumed to reach ${front[0].name} directly`);
  }

  // ---- call edges from references to other services ----
  const names = [...svcTarget.keys()].sort((x, y) => y.length - x.length);
  for (const w of workloads) {
    if (w.comp.kind !== 'server' && w.comp.kind !== 'worker' && w.comp.kind !== 'lb' && w.comp.kind !== 'llm') continue;
    const blob = JSON.stringify(w.containers.map((c) => ({ env: c.env, args: c.args, command: c.command, envFrom: c.envFrom }))).toLowerCase();
    const hits = new Set<Workload>();
    for (const n of names) {
      const t = svcTarget.get(n)!;
      if (t === w) continue;
      const re = new RegExp(`(^|[^a-z0-9-])${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9-]|$)`);
      if (re.test(blob)) hits.add(t);
    }
    for (const t of hits) {
      if (edges.some(([x, y]) => x === w.id && y === t.id)) continue;
      edges.push([w.id, t.id]);
      assumptions.push(`${w.kindName}/${w.name} → ${t.name}: inferred from a reference in its env / args`);
    }
  }
  // services that consume from a broker are workers behind it
  for (const [from, to] of [...edges]) {
    const src = components.find((c) => c.id === from);
    const dst = components.find((c) => c.id === to);
    if (src?.kind === 'server' && dst?.kind === 'queue') {
      const consumers = workloads.filter((w) => w.comp.kind === 'server' && w.id !== src.id && edges.some(([x, y]) => x === w.id && y === dst.id) && !entries.some((e) => edges.some(([x, y]) => x === e && y === w.id)));
      for (const c of consumers) {
        c.comp.kind = 'worker';
        const i = edges.findIndex(([x, y]) => x === c.id && y === dst.id);
        if (i >= 0) edges.splice(i, 1, [dst.id, c.id]);
        assumptions.push(`${c.kindName}/${c.name}: not reachable from an entry point and connected to ${dst.id} — modelled as a queue consumer (worker)`);
      }
    }
  }
  // caches front the database they are next to (cache-aside)
  const caches = components.filter((c) => c.kind === 'cache');
  const dbs = components.filter((c) => c.kind === 'db');
  if (caches.length === 1 && dbs.length >= 1) {
    const cache = caches[0];
    for (const [i, [x, y]] of [...edges.entries()].reverse()) {
      const dst = components.find((c) => c.id === y);
      if (dst?.kind === 'db' && edges.some(([p, q]) => p === x && q === cache.id)) edges.splice(i, 1);
    }
    for (const db of dbs) if (!edges.some(([x, y]) => x === cache.id && y === db.id)) edges.push([cache.id, db.id]);
    assumptions.push(`${cache.id}: read-through in front of ${dbs.map((d) => d.id).join(', ')} (cache-aside) — remove the cache → db link if your services read the database directly`);
  }

  for (const d of docs) if (!WORKLOADS.has(s(d.kind)) && !['Service', 'Ingress', 'HTTPRoute', 'Gateway', 'HorizontalPodAutoscaler'].includes(s(d.kind)) && !SKIP.has(s(d.kind))) skipped.push(ref(d));

  const spec: ArchitectureSpec = {
    version: 1,
    name: name ?? 'Kubernetes import',
    components: [{ id: 'users', kind: 'client' }, ...components],
    connections: [...entries.map((e): [string, string] => ['users', e]), ...edges],
  };
  return { spec, assumptions, skipped, mapped };
}

/** a parsed document (or list of documents) that looks like Kubernetes */
export const looksLikeKubernetes = (docs: unknown[]) => docs.some((d) => !!o(d).apiVersion && !!o(d).kind);
