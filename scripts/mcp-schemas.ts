// The MCP tools' input schemas for architectures, scenarios and variants, from the spec's zod schema
// (src/spec/schema.ts): written into engine-rs/src/cli/mcp/manifest.json, checked by a test.
// npx tsx scripts/mcp-schemas.ts [--write]
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { ArchitectureSpec, ScenarioSpec, VariantSpec } from '../src/spec/schema';

const FILE = 'engine-rs/src/cli/mcp/manifest.json';
const schema = (t: z.ZodType) => {
  const s = z.toJSONSchema(t, { target: 'draft-7', io: 'input' } as never) as Record<string, unknown>;
  delete s.$schema;
  return s;
};
const BY_NAME: Record<string, () => Record<string, unknown>> = {
  architecture: () => schema(ArchitectureSpec),
  scenario: () => schema(ScenarioSpec),
  compare_with: () => schema(VariantSpec),
  variants: () => schema(z.array(VariantSpec).min(1)),
};

export function mcpManifestWithSchemas(): string {
  const m = JSON.parse(readFileSync(FILE, 'utf8')) as { tools: { inputSchema: { properties?: Record<string, unknown> } }[] };
  for (const t of m.tools) for (const k of Object.keys(t.inputSchema.properties ?? {})) if (BY_NAME[k]) t.inputSchema.properties![k] = BY_NAME[k]();
  return JSON.stringify(m, null, 1) + '\n';
}

if (process.argv[1]?.endsWith('mcp-schemas.ts')) {
  const next = mcpManifestWithSchemas();
  if (process.argv.includes('--write')) writeFileSync(FILE, next);
  else process.exitCode = readFileSync(FILE, 'utf8') === next ? 0 : 1;
}
