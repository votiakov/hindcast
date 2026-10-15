// Builds the extension into dist/: the extension and the engine worker (esbuild, CommonJS for the
// extension host), the engine's .wasm next to them, and the webview (vite, one HTML file).
// Uses the repository's own node_modules; run `npm run engine:build` at the root after Rust changes.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(here, '..');
const dist = join(here, 'dist');
mkdirSync(dist, { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: true,
  logLevel: 'warning',
  // wasm-bindgen's loader refers to import.meta.url; in CommonJS it is this file
  define: { 'import.meta.url': 'importMetaUrl' },
  banner: { js: "const importMetaUrl = require('url').pathToFileURL(__filename).href;" },
};
await build({ ...common, entryPoints: [join(here, 'src/extension.ts')], outfile: join(dist, 'extension.cjs'), external: ['vscode'] });
await build({ ...common, entryPoints: [join(here, 'src/worker.ts')], outfile: join(dist, 'worker.cjs') });
copyFileSync(join(root, 'src/backtest/wasm/hindcast_engine_bg.wasm'), join(dist, 'hindcast_engine_bg.wasm'));
mkdirSync(join(here, 'media'), { recursive: true });
copyFileSync(join(root, 'public/favicon.svg'), join(here, 'media/icon.svg'));

execFileSync(join(root, 'node_modules/.bin/vite'), ['build', '--config', 'vite.webview.config.mts', '--logLevel', 'warn'], { cwd: here, stdio: 'inherit' });
// nothing from the network: the Terminal theme's web fonts fall back to the system's
const page = join(dist, 'webview/index.html');
writeFileSync(page, readFileSync(page, 'utf8').replace(/@import\s*(url\()?["']https:\/\/fonts\.googleapis\.com[^"']*["']\)?;/g, ''));
console.log('built vscode/dist');
