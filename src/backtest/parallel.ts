/**
 * Replays on worker threads, for Node hosts (the CLI, the MCP server). A backtest is dozens of
 * independent replays — every capacity draw of every strategy — so they spread over the cores. The
 * call stays synchronous: the main thread hands each worker its share, blocks on a shared counter
 * (Atomics.wait) until all are done and reads the results off the ports (receiveMessageOnPort).
 *
 * The workers run the same file the host runs (the CLI bundle, or this module under tsx), told apart
 * by workerData. Hosts call enableParallelReplays() once; the browser never imports this file.
 */
import { MessageChannel, Worker, isMainThread, parentPort, receiveMessageOnPort, workerData, type MessagePort } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { runPlan, type Plan, type RunResult, type Traffic, type Fault } from './engine';
import { setReplayRunner } from './backtest';
import { loadNativeEngine } from './native';

const ROLE = 'hindcast-replay';

interface Job {
  plans: Plan[];
  traffic: Traffic;
  opts: { faults?: Fault[] };
  port: MessagePort;
  flag: Int32Array;
}

// ---- the worker side: replay what it is handed, post the runs back, count itself done
if (!isMainThread && (workerData as { role?: string } | null)?.role === ROLE) {
  // the compiled engine first, then ready
  void loadNativeEngine().finally(() => parentPort!.postMessage('ready'));
  parentPort!.on('message', (job: Job) => {
    let out: { runs?: RunResult[]; error?: string };
    const moved: ArrayBuffer[] = [];
    try {
      // number arrays travel as typed arrays whose buffers are handed over, not copied element by element
      out = { runs: job.plans.map((p) => pack(runPlan(p, job.traffic, job.opts), moved) as RunResult) };
    } catch (e) {
      out = { error: e instanceof Error ? e.stack ?? e.message : String(e) };
    }
    job.port.postMessage(out, moved);
    Atomics.add(job.flag, 0, 1);
    Atomics.notify(job.flag, 0);
  });
}

/** every number[] in a result becomes a Float64Array (its buffer listed for transfer), and back */
function pack(x: unknown, moved: ArrayBuffer[]): unknown {
  if (Array.isArray(x)) {
    if (x.length > 16 && typeof x[0] === 'number') {
      const f = Float64Array.from(x as number[]);
      moved.push(f.buffer);
      return f;
    }
    return x.map((y) => pack(y, moved));
  }
  if (x && typeof x === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) o[k] = pack(v, moved);
    return o;
  }
  return x;
}
function unpack(x: unknown): unknown {
  if (x instanceof Float64Array) return Array.from(x);
  if (Array.isArray(x)) return x.map(unpack);
  if (x && typeof x === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) o[k] = unpack(v);
    return o;
  }
  return x;
}

let pool: Worker[] = [];

/** replay batches of at least this many plans in parallel; smaller ones aren't worth the copies */
const MIN_BATCH = 6;

/**
 * Install the parallel runner. `entry` is the file the workers load: the host's own bundle (its
 * import.meta.url) or, from source, this module's. Returns how many threads it uses (0: not enabled).
 */
export function enableParallelReplays(entry: string | URL, o: { threads?: number; execArgv?: string[] } = {}): { threads: number; ready: Promise<number> } {
  if (!isMainThread) return { threads: 0, ready: Promise.resolve(0) };
  const n = o.threads ?? Math.max(0, Math.min(8, availableParallelism() - 1));
  if (n < 2) return { threads: 0, ready: Promise.resolve(0) };
  const starting = Array.from({ length: n }, () => {
    // from source (tsx), a worker doesn't inherit the TypeScript loader: it loads it through tsx's API
    const file = String(entry);
    const w = /\.ts$/.test(file)
      ? new Worker(`import('tsx/esm/api').then(({ tsImport }) => tsImport(${JSON.stringify(file)}, ${JSON.stringify(file)}))`, { eval: true, workerData: { role: ROLE } })
      : new Worker(typeof entry === 'string' && entry.startsWith('file:') ? new URL(entry) : entry, { workerData: { role: ROLE }, execArgv: o.execArgv ?? process.execArgv });
    w.unref(); // a CLI exits when its work is done, workers or not
    return new Promise<Worker | null>((res) => {
      w.once('message', (m) => res(m === 'ready' ? w : null));
      w.once('error', () => res(null));
    });
  });
  // a worker starts on the main thread's event loop: until every one has said so, replays stay here
  const ready = Promise.all(starting).then((ws) => {
    pool = ws.filter((w): w is Worker => !!w);
    if (pool.length >= 2) setReplayRunner((plans, traffic, opts) => (plans.length < MIN_BATCH ? plans.map((p) => runPlan(p, traffic, opts)) : replayAll(plans, traffic, opts)), pool.length);
    return pool.length;
  });
  return { threads: n, ready };
}

export function disableParallelReplays() {
  for (const w of pool) void w.terminate();
  pool = [];
  setReplayRunner(null);
}

function replayAll(plans: Plan[], traffic: Traffic, opts: { faults?: Fault[] }): RunResult[] {
  const k = Math.min(pool.length, plans.length);
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const ports: MessagePort[] = [];
  const share = Math.ceil(plans.length / k);
  for (let w = 0; w < k; w++) {
    const { port1, port2 } = new MessageChannel();
    ports.push(port1);
    pool[w].postMessage({ plans: plans.slice(w * share, (w + 1) * share), traffic, opts, port: port2, flag } satisfies Job, [port2]);
  }
  // block until every worker has posted (a minute without progress means one has died)
  let done = Atomics.load(flag, 0);
  while (done < k) {
    if (Atomics.wait(flag, 0, done, 60_000) === 'timed-out' && Atomics.load(flag, 0) === done) throw new Error('parallel replay: a worker stopped responding');
    done = Atomics.load(flag, 0);
  }
  const runs: RunResult[] = [];
  for (const p of ports) {
    const m = receiveMessageOnPort(p)?.message as { runs?: RunResult[]; error?: string } | undefined;
    p.close();
    if (!m || m.error || !m.runs) throw new Error(`parallel replay failed: ${m?.error ?? 'no result'}`);
    for (const r of m.runs) runs.push(unpack(r) as RunResult);
  }
  return runs;
}

/** for hosts: start the threads from wherever this code runs — this module under tsx, or the host's
 *  bundle once built (whose own entry code must then run only on the main thread). HINDCAST_THREADS
 *  sets how many (0: none) */
export function startReplayThreads(): Promise<number> {
  const env = process.env.HINDCAST_THREADS;
  const threads = env !== undefined && env !== '' ? Number(env) : undefined;
  if (threads === 0) return Promise.resolve(0);
  try {
    return enableParallelReplays(import.meta.url, threads ? { threads } : {}).ready.catch(() => 0);
  } catch {
    return Promise.resolve(0); // replays stay on this thread
  }
}
