import { ArchitectureSpec } from './schema';
import { pairs } from './convert';

export interface Issue {
  level: 'error' | 'warning';
  message: string;
}

/** Schema errors plus architectural lint (things that will silently misbehave in the simulation). */
export function validateSpec(input: unknown): { ok: boolean; issues: Issue[]; spec?: ArchitectureSpec } {
  const parsed = ArchitectureSpec.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => ({ level: 'error', message: `${i.path.join('.') || 'spec'}: ${i.message}` })) };
  }
  const spec = parsed.data;
  const issues: Issue[] = [];
  const ids = new Map(spec.components.map((c) => [c.id, c]));
  const seen = new Set<string>();
  for (const c of spec.components) {
    if (seen.has(c.id)) issues.push({ level: 'error', message: `duplicate component id "${c.id}"` });
    seen.add(c.id);
  }
  const edges = pairs(spec);
  const out = new Map<string, string[]>();
  const into = new Map<string, string[]>();
  for (const [a, b] of edges) {
    if (!ids.has(a)) issues.push({ level: 'error', message: `connection from unknown component "${a}"` });
    if (!ids.has(b)) issues.push({ level: 'error', message: `connection to unknown component "${b}"` });
    if (a === b) issues.push({ level: 'error', message: `"${a}" is connected to itself` });
    out.set(a, [...(out.get(a) ?? []), b]);
    into.set(b, [...(into.get(b) ?? []), a]);
  }
  if (!spec.components.some((c) => c.kind === 'client')) issues.push({ level: 'error', message: 'no traffic source: add a component with kind "client"' });

  for (const c of spec.components) {
    const kids = out.get(c.id) ?? [];
    const parents = (into.get(c.id) ?? []).map((p) => ids.get(p)?.kind);
    if ((c.kind === 'lb' || c.kind === 'gateway' || c.kind === 'queue') && !kids.length) issues.push({ level: 'error', message: `${c.kind} "${c.id}" has nothing behind it — every request fails` });
    if ((c.kind === 'cache' || c.kind === 'cdn') && !kids.length) issues.push({ level: 'warning', message: `${c.kind} "${c.id}" has no origin — every miss fails` });
    const fannedInto = (into.get(c.id) ?? []).some((p) => (ids.get(p)?.fanout ?? 1) > 1);
    if ((c.instances ?? 1) > 1 && c.kind !== 'llm' && !fannedInto && !parents.some((k) => k === 'lb' || k === 'gateway' || k === 'queue')) issues.push({ level: 'warning', message: `"${c.id}" has ${c.instances} instances but no lb/gateway/queue in front — only one receives traffic` });
    if (c.kind === 'replica' && !parents.includes('db')) issues.push({ level: 'warning', message: `replica "${c.id}" is not connected from a db — it will be treated as a plain server` });
    if (c.kind !== 'client' && !(into.get(c.id) ?? []).length) issues.push({ level: 'warning', message: `"${c.id}" receives no traffic (nothing connects to it)` });
    if (c.fallback && !c.breaker) issues.push({ level: 'warning', message: `"${c.id}" has fallback without breaker — fallback only applies while a breaker is open` });
  }
  for (const z of spec.zones ?? []) for (const m of z.members) if (!ids.has(m)) issues.push({ level: 'error', message: `zone "${z.id}" lists unknown member "${m}"` });

  return { ok: !issues.some((i) => i.level === 'error'), issues, spec };
}
