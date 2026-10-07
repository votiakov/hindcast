import type { Placement } from './dataset';

/**
 * The calibrated model: what Bottleneck believes about each component, fitted from real data,
 * with how well each belief reproduces what was measured.
 */

export type FitStatus = 'good' | 'fair' | 'poor' | 'unexplained' | 'cost-only';

export interface FitQuality {
  status: FitStatus;
  /** mean absolute percentage error of the model replaying the measured history */
  latencyMape?: number;
  p99Mape?: number;
  cpuMape?: number;
  /** R² of the CPU-vs-load regression */
  cpuR2?: number;
  /** buckets used */
  samples: number;
  /** plain-English reasons behind the status */
  notes: string[];
}

export interface Capacity {
  /** what limits throughput: CPU, a concurrency limit (locks, pools, connections), or nothing seen */
  limit: 'cpu' | 'concurrency' | 'none';
  /** parallel servers per replica (M/M/c) */
  servers: number;
  /** req/s one replica can serve; Infinity when no limit was observed */
  perReplicaRps: number;
  /** bootstrap 10th / 90th percentiles of perReplicaRps */
  band?: [number, number];
  /** bootstrap draws of perReplicaRps, for Monte Carlo bands */
  samples?: number[];
}

export interface ServiceModel {
  id: string;
  kind: 'server' | 'db' | 'cache' | 'queue' | 'external' | 'lb';
  system?: string;
  /** in-process dependency: runs inside this service's replicas (scales with it, billed with it) */
  hostedBy?: string;
  /** typical replicas in the history (median) */
  replicas: number;
  /** cores per replica (limit), null if unknown */
  cpuLimit: number | null;
  memoryGb: number | null;
  /** cores per replica = base + perReq × (req/s per replica) */
  cpu: { base: number; perReq: number; r2: number } | null;
  capacity: Capacity;
  /** own work per visit at low load, ms */
  self: { mean: number; p99: number };
  /** latency tail multiplier fitted on queueing excess */
  tail: number;
  /** service-time variability: queueing waits are this × the M/M/c wait (0.5 ≈ constant service times) */
  variability?: number;
  /** waits scale with utilisation^(loadExponent − 1) on top of M/M/c: > 1 when queueing starts late and
   *  steep (CPU quotas throttling in bursts) */
  loadExponent?: number;
  cost: {
    /** $ per replica-hour (compute) */
    perReplicaHour: number;
    /** $ per request (usage-billed) */
    perRequest: number;
    /** share of perReplicaHour that is CPU (rest memory) — for resizing */
    cpuShare: number;
    arch: 'x86' | 'arm';
    source: 'bill' | 'pricing' | 'none';
  };
  placement?: Placement;
  fit: FitQuality;
}

export interface EndpointModel {
  id: string;
  service: string;
  /** mean share of all traffic */
  share: number;
  /** visits per request per service */
  visits: Record<string, number>;
  /** calls per request per edge "from>to" */
  calls: Record<string, number>;
  /** critical-path weight per service: how many self-times of the service sit on the request's path */
  weights: Record<string, number>;
  /** fixed latency not owned by any traced service (network, proxies), ms */
  overheadMs: number;
  /** measured p99 − mean at low load, ms */
  baseExcessMs: number;
  /** measured median at low load, ms */
  baseP50Ms?: number;
  /** tail multiplier fitted on history */
  tail: number;
  /** baseline error share (not overload), at zero load */
  errorRate: number;
  /** baseline errors that grow with traffic: + this × the endpoint's req/s */
  errorSlope?: number;
  /** bytes per request per edge, and back to the client */
  bytes: Record<string, number>;
  egressBytes: number;
  slo: { p99Ms: number; errorRate: number };
  fit: FitQuality;
}

export interface TransferPrices {
  /** $/GB for traffic between zones (charged on each side), between regions, and out to the internet */
  crossZoneGb: number;
  crossRegionGb: number;
  internetGb: number;
  source: string;
}

export interface AccuracyCheck {
  metric: 'p99' | 'breaking-point' | 'cost' | 'errors';
  predicted: number;
  measured: number;
  /** |predicted − measured| / measured */
  error: number;
  tolerance: number;
  pass: boolean;
  note: string;
}

export interface AccuracyRecord {
  /** what the accuracy was measured against */
  method: 'holdout' | 'reference';
  label: string;
  checks: AccuracyCheck[];
  measuredAt: string;
}

export interface Model {
  version: 1;
  name: string;
  /** client deadline: slower answers are failures, ms */
  timeoutMs: number;
  slo: { p99Ms: number; errorRate: number };
  services: Record<string, ServiceModel>;
  endpoints: Record<string, EndpointModel>;
  transfer: TransferPrices;
  /** spend that does not scale with load (storage, unattributed lines), $/h */
  unattributedPerHour: number;
  accuracy: AccuracyRecord[];
  /** history the model was fitted on */
  fittedOn: { start: number; end: number; stepS: number; buckets: number };
  /** traffic seen in that history, req/s (all endpoints) */
  traffic?: { mean: number; p90: number; peak: number };
}

export const AWS_TRANSFER: TransferPrices = {
  crossZoneGb: 0.01,
  crossRegionGb: 0.02,
  internetGb: 0.09,
  source: 'https://aws.amazon.com/ec2/pricing/on-demand/#Data_Transfer (us-east-1: $0.01/GB each way between AZs, $0.02/GB between regions, $0.09/GB out to the internet, first 10 TB)',
};

/** JSON has no Infinity: unbounded capacities come back as null — restore them after parsing */
export function reviveModel(m: Model): Model {
  for (const s of Object.values(m.services)) {
    const c = s.capacity as { perReplicaRps: number | null };
    if (c.perReplicaRps === null || c.perReplicaRps === undefined) s.capacity.perReplicaRps = Infinity;
  }
  return m;
}
