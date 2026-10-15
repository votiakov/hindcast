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
    return { ok: false, issues: parsed.error.issues.map((i) => ({ level: 'error', message: describeIssue(i, input) })) };
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
    if ((c.kind === 'lb' || c.kind === 'gateway' || c.kind === 'queue' || c.kind === 'stream' || c.kind === 'dns') && !kids.length) issues.push({ level: 'error', message: `${c.kind} "${c.id}" has nothing behind it — every request fails` });
    if ((c.kind === 'cache' || c.kind === 'cdn') && !kids.length) issues.push({ level: 'warning', message: `${c.kind} "${c.id}" has no origin — every miss fails` });
    const fannedInto = (into.get(c.id) ?? []).some((p) => (ids.get(p)?.fanout ?? 1) > 1);
    if ((c.instances ?? 1) > 1 && c.kind !== 'llm' && c.kind !== 'search' && !fannedInto && !parents.some((k) => k === 'lb' || k === 'gateway' || k === 'queue' || k === 'stream')) issues.push({ level: 'warning', message: `"${c.id}" has ${c.instances} instances but no lb/gateway/queue in front — only one receives traffic` });
    if (c.kind === 'replica' && !parents.includes('db')) issues.push({ level: 'warning', message: `replica "${c.id}" is not connected from a db — it will be treated as a plain server` });
    if (c.kind !== 'client' && !(into.get(c.id) ?? []).length) issues.push({ level: 'warning', message: `"${c.id}" receives no traffic (nothing connects to it)` });
    if (c.fallback && !c.breaker) issues.push({ level: 'warning', message: `"${c.id}" has fallback without breaker — fallback only applies while a breaker is open` });
  }
  for (const z of spec.zones ?? []) for (const m of z.members) if (!ids.has(m)) issues.push({ level: 'error', message: `zone "${z.id}" lists unknown member "${m}"` });

  return { ok: !issues.some((i) => i.level === 'error'), issues, spec };
}

type ZIssue = { code: string; path: PropertyKey[]; message: string; values?: unknown[]; minimum?: unknown; maximum?: unknown; expected?: string };

const distance = (a: string, b: string) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};

/** a schema error in words: which component, which field, what it was, what it should be */
export function describeIssue(i: ZIssue, input: unknown): string {
  const doc = (input ?? {}) as { components?: { id?: unknown }[]; connections?: unknown[] };
  const [head, idx, ...rest] = i.path;
  const field = rest.join('.');
  const got = (path: PropertyKey[]) => path.reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<PropertyKey, unknown>)[k] : undefined), input);
  const value = got(i.path);
  const show = (v: unknown) => (typeof v === 'string' ? `"${v}"` : JSON.stringify(v));
  if (head === 'components' && typeof idx === 'number') {
    const id = doc.components?.[idx]?.id;
    const who = typeof id === 'string' ? `component "${id}"` : `component #${idx + 1}`;
    if (!field) return `${who}: ${i.message}`;
    if (i.code === 'invalid_value' && i.values && typeof value === 'string') {
      const options = i.values.map(String);
      const near = options.map((o) => ({ o, d: distance(value.toLowerCase(), o.toLowerCase()) })).sort((a, b) => a.d - b.d)[0];
      return `${who}: ${field} ${show(value)} is not valid${near && near.d <= 3 ? ` — did you mean "${near.o}"?` : ''} (one of ${options.join(', ')})`;
    }
    if (i.code === 'too_small' && i.minimum !== undefined) return `${who}: ${field} must be at least ${String(i.minimum)}${value !== undefined ? ` (it is ${show(value)})` : ''}`;
    if (i.code === 'too_big' && i.maximum !== undefined) return `${who}: ${field} must be at most ${String(i.maximum)}${value !== undefined ? ` (it is ${show(value)})` : ''}`;
    if (i.code === 'invalid_type' && value === undefined) return `${who}: ${field} is missing`;
    if (i.code === 'unrecognized_keys') return `${who}: ${i.message}`;
    return `${who}: ${field}: ${i.message}`;
  }
  if (head === 'connections' && typeof idx === 'number') return `connection ${show(doc.connections?.[idx])}: write it as "from -> to", ["from", "to"] or { from, to }`;
  if (head === 'components' && i.code === 'too_small') return 'the spec needs at least one component';
  return `${i.path.join('.') || 'spec'}: ${i.message}`;
}
