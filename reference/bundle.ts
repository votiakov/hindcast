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
import { accuracyLines, holdoutAccuracy, referenceAccuracy, type ReferenceRun } from '../src/backtest/accuracy';
import type { Dataset } from '../src/backtest/dataset';
import { fileAccess } from '../cli/files';
import { writeManifest } from './manifest';

const ROOT = dirname(fileURLToPath(import.meta.url));

interface Validate {
  run: string;
  strategy?: string;
  stress?: boolean;
}

export function importRun(system: string, run: string): Dataset {
  const dir = join(ROOT, system, 'runs', run);
  if (!existsSync(join(dir, 'bottleneck.import.yaml'))) writeManifest(system, run);
  const path = join(dir, 'bottleneck.import.yaml');
  return importBundle(parse(readFileSync(path, 'utf8')), fileAccess(path)).dataset;
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
    runs.push({ label: v.run, dataset: importRun(system, v.run), strategy: v.strategy ? parse(readFileSync(join(sysDir, v.strategy), 'utf8')) : undefined, stress: v.stress });
  }
  if (runs.length) model.accuracy.push(referenceAccuracy(model, runs, `recorded runs the model never saw: ${runs.map((r) => r.label).join(', ')}`));
  model.accuracy.push(holdoutAccuracy(history, { holdout: 0.3 }));
  writeFileSync(join(sysDir, 'model.json'), JSON.stringify(model, null, 1));

  for (const a of model.accuracy) {
    console.log(`\n${a.method}: ${a.label}`);
    for (const l of accuracyLines(a)) console.log('  ' + l);
  }

  const stratDir = join(sysDir, 'strategies');
  const strategies = existsSync(stratDir) ? readdirSync(stratDir).filter((f) => f.endsWith('.yaml')).sort().map((f) => readFileSync(join(stratDir, f), 'utf8')) : [];
  mkdirSync(join(ROOT, '..', 'public', 'reference'), { recursive: true });
  writeFileSync(join(ROOT, '..', 'public', 'reference', `${system}.json`), JSON.stringify({ name: cfg.name, source: `reference/${system} — recorded ${new Date(history.start * 1000).toISOString().slice(0, 10)}`, dataset: history, model, strategies }));
  console.log(`\nwrote public/reference/${system}.json (${strategies.length} strategies)`);
}

main();
