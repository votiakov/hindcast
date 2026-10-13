import { ReactFlowProvider } from '@xyflow/react';
import { Pause, Play, RotateCcw, ExternalLink } from 'lucide-react';
import { BoardCanvas } from '../canvas/BoardCanvas';
import { useSim } from '../sim/store';
import { encodePayload, graphToSpec } from '../spec/convert';
import './embed.css';

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

/**
 * Embed mode (`?embed=1#spec=…`, optional `&rps=800`): just the running board, its numbers and a
 * traffic slider — for blog posts, docs and slides. A link opens the full app on the same design.
 */
export function Embed() {
  const g = useSim((s) => s.boards.main.global);
  const running = useSim((s) => s.running);
  const traffic = useSim((s) => s.traffic);
  const title = useSim((s) => s.boards.main.title);
  const slo = useSim((s) => s.settings);
  const { setRunning, setTraffic, reset } = useSim.getState();
  const open = () => {
    const m = useSim.getState().boards.main;
    window.open(`${location.origin}${location.pathname}#spec=${encodePayload(graphToSpec(m.nodes, m.edges, m.title))}`, '_blank');
  };
  return (
    <div className="embed">
      <ReactFlowProvider>
        <BoardCanvas id="main" minimap={false} padding={{ top: '56px', left: '24px', right: '24px', bottom: '64px' }} />
      </ReactFlowProvider>
      <div className="em-top">
        <span className="em-title">{title}</span>
        <span className={g.rps > 0.5 && g.errorRate > slo.sloErrorRate ? 'bad' : ''}>{(g.errorRate * 100).toFixed(1)}% errors</span>
        <span className={g.rps > 0.5 && g.p99 > slo.sloP99Ms ? 'bad' : ''}>p99 {fmtMs(g.p99)}</span>
        <span>${Math.round(g.cost * 730).toLocaleString('en-US')}/mo</span>
      </div>
      <div className="em-bar">
        <button onClick={() => setRunning(!running)} title={running ? 'Pause' : 'Play'}>
          {running ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button onClick={reset} title="Reset">
          <RotateCcw size={13} />
        </button>
        <input type="range" min={0} max={5000} step={10} value={traffic} onChange={(e) => setTraffic(+e.target.value)} aria-label="Traffic" />
        <span className="em-rps">{traffic.toLocaleString('en-US')} req/s</span>
        <button className="em-open" onClick={open} title="Open this design in Hindcast">
          Hindcast <ExternalLink size={11} />
        </button>
      </div>
    </div>
  );
}
