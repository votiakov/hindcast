/**
 * Write the accuracy results of every bundled reference system into reference/README.md
 * (between the RESULTS markers) — the same records the app, the CLI and the reports show.
 *
 *   npx tsx reference/results.ts
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Model } from '../src/backtest/model';

const ROOT = dirname(fileURLToPath(import.meta.url));
const systems = ['hotrod', 'shop', 'petclinic'];
const fmt = (metric: string, x: number) => (metric === 'cost' ? `$${x.toFixed(3)}` : metric === 'breaking-point' ? `${x.toFixed(1)} req/s` : metric === 'errors' ? `${Math.round(x)}` : `${Math.round(x)} ms`);

const L: string[] = ['| system | check | run | predicted | measured | off by | target | |', '|---|---|---|---|---|---|---|---|'];
for (const sys of systems) {
  const p = join(ROOT, sys, 'model.json');
  if (!existsSync(p)) continue;
  const m = JSON.parse(readFileSync(p, 'utf8')) as Model;
  for (const a of m.accuracy)
    for (const c of a.checks) {
      if (c.metric === 'errors') continue;
      const run = a.method === 'holdout' ? 'holdout (last 30% of history)' : c.note.split(':')[0];
      L.push(`| ${m.name} | ${c.metric} | ${run} | ${fmt(c.metric, c.predicted)} | ${fmt(c.metric, c.measured)} | ${(c.error * 100).toFixed(1)}% | ≤ ${c.tolerance * 100}% | ${c.pass ? '✅' : '❌'} |`);
    }
}
const table = L.join('\n');
const readme = join(ROOT, 'README.md');
let s = readFileSync(readme, 'utf8');
const begin = '<!-- RESULTS -->';
const end = '<!-- /RESULTS -->';
if (!s.includes(begin)) s = s.replace('## Results\n', `## Results\n\n${begin}\n${end}\n`);
s = s.replace(new RegExp(`${begin}[\\s\\S]*${end}`), `${begin}\n${table}\n${end}`);
writeFileSync(readme, s);
console.log(table);
