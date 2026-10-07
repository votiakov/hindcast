import { create } from 'zustand';
import { addEdge, applyEdgeChanges, applyNodeChanges, type Connection, type EdgeChange, type NodeChange, type XYPosition } from '@xyflow/react';
import { KINDS, defaultData, instancesUp, isSystem, type AppNode, type Kind, type SystemEdge, type SystemNode, type SystemNodeData, type ZoneData } from './catalog';
import { applyAction } from './actions';
import { DEFAULT_ENGINE_CONFIG, Engine, type EdgeStats, type GlobalStats, type NodeStats, type SimEvent } from './engine';
import { lesson1 } from '../lessons/lesson1';
import { goalStart, trafficAt, type Lesson } from '../lessons/types';
import { lessonById } from '../lessons';
import { SCENARIOS, findScenario, scenarioDuration, scenarioTraffic, type Scenario, type ScenarioAction } from '../scenarios/scenarios';
import type { Graph } from '../scenarios/build';
import { HOME_GRAPHS } from '../ui/homeGraphs';
import type { ThemeId } from '../theme/themes';
import { setPricing, type PricingId } from './pricing';
import { EPISODES, OUTRO_SECONDS, episodeById, episodeDuration, episodeTraffic, type BeatAction, type StageBoard } from '../studio/episodes';

export type Mode = 'home' | 'lesson' | 'sandbox' | 'compare' | 'studio';
export type Pattern = 'steady' | 'diurnal' | 'spiky' | 'ramp';
export type BoardId = 'main' | 'A' | 'B';

export interface Settings {
  theme: ThemeId;
  /** cost model: teaching defaults or a cited real-cloud profile */
  pricing: PricingId;
  /** plain-English callouts on components under stress */
  explain: boolean;
  /** show $ everywhere and enforce budget goals */
  cost: boolean;
  /** animated request particles on edges */
  particles: boolean;
  /** small random wobble on traffic */
  jitter: boolean;
  /** fire-and-forget toasts for overloads / recoveries */
  alerts: boolean;
  autoFailover: boolean;
  failoverS: number;
  coldStarts: boolean;
  timeoutS: number;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'neon',
  pricing: 'illustrative',
  explain: true,
  cost: true,
  particles: true,
  jitter: true,
  alerts: true,
  autoFailover: true,
  failoverS: DEFAULT_ENGINE_CONFIG.failoverS ?? 3,
  coldStarts: true,
  timeoutS: DEFAULT_ENGINE_CONFIG.timeoutS,
};

export interface Toast {
  id: number;
  tone: 'bad' | 'good' | 'info';
  text: string;
}

export interface LessonState {
  lesson: Lesson;
  stepIndex: number;
  stepT: number;
  holdT: number;
  failT: number;
  passed: boolean;
  firedChaos: number[];
  finished: boolean;
}

export interface CompareState {
  /** null = free play with manual traffic controls */
  scenarioId: string | null;
  t: number;
  fired: number[];
  finished: boolean;
}

export interface StudioState {
  episodeId: string;
  t: number;
  fired: number[];
  /** timeline over — outro card is showing */
  finished: boolean;
  /** outro done — safe to stop recording */
  done: boolean;
  aspect: Aspect;
  brandId: string;
  camera: Record<StageBoard, { nodes: string[] | null; seq: number }>;
}

export type Aspect = '4:5' | '1:1' | '9:16' | '16:9';

export interface Board {
  id: BoardId;
  title: string;
  nodes: AppNode[];
  edges: SystemEdge[];
  nodeStats: Record<string, NodeStats>;
  edgeStats: Record<string, EdgeStats>;
  global: GlobalStats;
  /** bumps when the graph is replaced, so the canvas re-fits */
  version: number;
}

interface State {
  mode: Mode;
  boards: Record<BoardId, Board>;
  focus: BoardId;
  running: boolean;
  speed: number;
  simT: number;
  traffic: number;
  readRatio: number;
  pattern: Pattern;
  spikeUntil: number;
  toasts: Toast[];
  lesson: LessonState;
  compare: CompareState;
  settings: Settings;
  studio: StudioState;
  analysisOpen: boolean;
  setAnalysisOpen: (open: boolean) => void;

  loadEpisode: (id: string) => void;
  setStudio: (p: Partial<Pick<StudioState, 'aspect' | 'brandId'>>) => void;
  replaceGraph: (b: BoardId, g: Graph, title?: string) => void;
  setSetting: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  onNodesChange: (b: BoardId, c: NodeChange<AppNode>[]) => void;
  onEdgesChange: (b: BoardId, c: EdgeChange<SystemEdge>[]) => void;
  onConnect: (b: BoardId, c: Connection) => void;
  addNode: (b: BoardId, kind: Kind, pos: XYPosition) => void;
  addZone: (b: BoardId, pos: XYPosition) => void;
  updateNode: (b: BoardId, id: string, patch: Partial<SystemNodeData>) => void;
  updateZone: (b: BoardId, id: string, patch: Partial<ZoneData>) => void;
  moveNodes: (b: BoardId, positions: Record<string, XYPosition>) => void;
  removeNode: (b: BoardId, id: string) => void;
  removeEdge: (b: BoardId, id: string) => void;
  killNode: (b: BoardId, id: string) => void;
  reviveNode: (b: BoardId, id: string) => void;
  setZoneFailed: (b: BoardId, id: string, failed: boolean) => void;
  apply: (b: BoardId, a: ScenarioAction) => string | null;
  loadGraph: (b: BoardId, g: Graph, title?: string) => void;
  setFocus: (b: BoardId) => void;
  /** switch mode keeping the current main board (home → sandbox) */
  keepBoardAs: (mode: Mode) => void;
  setRunning: (r: boolean) => void;
  setSpeed: (s: number) => void;
  setTraffic: (t: number) => void;
  setReadRatio: (r: number) => void;
  setPattern: (p: Pattern) => void;
  spike: () => void;
  chaosAll: (a: ScenarioAction, label: string) => void;
  setMode: (m: Mode) => void;
  reset: () => void;
  nextStep: () => void;
  pickLesson: (id: string) => void;
  pickScenario: (id: string | null) => void;
  toast: (tone: Toast['tone'], text: string) => void;
  tick: (realDt: number) => void;
}

export const engines: Record<BoardId, Engine> = { main: new Engine(), A: new Engine(), B: new Engine() };
let toastSeq = 1;
const emptyGlobal: GlobalStats = { t: 0, rps: 0, errorRate: 0, p99: 0, cost: 0, history: [] };
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

export const activeBoards = (mode: Mode, episodeId?: string): BoardId[] =>
  mode === 'compare' || (mode === 'studio' && episodeById(episodeId ?? '').layout === 'compare') ? ['A', 'B'] : ['main'];
export const systemNodes = (nodes: AppNode[]) => nodes.filter(isSystem);
export const scenarioById = (id: string | null): Scenario | undefined => findScenario(id);

function freshLesson(lesson: Lesson): LessonState {
  return { lesson, stepIndex: 0, stepT: 0, holdT: 0, failT: 0, passed: false, firedChaos: [], finished: false };
}

function freshStudio(episodeId: string, aspect: Aspect, brandId: string): StudioState {
  const cam = { nodes: null, seq: 0 };
  return { episodeId, t: 0, fired: [], finished: false, done: false, aspect, brandId, camera: { main: cam, A: cam, B: cam } };
}

function makeBoard(id: BoardId, title: string, g: Graph, version = 0): Board {
  engines[id].reset();
  return { id, title, ...clone(g), nodeStats: {}, edgeStats: {}, global: emptyGlobal, version };
}

function nextName(nodes: AppNode[], kind: Kind): string {
  const prefix = KINDS[kind].prefix;
  let i = 1;
  while (nodes.some((n) => isSystem(n) && n.data.name === `${prefix}-${i}`)) i++;
  return `${prefix}-${i}`;
}

function patternMultiplier(p: Pattern, t: number): number {
  switch (p) {
    case 'steady':
      return 1;
    case 'diurnal':
      return 0.55 + 0.45 * Math.cos((t / 40) * Math.PI * 2);
    case 'spiky':
      return t % 20 < 3 ? 2.5 : 1;
    case 'ramp':
      return Math.min(3, 0.3 + t / 30);
  }
}

/** a node counts as inside a zone when its centre is */
function nodesInZone(nodes: AppNode[], zoneId: string): string[] {
  const z = nodes.find((n) => n.id === zoneId);
  if (!z) return [];
  const w = z.width ?? z.measured?.width ?? 0;
  const h = z.height ?? z.measured?.height ?? 0;
  return nodes
    .filter((n) => {
      if (!isSystem(n)) return false;
      const cx = n.position.x + (n.measured?.width ?? 230) / 2;
      const cy = n.position.y + (n.measured?.height ?? 150) / 2;
      return cx >= z.position.x && cx <= z.position.x + w && cy >= z.position.y && cy <= z.position.y + h;
    })
    .map((n) => n.id);
}

function initialCompare(scenarioId: string | null): Pick<State, 'compare'> & { A: Board; B: Board } {
  const sc = scenarioById(scenarioId) ?? SCENARIOS[0];
  return {
    compare: { scenarioId: sc.id, t: 0, fired: [], finished: false },
    A: makeBoard('A', sc.a.title, sc.a.graph),
    B: makeBoard('B', sc.b.title, sc.b.graph),
  };
}

export const useSim = create<State>()((set, get) => {
  const board = (b: BoardId) => get().boards[b];
  const patch = (b: BoardId, p: Partial<Board>) => set((s) => ({ boards: { ...s.boards, [b]: { ...s.boards[b], ...p } } }));
  const setNodes = (b: BoardId, fn: (nodes: AppNode[]) => AppNode[]) => patch(b, { nodes: fn(board(b).nodes) });
  const runBeatAction = (b: BoardId, a: BeatAction) => (a.type === 'graph' ? get().replaceGraph(b, a.graph, a.title) : get().apply(b, a));
  const s0 = get;
  const label = (b: BoardId) => (get().mode === 'compare' ? `[${board(b).title}] ` : '');

  const init = initialCompare(null);
  return {
    mode: 'home',
    boards: {
      main: makeBoard('main', 'Main', HOME_GRAPHS[0]),
      A: init.A,
      B: init.B,
    },
    focus: 'main',
    running: true,
    speed: 1,
    simT: 0,
    traffic: 60,
    readRatio: 0.8,
    pattern: 'steady',
    spikeUntil: 0,
    toasts: [],
    lesson: freshLesson(lesson1),
    compare: init.compare,
    settings: DEFAULT_SETTINGS,
    analysisOpen: false,
    setAnalysisOpen: (analysisOpen) => set({ analysisOpen }),
    studio: freshStudio(EPISODES[0].id, '4:5', 'personal'),

    loadEpisode: (id) => {
      const ep = episodeById(id);
      const st = get().studio;
      set((s) => ({
        running: false,
        simT: 0,
        readRatio: ep.readRatio,
        studio: freshStudio(ep.id, st.aspect, st.brandId),
        boards:
          ep.layout === 'single'
            ? { ...s.boards, main: makeBoard('main', 'Main', ep.main!, s.boards.main.version + 1) }
            : { ...s.boards, A: makeBoard('A', ep.a!.title, ep.a!.graph, s.boards.A.version + 1), B: makeBoard('B', ep.b!.title, ep.b!.graph, s.boards.B.version + 1) },
      }));
    },
    setStudio: (p) => set({ studio: { ...get().studio, ...p } }),
    replaceGraph: (b, g, title) => {
      // keeps engine state for nodes that survive (same id), so the fix happens "live"
      const c = clone(g);
      patch(b, { nodes: c.nodes, edges: c.edges, title: title ?? board(b).title, version: board(b).version + 1 });
    },

    setSetting: (k, v) => {
      if (k === 'pricing') setPricing(v as PricingId);
      set({ settings: { ...get().settings, [k]: v } });
    },

    onNodesChange: (b, c) => patch(b, { nodes: applyNodeChanges(c, board(b).nodes) }),
    onEdgesChange: (b, c) => patch(b, { edges: applyEdgeChanges(c, board(b).edges) }),
    onConnect: (b, c) => {
      const { edges, nodes } = board(b);
      if (c.source === c.target) return;
      if (nodes.find((n) => n.id === c.source)?.type === 'zone' || nodes.find((n) => n.id === c.target)?.type === 'zone') return;
      if (edges.some((e) => e.source === c.source && e.target === c.target)) return;
      patch(b, { edges: addEdge({ ...c, type: 'flow', id: `e-${c.source}-${c.target}-${Date.now()}` }, edges) });
    },
    addNode: (b, kind, position) => {
      const nodes = board(b).nodes;
      const name = nextName(nodes, kind);
      const node: SystemNode = { id: `${name}-${Date.now()}`, type: 'system', position, data: defaultData(kind, name), selected: true };
      patch(b, { nodes: [...nodes.map((n) => ({ ...n, selected: false })), node] });
    },
    addZone: (b, position) => {
      const nodes = board(b).nodes;
      const n = nodes.filter((x) => x.type === 'zone').length + 1;
      const zone: AppNode = { id: `zone-${Date.now()}`, type: 'zone', position, width: 560, height: 380, zIndex: -1, data: { label: `zone-${n}` } };
      patch(b, { nodes: [zone, ...nodes] });
    },
    updateNode: (b, id, p) => setNodes(b, (nodes) => nodes.map((n) => (n.id === id && isSystem(n) ? { ...n, data: { ...n.data, ...p } } : n))),
    updateZone: (b, id, p) => setNodes(b, (nodes) => nodes.map((n) => (n.id === id && n.type === 'zone' ? ({ ...n, data: { ...n.data, ...p } } as AppNode) : n))),
    moveNodes: (b, positions) => setNodes(b, (nodes) => nodes.map((n) => (positions[n.id] ? { ...n, position: positions[n.id] } : n))),
    removeNode: (b, id) => patch(b, { nodes: board(b).nodes.filter((n) => n.id !== id), edges: board(b).edges.filter((e) => e.source !== id && e.target !== id) }),
    removeEdge: (b, id) => patch(b, { edges: board(b).edges.filter((e) => e.id !== id) }),
    killNode: (b, id) => {
      const n = board(b).nodes.find((x) => x.id === id);
      if (!n || !isSystem(n)) return;
      if (KINDS[n.data.kind].scalable && instancesUp(n.data) > 1) {
        get().updateNode(b, id, { down: (n.data.down ?? 0) + 1 });
        get().toast('bad', `${label(b)}💥 ${n.data.name}: 1 instance down`);
      } else {
        get().updateNode(b, id, { alive: false });
        get().toast('bad', `${label(b)}💀 ${n.data.name} is DOWN`);
      }
    },
    reviveNode: (b, id) => {
      const n = board(b).nodes.find((x) => x.id === id);
      if (!n || !isSystem(n)) return;
      get().updateNode(b, id, { alive: true, down: 0 });
    },
    setZoneFailed: (b, id, failed) => {
      const inside = new Set(nodesInZone(board(b).nodes, id));
      setNodes(b, (nodes) =>
        nodes.map((n) => {
          if (n.id === id) return { ...n, data: { ...n.data, failed } } as AppNode;
          if (inside.has(n.id) && isSystem(n)) return { ...n, data: { ...n.data, alive: !failed, down: 0 } };
          return n;
        }),
      );
    },
    apply: (b, a) => {
      const { nodes, nodeStats } = board(b);
      const r = applyAction(nodes, a, { inRps: (id) => nodeStats[id]?.inRps ?? 0, zoneMembers: (zid) => nodesInZone(nodes, zid) });
      patch(b, { nodes: r.nodes });
      // zone/global notes come from the caller's own message; per-node ones become toasts
      if (a.type === 'kill' || a.type === 'kill-id') for (const n of r.notes) get().toast(n.tone, `${label(b)}${n.text}`);
      return r.target;
    },
    loadGraph: (b, g, title) => patch(b, makeBoard(b, title ?? board(b).title, g, board(b).version + 1)),
    keepBoardAs: (mode) => set({ mode, focus: 'main' }),
    setFocus: (focus) => get().focus !== focus && set({ focus }),
    setRunning: (running) => {
      const s = get();
      if (running && ((s.mode === 'compare' && s.compare.finished) || (s.mode === 'studio' && s.studio.done))) get().reset();
      set({ running });
    },
    setSpeed: (speed) => set({ speed }),
    setTraffic: (traffic) => set({ traffic }),
    setReadRatio: (readRatio) => set({ readRatio }),
    setPattern: (pattern) => set({ pattern }),
    spike: () => {
      set({ spikeUntil: get().simT + 8 });
      get().toast('info', '📈 Traffic spike ×3 for 8s');
    },
    chaosAll: (a, what) => {
      let hit = false;
      for (const b of activeBoards(get().mode, get().studio.episodeId)) hit = get().apply(b, a) !== null || hit;
      if (!hit) get().toast('info', `No live ${what} to kill`);
    },
    setMode: (mode) => {
      const focus = mode === 'compare' ? 'A' : 'main';
      if (mode === 'home') {
        engines.main.reset();
        set((s) => ({ mode, focus, running: true, analysisOpen: false, simT: 0, traffic: 60, pattern: 'steady', readRatio: 0.8, spikeUntil: 0, boards: { ...s.boards, main: makeBoard('main', 'Main', HOME_GRAPHS[0], s.boards.main.version + 1) } }));
      } else if (mode === 'studio') {
        set({ mode, focus });
        get().loadEpisode(get().studio.episodeId);
      } else if (mode === 'compare') {
        const init = initialCompare(get().compare.scenarioId);
        set((s) => ({ mode, focus, running: false, simT: 0, spikeUntil: 0, compare: init.compare, boards: { ...s.boards, A: init.A, B: init.B } }));
      } else {
        const lesson = mode === 'lesson' ? s0().lesson.lesson : lesson1;
        set((s) => ({ mode, focus, running: false, simT: 0, spikeUntil: 0, readRatio: lesson.readRatio ?? 0.8, lesson: freshLesson(lesson), boards: { ...s.boards, main: makeBoard('main', 'Main', lesson.initial, s.boards.main.version + 1) } }));
      }
    },
    reset: () => {
      const s = get();
      if (s.mode === 'studio') get().loadEpisode(s.studio.episodeId);
      else if (s.mode === 'compare' && s.compare.scenarioId) get().pickScenario(s.compare.scenarioId);
      else if (s.mode === 'compare') {
        for (const b of ['A', 'B'] as BoardId[]) {
          engines[b].reset();
          get().apply(b, { type: 'revive-all' });
        }
        set({ simT: 0, running: false });
      } else get().setMode(s.mode);
    },
    pickLesson: (id) => {
      const lesson = lessonById(id);
      set((s) => ({ running: false, simT: 0, readRatio: lesson.readRatio ?? 0.8, lesson: freshLesson(lesson), boards: { ...s.boards, main: makeBoard('main', 'Main', lesson.initial, s.boards.main.version + 1) } }));
      engines.main.reset();
    },
    nextStep: () => {
      const ls = get().lesson;
      if (ls.stepIndex + 1 >= ls.lesson.steps.length) {
        set({ lesson: { ...ls, finished: true }, running: false });
        return;
      }
      set({ lesson: { ...ls, stepIndex: ls.stepIndex + 1, stepT: 0, holdT: 0, failT: 0, passed: false, firedChaos: [] } });
    },
    pickScenario: (id) => {
      if (id === null) {
        set({ compare: { scenarioId: null, t: 0, fired: [], finished: false }, running: false });
        return;
      }
      const sc = scenarioById(id)!;
      set((s) => ({
        running: false,
        simT: 0,
        readRatio: sc.readRatio,
        compare: { scenarioId: id, t: 0, fired: [], finished: false },
        boards: { ...s.boards, A: makeBoard('A', sc.a.title, sc.a.graph, s.boards.A.version + 1), B: makeBoard('B', sc.b.title, sc.b.graph, s.boards.B.version + 1) },
      }));
    },
    toast: (tone, text) => {
      const id = toastSeq++;
      set({ toasts: [...get().toasts, { id, tone, text }].slice(-5) });
      setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), 4200);
    },

    tick: (realDt) => {
      const s = get();
      if (!s.running) return;
      const dt = 0.05;
      const steps = Math.max(1, Math.round((realDt * s.speed) / dt));
      const boards = activeBoards(s.mode, s.studio.episodeId);
      const ep = s.mode === 'studio' ? episodeById(s.studio.episodeId) : undefined;
      let studio = s.studio;
      const events: { b: BoardId; e: SimEvent }[] = [];
      let ls = s.lesson;
      let cmp = s.compare;
      let simT = s.simT;
      const sc = s.mode === 'compare' ? scenarioById(cmp.scenarioId) : undefined;
      const cfg = {
        timeoutS: s.settings.timeoutS,
        failoverS: s.settings.autoFailover ? s.settings.failoverS : null,
        coldStartMs: s.settings.coldStarts ? DEFAULT_ENGINE_CONFIG.coldStartMs : 0,
      };

      for (let i = 0; i < steps; i++) {
        simT += dt;
        let rps: number;
        if (s.mode === 'lesson' && !ls.finished) {
          const step = ls.lesson.steps[ls.stepIndex];
          rps = trafficAt(step, ls.stepT);
          ls = { ...ls, stepT: ls.stepT + dt };
          for (const [ci, c] of (step.chaos ?? []).entries()) {
            if (!ls.firedChaos.includes(ci) && ls.stepT >= c.at) {
              ls = { ...ls, firedChaos: [...ls.firedChaos, ci] };
              get().toast('bad', `🔥 ${c.message}`);
              get().apply('main', c.action);
            }
          }
        } else if (ep) {
          rps = episodeTraffic(ep, studio.t);
          studio = { ...studio, t: studio.t + dt };
          for (const [bi, beat] of ep.beats.entries()) {
            if (studio.fired.includes(bi) || studio.t < beat.at) continue;
            studio = { ...studio, fired: [...studio.fired, bi] };
            for (const { board: b, action } of beat.do ?? []) runBeatAction(b, action);
            if (beat.focus) {
              const f = beat.focus;
              studio = { ...studio, camera: { ...studio.camera, [f.board]: { nodes: f.nodes, seq: studio.camera[f.board].seq + 1 } } };
            }
          }
          const dur = episodeDuration(ep);
          if (!studio.finished && studio.t >= dur) studio = { ...studio, finished: true };
          if (studio.t >= dur + OUTRO_SECONDS) studio = { ...studio, done: true };
        } else if (sc && !cmp.finished) {
          rps = scenarioTraffic(sc, cmp.t);
          cmp = { ...cmp, t: cmp.t + dt };
          for (const [ei, ev] of sc.events.entries()) {
            if (!cmp.fired.includes(ei) && cmp.t >= ev.at) {
              cmp = { ...cmp, fired: [...cmp.fired, ei] };
              get().toast('info', ev.message);
              if (ev.a) get().apply('A', ev.a);
              if (ev.b) get().apply('B', ev.b);
            }
          }
        } else {
          rps = s.traffic * patternMultiplier(s.pattern, simT) * (simT < s.spikeUntil ? 3 : 1);
        }
        // shared noise so both sides of a comparison see identical traffic
        if (s.settings.jitter) rps *= 1 + 0.05 * Math.sin(simT * 1.7) + 0.04 * (Math.random() - 0.5);

        for (const b of boards) {
          const { nodes, edges } = get().boards[b];
          for (const e of engines[b].step(systemNodes(nodes), edges, rps, s.readRatio, dt, cfg)) events.push({ b, e });
        }

        if (s.mode === 'lesson' && !ls.finished && !ls.passed) {
          const step = ls.lesson.steps[ls.stepIndex];
          const g = engines.main.snapshot([], []).global;
          if (step.goal && ls.stepT >= goalStart(step)) {
            const ok =
              g.errorRate <= step.goal.maxErrorRate &&
              g.p99 <= step.goal.maxP99 &&
              (step.goal.maxCost === undefined || !s.settings.cost || g.cost <= step.goal.maxCost) &&
              g.rps > 0;
            ls = ok ? { ...ls, holdT: ls.holdT + dt } : { ...ls, holdT: 0, failT: ls.failT + dt };
            if (ls.holdT >= step.goal.holdSeconds) {
              ls = { ...ls, passed: true };
              get().toast('good', `🏆 Objective complete: ${step.title}`);
            }
          } else if (step.goal && (g.errorRate > step.goal.maxErrorRate || g.p99 > step.goal.maxP99)) {
            ls = { ...ls, failT: ls.failT + dt };
          }
        }
        if (sc && !cmp.finished && cmp.t >= scenarioDuration(sc)) {
          cmp = { ...cmp, finished: true };
          break;
        }
        if (studio.done) break;
      }

      for (const { b, e } of s.settings.alerts && s.mode !== 'studio' ? events : []) {
        if (e.kind === 'overload') get().toast('bad', `${label(b)}🔥 ${e.name} overloaded — dropping requests`);
        if (e.kind === 'recovered') get().toast('good', `${label(b)}✅ ${e.name} recovered`);
        if (e.kind === 'failover') get().toast('good', `${label(b)}🔁 ${e.name}: replica promoted to primary`);
        if (e.kind === 'breaker-open') get().toast('info', `${label(b)}⛔ ${e.name}: circuit breaker OPEN`);
        if (e.kind === 'breaker-closed') get().toast('good', `${label(b)}✅ ${e.name}: circuit breaker closed`);
      }
      const next = { ...get().boards };
      for (const b of boards) {
        const { nodes, edges } = next[b];
        next[b] = { ...next[b], ...engines[b].snapshot(systemNodes(nodes), edges) };
      }
      set({ boards: next, lesson: ls, compare: cmp, studio, simT, running: (cmp.finished && sc) || studio.done ? false : get().running });
    },
  };
});
