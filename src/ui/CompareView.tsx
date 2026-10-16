import { ReactFlowProvider } from '@xyflow/react';
import { ChevronRight, Eye, Lightbulb, RotateCcw, ShieldAlert, Shuffle, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { auditInBrowser } from '../sim/des/browserPool';
import { graphToSpec } from '../spec/convert';
import type { AuditResult } from '../sim/audit';
import './audit.css';
import { BoardCanvas } from '../canvas/BoardCanvas';
import { useSim, scenarioById, type BoardId, type SideScore } from '../sim/store';
import { SCENARIOS, scenarioCaption, scenarioDuration } from '../scenarios/scenarios';
import { TEMPLATES, templateGroups } from '../scenarios/templates';

const fmtMs = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n.toFixed(0)}ms`);

const SEV = { critical: 'CRIT', major: 'MAJOR', minor: 'minor', ok: 'ok' } as const;

/** failure audit of one side, at the scenario's peak load (or the traffic slider in free play) */
function PaneAudit({ b }: { b: BoardId }) {
  const [state, setState] = useState<{ busy: boolean; r: AuditResult | null; open: boolean; err?: string }>({ busy: false, r: null, open: false });
  const nodes = useSim((s) => s.boards[b].nodes);
  useEffect(() => setState((x) => ({ ...x, r: null, open: false })), [nodes.length]);
  const run = async () => {
    const s = useSim.getState();
    const sc = scenarioById(s.compare.scenarioId);
    const rps = sc ? Math.max(...sc.timeline.map((k) => k.rps)) : s.traffic;
    const { nodes: ns, edges, title } = s.boards[b];
    setState({ busy: true, r: null, open: false });
    try {
      const r = await auditInBrowser(
        { ...graphToSpec(ns, edges, title), pricing: s.settings.pricing, ...(s.settings.commitment !== 'none' ? { commitment: s.settings.commitment } : {}) },
        { rps, readRatio: sc?.readRatio ?? s.readRatio, slo: { maxErrorRate: s.settings.sloErrorRate, maxP99Ms: s.settings.sloP99Ms } },
        undefined,
        `cmp-${b}`,
      );
      setState({ busy: false, r, open: false });
    } catch (e) {
      setState({ busy: false, r: null, open: false, err: e instanceof Error ? e.message : String(e) });
    }
  };
  const r = state.r;
  return (
    <div className="pane-audit">
      {r ? (
        <button className={`pa-score ${r.score >= 80 ? 'good' : r.score >= 50 ? 'warn' : 'bad'}`} onClick={() => setState({ ...state, open: !state.open })} title="Failure audit of this side">
          <ShieldAlert size={12} /> {r.score}
          <small>/100</small>
        </button>
      ) : (
        <button className="pa-run" disabled={state.busy} onClick={run} title="Failure audit of this side: what breaks first, and what it costs">
          <ShieldAlert size={12} /> {state.busy ? 'auditing…' : 'audit'}
        </button>
      )}
      {r && state.open && (
        <div className="pa-pop">
          <div className="pa-head">
            survives <b>{r.survived}</b>/{r.total} · headroom <b>{r.headroom.ratio.toFixed(1)}×</b> · <b>${r.baseline.monthly.toLocaleString('en-US')}</b>/mo · at {r.load.rps.toLocaleString('en-US')} req/s
          </div>
          {r.findings
            .filter((f) => f.severity === 'critical' || f.severity === 'major')
            .slice(0, 8)
            .map((f) => (
              <div key={f.id} className={`pa-row sev-${f.severity}`}>
                <span className="au-sev">{SEV[f.severity]}</span>
                <span>{f.title}</span>
                {f.fixes[0] && (
                  <em>
                    {f.fixes[0].title} · {f.fixes[0].monthlyDelta >= 0 ? '+' : '−'}${Math.abs(f.fixes[0].monthlyDelta)}/mo
                  </em>
                )}
              </div>
            ))}
          <button className="pa-run" onClick={run}>
            re-run
          </button>
        </div>
      )}
      {state.err && <span className="bad">{state.err}</span>}
    </div>
  );
}

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
        {g.staleReads >= 1 && <span className="warn" title="reads that could miss a write made before them: a lagging replica, a search index between refreshes">{num(g.staleReads)} stale</span>}
      </div>
      <PaneAudit b={b} />
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
        <BoardCanvas id={b} minimap={false} legible padding={{ top: '80px', left: b === 'A' ? '90px' : '40px', right: '40px', bottom: '150px' }} />
      </ReactFlowProvider>
    </div>
  );
}

function ScenarioStrip() {
  const current = useSim((s) => s.compare.scenarioId);
  const pick = useSim((s) => s.pickScenario);
  const strip = useRef<HTMLDivElement>(null);
  // twenty-eight chips scroll sideways: keep the current one in view (e.g. after "Next")
  useEffect(() => {
    strip.current?.querySelector('.sc-chip.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [current]);
  return (
    <div className="scenario-strip" ref={strip}>
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

const num = (n: number) => Math.round(n).toLocaleString('en-US');
const msx = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);

/** one sentence from the measured run: who failed fewer requests, and at what price */
function verdict(a: SideScore, b: SideScore, ta: string, tb: string): string {
  const costA = a.costSum / Math.max(1, a.n);
  const costB = b.costSum / Math.max(1, b.n);
  const dCost = costB - costA;
  const price = Math.abs(dCost) < 0.01 ? 'at the same cost' : dCost > 0 ? `for $${dCost.toFixed(2)}/h more` : `and $${(-dCost).toFixed(2)}/h cheaper`;
  if (Math.abs(a.failed - b.failed) < Math.max(5, 0.05 * Math.max(a.failed, b.failed))) {
    // the same service, but one side's reads missed what was just written
    if (Math.abs(a.outS - b.outS) < 1 && Math.abs(a.stale - b.stale) > 50) {
      const [w, l, wn, ln] = b.stale <= a.stale ? [b, a, tb, ta] : [a, b, ta, tb];
      return `${ta} and ${tb} served this run alike, ${Math.abs(dCost) < 0.01 ? 'at the same cost' : `$${Math.abs(dCost).toFixed(2)}/h apart`} — but ${ln} answered ${num(l.stale)} reads that could miss a write made before them, against ${num(w.stale)} for ${wn}.`;
    }
    if (Math.abs(a.outS - b.outS) < 1) return `${ta} and ${tb} served this run alike; the difference is the bill: ${tb} ${Math.abs(dCost) < 0.01 ? 'costs the same' : dCost > 0 ? `costs $${dCost.toFixed(2)}/h more` : `costs $${(-dCost).toFixed(2)}/h less`}.`;
  }
  // nobody failed requests: the difference is time out of SLO (latency)
  if (a.failed < 5 && b.failed < 5) {
    const [w, l, wn, ln] = b.outS <= a.outS ? [b, a, tb, ta] : [a, b, ta, tb];
    const p = w === b ? price : Math.abs(dCost) < 0.01 ? 'at the same cost' : dCost > 0 ? `and $${dCost.toFixed(2)}/h cheaper` : `for $${(-dCost).toFixed(2)}/h more`;
    return `Neither dropped requests, but ${wn} spent ${Math.round(w.outS)} s out of SLO against ${ln}'s ${Math.round(l.outS)} s (worst p99 ${msx(w.peakP99)} vs ${msx(l.peakP99)}), ${p}.`;
  }
  const [win, lose, wName, lName] = b.failed <= a.failed ? [b, a, tb, ta] : [a, b, ta, tb];
  const fewer = lose.failed > 0 ? Math.round((1 - win.failed / lose.failed) * 100) : 0;
  const pricePhrase = win === b ? price : Math.abs(dCost) < 0.01 ? 'at the same cost' : dCost > 0 ? `and $${dCost.toFixed(2)}/h cheaper` : `for $${(-dCost).toFixed(2)}/h more`;
  return `${wName} failed ${fewer}% fewer requests than ${lName} (${num(win.failed)} vs ${num(lose.failed)}) and spent ${Math.round(win.outS)} s out of SLO instead of ${Math.round(lose.outS)} s, ${pricePhrase}.`;
}

/** the measured run, side by side; the better side of each row is marked */
function Scoreboard({ a, b }: { a: SideScore; b: SideScore }) {
  const rows: { label: string; va: number; vb: number; fmt: (n: number) => string }[] = [
    { label: 'failed requests', va: a.failed, vb: b.failed, fmt: num },
    { label: 'time out of SLO', va: a.outS, vb: b.outS, fmt: (n) => `${Math.round(n)} s` },
    { label: 'worst p99', va: a.peakP99, vb: b.peakP99, fmt: msx },
    { label: 'average cost', va: a.costSum / Math.max(1, a.n), vb: b.costSum / Math.max(1, b.n), fmt: (n) => `$${n.toFixed(2)}/h` },
    ...(a.stale > 0 || b.stale > 0 ? [{ label: 'stale reads', va: a.stale, vb: b.stale, fmt: num }] : []),
  ];
  return (
    <table className="tk-score">
      <thead>
        <tr>
          <th>this run</th>
          <th className="side-A">A</th>
          <th className="side-B">B</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const close = Math.abs(r.va - r.vb) <= Math.max(Math.abs(r.va), Math.abs(r.vb)) * 0.03;
          return (
            <tr key={r.label}>
              <th>{r.label}</th>
              <td className={!close && r.va < r.vb ? 'win' : ''}>{r.fmt(r.va)}</td>
              <td className={!close && r.vb < r.va ? 'win' : ''}>{r.fmt(r.vb)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Takeaway() {
  const cmp = useSim((s) => s.compare);
  const titleA = useSim((s) => s.boards.A.title);
  const titleB = useSim((s) => s.boards.B.title);
  const reset = useSim((s) => s.reset);
  const pick = useSim((s) => s.pickScenario);
  const [hidden, setHidden] = useState<string | null>(null);
  const sc = scenarioById(cmp.scenarioId);
  if (!sc || !cmp.finished || hidden === `${sc.id}-${cmp.t}`) return null;
  const next = SCENARIOS[(SCENARIOS.findIndex((x) => x.id === sc.id) + 1) % SCENARIOS.length];
  return (
    <div className="takeaway-backdrop">
      <div className="takeaway panel">
        <button className="icon-btn small close" onClick={() => setHidden(`${sc.id}-${cmp.t}`)}>
          <X size={14} />
        </button>
        <div className="step-label">Takeaway</div>
        <h2>{sc.title}</h2>
        <p className="tk-verdict">{verdict(cmp.score.A, cmp.score.B, titleA, titleB)}</p>
        <Scoreboard a={cmp.score.A} b={cmp.score.B} />
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
        <div className="tk-actions">
          <button className="btn primary" onClick={() => pick(next.id)} title={next.tagline}>
            Next: {next.title} <ChevronRight size={14} />
          </button>
          <button className="btn" onClick={reset}>
            <RotateCcw size={14} /> Replay
          </button>
        </div>
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
