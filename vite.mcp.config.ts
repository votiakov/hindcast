import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

/** Single-file build of the app for the MCP Apps live canvas (served as a ui:// resource). */
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: 'dist-mcp',
    emptyOutDir: true,
    rollupOptions: { input: 'mcp-app.html' },
  },
  worker: { format: 'es' },
});
