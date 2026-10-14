import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // workers are ES modules: the backtest worker loads the compiled engine (WebAssembly) on its own
  worker: { format: 'es' },
});
