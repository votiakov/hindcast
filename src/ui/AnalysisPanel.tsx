import { useState } from 'react';
import { FlaskConical, Gauge, Loader2, PiggyBank, X } from 'lucide-react';
import { useSim, scenarioById, type BoardId } from '../sim/store';
import { graphToSpec } from '../spec/convert';
import { scenarioDuration } from '../scenarios/scenarios';
import type { Analysis } from '../sim/des/analyze';
import type { OptimizeResult } from '../sim/optimize';
import { analyzeInBrowser, breakingPointInBrowser, optimizeInBrowser } from '../sim/des/browserPool';
import { breakingPoint } from '../sim/headless';

const pct = (n: number) => `${(n * 100).toFixed(n > 0 && n < 0.01 ? 2 : 1)}%`;
const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`);

/** scenario the analysis runs: the comparison script, or the sandbox's current traffic */
function scenarioFor(b: BoardId, killMidRun: boolean) {
  const s = useSim.getState();
  const slo = { maxErrorRate: s.settings.sloErrorRate, maxP99Ms: s.settings.sloP99Ms };
  const sc = s.mode === 'compare' ? scenarioById(s.compare.scenarioId) : undefined;
  if (sc) {
    const side = b === 'A' ? 'a' : 'b';
    return {
      name: sc.title,
      duration: scenarioDuration(sc),
      readRatio: sc.readRatio,
      traffic: sc.timeline.map((k) => ({ at: k.at, rps: k.rps })),
      events: sc.events.filter((e) => e[side]).map((e) => ({ at: e.at, action: e[side]!, note: e.message })),
      slo,
    };
  }
  // the board's idle trickle (below 100 req/s) would make every design look fine and every
  // cost cut look safe: analyse at half of what the design can take instead, and say so
  const rps = s.traffic >= 100 ? s.traffic : designLoad(b);
  return {
    name: `${rps.toLocaleString()} req/s steady${rps !== s.traffic ? ` (half its limit; the board idles at ${s.traffic})` : ''}${killMidRun ? ' + instance failure' : ''}`,
    duration: 60,
    rps,
    readRatio: s.readRatio,
    events: killMidRun ? [{ at: 30, action: { type: 'kill' as const, kind: 'server' as const, pick: 'busiest' as const }, note: 'busiest server instance dies' }] : [],
    slo,
  };
}

/** half the design's breaking point (fluid engine, fast), rounded to 10 req/s */
function designLoad(b: BoardId): number {
  const s = useSim.getState();
  const bp = breakingPoint(specOf(b), { readRatio: s.readRatio, slo: { maxErrorRate: s.settings.sloErrorRate, maxP99Ms: s.settings.sloP99Ms } });
  return Math.max(10, Math.round(bp.maxRps / 2 / 10) * 10);
}

const specOf = (b: BoardId) => {
  const { boards, settings } = useSim.getState();
  const { nodes, edges, title } = boards[b];
  // workers have their own module state, so the pricing profile travels inside the spec
  return { ...graphToSpec(nodes, edges, title), pricing: settings.pricing, ...(settings.commitment !== 'none' ? { commitment: settings.commitment } : {}) };
};

function Result({ a, title }: { a: Analysis; title?: string }) {
  const m = a.metrics;
  const ok = a.pSloMet >= 0.95;
  return (
    <div className="an-card">
      {title && <div className="an-card-title">{title}</div>}
      <div className={`an-verdict ${ok ? 'good' : 'bad'}`}>
        SLO met in <b>{pct(a.pSloMet)}</b> of runs
      </div>
      <table className="an-table">
        <tbody>
          <tr>
            <th>errors</th>
            <td>
              {pct(m.errorRate.mean)} <i>± {pct(m.errorRate.ci95)}</i>
            </td>
          </tr>
          <tr>
            <th>p50</th>
            <td>
              {ms(m.p50Ms.mean)} <i>± {ms(m.p50Ms.ci95)}</i>
            </td>
          </tr>
          <tr>
            <th>p99 (answers)</th>
            <td>
              {ms(m.p99Ms.mean)} <i>± {ms(m.p99Ms.ci95)}</i>
            </td>
          </tr>
          <tr>
            <th>p99.9</th>
            <td>
              {ms(m.p999Ms.mean)} <i>± {ms(m.p999Ms.ci95)}</i>
            </td>
          </tr>
          <tr>
            <th>cost</th>
            <td>
              ${m.costPerHour.mean.toFixed(2)}/h <i>≈ ${Math.round(m.costPerHour.mean * 730).toLocaleString()}/mo</i>
            </td>
          </tr>
        </tbody>
      </table>
      {a.bottlenecks[0] && (
        <div className="an-note">
          <b>{a.bottlenecks[0].id}</b> is the top bottleneck in {pct(a.bottlenecks[0].share)} of runs. {a.bottlenecks[0].note}
        </div>
      )}
      {a.failures?.length > 0 && (
        <div className="an-why">
          <div className="an-why-head">why requests failed</div>
          {a.failures.slice(0, 4).map((f) => (
            <div key={`${f.id}-${f.reason}`} className="an-why-row">
              <span className="an-why-bar">
                <i style={{ width: `${Math.max(2, f.share * 100)}%` }} />
              </span>
              <span className="an-why-what">
                <b>{f.name}</b> {f.reason}
              </span>
              <span className="an-why-pct">{pct(f.share)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="an-foot">
        {a.runs} runs · {a.events.toLocaleString()} requests-events · {a.wallMs} ms
      </div>
    </div>
  );
}

export function AnalysisPanel() {
  const mode = useSim((s) => s.mode);
  const setOpen = useSim((s) => s.setAnalysisOpen);
  const [runs, setRuns] = useState(12);
  const [kill, setKill] = useState(false);
  const [runtimes, setRuntimes] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<{ A?: Analysis; B?: Analysis; main?: Analysis }>({});
  const [bp, setBp] = useState<Awaited<ReturnType<typeof breakingPointInBrowser>> | null>(null);
  const [opt, setOpt] = useState<Omit<OptimizeResult, 'spec'> | null>(null);
  const boards: BoardId[] = mode === 'compare' ? ['A', 'B'] : ['main'];
  const titleA = useSim((s) => s.boards.A.title);
  const titleB = useSim((s) => s.boards.B.title);
  const titles = { A: titleA, B: titleB };

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const analyzeAll = () =>
    run('analyze', async () => {
      const out: typeof res = {};
      await Promise.all(boards.map(async (b) => (out[b] = await analyzeInBrowser(specOf(b), scenarioFor(b, kill), runs))));
      setRes(out);
    });

  const apply = () => {
    if (!opt) return;
    const { updateNode, toast } = useSim.getState();
    for (const ch of opt.changes) if (ch.op === 'set') updateNode('main', ch.id, ch.fields);
    toast('good', `Applied ${opt.changes.length} change(s) — ${opt.monthlySavings >= 0 ? `saves $${opt.monthlySavings.toLocaleString()}/month` : `+$${(-opt.monthlySavings).toLocaleString()}/month`}`);
    setOpt(null);
  };

  const sc = scenarioFor(boards[0], kill);

  return (
    <div className="analysis panel">
      <div className="an-head">
        <FlaskConical size={15} />
        <div>
          <div className="an-title">Analysis</div>
          <div className="an-sub">discrete-event engine · every request simulated</div>
        </div>
        <button className="icon-btn small" onClick={() => setOpen(false)}>
          <X size={13} />
        </button>
      </div>

      <div className="an-scenario">
        <span>Scenario</span> {sc.name} · {sc.duration}s
      </div>
      <div className="an-controls">
        <label>
          runs
          <select value={runs} onChange={(e) => setRuns(+e.target.value)}>
            {[6, 12, 24, 48].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        {mode !== 'compare' && (
          <label className="an-check">
            <input type="checkbox" checked={kill} onChange={(e) => setKill(e.target.checked)} /> kill busiest server at 30s
          </label>
        )}
      </div>
      <button className="btn primary wide" disabled={!!busy} onClick={analyzeAll}>
        {busy === 'analyze' ? <Loader2 size={14} className="spin" /> : <FlaskConical size={14} />} Run Monte Carlo
      </button>

      {error && <div className="an-error">{error}</div>}
      {boards.map((b) => res[b] && <Result key={b} a={res[b]!} title={mode === 'compare' ? `${b} · ${titles[b as 'A' | 'B']}` : undefined} />)}

      {mode !== 'compare' && (
        <>
          <div className="an-section">Capacity</div>
          <button className="btn wide" disabled={!!busy} onClick={() => run('bp', async () => setBp(await breakingPointInBrowser(specOf('main'), useSim.getState().readRatio, { maxErrorRate: useSim.getState().settings.sloErrorRate, maxP99Ms: useSim.getState().settings.sloP99Ms })))}>
            {busy === 'bp' ? <Loader2 size={14} className="spin" /> : <Gauge size={14} />} Find breaking point
          </button>
          {bp && (
            <div className="an-card">
              Sustains <b>{bp.maxRps.toLocaleString()} req/s</b> within SLO.
              {bp.limitedBy && (
                <div className="an-note">
                  Limited by <b>{bp.limitedBy}</b>. {bp.note}
                </div>
              )}
            </div>
          )}

          <div className="an-section">Cost</div>
          <label className="an-check">
            <input type="checkbox" checked={runtimes} onChange={(e) => setRuntimes(e.target.checked)} /> allow runtime changes (e.g. Node → Go)
          </label>
          <button className="btn wide" disabled={!!busy} onClick={() => run('opt', async () => setOpt(await optimizeInBrowser(specOf('main'), scenarioFor('main', kill), runtimes)))}>
            {busy === 'opt' ? <Loader2 size={14} className="spin" /> : <PiggyBank size={14} />} Find cheapest config meeting SLO
          </button>
          {opt && (
            <div className="an-card">
              <div className={`an-verdict ${opt.feasible ? 'good' : 'bad'}`}>{opt.feasible ? 'SLO achievable by sizing' : 'Sizing alone cannot meet the SLO — change the design'}</div>
              <table className="an-table">
                <tbody>
                  <tr>
                    <th>before</th>
                    <td>
                      ${opt.before.monthly.toLocaleString()}/mo <i>{pct(opt.before.sloCompliance)} in SLO</i>
                    </td>
                  </tr>
                  <tr>
                    <th>after</th>
                    <td>
                      ${opt.after.monthly.toLocaleString()}/mo <i>{pct(opt.after.sloCompliance)} in SLO</i>
                    </td>
                  </tr>
                  <tr>
                    <th>{opt.monthlySavings >= 0 ? 'saves' : 'costs'}</th>
                    <td>
                      <b>${Math.abs(opt.monthlySavings).toLocaleString()}/mo</b>
                    </td>
                  </tr>
                </tbody>
              </table>
              {opt.log.filter((l) => l.startsWith('hint:')).map((l) => (
                <div key={l} className="an-note">
                  💡 {l.slice(6)}
                </div>
              ))}
              <ul className="an-changes">
                {opt.changes.map((ch, i) => (
                  <li key={i}>{ch.op === 'set' ? `${ch.id}: ${Object.entries(ch.fields).map(([k, v]) => `${k} → ${v}`).join(', ')}` : JSON.stringify(ch)}</li>
                ))}
              </ul>
              {opt.verification && (
                <div className="an-foot">
                  verified: SLO met in {pct(opt.verification.pSloMet)} of {opt.verification.runs} discrete-event runs · p99 (answers) {ms(opt.verification.metrics.p99Ms.mean)}
                </div>
              )}
              {opt.changes.length > 0 && (
                <button className="btn primary wide" onClick={apply}>
                  Apply to board
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
