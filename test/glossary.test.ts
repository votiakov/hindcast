import { describe, expect, it } from 'vitest';
import { GLOSSARY, withTerms } from '../src/content/glossary';

describe('glossary', () => {
  it('underlines the first use of each term, longest match first', () => {
    const parts = withTerms('Retry amplification ×2: retries multiply the load; the p99 and the p99 again.');
    const terms = parts.filter((p) => typeof p !== 'string') as { term: string }[];
    expect(terms.map((t) => t.term)).toEqual(['Retry amplification', 'retries', 'p99']);
    expect(parts.map((p) => (typeof p === 'string' ? p : p.term)).join('')).toBe('Retry amplification ×2: retries multiply the load; the p99 and the p99 again.');
  });

  it('every definition is a sentence or two', () => {
    for (const [t, d] of Object.entries(GLOSSARY)) {
      expect(d, t).toMatch(/[.%”]$/);
      expect(d.length, t).toBeLessThan(220);
    }
  });
});
