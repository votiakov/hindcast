// The reference harnesses drive Hindcast the way an agent does: through the native binary
// (`hindcast agent <tool>`), on a workspace directory.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'hindcast');

/** run the CLI; its stdout, or an error with its stderr */
export function hindcast(args: string[]): string {
  const r = spawnSync(BIN, args, { encoding: 'utf8', maxBuffer: 1 << 30, env: { ...process.env, NO_COLOR: '1' } });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || `hindcast ${args[0]} exited with ${r.status}`).trim());
  return r.stdout;
}

/** an agent tool on a workspace: its JSON answer */
export function agent<T = any>(tool: string, ws: Workspace, args: Record<string, unknown> = {}): T {
  return JSON.parse(hindcast(['agent', tool, JSON.stringify({ workspace: ws.dir, ...args })])) as T;
}

export class Workspace {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = resolve(dir);
  }
  path(...p: string[]) {
    return join(this.dir, ...p);
  }
  readJson<T>(p: string): T {
    return JSON.parse(readFileSync(this.path(p), 'utf8')) as T;
  }
  writeJson(p: string, v: unknown, pretty = true) {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path(p), pretty ? JSON.stringify(v, null, 1) : JSON.stringify(v));
  }
}

/** the strategy a manifest change amounts to (`hindcast diff-strategy`), or undefined when nothing the model knows changed */
export function strategyFromManifests(base: string, head: string, model: string): unknown {
  const out = join(mkdtempSync(join(tmpdir(), 'hindcast-diff-')), 'strategy.yaml');
  hindcast(['diff-strategy', '--base', base, '--head', head, '--model', model, '--out', out]);
  const text = existsSync(out) ? readFileSync(out, 'utf8') : '';
  return text.trim() ? parse(text) : undefined;
}
