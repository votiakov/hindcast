import type { SystemNodeData } from './catalog';

/**
 * Target-tracking autoscaling, shared by both engines.
 *
 * Every `EVAL_S` the scaler compares demand (req/s offered) with what one instance can serve and
 * asks for `ceil(demand / (perInstance × targetUtil))` instances, clamped to [min, max].
 * New instances take `warmupS` to become healthy (and are billed while booting); scale-in waits
 * `cooldownS` after the last scaling activity. Instances killed by chaos are replaced like an
 * auto-scaling group replaces unhealthy hosts.
 *
 * Typical warm-up times: EC2 auto-scaling group 90–180 s, Fargate task 30–60 s,
 * Kubernetes pod on an existing node 5–20 s (+ 60–120 s when the cluster needs a new node).
 */

export interface AutoscaleSpec {
  min: number;
  max: number;
  /** utilisation the scaler aims for (0..1) */
  targetUtil?: number;
  /** seconds from launch to serving traffic */
  warmupS?: number;
  /** seconds after a scaling activity before scaling in */
  cooldownS?: number;
}

export const AUTOSCALE_DEFAULTS = { targetUtil: 0.6, warmupS: 30, cooldownS: 60 };
export const EVAL_S = 1;

export interface ScalerState {
  /** instances serving traffic (healthy or not — `down` still applies on top) */
  live: number;
  /** launch times of instances still booting */
  pending: number[];
  /** dead instances already replaced by the scaler */
  replaced: number;
  lastActivity: number;
  lastEval: number;
  /** last decision, for display */
  desired: number;
}

/** node data as the engine should see it: live instance count, replaced instances no longer down */
export function effectiveData(d: SystemNodeData, s: ScalerState | undefined): SystemNodeData {
  if (!d.autoscale || !s) return d;
  return { ...d, instances: s.live, down: Math.max(0, Math.min(s.live, (d.down ?? 0) - s.replaced)) };
}

export interface ScaleEvent {
  kind: 'scale-out' | 'scale-in' | 'scaled';
  from: number;
  to: number;
}
