/**
 * Record a Kubernetes reference run on the local kind cluster (reference/k8s/README.md):
 * apply the run's manifests (the as-built system, or a change as a pull request would leave it),
 * restart and warm the pods, replay a real day from an access log with k6, then collect the run's
 * telemetry the way a user's agent would — connect_telemetry + collect_telemetry against the live
 * Prometheus and Jaeger — and keep every request k6 made as the ground truth.
 *
 *   npx tsx reference/k8s/record.ts <system> <run>        e.g. shop history
 *
 * kubectl only ever runs with KUBECONFIG=$BNK8S_KUBECONFIG and --context kind-bnk8s: it can't
 * reach any other cluster.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { clientCsv, readK6, requestsCsv } from '../k6';
import { Workspace } from '../../agent/workspace';
import { connectTelemetry } from '../../agent/connect';
import { collect } from '../../agent/collect';

const ROOT = dirname(fileURLToPath(import.meta.url));
const LOAD = join(ROOT, '..', 'load');
const CONTEXT = 'kind-bnk8s';
const KUBECONFIG = process.env.BNK8S_KUBECONFIG;

export interface K8sReference {
  name: string;
  namespace: string;
  /** where k6 (on the kind Docker network) sends requests */
  base: string;
  prometheus: string;
  jaeger: string;
  mix: string;
  thin?: number;
  timeout?: string;
  slo: { p99Ms: number; errorRate: number };
  /** a gentle load before recording so runtimes are warm: shape.mjs args */
  warmup: (string | number)[];
  /** the access log the days are replayed from */
  log: string;
  /** a day from the log, or a step load test (shape.mjs steps args: from, to, step, holdS) */
  runs: Record<string, { day?: string; minutes?: number; scale?: string; steps?: (string | number)[]; manifests: string; note?: string; kill?: { node: string; atS: number } }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function kubectl(args: string[], opts: { input?: string; quiet?: boolean } = {}): string {
  if (!KUBECONFIG) throw new Error('set BNK8S_KUBECONFIG to the kind cluster’s kubeconfig (kind get kubeconfig --name bnk8s > file)');
  return execFileSync('kubectl', ['--context', CONTEXT, ...args], { env: { ...process.env, KUBECONFIG }, encoding: 'utf8', input: opts.input, stdio: ['pipe', 'pipe', opts.quiet ? 'ignore' : 'inherit'] });
}

function k6(out: string, shapeFile: string, cfg: K8sReference, csv: boolean): Promise<void> {
  // one load generator at a time: a leftover k6 from an interrupted run would double the load
  spawnSync('docker', ['rm', '-f', 'bnk8s-k6'], { stdio: 'ignore' });
  const args = ['run', '--rm', '--name', 'bnk8s-k6', '--network', 'kind', '-v', `${LOAD}:/load:ro`, '-v', `${out}:/out`, '-e', `SHAPE=/out/${shapeFile}`, '-e', 'MIX=/out/mix.json', '-e', `BASE=${cfg.base}`, '-e', `TIMEOUT=${cfg.timeout ?? '5s'}`, '-e', `THIN=${cfg.thin ?? 5}`, 'grafana/k6:latest', 'run', '--quiet', ...(csv ? ['--out', 'csv=/out/raw/k6.csv'] : []), '/load/replay.js'];
  return new Promise((res, rej) => {
    const p = spawn('docker', args, { stdio: csv ? 'inherit' : 'ignore' });
    p.on('close', (code) => (code === 0 || code === 99 ? res() : rej(new Error(`k6 exited ${code}`))));
  });
}

async function main() {
  const [system, run] = process.argv.slice(2);
  if (!system || !run) throw new Error('usage: record.ts <system> <run>');
  const sysDir = join(ROOT, system);
  const cfg = parse(readFileSync(join(sysDir, 'reference.yaml'), 'utf8')) as K8sReference;
  const r = cfg.runs[run];
  if (!r) throw new Error(`no run "${run}" in ${system}/reference.yaml`);
  const out = join(sysDir, 'runs', run);
  if (existsSync(out)) rmSync(out, { recursive: true });
  mkdirSync(join(out, 'raw'), { recursive: true });
  writeFileSync(join(out, 'mix.json'), readFileSync(resolve(sysDir, cfg.mix)));

  // 1. the run's manifests, applied as a deploy would apply them; objects the run doesn't have
  //    (an autoscaler from another run) are removed
  const manifests = resolve(sysDir, r.manifests);
  kubectl(['apply', '-f', manifests]);
  if (!/kind: HorizontalPodAutoscaler/.test(readFileSync(manifests, 'utf8'))) kubectl(['-n', cfg.namespace, 'delete', 'hpa', '--all', '--ignore-not-found']);
  // fresh pods for every run: no cache or JIT state carried over from the previous one. Not the
  // telemetry: Jaeger keeps every run's traces (an agent collects any of them later)
  kubectl(['-n', cfg.namespace, 'rollout', 'restart', 'deploy', '-l', 'app notin (jaeger,otel-collector)']);
  kubectl(['-n', cfg.namespace, 'rollout', 'status', 'deploy', '--timeout=600s'], { quiet: true });
  console.log('rolled out; warming up…');
  await sleep(20_000);
  writeFileSync(join(out, 'raw', 'warmup.json'), spawnSync('node', [join(LOAD, 'shape.mjs'), ...cfg.warmup.map(String)], { encoding: 'utf8' }).stdout);
  await k6(out, 'raw/warmup.json', cfg, false);
  // the autoscaler starts from its minimum, as it would at the start of a day
  if (/kind: HorizontalPodAutoscaler/.test(readFileSync(manifests, 'utf8'))) {
    kubectl(['apply', '-f', manifests]);
    await sleep(30_000);
  }
  await sleep(30_000);

  // 2. replay the day (or step the load up)
  const shape = r.steps ? spawnSync('node', [join(LOAD, 'shape.mjs'), 'steps', ...r.steps.map(String)], { encoding: 'utf8' }) : spawnSync('node', [join(LOAD, 'fromLog.mjs'), resolve(sysDir, cfg.log), r.day!, String(r.minutes), r.scale!], { encoding: 'utf8' });
  if (shape.status !== 0) throw new Error(shape.stderr);
  process.stdout.write(shape.stderr);
  writeFileSync(join(out, 'shape.json'), shape.stdout);
  const replicas = () => kubectl(['-n', cfg.namespace, 'get', 'deploy', 'frontend', '-o', 'jsonpath={.status.readyReplicas}'], { quiet: true }).trim();
  const scaleLog: string[] = [];
  const watch = setInterval(() => scaleLog.push(`${Math.floor(Date.now() / 1000)} ${replicas()}`), 15_000);
  const start = Math.floor(Date.now() / 1000);
  // a node failure, for real: its container stops (as a VM would vanish), mid-day. What ran on it
  // is written down first — the placement a node-loss prediction starts from
  let killedAt: number | null = null;
  const kill = r.kill
    ? setTimeout(() => {
        const pods = kubectl(['get', 'pods', '-A', '-o', 'jsonpath={range .items[*]}{.metadata.namespace} {.metadata.name} {.spec.nodeName} {.status.phase}{"\\n"}{end}'], { quiet: true });
        writeFileSync(join(out, 'placement.txt'), pods);
        killedAt = Math.floor(Date.now() / 1000);
        spawnSync('docker', ['stop', r.kill!.node], { stdio: 'ignore' });
        console.log(`killed ${r.kill!.node} at ${killedAt}`);
      }, r.kill.atS * 1000)
    : null;
  await k6(out, 'shape.json', cfg, true);
  const end = Math.floor(Date.now() / 1000);
  if (kill) clearTimeout(kill);
  if (r.kill && killedAt) {
    spawnSync('docker', ['start', r.kill.node], { stdio: 'ignore' });
    kubectl(['wait', '--for=condition=Ready', `node/${r.kill.node}`, '--timeout=300s'], { quiet: true });
    console.log(`${r.kill.node} is back`);
  }
  clearInterval(watch);
  writeFileSync(join(out, 'frontend-replicas.log'), scaleLog.join('\n') + '\n');
  console.log('flushing 45 s…');
  await sleep(45_000);

  // 3. ground truth from the client
  const reqs = readK6(join(out, 'raw', 'k6.csv'));
  writeFileSync(join(out, 'requests.csv'), requestsCsv(reqs));
  writeFileSync(join(out, 'client.csv'), clientCsv(reqs, 30));
  rmSync(join(out, 'raw', 'k6.csv'));

  // the run is recorded: its metadata first, so a failed collection below doesn't lose it
  writeFileSync(join(out, 'run.json'), JSON.stringify({ system, run, start, end, day: r.day ?? null, minutes: r.minutes ?? null, scale: r.scale ?? null, steps: r.steps ?? null, manifests: r.manifests, note: r.note ?? null, ...(r.kill ? { kill: { node: r.kill.node, at: killedAt } } : {}), recordedAt: new Date().toISOString() }, null, 2));

  // 4. telemetry, collected the way an agent collects it: from the live Prometheus and Jaeger
  const ws = new Workspace(join(out, 'workspace'));
  const conn = await connectTelemetry(ws, { prometheus: { url: cfg.prometheus }, jaeger: { url: cfg.jaeger }, system: { name: `${cfg.name} — ${run}`, slo: cfg.slo, timeoutMs: Number(String(cfg.timeout ?? '5s').replace('s', '')) * 1000 } });
  if (conn.problems.length) console.warn('connect problems:', conn.problems);
  // a killed node may have taken Jaeger and its traces with it: the metrics still stand
  const col = await collect(ws, { start, end, stepS: 30 }).catch((e) => {
    if (!r.kill) throw e;
    console.warn(`collection failed after the node kill: ${(e as Error).message}`);
    return { window: { buckets: 0 }, services: 0, warnings: [String(e)] } as unknown as Awaited<ReturnType<typeof collect>>;
  });
  writeFileSync(join(out, 'collect.json'), JSON.stringify(col, null, 1));
  console.log(`collected ${col.window.buckets} buckets, ${col.services} services; warnings: ${col.warnings.length}`);
  console.log(`done: ${out} (${Math.round((end - start) / 60)} min, ${reqs.length} requests)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
