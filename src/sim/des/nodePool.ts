import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { aggregate, seedsFor, slim, type Analysis, type RunSummary } from './analyze';
import { simulateDes, type DesConfig } from './des';

/**
 * Parallel Monte Carlo for Node (CLI, MCP): seeds are spread over worker threads.
 * Workers run the TypeScript sources through tsx; if threads are unavailable, it falls back
 * to running in-process.
 */
export async function analyzeParallel(spec: unknown, scenario: unknown, opts: { runs?: number; seed?: number; des?: Partial<DesConfig>; threads?: number } = {}): Promise<Analysis> {
  const t0 = performance.now();
  const seeds = seedsFor(opts.runs ?? 20, opts.seed);
  const threads = Math.max(1, Math.min(opts.threads ?? availableParallelism() - 1, seeds.length));
  const chunks: number[][] = Array.from({ length: threads }, () => []);
  seeds.forEach((s, i) => chunks[i % threads].push(s));

  let runs: RunSummary[];
  try {
    if (threads === 1) throw new Error('single thread');
    runs = (
      await Promise.all(
        chunks.map(
          (chunk) =>
            new Promise<RunSummary[]>((resolve, reject) => {
              // bootstrap: register tsx inside the thread, then load the TypeScript worker module
              const entry = new URL('./nodeWorker.ts', import.meta.url).href;
              const boot = `import('tsx/esm/api').then(({ register }) => { register(); return import(${JSON.stringify(entry)}); })`;
              const w = new Worker(boot, { eval: true, workerData: { spec, scenario, seeds: chunk, des: opts.des ?? {} } });
              w.once('message', resolve);
              w.once('error', reject);
              w.once('exit', (code) => code !== 0 && reject(new Error(`worker exited ${code}`)));
            }),
        ),
      )
    ).flat();
  } catch {
    runs = seeds.map((seed) => slim(simulateDes(spec, scenario, { ...opts.des, seed })));
  }
  runs.sort((a, b) => seeds.indexOf(a.seed) - seeds.indexOf(b.seed));
  return aggregate(runs, Math.round(performance.now() - t0));
}
