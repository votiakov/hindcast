/**
 * The calibration's foundation, checked on real production microservices: Alibaba's 2021 trace
 * (github.com/alibaba/clusterdata, cluster-trace-microservices-v2021) — 12 hours of ~1,300 services
 * serving millions of calls per second, with calls/s, response time and CPU per container per minute.
 *
 * For the busiest services, `calibrate` (the same code that fits your system) is fitted on the first
 * 70% of the day and asked for each service's CPU over the last 30%, from its traffic alone. Compared
 * with two naive forecasts: CPU per request held at its training average (no idle baseline), and
 * "the same as an hour ago".
 *
 *   sh reference/alibaba/fetch.sh <dir>        # streams 35 GB, keeps ~20 MB of per-minute aggregates
 *   npx tsx reference/alibaba/validate.ts <dir> [--top 60]
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calibrate } from '../../src/backtest/calibrate';
import type { Dataset, Num } from '../../src/backtest/dataset';

const ROOT = dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2];
if (!dir) throw new Error('usage: validate.ts <aggregates dir> [--top N]');
const top = Number(process.argv[process.argv.indexOf('--top') + 1] || 60);

type Row = { rps?: number; rt?: number; inst?: number; cpu?: number; cpuInst?: number };
const data = new Map<string, Map<number, Row>>();
const cell = (ms: string, m: number) => {
  const s = data.get(ms) ?? data.set(ms, new Map()).get(ms)!;
  return s.get(m) ?? s.set(m, {}).get(m)!;
};
const csv = (f: string) =>
  readFileSync(join(dir, f), 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => l.split(','));
for (const f of readdirSync(dir).filter((x) => /^rtqps_\d+\.csv$/.test(x)))
  for (const [ms, minute, rps, rt, inst] of csv(f)) {
    const c = cell(ms, Number(minute));
    // a minute split across two files: sum the calls, keep the larger instance count
    c.rps = (c.rps ?? 0) + Number(rps);
    if (rt) c.rt = Number(rt);
    c.inst = Math.max(c.inst ?? 0, Number(inst));
  }
for (const f of readdirSync(dir).filter((x) => /^resource_\d+\.csv$/.test(x)))
  for (const [ms, minute, cpu, inst] of csv(f)) {
    const c = cell(ms, Number(minute));
    c.cpu = (c.cpu ?? 0) + Number(cpu);
    c.cpuInst = Math.max(c.cpuInst ?? 0, Number(inst));
  }

const minutes = [...new Set([...data.values()].flatMap((s) => [...s.keys()]))].sort((a, b) => a - b);
const t0 = minutes[0];
const n = minutes[minutes.length - 1] - t0 + 1;
// services with traffic and CPU in nearly every minute, busiest first
const candidates = [...data.entries()]
  .map(([ms, s]) => ({ ms, s, full: [...s.values()].filter((c) => c.rps && c.cpu && c.inst).length, total: [...s.values()].reduce((a, c) => a + (c.rps ?? 0), 0) }))
  .filter((x) => x.full >= n * 0.9)
  .sort((a, b) => b.total - a.total)
  .slice(0, top);

const mape = (pred: number[], obs: number[]) => {
  const e = pred.map((p, i) => Math.abs(p - obs[i]) / Math.max(1e-9, Math.abs(obs[i]))).filter(isFinite).sort((a, b) => a - b);
  return e.length ? e[Math.floor(e.length / 2)] : NaN;
};
const cut = Math.floor(n * 0.7);
const rows: { ms: string; instances: number; callsPerS: number; r2: number | null; model: number; perRequest: number; hourAgo: number; loadSwing: number; moved: { n: number; model: number; perRequest: number; hourAgo: number }; beyond: { n: number; model: number; perRequest: number } }[] = [];
for (const { ms, s } of candidates) {
  const series = (k: keyof Row): Num[] => Array.from({ length: n }, (_, i) => s.get(t0 + i)?.[k] ?? null);
  const rps = series('rps');
  // MSResource samples every 30 s: a minute holds two samples per container. CPU is the mean per
  // container sample × the containers serving that minute
  const cpu: Num[] = Array.from({ length: n }, (_, i) => {
    const c = s.get(t0 + i);
    return c?.cpu !== undefined && c.cpuInst && c.inst ? (c.cpu / c.cpuInst) * c.inst : null;
  });
  const replicas = Array.from({ length: n }, (_, i) => s.get(t0 + i)?.inst ?? null);
  const rt = series('rt');
  const d: Dataset = { version: 1, name: ms, start: t0 * 60, stepS: 60, n: cut, services: { [ms]: { rps: rps.slice(0, cut), cpuCores: cpu.slice(0, cut), replicas: replicas.slice(0, cut), meanMs: rt.slice(0, cut) } }, endpoints: {}, sources: ['alibaba 2021'] };
  const m = calibrate(d, { bootstrap: 0 });
  const fit = m.services[ms]?.cpu;
  if (!fit) continue;
  // the holdout: CPU from traffic alone
  const obs: number[] = [];
  const model: number[] = [];
  const ratio: number[] = [];
  const lag: number[] = [];
  // the minutes that matter for a forecast: traffic moved ≥15% from an hour before, or went past
  // anything the training window saw
  const moved = { obs: [] as number[], model: [] as number[], ratio: [] as number[], lag: [] as number[] };
  const beyond = { obs: [] as number[], model: [] as number[], ratio: [] as number[] };
  let trainMax = 0;
  for (let i = 0; i < cut; i++) if (rps[i] !== null) trainMax = Math.max(trainMax, rps[i]!);
  let trainCpu = 0;
  let trainRps = 0;
  for (let i = 0; i < cut; i++) if (cpu[i] !== null && rps[i] !== null) (trainCpu += cpu[i]!), (trainRps += rps[i]!);
  for (let i = cut; i < n; i++) {
    if (cpu[i] === null || rps[i] === null || cpu[i - 60] == null) continue;
    const pm = (replicas[i] ?? 1) * fit.base + fit.perReq * rps[i]!;
    const pr = (trainCpu / trainRps) * rps[i]!;
    obs.push(cpu[i]!);
    model.push(pm);
    ratio.push(pr);
    lag.push(cpu[i - 60]!);
    if (rps[i - 60] != null && Math.abs(rps[i]! / rps[i - 60]! - 1) >= 0.15) {
      moved.obs.push(cpu[i]!);
      moved.model.push(pm);
      moved.ratio.push(pr);
      moved.lag.push(cpu[i - 60]!);
    }
    if (rps[i]! > trainMax) {
      beyond.obs.push(cpu[i]!);
      beyond.model.push(pm);
      beyond.ratio.push(pr);
    }
  }
  const loads = rps.filter((x): x is number => x !== null).sort((a, b) => a - b);
  rows.push({ ms, instances: Math.round(replicas[cut] ?? 0), callsPerS: Math.round(loads[Math.floor(loads.length / 2)]), r2: fit.r2 ?? null, model: mape(model, obs), perRequest: mape(ratio, obs), hourAgo: mape(lag, obs), loadSwing: loads[Math.floor(loads.length * 0.95)] / loads[Math.floor(loads.length * 0.05)], moved: { n: moved.obs.length, model: mape(moved.model, moved.obs), perRequest: mape(moved.ratio, moved.obs), hourAgo: mape(moved.lag, moved.obs) }, beyond: { n: beyond.obs.length, model: mape(beyond.model, beyond.obs), perRequest: mape(beyond.ratio, beyond.obs) } });
}

const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const summary = {
  services: rows.length,
  minutes: n,
  trainedOn: `first ${cut} minutes`,
  heldOut: `last ${n - cut} minutes`,
  medianError: { model: med(rows.map((r) => r.model)), perRequestOnly: med(rows.map((r) => r.perRequest)), hourAgo: med(rows.map((r) => r.hourAgo)) },
  modelBest: rows.filter((r) => r.model <= Math.min(r.perRequest, r.hourAgo)).length,
  whenTrafficMoved: (() => {
    const m = rows.filter((r) => r.moved.n >= 10);
    return { services: m.length, minutes: m.reduce((a, r) => a + r.moved.n, 0), model: med(m.map((r) => r.moved.model)), perRequestOnly: med(m.map((r) => r.moved.perRequest)), hourAgo: med(m.map((r) => r.moved.hourAgo)) };
  })(),
  beyondTraining: (() => {
    const m = rows.filter((r) => r.beyond.n >= 5);
    return { services: m.length, minutes: m.reduce((a, r) => a + r.beyond.n, 0), model: med(m.map((r) => r.beyond.model)), perRequestOnly: med(m.map((r) => r.beyond.perRequest)) };
  })(),
  within10: rows.filter((r) => r.model <= 0.1).length,
};
console.log(JSON.stringify(summary, null, 1));
for (const r of rows.slice(0, 15)) console.log(`${r.ms}  ${String(r.instances).padStart(5)} inst  ${String(r.callsPerS).padStart(7)} calls/s  swing ×${r.loadSwing.toFixed(2)}  R² ${r.r2?.toFixed(2)}  model ${(r.model * 100).toFixed(1)}%  per-request ${(r.perRequest * 100).toFixed(1)}%  hour-ago ${(r.hourAgo * 100).toFixed(1)}%`);
writeFileSync(join(ROOT, 'results.json'), JSON.stringify({ summary, rows }, null, 1));
