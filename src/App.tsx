import { useEffect } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { useSim } from './sim/store';
import { BoardCanvas } from './canvas/BoardCanvas';
import { TopBar } from './ui/TopBar';
import { Palette } from './ui/Palette';
import { LessonPanel } from './ui/LessonPanel';
import { ControlBar } from './ui/ControlBar';
import { Toasts } from './ui/Toasts';
import { CompareView } from './ui/CompareView';
import { AnalysisPanel } from './ui/AnalysisPanel';
import { AuditPanel } from './ui/AuditPanel';
import { CommandPalette } from './ui/CommandPalette';
import { SpecEditor } from './ui/SpecEditor';
import { EnvelopePanel } from './ui/EnvelopePanel';
import { PresentHUD, presentStep } from './ui/PresentHUD';
import { Shortcuts } from './ui/Shortcuts';
import { Embed } from './ui/Embed';
import { HomeBoard } from './ui/HomeBoard';
import { BacktestView } from './backtest-ui/BacktestView';
import { BoardReturn } from './backtest-ui/BoardReturn';
import { CardStage } from './backtest-ui/Card';
import './ui/callout.css';
import { StudioView } from './studio/StudioView';
import { Stage } from './studio/Stage';
import { openFromHash } from './spec/links';
import { loadWorkspaceUrl } from './backtest-ui/workspace';
import { useBacktest } from './backtest-ui/store';
import { decodePayload } from './spec/convert';
import { registerEpisode, type Episode } from './studio/episodes';
import { writeAutosave } from './sim/designs';
import { saveCurrent } from './ui/DesignMenu';
import { openFile } from './spec/openFile';
import { useState } from 'react';
import type { Aspect, Clip, Mode } from './sim/store';
import './theme/reference.css';
import './theme/terminal.css';
import './ui/phone.css';
import { manualClock } from './sim/clock';
import { narrowScreen } from './ui/homeGraphs';

/** phones: no palette on the left, and the lesson is a sheet over the bottom half — fit the board above it
 *  (elsewhere, above the run's timeline and controls) */
const PHONE_PADDING = (mode: Mode) => ({ top: '20px', left: '16px', right: '16px', bottom: `${mode === 'lesson' ? Math.round(window.innerHeight * 0.5) : 136}px` }) as const;


/** what ⌘C / ⌘X copied, and how many times it was pasted (each paste lands a step further) */
let clip: Clip | null = null;
let pastes = 0;

/**
 * Render mode (used by scripts/record.mjs): `?render=1&ep=<id>&aspect=4:5&brand=personal`
 * shows only the stage at its true pixel size and exposes `window.studio` for the recorder.
 */
const params = new URLSearchParams(location.search);
const RENDER = params.get('render') === '1';
const EMBED = params.get('embed') === '1';
/** a backtest Studio card / clip (see src/backtest-ui/Card.tsx) */
const CARD = RENDER && params.has('card');
if (RENDER && !CARD) {
  const s = useSim.getState();
  s.setStudio({ aspect: (params.get('aspect') as Aspect) ?? '4:5', brandId: params.get('brand') ?? 'personal' });
  s.setMode('studio');
  // episodes made in the app travel in the URL (the recorder's browser has no local storage)
  if (params.get('epData')) registerEpisode(decodePayload<Episode>(params.get('epData')!), false);
  if (params.get('ep')) s.loadEpisode(params.get('ep')!);
  (window as unknown as { studio: unknown }).studio = {
    start: () => useSim.getState().setRunning(true),
    state: () => {
      const st = useSim.getState().studio;
      return { t: st.t, fired: st.fired.length, finished: st.finished, done: st.done };
    },
  };
}

// handy for scripting demos from the devtools console
(window as unknown as { sim: typeof useSim }).sim = useSim;
(window as unknown as { backtest: typeof useBacktest }).backtest = useBacktest;

function useSimLoop() {
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest?.('input, select, textarea')) return;
      const s = useSim.getState();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'z' || e.key === 'Z' || e.key === 'y') && (s.mode === 'sandbox' || s.mode === 'compare')) {
        e.preventDefault();
        if (e.key === 'y' || e.shiftKey) s.redo(s.focus);
        else s.undo(s.focus);
        return;
      }
      // copy, paste, duplicate and select all, on the board in focus
      if (mod && !e.shiftKey && (s.mode === 'sandbox' || s.mode === 'compare') && ['c', 'x', 'v', 'd', 'a'].includes(e.key)) {
        if (window.getSelection()?.toString()) return;
        e.preventDefault();
        const b = s.focus;
        if (e.key === 'a') return s.selectAll(b);
        if (e.key === 'v') {
          if (clip) s.paste(b, clip, ++pastes);
          return;
        }
        const c = s.copySelection(b);
        if (!c) return;
        if (e.key === 'd') return s.paste(b, c);
        clip = c;
        pastes = 0;
        if (e.key === 'x') s.removeNodes(b, c.nodes.map((n) => n.id));
        return;
      }
      if (mod && e.key === 's' && s.mode === 'sandbox') {
        e.preventDefault();
        saveCurrent();
        return;
      }
      if (!mod && !e.altKey && (e.key === 'n' || e.key === 'N') && (s.mode === 'sandbox' || s.mode === 'compare')) {
        e.preventDefault();
        s.addNote(s.focus);
        return;
      }
      if (!mod && !e.altKey && (e.key === 'g' || e.key === 'G') && (s.mode === 'sandbox' || s.mode === 'compare')) {
        e.preventDefault();
        s.addSection(s.focus);
        return;
      }
      if (!mod && !e.altKey && (e.key === 'p' || e.key === 'P') && s.mode !== 'studio') {
        s.setPresent(!s.present);
        return;
      }
      if (s.present) {
        if (e.key === 'Escape') {
          s.setPresent(false);
          if (document.fullscreenElement) document.exitFullscreen();
          return;
        }
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          if (!s.scrub) presentStep(e.key === 'ArrowRight' ? 1 : -1);
          return;
        }
        if (e.key === 'f' || e.key === 'F') {
          if (document.fullscreenElement) document.exitFullscreen();
          else document.documentElement.requestFullscreen?.();
          return;
        }
      }
      if (e.code !== 'Space' || manualClock.on) return;
      e.preventDefault();
      s.setRunning(!s.running);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

// the app opens on Live; #backtest, #live, #lessons, #sandbox, #compare and #studio link to a view
const VIEW_HASH: Record<string, Mode> = { '#backtest': 'backtest', '#live': 'home', '#lessons': 'lesson', '#sandbox': 'sandbox', '#compare': 'compare', '#studio': 'studio' };
const openHash = (hash: string) => {
  // #backtest=<url>: an agent's verify_change result, opened on the backtest screen
  if (hash.startsWith('#backtest=')) {
    void loadWorkspaceUrl(decodeURIComponent(hash.slice('#backtest='.length)));
    useSim.getState().setMode('backtest');
    return true;
  }
  // #backtest/review: the Backtest tab on its capacity review
  if (hash === '#backtest/review') {
    useBacktest.getState().setScreen('review');
    useSim.getState().setMode('backtest');
    return true;
  }
  return VIEW_HASH[hash] ? (useSim.getState().setMode(VIEW_HASH[hash]), true) : openFromHash(hash);
};
if (!RENDER && location.hash) openHash(location.hash);
if (EMBED) {
  const s = useSim.getState();
  if (s.mode !== 'sandbox') s.setMode('sandbox');
  s.setSetting('alerts', false);
  s.setTraffic(Number(params.get('rps') ?? 300));
  s.setRunning(true);
}

// autosave the sandbox design (debounced); survives reloads and mode switches
if (!RENDER && !EMBED) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  useSim.subscribe((s, prev) => {
    if (s.mode !== 'sandbox') return;
    const a = s.boards.main;
    const b = prev.boards.main;
    if (a.nodes === b.nodes && a.edges === b.edges && a.title === b.title && s.designId === prev.designId) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const m = useSim.getState().boards.main;
      writeAutosave(m.title, { nodes: m.nodes, edges: m.edges }, useSim.getState().designId ?? undefined);
    }, 500);
  });
}
window.addEventListener('hashchange', () => openHash(location.hash));

export default function App() {
  const mode = useSim((s) => s.mode);
  const analysisOpen = useSim((s) => s.analysisOpen);
  const auditOpen = useSim((s) => s.auditOpen);
  const specOpen = useSim((s) => s.specOpen);
  const envelopeOpen = useSim((s) => s.envelopeOpen);
  const present = useSim((s) => s.present);
  useSimLoop();
  const [dropping, setDropping] = useState(false);
  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files');

  if (CARD) return <CardStage />;
  if (RENDER) return <Stage />;
  if (EMBED) return <Embed />;
  if (mode === 'backtest')
    return (
      <>
        <BacktestView />
        <Toasts />
      </>
    );

  return (
    <div className={`app mode-${mode} ${present ? 'presenting' : ''}`}>
      <TopBar />
      <div
        className="board"
        onDragOver={(e) => {
          if (!hasFiles(e) || mode === 'studio') return;
          e.preventDefault();
          setDropping(true);
        }}
        onDragLeave={(e) => e.currentTarget === e.target && setDropping(false)}
        onDrop={(e) => {
          setDropping(false);
          const f = e.dataTransfer.files?.[0];
          if (!f || mode === 'studio') return;
          e.preventDefault();
          openFile(f);
        }}
      >
        {dropping && <div className="drop-hint">Drop an architecture spec (.yaml / .json), Kubernetes manifests, terraform show -json output — or a traffic CSV (time, req/s) to replay</div>}
        {mode === 'home' ? (
          <HomeBoard />
        ) : mode === 'studio' ? (
          <StudioView />
        ) : mode === 'compare' ? (
          <CompareView />
        ) : (
          <ReactFlowProvider>
            <BoardCanvas id="main" padding={present ? { top: '150px', left: '60px', right: '60px', bottom: '140px' } : narrowScreen() ? PHONE_PADDING(mode) : { top: '60px', left: '270px', right: mode === 'lesson' ? '380px' : mode === 'sandbox' && (auditOpen || analysisOpen || specOpen || envelopeOpen) ? '450px' : '60px', bottom: '110px' }} />
          </ReactFlowProvider>
        )}
        {mode !== 'studio' && mode !== 'home' && <Palette key={mode} compact={mode === 'compare'} />}
        {mode === 'lesson' && <LessonPanel />}
        {analysisOpen && (mode === 'sandbox' || mode === 'compare') && <AnalysisPanel />}
        {auditOpen && mode === 'sandbox' && <AuditPanel />}
        {specOpen && mode === 'sandbox' && <SpecEditor />}
        {envelopeOpen && mode === 'sandbox' && <EnvelopePanel />}
        {mode !== 'studio' && mode !== 'home' && <ControlBar />}
        {mode === 'sandbox' && !present && <BoardReturn />}
        <Toasts />
        <CommandPalette />
        {!present && <Shortcuts />}
        {present && mode !== 'studio' && <PresentHUD />}
      </div>
    </div>
  );
}
