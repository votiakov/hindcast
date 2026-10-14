import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { FileAccess } from '../src/backtest/import/manifest';

/** read a file line by line without holding it in one string */
export function* readLines(path: string, chunk = 1 << 22): Generator<string> {
  const fd = openSync(path, 'r');
  const buf = Buffer.alloc(chunk);
  let rest = '';
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, chunk, null);
      if (n <= 0) break;
      const text = rest + buf.toString('utf8', 0, n);
      const parts = text.split('\n');
      rest = parts.pop() ?? '';
      yield* parts;
    }
    if (rest) yield rest;
  } finally {
    closeSync(fd);
  }
}

/** a file in blocks of bytes; each block is valid until the next is asked for (one buffer, reused) */
export function* readChunks(path: string, chunk = 1 << 22): Generator<Uint8Array> {
  const fd = openSync(path, 'r');
  const buf = Buffer.allocUnsafe(chunk);
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, chunk, null);
      if (n <= 0) break;
      yield buf.subarray(0, n);
    }
  } finally {
    closeSync(fd);
  }
}

/** minimal glob: `*` and `**` within path segments */
export function glob(pattern: string, base = '.'): string[] {
  const abs = resolve(base, pattern);
  if (!/[*?]/.test(pattern)) return existsSync(abs) ? [abs] : [];
  const segs = abs.split('/');
  const firstWild = segs.findIndex((s) => /[*?]/.test(s));
  const root = segs.slice(0, firstWild).join('/') || '/';
  const re = new RegExp('^' + segs.slice(firstWild).join('/').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$');
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (re.test(relative(root, p))) out.push(p);
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

/** file access relative to a manifest's directory */
export function fileAccess(manifestPath: string): FileAccess {
  const base = dirname(resolve(manifestPath));
  return {
    read: (p) => readFileSync(resolve(base, p), 'utf8'),
    glob: (p) => glob(p, base),
    lines: (p) => readLines(resolve(base, p)),
    chunks: (p) => readChunks(resolve(base, p)),
  };
}
