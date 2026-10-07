import { useLayoutEffect, useRef, useState } from 'react';
import { Clapperboard, Copy, Pause, Play, RotateCcw } from 'lucide-react';
import { useSim, type Aspect } from '../sim/store';
import { episodeById, episodeDuration, isCustomEpisode, listEpisodes, OUTRO_SECONDS } from './episodes';
import { BRANDS } from './brands';
import { ASPECTS, Stage } from './Stage';
import { THEMES } from '../theme/themes';

function useFitScale(w: number, h: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setScale(Math.min((r.width - 40) / w, (r.height - 40) / h));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [w, h]);
  return { ref, scale };
}

export function StudioView() {
  const studio = useSim((s) => s.studio);
  const running = useSim((s) => s.running);
  const theme = useSim((s) => s.settings.theme);
  const setSetting = useSim((s) => s.setSetting);
  const { loadEpisode, setStudio, setRunning, reset, toast } = useSim.getState();
  const { w, h } = ASPECTS[studio.aspect];
  const { ref, scale } = useFitScale(w, h);
  const ep = episodeById(studio.episodeId);
  const custom = isCustomEpisode(studio.episodeId);
  const cmd = `npm run record -- ${custom ? `--ep-file ${studio.episodeId}.json` : studio.episodeId} --aspect ${studio.aspect} --brand ${studio.brandId} --theme ${theme}`;

  return (
    <div className="studio">
      <div className="studio-panel panel">
        <div className="panel-title">Episodes</div>
        <div className="ep-list">
          {listEpisodes().map((e) => (
            <button key={e.id} className={`ep-item ${e.id === studio.episodeId ? 'on' : ''}`} onClick={() => loadEpisode(e.id)}>
              <span className="ep-series">
                {e.series}
                {e.number !== undefined && ` · Ep. ${e.number}`}
              </span>
              <span className="ep-hook">{e.hook.replace('\n', ' ')}</span>
            </button>
          ))}
        </div>

        <div className="panel-title">Format</div>
        <div className="seg">
          {(Object.keys(ASPECTS) as Aspect[]).map((a) => (
            <button key={a} className={studio.aspect === a ? 'on' : ''} onClick={() => setStudio({ aspect: a })} title={ASPECTS[a].label}>
              {a}
            </button>
          ))}
        </div>

        <div className="panel-title">Theme</div>
        <div className="seg">
          {THEMES.map((t) => (
            <button key={t.id} className={theme === t.id ? 'on' : ''} onClick={() => setSetting('theme', t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="panel-title">Brand</div>
        <div className="seg">
          {BRANDS.map((b) => (
            <button key={b.id} className={studio.brandId === b.id ? 'on' : ''} onClick={() => setStudio({ brandId: b.id })}>
              {b.name}
            </button>
          ))}
        </div>

        <div className="studio-play">
          <button className={`play ${running ? 'on' : ''}`} onClick={() => setRunning(!running)}>
            {running ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <button className="icon-btn" onClick={reset} title="Restart">
            <RotateCcw size={15} />
          </button>
          <span className="mono studio-time">
            {studio.t.toFixed(1)}s / {episodeDuration(ep) + OUTRO_SECONDS}s
          </span>
        </div>

        <div className="panel-title">
          <Clapperboard size={11} /> Export
        </div>
        <p className="studio-note">Renders frame-perfect MP4 + GIF + per-beat PNGs (carousel) at {w}×{h}. Needs this dev server running.</p>
        {custom && (
          <button
            className="chip"
            onClick={() => {
              const a = document.createElement('a');
              a.href = URL.createObjectURL(new Blob([JSON.stringify(ep)], { type: 'application/json' }));
              a.download = `${ep.id}.json`;
              a.click();
            }}
            title="Made in the app — download it to render with the recorder"
          >
            Download episode file
          </button>
        )}
        <div className="cmd">
          <code>{cmd}</code>
          <button
            className="icon-btn small"
            onClick={() => {
              navigator.clipboard?.writeText(cmd);
              toast('good', 'Command copied');
            }}
            title="Copy"
          >
            <Copy size={13} />
          </button>
        </div>
      </div>

      <div className="studio-canvas" ref={ref}>
        <div className="stage-scaler" style={{ width: w * scale, height: h * scale }}>
          <div style={{ transform: `scale(${scale})`, transformOrigin: '0 0' }}>
            <Stage />
          </div>
        </div>
      </div>
    </div>
  );
}
