import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';

/**
 * The agent workspace: one directory (default `.bottleneck/` in the directory the agent runs in)
 * holding where the telemetry lives, what was collected, the calibrated model and the reports.
 *
 *   .bottleneck/
 *     sources.json          connections and system hints (never secrets: credentials are env var names)
 *     telemetry/            the last collection: metrics/*.json, traces/*.json, bottleneck.import.yaml
 *     dataset.json          the imported history
 *     model.json            the calibrated model
 *     calibration.json      what the model rests on, per service (history peak vs capacity)
 *     cluster/              read_cluster snapshots
 *     reports/              verify_change reports (HTML + Markdown)
 */

const Auth = z
  .object({
    tokenEnv: z.string().optional().describe('name of an env var holding a bearer token'),
    basicAuthEnv: z.string().optional().describe('name of an env var holding "user:password"'),
    headersEnv: z.record(z.string(), z.string()).optional().describe('header name → env var holding its value (e.g. X-Scope-OrgID)'),
  })
  .partial();

export const Sources = z.object({
  system: z
    .object({
      name: z.string().default('my system'),
      slo: z.object({ p99Ms: z.number().positive(), errorRate: z.number().min(0).max(1) }).optional(),
      timeoutMs: z.number().positive().optional(),
      rename: z.record(z.string(), z.string()).optional(),
      hostedBy: z.record(z.string(), z.string()).optional(),
      ignore: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
      entry: z.array(z.string()).optional(),
      placement: z.record(z.string(), z.object({ zone: z.string().optional(), region: z.string().optional() })).optional(),
    })
    .default({ name: 'my system' }),
  prometheus: z.object({ url: z.string().url(), presets: z.array(z.string()).optional(), selector: z.string().optional(), namespaces: z.array(z.string()).optional() }).merge(Auth).optional(),
  jaeger: z.object({ url: z.string().url() }).merge(Auth).optional(),
  tempo: z.object({ url: z.string().url() }).merge(Auth).optional(),
  traceFiles: z.array(z.string()).optional(),
  bill: z
    .object({ cur: z.string().optional(), gcp: z.string().optional(), tag: z.string().optional(), resources: z.record(z.string(), z.string()).optional() })
    .optional(),
  kube: z.object({ context: z.string(), namespace: z.string().optional() }).optional(),
});
export type Sources = z.infer<typeof Sources>;
export type AuthConfig = z.infer<typeof Auth>;

export class Workspace {
  readonly dir: string;
  constructor(dir?: string) {
    this.dir = resolve(dir ?? process.env.BOTTLENECK_WORKSPACE ?? join(process.cwd(), '.bottleneck'));
  }
  path(...p: string[]) {
    return join(this.dir, ...p);
  }
  ensure(...p: string[]) {
    const d = this.path(...p);
    mkdirSync(d, { recursive: true });
    return d;
  }
  has(file: string) {
    return existsSync(this.path(file));
  }
  readJson<T>(file: string): T {
    const p = this.path(file);
    if (!existsSync(p)) throw new Error(`${file} is not in the workspace (${this.dir}) yet`);
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  }
  writeJson(file: string, v: unknown, pretty = true) {
    this.ensure();
    writeFileSync(this.path(file), JSON.stringify(v, null, pretty ? 1 : undefined));
    return this.path(file);
  }
  sources(): Sources {
    return this.has('sources.json') ? Sources.parse(this.readJson('sources.json')) : Sources.parse({});
  }
  saveSources(s: Sources) {
    return this.writeJson('sources.json', Sources.parse(s));
  }
}

/** request headers from env var names — secrets stay in the environment, never in the workspace */
export function authHeaders(a: AuthConfig | undefined): Record<string, string> {
  const h: Record<string, string> = {};
  if (!a) return h;
  const env = (name: string) => {
    const v = process.env[name];
    if (v === undefined) throw new Error(`env var ${name} is not set (named in the connection's auth)`);
    return v;
  };
  if (a.tokenEnv) h.Authorization = `Bearer ${env(a.tokenEnv)}`;
  if (a.basicAuthEnv) h.Authorization = `Basic ${Buffer.from(env(a.basicAuthEnv)).toString('base64')}`;
  for (const [k, v] of Object.entries(a.headersEnv ?? {})) h[k] = env(v);
  return h;
}

/** GET JSON with a timeout and a useful error */
export async function getJson<T>(url: string, headers: Record<string, string> = {}, timeoutMs = 30_000): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers, signal: ctl.signal });
    const text = await r.text();
    if (!r.ok) throw new Error(`${new URL(url).pathname} answered ${r.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error(`${url} did not answer within ${timeoutMs / 1000} s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** "6h", "14d", "90m" → seconds */
export function seconds(span: string): number {
  const m = /^(\d+(?:\.\d+)?)(s|m|h|d|w)$/.exec(span.trim());
  if (!m) throw new Error(`bad duration "${span}" (e.g. 90m, 6h, 14d)`);
  return parseFloat(m[1]) * { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[m[2] as 's']!;
}

export const iso = (t: number) => new Date(t * 1000).toISOString().replace('.000Z', 'Z');
