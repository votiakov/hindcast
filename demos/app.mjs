// The Backtest screen on the Kubernetes reference, as a narrated walkthrough recorded to video:
// the calibration day, three changes to the frontend, then launch day at 2.2× — and the model's
// accuracy against the runs where those changes were really applied.
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
await page.locator('.bt-select').first().selectOption('k8s-shop');
await computed();
await wait(1500);
await caption('A real Kubernetes cluster: the Astronomy Shop, 11 services, observed with Prometheus, ingress-nginx and Jaeger');
await wait(4500);
await caption('The history: one ordinary day of real traffic (NASA’s web log, 12 July 1995), recorded through the ingress');
await page.mouse.move(300, 300, { steps: 20 });
await page.mouse.move(820, 250, { steps: 60 });
await wait(4500);
await caption('Three changes to the frontend, from their manifests: 2 replicas, 1 replica, an HPA — each backtested over that day');
await focusStrategy('Frontend at 2 replicas');
await wait(3500);
await focusStrategy('Frontend at 1 replica');
await wait(4000);
await caption('On an ordinary day: 2 replicas save money and hold the SLO; 1 replica breaks it at the lunch peak');
await wait(4500);
await caption('Now launch day: the same day at 2.2× the load — STS-70 launched on 13 July, and NASA’s traffic more than doubled');
await page.evaluate(() => window.backtest.getState().setLoad(2.2));
await computed();
await wait(1500);
await pointAt(page.locator('.bt-loadnote'));
await wait(3500);
await focusStrategy('Frontend at 2 replicas');
await caption('At launch-day load, 2 replicas fail. The HPA scales out and holds');
await wait(4500);
await focusStrategy('Frontend on an HPA');
await wait(4500);
await caption('Then each change was applied for real and launch day replayed. The model’s predictions, against what was measured:');
await page.evaluate(() => window.backtest.getState().setLoad(1));
await computed();
await page.locator('.bt-tabs button, [role=tab]', { hasText: 'Model' }).first().click().catch(() => {});
await wait(1200);
await pointAt(page.locator('text=Kubernetes runs').first());
await wait(6500);
await caption('');
await wait(800);

await ctx.close();
await browser.close();
const webm = readdirSync(tmp).find((f) => f.endsWith('.webm'));
const raw = join(tmp, webm);
const mp4 = join(out, 'app-backtest-k8s.mp4');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'slow', '-movflags', '+faststart', mp4]);
renameSync(raw, join(out, 'app-backtest-k8s.webm'));
rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${mp4}`, errors.length ? errors : '');
