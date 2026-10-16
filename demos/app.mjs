// The README's hero: the Backtest screen on the Astronomy Shop reference. Its recorded day, then the
// same day at twice the traffic: as built it breaks at the peak, autoscaling the frontend holds the
// SLO, at a price per month; then a look at the Review screen.
//
//   npx vite --port 5173 &   node demos/app.mjs [--url http://localhost:5173] [--out demos/out]
//
// Frames come from Chromium's screencast at device scale 2 (Playwright's own WebM is soft), with a
// drawn cursor, since headless Chromium paints none. Needs ffmpeg. Writes app-backtest.mp4 (the whole
// scene) and backtest.gif (the hero cut, from the Backtest tab to the autoscaled verdict).
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i < 0 ? d : process.argv[i + 1];
};
const url = arg('url', 'http://localhost:5173');
const out = resolve(arg('out', 'demos/out'));
const W = 1440;
const H = 900;
const SCALE = 2;
const FPS = 30;
const MP4_SCALE = 2;
const GIF_W = 1200;
const GIF_FPS = 10;
mkdirSync(out, { recursive: true });
const tmp = join(out, '.frames');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE });

// a cursor the screencast can see: an arrow that follows the real mouse events and dips on a press
await ctx.addInitScript(() => {
  const add = () => {
    if (document.getElementById('demo-cursor')) return;
    const c = document.createElement('div');
    c.id = 'demo-cursor';
    c.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2 L3 18 L7.2 14.2 L10 20.5 L12.8 19.3 L10.1 13.1 L15.8 13.1 Z" fill="#f4f6f8" stroke="#0b0f14" stroke-width="1.3" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: 'fixed', left: '0', top: '0', width: '22px', height: '22px', zIndex: 2147483647, pointerEvents: 'none', transform: 'translate(-100px,-100px)', transition: 'scale .12s ease', transformOrigin: '3px 2px', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.5))' });
    document.documentElement.appendChild(c);
    let x = -100;
    let y = -100;
    addEventListener('mousemove', (e) => ((x = e.clientX), (y = e.clientY), (c.style.transform = `translate(${x - 3}px,${y - 2}px)`)), true);
    addEventListener('mousedown', () => (c.style.scale = '0.82'), true);
    addEventListener('mouseup', () => (c.style.scale = '1'), true);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', add);
  else add();
});

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const wait = (ms) => page.waitForTimeout(ms);

// screencast frames, each with its timestamp; the movie holds each frame until the next one
const cdp = await ctx.newCDPSession(page);
const frames = [];
let writing = Promise.resolve();
cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  const file = join(tmp, `f${String(frames.length).padStart(5, '0')}.jpg`);
  frames.push({ file, t: metadata.timestamp });
  writing = writing.then(() => writeFileSync(file, Buffer.from(data, 'base64')));
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});
const marks = {};
const mark = (name) => (marks[name] = Date.now() / 1000);

// smooth, eased cursor travel
let mx = W / 2;
let my = H / 2;
const glide = async (x, y, ms = 700) => {
  const x0 = mx;
  const y0 = my;
  const from = Date.now();
  for (;;) {
    const k = Math.min(1, (Date.now() - from) / ms);
    const e = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
    await page.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e);
    if (k >= 1) break;
    await wait(12);
  }
  mx = x;
  my = y;
};
const center = async (loc, dx = 0.5, dy = 0.5) => {
  const b = await loc.boundingBox();
  return [b.x + b.width * dx, b.y + b.height * dy];
};
const glideTo = async (loc, ms, dx, dy) => {
  const [x, y] = await center(loc, dx, dy);
  await glide(x, y, ms);
};
const press = async () => {
  await page.mouse.down();
  await wait(110);
  await page.mouse.up();
};
const click = async (loc, ms = 700) => {
  await glideTo(loc, ms);
  await wait(180);
  await press();
};
// a native select's list isn't painted headless: point at it, press, and pick
const choose = async (loc, value, ms = 700) => {
  await glideTo(loc, ms);
  await wait(250);
  await page.mouse.down();
  await wait(110);
  await page.mouse.up();
  await loc.selectOption(value);
};
const computed = () => page.waitForFunction(() => !document.body.innerText.includes('computing…'), null, { timeout: 60_000 });

await page.goto(`${url}/`);
await page.waitForSelector('text=Backtest');
await wait(1200);
await page.mouse.move(mx, my);
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W * SCALE, maxHeight: H * SCALE, everyNthFrame: 1 });
mark('start');
await wait(900);

// the Backtest tab
const tab = page.getByText('Backtest', { exact: true }).first();
mark('gifStart');
await glideTo(tab, 700);
await wait(150);
await press();
await page.waitForSelector('.bt-sys');
await computed();
await wait(500);

// the Astronomy Shop's recorded day
mark('shop');
await choose(page.locator('.bt-sys'), 'shop', 800);
await computed();
await wait(800);

mark('eyes');
// keep the as-built line and the change the caption is about
const row = (name) => page.locator('.bt-row', { hasText: name });
for (const name of ['Frontend on 1 vCPU', 'Frontend and cart on Graviton', 'Cache in front of the product catalog']) {
  await click(row(name).locator('.bt-eye'), 380);
  await wait(60);
}
await wait(300);

// the same day at twice the traffic
mark('x2');
await choose(page.locator('.bt-load select'), '2', 800);
await computed();
await wait(700);

mark('chart');
// along the as-built line, up to where it breaks at the peak
const chart = page.locator('.bt-panes svg').first();
const cb = await chart.boundingBox();
await glide(cb.x + cb.width * 0.3, cb.y + cb.height * 0.62, 700);
await glide(cb.x + cb.width * 0.5, cb.y + cb.height * 0.2, 900);
await wait(500);

mark('autoscale');
// the autoscaled frontend holds, and what it costs
await click(row('Autoscale the frontend'), 800);
await wait(300);
const verdict = page.locator('.bt-verdict').first();
await glideTo(verdict, 800, 0.47, 0.55);
await wait(1700);
mark('gifEnd');

// the Review screen's summary
await click(page.getByRole('tab', { name: 'Review' }), 1000);
await wait(400);
await computed();
await wait(2500);
await glide(W * 0.93, H * 0.6, 700);
for (let i = 0; i < 20; i++) {
  await page.mouse.wheel(0, 15);
  await wait(25);
}
await wait(3500);

await cdp.send('Page.stopScreencast');
mark('end');
await writing;
await ctx.close();
await browser.close();

// frames → a constant-rate movie: each frame lasts until the next
const t0 = frames[0].t;
const list = frames.map((f, i) => `file '${f.file}'\nduration ${((frames[i + 1]?.t ?? marks.end) - f.t).toFixed(4)}`).join('\n') + `\nfile '${frames.at(-1).file}'\n`;
writeFileSync(join(tmp, 'list.txt'), list);
const mp4 = join(out, 'app-backtest.mp4');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(tmp, 'list.txt'), '-t', (marks.end - t0).toFixed(2), '-vf', `fps=${FPS},scale=${W * MP4_SCALE}:${H * MP4_SCALE}:flags=lanczos,format=yuv420p`, '-c:v', 'libx264', '-crf', '24', '-preset', 'slow', '-tune', 'animation', '-movflags', '+faststart', mp4]);

// the hero cut, as a GIF with its own palette
const ss = Math.max(0, marks.gifStart - t0 - 0.3).toFixed(2);
const dur = (marks.gifEnd - marks.gifStart + 0.3).toFixed(2);
const gif = join(out, 'backtest.gif');
const vf = `fps=${GIF_FPS},scale=${GIF_W}:-1:flags=lanczos`;
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', ss, '-t', dur, '-i', mp4, '-vf', `${vf},palettegen=max_colors=128:stats_mode=diff`, join(tmp, 'palette.png')]);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', ss, '-t', dur, '-i', mp4, '-i', join(tmp, 'palette.png'), '-lavfi', `${vf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, gif]);
rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${mp4} (${(marks.end - t0).toFixed(1)} s) and ${gif} (${dur} s from ${ss} s)`, errors.length ? errors : '');
