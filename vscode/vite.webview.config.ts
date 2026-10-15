import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

/** The webview: one HTML file (engine included) the extension loads from disk, nothing fetched. */
export default defineConfig({
  root: 'webview',
  base: './',
  plugins: [react(), viteSingleFile()],
  build: { outDir: '../dist/webview', emptyOutDir: true },
  worker: { format: 'es' },
});
