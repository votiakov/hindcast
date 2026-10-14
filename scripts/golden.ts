// Golden outputs for the native CLI and MCP server: recorded once from the TypeScript implementations
// they replaced (byte for byte), and checked on every change since. Small outputs are kept as text so
// a difference reads as a diff; large files (datasets, workspaces) as a hash and a size.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

const TEXT_MAX = 16_384;

export type Stored = string | { sha256: string; bytes: number };
export const store = (text: string): Stored => (text.length <= TEXT_MAX ? text : { sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) });

const walk = (d: string): string[] => readdirSync(d).sort().flatMap((f) => (statSync(`${d}/${f}`).isDirectory() ? walk(`${d}/${f}`) : [`${d}/${f}`]));

/** every file under root (masked), keyed by its path relative to root */
export function snapshot(root: string, mask: (s: string) => string): Map<string, string> {
  const m = new Map<string, string>();
  if (existsSync(root)) for (const f of walk(root)) m.set(mask(f.slice(root.length + 1)), mask(readFileSync(f, 'utf8')));
  return m;
}

/** the files a step added or changed */
export function changed(before: Map<string, string>, after: Map<string, string>): Record<string, Stored> {
  const out: Record<string, Stored> = {};
  for (const [k, v] of after) if (before.get(k) !== v) out[k] = store(v);
  return out;
}

export const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
export const write = (path: string, v: unknown) => writeFileSync(path, JSON.stringify(v, null, 1) + '\n');

/** where two values first differ, for a readable report */
export function firstDiff(label: string, a: unknown, b: unknown): string | null {
  const x = typeof a === 'string' ? a : JSON.stringify(a);
  const y = typeof b === 'string' ? b : JSON.stringify(b);
  if (x === y) return null;
  const lx = x.split('\n');
  const ly = y.split('\n');
  let i = 0;
  while (lx[i] === ly[i]) i++;
  const p = lx[i] ?? '';
  const q = ly[i] ?? '';
  let j = 0;
  while (j < p.length && p[j] === q[j]) j++;
  const cut = (t: string) => (j > 120 ? '…' : '') + t.slice(Math.max(0, j - 120), j + 120);
  return `  ${label} line ${i + 1}, column ${j + 1}:\n    want: ${JSON.stringify(cut(p))}\n    got:  ${JSON.stringify(cut(q))}`;
}
