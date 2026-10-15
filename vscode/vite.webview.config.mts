import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { singleFile } from '../scripts/vite-single-file.ts';

/** The webview: one HTML file (engine included) the extension loads from disk, nothing fetched. */
export default defineConfig({
  root: 'webview',
  base: './',
  plugins: [react(), singleFile()],
  build: { outDir: '../dist/webview', emptyOutDir: true },
  worker: { format: 'es' },
});
