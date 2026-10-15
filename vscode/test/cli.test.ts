import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CliEngine } from '../src/engine';
import { parseSpecDoc, placeIssues } from '../src/lineMap';
import { summary } from '../src/summary';

// The CLI fallback against the native binary, when there is one (HINDCAST_BIN, or a release build here)
const built = fileURLToPath(new URL('../../engine-rs/target/release/hindcast', import.meta.url));
const bin = process.env.HINDCAST_BIN ?? (existsSync(built) ? built : '');
const shop = readFileSync(new URL('../../examples/shop.yaml', import.meta.url), 'utf8');

describe.skipIf(!bin)('the hindcast CLI as the engine', () => {
  const cli = new CliEngine(bin);

  it('validate: the same issues, placed from their messages', async () => {
    const text = shop.replace('kind: server', 'kind: servr');
    const doc = parseSpecDoc(text);
    const v = await cli.validate(doc.value, text);
    expect(v.ok).toBe(false);
    const [first] = placeIssues(doc, v.issues);
    expect(text.split('\n')[first.span.line]).toContain('servr');
  });

  it('summary: the numbers the WebAssembly gives', async () => {
    const doc = parseSpecDoc(shop);
    const s = await cli.summary(doc.value, shop);
    const w = summary(doc.value, undefined);
    expect(s.p99Ms).toBe(w.p99Ms);
    expect(s.errorRate).toBe(w.errorRate);
    expect(Math.round(s.monthly)).toBe(Math.round(w.monthly));
  });

  it('audit: a Markdown report', async () => {
    const r = await cli.audit(parseSpecDoc(shop).value, shop, {});
    expect(r.markdown).toMatch(/^# Failure audit — Web shop/);
  });
});
