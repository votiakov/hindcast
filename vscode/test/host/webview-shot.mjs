// The built webview in headless Chromium with a stand-in for VS Code's host API: posts a spec, waits for
// the board, writes a screenshot. `node test/host/webview-shot.mjs [spec.yaml] [out.png]`
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const spec = parse(readFileSync(process.argv[2] ?? join(here, '../../../examples/shop.yaml'), 'utf8'));
const out = process.argv[3] ?? join(here, '../../dist/webview.png');
const html = readFileSync(join(here, '../../dist/webview/index.html'), 'utf8');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(() => {
  window.sent = [];
  window.hindcastHost = { postMessage: (m) => window.sent.push(m) };
});
await page.route('http://webview.test/', (r) => r.fulfill({ contentType: 'text/html', body: html }));
await page.goto('http://webview.test/');
await page.waitForFunction(() => window.sent.some((m) => m.type === 'ready'));
await page.evaluate((value) => window.postMessage({ type: 'spec', value, rps: 600 }, '*'), spec);
await page.waitForFunction(() => window.sent.some((m) => m.type === 'board'));
await page.waitForTimeout(2500);
await page.screenshot({ path: out });
console.log(JSON.stringify((await page.evaluate(() => window.sent)).filter((m) => m.type === 'board')), errors);
await browser.close();
