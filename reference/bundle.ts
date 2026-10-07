/**
 * Turn a reference system's recorded runs into what ships:
 *   - import the "history" run (the same path a user's files take) → dataset.json
 *   - calibrate on it → model.json
 *   - predict every other recorded run the model never saw (a strategy really applied, stress tests
 *     to the breaking point) and record the accuracy in the model
 *   - write the app workspace public/reference/<system>.json and a sampled trace file to keep
 *
 *   npx tsx reference/bundle.ts <system>
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { importBundle } from '../src/backtest/import/manifest';
import { calibrate } from '../src/backtest/calibrate';
import { accuracyLines, holdoutAccuracy, parseRequestLog, referenceAccuracy, type ReferenceRun } from '../src/backtest/accuracy';
import type { Dataset } from '../src/backtest/dataset';
import { fileAccess } from '../cli/files';
import { writeManifest } from './manifest';

const ROOT = dirname(fileURLToPath(import.meta.url));

interface Validate {
  run: string;
  strategy?: string;
  stress?: boolean;
}

/**
 * A run's dataset: imported from its files when the raw traces are here (they are not committed —
 * too large), otherwise the imported dataset committed next to them.
 */
export function importRun(system: string, run: string): Dataset {
  const dir = join(ROOT, system, 'runs', run);
  const saved = join(dir, 'dataset.json');
  if (!existsSync(join(dir, 'raw', 'traces.jsonl')) && existsSync(saved)) return JSON.parse(readFileSync(saved, 'utf8')) as Dataset;
  if (!existsSync(join(dir, 'bottleneck.import.yaml'))) writeManifest(system, run);
  const path = join(dir, 'bottleneck.import.yaml');
  const d = importBundle(parse(readFileSync(path, 'utf8')), fileAccess(path)).dataset;
  writeFileSync(saved, JSON.stringify(d));
  return d;
}

function main() {
  const system = process.argv[2];
  const sysDir = join(ROOT, system);
  const cfg = parse(readFileSync(join(sysDir, 'reference.yaml'), 'utf8')) as { name: string; validate?: Validate[] };
  const t0 = Date.now();
  const history = importRun(system, 'history');
  writeFileSync(join(sysDir, 'dataset.json'), JSON.stringify(history));
  console.log(`imported history: ${history.n} buckets, ${Object.keys(history.services).length} services (${Date.now() - t0} ms)`);

  const model = calibrate(history);
  model.name = cfg.name;
  const runs: ReferenceRun[] = [];
  for (const v of cfg.validate ?? []) {
    if (!existsSync(join(sysDir, 'runs', v.run, 'run.json'))) {
      console.log(`  (run ${v.run} not recorded yet — skipped)`);
      continue;
    }
    const dir = join(sysDir, 'runs', v.run);
    const meta = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as { start: number };
    runs.push({
      label: v.run,
      dataset: importRun(system, v.run),
      strategy: v.strategy ? parse(readFileSync(join(sysDir, v.strategy), 'utf8')) : undefined,
      stress: v.stress,
      requests: existsSync(join(dir, 'requests.csv')) ? parseRequestLog(readFileSync(join(dir, 'requests.csv'), 'utf8')) : undefined,
      shape: JSON.parse(readFileSync(join(dir, 'shape.json'), 'utf8')),
      start: meta.start,
    });
  }
  if (runs.length) model.accuracy.push(referenceAccuracy(model, runs, `recorded runs the model never saw: ${runs.map((r) => r.label).join(', ')}`));
  const histReq = join(sysDir, 'runs', 'history', 'requests.csv');
  model.accuracy.push(holdoutAccuracy(history, { holdout: 0.3, requests: existsSync(histReq) ? parseRequestLog(readFileSync(histReq, 'utf8')) : undefined }));
  writeFileSync(join(sysDir, 'model.json'), JSON.stringify(model, null, 1));

  for (const a of model.accuracy) {
    console.log(`\n${a.method}: ${a.label}`);
    for (const l of accuracyLines(a)) console.log('  ' + l);
  }

  const stratDir = join(sysDir, 'strategies');
  const strategies = existsSync(stratDir) ? readdirSync(stratDir).filter((f) => f.endsWith('.yaml')).sort().map((f) => readFileSync(join(stratDir, f), 'utf8')) : [];
  mkdirSync(join(ROOT, '..', 'public', 'reference'), { recursive: true });
  writeFileSync(join(ROOT, '..', 'public', 'reference', `${system}.json`), JSON.stringify({ name: cfg.name, source: `reference/${system} — recorded ${new Date(history.start * 1000).toISOString().slice(0, 10)}`, dataset: history, model, strategies }));
  // the app lists what is bundled
  const indexPath = join(ROOT, '..', 'public', 'reference', 'index.json');
  const index = (existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : []) as { id: string; label: string }[];
  const entry = { id: system, label: `${cfg.name} (reference)` };
  writeFileSync(indexPath, JSON.stringify([...index.filter((x) => x.id !== system), entry].sort((a, b) => ['hotrod', 'shop', 'petclinic'].indexOf(a.id) - ['hotrod', 'shop', 'petclinic'].indexOf(b.id)), null, 1));
  console.log(`\nwrote public/reference/${system}.json (${strategies.length} strategies)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
