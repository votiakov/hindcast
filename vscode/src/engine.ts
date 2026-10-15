import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { AuditDone, Progress, Summary, Validation } from './protocol';

/**
 * The engine, two ways: the bundled WebAssembly in a worker thread (default), or the native
 * `hindcast` command line when `hindcast.path` is set and the WebAssembly is not there or
 * `hindcast.engine` asks for it. Both run the same Rust.
 */
export interface Engine {
  readonly kind: 'wasm' | 'cli';
  validate(value: unknown, text: string): Promise<Validation>;
  summary(value: unknown, text: string, rps?: number): Promise<Summary>;
  audit(value: unknown, text: string, opts: { rps?: number; costPerMinute?: number }, progress?: (p: Progress) => void): Promise<AuditDone>;
  dispose(): void;
}

export class WasmEngine implements Engine {
  readonly kind = 'wasm';
  private worker: Worker | null = null;
  private next = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; progress?: (p: Progress) => void }>();

  constructor(private readonly dir: string) {}

  static available(dir: string) {
    return existsSync(join(dir, 'worker.cjs')) && existsSync(join(dir, 'hindcast_engine_bg.wasm'));
  }

  private get w(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(join(this.dir, 'worker.cjs'));
    w.on('message', (m: { id: number; result?: unknown; error?: string; progress?: Progress }) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.progress) return p.progress?.(m.progress);
      this.pending.delete(m.id);
      if (m.error !== undefined) p.reject(new Error(m.error));
      else p.resolve(m.result);
    });
    const fail = (e: Error) => {
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
      if (this.worker === w) this.worker = null;
    };
    w.on('error', fail);
    w.on('exit', (code) => code !== 0 && fail(new Error(`engine worker exited (${code})`)));
    return (this.worker = w);
  }

  private call<T>(msg: Record<string, unknown>, progress?: (p: Progress) => void): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, progress });
      this.w.postMessage({ ...msg, id });
    });
  }

  validate(value: unknown) {
    return this.call<Validation>({ op: 'validate', value });
  }
  summary(value: unknown, _text: string, rps?: number) {
    return this.call<Summary>({ op: 'summary', value, rps });
  }
  audit(value: unknown, _text: string, opts: { rps?: number; costPerMinute?: number }, progress?: (p: Progress) => void) {
    return this.call<AuditDone>({ op: 'audit', value, ...opts }, progress);
  }
  dispose() {
    void this.worker?.terminate();
    this.worker = null;
  }
}

/** run the CLI on the editor's text (saved or not), through a temporary file */
export class CliEngine implements Engine {
  readonly kind = 'cli';
  constructor(private readonly bin: string) {}

  private run(args: string[], text: string, extra?: (dir: string) => string[]): Promise<{ code: number; stdout: string; stderr: string; dir: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'hindcast-'));
    const file = join(dir, 'design.yaml');
    writeFileSync(file, text);
    const argv = [args[0], file, ...args.slice(1), ...(extra?.(dir) ?? [])];
    return new Promise((resolve, reject) =>
      execFile(this.bin, argv, { timeout: 300_000, maxBuffer: 64 << 20, env: { ...process.env, NO_COLOR: '1' } }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : -1) : 0;
        if (code === -1) {
          rmSync(dir, { recursive: true, force: true });
          return reject(new Error(`${this.bin}: ${err?.message}`));
        }
        resolve({ code, stdout, stderr, dir });
      }),
    );
  }

  private json<T>(r: { code: number; stdout: string; stderr: string; dir: string }): T {
    rmSync(r.dir, { recursive: true, force: true });
    try {
      return JSON.parse(r.stdout) as T;
    } catch {
      throw new Error((r.stderr || r.stdout).trim().split('\n')[0] || `hindcast exited ${r.code}`);
    }
  }

  async validate(_value: unknown, text: string) {
    // `validate --json`: messages only; lineMap reads the place back out of them
    return this.json<Validation>(await this.run(['validate', '--json'], text));
  }

  async summary(_value: unknown, text: string, rps?: number): Promise<Summary> {
    const r = this.json<{ scenario: string; summary: { peakP99Ms: number; meanErrorRate: number; meanCostPerHour: number; sloCompliance: number }; slo: Summary['slo']; bottlenecks?: { id: string; peakUtil: number; note: string | null }[] }>(
      await this.run(['simulate', '--json', ...(rps ? ['--rps', String(rps)] : [])], text),
    );
    const top = r.bottlenecks?.[0];
    return { scenario: r.scenario, p99Ms: r.summary.peakP99Ms, errorRate: r.summary.meanErrorRate, monthly: r.summary.meanCostPerHour * 730, sloCompliance: r.summary.sloCompliance, slo: r.slo, bottleneck: top && top.peakUtil >= 0.8 ? { id: top.id, note: top.note } : null };
  }

  async audit(_value: unknown, text: string, opts: { rps?: number; costPerMinute?: number }): Promise<AuditDone> {
    const args = ['audit', '--json', ...(opts.rps ? ['--rps', String(opts.rps)] : []), ...(opts.costPerMinute ? ['--cost-per-min', String(opts.costPerMinute)] : [])];
    const r = await this.run(args, text, (dir) => ['--md', join(dir, 'audit.md')]);
    const md = join(r.dir, 'audit.md');
    const markdown = existsSync(md) ? readFileSync(md, 'utf8') : '';
    const v = this.json<{ score: number; findings: { severity: string }[] }>(r);
    if (!markdown) throw new Error('hindcast audit wrote no report');
    return { markdown, score: v.score, critical: v.findings.filter((f) => f.severity === 'critical').length };
  }

  dispose() {}
}
