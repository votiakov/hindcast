import { useMemo } from 'react';
import { Clapperboard, ClipboardCopy, Play, ShieldAlert, Square, Wrench, X } from 'lucide-react';
import { episodeFromFinding } from '../studio/fromAudit';
import { registerEpisode } from '../studio/episodes';
import { cleanGraph } from '../sim/designs';
import { useSim } from '../sim/store';
import { graphToSpec } from '../spec/convert';
import { auditInBrowser } from '../sim/des/browserPool';
import { auditMarkdown } from '../sim/auditReport';
import { auditHtml } from '../sim/auditHtml';
import { availPct, downtimeText, type AuditResult, type Finding, type Severity } from '../sim/audit';
import type { SimAction } from '../sim/actions';
import { isSystem } from '../sim/catalog';
import './audit.css';
import { LoadCurve } from './LoadCurve';
import { useBacktest } from '../backtest-ui/store';
import { backtestBoard } from '../backtest-ui/bridge';

const pct = (n: number) => `${(n * 100).toFixed(n > 0 && n < 0.01 ? 2 : n < 0.1 ? 1 : 0)}%`;
const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`);
const money = (n: number) => `${n < 0 ? '−' : '+'}$${Math.abs(n).toLocaleString('en-US')}`;
const SEV_LABEL: Record<Severity, string> = { critical: 'CRIT', major: 'MAJOR', minor: 'minor', ok: 'ok' };

/** the spec the audit runs on: the main board as it is now */
function currentSpec() {
  const { boards, settings } = useSim.getState();
  const { nodes, edges } = boards.main;
  return { ...graphToSpec(nodes, edges, boards.main.title || 'Sandbox'), pricing: settings.pricing, ...(settings.commitment !== 'none' ? { commitment: settings.commitment } : {}) };
}

export async function runAudit() {
  const s = useSim.getState();
  const spec = currentSpec();
  s.setAudit({ status: 'running', progress: null, error: null, selected: null });
  try {
    const result = await auditInBrowser(
      spec,
      // the board's idle trickle says nothing about failures: below 100 req/s the audit picks its own
      // load (half of what the design can take) and the panel says so
      { rps: s.traffic >= 100 ? s.traffic : undefined, readRatio: s.readRatio, incidentCostPerMinute: s.audit.costPerMinute || undefined, slo: { maxErrorRate: s.settings.sloErrorRate, maxP99Ms: s.settings.sloP99Ms } },
      (progress) => useSim.getState().setAudit({ progress }),
    );
    useSim.getState().setAudit({ status: 'done', result, specKey: JSON.stringify(spec), progress: null });
  } catch (e) {
    useSim.getState().setAudit({ status: 'error', error: e instanceof Error ? e.message : String(e), progress: null });
  }
}

function recoveryText(f: Finding): string {
  const i = f.impact;
  if (f.kind === 'headroom') return '';
  if (f.severity === 'ok') return 'absorbed';
  if (i.recoveryS === null) return 'never recovers';
  if (i.selfHealS !== null && i.selfHealS > 0 && f.kind !== 'surge') return `heals in ${i.selfHealS}s`;
  return `down while it lasts`;
}

export function replay(f: Finding) {
  const sc = f.scenario as { duration: number; rps?: number; traffic?: { at: number; rps: number }[]; events?: { at: number; action: SimAction; note?: string }[] };
  const events = (sc.events ?? []).map((e, i) => ({ ...e, note: e.note ?? (i === 0 ? `▶ ${f.title}` : '✓ fault cleared') }));
  useSim.getState().play({ title: f.title, duration: sc.duration, rps: sc.rps ?? 0, traffic: sc.traffic ?? null, events, findingId: f.id });
}

function toStudio(f: Finding) {
  const s = useSim.getState();
  const r = s.audit.result;
  if (!r) return;
  const m = s.boards.main;
  const live = s.scrub?.live.nodes ?? m.nodes;
  // the clip starts from a healthy board
  const healthy = live.map((n) => (isSystem(n) ? { ...n, selected: false, data: { ...n.data, alive: true, down: 0, degraded: undefined, faultRate: undefined, faultLatencyMs: undefined } } : { ...n, selected: false }));
  const ep = registerEpisode(episodeFromFinding(f, r, cleanGraph({ nodes: healthy, edges: m.edges }), m.title));
  s.setMode('studio');
  useSim.getState().loadEpisode(ep.id);
  useSim.getState().toast('good', 'Studio clip ready — press play, or render it with the recorder');
}

function FindingRow({ f, open, names }: { f: Finding; open: boolean; names: Map<string, string> }) {
  const fromBacktest = useBacktest((s) => !!s.origin);
  const { setAudit, applyFix } = useSim.getState();
  const nm = (id: string) => names.get(id) ?? id;
  const bar = Math.min(1, f.kind === 'headroom' ? 0 : f.impact.errorRate);
  return (
    <div className={`au-row sev-${f.severity} ${open ? 'open' : ''}`}>
      <button className="au-row-head" onClick={() => setAudit({ selected: open ? null : f.id })}>
        <span className="au-sev">{SEV_LABEL[f.severity]}</span>
        <span className="au-title">{f.title}</span>
        <span className="au-impact">
          {f.kind === 'headroom' ? (
            <em>{nm(f.target)}</em>
          ) : (
            <>
              <i className="au-bar">
                <i style={{ width: `${Math.max(bar > 0 ? 3 : 0, bar * 100)}%` }} />
              </i>
              <em>{f.severity === 'ok' ? '—' : pct(f.impact.errorRate)}</em>
            </>
          )}
        </span>
      </button>
      {open && (
        <div className="au-detail">
          <p>{f.explanation}</p>
          <div className="au-facts">
            {f.kind !== 'headroom' && (
              <>
                <span>
                  p99 <b>{ms(f.impact.peakP99Ms)}</b>
                </span>
                <span>
                  out of SLO <b>{f.impact.breachS}s</b>
                </span>
                <span>{recoveryText(f)}</span>
              </>
            )}
            {f.costAtRisk ? (
              <span className="bad">
                <b>${f.costAtRisk.toLocaleString('en-US')}</b> at risk
              </span>
            ) : null}
          </div>
          {f.blastRadius.length > 0 && (
            <div className="au-blast">
              <span>blast radius</span>
              {f.blastRadius.map((id) => (
                <code key={id}>{nm(id)}</code>
              ))}
            </div>
          )}
          {f.kind !== 'headroom' && (
            <div className="au-acts">
              <button className="chip" onClick={() => replay(f)} title="Play this incident on the board, from a clean start">
                <Play size={13} /> Replay on the board
              </button>
              <button className="chip" onClick={() => toStudio(f)} title={f.fixes.length ? 'A clip for posts and talks: this design vs the fixed one, same incident' : 'A clip of this incident for posts and talks'}>
                <Clapperboard size={13} /> Studio clip
              </button>
            </div>
          )}
          {f.fixes.length > 0 && (
            <div className="au-fixes">
              <div className="au-fixes-h">verified fixes — the same incident, re-run</div>
              {f.fixes.map((x, i) => (
                <div key={i} className="au-fix">
                  <div className="au-fix-main">
                    <div className="au-fix-title">{x.title}</div>
                    <div className="au-fix-why">{x.why}</div>
                    {f.kind !== 'headroom' && (
                      <div className="au-fix-delta">
                        errors <s>{pct(f.impact.errorRate)}</s> → <b>{pct(x.after.errorRate)}</b> · p99 <s>{ms(f.impact.peakP99Ms)}</s> → <b>{ms(x.after.peakP99Ms)}</b>
                      </div>
                    )}
                  </div>
                  <div className="au-fix-side">
                    <span className={`au-after sev-${x.after.severity}`}>→ {SEV_LABEL[x.after.severity]}</span>
                    <span className="au-cost">{money(x.monthlyDelta)}/mo</span>
                    <button className="chip good" onClick={() => applyFix(f.id, i)}>
                      <Wrench size={12} /> Apply
                    </button>
                    {fromBacktest && (
                      <button className="chip" title="Replay this fix over the real history the board came from" onClick={() => backtestBoard({ title: x.title, changes: x.changes })}>
                        Backtest
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {f.fixes.length === 0 && (f.severity === 'critical' || f.severity === 'major') && <div className="au-nofix">No single change fixed it in simulation — this one needs a design decision.</div>}
        </div>
      )}
    </div>
  );
}

/** the design misses the SLO before anything goes wrong: every incident would be graded from an
 *  outage, so say why — too little capacity, or a latency the SLO never allows — and offer the way out */
function OutOfSlo({ r, names }: { r: AuditResult; names: Map<string, string> }) {
  const latencyBound = r.baseline.errorRate <= r.slo.maxErrorRate && r.baseline.p99Ms > r.slo.maxP99Ms;
  if (latencyBound) {
    const suggest = Math.min(3000, Math.ceil((r.baseline.p99Ms * 1.25) / 50) * 50);
    return (
      <div className="au-stale au-overloaded">
        Nothing is overloaded, but p99 is {ms(r.baseline.p99Ms)} against the {ms(r.slo.maxP99Ms)} SLO: this design&rsquo;s normal latency (a slow dependency, a long chain of calls) already misses it, so every incident below is graded from an outage. Shorten the slow path, or{' '}
        <button
          className="linkish"
          onClick={() => {
            useSim.getState().setSetting('sloP99Ms', suggest);
            void runAudit();
          }}
        >
          audit against a {ms(suggest)} p99 SLO
        </button>
        .
      </div>
    );
  }
  if (r.headroom.maxRps <= 0) return null;
  const half = Math.max(10, Math.round(r.headroom.maxRps / 2));
  return (
    <div className="au-stale au-overloaded">
      At {r.load.rps.toLocaleString('en-US')} req/s this design misses the SLO with nothing broken: {names.get(r.headroom.limitedBy ?? '') ?? r.headroom.limitedBy ?? 'it'} tops out near {Math.round(r.headroom.maxRps).toLocaleString('en-US')} req/s, so every incident below starts from an outage. Fix the capacity first (the last row has verified fixes), or{' '}
      <button
        className="linkish"
        onClick={() => {
          useSim.getState().setTraffic(half);
          void runAudit();
        }}
      >
        audit at {half.toLocaleString('en-US')} req/s
      </button>
      .
    </div>
  );
}

export function AuditPanel() {
  const audit = useSim((s) => s.audit);
  const traffic = useSim((s) => s.traffic);
  const nodes = useSim((s) => s.boards.main.nodes);
  const edges = useSim((s) => s.boards.main.edges);
  const playback = useSim((s) => s.playback);
  const { setAuditOpen, setAudit, stopPlayback } = useSim.getState();
  const r = audit.result;
  const names = useMemo(() => new Map(nodes.filter(isSystem).map((n) => [n.id, n.data.name])), [nodes]);
  const stale = useMemo(() => !!r && audit.specKey !== JSON.stringify(currentSpec()), [r, audit.specKey, nodes, edges]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="audit panel">
      <div className="au-head">
        <ShieldAlert size={16} />
        <div>
          <div className="au-h1">Failure audit</div>
          <div className="au-h2">what breaks first, and what it costs</div>
        </div>
        <button className="icon-btn small" onClick={() => setAuditOpen(false)} title="Close">
          <X size={14} />
        </button>
      </div>

      <div className="au-inputs">
        <label title={r && r.load.rps !== traffic ? `The board runs at ${traffic} req/s, too light to tell; the audit used half of what the design can take. Set the board's traffic to 100 req/s or more to audit at it.` : 'The audit runs at the board\'s traffic'}>
          load <b>{(r ? r.load.rps : traffic).toLocaleString('en-US')}</b> req/s{r && r.load.rps !== traffic && <span className="au-auto"> · half its limit</span>}
        </label>
        <label title="What a minute of full outage costs the business — prices every incident">
          outage $
          <input type="number" min={0} step={100} value={audit.costPerMinute || ''} placeholder="0" onChange={(e) => setAudit({ costPerMinute: Math.max(0, +e.target.value) })} />
          /min
        </label>
        <button className="chip au-run" disabled={audit.status === 'running'} onClick={runAudit}>
          {audit.status === 'running' ? 'Running…' : r ? 'Re-run' : 'Run audit'}
        </button>
      </div>

      {audit.status === 'running' && (
        <div className="au-progress">
          <i>
            <i style={{ width: `${audit.progress ? (audit.progress.done / audit.progress.total) * 100 : 4}%` }} />
          </i>
          <span>{audit.progress ? `${audit.progress.done}/${audit.progress.total} · ${audit.progress.label}` : 'finding the breaking point…'}</span>
        </div>
      )}
      {audit.error && <div className="an-error">{audit.error}</div>}

      {!r && audit.status !== 'running' && (
        <div className="au-empty">
          Replays a minute at the current traffic once per thing that goes wrong in production — each component dying, each dependency turning slow or erroring, caches restarting cold, zones going dark, a 3× surge — and finds the breaking point. Fixes are verified by re-running the incident, then priced.
        </div>
      )}

      {r && (
        <>
          {stale && <div className="au-stale">The board changed since this audit — re-run to update.</div>}
          <div className="au-summary">
            <div className={`au-score ${r.score >= 80 ? 'good' : r.score >= 50 ? 'warn' : 'bad'}`}>
              {r.score}
              <small>/100</small>
            </div>
            <div className="au-sumlines">
              <div>
                survives <b>{r.survived}</b> of {r.total} incidents
              </div>
              {r.availability && (
                <div title={`What the structure promises from the providers' published SLAs, not measured: components in sequence multiply their availability, redundant ones back each other up. ${r.availability.weakest.length ? `Costs the most downtime: ${r.availability.weakest.map((w) => `${w.name} ${downtimeText(w.downtimeHoursPerYear)}/yr`).join(', ')}.` : ''}`}>
                  <span title="From published SLAs, not measured">available <b>{availPct(r.availability.estimate)}</b> by SLA · {downtimeText(r.availability.downtimeHoursPerYear)}/yr down</span>
                  {r.availability.weakest[0] ? <> · {r.availability.weakest[0].name} the weakest link</> : null}
                </div>
              )}
              <div>
                headroom <b>{r.headroom.ratio.toFixed(1)}×</b> · {names.get(r.headroom.limitedBy ?? '') ?? r.headroom.limitedBy ?? '—'} first
              </div>
              <div>
                runs at <b>${r.baseline.monthly.toLocaleString('en-US')}</b>/mo{!r.baseline.meetsSlo && <span className="bad"> · out of SLO already</span>}
              </div>
            </div>
          </div>
          {!r.baseline.meetsSlo && <OutOfSlo r={r} names={names} />}
          {r.curve?.length > 1 && <LoadCurve curve={r.curve} now={r.load.rps} limit={r.headroom.maxRps} sloP99={r.slo.maxP99Ms} />}
          <div className="au-list">
            {r.findings.map((f) => (
              <FindingRow key={f.id} f={f} open={audit.selected === f.id} names={names} />
            ))}
          </div>
          <div className="au-foot">
            <button
              className="chip"
              onClick={() => {
                navigator.clipboard?.writeText(auditMarkdown(r));
                useSim.getState().toast('good', 'Audit report copied (Markdown)');
              }}
            >
              <ClipboardCopy size={13} /> Copy report
            </button>
            <button
              className="chip"
              title="A self-contained HTML report to attach to a design review"
              onClick={() => {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(new Blob([auditHtml(r)], { type: 'text/html' }));
                a.download = `failure-audit-${useSim.getState().boards.main.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'design'}.html`;
                a.click();
              }}
            >
              HTML
            </button>
            <span>
              {r.findings.length} scenarios · {(r.wallMs / 1000).toFixed(1)}s
            </span>
          </div>
        </>
      )}

      {playback && (
        <div className="au-playing">
          <span>
            replaying <b>{playback.title}</b>
          </span>
          <button className="chip" onClick={stopPlayback}>
            <Square size={11} /> Stop
          </button>
        </div>
      )}
    </div>
  );
}
