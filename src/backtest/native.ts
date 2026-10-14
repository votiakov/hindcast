import init, { initSync } from './wasm/hindcast_engine.js';

/**
 * Loads the engine (engine-rs, built to WebAssembly by `npm run engine:build`). Everything the app
 * computes — the live simulation, the discrete-event runs, audits, calibration, backtests,
 * importers — runs in it; nothing works until it has loaded. In the browser it streams the .wasm
 * next to this module; in Node (tests, scripts) it reads the file synchronously.
 */
let loading: Promise<void> | null = null;

export function loadEngine(): Promise<void> {
  return (loading ??= (async () => {
    if (typeof window === 'undefined' && typeof process !== 'undefined' && process.versions?.node) {
      const { readFileSync } = await import('node:fs');
      initSync({ module: readFileSync(new URL('./wasm/hindcast_engine_bg.wasm', import.meta.url)) });
    } else await init();
  })());
}
