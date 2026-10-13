// The Backtest screen as a narrated walkthrough recorded to video, on the Astronomy Shop reference
// (its accuracy is within target on every recorded run it never saw): the recorded day, four changes,
// the same day at twice the traffic, and the model's accuracy record.
//
//   npm run dev &   node demos/app.mjs [--url http://localhost:5173] [--out demos/out]
// Needs ffmpeg for the MP4 (Playwright records WebM).
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
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
const tmp = join(out, '.video');
rmSync(tmp, { recursive: true, force: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, recordVideo: { dir: tmp, size: { width: W, height: H } } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const wait = (ms) => page.waitForTimeout(ms);

// a caption strip at the bottom of the frame, so the video explains itself without sound
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
const focusStrategy = async (name) => {
  const row = page.locator('.bt-watch, .bt-side').locator('text=' + name).first();
  await pointAt(row);
  await row.click();
};
const computed = () => page.waitForFunction(() => !document.body.innerText.includes('computing…'), null, { timeout: 60_000 });

await page.goto(`${url}/#backtest`);
await wait(2500);
await page.locator('.bt-select').first().selectOption('shop');
await computed();
await wait(1200);
await caption('A recorded day of a real microservices shop: 11 services, its telemetry from Prometheus, OpenTelemetry and the bill');
await page.mouse.move(300, 300, { steps: 20 });
await page.mouse.move(860, 260, { steps: 60 });
await wait(4500);
await caption('Four infrastructure changes, each replayed over that day: what it saves, and what it would have broken');
await focusStrategy('Frontend on 1 vCPU');
await wait(3500);
await focusStrategy('Autoscale the frontend');
await wait(3500);
await caption('Now the same day at twice the traffic. As built, the shop breaks at the peak');
await page.locator('.bt-load button', { hasText: '×2' }).first().click();
await computed();
await wait(1200);
await pointAt(page.locator('.bt-loadnote'));
await wait(3500);
await focusStrategy('Autoscale the frontend');
await caption('Autoscaling the frontend holds the SLO through it, at a cost the backtest prices per month');
await wait(4500);
await page.locator('.bt-load button', { hasText: '×1' }).first().click();
await computed();
await caption('Every answer comes with the model\u2019s accuracy, measured against recorded runs it never saw');
await wait(800);
await pointAt(page.locator('.bt-acc').first());
await wait(6000);
await caption('');
await wait(800);

await ctx.close();
await browser.close();
const webm = readdirSync(tmp).find((f) => f.endsWith('.webm'));
const raw = join(tmp, webm);
const mp4 = join(out, 'app-backtest.mp4');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'slow', '-movflags', '+faststart', mp4]);
renameSync(raw, join(out, 'app-backtest.webm'));
rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${mp4}`, errors.length ? errors : '');
