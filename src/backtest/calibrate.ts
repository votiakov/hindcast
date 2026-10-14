import {   type Dataset, type Num } from './dataset';
import {   type Model, type ServiceModel } from './model';
import {  type Traffic } from './engine';
import * as wasm from './wasm/hindcast_engine.js';

/**
 * Fit a model to a dataset.
 *
 *  - topology and per-request work from traces (visits, critical path, payloads)
 *  - per service: CPU per request (regression), capacity per replica — CPU-bound, concurrency-bound
 *    (M/M/c fitted to self time vs load, replaying the history through the queue so overload
 *    transients are fitted too) or unbounded — with bootstrap bands
 *  - per endpoint: network/proxy overhead, latency tail, baseline errors
 *  - cost from the bill: $ per replica-hour, per request, per GB
 *  - fit quality per component; anything the model cannot explain is flagged
 */

export interface CalibrateOptions {
  slo?: { p99Ms: number; errorRate: number };
  /** client deadline, ms (default 5000) */
  timeoutMs?: number;
  /** in-process dependencies: service → host service */
  hostedBy?: Record<string, string>;
  /** bootstrap draws for capacity bands (default 40) */
  bootstrap?: number;
  /** per-service overrides */
  services?: Record<string, { kind?: ServiceModel['kind']; servers?: number; perReplicaRps?: number; arch?: 'x86' | 'arm' }>;
  endpoints?: Record<string, { slo?: { p99Ms: number; errorRate: number } }>;
  seed?: number;
  /** price services the bill doesn't cover (or every service, without a bill) at on-demand list
   *  prices from their CPU and memory limits — AWS Fargate us-east-1 unless given */
  listPrices?: boolean | ListPrices;
}

export interface ListPrices {
  perVcpuHour: number;
  perGbHour: number;
  /** Arm (Graviton) prices */
  armPerVcpuHour: number;
  armPerGbHour: number;
  source: string;
}

/** endpoint ids from different sources ("frontend GET /dispatch" vs "frontend HTTP GET /dispatch") */
export function sameEndpoint(a: string, b: string) {
  // path parameters are spelled {id}, [id] or :id depending on the framework; query strings and
  // trailing slashes don't name a different endpoint
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\bhttp\b/g, '')
      .replace(/\{[^}]*\}|\[[^\]]*\]|:[a-z_]\w*/g, '*')
      .replace(/\?\S*/g, '')
      .replace(/\/(\s|$)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  if (norm(a) === norm(b)) return true;
  const parse = (s: string) => {
    const t = norm(s).split(' ');
    return { svc: t[0], path: t[t.length - 1], method: t.find((x) => /^(get|post|put|patch|delete|head|options)$/.test(x)) };
  };
  const pa = parse(a);
  const pb = parse(b);
  return pa.svc === pb.svc && pa.path === pb.path && (!pa.method || !pb.method || pa.method === pb.method);
}

export function calibrate(d: Dataset, options: CalibrateOptions = {}): Model {
  return wasm.calibrate(d, options) as Model;
}

/** endpoint traffic of a dataset, aligned to the model's endpoints */
export function trafficOf(d: Dataset, model: Model): Traffic {
  const endpoints: Record<string, Num[]> = {};
  for (const id of Object.keys(model.endpoints)) {
    const s = d.endpoints[id]?.rps;
    if (s) endpoints[id] = s;
  }
  if (!Object.keys(endpoints).length) {
    // no endpoint series: split the entry services' traffic by the model's shares
    for (const [id, e] of Object.entries(model.endpoints)) {
      const entry = d.services[e.service]?.rps;
      if (entry) endpoints[id] = entry.map((v) => (v === null ? null : v * e.share));
    }
  }
  return { start: d.start, stepS: d.stepS, n: d.n, endpoints };
}

export function observedReplicas(d: Dataset, model: Model): Record<string, Num[] | undefined> {
  return Object.fromEntries(Object.entries(model.services).map(([id, s]) => [id, d.services[s.hostedBy ?? id]?.replicas]));
}
