// The component catalogue as the CLI prints it (`hindcast catalog`), from the TypeScript catalogue the
// app shows: written to engine-rs/src/cli/catalog.json for the native binary, checked by a test.
// npx tsx scripts/catalog-json.ts [--write]
import { readFileSync, writeFileSync } from 'node:fs';
import { catalog } from '../src/sim/headless';

const FILE = 'engine-rs/src/cli/catalog.json';
export const catalogJson = () => JSON.stringify(catalog(), null, 2) + '\n';
if (process.argv[1]?.endsWith('catalog-json.ts')) {
  if (process.argv.includes('--write')) writeFileSync(FILE, catalogJson());
  else process.exitCode = readFileSync(FILE, 'utf8') === catalogJson() ? 0 : 1;
}
