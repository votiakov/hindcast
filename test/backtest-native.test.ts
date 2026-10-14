import { loadNativeEngine } from '../src/backtest/native';

/**
 * The backtest suite (test/backtest.test.ts) again, with the compiled engine loaded: importers,
 * calibration, strategies and replays answer through engine-rs and must meet the same expectations.
 */
if (!(await loadNativeEngine())) throw new Error('the compiled engine did not load (npm run engine:build)');
await import('./backtest.test');
