import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { singleFile } from './scripts/vite-single-file.ts';

/** Single-file build of the app for the MCP Apps live canvas (served as a ui:// resource). */
export default defineConfig({
  plugins: [react(), singleFile()],
  build: {
    outDir: 'dist-mcp',
    emptyOutDir: true,
    rolldownOptions: { input: 'mcp-app.html' },
  },
  worker: { format: 'es' },
});
