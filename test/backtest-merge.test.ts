import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { backtest, mergeBacktests } from '../src/backtest/backtest';
import { reviveModel } from '../src/backtest/model';

describe('backtest split across workers', () => {
  it('merging per-strategy backtests equals one backtest over all strategies', () => {
    const w = JSON.parse(readFileSync('public/reference/hotrod.json', 'utf8'));
    const model = reviveModel(w.model);
    const strategies = w.strategies.map((y: string) => parse(y));
    const whole = backtest(model, w.dataset, strategies, { draws: 4 });
    const merged = mergeBacktests([backtest(model, w.dataset, strategies.slice(0, 2), { draws: 4 }), backtest(model, w.dataset, strategies.slice(2), { draws: 4 })]);
    expect(merged.ranking).toEqual(whole.ranking);
    expect(merged.strategies.map((s) => s.summary)).toEqual(whole.strategies.map((s) => s.summary));
    expect(merged.baseline.summary).toEqual(whole.baseline.summary);
  });
});
