// Click through every view and report console errors, page errors and failed
// requests, with a screenshot of each state.
//
//   npm run dev
//   node scripts/ui-audit.mjs [--out dir] [--only phone]
//
// Exits 1 when anything was logged as an error.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i < 0 ? d : process.argv[i + 1];
};
const BASE = process.env.HINDCAST_APP_URL ?? process.env.BOTTLENECK_APP_URL ?? 'http://localhost:5173';
const OUT = arg('out', 'ui-audit');
const ONLY = arg('only', '');
const THEMES = ONLY === 'phone' ? [] : ['terminal'];
mkdirSync(OUT, { recursive: true });

const problems = [];
const b = await chromium.launch();
const wait = (p, ms) => p.waitForTimeout(ms);

async function session(theme, width = 1280, height = 800) {
  const p = await b.newPage({ viewport: { width, height } });
  let where = 'start';
  p.on('console', (m) => m.type() === 'error' && problems.push({ theme, width, where, kind: 'console', text: m.text().slice(0, 300) }));
  p.on('pageerror', (e) => problems.push({ theme, width, where, kind: 'pageerror', text: String(e).slice(0, 300) }));
  p.on('requestfailed', (r) => !r.url().includes('fonts.g') && problems.push({ theme, width, where, kind: 'request', text: `${r.url()} ${r.failure()?.errorText}` }));
  const at = (w) => (where = w);
  await p.goto(`${BASE}/#live`);
  await wait(p, 1500);
  if (theme !== 'terminal') {
    await p.locator('.topbar button').filter({ has: p.locator('svg.lucide-settings') }).click();
    await p.click(`button:text-is("${theme[0].toUpperCase() + theme.slice(1)}")`);
    await p.mouse.click(640, 400);
  }
  return { p, at };
}

const shot = (p, name) => p.screenshot({ path: join(OUT, `${name}.png`) });

for (const theme of THEMES) {
  const { p, at } = await session(theme);
  // Live
  at('live');
  await wait(p, 3000);
  await shot(p, `${theme}-live`);
  // every view through the tabs
  for (const [tab, name] of [['Lessons', 'lessons'], ['Sandbox', 'sandbox'], ['Compare', 'compare'], ['Studio', 'studio'], ['Backtest', 'backtest']]) {
    at(name);
    const tabs = p.locator('.mode-tabs button, .bt-modes button');
    await tabs.filter({ hasText: tab }).first().click();
    await wait(p, name === 'backtest' ? 6000 : 2000);
    await shot(p, `${theme}-${name}`);
    if (name === 'sandbox') {
      at('sandbox-run');
      await p.keyboard.press('Space');
      await wait(p, 3000);
      for (const t of ['Failure audit', 'Analysis', 'Architecture as code']) {
        at(`sandbox-${t}`);
        const btn = p.locator(`button[title^="${t}"]`);
        if (await btn.count()) {
          await btn.click();
          await wait(p, t === 'Failure audit' ? 2500 : 800);
          await shot(p, `${theme}-sandbox-${t.split(' ')[0].toLowerCase()}`);
          await btn.click();
        } else problems.push({ theme, where: 'sandbox', kind: 'missing', text: `no "${t}" button` });
      }
      // the request tracer: a component's card → trace, drawn on the board and read out below it
      at('sandbox-trace');
      await p.locator('.react-flow__node .ref-head').nth(1).click();
      await wait(p, 400);
      await p.click('.nc-act:has-text("trace")');
      await p.waitForSelector('.trace-strip .ts-path, .trace-strip .ts-msg.bad', { timeout: 30000 }).catch(() => problems.push({ theme, where: 'sandbox-trace', kind: 'missing', text: 'no traced request' }));
      await wait(p, 600);
      await shot(p, `${theme}-sandbox-trace`);
      if (await p.locator('.trace-strip .ts-msg.bad').count()) problems.push({ theme, where: 'sandbox-trace', kind: 'trace', text: await p.locator('.trace-strip .ts-msg.bad').innerText() });
      await p.keyboard.press('Escape');
      await p.keyboard.press('Space');
    }
    if (name === 'backtest') {
      for (const t of ['Incidents', 'Endpoints', 'Changes', 'Model']) {
        at(`backtest-${t}`);
        const tabEl = p.locator(`.bt-tabs [role="tab"]:has-text("${t}")`);
        if (await tabEl.count()) {
          await tabEl.click();
          await wait(p, 500);
          await shot(p, `${theme}-backtest-${t.toLowerCase()}`);
        }
      }
    }
    // back to the app bar for the next tab
  }
  await p.close();
}

// narrow screens: every view at phone width, terminal theme
{
  const { p, at } = await session('terminal', 390, 844);
  for (const h of ['live', 'lessons', 'sandbox', 'compare', 'studio', 'backtest']) {
    at(`phone-${h}`);
    await p.goto(`${BASE}/#${h}`);
    await wait(p, h === 'backtest' ? 6000 : 2000);
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 4) problems.push({ theme: 'terminal', width: 390, where: h, kind: 'layout', text: `page scrolls sideways by ${overflow}px` });
    await shot(p, `phone-${h}`);
  }
  await p.close();
}

await b.close();
const seen = new Set();
const unique = problems.filter((x) => {
  const k = `${x.kind}|${x.where}|${x.text}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});
for (const x of unique) console.log(`${x.kind.padEnd(9)} ${String(x.theme).padEnd(9)} ${String(x.width ?? 1280).padEnd(5)} ${x.where.padEnd(28)} ${x.text}`);
console.log(`\n${unique.length} problem(s); screenshots in ${OUT}/`);
process.exit(unique.length ? 1 : 0);
