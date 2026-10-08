import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

describe('user-facing docs (public/docs)', () => {
  it('every page builds, every pin has a screenshot position, every link resolves', () => {
    const out = execFileSync('node', ['scripts/build-docs.mjs', '--check'], { encoding: 'utf8' });
    expect(out).toMatch(/pages ok/);
  });
});
