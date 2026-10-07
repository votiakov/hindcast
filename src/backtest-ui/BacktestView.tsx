import { useEffect, useMemo, useState } from 'react';
import { useBacktest, strategyName, type Tab } from './store';
import { AXIS_W, Pane, TimeAxis, bandPath, candles, makeScale, path, useWidth, yScale } from './chart';
import { headline } from '../backtest/report';
import type { StrategyResult } from '../backtest/backtest';
import { closeOutage, loadReference, loadReferenceIndex, openOutage, REFERENCES, openWorkspaceFiles } from './workspace';
import { OUTAGES } from '../backtest/outages';
import { openMomentOnBoard } from './bridge';
import { cardData } from '../backtest/card';
import { useSim, type Mode } from '../sim/store';
import './terminal.css';

export const STRAT_COLORS = ['#f2a93b', '#3fc1d9', '#b48cf2', '#ef7fb1', '#9bd35a'];
const ASBUILT = '#8193a3';
const MEASURED = '#e6edf3';

const ms = (v: number) => (v >= 10_000 ? `${(v / 1000).toFixed(0)}s` : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}`);
const pct = (v: number) => `${(v * 100).toFixed(v < 0.01 ? 2 : v < 0.1 ? 1 : 0)}%`;
const usd = (v: number) => `$${Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(Math.abs(v) < 1 ? 3 : 2)}`;
const signedUsd = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}$${Math.abs(v) >= 100 ? Math.round(Math.abs(v)).toLocaleString('en-US') : Math.abs(v).toFixed(2)}`;
const when = (t: number) => new Date(t * 1000).toISOString().slice(5, 16).replace('T', ' ');

function Bar() {
  const w = useBacktest((s) => s.workspace);
  const r = useBacktest((s) => s.result);
  const view = useBacktest((s) => s.view);
  const setView = useBacktest((s) => s.setView);
  const computing = useBacktest((s) => s.computing);
  const setMode = useSim((s) => s.setMode);
  const n = r?.t.length ?? 0;
  const stepS = r?.window.stepS ?? 60;
  const ranges = [
    ['ALL', n],
    ['24H', Math.round(86400 / stepS)],
    ['6H', Math.round(21600 / stepS)],
    ['1H', Math.round(3600 / stepS)],
    ['15M', Math.round(900 / stepS)],
  ].filter(([, k], idx) => idx === 0 || (k as number) < n) as [string, number][];
  const cur = view ? view[1] - view[0] : n;
  return (
    <div className="bt-bar">
      <span className="bt-brand">Bottleneck</span>
      <span className="bt-sym">{w?.model.name ?? '—'}</span>
      {ranges.map(([label, k]) => (
        <button key={label} className={`bt-chip ${cur === k ? 'on' : ''}`} onClick={() => setView(label === 'ALL' ? null : [Math.max(0, (view?.[1] ?? n) - k), view?.[1] ?? n])}>
          {label}
        </button>
      ))}
      {r && <span className="bt-chip dim">{r.window.stepS >= 60 ? `${r.window.stepS / 60}m` : `${r.window.stepS}s`} buckets</span>}
      {computing && <span className="bt-chip dim">computing…</span>}
      <span className="bt-spacer" />
      {r && (
        <span className="bt-dim">
          SLO p99 ≤ {r.slo.p99Ms} ms · err ≤ {pct(r.slo.errorRate)}
        </span>
      )}
      <select className="bt-select" aria-label="Reference system" value={w?.id ?? ''} onChange={(e) => loadReference(e.target.value)}>
        {!REFERENCES.some((x) => x.id === w?.id) && <option value={w?.id ?? ''}>{w?.name ?? 'workspace'}</option>}
        {REFERENCES.map((x) => (
          <option key={x.id} value={x.id}>
            {x.label}
          </option>
        ))}
      </select>
      {r && (
        <button
          className="bt-chip"
          title="A Studio card / clip of the focused strategy, at post size"
          onClick={() => {
            try {
              localStorage.setItem('bottleneck.card', JSON.stringify(cardData(r, useBacktest.getState().focus)));
            } catch {
              /* storage full or blocked: the card page says so */
            }
            window.open(`${location.pathname}?render=1&card=local&play=1&aspect=4:5`, '_blank');
          }}
        >
          Card ↗
        </button>
      )}
      <select className="bt-select" aria-label="Replay a public outage" value={w?.outage?.outage.id ?? ''} onChange={(e) => (e.target.value ? openOutage(e.target.value) : closeOutage())}>
        <option value="">{w?.outage ? '← back to the history' : 'Replay an outage…'}</option>
        {OUTAGES.map((o) => (
          <option key={o.id} value={o.id}>
            {o.title.split(' — ')[0]}
          </option>
        ))}
      </select>
      <label className="bt-chip">
        Open files…
        <input type="file" multiple hidden onChange={(e) => e.target.files && openWorkspaceFiles([...e.target.files])} />
      </label>
      <select className="bt-select" aria-label="Other views" value="" onChange={(e) => e.target.value && setMode(e.target.value as Mode)}>
        <option value="">Board ▾</option>
        <option value="sandbox">Sandbox</option>
        <option value="compare">Compare</option>
        <option value="lesson">Lessons</option>
        <option value="home">Live</option>
        <option value="studio">Studio</option>
      </select>
    </div>
  );
}

function OutageBanner() {
  const w = useBacktest((s) => s.workspace);
  const r = useBacktest((s) => s.result);
  const o = w?.outage;
  if (!o || !r) return null;
  const b = r.baseline.summary;
  return (
    <div className="bt-outage">
      <div className="bt-outage-head">
        <b>{o.outage.title}</b>
        <span className={b.minutesOutOfSlo.p50 < 1 ? 'pos' : 'neg'}>
          {w!.name} as built: {b.minutesOutOfSlo.p50 < 1 ? 'survives' : `${Math.round(b.minutesOutOfSlo.p50)} min out of SLO, ${Math.round(b.failedRequests.p50).toLocaleString('en-US')} failed requests`}
        </span>
        <button className="bt-chip" onClick={closeOutage}>
          ← back to the history
        </button>
      </div>
      <div className="bt-outage-what">{o.outage.what}</div>
      <div className="bt-outage-tl">
        {o.outage.timeline.map((t, i) => (
          <span key={i}>
            <b>{t.at}</b> {t.text}
          </span>
        ))}
      </div>
      <div className="bt-dim small">
        Replayed at {o.baseRps.toFixed(1)} req/s normal load · roles: {Object.entries(o.roles).map(([role, ids]) => `${role} → ${ids.join(', ') || 'nothing'}`).join(' · ')} · assumptions: {o.outage.assumptions.join(' ')} · source:{' '}
        {o.outage.sources.map((x) => (
          <a key={x.url} href={x.url} target="_blank" rel="noreferrer">
            {x.label}
          </a>
        ))}
        {o.warnings.map((x) => (
          <div key={x} className="neg">
            {x}
          </div>
        ))}
      </div>
    </div>
  );
}

function Panes() {
  const r = useBacktest((s) => s.result)!;
  const w = useBacktest((s) => s.workspace)!;
  const view = useBacktest((s) => s.view);
  const hover = useBacktest((s) => s.hover);
  const setHover = useBacktest((s) => s.setHover);
  const setView = useBacktest((s) => s.setView);
  const focus = useBacktest((s) => s.focus);
  const [ref, width] = useWidth<HTMLDivElement>();
  const n = r.t.length;
  const [i0, i1] = view ?? [0, n];
  const s = makeScale(i0, i1, width);
  const visible = r.strategies.map((st, k) => ({ st, k, color: STRAT_COLORS[k % STRAT_COLORS.length] })).filter(({ k }) => w.strategies.filter((x) => !x.error)[k]?.visible !== false);
  const focused = r.strategies[focus] ?? r.strategies[0];
  const at = hover ?? i1 - 1;
  const pick = (i: number) => openMomentOnBoard(i, focused ? focus : -1);

  // zoom with the wheel around the cursor
  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
    const span = i1 - i0;
    const c = hover ?? Math.round((i0 + i1) / 2);
    const k = e.deltaY > 0 ? 1.25 : 0.8;
    const ns = Math.max(12, Math.min(n, Math.round(span * k)));
    let a = Math.round(c - ((c - i0) / span) * ns);
    a = Math.max(0, Math.min(n - ns, a));
    setView(ns >= n ? null : [a, a + ns]);
  };

  // ---- p99 ----
  const p99Vals: number[] = [];
  for (let i = i0; i < i1; i++) {
    const v = r.actual.p99Ms[i];
    if (v !== null && v > 0) p99Vals.push(v);
    p99Vals.push(r.baseline.series.p99Ms.hi[i]);
    for (const { st } of visible) p99Vals.push(st.series.p99Ms.hi[i]);
  }
  const lo = Math.max(1, Math.min(...p99Vals.filter((v) => v > 0)) * 0.7);
  const hi = Math.max(r.slo.p99Ms * 1.4, ...p99Vals) * 1.3;
  const yp = yScale(lo, hi, 300, { log: true, fmt: ms });
  const cs = candles(r.actual.p99Ms, i0, i1, Math.max(40, Math.floor(s.plotW / 7)));
  const cw = Math.max(1.2, Math.min(9, ((s.plotW - 8) / Math.max(1, i1 - i0)) * cs.size * 0.62));
  const gridLines = Array.from({ length: 6 }, (_, k) => Math.round(i0 + ((i1 - 1 - i0) * k) / 5));
  const legendP99 = [
    { label: `measured p99 · ${cs.size > 1 ? `${cs.size}-bucket` : 'bucket'} candles`, color: MEASURED, value: r.actual.p99Ms[at] !== null ? ms(r.actual.p99Ms[at]!) : '—' },
    { label: 'as built (model)', color: ASBUILT, value: ms(r.baseline.series.p99Ms.p50[at]) },
    ...visible.map(({ st, color }) => ({ label: st.name, color, value: ms(st.series.p99Ms.p50[at]) })),
  ];

  // ---- errors ----
  const errMax = Math.max(r.slo.errorRate * 2, ...Array.from({ length: i1 - i0 }, (_, k) => Math.max(r.actual.errorRate[i0 + k] ?? 0, r.baseline.series.errorRate.p50[i0 + k], ...visible.map(({ st }) => st.series.errorRate.hi[i0 + k])))) * 1.1;
  const ye = yScale(0, Math.min(1, errMax), 110, { fmt: pct });
  const bw = Math.max(1, ((s.plotW - 8) / Math.max(1, i1 - i0)) * 0.7);

  // ---- cost ----
  const costVals: number[] = [];
  for (let i = i0; i < i1; i++) {
    if (r.actual.costPerHour[i] !== null) costVals.push(r.actual.costPerHour[i]!);
    costVals.push(r.baseline.series.costPerHour.hi[i]);
    for (const { st } of visible) costVals.push(st.series.costPerHour.hi[i]);
  }
  const yc = yScale(0, Math.max(...costVals) * 1.15, 110, { fmt: usd });

  // ---- equity: $ saved vs as built ----
  const saved = visible.map(({ st, color, k }) => {
    const b = r.baseline.series.cumulativeCost;
    const mk = (a: number[], base: number[]) => a.map((v, i) => base[i] - v - (base[i0] - a[i0]));
    return { st, color, k, p50: mk(st.series.cumulativeCost.p50, b.p50), lo: mk(st.series.cumulativeCost.hi, b.p50), hi: mk(st.series.cumulativeCost.lo, b.p50) };
  });
  const eqVals = saved.flatMap((x) => [...x.lo.slice(i0, i1), ...x.hi.slice(i0, i1)]);
  const eqLo = Math.min(0, ...eqVals);
  const eqHi = Math.max(1e-6, ...eqVals);
  const yq = yScale(eqLo - (eqHi - eqLo) * 0.08, eqHi + (eqHi - eqLo) * 0.15, 120, { fmt: signedUsd });

  // focused strategy: shade its out-of-SLO buckets on the p99 pane
  const breach = focused?.incidents ?? [];
  const idxOf = (t: number) => Math.round((t - r.t[0]) / r.window.stepS);

  return (
    <div className="bt-panes" ref={ref} onWheel={onWheel}>
      <Pane s={s} h={300} ys={yp} legend={legendP99} hover={hover} onHover={setHover} onPick={pick} gridLines={gridLines}>
        {breach.map((b) => {
          const a = Math.max(i0, idxOf(b.start));
          const z = Math.min(i1 - 1, idxOf(b.end));
          if (z < i0 || a > i1) return null;
          return <rect key={b.start} x={s.x(a) - 1} y={0} width={Math.max(2, s.x(z) - s.x(a) + 2)} height={300} className="bt-breach" />;
        })}
        <line x1={0} x2={s.plotW} y1={yp.y(r.slo.p99Ms)} y2={yp.y(r.slo.p99Ms)} className="bt-slo" />
        {w.outage &&
          [...new Map(w.outage.faults.map((f) => [f.at, f])).values()].map((f, k) => {
            const i = Math.round(f.at / r.window.stepS);
            if (i < i0 || i >= i1) return null;
            return (
              <g key={k} className="bt-marker">
                <line x1={s.x(i)} x2={s.x(i)} y1={20} y2={300} />
                <text x={s.x(i) + 4} y={58 + (k % 4) * 13}>
                  {(f.note ?? '').replace(/ \([^)]*\)$/, '').slice(0, 48)}
                </text>
              </g>
            );
          })}
        <path d={bandPath(s, yp.y, r.baseline.series.p99Ms)} fill={ASBUILT} opacity={0.1} />
        <path d={path(s, yp.y, r.baseline.series.p99Ms.p50)} fill="none" stroke={ASBUILT} strokeDasharray="3 3" strokeWidth={1} />
        {cs.list.map((c) => {
          const up = c.c > c.o;
          const col = up ? 'var(--bt-red)' : 'var(--bt-green)';
          const x = s.x(c.i);
          return (
            <g key={c.i}>
              <line x1={x} x2={x} y1={yp.y(c.h)} y2={yp.y(c.l)} stroke={col} strokeWidth={1} />
              <rect x={x - cw / 2} y={Math.min(yp.y(c.o), yp.y(c.c))} width={cw} height={Math.max(1, Math.abs(yp.y(c.o) - yp.y(c.c)))} fill={col} />
            </g>
          );
        })}
        {visible.map(({ st, color, k }) => (
          <g key={st.name} opacity={k === focus ? 1 : 0.55}>
            {k === focus && <path d={bandPath(s, yp.y, st.series.p99Ms)} fill={color} opacity={0.15} />}
            <path d={path(s, yp.y, st.series.p99Ms.p50)} fill="none" stroke={color} strokeWidth={k === focus ? 1.6 : 1} />
          </g>
        ))}
        {focused && idxOf(focused.worst.t) >= i0 && idxOf(focused.worst.t) < i1 && focused.worst.p99Ms > r.slo.p99Ms && (
          <g className="bt-worst" onClick={() => pick(idxOf(focused.worst.t))}>
            <rect x={Math.min(s.plotW - 120, s.x(idxOf(focused.worst.t)) + 6)} y={Math.max(24, yp.y(focused.worst.p99Ms) - 10)} width={112} height={18} />
            <text x={Math.min(s.plotW - 114, s.x(idxOf(focused.worst.t)) + 12)} y={Math.max(24, yp.y(focused.worst.p99Ms) - 10) + 13}>
              worst {when(focused.worst.t).slice(6)} · {ms(focused.worst.p99Ms)}
            </text>
          </g>
        )}
      </Pane>
      <Pane s={s} h={110} ys={ye} legend={[{ label: 'errors', color: MEASURED, value: r.actual.errorRate[at] !== null ? pct(r.actual.errorRate[at]!) : '—' }, ...visible.map(({ st, color }) => ({ label: st.name, color, value: pct(st.series.errorRate.p50[at]) }))]} hover={hover} onHover={setHover} onPick={pick} gridLines={gridLines}>
        <line x1={0} x2={s.plotW} y1={ye.y(r.slo.errorRate)} y2={ye.y(r.slo.errorRate)} className="bt-slo" />
        {Array.from({ length: i1 - i0 }, (_, k) => i0 + k).map((i) => {
          const v = r.actual.errorRate[i];
          if (v === null || v <= 0) return null;
          return <rect key={i} x={s.x(i) - bw / 2} y={ye.y(Math.min(v, ye.ticks.at(-1)! * 1.2))} width={bw} height={ye.y(0) - ye.y(Math.min(v, ye.ticks.at(-1)! * 1.2))} fill={v > r.slo.errorRate ? 'var(--bt-red)' : 'var(--bt-mute)'} />;
        })}
        <path d={path(s, ye.y, r.baseline.series.errorRate.p50)} fill="none" stroke={ASBUILT} strokeDasharray="3 3" />
        {visible.map(({ st, color, k }) => (
          <path key={st.name} d={path(s, ye.y, st.series.errorRate.p50)} fill="none" stroke={color} strokeWidth={k === focus ? 1.5 : 1} opacity={k === focus ? 1 : 0.55} />
        ))}
      </Pane>
      <Pane s={s} h={110} ys={yc} legend={[{ label: 'cost $/h (bill)', color: MEASURED, value: r.actual.costPerHour[at] !== null ? usd(r.actual.costPerHour[at]!) : '—' }, { label: 'as built', color: ASBUILT, value: usd(r.baseline.series.costPerHour.p50[at]) }, ...visible.map(({ st, color }) => ({ label: st.name, color, value: usd(st.series.costPerHour.p50[at]) }))]} hover={hover} onHover={setHover} onPick={pick} gridLines={gridLines}>
        <path d={path(s, yc.y, r.actual.costPerHour)} fill="none" stroke={MEASURED} strokeWidth={1} opacity={0.8} />
        <path d={path(s, yc.y, r.baseline.series.costPerHour.p50)} fill="none" stroke={ASBUILT} strokeDasharray="3 3" />
        {visible.map(({ st, color, k }) => (
          <path key={st.name} d={path(s, yc.y, st.series.costPerHour.p50)} fill="none" stroke={color} strokeWidth={k === focus ? 1.5 : 1} opacity={k === focus ? 1 : 0.55} />
        ))}
      </Pane>
      <Pane s={s} h={120} ys={yq} legend={[{ label: 'saved vs as built, $', color: 'var(--bt-dim)' }, ...saved.map((x) => ({ label: x.st.name, color: x.color, value: signedUsd(x.p50[at]) }))]} hover={hover} onHover={setHover} onPick={pick} gridLines={gridLines}>
        <line x1={0} x2={s.plotW} y1={yq.y(0)} y2={yq.y(0)} className="bt-zero" />
        {saved.map((x) => (
          <g key={x.st.name} opacity={x.k === focus ? 1 : 0.55}>
            {x.k === focus && <path d={bandPath(s, yq.y, { p50: x.p50, lo: x.lo, hi: x.hi })} fill={x.color} opacity={0.16} />}
            <path d={path(s, yq.y, x.p50)} fill="none" stroke={x.color} strokeWidth={x.k === focus ? 1.6 : 1} />
          </g>
        ))}
      </Pane>
      <TimeAxis s={s} t={r.t} hover={hover} />
      <div className="bt-hint" style={{ right: AXIS_W + 8 }}>
        ⌘/ctrl + wheel to zoom · click any moment to open it on the board
      </div>
    </div>
  );
}

function Watch() {
  const r = useBacktest((s) => s.result)!;
  const w = useBacktest((s) => s.workspace)!;
  const focus = useBacktest((s) => s.focus);
  const setFocus = useBacktest((s) => s.setFocus);
  const toggle = useBacktest((s) => s.toggle);
  const addStrategy = useBacktest((s) => s.addStrategy);
  const ok = w.strategies.filter((x) => !x.error);
  const focused = r.strategies[focus];
  const checks = r.accuracy.flatMap((a) => a.checks).filter((c) => c.metric !== 'errors');
  return (
    <aside className="bt-watch">
      <h4>Strategies · ranked</h4>
      <div className="bt-row head">
        <span />
        <span>strategy</span>
        <span>$/mo</span>
        <span>SLO min</span>
      </div>
      <div className="bt-row base">
        <span />
        <span>As built</span>
        <span>{usd(r.baseline.summary.monthly.p50)}</span>
        <span>{Math.round(r.baseline.summary.minutesOutOfSlo.p50)}</span>
      </div>
      {r.ranking.map((k) => {
        const idx = r.strategies.findIndex((x) => x.name === k.name);
        const st = r.strategies[idx];
        const color = STRAT_COLORS[idx % STRAT_COLORS.length];
        return (
          <div key={k.name} className={`bt-row ${idx === focus ? 'focus' : ''}`} onClick={() => setFocus(idx)}>
            <button className="bt-eye" aria-label={`${ok[idx]?.visible === false ? 'Show' : 'Hide'} ${k.name}`} style={{ borderColor: color, background: ok[idx]?.visible === false ? 'transparent' : color }} onClick={(e) => (e.stopPropagation(), toggle(w.strategies.indexOf(ok[idx])))} />
            <span title={st.description}>{k.name}</span>
            <span className={k.monthlyDelta < -0.5 ? 'pos' : k.monthlyDelta > 0.5 ? 'neg' : ''}>{signedUsd(k.monthlyDelta)}</span>
            <span className={k.minutesOutOfSloDelta > 0.5 ? 'neg' : k.minutesOutOfSloDelta < -0.5 ? 'pos' : ''}>{k.minutesOutOfSloDelta > 0 ? '+' : ''}{Math.round(k.minutesOutOfSloDelta)}</span>
          </div>
        );
      })}
      {w.strategies.filter((x) => x.error).map((x, i) => (
        <div key={i} className="bt-row err" title={x.error}>
          <span />
          <span>{strategyName(x.yaml)}</span>
          <span className="neg" style={{ gridColumn: 'span 2' }}>
            invalid
          </span>
        </div>
      ))}
      <button className="bt-chip add" onClick={() => addStrategy(`name: New strategy\ndescription: what would have happened if…\nchanges:\n  - service: ${Object.keys(w.model.services).find((k) => !w.model.services[k].hostedBy) ?? 'api'}\n    replicas: 2\n`)}>
        + strategy
      </button>
      {focused && (
        <>
          <h4>Worst moment · {focused.name}</h4>
          <div className="bt-worstbox" onClick={() => openMomentOnBoard(Math.round((focused.worst.t - r.t[0]) / r.window.stepS), focus)}>
            <div>{when(focused.worst.t)}</div>
            <div className={focused.worst.p99Ms > r.slo.p99Ms || focused.worst.errorRate > r.slo.errorRate ? 'neg' : ''}>
              p99 {ms(focused.worst.p99Ms)} ms · {pct(focused.worst.errorRate)} err
            </div>
            <div className="bt-dim">{focused.worst.why}</div>
            <div className="bt-link">open on board ↗</div>
          </div>
        </>
      )}
      <h4>Model accuracy</h4>
      {checks.length ? (
        r.accuracy.map((a, k) => (
          <div key={k} className="bt-acc" title={a.label}>
            <div className="bt-dim small">{a.method === 'reference' ? 'vs recorded runs it never saw' : 'holdout: last 30% of the history'}</div>
            {a.checks
              .filter((c) => c.metric !== 'errors')
              .map((c, i) => (
                <div key={i} title={c.note}>
                  <span>{c.metric}</span>
                  <span className={c.pass ? 'pos' : 'neg'}>{(c.error * 100).toFixed(0)}%</span>
                  <span className="bt-dim">≤{c.tolerance * 100}%</span>
                </div>
              ))}
          </div>
        ))
      ) : (
        <div className="bt-dim small">No accuracy record yet — calibrate with a holdout to measure one.</div>
      )}
    </aside>
  );
}

function Stat({ k, v, s, tone }: { k: string; v: string; s?: string; tone?: 'pos' | 'neg' }) {
  return (
    <div className="bt-stat">
      <div className="k">{k}</div>
      <div className={`v ${tone ?? ''}`}>{v}</div>
      {s && <div className="s">{s}</div>}
    </div>
  );
}

function Overview({ st }: { st: StrategyResult | undefined }) {
  const r = useBacktest((s) => s.result)!;
  if (!st) {
    const b = r.baseline.summary;
    return (
      <div className="bt-stats">
        <Stat k="$/month as built" v={usd(b.monthly.p50)} />
        <Stat k="Min out of SLO" v={String(Math.round(b.minutesOutOfSlo.p50))} />
        <Stat k="Failed requests" v={Math.round(b.failedRequests.p50).toLocaleString('en-US')} />
        <Stat k="Error budget used" v={pct(b.errorBudgetUsed.p50)} />
        <Stat k="Peak p99" v={ms(b.peakP99Ms.p50)} />
        <Stat k="Add a strategy" v="+" s="from the watchlist" />
      </div>
    );
  }
  const d = st.delta;
  const reps = Object.values(st.series.replicas).reduce((a, x) => a + x.reduce((p, v) => p + v, 0), 0) * (r.window.stepS / 3600);
  const repsB = Object.values(r.baseline.series.replicas).reduce((a, x) => a + x.reduce((p, v) => p + v, 0), 0) * (r.window.stepS / 3600);
  return (
    <>
      <div className="bt-verdict">
        <b>{st.name}</b> {headline(st, r.baseline)}.
      </div>
      <div className="bt-stats">
        <Stat k="Net $/month" v={signedUsd(d.monthly.p50)} s={`${signedUsd(d.monthly.lo)} … ${signedUsd(d.monthly.hi)}`} tone={d.monthly.p50 < 0 ? 'pos' : d.monthly.p50 > 0 ? 'neg' : undefined} />
        <Stat k="Min out of SLO" v={`${d.minutesOutOfSlo.p50 > 0 ? '+' : ''}${d.minutesOutOfSlo.p50.toFixed(1)}`} s={`${st.summary.minutesOutOfSlo.p50.toFixed(1)} total · ${d.minutesOutOfSlo.lo.toFixed(1)} … ${d.minutesOutOfSlo.hi.toFixed(1)}`} tone={d.minutesOutOfSlo.p50 > 0.5 ? 'neg' : d.minutesOutOfSlo.p50 < -0.5 ? 'pos' : undefined} />
        <Stat k="Failed requests" v={`${d.failedRequests.p50 > 0 ? '+' : ''}${Math.round(d.failedRequests.p50).toLocaleString('en-US')}`} s={`${Math.round(st.summary.failedRequests.p50).toLocaleString('en-US')} total`} tone={d.failedRequests.p50 > 1 ? 'neg' : d.failedRequests.p50 < -1 ? 'pos' : undefined} />
        <Stat k="Error budget used" v={pct(st.summary.errorBudgetUsed.p50)} s={`as built ${pct(r.baseline.summary.errorBudgetUsed.p50)}`} />
        <Stat k="Peak p99" v={ms(st.summary.peakP99Ms.p50)} s={when(st.worst.t)} />
        <Stat k="Replica-hours" v={reps.toFixed(reps < 10 ? 2 : 0)} s={`as built ${repsB.toFixed(repsB < 10 ? 2 : 0)}`} />
      </div>
    </>
  );
}

function Incidents({ st }: { st: StrategyResult | undefined }) {
  const r = useBacktest((s) => s.result)!;
  const focus = useBacktest((s) => s.focus);
  const list = (st ?? r.baseline).incidents;
  if (!list.length) return <div className="bt-empty">No time out of SLO in this window{st ? ` with ${st.name}` : ''}.</div>;
  return (
    <table className="bt-table">
      <thead>
        <tr>
          <th>from</th>
          <th>minutes</th>
          <th>peak p99</th>
          <th>peak errors</th>
          <th>why</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {list.map((i) => (
          <tr key={i.start}>
            <td>{when(i.start)}</td>
            <td>{i.minutes.toFixed(1)}</td>
            <td>{ms(i.peakP99Ms)} ms</td>
            <td>{pct(i.peakErrorRate)}</td>
            <td>{i.why}</td>
            <td>
              <button className="bt-chip" onClick={() => openMomentOnBoard(Math.round((i.start - r.t[0]) / r.window.stepS), st ? focus : -1)}>
                board ↗
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Changes() {
  const w = useBacktest((s) => s.workspace)!;
  const r = useBacktest((s) => s.result)!;
  const focus = useBacktest((s) => s.focus);
  const edit = useBacktest((s) => s.editStrategy);
  const remove = useBacktest((s) => s.removeStrategy);
  const ok = w.strategies.filter((x) => !x.error);
  const file = ok[focus] ?? w.strategies[focus];
  const idx = file ? w.strategies.indexOf(file) : -1;
  const st = r.strategies[focus];
  if (!file) return <div className="bt-empty">No strategy yet. Add one from the watchlist, or write a YAML file and open it.</div>;
  return (
    <div className="bt-changes">
      <div>
        <label htmlFor="bt-yaml" className="bt-dim small">
          strategy file (YAML) — edits re-run the backtest
        </label>
        <textarea id="bt-yaml" spellCheck={false} value={file.yaml} onChange={(e) => edit(idx, e.target.value)} />
        {file.error && <div className="neg small">{file.error}</div>}
        <button className="bt-chip" onClick={() => remove(idx)}>
          remove strategy
        </button>
      </div>
      <div>
        <div className="bt-dim small">what changes, and what is assumed</div>
        <ul>{(st?.notes ?? []).map((n, i) => <li key={i}>{n}</li>)}</ul>
        {st && st.events.length > 0 && (
          <>
            <div className="bt-dim small">autoscaler, first {Math.min(12, st.events.length)} of {st.events.length} decisions</div>
            <ul className="bt-events">{st.events.slice(0, 12).map((e, i) => <li key={i}>{when(e.t)} {e.what}</li>)}</ul>
          </>
        )}
      </div>
    </div>
  );
}

function Endpoints({ st }: { st: StrategyResult | undefined }) {
  const r = useBacktest((s) => s.result)!;
  const rows = Object.entries(r.baseline.endpoints);
  return (
    <table className="bt-table">
      <thead>
        <tr>
          <th>endpoint</th>
          <th>own SLO</th>
          <th>requests</th>
          <th>failed{st ? ` (as built → ${st.name})` : ''}</th>
          <th>min out of SLO</th>
          <th>$ / 1M requests</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([id, b]) => {
          const e = st?.endpoints[id];
          const arrow = (a: number, z: number | undefined, f: (x: number) => string) => (z === undefined ? f(a) : `${f(a)} → ${f(z)}`);
          return (
            <tr key={id}>
              <td>{id}</td>
              <td className="bt-dim">
                p99 ≤ {b.slo.p99Ms} ms · err ≤ {pct(b.slo.errorRate)}
              </td>
              <td>{Math.round(b.requests).toLocaleString('en-US')}</td>
              <td>{arrow(b.failedRequests, e?.failedRequests, (x) => Math.round(x).toLocaleString('en-US'))}</td>
              <td className={e && e.minutesOutOfSlo > b.minutesOutOfSlo + 0.5 ? 'neg' : e && e.minutesOutOfSlo < b.minutesOutOfSlo - 0.5 ? 'pos' : ''}>{arrow(b.minutesOutOfSlo, e?.minutesOutOfSlo, (x) => x.toFixed(1))}</td>
              <td>{arrow(b.costPerMillion, e?.costPerMillion, (x) => `$${x.toFixed(x < 10 ? 3 : 2)}`)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ModelTab() {
  const w = useBacktest((s) => s.workspace)!;
  const m = w.model;
  return (
    <table className="bt-table">
      <thead>
        <tr>
          <th>component</th>
          <th>fit</th>
          <th>capacity / replica</th>
          <th>limited by</th>
          <th>replicas</th>
          <th>$/replica-h</th>
          <th>notes</th>
        </tr>
      </thead>
      <tbody>
        {Object.values(m.services).map((s) => (
          <tr key={s.id} className={s.fit.status === 'unexplained' || s.fit.status === 'poor' ? 'flag' : ''}>
            <td>
              {s.id}
              {s.hostedBy ? <span className="bt-dim"> in {s.hostedBy}</span> : ''}
            </td>
            <td className={`fit-${s.fit.status}`}>
              {s.fit.status}
              {s.fit.latencyMape !== undefined ? ` · ${(s.fit.latencyMape * 100).toFixed(0)}%` : ''}
            </td>
            <td>{isFinite(s.capacity.perReplicaRps) ? `${s.capacity.perReplicaRps.toFixed(1)} req/s${s.capacity.band ? ` (${s.capacity.band[0].toFixed(1)}–${s.capacity.band[1].toFixed(1)})` : ''}` : '—'}</td>
            <td>{s.capacity.limit === 'cpu' ? 'CPU' : s.capacity.limit === 'concurrency' ? `${s.capacity.servers} at a time` : '—'}</td>
            <td>{s.hostedBy ? '—' : s.replicas}</td>
            <td>{s.cost.source === 'none' ? '—' : `$${s.cost.perReplicaHour.toFixed(4)}`}</td>
            <td className="bt-dim">{s.fit.notes.join(' · ')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Tester() {
  const r = useBacktest((s) => s.result)!;
  const tab = useBacktest((s) => s.tab);
  const setTab = useBacktest((s) => s.setTab);
  const focus = useBacktest((s) => s.focus);
  const st = r.strategies[focus];
  const tabs: [Tab, string][] = [
    ['overview', 'Overview'],
    ['incidents', `Incidents${st ? ` (${st.incidents.length})` : ''}`],
    ['endpoints', 'Endpoints'],
    ['changes', 'Changes'],
    ['model', 'Model'],
  ];
  return (
    <section className="bt-tester">
      <div className="bt-tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
        <span className="bt-spacer" />
        <span className="bt-dim small">{r.draws} draws · bands 10–90%</span>
      </div>
      <div className="bt-tabbody">
        {tab === 'overview' && <Overview st={st} />}
        {tab === 'incidents' && <Incidents st={st} />}
        {tab === 'endpoints' && <Endpoints st={st} />}
        {tab === 'changes' && <Changes />}
        {tab === 'model' && <ModelTab />}
      </div>
    </section>
  );
}

export function BacktestView() {
  const w = useBacktest((s) => s.workspace);
  const r = useBacktest((s) => s.result);
  const loading = useBacktest((s) => s.loading);
  const [drag, setDrag] = useState(false);
  useEffect(() => {
    if (!useBacktest.getState().workspace && !useBacktest.getState().loading) loadReferenceIndex().then(() => loadReference(REFERENCES[0].id));
  }, []);
  const body = useMemo(() => (w && r ? 'ready' : 'wait'), [w, r]);
  return (
    <div
      className={`bt ${drag ? 'drag' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if (e.dataTransfer.files.length) openWorkspaceFiles([...e.dataTransfer.files]);
      }}
    >
      <header>
        <Bar />
        <OutageBanner />
      </header>
      {body === 'ready' ? (
        <>
          <div className="bt-main">
            <Panes />
            <Watch />
          </div>
          <Tester />
        </>
      ) : (
        <div className="bt-empty big">{loading ?? 'Loading…'}</div>
      )}
      {drag && <div className="bt-drop">Drop an import manifest with its files (Prometheus / CloudWatch exports, OTLP traces, CUR or GCP bill), a dataset.json + model.json, or strategy YAML files</div>}
    </div>
  );
}
