import type { Placement } from './dataset';

/**
 * The calibrated model: what Hindcast believes about each component, fitted from real data,
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
  /** metastable: once overloaded, it only finishes this many req/s per replica until the backlog
   *  is gone (garbage collection, thread and pool thrash) */
  overloadedRps?: number;
  /** CFS quota throttling fitted from the history: ln(share of periods throttled) = ln(atZero) +
   *  growth × (CPU / limit); knee is the share of the limit where throttling stops it keeping up */
  throttle?: { knee: number; atZero: number; growth: number; r2: number; seenTo: number };
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
  /** memory per replica: its limit, or (no limit seen) what it used; GB */
  memoryGb: number | null;
  /** the largest container's peak working set = base + perReq × req/s per replica, + up to spike
   *  above that line (the worst the history showed); GiB. An OOM kill compares it with the limit */
  memory?: { base: number; perReq: number; spike: number; peak: number; limit: number | null; r2: number; /** the busiest req/s per replica the history saw */ seenTo?: number };
  /** what each replica asks the scheduler for (Kubernetes requests): cores, GiB */
  requests?: { cpu: number; memoryGb: number };
  /** pods per node at the end of the history (Kubernetes) */
  pods?: Record<string, number>;
  /** its HorizontalPodAutoscaler (Kubernetes): replicas, CPU target as a share */
  hpa?: { min: number; max: number; targetCpu?: number };
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
    source: 'bill' | 'pricing' | 'nodes' | 'none';
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
  /** p90 at low load, ms (with the median, keeps a bimodal endpoint's tail where it is) */
  baseP90Ms?: number;
  /** tail multiplier fitted on history */
  tail: number;
  /** baseline error share (not overload), at zero load */
  errorRate: number;
  /** baseline errors that grow with traffic: + this × the endpoint's req/s */
  errorSlope?: number;
  /** services on its path that ran under a CPU limit below one core and were throttled at low load:
   *  a one-core burst spends the quota early in the 100 ms CFS period and waits out the rest, so
   *  the p99 carries one stall of (1 − limit) × 100 ms. baseExcessMs is without it; the replay adds
   *  the longest stall at the plan's limits */
  stalls?: { service: string; limit: number }[];
  /** bytes per request per edge, and back to the client */
  bytes: Record<string, number>;
  egressBytes: number;
  slo: { p99Ms: number; errorRate: number };
  fit: FitQuality;
}

/** the Kubernetes nodes the services run on: on a cluster, compute is paid for by the node */
export interface ClusterModel {
  /** allocatable per node: cores, GiB */
  node: { cpu: number; memoryGb: number; perHour: number; source: 'pricing' | 'hint' };
  /** nodes in the history: typical, fewest, most */
  nodes: number;
  minNodes: number;
  maxNodes: number;
  /** the node count followed demand (cluster autoscaler, Karpenter) — else it is a fixed pool */
  autoscaled: boolean;
  /** nodes ÷ the nodes the requests would fill exactly, typically (fragmentation, headroom) */
  packing: number;
  /** requests of every pod on the cluster that isn't one of the modelled services: cores, GiB */
  other: { cpu: number; memoryGb: number };
  /** seconds a pod waits for a new node (default 90) */
  provisionS?: number;
  /** the zone of each node (from its provider id) */
  zones?: Record<string, string>;
  notes: string[];
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
  cluster?: ClusterModel;
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
