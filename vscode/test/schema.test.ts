import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { specSchema } from '../scripts/schema';

it('the bundled JSON Schema is the zod schema of today (npm run schema)', () => {
  expect(readFileSync(new URL('../schemas/hindcast.schema.json', import.meta.url), 'utf8')).toBe(specSchema());
});
