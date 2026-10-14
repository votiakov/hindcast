import { loadNativeEngine } from '../src/backtest/native';

/**
 * The agent suite (test/agent.test.ts) again, with the compiled engine loaded: verify_change,
 * Terraform plans, manifest diffs, calibration and suggestions answer through engine-rs.
 */
if (!(await loadNativeEngine())) throw new Error('the compiled engine did not load (npm run engine:build)');
await import('./agent.test');
