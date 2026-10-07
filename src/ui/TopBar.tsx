import { Crown } from 'lucide-react';
import { BrandMark } from '../theme/BrandMark';
import { useSim, type Mode } from '../sim/store';
import type { GlobalStats } from '../sim/engine';
import { Sparkline } from '../canvas/Sparkline';
import { TEMPLATES, templateGroups } from '../scenarios/templates';
import { SettingsButton } from './SettingsPanel';
import { currentSpecYaml } from '../spec/links';
import { FileCode2, FlaskConical } from 'lucide-react';

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

function SingleMetrics() {
  const g = useSim((s) => s.boards.main.global);
  const goal = useSim((s) => (s.mode === 'lesson' && !s.lesson.finished ? s.lesson.lesson.steps[s.lesson.stepIndex].goal : undefined));
  const maxErr = goal?.maxErrorRate ?? 0.01;
  const maxP99 = goal?.maxP99 ?? 300;
  const errTone = g.rps < 0.5 ? undefined : g.errorRate > maxErr ? 'bad' : g.errorRate > maxErr / 2 ? 'warn' : 'good';
  const p99Tone = g.rps < 0.5 ? undefined : g.p99 > maxP99 ? 'bad' : g.p99 > maxP99 * 0.7 ? 'warn' : 'good';
  const costTone = goal?.maxCost !== undefined ? (g.cost > goal.maxCost ? 'bad' : 'good') : undefined;
  const showCost = useSim((s) => s.settings.cost);
  const h = g.history;
  return (
    <div className="metrics">
      <Metric label="Throughput" value={fmtRps(g.rps)} sub="req/s" values={h.map((x) => x.rps)} color="#22d3ee" />
      <Metric label="Error rate" value={`${(g.errorRate * 100).toFixed(2)}%`} sub={`SLO < ${(maxErr * 100).toFixed(0)}%`} tone={errTone} values={h.map((x) => x.err)} max={0.2} color="#f43f5e" />
      <Metric label="p99" value={`${g.p99.toFixed(0)}ms`} sub={`SLO < ${maxP99}ms`} tone={p99Tone} values={h.map((x) => x.p99)} max={Math.max(maxP99 * 2, ...h.map((x) => x.p99))} color="#fbbf24" />
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

function CompareMetrics() {
  const A: GlobalStats = useSim((s) => s.boards.A.global);
  const B: GlobalStats = useSim((s) => s.boards.B.global);
  const ha = A.history;
  const hb = B.history;
  const showCost = useSim((s) => s.settings.cost);
  return (
    <div className="metrics">
      <VsMetric label="Error rate" a={A.errorRate} b={B.errorRate} fmt={(n) => `${(n * 100).toFixed(1)}%`} seriesA={ha.map((x) => x.err)} seriesB={hb.map((x) => x.err)} max={1} />
      <VsMetric label="p99 latency" a={A.p99} b={B.p99} fmt={(n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n.toFixed(0)}ms`)} seriesA={ha.map((x) => x.p99)} seriesB={hb.map((x) => x.p99)} />
 {showCost && <VsMetric label="Cost $/h" a={A.cost} b={B.cost} fmt={(n) => `$${n.toFixed(2)}`} seriesA={ha.map((x) => x.cost)} seriesB={hb.map((x) => x.cost)} />}
    </div>
  );
}

export function TopBar() {
  const mode = useSim((s) => s.mode);
  const setMode = useSim((s) => s.setMode);
  const loadGraph = useSim((s) => s.loadGraph);
  const analysisOpen = useSim((s) => s.analysisOpen);
  const setAnalysisOpen = useSim((s) => s.setAnalysisOpen);

  return (
    <div className="topbar">
      <div className="brand">
        <BrandMark />
        <div>
          <div className="brand-name">Bottleneck</div>
          <div className="brand-sub">system design simulator</div>
        </div>
      </div>

      <div className="mode-tabs">
        {(['home', 'lesson', 'sandbox', 'compare', 'studio'] as Mode[]).map((m) => (
          <button key={m} className={mode === m ? 'on' : ''} onClick={() => mode !== m && setMode(m)}>
            {m === 'home' ? 'Live' : m[0].toUpperCase() + m.slice(1)}
          </button>
        ))}
      </div>

      {mode === 'sandbox' && (
        <select
          className="template-select"
          value=""
          onChange={(e) => {
            const t = TEMPLATES.find((x) => x.id === e.target.value);
            if (t) loadGraph('main', t.graph);
          }}
        >
          <option value="" disabled>
            Load template…
          </option>
          {templateGroups().map((g) => (
            <optgroup key={g} label={g}>
              {TEMPLATES.filter((t) => t.group === g).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      )}

      {mode === 'sandbox' && (
        <button
          className="icon-btn"
          title="Copy this architecture as a spec (YAML) — paste it to your AI assistant or the CLI"
          onClick={() => {
            navigator.clipboard?.writeText(currentSpecYaml());
            useSim.getState().toast('good', 'Architecture spec copied (YAML)');
          }}
        >
          <FileCode2 size={15} />
        </button>
      )}
      {(mode === 'sandbox' || mode === 'compare') && (
        <button className={`icon-btn ${analysisOpen ? 'on' : ''}`} title="Analysis: discrete-event Monte Carlo, breaking point, cost optimizer" onClick={() => setAnalysisOpen(!analysisOpen)}>
          <FlaskConical size={15} />
        </button>
      )}
      {mode === 'compare' ? <CompareMetrics /> : mode === 'studio' ? <div className="metrics" /> : <SingleMetrics />}
      <SettingsButton />
    </div>
  );
}
