import type {   StrategyResult } from './backtest';

/** Plain-text renderings of a backtest: Markdown report and the pull-request comment. */

const when = (t: number) => {
  const d = new Date(t * 1000);
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} at ${d.toISOString().slice(11, 16)} UTC`;
};

/** one-sentence verdict, e.g. "saves $410/month; on Sep 14 at 12:03 it would have caused 9 minutes of errors" */
export function headline(s: StrategyResult, base: StrategyResult): string {
  const dm = s.delta.monthly.p50;
  const money = Math.abs(dm) < 1 ? 'costs the same' : dm < 0 ? `saves $${Math.round(-dm).toLocaleString('en-US')}/month` : `costs $${Math.round(dm).toLocaleString('en-US')}/month more`;
  const newInc = s.incidents.filter((i) => !base.incidents.some((b) => b.start < i.end && i.start < b.end));
  if (newInc.length) {
    const w = [...newInc].sort((a, b) => b.minutes - a.minutes || b.peakP99Ms - a.peakP99Ms)[0];
    const total = Math.max(w.minutes, s.delta.minutesOutOfSlo.p50);
    const mins = (x: number) => `${Math.max(1, Math.round(x))} minute${Math.max(1, Math.round(x)) === 1 ? '' : 's'}`;
    if (total < w.minutes + 0.5) return `${money}; on ${when(w.start)} it would have caused ${mins(w.minutes)} out of SLO (${w.why})`;
    return `${money}; it would have caused ${mins(total)} out of SLO, the worst on ${when(w.start)} (${w.why})`;
  }
  const ds = s.delta.minutesOutOfSlo.p50;
  if (ds < -0.5) return `${money} and removes ${Math.round(-ds)} minute${Math.round(-ds) === 1 ? '' : 's'} out of SLO from the history`;
  if (ds > 0.5) return `${money} and adds ${Math.round(ds)} minutes out of SLO`;
  return `${money}, with no change in time out of SLO`;
}
