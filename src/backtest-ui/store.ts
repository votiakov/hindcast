import { create } from 'zustand';
import { parse as parseYaml } from 'yaml';
import type { Dataset } from '../backtest/dataset';
import type { Model } from '../backtest/model';
import { backtest, type BacktestResult } from '../backtest/backtest';
import { StrategySpec } from '../backtest/strategy';

/**
 * Backtest screen state: the workspace (dataset + calibrated model + strategy files), what is
 * shown, and the computed result.
 */

export interface StrategyFile {
  /** YAML text as the user wrote it */
  yaml: string;
  /** shown on the chart */
  visible: boolean;
  error?: string;
}

export interface Workspace {
  id: string;
  name: string;
  /** where it came from, shown in the bar */
  source: string;
  dataset: Dataset;
  model: Model;
  strategies: StrategyFile[];
}

export type Tab = 'overview' | 'incidents' | 'endpoints' | 'changes' | 'model';

interface State {
  workspace: Workspace | null;
  loading: string | null;
  result: BacktestResult | null;
  computing: boolean;
  /** strategy in focus (index into workspace.strategies) */
  focus: number;
  /** visible bucket range [from, to) */
  view: [number, number] | null;
  hover: number | null;
  tab: Tab;
  draws: number;
  setWorkspace: (w: Workspace) => void;
  setLoading: (what: string | null) => void;
  setFocus: (i: number) => void;
  toggle: (i: number) => void;
  setView: (v: [number, number] | null) => void;
  setHover: (i: number | null) => void;
  setTab: (t: Tab) => void;
  editStrategy: (i: number, yaml: string) => void;
  addStrategy: (yaml: string, focus?: boolean) => void;
  removeStrategy: (i: number) => void;
  recompute: () => void;
}

export const strategyName = (yaml: string, fallback = 'strategy') => {
  try {
    return String((parseYaml(yaml) as { name?: string })?.name ?? fallback);
  } catch {
    return fallback;
  }
};

let timer: ReturnType<typeof setTimeout> | undefined;

export const useBacktest = create<State>((set, get) => ({
  workspace: null,
  loading: null,
  result: null,
  computing: false,
  focus: 0,
  view: null,
  hover: null,
  tab: 'overview',
  draws: 20,
  setWorkspace: (w) => {
    set({ workspace: w, focus: 0, view: null, hover: null, result: null });
    get().recompute();
  },
  setLoading: (loading) => set({ loading }),
  setFocus: (focus) => set({ focus }),
  toggle: (i) => {
    const w = get().workspace;
    if (!w) return;
    set({ workspace: { ...w, strategies: w.strategies.map((s, k) => (k === i ? { ...s, visible: !s.visible } : s)) } });
  },
  setView: (view) => set({ view }),
  setHover: (hover) => set({ hover }),
  setTab: (tab) => set({ tab }),
  editStrategy: (i, yaml) => {
    const w = get().workspace;
    if (!w) return;
    set({ workspace: { ...w, strategies: w.strategies.map((s, k) => (k === i ? { ...s, yaml } : s)) } });
    clearTimeout(timer);
    timer = setTimeout(() => get().recompute(), 400);
  },
  addStrategy: (yaml, focus = true) => {
    const w = get().workspace;
    if (!w) return;
    set({ workspace: { ...w, strategies: [...w.strategies, { yaml, visible: true }] }, ...(focus ? { focus: w.strategies.length, tab: 'changes' as Tab } : {}) });
    get().recompute();
  },
  removeStrategy: (i) => {
    const w = get().workspace;
    if (!w) return;
    set({ workspace: { ...w, strategies: w.strategies.filter((_, k) => k !== i) }, focus: 0 });
    get().recompute();
  },
  recompute: () => {
    const w = get().workspace;
    if (!w) return;
    set({ computing: true });
    // let the UI paint "computing" first
    setTimeout(() => {
      const ok: unknown[] = [];
      const strategies = w.strategies.map((s) => {
        try {
          const spec = StrategySpec.parse(parseYaml(s.yaml));
          ok.push(spec);
          return { ...s, error: undefined };
        } catch (e) {
          return { ...s, error: e instanceof Error ? e.message.split('\n').slice(0, 3).join(' ') : String(e) };
        }
      });
      let result: BacktestResult | null = null;
      try {
        result = backtest(w.model, w.dataset, ok, { draws: get().draws });
      } catch (e) {
        // a strategy that names an unknown service: report on that strategy, keep the rest
        const msg = e instanceof Error ? e.message : String(e);
        const bad = strategies.findIndex((s) => msg.includes(`"${strategyName(s.yaml)}"`));
        if (bad >= 0) strategies[bad] = { ...strategies[bad], error: msg };
        const good = strategies.filter((s) => !s.error).map((s) => parseYaml(s.yaml));
        result = backtest(w.model, w.dataset, good, { draws: get().draws });
      }
      set({ result, computing: false, workspace: { ...get().workspace!, strategies } });
    }, 16);
  },
}));
