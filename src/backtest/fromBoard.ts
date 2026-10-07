import type { ArchitectureSpec, ChangeSpec } from '../spec/schema';
import { applyVariant } from '../spec/convert';
import type { Model } from './model';
import type { StrategySpec } from './strategy';

/**
 * Strategies from the canvas: the board opened from the model is edited (or an audit fix is
 * applied), and the difference becomes a strategy the backtest can replay over real history.
 */

const TIER_CPU: Record<string, number> = { S: 1, M: 2, L: 4 };

const targets = (spec: ArchitectureSpec, from: string) => spec.connections.map((c) => (Array.isArray(c) ? { from: c[0], to: c[1] } : c)).filter((c) => c.from === from).map((c) => c.to);
/** a board puts an lb in front of scaled services; follow it to the service */
const through = (spec: ArchitectureSpec, id: string) => (id.endsWith('-lb') ? targets(spec, id) : [id]);

export function specDiffToStrategy(name: string, before: ArchitectureSpec, after: ArchitectureSpec, model: Model): { strategy: StrategySpec | null; ignored: string[] } {
  const changes: StrategySpec['changes'] = [];
  const ignored: string[] = [];
  const was = new Map(before.components.map((c) => [c.id, c]));
  const say = (c: Record<string, unknown>) => {
    const ex = changes.find((x) => 'service' in x && x.service === c.service) as Record<string, unknown> | undefined;
    if (ex) Object.assign(ex, c);
    else changes.push(c as StrategySpec['changes'][number]);
  };

  for (const c of after.components) {
    const b = was.get(c.id);
    const m = model.services[c.id];
    if (!b) {
      // new components the model understands: a cache in front of a service, read replicas of a db
      if (c.kind === 'cache') {
        const behind = targets(after, c.id).flatMap((t) => through(after, t)).filter((t) => model.services[t]);
        if (behind.length) for (const t of behind) say({ service: t, cache: { hitRate: c.hitRate ?? 0.8 } });
        else ignored.push(`${c.id}: a cache in front of nothing the model knows`);
      } else if (c.kind === 'replica') {
        const dbs = after.components.filter((x) => x.kind === 'db' && targets(after, x.id).includes(c.id) && model.services[x.id]);
        for (const d of dbs) {
          const n = after.components.filter((x) => x.kind === 'replica' && targets(after, d.id).includes(x.id)).length;
          say({ service: d.id, readReplicas: n });
        }
        if (!dbs.length) ignored.push(`${c.id}: read replica of no modelled database`);
      } else if (c.kind !== 'lb') ignored.push(`${c.id}: new ${c.kind} — not in the measured system, so it cannot be backtested`);
      continue;
    }
    if (c.kind === 'client') {
      if ((c.retries ?? 0) !== (b.retries ?? 0) || c.timeoutMs !== b.timeoutMs)
        changes.push({ endpoint: '*', ...(c.retries !== b.retries ? { retries: { attempts: c.retries ?? 0, ...(c.retryPolicy === 'budget' ? { budget: 0.1 } : {}) } } : {}), ...(c.timeoutMs !== b.timeoutMs && c.timeoutMs ? { timeoutMs: c.timeoutMs } : {}) });
      continue;
    }
    if (!m) continue;
    if (c.autoscale && JSON.stringify(c.autoscale) !== JSON.stringify(b.autoscale)) say({ service: c.id, autoscale: { min: c.autoscale.min, max: c.autoscale.max, targetCpu: c.autoscale.targetUtil ?? 0.6, warmupS: c.autoscale.warmupS ?? 30, cooldownS: c.autoscale.cooldownS ?? 60 } });
    else if (!c.autoscale && (c.instances ?? 1) !== (b.instances ?? 1)) say({ service: c.id, replicas: c.instances ?? 1 });
    if ((c.tier ?? 'S') !== (b.tier ?? 'S')) {
      const f = TIER_CPU[c.tier ?? 'S'] / TIER_CPU[b.tier ?? 'S'];
      if (m.cpuLimit) say({ service: c.id, cpu: Math.round(m.cpuLimit * f * 1000) / 1000 });
      else say({ service: c.id, perf: f });
    }
    if (c.capacity !== undefined && b.capacity !== undefined && Math.abs(c.capacity - b.capacity) / b.capacity > 0.001 && (c.tier ?? 'S') === (b.tier ?? 'S')) {
      if (isFinite(m.capacity.perReplicaRps)) say({ service: c.id, capacityRps: Math.round(m.capacity.perReplicaRps * (c.capacity / b.capacity) * 100) / 100 });
      else ignored.push(`${c.id}: capacity changed, but the model saw no limit to scale`);
    }
    if ((c.hitRate ?? null) !== (b.hitRate ?? null)) ignored.push(`${c.id}: hit rate edits on existing caches are not modelled from history`);
  }
  for (const b of before.components) if (!after.components.some((c) => c.id === b.id) && model.services[b.id]) ignored.push(`${b.id}: removed on the board — removing a measured component cannot be backtested`);
  return { strategy: changes.length ? { name, description: 'from the board', changes } : null, ignored };
}

/** an audit fix (a list of spec edits) as a strategy */
export function fixToStrategy(title: string, base: ArchitectureSpec, changes: ChangeSpec[], model: Model) {
  const after = applyVariant(base, { name: title, changes });
  return specDiffToStrategy(title, base, after, model);
}
