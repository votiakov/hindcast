import { parse as parseYaml } from 'yaml';
import { useBacktest } from './store';
import { useSim } from '../sim/store';
import { basePlan } from '../backtest/engine';
import { observedReplicas } from '../backtest/calibrate';
import { applyStrategy } from '../backtest/strategy';
import { modelToSpec } from '../backtest/toSpec';
import { specToGraph } from '../spec/convert';

/** seconds of board time the replayed window is squeezed into */
const BOARD_SECONDS = 120;

/**
 * Open a moment of the backtest on the board: the model (with the focused strategy applied, or as
 * built) as a canvas, replaying the real traffic of the minutes around that moment.
 */
export function openMomentOnBoard(i: number, strategyIndex: number) {
  const { workspace: w, result: r } = useBacktest.getState();
  const sim = useSim.getState();
  if (!w || !r) return;
  const base = basePlan(w.model, observedReplicas(w.dataset, w.model));
  const files = w.strategies.filter((s) => !s.error);
  const strat = strategyIndex >= 0 ? files[strategyIndex] : undefined;
  const plan = strat ? applyStrategy(w.model, base, parseYaml(strat.yaml)).plan : base;
  const label = strat ? r.strategies[strategyIndex]?.name ?? 'strategy' : 'as built';
  const { spec, notes } = modelToSpec(w.model, plan, `${w.model.name} · ${label}`);

  // ~15 minutes before the moment, 5 after (bounded by the data)
  const step = r.window.stepS;
  const a = Math.max(0, i - Math.round(900 / step));
  const b = Math.min(r.t.length - 1, i + Math.round(300 / step));
  const span = Math.max(step, (b - a) * step);
  const squeeze = Math.max(1, span / BOARD_SECONDS);
  const traffic = [];
  for (let k = a; k <= b; k++) traffic.push({ at: Math.round((((k - a) * step) / squeeze) * 100) / 100, rps: Math.max(0, Math.round((r.actual.rps[k] ?? 0) * 10) / 10) });

  if (sim.mode !== 'sandbox') sim.setMode('sandbox');
  useSim.getState().loadGraph('main', specToGraph(spec), spec.name);
  useSim.getState().setDesign(null, spec.name ?? 'backtest moment');
  useSim.getState().setSetting('sloP99Ms', r.slo.p99Ms);
  useSim.getState().setSetting('sloErrorRate', r.slo.errorRate);
  const when = new Date(r.t[i] * 1000).toISOString().slice(5, 16).replace('T', ' ');
  useSim.getState().play({ title: `${when} UTC · ${label}`, duration: traffic[traffic.length - 1].at, rps: 0, traffic, events: [] });
  useSim.getState().toast('info', `Replaying ${Math.round(span / 60)} min around ${when}${squeeze > 1.01 ? `, ${squeeze.toFixed(0)}× faster` : ''}. The board is a simplified drawing of the model${notes.length ? ` (${notes.length} folded call${notes.length > 1 ? 's' : ''})` : ''}; the backtest numbers come from the model itself.`);
}
