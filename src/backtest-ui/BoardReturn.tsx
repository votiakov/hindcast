import { useBacktest } from './store';
import { backtestBoard } from './bridge';
import { useSim } from '../sim/store';
import './terminal.css';

/** on a board opened from the backtest: send the edits back as a strategy, or just go back */
export function BoardReturn() {
  const origin = useBacktest((s) => s.origin);
  const setMode = useSim((s) => s.setMode);
  if (!origin) return null;
  return (
    <div className="bt-return" role="group" aria-label="Backtest">
      <span>
        Board of <b>{origin.label}</b> from the backtest
      </span>
      <button onClick={() => backtestBoard()}>Backtest these edits</button>
      <button onClick={() => setMode('backtest')}>Back to the chart</button>
    </div>
  );
}
