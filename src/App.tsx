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
import { HomeBoard } from './ui/HomeBoard';
import './ui/callout.css';
import { StudioView } from './studio/StudioView';
import { Stage } from './studio/Stage';
import { openFromHash } from './spec/links';
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
      if (e.code !== 'Space' || (e.target as HTMLElement).closest('input, select, textarea')) return;
      e.preventDefault();
      const s = useSim.getState();
      s.setRunning(!s.running);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

if (!RENDER && location.hash) openFromHash(location.hash);
window.addEventListener('hashchange', () => openFromHash(location.hash));

export default function App() {
  const mode = useSim((s) => s.mode);
  const theme = useSim((s) => s.settings.theme);
  const analysisOpen = useSim((s) => s.analysisOpen);
  useSimLoop();
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  if (RENDER) return <Stage />;

  return (
    <div className="app">
      <TopBar />
      <div className="board">
        {mode === 'home' ? (
          <HomeBoard />
        ) : mode === 'studio' ? (
          <StudioView />
        ) : mode === 'compare' ? (
          <CompareView />
        ) : (
          <ReactFlowProvider>
            <BoardCanvas id="main" padding={{ top: '60px', left: '270px', right: mode === 'lesson' ? '380px' : '60px', bottom: '110px' }} />
          </ReactFlowProvider>
        )}
        {mode !== 'studio' && mode !== 'home' && <Palette key={mode} compact={mode === 'compare'} />}
        {mode === 'lesson' && <LessonPanel />}
        {analysisOpen && (mode === 'sandbox' || mode === 'compare') && <AnalysisPanel />}
        {mode !== 'studio' && mode !== 'home' && <ControlBar />}
        <Toasts />
      </div>
    </div>
  );
}
