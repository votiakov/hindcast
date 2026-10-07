import { ReactFlowProvider } from '@xyflow/react';
import { Eye, Lightbulb, RotateCcw, Shuffle, X } from 'lucide-react';
import { useState } from 'react';
import { BoardCanvas } from '../canvas/BoardCanvas';
import { useSim, scenarioById, type BoardId } from '../sim/store';
import { SCENARIOS, scenarioCaption, scenarioDuration } from '../scenarios/scenarios';
import { TEMPLATES, templateGroups } from '../scenarios/templates';

const fmtMs = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n.toFixed(0)}ms`);

function PaneHeader({ b }: { b: BoardId }) {
  const title = useSim((s) => s.boards[b].title);
  const g = useSim((s) => s.boards[b].global);
  const loadGraph = useSim((s) => s.loadGraph);
  const showCost = useSim((s) => s.settings.cost);
  const errTone = g.rps < 0.5 ? '' : g.errorRate > 0.01 ? 'bad' : 'good';
  return (
    <div className={`pane-header side-${b}`}>
      <span className="pane-tag">{b}</span>
      <span className="pane-title">{title}</span>
      <div className="pane-stats">
        <span className={errTone}>{(g.errorRate * 100).toFixed(1)}% err</span>
        <span>{fmtMs(g.p99)} p99</span>
        {showCost && <span>${g.cost.toFixed(2)}/h</span>}
      </div>
      <select
        className="pane-template"
        value=""
        title="Swap architecture"
        onChange={(e) => {
          const t = TEMPLATES.find((x) => x.id === e.target.value);
          if (t) loadGraph(b, t.graph, t.title);
        }}
      >
        <option value="" disabled>
          Swap…
        </option>
        {templateGroups().map((grp) => (
          <optgroup key={grp} label={grp}>
            {TEMPLATES.filter((t) => t.group === grp).map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

function Pane({ b }: { b: BoardId }) {
  const focused = useSim((s) => s.focus === b);
  return (
    <div className={`pane ${focused ? 'focused' : ''}`}>
      <ReactFlowProvider>
        <PaneHeader b={b} />
        <BoardCanvas id={b} minimap={false} padding={{ top: '80px', left: b === 'A' ? '90px' : '40px', right: '40px', bottom: '150px' }} />
      </ReactFlowProvider>
    </div>
  );
}

function ScenarioStrip() {
  const current = useSim((s) => s.compare.scenarioId);
  const pick = useSim((s) => s.pickScenario);
  return (
    <div className="scenario-strip">
      {SCENARIOS.map((s) => (
        <button key={s.id} className={`sc-chip ${current === s.id ? 'on' : ''}`} onClick={() => pick(s.id)} title={s.tagline}>
          {s.title}
        </button>
      ))}
      <button className={`sc-chip free ${current === null ? 'on' : ''}`} onClick={() => pick(null)} title="Manual traffic & chaos on whatever is on the boards">
        <Shuffle size={12} /> Free play
      </button>
    </div>
  );
}

function ScenarioBanner() {
  const cmp = useSim((s) => s.compare);
  const running = useSim((s) => s.running);
  const sc = scenarioById(cmp.scenarioId);
  if (!sc) return null;
  const dur = scenarioDuration(sc);
  const caption = cmp.t > 0 ? scenarioCaption(sc, cmp.t) : undefined;
  return (
    <div className="scenario-banner panel">
      <div className="sb-top">
        <span className="sb-title">{sc.title}</span>
        <span className="sb-time">
          {Math.min(cmp.t, dur).toFixed(0)}s / {dur}s
        </span>
      </div>
      <div className="sb-caption">{caption ?? (running ? '' : sc.tagline)}</div>
      {cmp.t === 0 && (
        <div className="sb-watch">
          <Eye size={13} /> {sc.watch}
        </div>
      )}
      <div className="sb-track">
        <div className="sb-fill" style={{ width: `${Math.min(100, (cmp.t / dur) * 100)}%` }} />
        {sc.events.map((e, i) => (
          <span key={i} className={`sb-mark ${cmp.t >= e.at ? 'past' : ''}`} style={{ left: `${(e.at / dur) * 100}%` }} title={e.message} />
        ))}
      </div>
      {cmp.t === 0 && !running && <div className="sb-hint">Press ▶ Play — same traffic and failures hit both architectures.</div>}
    </div>
  );
}

function Takeaway() {
  const cmp = useSim((s) => s.compare);
  const titleA = useSim((s) => s.boards.A.title);
  const titleB = useSim((s) => s.boards.B.title);
  const reset = useSim((s) => s.reset);
  const [hidden, setHidden] = useState<string | null>(null);
  const sc = scenarioById(cmp.scenarioId);
  if (!sc || !cmp.finished || hidden === `${sc.id}-${cmp.t}`) return null;
  return (
    <div className="takeaway-backdrop">
      <div className="takeaway panel">
        <button className="icon-btn small close" onClick={() => setHidden(`${sc.id}-${cmp.t}`)}>
          <X size={14} />
        </button>
        <div className="step-label">Takeaway</div>
        <h2>{sc.title}</h2>
        <div className="tk-cols">
          <div className="tk side-A">
            <span className="pane-tag">A</span>
            <b>{titleA}</b>
            <p>{sc.takeaway.a}</p>
          </div>
          <div className="tk side-B">
            <span className="pane-tag">B</span>
            <b>{titleB}</b>
            <p>{sc.takeaway.b}</p>
          </div>
        </div>
        <div className="hint">
          <Lightbulb size={14} />
          <span>{sc.takeaway.lesson}</span>
        </div>
        <button className="btn primary" onClick={reset}>
          <RotateCcw size={14} /> Replay
        </button>
      </div>
    </div>
  );
}

export function CompareView() {
  return (
    <div className="compare-wrap">
      <ScenarioStrip />
      <div className="compare">
        <Pane b="A" />
        <Pane b="B" />
        <ScenarioBanner />
        <Takeaway />
      </div>
    </div>
  );
}
