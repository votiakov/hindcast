// Builds the user-facing docs (public/docs/*.html) from docs-site/pages/*.html.
//
//   node scripts/build-docs.mjs [--check]   (--check validates pages, pins and links without writing)
//
// A page fragment starts with a front-matter comment and holds one or more annotated screens:
//
//   <!-- title: The backtest | lede: … -->
//   <section class="screen" data-shot="backtest">
//     <h2>…</h2>
//     <ol class="pins">
//       <li data-pin="p99"><h3>p99</h3><p>…</p></li>
//     </ol>
//   </section>
//
// For every screen the build inserts the screenshot (public/docs/shots/<shot>.png) with a numbered
// pin per <li>, placed from public/docs/shots/pins.json (written by scripts/docs-shots.mjs).
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'docs-site/pages');
const OUT = join(ROOT, 'public/docs');
const pins = JSON.parse(readFileSync(join(OUT, 'shots/pins.json'), 'utf8'));

/** chapters in reading order: file, rail label, group */
const CHAPTERS = [
  ['index', 'Overview', ''],
  ['why', 'Why Hindcast', ''],
  ['agents', 'For AI agents', ''],
  ['backtest', 'The backtest screen', 'Backtest on real data'],
  ['data', 'Bring your data', 'Backtest on real data'],
  ['calibration', 'How the model is fitted', 'Backtest on real data'],
  ['strategies', 'Strategies', 'Backtest on real data'],
  ['outages', 'Public-outage replays', 'Backtest on real data'],
  ['ci', 'CLI, pull requests, MCP', 'Backtest on real data'],
  ['live', 'Live', 'Design simulator'],
  ['lessons', 'Lessons', 'Design simulator'],
  ['sandbox', 'Sandbox', 'Design simulator'],
  ['audit', 'Failure audit and analysis', 'Design simulator'],
  ['compare', 'Compare', 'Design simulator'],
  ['studio', 'Studio', 'Design simulator'],
  ['use-cases', 'Use cases', 'Reference'],
  ['accuracy', 'Accuracy', 'Reference'],
  ['capabilities', 'Everything it does', 'Reference'],
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function meta(src, file) {
  const m = src.match(/^<!--([\s\S]*?)-->/);
  if (!m) throw new Error(`${file}: missing front matter`);
  return Object.fromEntries(m[1].split('|').map((kv) => kv.split(':')).map(([k, ...v]) => [k.trim(), v.join(':').trim()]));
}

function screens(body, file) {
  return body.replace(/<section class="screen" data-shot="([\w-]+)"([^>]*)>([\s\S]*?)<\/section>/g, (_, shot, attrs, inner) => {
    const at = pins[shot];
    if (!at) throw new Error(`${file}: no screenshot "${shot}" — run scripts/docs-shots.mjs ${shot}`);
    const size = at._size ?? { w: 1280, h: 800 };
    let n = 0;
    const marks = [];
    const list = inner.replace(/<li data-pin="([\w-]+)">/g, (_, pin) => {
      const p = at[pin];
      if (!p) throw new Error(`${file}: shot "${shot}" has no pin "${pin}"`);
      n++;
      const id = `${shot}-${pin}`;
      marks.push(`<a class="pin" href="#${id}" data-for="${id}" style="left:${p.x}%;top:${p.y}%" aria-label="Note ${n}">${n}</a>`);
      return `<li id="${id}" data-n="${n}">`;
    });
    const caption = (inner.match(/<h2[^>]*>([\s\S]*?)<\/h2>/) ?? [, shot])[1].replace(/<[^>]+>/g, '');
    return `<section class="screen" data-shot="${shot}"${attrs}>
<figure class="shot"><div class="shot-frame"><a class="shot-full" href="shots/${shot}.png" target="_blank" rel="noopener" title="Open full size"><img src="shots/${shot}.png" width="${size.w}" height="${size.h}" alt="${esc(caption)} — screenshot" loading="lazy"></a>${marks.join('')}</div></figure>
<div class="notes">${list}</div>
</section>`;
  });
}

function rail(current) {
  let group = null;
  let html = '';
  for (const [file, label, g] of CHAPTERS) {
    if (g !== group) {
      if (g) html += `<div class="rail-h">${esc(g)}</div>`;
      group = g;
    }
    html += `<a href="${file}.html"${file === current ? ' aria-current="page"' : ''}>${esc(label)}</a>`;
  }
  return html;
}

const layout = (file, m, body) => {
  const i = CHAPTERS.findIndex(([f]) => f === file);
  const prev = CHAPTERS[i - 1];
  const next = CHAPTERS[i + 1];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(m.title)} · Hindcast docs</title>
<meta name="description" content="${esc(m.lede ?? '')}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans+Condensed:wght@400;500;600&display=swap">
<link rel="stylesheet" href="docs.css">
</head>
<body>
<header class="bar">
  <a class="brand" href="index.html">Hindcast<span>docs</span></a>
  <nav class="bar-links" aria-label="The app">
    <a href="../#backtest">Backtest</a><a href="../#live">Live</a><a href="../#lessons">Lessons</a><a href="../#sandbox">Sandbox</a><a href="../#compare">Compare</a><a href="../#studio">Studio</a>
  </nav>
  <a class="bar-open" href="../">Open the app ↗</a>
</header>
<div class="page">
<nav class="rail" aria-label="Chapters">${rail(file)}</nav>
<main>
<header class="head">
  <div class="kicker">${esc(CHAPTERS[i][2] || 'Documentation')}</div>
  <h1>${esc(m.title)}</h1>
  ${m.lede ? `<p class="lede">${m.lede}</p>` : ''}
</header>
${screens(body, file)}
<nav class="pager">${prev ? `<a href="${prev[0]}.html">← ${esc(prev[1])}</a>` : '<span></span>'}${next ? `<a href="${next[0]}.html">${esc(next[1])} →</a>` : ''}</nav>
</main>
</div>
<script src="docs.js"></script>
</body>
</html>
`;
};

const check = process.argv.includes('--check');
let built = 0;
const out = {};
for (const f of readdirSync(SRC).filter((f) => f.endsWith('.html'))) {
  const file = f.replace(/\.html$/, '');
  if (!CHAPTERS.some(([c]) => c === file)) throw new Error(`${f}: not in CHAPTERS`);
  const src = readFileSync(join(SRC, f), 'utf8');
  const m = meta(src, f);
  out[`${file}.html`] = layout(file, m, src.replace(/^<!--[\s\S]*?-->\s*/, ''));
  built++;
}
// every local link and anchor resolves
const ids = Object.fromEntries(Object.entries(out).map(([f, h]) => [f, new Set([...h.matchAll(/id="([^"]+)"/g)].map((x) => x[1]))]));
for (const [f, h] of Object.entries(out))
  for (const [, u, hash] of h.matchAll(/(?:href|src)="([^"#:]*)(#[^"]*)?"/g)) {
    if (u.startsWith('..')) continue;
    const t = u || f;
    if (t.endsWith('.html') && !out[t] && !existsSync(join(OUT, t))) throw new Error(`${f}: link to missing ${t}`);
    if (!t.endsWith('.html') && !existsSync(join(OUT, t))) throw new Error(`${f}: missing file ${t}`);
    if (hash && out[t] && !ids[t].has(hash.slice(1))) throw new Error(`${f}: no anchor ${t}${hash}`);
  }
for (const [file] of CHAPTERS) if (!out[`${file}.html`]) throw new Error(`chapter ${file} has no page in docs-site/pages/`);
if (!check) for (const [f, h] of Object.entries(out)) writeFileSync(join(OUT, f), h);
console.log(check ? `${built} pages ok` : `built ${built} pages into public/docs/`);
