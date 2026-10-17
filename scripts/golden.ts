// Golden outputs for the native CLI and MCP server: recorded once from the TypeScript implementations
// they replaced (byte for byte), and checked on every change since. Small outputs are kept as text so
// a difference reads as a diff; large files (datasets, workspaces) as a hash and a size.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';

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

/** a mock server (test/cli-fixtures/mock-*.mjs) on a free port, so checkouts side by side don't
 *  collide: the goldens are recorded against `canonical`, and `ports` maps it to the port in use */
export async function mock(script: string, canonical: number): Promise<{ proc: ChildProcess; canonical: number; port: number }> {
  const proc = spawn('node', [script, '0'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const port = await new Promise<number>((res, rej) => {
    let b = '';
    proc.stdout!.on('data', (d) => {
      const m = /listening on (\d+)/.exec((b += d));
      if (m) res(Number(m[1]));
    });
    proc.on('exit', (code) => rej(new Error(`${script} exited (${code}) before listening`)));
  });
  return { proc, canonical, port };
}

/** a port free right now, for a server the binary starts itself */
export const freePort = () =>
  new Promise<number>((res) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });

/** between the canonical ports the goldens hold and the ones in use: `to` for what is sent, `from`
 *  for what comes back (127.0.0.1:port, plain or URL-encoded), so no real port reaches a golden */
export function ports(used: { canonical: number; port: number }[]) {
  const swap = (s: string, a: (x: { canonical: number; port: number }) => number, b: (x: { canonical: number; port: number }) => number) =>
    used.reduce((t, u) => t.replace(new RegExp(`127\\.0\\.0\\.1(%3A|:)${a(u)}(?!\\d)`, 'g'), `127.0.0.1$1${b(u)}`), s);
  return { to: (s: string) => swap(s, (u) => u.canonical, (u) => u.port), from: (s: string) => swap(s, (u) => u.port, (u) => u.canonical) };
}
