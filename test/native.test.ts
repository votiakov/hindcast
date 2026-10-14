import { loadNativeEngine } from '../src/backtest/native';

/**
 * The backtest and spec suites again, with the compiled engine loaded: importers, calibration,
 * strategies, replays, Terraform plans, manifest diffs and the Kubernetes / Terraform spec readers
 * answer through engine-rs and must meet the same expectations as the TypeScript ones.
 */
if (!(await loadNativeEngine())) throw new Error('the compiled engine did not load (npm run engine:build)');
await import('./backtest.test');
await import('./spec.test');
