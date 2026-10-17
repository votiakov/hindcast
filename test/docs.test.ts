import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { GLOSSARY } from '../src/content/glossary';

describe('user-facing docs (public/docs)', () => {
  it('every page builds, every pin has a screenshot position, every link resolves', () => {
    const out = execFileSync('node', ['scripts/build-docs.mjs', '--check'], { encoding: 'utf8' });
    expect(out).toMatch(/pages ok/);
  });

  it('the Terms page lists every glossary term, as built (npm run docs:build after editing the glossary)', () => {
    const page = readFileSync('public/docs/terms.html', 'utf8');
    const listed = [...page.matchAll(/<tr id="t-[^"]+"><td>([^<]+)<\/td>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
    expect(listed.sort()).toEqual(Object.keys(GLOSSARY).sort());
  });
});
