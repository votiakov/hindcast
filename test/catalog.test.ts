import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

it("the native CLI's catalogue is the app's (npx tsx scripts/catalog-json.ts --write)", async () => {
  const { catalogJson, outagesJson } = await import('../scripts/catalog-json');
  expect(readFileSync('engine-rs/src/cli/catalog.json', 'utf8')).toBe(catalogJson());
  expect(readFileSync('engine-rs/src/cli/outages.json', 'utf8')).toBe(outagesJson());
});
