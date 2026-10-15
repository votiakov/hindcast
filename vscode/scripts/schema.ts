// The spec's JSON Schema, generated from the zod schema (src/spec/schema.ts) the engine and app validate
// against: `npm run schema` writes schemas/hindcast.schema.json, `--check` fails when it is out of date.
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { ArchitectureSpec } from '../../src/spec/schema';

const OUT = new URL('../schemas/hindcast.schema.json', import.meta.url);

export function specSchema(): string {
  const s = z.toJSONSchema(ArchitectureSpec, { io: 'input', unrepresentable: 'any', target: 'draft-7' });
  return JSON.stringify({ ...s, title: 'Hindcast architecture spec' }, null, 2) + '\n';
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  const next = specSchema();
  if (process.argv.includes('--check')) {
    if (readFileSync(OUT, 'utf8') !== next) {
      console.error('schemas/hindcast.schema.json is out of date: run npm run schema');
      process.exit(1);
    }
  } else {
    writeFileSync(OUT, next);
    console.log('wrote schemas/hindcast.schema.json');
  }
}
