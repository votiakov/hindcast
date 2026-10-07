#!/usr/bin/env node
/**
 * Frame-perfect episode renderer.
 *
 *   npm run record -- <episode-id> [--aspect 4:5] [--brand personal] [--theme neon|transit] [--fps 30] [--gif] [--no-stills]
 *                                  [--url http://localhost:5173] [--out exports]
 *
 * Opens the app in render mode inside headless Chromium with a fake clock, steps time one frame
 * at a time (JS timers, CSS animations and SVG/SMIL particles all pinned to the frame clock),
 * screenshots every frame and pipes it into ffmpeg → MP4 (H.264). Also writes a PNG still a moment
 * after every caption beat plus the outro, and bundles those into a PDF carousel for LinkedIn.
 */
import { chromium } from 'playwright';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SIZES = { '4:5': [1080, 1350], '1:1': [1080, 1080], '9:16': [1080, 1920], '16:9': [1920, 1080] };

function parseArgs(argv) {
  const o = { aspect: '4:5', brand: 'personal', theme: 'neon', fps: 30, url: 'http://localhost:5173', out: 'exports', gif: false, stills: true, ep: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--gif') o.gif = true;
    else if (a === '--no-stills') o.stills = false;
    else if (a.startsWith('--')) o[a.slice(2)] = argv[++i];
    else o.ep = a;
  }
  o.fps = Number(o.fps);
  if (!o.ep) throw new Error('usage: npm run record -- <episode-id> [--aspect 4:5] [--brand personal] [--gif]');
  if (!SIZES[o.aspect]) throw new Error(`unknown aspect ${o.aspect}; use one of ${Object.keys(SIZES).join(', ')}`);
  return o;
}

function ffmpeg(args) {
  const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => p.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exited ${code}`)))));
  return { stdin: p.stdin, done };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const [w, h] = SIZES[o.aspect];
  const name = `${o.ep}_${o.aspect.replace(':', 'x')}_${o.brand}_${o.theme}`;
  const dir = resolve(o.out, name);
  mkdirSync(dir, { recursive: true });
  const mp4 = join(dir, `${name}.mp4`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  const q = new URLSearchParams({ render: '1', ep: o.ep, aspect: o.aspect, brand: o.brand, theme: o.theme });
  await page.goto(`${o.url}/?${q}`);
  await page.waitForFunction(() => window.studio);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500); // let the canvas measure and fit

  // freeze time, then drive it manually
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(new Date(now + 50));
  await page.evaluate(() => window.studio.start());

  const enc = ffmpeg(['-y', '-f', 'image2pipe', '-framerate', String(o.fps), '-i', '-', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium', '-movflags', '+faststart', mp4]);

  const frameMs = 1000 / o.fps;
  const stills = [];
  let lastFired = 0;
  let stillAt = -1;
  let outroShot = false;
  const maxFrames = o.fps * 180;
  const started = Date.now();

  for (let f = 0; f < maxFrames; f++) {
    await page.clock.runFor(frameMs);
    const t = (f + 1) / o.fps;
    // pin CSS animations/transitions and SVG particle timelines to the frame clock
    await page.evaluate((t) => {
      const born = (window.__born ??= new WeakMap());
      for (const a of document.getAnimations()) {
        if (!born.has(a)) born.set(a, t);
        a.pause();
        a.currentTime = (t - born.get(a)) * 1000;
      }
      for (const svg of document.querySelectorAll('svg')) {
        if (!svg.setCurrentTime) continue;
        if (!born.has(svg)) born.set(svg, t);
        svg.pauseAnimations();
        svg.setCurrentTime(t - born.get(svg));
      }
    }, t);

    const st = await page.evaluate(() => window.studio.state());
    const shot = await page.screenshot({ type: 'jpeg', quality: 95 });
    if (!enc.stdin.write(shot)) await once(enc.stdin, 'drain');

    if (o.stills) {
      if (st.fired > lastFired) {
        lastFired = st.fired;
        stillAt = f + Math.round(o.fps * 2); // after the caption has animated in and the system reacted
      }
      if (f === stillAt) stills.push(await page.screenshot({ type: 'png' }));
      if (st.finished && !outroShot && st.t > 0) {
        outroShot = true;
        stillAt = f + Math.round(o.fps * 1.5);
      }
    }
    if (f % (o.fps * 5) === 0) process.stdout.write(`\r  rendering… ${t.toFixed(0)}s of video`);
    if (st.done) break;
  }
  enc.stdin.end();
  await enc.done;
  process.stdout.write(`\r  rendered in ${((Date.now() - started) / 1000).toFixed(0)}s            \n`);
  console.log(`✓ ${mp4}`);

  if (stills.length) {
    const files = stills.map((buf, i) => {
      const p = join(dir, `${name}_${String(i + 1).padStart(2, '0')}.png`);
      writeFileSync(p, buf);
      return p;
    });
    console.log(`✓ ${files.length} stills in ${dir}`);
    // LinkedIn "document" carousel: one still per page
    const html = `<html><head><style>@page{size:${w}px ${h}px;margin:0}body{margin:0}img{display:block;width:${w}px;height:${h}px;page-break-after:always}</style></head><body>${files
      .map((p) => `<img src="data:image/png;base64,${readFileSync(p).toString('base64')}">`)
      .join('')}</body></html>`;
    const pdfPage = await browser.newPage();
    await pdfPage.setContent(html, { waitUntil: 'load' });
    const pdf = join(dir, `${name}_carousel.pdf`);
    await pdfPage.pdf({ path: pdf, width: `${w}px`, height: `${h}px`, printBackground: true });
    console.log(`✓ ${pdf}`);
  }
  await browser.close();

  if (o.gif) {
    const gif = join(dir, `${name}.gif`);
    const scale = Math.round(w / 2);
    await ffmpeg(['-y', '-i', mp4, '-vf', `fps=12,scale=${scale}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`, gif]).done;
    console.log(`✓ ${gif}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
