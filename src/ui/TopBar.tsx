import { useState } from 'react';
import { Crown } from 'lucide-react';
import { Lens } from './Lens';
import { BrandMark } from '../theme/BrandMark';
import { useSim, type Mode } from '../sim/store';
import type { GlobalStats } from '../sim/engine';
import { Sparkline } from '../canvas/Sparkline';
import { SettingsButton } from './SettingsPanel';
import { DesignMenu } from './DesignMenu';
import { BookOpen, Calculator, FileCode2, FlaskConical, ShieldAlert } from 'lucide-react';

const fmtRps = (r: number) => (r >= 1000 ? `${(r / 1000).toFixed(2)}k` : r.toFixed(0));

function Metric({ label, value, sub, tone, values, max, color }: { label: string; value: string; sub?: string; tone?: 'good' | 'warn' | 'bad'; values: number[]; max?: number; color: string }) {
  return (
    <div className={`metric ${tone ?? ''}`}>
      <div className="metric-top">
        <span className="metric-label">{label}</span>
        {sub && <span className="metric-sub">{sub}</span>}
      </div>
      <div className="metric-value">{value}</div>
      <Sparkline values={values} max={max} color={color} width={132} height={20} />
    </div>
  );
}

const pctOf = (x: number) => `${x < 0.1 ? +(x * 100).toFixed(1) : Math.round(x * 100)}%`;

/** each priority class on its own, once the users send best-effort requests: critical's errors and
 *  p99 against the SLO, and the share of best-effort shed on its way */
function ClassMetric({ g, maxErr, maxP99 }: { g: GlobalStats; maxErr: number; maxP99: number }) {
  const c = g.critical;
  const be = g.bestEffort;
  if (!c || !be) return null;
  const tone = c.rps < 0.5 ? undefined : c.errorRate > maxErr || c.p99 > maxP99 ? 'bad' : c.errorRate > maxErr / 2 || c.p99 > maxP99 * 0.7 ? 'warn' : 'good';
  const shed = be.rps > 0.5 ? Math.min(1, be.shedRps / be.rps) : 0;
  const p99 = c.p99 >= 1000 ? `${(c.p99 / 1000).toFixed(1)}s` : `${c.p99.toFixed(0)}ms`;
  return (
    <>
      <div className={`metric ${tone ?? ''}`} title="The users' critical requests: their errors and p99, against the SLO">
        <div className="metric-top">
          <span className="metric-label">critical</span>
        </div>
        <div className="metric-value">
          {pctOf(c.errorRate)} err <span className="metric-aside">p99 {p99}</span>
        </div>
      </div>
      <div className="metric" title="The users' best-effort requests: the share shed on their way, so that critical ones keep capacity">
        <div className="metric-top">
          <span className="metric-label">best-effort</span>
        </div>
        <div className="metric-value">{shed > 0.001 ? `${pctOf(shed)} shed` : `${pctOf(be.errorRate)} err`}</div>
      </div>
    </>
  );
}

function SingleMetrics({ onClick, lens }: { onClick: () => void; lens: React.ReactNode }) {
  const g = useSim((s) => s.boards.main.global);
  const goal = useSim((s) => (s.mode === 'lesson' && !s.lesson.finished ? s.lesson.lesson.steps[s.lesson.stepIndex].goal : undefined));
  const slo = useSim((s) => s.settings);
  const maxErr = goal?.maxErrorRate ?? slo.sloErrorRate;
  const maxP99 = goal?.maxP99 ?? slo.sloP99Ms;
  const errTone = g.rps < 0.5 ? undefined : g.errorRate > maxErr ? 'bad' : g.errorRate > maxErr / 2 ? 'warn' : 'good';
  const p99Tone = g.rps < 0.5 ? undefined : g.p99 > maxP99 ? 'bad' : g.p99 > maxP99 * 0.7 ? 'warn' : 'good';
  const costTone = goal?.maxCost !== undefined ? (g.cost > goal.maxCost ? 'bad' : 'good') : undefined;
  const showCost = useSim((s) => s.settings.cost);
  const h = g.history;
  return (
    <div className="metrics" onClick={onClick} title="Cost breakdown and error budget">
      {lens}
      <Metric label="Throughput" value={fmtRps(g.rps)} sub="req/s" values={h.map((x) => x.rps)} color="#22d3ee" />
      <Metric label="Error rate" value={`${(g.errorRate * 100).toFixed(2)}%`} sub={`SLO < ${+(maxErr * 100).toFixed(2)}%`} tone={errTone} values={h.map((x) => x.err)} max={0.2} color="#f43f5e" />
      <Metric label="p99" value={`${g.p99.toFixed(0)}ms`} sub={`SLO < ${maxP99}ms`} tone={p99Tone} values={h.map((x) => x.p99)} max={Math.max(maxP99 * 2, ...h.map((x) => x.p99))} color="#fbbf24" />
      <ClassMetric g={g} maxErr={maxErr} maxP99={maxP99} />
      {showCost && <Metric label="Cost" value={`$${g.cost.toFixed(2)}`} sub={goal?.maxCost !== undefined ? `budget $${goal.maxCost.toFixed(2)}/h` : `/h · $${(g.cost * 730).toFixed(0)}/mo`} tone={costTone} values={h.map((x) => x.cost)} color="#a78bfa" />}
    </div>
  );
}

/** two series on one sparkline: A cyan, B violet */
function Duo({ a, b, max }: { a: number[]; b: number[]; max?: number }) {
  const top = max ?? Math.max(1e-6, ...a, ...b);
  return (
    <div className="duo">
      <Sparkline values={a} max={top} color="#22d3ee" width={150} height={22} />
      <div className="duo-b">
        <Sparkline values={b} max={top} color="#c084fc" width={150} height={22} />
      </div>
    </div>
  );
}

function VsMetric({ label, a, b, fmt, lowerWins = true, seriesA, seriesB, max }: { label: string; a: number; b: number; fmt: (n: number) => string; lowerWins?: boolean; seriesA: number[]; seriesB: number[]; max?: number }) {
  const close = Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 0.05;
  const aWins = !close && (lowerWins ? a < b : a > b);
  const bWins = !close && !aWins;
  return (
    <div className="metric vs">
      <div className="metric-top">
        <span className="metric-label">{label}</span>
      </div>
      <div className="vs-values">
        <span className={`vs-a ${aWins ? 'win' : ''}`}>
          {aWins && <Crown size={11} />}
          {fmt(a)}
        </span>
        <span className="vs-sep">vs</span>
        <span className={`vs-b ${bWins ? 'win' : ''}`}>
          {bWins && <Crown size={11} />}
          {fmt(b)}
        </span>
      </div>
      <Duo a={seriesA} b={seriesB} max={max} />
    </div>
  );
}

function CompareMetrics({ onClick, lens }: { onClick: () => void; lens: React.ReactNode }) {
  const A: GlobalStats = useSim((s) => s.boards.A.global);
  const B: GlobalStats = useSim((s) => s.boards.B.global);
  const ha = A.history;
  const hb = B.history;
  const showCost = useSim((s) => s.settings.cost);
  return (
    <div className="metrics" onClick={onClick} title="Cost breakdown and error budget (focused side)">
      {lens}
      <VsMetric label="Error rate" a={A.errorRate} b={B.errorRate} fmt={(n) => `${(n * 100).toFixed(1)}%`} seriesA={ha.map((x) => x.err)} seriesB={hb.map((x) => x.err)} max={1} />
      <VsMetric label="p99 latency" a={A.p99} b={B.p99} fmt={(n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n.toFixed(0)}ms`)} seriesA={ha.map((x) => x.p99)} seriesB={hb.map((x) => x.p99)} />
 {showCost && <VsMetric label="Cost $/h" a={A.cost} b={B.cost} fmt={(n) => `$${n.toFixed(2)}`} seriesA={ha.map((x) => x.cost)} seriesB={hb.map((x) => x.cost)} />}
    </div>
  );
}

export function TopBar() {
  const mode = useSim((s) => s.mode);
  const [lens, setLens] = useState(false);
  const setMode = useSim((s) => s.setMode);
  const analysisOpen = useSim((s) => s.analysisOpen);
  const setAnalysisOpen = useSim((s) => s.setAnalysisOpen);
  const auditOpen = useSim((s) => s.auditOpen);
  const setAuditOpen = useSim((s) => s.setAuditOpen);
  const specOpen = useSim((s) => s.specOpen);
  const setSpecOpen = useSim((s) => s.setSpecOpen);
  const envelopeOpen = useSim((s) => s.envelopeOpen);
  const setEnvelopeOpen = useSim((s) => s.setEnvelopeOpen);

  return (
    <div className="topbar">
      <div className="brand">
        <BrandMark />
        <div>
          <div className="brand-name">Hindcast</div>
          <div className="brand-sub">system design simulator</div>
        </div>
      </div>

      <div className="mode-tabs">
        {(['backtest', 'home', 'lesson', 'sandbox', 'compare', 'studio'] as Mode[]).map((m) => (
          <button key={m} className={mode === m ? 'on' : ''} onClick={() => mode !== m && setMode(m)}>
            {m === 'home' ? 'Live' : m === 'lesson' ? 'Lessons' : m[0].toUpperCase() + m.slice(1)}
          </button>
        ))}
      </div>

      {mode === 'sandbox' && <DesignMenu />}

      {mode === 'sandbox' && (
        <button className={`icon-btn ${specOpen ? 'on' : ''}`} title="Architecture as code: edit the YAML spec, two-way synced with the board" onClick={() => setSpecOpen(!specOpen)}>
          <FileCode2 size={15} />
        </button>
      )}
      {mode === 'sandbox' && (
        <button className={`icon-btn ${envelopeOpen ? 'on' : ''}`} title="Back of the envelope: users → req/s, storage and bandwidth, then run the peak" onClick={() => setEnvelopeOpen(!envelopeOpen)}>
          <Calculator size={15} />
        </button>
      )}
      {mode === 'sandbox' && (
        <button className={`icon-btn ${auditOpen ? 'on' : ''}`} title="Failure audit: what breaks first, and what it costs" onClick={() => setAuditOpen(!auditOpen)}>
          <ShieldAlert size={15} />
        </button>
      )}
      {(mode === 'sandbox' || mode === 'compare') && (
        <button className={`icon-btn ${analysisOpen ? 'on' : ''}`} title="Analysis: discrete-event Monte Carlo, breaking point, cost optimizer" onClick={() => setAnalysisOpen(!analysisOpen)}>
          <FlaskConical size={15} />
        </button>
      )}
      {mode === 'compare' ? <CompareMetrics onClick={() => setLens(!lens)} lens={lens && <Lens onClose={() => setLens(false)} />} /> : mode === 'studio' ? <div className="metrics" /> : <SingleMetrics onClick={() => setLens(!lens)} lens={lens && <Lens onClose={() => setLens(false)} />} />}
      <SettingsButton />
      <a className="icon-btn" href="docs/index.html" target="_blank" rel="noopener" title="Documentation: every view and feature, explained">
        <BookOpen size={17} />
      </a>
    </div>
  );
}
