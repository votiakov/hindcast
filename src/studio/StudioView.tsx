import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Clapperboard, Copy, Download, Pause, Play, RotateCcw, X } from 'lucide-react';
import { useSim, type Aspect } from '../sim/store';
import { episodeById, episodeDuration, isCustomEpisode, listEpisodes, OUTRO_SECONDS } from './episodes';
import { BRANDS } from './brands';
import { ASPECTS, Stage } from './Stage';
import { THEMES } from '../theme/themes';
import { canEncodeMp4, renderClip, type Clip } from './exportClip';

type Job = { state: 'idle' } | { state: 'rendering'; done: number; label: string; abort: AbortController } | { state: 'done'; clip: Clip; name: string; seconds: number } | { state: 'error'; message: string };

function Downloads({ clip, name, seconds }: { clip: Clip; name: string; seconds: number }) {
  type Urls = { mp4?: string; gif?: string; pdf?: string; stills: string[] };
  const [urls, setUrls] = useState<Urls>({ stills: [] });
  // made and revoked by the same effect, so a remount never leaves dead links
  useEffect(() => {
    const u: Urls = {
      mp4: clip.mp4 && URL.createObjectURL(clip.mp4),
      gif: clip.gif && URL.createObjectURL(clip.gif),
      pdf: clip.pdf && URL.createObjectURL(clip.pdf),
      stills: clip.stills.map((b) => URL.createObjectURL(b)),
    };
    setUrls(u);
    return () => [u.mp4, u.gif, u.pdf, ...u.stills].forEach((x) => x && URL.revokeObjectURL(x));
  }, [clip]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);
  const mb = (b?: Blob) => (b ? ` · ${(b.size / 1e6).toFixed(1)} MB` : '');
  return (
    <div className="studio-files" ref={box}>
      <div className="studio-note">Rendered in {seconds.toFixed(0)} s.</div>
      {urls.mp4 && (
        <a className="chip" href={urls.mp4} download={`${name}.mp4`}>
          <Download size={12} /> MP4{mb(clip.mp4)}
        </a>
      )}
      {urls.gif && (
        <a className="chip" href={urls.gif} download={`${name}.gif`}>
          <Download size={12} /> GIF{mb(clip.gif)}
        </a>
      )}
      {urls.pdf && (
        <a className="chip" href={urls.pdf} download={`${name}_carousel.pdf`} title="One page per beat plus the outro: LinkedIn shows a PDF as a swipeable carousel">
          <Download size={12} /> Carousel PDF · {clip.stills.length} slides
        </a>
      )}
      {urls.stills.length > 0 && (
        <div className="studio-stills">
          {urls.stills.map((u, i) => (
            <a key={u} href={u} download={`${name}_${String(i + 1).padStart(2, '0')}.png`} title={`Slide ${i + 1} as PNG`}>
              <img src={u} alt={`Slide ${i + 1}`} />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}


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
  const [job, setJob] = useState<Job>({ state: 'idle' });
  const stageRef = useRef<HTMLDivElement>(null);
  useEffect(() => setJob((j) => (j.state === 'rendering' ? j : { state: 'idle' })), [studio.episodeId, studio.aspect, studio.brandId, theme]);
  const render = async () => {
    const abort = new AbortController();
    const started = performance.now();
    setJob({ state: 'rendering', done: 0, label: 'starting', abort });
    try {
      const stage = stageRef.current!.querySelector<HTMLElement>('.stage')!;
      const clip = await renderClip(stage, w, h, {
        fps: 30,
        mp4: true,
        gif: true,
        carousel: true,
        signal: abort.signal,
        onProgress: (done, label) => setJob({ state: 'rendering', done, label, abort }),
      });
      setJob({ state: 'done', clip, name: `${ep.id}_${studio.aspect.replace(':', 'x')}`, seconds: (performance.now() - started) / 1000 });
    } catch (e) {
      setJob(abort.signal.aborted ? { state: 'idle' } : { state: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };
  const busy = job.state === 'rendering';
  const cmd = `npm run record -- ${custom ? `--ep-file ${studio.episodeId}.json` : studio.episodeId} --aspect ${studio.aspect} --brand ${studio.brandId} --theme ${theme}`;

  return (
    <div className="studio">
      <div className={`studio-panel panel ${busy ? 'busy' : ''}`}>
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
        {job.state === 'rendering' ? (
          <div className="studio-render">
            <div className="hold-bar">
              <div className="hold-fill" style={{ width: `${job.done * 100}%` }} />
            </div>
            <div className="studio-note">
              Rendering frame by frame… {job.label}
              <button className="icon-btn small" onClick={() => job.abort.abort()} title="Cancel">
                <X size={13} />
              </button>
            </div>
          </div>
        ) : (
          <button className="btn primary wide" onClick={render} title={`Plays the episode frame by frame at ${w}×${h} and encodes it here, in your browser`}>
            <Clapperboard size={14} /> Render {canEncodeMp4() ? 'video, GIF' : 'GIF'} and carousel
          </button>
        )}
        {job.state === 'error' && <p className="studio-note bad">Rendering failed: {job.message}</p>}
        {job.state === 'done' && <Downloads key={job.name + job.seconds} clip={job.clip} name={job.name} seconds={job.seconds} />}
        <details className="studio-cli">
          <summary>Or from the command line</summary>
          <p className="studio-note">Frame-perfect H.264 at 30 fps with ffmpeg; needs this repository and the dev server running.</p>
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
        </details>
      </div>

      <div className={`studio-canvas ${busy ? 'rendering' : ''}`} ref={ref}>
        <div className="stage-scaler" ref={stageRef} style={{ width: w * scale, height: h * scale }}>
          <div style={{ transform: `scale(${scale})`, transformOrigin: '0 0' }}>
            <Stage />
          </div>
        </div>
      </div>
    </div>
  );
}
