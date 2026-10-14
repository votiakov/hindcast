import { z } from 'zod';
import type { Model } from './model';
import type { Plan } from './engine';
import * as wasm from './wasm/hindcast_engine.js';

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
    spread: z.literal('even').optional().describe('Kubernetes: spread the replicas evenly over the nodes (topologySpreadConstraints on kubernetes.io/hostname, maxSkew 1) — what a node failure takes'),
    cpuRequest: z.number().positive().optional().describe('Kubernetes CPU request per replica, cores (what it takes of a node)'),
    memoryRequestGb: z.number().positive().optional().describe('Kubernetes memory request per replica, GiB'),
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
        for (const i of r.error.issues) ctx.addIssue({ code: 'custom', message: `${schema === EndpointChange ? 'endpoint change' : 'service change'}: ${i.message}${schema === EndpointChange ? ' — an endpoint change takes endpoint, retries { attempts, budget? }, timeoutMs' : ' — a service change takes service plus replicas, autoscale, cpu, memoryGb, cpuRequest, memoryRequestGb, spread, arch, perf, capacityRps, cache, readReplicas, readShare, zone, region'}`, path: i.path });
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
  return wasm.applyStrategy(model, base, input) as Applied;
}
