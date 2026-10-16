import type { StrategyResult } from './backtest';
import * as wasm from './wasm/hindcast_engine.js';

/**
 * The one-sentence verdict a backtest is read by, e.g. "saves $410/month; on Sep 14 at 12:03 UTC it
 * would have caused 9 minutes out of SLO (…)". The engine writes it (review::judge::headline): the
 * same sentence the CLI, the reports and the agent tools print.
 */
export function headline(s: StrategyResult, base: StrategyResult): string {
  return wasm.backtestHeadline(s, base);
}
