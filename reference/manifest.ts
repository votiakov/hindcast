/**
 * Write the Bottleneck import manifest for a recorded reference run — the same file a user writes
 * for their own system (see docs/backtest.md).
 *
 *   npx tsx reference/manifest.ts <system> <run>
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { exportPlan, manifestMetrics } from '../src/backtest/import/promExport';
import type { ReferenceConfig } from './record';

const ROOT = dirname(fileURLToPath(import.meta.url));

export function writeManifest(system: string, run: string) {
  const sysDir = join(ROOT, system);
  const cfg = parse(readFileSync(join(sysDir, 'reference.yaml'), 'utf8')) as ReferenceConfig;
  const dir = join(sysDir, 'runs', run);
  const meta = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as { sampling?: number };
  const plan = [...exportPlan(['otel-spanmetrics'], { window: '30s' }), ...exportPlan(['cadvisor'], { window: '30s' })];
  const traces = existsSync(join(dir, 'traces.jsonl')) ? 'traces.jsonl' : 'raw/traces.jsonl';
  const manifest = {
    name: `${cfg.name} — ${run}`,
    step: '30s',
    metrics: [...manifestMetrics(plan, 'metrics'), { csv: 'client.csv' }],
    traces: [{ file: traces, sampling: meta.sampling ?? 1, series: { rps: false, latency: false, endpoints: false } }],
    billing: [{ cur: 'bill.csv', tag: 'user:service' }],
    ...(cfg.placement ? { placement: cfg.placement } : {}),
    model: { slo: cfg.slo, timeoutMs: Number(String(cfg.timeout ?? '5s').replace('s', '')) * 1000, ...(cfg.hostedBy ? { hostedBy: cfg.hostedBy } : {}) },
  };
  writeFileSync(join(dir, 'bottleneck.import.yaml'), `# Recorded reference run (${system}/${run}); see reference/README.md\n` + stringify(manifest));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) writeManifest(process.argv[2], process.argv[3]);
