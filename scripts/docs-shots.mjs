// Screenshots and pin positions for the user-facing docs (public/docs/).
//
//   npm run dev            # the app on http://localhost:5173
//   node scripts/docs-shots.mjs [shot …]
//
// Each shot opens the app, gets it into a state, takes a 1280×800 screenshot to
// public/docs/shots/<id>.png and records where each pin's element is, as a share of the image, in
// public/docs/shots/pins.json. scripts/build-docs.mjs places the pins from that file, so pins follow
// the UI when it moves: rerun this after UI changes.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public/docs/shots');
const BASE = process.env.BOTTLENECK_APP_URL ?? 'http://localhost:5173';
const W = 1280;
const H = 800;

const wait = (p, ms = 600) => p.waitForTimeout(ms);
const backtest = async (p, ref) => {
  await p.goto(`${BASE}/#backtest`);
  await p.waitForSelector('.bt-pane svg', { timeout: 30000 });
  if (ref) {
    await p.selectOption('select[aria-label="Reference system"]', ref);
    await p.waitForFunction((n) => document.querySelector('.bt-sym')?.textContent?.includes(n), ref === 'shop' ? 'Shop' : ref === 'petclinic' ? 'PetClinic' : 'HotROD', { timeout: 60000 });
  }
  await p.waitForSelector('.bt-verdict', { timeout: 60000 });
  await wait(p, 1200);
};
const tab = async (p, name) => {
  await p.click(`.bt-tabs [role="tab"]:has-text("${name}")`);
  await wait(p, 500);
};
const mode = async (p, label) => {
  await p.goto(BASE + '/');
  await wait(p, 800);
  await p.click(`.mode-tabs button:has-text("${label}")`);
  await wait(p, 1200);
};

/**
 * pins: id → [selector, anchor?, nth?, dx?, dy?]
 * anchor: where on the element the pin goes — 'c' centre (default), 'tl', 'tr', 'bl', 'br', 'l', 'r', 't', 'b';
 * nth: which match (negative counts from the end); dx, dy: px to move the pin off what it points at
 */
const view = async (p, hash, ms = 2500) => {
  await p.goto(`${BASE}/${hash}`);
  await wait(p, ms);
};
/** run the sandbox until the default design is overloaded */
const runSandbox = async (p) => {
  await view(p, '#sandbox');
  await p.keyboard.press('Space');
  await wait(p, 4500);
};

/** the tester panel at a height that shows whole tables */
const tall = (px) => `.bt-tester { height: ${px}px !important; }`;
const TESTER_TALL = tall(330);

const SHOTS = {
  backtest: {
    setup: (p) => backtest(p),
    pins: {
      views: ['.bt-modes', 'r', 0, 12],
      ranges: ['.bt-bar .bt-chip', 'b', 0, 0, 8],
      p99: ['.bt-pane', 'tl', 0, 16, 60],
      incident: ['.bt-breach', 'c', -1],
      errors: ['.bt-pane', 'tl', 1, 16, 48],
      cost: ['.bt-pane', 'r', 2, -110, 10],
      savings: ['.bt-pane', 'tl', 3, 330, 8],
      watch: ['.bt-watch', 'tr', 0, -18, 20],
      worst: ['.bt-worstbox', 'tr', 0, -16, 16],
      accuracy: ['.bt-watch :text("Model accuracy")', 'r', 0, 16],
      verdict: ['.bt-verdict', 'l', 0, 500],
      stats: ['.bt-stats', 'tl', 0, 190, 26],
      system: ['select[aria-label="Reference system"]', 'b', 0, 0, 8],
      card: ['.bt-bar .bt-chip:has-text("Card")', 'b', 0, 0, 8],
      outage: ['select[aria-label="Replay a public outage"]', 'b', 0, 0, 8],
      files: ['.bt-bar .bt-chip:has-text("Open files")', 'b', 0, 0, 8],
    },
  },
  'bt-incidents': {
    css: TESTER_TALL,
    clip: '.bt-tester',
    setup: async (p) => (await backtest(p), await tab(p, 'Incidents')),
    pins: {
      tab: ['.bt-tabs [role="tab"]:has-text("Incidents")', 'b', 0, 0, 6],
      list: ['.bt-tabbody tr', 'r', 1, -30],
    },
  },
  'bt-endpoints': {
    css: tall(300),
    clip: '.bt-tester',
    setup: async (p) => (await backtest(p, 'shop'), await tab(p, 'Endpoints')),
    pins: {
      table: ['.bt-tabbody tr', 'l', 1, 6],
      slo: ['.bt-tabbody th:has-text("own SLO")', 'r', 0, 10],
      failed: ['.bt-tabbody th:has-text("failed")', 'r', 0, 10],
      minutes: ['.bt-tabbody th:has-text("min out")', 'r', 0, 10],
      price: ['.bt-tabbody th:has-text("1M")', 'r', 0, 10],
    },
  },
  'bt-changes': {
    css: TESTER_TALL,
    clip: '.bt-tester',
    setup: async (p) => (await backtest(p), await tab(p, 'Changes')),
    pins: {
      yaml: ['.bt-changes textarea', 'tr', 0, -18, 18],
      notes: ['.bt-changes > div', 'tl', 1, 10, 10],
    },
  },
  'bt-model': {
    css: tall(640),
    clip: '.bt-tester',
    setup: async (p) => (await backtest(p, 'shop'), await tab(p, 'Model')),
    pins: {
      fit: ['.bt-tabbody th:has-text("fit")', 'r', 0, 10],
      capacity: ['.bt-tabbody th:has-text("capacity")', 'r', 0, 10],
      limit: ['.bt-tabbody th:has-text("limited")', 'r', 0, 10],
      cost: ['.bt-tabbody th:has-text("replica-")', 'r', 0, 10],
      notes: ['.bt-tabbody th:has-text("notes")', 'r', 0, 10],
      frontend: ['.bt-tabbody tr:has-text("frontend")', 'l', 0, 6],
      virtual: ['.bt-tabbody tr:has-text("valkey"), .bt-tabbody tr:has-text("redis")', 'l', 0, 6],
    },
  },
  'bt-model-pet': {
    css: tall(250),
    clip: '.bt-tester',
    setup: async (p) => (await backtest(p, 'petclinic'), await tab(p, 'Model')),
    pins: {
      knee: ['.bt-tabbody tr:has-text("broke between")', 'r', 0, -20],
      costonly: ['.bt-tabbody tr:has-text("cost only")', 'l', 0, 6],
    },
  },
  'bt-outage': {
    setup: async (p) => {
      await backtest(p);
      await p.selectOption('select[aria-label="Replay a public outage"]', 'slack-2021-01-04');
      await p.waitForSelector('.bt-outage', { timeout: 60000 });
      await wait(p, 2500);
    },
    pins: {
      banner: ['.bt-outage-head', 'l', 0, 4],
      what: ['.bt-outage-what', 'r', 0, -14],
      timeline: ['.bt-outage-tl', 'l', 0, 6],
      marker: ['.bt-marker', 'c', 0],
    },
  },
  'bt-board': {
    setup: async (p) => {
      await backtest(p);
      await p.click('.bt-worstbox :text("open on board")');
      await wait(p, 3500);
    },
    pins: {
      back: ['button:has-text("Back to the chart")', 'l', 0, -6],
      edits: ['button:has-text("Backtest these edits")', 'r', 0, 6],
      node: ['.react-flow__node', 'tr', 0, -6, 6],
    },
  },
  'bt-drop': {
    setup: async (p) => {
      await backtest(p);
      const dt = await p.evaluateHandle(() => {
        const d = new DataTransfer();
        d.items.add(new File(['name: x'], 'bottleneck.import.yaml'));
        return d;
      });
      await p.dispatchEvent('.bt', 'dragenter', { dataTransfer: dt });
      await p.dispatchEvent('.bt', 'dragover', { dataTransfer: dt });
      await wait(p, 500);
    },
    pins: {
      drop: ['.bt-drop', 'c', 0, 0, -30],
      files: ['.bt-bar .bt-chip:has-text("Open files")', 'b', 0, 0, 8],
    },
  },
  report: {
    setup: async (p) => {
      await p.goto(`${BASE}/docs/examples/hotrod-report.html`);
      await wait(p, 1500);
    },
    pins: {
      verdict: ['.verdict', 'l', 0, -10],
      p99: ['figure', 'tl', 0, 14, 14],
      errors: ['figure', 'tl', 1, 14, 14],
    },
  },
  card: {
    setup: async (p) => {
      await backtest(p);
      const [popup] = await Promise.all([p.waitForEvent('popup'), p.click('.bt-bar .bt-chip:has-text("Card")')]);
      await popup.setViewportSize({ width: 1080, height: 1350 });
      await popup.waitForLoadState();
      await wait(popup, 12000);
      return popup;
    },
    clip: '.cd',
    pins: {
      verdict: ['.cd-head', 'b', 0, 0, -10],
      chart: ['.cd-chart', 'tl', 0, 24, 24],
      foot: ['.cd-foot', 'l', 0, 14],
    },
  },
  live: {
    setup: (p) => view(p, '#live', 5000),
    pins: {
      chapters: ['.live-chapters', 'r', 0, 10],
      metrics: ['.metrics', 'b', 0, 0, 4],
      node: ['.react-flow__node', 'tr', 1, -8, 8],
      callout: ['.callout-title', 'l', 0, -14],
      actions: ['.callout-actions', 'l', 0, -14],
    },
  },
  lesson: {
    setup: (p) => view(p, '#lessons', 3000),
    pins: {
      picker: ['.lesson-picker', 'l', 0, -8],
      level: ['.step-title', 'l', 0, -10],
      objective: ['.objective', 'l', 0, -10],
      progress: ['.hold', 'l', 0, -10],
      palette: ['.palette-scroll', 'tr', 0, -14, 20],
      play: ['.controlbar button', 't', 0, 0, -8],
    },
  },
  sandbox: {
    setup: runSandbox,
    pins: {
      palette: ['.palette-scroll', 'tr', 0, -14, 20],
      node: ['.react-flow__node', 'tr', 1, -8, 8],
      flow: ['.react-flow__edge', 'c', 0],
      design: ['.dm', 'b', 0, 0, 6],
      spec: ['button[title^="Architecture as code"]', 'b', 0, 0, 8],
      audit: ['button[title^="Failure audit"]', 'b', 0, 0, 8],
      analysis: ['button[title^="Analysis"]', 'b', 0, 0, 8],
      metrics: ['.metrics', 'b', 0, 0, 4],
      timeline: ['.tl-track', 'l', 0, 40],
      traffic: ['.controlbar input[type="range"]', 'c', 0, 0, -16],
      chaos: ['.controlbar button:has-text("Kill server")', 't', 0, 0, -8],
      minimap: ['.react-flow__minimap', 'tl', 0, 10, 10],
    },
  },
  'sandbox-node': {
    setup: async (p) => {
      await runSandbox(p);
      await p.locator('.react-flow__node .ref-head').nth(1).click();
      await wait(p, 400);
      await p.click('.nc-more');
      await wait(p, 900);
    },
    pins: {
      instances: ['.nc .nc-step', 'l', 0, -10],
      tier: ['.nc .nc-seg', 'r', 0, 10],
      autoscale: ['.nc .nc-toggle', 'l', 0, -10],
      runtime: ['.nc .nc-l:text("runtime")', 'l', 0, -10],
      resilience: ['.nc .nc-more', 'l', 0, -10],
      retries: ['.nc .nc-l:text("retries")', 'l', 0, -10],
      breaker: ['.nc .nc-l:text("breaker")', 'l', 0, -10],
      routing: ['.nc .nc-l:text("routing")', 'l', 0, -10],
      fanout: ['.nc .nc-l:text("fan-out")', 'r', 0, 60],
      queue: ['.nc .nc-l:text("queue")', 'l', 0, -10],
      fault: ['.nc select:has(option:has-text("break it"))', 'r', 0, 10],
      calibrate: ['.nc .nc-act:has-text("calibrate")', 'r', 0, 10],
    },
  },
  audit: {
    setup: async (p) => {
      await view(p, '#sandbox');
      await p.click('button[title^="Failure audit"]');
      await wait(p, 800);
      await p.click('.au-run');
      await p.waitForSelector('.au-summary', { timeout: 120000 });
      await wait(p, 800);
      await p.locator('.au-row-head').first().click();
      await wait(p, 1200);
    },
    pins: {
      inputs: ['.au-inputs', 'l', 0, -8],
      summary: ['.au-summary', 'l', 0, -8],
      lines: ['.au-sumlines', 'r', 0, 10],
      curve: ['.lc', 'tl', 0, 40, 14],
      risk: ['.au-row-head', 'l', 0, -8],
      replay: ['button:has-text("Replay on the board")', 'b', 0, 0, 8],
      clip: ['button:has-text("Studio clip")', 'r', 0, 10],
      fixes: ['.au-fixes-h', 'r', 0, 10],
      report: ['button:has-text("Copy report")', 'r', 0, 10],
      mark: ['.risk-mark, [class*="risk"]', 'l', 0, -8],
    },
  },
  analysis: {
    setup: async (p) => {
      await runSandbox(p);
      await p.click('button[title^="Analysis"]');
      await wait(p, 1500);
    },
    pins: {
      montecarlo: ['button:has-text("Run Monte Carlo")', 'l', 0, -10],
      breaking: ['button:has-text("Find breaking point")', 'l', 0, -10],
      cheapest: ['button:has-text("Find cheapest config")', 'l', 0, -10],
    },
  },
  spec: {
    setup: async (p) => {
      await view(p, '#sandbox');
      await p.click('button[title^="Architecture as code"]');
      await wait(p, 1500);
    },
    pins: {
      editor: ['.spec-text', 'tl', 0, -6, 20],
      status: ['.spec-status', 'l', 0, -6],
    },
  },
  palette: {
    setup: async (p) => {
      await view(p, '#sandbox');
      await p.keyboard.press('Meta+k');
      await wait(p, 600);
      await p.keyboard.type('kill');
      await wait(p, 600);
    },
    pins: {
      input: ['.cp-input', 'l', 0, -10],
      list: ['.cp-list', 'tl', 0, -10, 20],
    },
  },
  compare: {
    setup: async (p) => {
      await view(p, '#compare', 3000);
      await p.keyboard.press('Space');
      await wait(p, 14000);
    },
    pins: {
      strip: ['.scenario-strip', 'l', 0, 10, 24],
      a: ['.pane-stats', 'l', 0, -6],
      audit: ['button[title^="Failure audit of this side"]', 'b', 0, 0, 8],
      swap: ['select', 'b', 0, 0, 6],
      caption: ['.sb-caption', 'l', 0, -10],
      track: ['.sb-track', 'r', 0, 10],
    },
  },
  studio: {
    setup: (p) => view(p, '#studio', 3000),
    pins: {
      episodes: ['.ep-list', 'tr', 0, -14, 14],
      stage: ['.studio-canvas', 'tl', 0, 14, 14],
      render: ['.studio-panel .btn.primary', 'r', 0, 0, 8],
    },
  },
};

const only = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const pinsPath = join(OUT, 'pins.json');
const all = existsSync(pinsPath) ? JSON.parse(readFileSync(pinsPath, 'utf8')) : {};
const browser = await chromium.launch();
for (const [id, shot] of Object.entries(SHOTS)) {
  if (only.length && !only.includes(id)) continue;
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1.5 });
  const first = await ctx.newPage();
  const errors = [];
  first.on('pageerror', (e) => errors.push(e.message));
  // a setup may hand back another page to shoot (a popup)
  const p = (await shot.setup(first)) ?? first;
  if (shot.css) {
    await p.addStyleTag({ content: shot.css });
    await wait(p, 600);
  }
  // crop to one region: pins are placed relative to it
  const box = shot.clip ? await p.locator(shot.clip).first().boundingBox() : { x: 0, y: 0, width: W, height: H };
  if (!box) throw new Error(`${id}: clip ${shot.clip} is not visible`);
  const cw = Math.round(box.width);
  const ch = Math.round(box.height);
  const pins = { _size: { w: cw, h: ch } };
  for (const [pin, [sel, anchor = 'c', nth = 0, dx = 0, dy = 0]] of Object.entries(shot.pins)) {
    const loc = p.locator(sel);
    const n = await loc.count();
    if (!n) {
      await p.screenshot({ path: join(OUT, `_debug-${id}.png`) });
      throw new Error(`${id}: pin ${pin}: nothing matches ${sel} (see shots/_debug-${id}.png)`);
    }
    const b = await loc.nth(nth < 0 ? n + nth : nth).boundingBox();
    if (!b) throw new Error(`${id}: pin ${pin}: ${sel} is not visible`);
    const x = dx + (anchor.includes('l') ? b.x : anchor.includes('r') ? b.x + b.width : b.x + b.width / 2);
    const y = dy + (anchor.includes('t') ? b.y : anchor.includes('b') ? b.y + b.height : b.y + b.height / 2);
    const rx = Math.min(cw - 12, Math.max(12, x - box.x));
    const ry = Math.min(ch - 12, Math.max(12, y - box.y));
    pins[pin] = { x: +((rx / cw) * 100).toFixed(2), y: +((ry / ch) * 100).toFixed(2) };
  }
  await p.screenshot({ path: join(OUT, `${id}.png`), clip: { x: box.x, y: box.y, width: cw, height: ch } });
  all[id] = pins;
  console.log(`${id}: ${Object.keys(pins).length - 1} pins${errors.length ? ` — page errors: ${errors.join('; ')}` : ''}`);
  await ctx.close();
}
await browser.close();
writeFileSync(pinsPath, JSON.stringify(all, null, 1) + '\n');
