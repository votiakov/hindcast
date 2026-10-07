/**
 * Record a reference run: start the system, replay a traffic shape with k6, then export
 * everything Bottleneck imports — Prometheus query_range JSON (via the same presets the CLI's
 * `export-prometheus` uses), the OTLP trace file, client-side endpoint series from k6, and a
 * Fargate-priced AWS CUR built from the containers' actual runtime.
 *
 *   npx tsx reference/record.ts <system> <run>          e.g. hotrod history
 *
 * Needs Docker and the recording stack (reference/stack). Runs take real time (the shape's length).
 */
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { exportPlan, runExport } from '../src/backtest/import/promExport';
import { clientCsv, readK6, requestsCsv } from './k6';
import { synthesiseCur } from './bill';
import { autoscaleLoop } from './autoscaler';
import { writeManifest } from './manifest';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PROM = process.env.PROM_URL ?? 'http://localhost:9090';

export interface ReferenceConfig {
  name: string;
  project: string;
  base: string;
  timeout?: string;
  /** k6 Poisson thinning factor (default 20; lower for high request rates) */
  thin?: number;
  mix: string;
  /** zone per compose service, for the bill's transfer lines and the model's placement */
  placement?: Record<string, { zone?: string; region?: string }>;
  /** compose service whose transmitted bytes leave to the internet */
  edge?: string;
  /** in-process dependencies seen in traces (e.g. HotROD's simulated mysql lives in customer) */
  hostedBy?: Record<string, string>;
  slo: { p99Ms: number; errorRate: number };
  runs: Record<string, { shape: (string | number)[]; env?: Record<string, string | number>; autoscale?: { service: string; min: number; max: number; targetCpu: number; cooldownS?: number; intervalS?: number } }>;
}

const sh = (cmd: string, env: Record<string, string> = {}) => execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...env } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [system, run] = process.argv.slice(2);
  if (!system || !run) throw new Error('usage: record.ts <system> <run>');
  const sysDir = join(ROOT, system);
  const cfg = parse(readFileSync(join(sysDir, 'reference.yaml'), 'utf8')) as ReferenceConfig;
  const r = cfg.runs[run];
  if (!r) throw new Error(`no run "${run}" in ${system}/reference.yaml`);
  const out = join(sysDir, 'runs', run);
  if (existsSync(out)) rmSync(out, { recursive: true });
  mkdirSync(join(out, 'raw'), { recursive: true });
  mkdirSync(join(out, 'metrics'), { recursive: true });
  const env = Object.fromEntries(Object.entries(r.env ?? {}).map(([k, v]) => [k, String(v)]));

  // 1. fresh trace file for this run, fresh system
  sh(`docker compose -f ${join(ROOT, 'stack/docker-compose.yml')} up -d --force-recreate otel-collector`, { RUN_DIR: resolve(out, 'raw') });
  sh(`docker compose -f ${join(sysDir, 'docker-compose.yml')} up -d --force-recreate --remove-orphans`, env);
  console.log('warming up 45 s…');
  await sleep(45_000);
  // drop warm-up spans: restart the collector into the run directory
  rmSync(join(out, 'raw', 'traces.jsonl'), { force: true });
  sh(`docker compose -f ${join(ROOT, 'stack/docker-compose.yml')} up -d --force-recreate otel-collector`, { RUN_DIR: resolve(out, 'raw') });
  await sleep(5_000);

  // 2. replay
  const shape = spawnSync('node', [join(ROOT, 'load/shape.mjs'), ...r.shape.map(String)], { encoding: 'utf8' }).stdout;
  writeFileSync(join(out, 'shape.json'), shape);
  writeFileSync(join(out, 'mix.json'), readFileSync(join(sysDir, cfg.mix)));
  const start = Math.floor(Date.now() / 1000);
  let scaling: { stop: () => Promise<void> } | null = null;
  if (r.autoscale) scaling = autoscaleLoop({ prom: PROM, compose: join(sysDir, 'docker-compose.yml'), project: cfg.project, env, ...r.autoscale, log: join(out, 'autoscaler.log') });
  // one load generator at a time: a leftover k6 from an interrupted run would double the load
  execSync('docker rm -f bnref-k6 >/dev/null 2>&1 || true');
  sh(
    `docker run --rm --name bnref-k6 --network bnref -v ${join(ROOT, 'load')}:/load:ro -v ${out}:/out -e SHAPE=/out/shape.json -e MIX=/out/mix.json -e BASE=${cfg.base} -e TIMEOUT=${cfg.timeout ?? '5s'} -e THIN=${cfg.thin ?? 20} grafana/k6:latest run --quiet --out csv=/out/raw/k6.csv /load/replay.js`,
  );
  const end = Math.floor(Date.now() / 1000);
  if (scaling) await scaling.stop();
  console.log('flushing 30 s…');
  await sleep(30_000);

  // 3. export
  const scoped = [...exportPlan(['otel-spanmetrics'], { window: '30s' }), ...exportPlan(['cadvisor'], { window: '30s', selector: `container_label_com_docker_compose_project="${cfg.project}"` })];
  const res = await runExport(PROM, scoped, { start, end, stepS: 10 }, (f, body) => writeFileSync(join(out, 'metrics', f), body));
  console.log('exported', res);
  const memRes = await fetch(`${PROM}/api/v1/query_range?${new URLSearchParams({ query: `max by (container_label_com_docker_compose_service) (container_spec_memory_limit_bytes{container_label_com_docker_compose_project="${cfg.project}"})`, start: String(start), end: String(end), step: '10s' })}`);
  writeFileSync(join(out, 'metrics', 'memory-limit.json'), await memRes.text());

  const reqs = readK6(join(out, 'raw', 'k6.csv'));
  writeFileSync(join(out, 'requests.csv'), requestsCsv(reqs));
  writeFileSync(join(out, 'client.csv'), clientCsv(reqs, 30));
  writeFileSync(join(out, 'bill.csv'), synthesiseCur(join(out, 'metrics'), { start, end, placement: cfg.placement ?? {}, edge: cfg.edge }));
  const sampling = Number(/sampling_percentage:\s*(\d+)/.exec(readFileSync(join(ROOT, 'stack/otel-collector.yaml'), 'utf8'))?.[1] ?? 100) / 100;
  writeFileSync(join(out, 'run.json'), JSON.stringify({ system, run, start, end, env, shape: r.shape, autoscale: r.autoscale ?? null, sampling, recordedAt: new Date().toISOString() }, null, 2));
  writeManifest(system, run);
  console.log(`done: ${out} (${Math.round((end - start) / 60)} min)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
