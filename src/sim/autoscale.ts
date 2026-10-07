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

export const newScaler = (d: SystemNodeData): ScalerState => {
  const as = d.autoscale!;
  const start = Math.min(as.max, Math.max(as.min, d.instances ?? as.min));
  return { live: start, pending: [], replaced: 0, lastActivity: -Infinity, lastEval: -Infinity, desired: start };
};

/** node data as the engine should see it: live instance count, replaced instances no longer down */
export function effectiveData(d: SystemNodeData, s: ScalerState | undefined): SystemNodeData {
  if (!d.autoscale || !s) return d;
  return { ...d, instances: s.live, down: Math.max(0, Math.min(s.live, (d.down ?? 0) - s.replaced)) };
}

/** instances being paid for (serving + booting) */
export const billedInstances = (s: ScalerState) => s.live + s.pending.length;

export interface ScaleEvent {
  kind: 'scale-out' | 'scale-in' | 'scaled';
  from: number;
  to: number;
}

/**
 * Advance the scaler to time `now`.
 * @param demandRps requests/sec offered to the node
 * @param perInstanceRps what one healthy instance serves
 */
export function stepScaler(s: ScalerState, d: SystemNodeData, now: number, demandRps: number, perInstanceRps: number): ScaleEvent[] {
  const as = d.autoscale!;
  const target = as.targetUtil ?? AUTOSCALE_DEFAULTS.targetUtil;
  const warmup = as.warmupS ?? AUTOSCALE_DEFAULTS.warmupS;
  const cooldown = as.cooldownS ?? AUTOSCALE_DEFAULTS.cooldownS;
  const events: ScaleEvent[] = [];

  // a healed node (down reset) no longer needs replacements
  s.replaced = Math.min(s.replaced, d.down ?? 0);

  // boots that finished
  const ready = s.pending.filter((t) => now - t >= warmup).length;
  if (ready) {
    s.pending = s.pending.filter((t) => now - t < warmup);
    const before = s.live;
    // replacements for dead instances first
    const dead = Math.max(0, (d.down ?? 0) - s.replaced);
    const replace = Math.min(dead, ready);
    s.replaced += replace;
    s.live = Math.min(as.max + (d.down ?? 0), s.live + ready - replace);
    events.push({ kind: 'scaled', from: before, to: s.live });
  }

  if (now - s.lastEval < EVAL_S) return events;
  s.lastEval = now;

  const dead = Math.max(0, (d.down ?? 0) - s.replaced);
  const healthy = s.live - dead;
  const desired = Math.min(as.max, Math.max(as.min, Math.ceil(demandRps / Math.max(1e-9, perInstanceRps * target))));
  s.desired = desired;
  const coming = healthy + s.pending.length;
  if (desired > coming || dead > s.pending.length) {
    const launch = Math.max(desired - coming, 0) + Math.max(0, dead - s.pending.length);
    const n = Math.min(launch, as.max + dead - s.live - s.pending.length);
    if (n > 0) {
      for (let i = 0; i < n; i++) s.pending.push(now);
      s.lastActivity = now;
      events.push({ kind: 'scale-out', from: healthy, to: healthy + s.pending.length });
    }
  } else if (desired < healthy && !s.pending.length && now - s.lastActivity >= cooldown) {
    // scale in gradually: at most half of the surplus per step
    const remove = Math.max(1, Math.floor((healthy - desired) / 2));
    const before = s.live;
    s.live = Math.max(as.min + dead, s.live - remove);
    if (s.live !== before) {
      s.lastActivity = now;
      events.push({ kind: 'scale-in', from: before, to: s.live });
    }
  }
  return events;
}
