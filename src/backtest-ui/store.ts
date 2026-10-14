import { create } from 'zustand';
import { parse as parseYaml } from 'yaml';
import type { Dataset } from '../backtest/dataset';
import type { Model } from '../backtest/model';
import { backtest, type BacktestResult } from '../backtest/backtest';
import { StrategySpec } from '../backtest/strategy';
import { backtestInWorkers, Superseded } from './pool';
import type { ArchitectureSpec } from '../spec/schema';
import type { Fault } from '../backtest/engine';
import type { Outage } from '../backtest/outages';

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
  /** a public-outage replay against this workspace's model */
  outage?: { outage: Outage; faults: Fault[]; roles: Record<string, string[]>; warnings: string[]; baseRps: number; parent: Workspace; /** replayed over the workspace's own history (a node loss), not a synthetic day */ ownHistory?: boolean; /** what happened when it was done for real, over the as-built history */ measured?: { minutesOutOfSlo: number; failedRequests: number } };
  /** node failures recorded for real (a Kubernetes reference) */
  nodeLosses?: { node: string; atS: number; pods: Record<string, Record<string, number>>; measured: { minutesOutOfSlo: number; failedRequests: number } }[];
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
  /** the history replayed at this multiple of its load (1 = as recorded) */
  load: number;
  setLoad: (x: number) => void;
  /** the board was opened from this backtest: edits on it can come back as a strategy */
  origin: { spec: ArchitectureSpec; label: string } | null;
  setOrigin: (o: { spec: ArchitectureSpec; label: string } | null) => void;
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
  load: 1,
  setLoad: (load) => {
    set({ load });
    get().recompute();
  },
  origin: null,
  setOrigin: (origin) => set({ origin }),
  setWorkspace: (w) => {
    set({ workspace: w, focus: 0, view: null, hover: null, result: null, ...(w.outage ? {} : { load: 1 }) });
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
    const ok: unknown[] = [];
    const okIndex: number[] = [];
    const strategies = w.strategies.map((s, i) => {
      try {
        const spec = StrategySpec.parse(parseYaml(s.yaml));
        ok.push(spec);
        okIndex.push(i);
        return { ...s, error: undefined };
      } catch (e) {
        return { ...s, error: e instanceof Error ? e.message.split('\n').slice(0, 3).join(' ') : String(e) };
      }
    });
    const load = get().load;
    const opts = { draws: get().draws, ...(w.outage ? { faults: w.outage.faults, ...(w.outage.ownHistory ? {} : { observed: false }) } : {}), ...(load !== 1 && !w.outage ? { load: { scale: load } } : {}) };
    const done = (result: BacktestResult, errors: Map<number, string>) => {
      // a strategy the model could not apply (an unknown service, say): report it on that strategy
      for (const [k, msg] of errors) strategies[okIndex[k]] = { ...strategies[okIndex[k]], error: msg };
      if (get().workspace?.id !== w.id) return;
      set({ result, computing: false, workspace: { ...get().workspace!, strategies } });
    };
    if (typeof Worker === 'undefined') {
      // no workers (tests, very old browsers): on this thread, after the UI painted "computing"
      setTimeout(() => done(backtest(w.model, w.dataset, ok, opts), new Map()), 16);
      return;
    }
    backtestInWorkers(w.model, w.dataset, ok, opts).then(
      ({ result, errors }) => done(result, errors),
      (e) => {
        if (e instanceof Superseded) return;
        set({ computing: false });
        const msg = `The backtest failed: ${e instanceof Error ? e.message : String(e)}`;
        void import('../sim/store').then(({ useSim }) => useSim.getState().toast('bad', msg));
      },
    );
  },
}));
