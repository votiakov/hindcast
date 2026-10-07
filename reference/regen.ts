/**
 * Re-derive a recorded run's request log, client series and import manifest from its raw k6 output
 * (after changing the bucket size or the export format; the recording itself is untouched).
 *
 *   npx tsx reference/regen.ts <system> <run>
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientCsv, readK6, requestsCsv } from './k6';
import { writeManifest } from './manifest';

const ROOT = dirname(fileURLToPath(import.meta.url));
const [system, run] = process.argv.slice(2);
const dir = join(ROOT, system, 'runs', run);
const reqs = readK6(join(dir, 'raw', 'k6.csv'));
writeFileSync(join(dir, 'requests.csv'), requestsCsv(reqs));
writeFileSync(join(dir, 'client.csv'), clientCsv(reqs, 30));
writeManifest(system, run);
console.log(`${system}/${run}: ${reqs.length} requests, ${reqs.filter((r) => r.failed).length} failed`);
