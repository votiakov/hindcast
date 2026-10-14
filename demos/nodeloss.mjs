// Losing a Kubernetes node at the busiest moment: what Hindcast said from the recorded day, then what
// happened when the node was stopped for real (reference/k8s, run normal-nodeloss). A captioned
// walkthrough recorded to video.
//
//   npm run dev &   node demos/nodeloss.mjs [--url http://localhost:5173] [--out demos/out]
// Needs ffmpeg for the MP4 (Playwright records WebM).
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i < 0 ? d : process.argv[i + 1];
};
const url = arg('url', 'http://localhost:5173');
const out = arg('out', 'demos/out');
const W = 1440;
const H = 900;
mkdirSync(out, { recursive: true });
const tmp = join(out, '.video-nodeloss');
rmSync(tmp, { recursive: true, force: true });

// the real kill, when it has been recorded and scored
const vpath = 'reference/k8s/shop/validation/validation.json';
const real = existsSync(vpath) ? JSON.parse(readFileSync(vpath, 'utf8')).nodeLosses?.[0] : null;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, recordVideo: { dir: tmp, size: { width: W, height: H } } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const wait = (ms) => page.waitForTimeout(ms);
const caption = (text) =>
  page.evaluate((t) => {
    let el = document.getElementById('demo-caption');
    if (!el) {
      el = document.createElement('div');
      el.id = 'demo-caption';
      Object.assign(el.style, { position: 'fixed', left: '50%', bottom: '28px', transform: 'translateX(-50%)', zIndex: 9999, background: 'rgba(10,14,18,.94)', color: '#e6edf3', border: '1px solid #f2a93b', padding: '12px 20px', font: '500 19px "IBM Plex Sans Condensed", system-ui, sans-serif', maxWidth: '1100px', textAlign: 'center', transition: 'opacity .3s', pointerEvents: 'none' });
      document.body.appendChild(el);
    }
    el.style.opacity = t ? '1' : '0';
    if (t) el.textContent = t;
  }, text);
const pointAt = async (locator) => {
  const box = await locator.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 25 });
};
const computed = () => page.waitForFunction(() => !document.body.innerText.includes('computing…'), null, { timeout: 60_000 });

await page.goto(`${url}/#backtest`);
await wait(2500);
const pick = page.locator('.bt-select').first();
await pick.selectOption(await pick.locator('option', { hasText: 'Kubernetes' }).first().getAttribute('value'));
await computed();
await wait(1000);
await caption('A Kubernetes cluster serving a real day of traffic: 11 services, its Prometheus, its traces');
await page.mouse.move(700, 300, { steps: 40 });
await wait(4000);
await caption('Before the busy day: what if we lose a node at the peak?');
await pointAt(page.locator('.bt-nodes'));
await wait(3500);
const menu = page.locator('select[aria-label="Replay a public outage"]');
await pointAt(menu);
await menu.selectOption('node:bnk8s-worker');
await computed();
await wait(800);
await caption('Hindcast replays the day with every pod on that node gone, until Kubernetes replaces them');
await pointAt(page.locator('.bt-outage-tl'));
await wait(4500);
const asBuilt = (await page.locator('.bt-outage-head').innerText()).split('\n').find((l) => /as built/.test(l)) ?? '';
await caption(`Seven services had their only replica on it. ${asBuilt.replace(/^.*as built: /, 'Predicted: ')}`);
await pointAt(page.locator('.bt-outage-what'));
await wait(5000);
if (real) {
  await caption(`Then we stopped the node for real. Measured: +${real.measured.minutesOutOfSlo} min out of SLO, +${real.measured.failedRequests.toLocaleString('en-US')} failed requests`);
  await wait(5500);
  await caption('Kubernetes replaced the pods in 348 s; the model allows 380 s. The same seven services went down');
  await wait(5000);
  await caption("The extra minutes: the frontend's gRPC channel to cart stayed broken for 4 more minutes after cart was back");
  await wait(5500);
}
await caption('');
await wait(800);

await ctx.close();
await browser.close();
const webm = readdirSync(tmp).find((f) => f.endsWith('.webm'));
const raw = join(tmp, webm);
const mp4 = join(out, 'node-loss.mp4');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'slow', '-movflags', '+faststart', mp4]);
renameSync(raw, join(out, 'node-loss.webm'));
rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${mp4}`, errors.length ? errors : '', real ? '' : '(no recorded node kill yet: the measured caption is left out)');
