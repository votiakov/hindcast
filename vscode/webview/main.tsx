import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import '../../src/styles.css';
import '../../src/theme/reference.css';
import '../../src/theme/terminal.css';
import { Embed } from '../../src/ui/Embed';
import { useSim } from '../../src/sim/store';
import { manualClock } from '../../src/sim/clock';
// the engine straight from its module: one copy of the .wasm inlined (native.ts would add a second for Node)
import initEngine from '../../src/backtest/wasm/hindcast_engine.js';
import { engineFailed } from '../../src/engineFailed';
import { ArchitectureSpec } from '../../src/spec/schema';
import { mergeSpecIntoGraph } from '../../src/spec/convert';
import { openPayload } from '../../src/spec/links';
import { isSystem } from '../../src/sim/catalog';
import './vscode.css';

/**
 * The VS Code webview: the embed board, fed by the extension. Messages in: `{ type: 'spec', value, rps? }`
 * on every (debounced) edit. Messages out: `ready`, `board` (what it shows, after each spec), `select`
 * (a component clicked on the board, to jump to its line) and `audit`.
 */
// acquired once, by the extension's first script (it reports errors before this module runs)
const host = (window as unknown as { hindcastHost: { postMessage(m: unknown): void } }).hindcastHost;

let stale: string | null = null;
const listeners = new Set<() => void>();
const setStale = (s: string | null) => {
  stale = s;
  listeners.forEach((l) => l());
};

let opened = false;
function apply(value: unknown, rps?: number) {
  const parsed = ArchitectureSpec.safeParse(value);
  if (!parsed.success) setStale('the file does not parse as a spec: the board shows the last version that did');
  else {
    setStale(null);
    const s = useSim.getState();
    if (!opened) {
      opened = openPayload({ spec: value });
      s.setSetting('alerts', false);
      if (rps) s.setTraffic(rps);
      s.setRunning(true);
    } else {
      // keep the layout and the running state; only what the file changed moves
      const merged = mergeSpecIntoGraph(parsed.data, s.boards.main);
      s.setGraph('main', merged.nodes, merged.edges, parsed.data.name);
    }
  }
  const m = useSim.getState().boards.main;
  host.postMessage({ type: 'board', title: m.title, components: m.nodes.filter(isSystem).map((n) => n.id), stale: stale !== null });
}

window.addEventListener('message', (e: MessageEvent) => {
  const m = e.data as { type?: string; value?: unknown; rps?: number };
  if (m?.type === 'spec') apply(m.value, m.rps);
});

// a single component selected on the board: the editor jumps to it
let lastSelected: string | null = null;
useSim.subscribe((s, prev) => {
  if (s.boards.main.nodes === prev.boards.main.nodes) return;
  const sel = s.boards.main.nodes.filter((n) => isSystem(n) && n.selected);
  const id = sel.length === 1 ? sel[0].id : null;
  if (id && id !== lastSelected) host.postMessage({ type: 'select', id });
  lastSelected = id;
});

function useTick() {
  useEffect(() => {
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      if (manualClock.on) return void (last = now);
      useSim.getState().tick(Math.min(0.25, (now - last) / 1000));
      last = now;
    }, 50);
    return () => clearInterval(id);
  }, []);
}

function Board() {
  useTick();
  const [, redraw] = useState(0);
  useEffect(() => {
    const l = () => redraw((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return (
    <>
      <Embed action={{ label: 'Audit', title: 'Run the failure audit on this design', run: () => host.postMessage({ type: 'audit' }) }} />
      {stale && <div className="vsc-stale">{stale}</div>}
    </>
  );
}

const root = createRoot(document.getElementById('root')!);
initEngine().then(
  () => {
    root.render(
      <StrictMode>
        <Board />
      </StrictMode>,
    );
    host.postMessage({ type: 'ready' });
  },
  (e: unknown) => {
    host.postMessage({ type: 'error', message: `engine: ${e instanceof Error ? e.message : String(e)}` });
    root.render(engineFailed(e));
  },
);
