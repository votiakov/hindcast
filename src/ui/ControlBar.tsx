import { Pause, Play, RotateCcw, Skull, TrendingUp, HeartPulse, X } from 'lucide-react';
import { useSim, type Pattern } from '../sim/store';
import { Timeline } from './Timeline';

const fmtTime = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export function ControlBar() {
  const running = useSim((s) => s.running);
  const speed = useSim((s) => s.speed);
  const traffic = useSim((s) => s.traffic);
  const readRatio = useSim((s) => s.readRatio);
  const pattern = useSim((s) => s.pattern);
  const t = useSim((s) => s.simT);
  const scripted = useSim((s) => s.mode === 'lesson' || (s.mode === 'compare' && s.compare.scenarioId !== null));
  const pb = useSim((s) => (s.mode === 'sandbox' ? s.playback : null));
  const mode = useSim((s) => s.mode);
  const { setRunning, setSpeed, reset, setTraffic, setReadRatio, setPattern, spike, chaosAll, stopPlayback } = useSim.getState();

  return (
    <div className="controlbar panel">
      {mode === 'sandbox' && <Timeline />}
      <div className="cb-row">
      <button className={`play ${running ? 'on' : ''}`} onClick={() => setRunning(!running)} title="Space">
        {running ? <Pause size={18} /> : <Play size={18} />}
      </button>
      <div className="speeds">
        {[1, 2, 4].map((s) => (
          <button key={s} className={speed === s ? 'on' : ''} onClick={() => setSpeed(s)}>
            {s}×
          </button>
        ))}
      </div>
      <div className="clock">{fmtTime(t)}</div>
      <button className="icon-btn" onClick={reset} title="Reset">
        <RotateCcw size={15} />
      </button>

      {pb && (
        <>
          <div className="divider" />
          <div className="pb-strip" title={pb.title}>
            <div className="pb-title">{pb.title}</div>
            <div className="pb-track">
              <i className="pb-fill" style={{ width: `${Math.min(100, (pb.t / pb.duration) * 100)}%` }} />
              {pb.events.map((e, i) => (
                <i key={i} className={`pb-mark ${pb.fired.includes(i) ? 'fired' : ''}`} style={{ left: `${(e.at / pb.duration) * 100}%` }} title={`t=${e.at}s ${e.note ?? e.action.type}`} />
              ))}
            </div>
          </div>
          <button className="chip" onClick={stopPlayback} title="Back to free play">
            <X size={13} /> Exit replay
          </button>
        </>
      )}
      {!scripted && !pb && (
        <>
          <div className="divider" />
          <div className="traffic">
            <span className="tl">Traffic</span>
            <input type="range" min={0} max={5000} step={10} value={traffic} onChange={(e) => setTraffic(+e.target.value)} />
            <span className="tv">{traffic.toLocaleString()}/s</span>
          </div>
          <div className="traffic">
            <span className="tl">Reads</span>
            <input className="short" type="range" min={0} max={1} step={0.05} value={readRatio} onChange={(e) => setReadRatio(+e.target.value)} />
            <span className="tv short">{Math.round(readRatio * 100)}%</span>
          </div>
          <select value={pattern} onChange={(e) => setPattern(e.target.value as Pattern)}>
            <option value="steady">Steady</option>
            <option value="diurnal">Day/night</option>
            <option value="spiky">Spiky</option>
            <option value="ramp">Ramp ×3</option>
          </select>
          <div className="divider" />
          <button className="chip" onClick={spike}>
            <TrendingUp size={14} /> Spike
          </button>
          <button className="chip danger" onClick={() => chaosAll({ type: 'kill', kind: 'server', pick: 'random' }, 'servers')}>
            <Skull size={14} /> Kill server
          </button>
          <button className="chip danger" onClick={() => chaosAll({ type: 'kill', kind: 'db', pick: 'random' }, 'databases')}>
            <Skull size={14} /> Kill DB
          </button>
          <button className="chip good" onClick={() => chaosAll({ type: 'revive-all' }, '')}>
            <HeartPulse size={14} /> Heal all
          </button>
        </>
      )}
      </div>
    </div>
  );
}
