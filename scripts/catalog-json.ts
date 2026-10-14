// The component and outage catalogues as the CLI uses them (`hindcast catalog`), from the TypeScript catalogue the
// app shows: written to engine-rs/src/cli/catalog.json for the native binary, checked by a test.
// npx tsx scripts/catalog-json.ts [--write]
import { readFileSync, writeFileSync } from 'node:fs';
import { catalog } from '../src/sim/headless';
import { OUTAGES } from '../src/backtest/outages';

const FILE = 'engine-rs/src/cli/catalog.json';
const OUTAGES_FILE = 'engine-rs/src/cli/outages.json';
export const catalogJson = () => JSON.stringify(catalog(), null, 2) + '\n';
/** the public-outage catalogue (src/backtest/outages.ts) the `outage` command replays */
export const outagesJson = () => JSON.stringify(OUTAGES, null, 1) + '\n';
if (process.argv[1]?.endsWith('catalog-json.ts')) {
  if (process.argv.includes('--write')) {
    writeFileSync(FILE, catalogJson());
    writeFileSync(OUTAGES_FILE, outagesJson());
  } else process.exitCode = readFileSync(FILE, 'utf8') === catalogJson() && readFileSync(OUTAGES_FILE, 'utf8') === outagesJson() ? 0 : 1;
}
