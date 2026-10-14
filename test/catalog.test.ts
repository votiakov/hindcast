import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

it("the native CLI's catalogue is the app's (npx tsx scripts/catalog-json.ts --write)", async () => {
  const { catalogJson, outagesJson } = await import('../scripts/catalog-json');
  expect(readFileSync('engine-rs/src/cli/catalog.json', 'utf8')).toBe(catalogJson());
  expect(readFileSync('engine-rs/src/cli/outages.json', 'utf8')).toBe(outagesJson());
});

it("the MCP tools' spec schemas are the spec's (npx tsx scripts/mcp-schemas.ts --write)", async () => {
  const { mcpManifestWithSchemas } = await import('../scripts/mcp-schemas');
  expect(readFileSync('engine-rs/src/cli/mcp/manifest.json', 'utf8')).toBe(mcpManifestWithSchemas());
});
