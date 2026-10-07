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
import { PresentHUD, presentStep } from './ui/PresentHUD';
import { HomeBoard } from './ui/HomeBoard';
import './ui/callout.css';
import { StudioView } from './studio/StudioView';
import { Stage } from './studio/Stage';
import { openFromHash } from './spec/links';
import { writeAutosave } from './sim/designs';
import { saveCurrent } from './ui/DesignMenu';
import { openFile } from './spec/openFile';
import { useState } from 'react';
import type { Aspect } from './sim/store';
import type { ThemeId } from './theme/themes';
import './theme/transit.css';
import './theme/reference.css';
import './theme/neon-chrome.css';

/**
 * Render mode (used by scripts/record.mjs): `?render=1&ep=<id>&aspect=4:5&brand=personal`
 * shows only the stage at its true pixel size and exposes `window.studio` for the recorder.
 */
const params = new URLSearchParams(location.search);
const RENDER = params.get('render') === '1';
if (RENDER) {
  const s = useSim.getState();
  s.setStudio({ aspect: (params.get('aspect') as Aspect) ?? '4:5', brandId: params.get('brand') ?? 'personal' });
  if (params.get('theme')) s.setSetting('theme', params.get('theme') as ThemeId);
  s.setMode('studio');
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

function useSimLoop() {
  useEffect(() => {
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
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
      if (mod && e.key === 's' && s.mode === 'sandbox') {
        e.preventDefault();
        saveCurrent();
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
      if (e.code !== 'Space') return;
      e.preventDefault();
      s.setRunning(!s.running);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

if (!RENDER && location.hash) openFromHash(location.hash);

// autosave the sandbox design (debounced); survives reloads and mode switches
if (!RENDER) {
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
window.addEventListener('hashchange', () => openFromHash(location.hash));

export default function App() {
  const mode = useSim((s) => s.mode);
  const theme = useSim((s) => s.settings.theme);
  const analysisOpen = useSim((s) => s.analysisOpen);
  const auditOpen = useSim((s) => s.auditOpen);
  const specOpen = useSim((s) => s.specOpen);
  const present = useSim((s) => s.present);
  useSimLoop();
  const [dropping, setDropping] = useState(false);
  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  if (RENDER) return <Stage />;

  return (
    <div className={`app ${present ? 'presenting' : ''}`}>
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
        {dropping && <div className="drop-hint">Drop an architecture spec (.yaml / .json) or terraform show -json output</div>}
        {mode === 'home' ? (
          <HomeBoard />
        ) : mode === 'studio' ? (
          <StudioView />
        ) : mode === 'compare' ? (
          <CompareView />
        ) : (
          <ReactFlowProvider>
            <BoardCanvas id="main" padding={present ? { top: '150px', left: '60px', right: '60px', bottom: '140px' } : { top: '60px', left: '270px', right: mode === 'lesson' ? '380px' : mode === 'sandbox' && (auditOpen || analysisOpen || specOpen) ? '450px' : '60px', bottom: '110px' }} />
          </ReactFlowProvider>
        )}
        {mode !== 'studio' && mode !== 'home' && <Palette key={mode} compact={mode === 'compare'} />}
        {mode === 'lesson' && <LessonPanel />}
        {analysisOpen && (mode === 'sandbox' || mode === 'compare') && <AnalysisPanel />}
        {auditOpen && mode === 'sandbox' && <AuditPanel />}
        {specOpen && mode === 'sandbox' && <SpecEditor />}
        {mode !== 'studio' && mode !== 'home' && <ControlBar />}
        <Toasts />
        <CommandPalette />
        {present && mode !== 'studio' && <PresentHUD />}
      </div>
    </div>
  );
}
