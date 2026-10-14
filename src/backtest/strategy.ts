import { z } from 'zod';
import type { Model } from './model';
import type { Plan } from './engine';

/**
 * A strategy: an infrastructure change, written as a readable YAML file, that the backtest replays
 * over real history. Each change targets one service (or endpoint) and says what would be different.
 *
 *   name: Graviton for the API, autoscaled
 *   changes:
 *     - service: api
 *       arch: arm
 *       autoscale: { min: 2, max: 8, targetCpu: 0.6, warmupS: 60 }
 */

/** Graviton / Arm price relative to x86 for the same vCPU and memory (Fargate: $0.03238 vs $0.04048 per vCPU-h) */
export const ARM_PRICE_FACTOR = 0.8;

const ServiceChange = z
  .object({
    service: z.string(),
    replicas: z.number().int().min(0).max(1000).optional().describe('fixed replica count'),
    autoscale: z
      .object({
        min: z.number().int().min(0),
        max: z.number().int().min(1),
        targetCpu: z.number().min(0.05).max(1).optional().describe('target CPU utilisation (default 0.6)'),
        warmupS: z.number().min(0).optional().describe('launch → serving (default 60 s)'),
        cooldownS: z.number().min(0).optional().describe('wait before scaling in (default 300 s)'),
        intervalS: z.number().min(1).optional().describe('evaluation period (default 15 s)'),
        metricWindowS: z.number().min(0).optional().describe('window the CPU metric is averaged over (default 30 s; CloudWatch 60)'),
      })
      .optional(),
    cpu: z.number().positive().optional().describe('cores per replica (resize)'),
    memoryGb: z.number().positive().optional(),
    // the spellings agents and manifests use: arm64, aarch64, graviton; amd64, x86_64
    arch: z
      .preprocess((v) => (typeof v === 'string' ? ({ arm64: 'arm', aarch64: 'arm', graviton: 'arm', amd64: 'x86', x86_64: 'x86', 'x86-64': 'x86', intel: 'x86', amd: 'x86' } as Record<string, string>)[v.toLowerCase()] ?? v.toLowerCase() : v), z.enum(['x86', 'arm']))
      .optional()
      .describe('arm = move to Graviton (cheaper per vCPU)'),
    perf: z.number().positive().optional().describe('throughput multiplier per replica (e.g. a benchmark of the new instance family)'),
    capacityRps: z.number().positive().optional().describe('override: req/s one replica can serve (e.g. after removing a lock)'),
    cache: z
      .object({ hitRate: z.number().min(0).max(1), latencyMs: z.number().min(0).optional(), costPerHour: z.number().min(0).optional() })
      .optional()
      .describe('put a cache in front of this service'),
    readReplicas: z.number().int().min(0).max(15).optional().describe('database read replicas'),
    readShare: z.number().min(0).max(1).optional().describe('share of the load that is reads (default 0.8)'),
    zone: z.string().optional(),
    region: z.string().optional(),
  })
  .strict();

const EndpointChange = z
  .object({
    endpoint: z.string().describe('endpoint id, or "*" for all'),
    retries: z.object({ attempts: z.number().int().min(0).max(10), budget: z.number().min(0).max(10).optional() }).optional().describe('client retries per failed request, extra load capped by budget (share)'),
    timeoutMs: z.number().positive().optional(),
  })
  .strict();

export const StrategySpec = z.object({
  name: z.string(),
  description: z.string().optional(),
  changes: z
    .array(
      // pick the schema by the key that says what the change targets, so a mistake gets that
      // schema's message ("retries.attempts: required") instead of a union of two failures
      z.unknown().transform((c, ctx) => {
        const o = (c ?? {}) as Record<string, unknown>;
        const schema = 'endpoint' in o && !('service' in o) ? EndpointChange : ServiceChange;
        const r = schema.safeParse(c);
        if (r.success) return r.data;
        for (const i of r.error.issues) ctx.addIssue({ code: 'custom', message: `${schema === EndpointChange ? 'endpoint change' : 'service change'}: ${i.message}${schema === EndpointChange ? ' — an endpoint change takes endpoint, retries { attempts, budget? }, timeoutMs' : ' — a service change takes service plus replicas, autoscale, cpu, memoryGb, arch, perf, capacityRps, cache, readReplicas, readShare, zone, region'}`, path: i.path });
        return z.NEVER;
      }),
    )
    .default([]),
});
export type StrategySpec = z.infer<typeof StrategySpec>;
export type ServiceChange = z.infer<typeof ServiceChange>;

export interface Applied {
  plan: Plan;
  /** plain-English list of what changed, with the assumptions made */
  notes: string[];
}

export function applyStrategy(model: Model, base: Plan, input: unknown): Applied {
  const spec = StrategySpec.parse(input);
  const plan: Plan = { ...base, services: Object.fromEntries(Object.entries(base.services).map(([k, v]) => [k, { ...v }])), endpoints: Object.fromEntries(Object.entries(base.endpoints).map(([k, v]) => [k, { ...v }])) };
  const notes: string[] = [];
  for (const ch of spec.changes) {
    if ('endpoint' in ch) {
      const ids = ch.endpoint === '*' ? Object.keys(plan.endpoints) : Object.keys(plan.endpoints).filter((id) => id === ch.endpoint);
      if (!ids.length) throw new Error(`strategy "${spec.name}": no endpoint "${ch.endpoint}" (have: ${Object.keys(plan.endpoints).join(', ')})`);
      for (const id of ids) {
        const e = plan.endpoints[id];
        if (ch.retries) e.retries = { attempts: ch.retries.attempts, budget: ch.retries.budget ?? ch.retries.attempts };
        if (ch.timeoutMs) e.timeoutMs = ch.timeoutMs;
      }
      if (ch.retries) notes.push(`${ch.endpoint}: clients retry failed requests up to ${ch.retries.attempts}×${ch.retries.budget !== undefined ? `, at most +${Math.round(ch.retries.budget * 100)}% extra load` : ''}`);
      if (ch.timeoutMs) notes.push(`${ch.endpoint}: client deadline ${ch.timeoutMs} ms`);
      continue;
    }
    const s = plan.services[ch.service];
    const m = model.services[ch.service];
    if (!s || !m) throw new Error(`strategy "${spec.name}": no service "${ch.service}" (have: ${Object.keys(plan.services).join(', ')})`);
    if (s.hostedBy && (ch.replicas !== undefined || ch.autoscale)) throw new Error(`${ch.service} runs inside ${s.hostedBy}; scale ${s.hostedBy} instead`);
    if (ch.replicas !== undefined) {
      s.replicas = ch.replicas;
      s.autoscale = undefined;
      notes.push(`${ch.service}: ${ch.replicas} replica${ch.replicas === 1 ? '' : 's'} (was ${m.replicas})`);
    }
    if (ch.autoscale) {
      const a = ch.autoscale;
      s.autoscale = { min: a.min, max: a.max, target: a.targetCpu ?? 0.6, warmupS: a.warmupS ?? 60, cooldownS: a.cooldownS ?? 300, intervalS: a.intervalS ?? 15, metricWindowS: a.metricWindowS ?? 30 };
      s.replicas = null;
      if (!m.cpu) notes.push(`${ch.service}: no CPU data — autoscaling tracks load as a share of fitted capacity instead of CPU`);
      notes.push(`${ch.service}: autoscale ${a.min}–${a.max} replicas at ${Math.round((a.targetCpu ?? 0.6) * 100)}% CPU, ${a.warmupS ?? 60} s warm-up, ${a.cooldownS ?? 300} s cool-down`);
    }
    if (ch.cpu !== undefined || ch.memoryGb !== undefined) {
      const c0 = m.cpuLimit;
      const m0 = m.memoryGb;
      const c1 = ch.cpu ?? c0;
      const m1 = ch.memoryGb ?? m0;
      if (ch.cpu !== undefined && !c0) throw new Error(`${ch.service}: CPU limit unknown, cannot resize — add a CPU limit series or set capacityRps`);
      if (ch.cpu !== undefined && c0) {
        const scale = c1! / c0;
        if (m.capacity.limit === 'cpu') {
          // the fitted capacity scales with the CPU left for requests (the idle baseline stays)
          const base = m.cpu?.base ?? 0;
          const f = c0 > base ? Math.max(0, c1! - base) / (c0 - base) : scale;
          s.perReplicaRps *= f;
          if (s.overloadedRps) s.overloadedRps *= f;
          s.servers = Math.max(1, Math.round(c1!));
          notes.push(`${ch.service}: ${c0} → ${c1} cores per replica; CPU-bound, so capacity scales to ${s.perReplicaRps.toFixed(1)} req/s per replica`);
        } else {
          // not CPU-bound today — but a smaller limit can make it so
          const cpuCap = m.cpu && m.cpu.perReq > 0 ? (c1! - m.cpu.base) / m.cpu.perReq : Infinity;
          if (cpuCap < s.perReplicaRps) {
            s.perReplicaRps = Math.max(0, cpuCap);
            s.servers = Math.max(1, Math.round(c1!));
            notes.push(`${ch.service}: ${c0} → ${c1} cores per replica; at ${(m.cpu!.perReq * 1000).toFixed(1)} ms of CPU per request that caps it at ${Math.max(0, cpuCap).toFixed(1)} req/s per replica — now CPU-bound`);
          } else notes.push(`${ch.service}: ${c0} → ${c1} cores per replica; capacity is ${m.capacity.limit === 'concurrency' ? 'bound by a concurrency limit' : 'not CPU-bound'}, so throughput does not change`);
        }
        s.cpuLimit = c1!;
      }
      if (ch.memoryGb !== undefined) {
        if (m.memory) {
          s.memory = { base: m.memory.base, perReq: m.memory.perReq, spike: m.memory.spike, limit: ch.memoryGb };
          const head = ch.memoryGb - m.memory.peak;
          notes.push(`${ch.service}: memory limit ${m.memory.limit ? `${Math.round(m.memory.limit * 1024)} → ` : ''}${Math.round(ch.memoryGb * 1024)} MiB; the history's peak working set was ${Math.round(m.memory.peak * 1024)} MiB per container (${head >= 0 ? `${Math.round(head * 1024)} MiB of headroom` : `${Math.round(-head * 1024)} MiB over: it would be OOM-killed`})`);
        } else notes.push(`${ch.service}: memory ${ch.memoryGb} GiB — no memory usage in the history, so OOM kills can't be checked`);
      }
      const cpuPart = c0 && c1 ? (m.cost.cpuShare * c1) / c0 : m.cost.cpuShare;
      const memPart = m0 && m1 ? ((1 - m.cost.cpuShare) * m1) / m0 : 1 - m.cost.cpuShare;
      s.replicaHour *= cpuPart + memPart;
      notes.push(`${ch.service}: $${s.replicaHour.toFixed(4)} per replica-hour (price scales with vCPU and memory)`);
    }
    if (ch.arch && ch.arch !== m.cost.arch) {
      s.replicaHour *= ch.arch === 'arm' ? ARM_PRICE_FACTOR : 1 / ARM_PRICE_FACTOR;
      notes.push(`${ch.service}: ${ch.arch === 'arm' ? 'Graviton (Arm)' : 'x86'} pricing, ×${(ch.arch === 'arm' ? ARM_PRICE_FACTOR : 1 / ARM_PRICE_FACTOR).toFixed(2)} per replica-hour`);
      if (ch.perf === undefined) notes.push(`${ch.service}: assumes equal throughput per vCPU — set \`perf\` from your own benchmark`);
    }
    if (ch.perf !== undefined) {
      s.perReplicaRps *= ch.perf;
      if (s.cpu) s.cpu = { base: s.cpu.base, perReq: s.cpu.perReq / ch.perf };
      notes.push(`${ch.service}: ×${ch.perf} throughput per replica`);
    }
    if (ch.capacityRps !== undefined) {
      s.perReplicaRps = ch.capacityRps;
      notes.push(`${ch.service}: ${ch.capacityRps} req/s per replica (override)`);
    }
    if (ch.cache) {
      s.cache = { hitRate: ch.cache.hitRate, latencyMs: ch.cache.latencyMs ?? 1, costPerHour: ch.cache.costPerHour ?? 0.219 };
      notes.push(`${ch.service}: cache in front, ${Math.round(ch.cache.hitRate * 100)}% hits at ${s.cache.latencyMs} ms, $${s.cache.costPerHour}/h${ch.cache.costPerHour === undefined ? ' (ElastiCache cache.r7g.large)' : ''}`);
    }
    if (ch.readReplicas !== undefined) {
      const r = ch.readShare ?? 0.8;
      const n = ch.readReplicas;
      const mult = 1 / (1 - r + r / (n + 1));
      s.perReplicaRps *= mult;
      s.replicaHour *= 1 + n;
      notes.push(`${ch.service}: ${n} read replica${n === 1 ? '' : 's'}; with ${Math.round(r * 100)}% reads the primary carries ${Math.round((1 / mult) * 100)}% of the load (capacity ×${mult.toFixed(2)}), cost ×${1 + n}`);
    }
    if (ch.zone) {
      s.zone = ch.zone;
      notes.push(`${ch.service}: placed in ${ch.zone}`);
    }
    if (ch.region) {
      s.region = ch.region;
      notes.push(`${ch.service}: placed in ${ch.region}`);
    }
  }
  // services hosted in a moved service move with it
  for (const s of Object.values(plan.services)) if (s.hostedBy && plan.services[s.hostedBy]) {
    s.zone = plan.services[s.hostedBy].zone;
    s.region = plan.services[s.hostedBy].region;
  }
  return { plan, notes };
}
