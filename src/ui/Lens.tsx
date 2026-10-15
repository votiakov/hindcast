import { useEffect, useRef, useState } from 'react';
import { useSim } from '../sim/store';
import { KINDS, isSystem } from '../sim/catalog';
import { PRICING, type PricingId } from '../sim/pricing';
import { useMemo } from 'react';
import { graphToSpec } from '../spec/convert';
import { simulate } from '../sim/headless';
import { explain, nodeView } from '../canvas/nodeModel';
import './lens.css';

const TARGETS = [0.99, 0.995, 0.999, 0.9995, 0.9999];
const money = (n: number) => (n >= 10000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 2 : 0 })}`);
const dur = (min: number) => (!isFinite(min) ? 'never' : min < 60 ? `${min.toFixed(0)} min` : min < 60 * 48 ? `${(min / 60).toFixed(1)} h` : `${(min / 1440).toFixed(1)} days`);

/**
 * Cost & error-budget lens: where the money goes (per component, per million requests) and how
 * fast the current error rate would burn a monthly SLO budget.
 */
export function Lens({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState(0.999);
  const g = useSim((s) => s.boards[s.mode === 'compare' ? s.focus : 'main'].global);
  const nodes = useSim((s) => s.boards[s.mode === 'compare' ? s.focus : 'main'].nodes);
  const stats = useSim((s) => s.boards[s.mode === 'compare' ? s.focus : 'main'].nodeStats);
  const pricing = useSim((s) => s.settings.pricing);
  const edges = useSim((s) => s.boards[s.mode === 'compare' ? s.focus : 'main'].edges);
  const rpsKey = Math.round(g.rps / 50) * 50;
  // the same design, same load, under every pricing profile (a short headless run each)
  const perCloud = useMemo(() => {
    if (!nodes.some((n) => n.type === 'system')) return [];
    const spec = graphToSpec(nodes, edges);
    return (Object.keys(PRICING) as PricingId[]).map((id) => {
      try {
        return { id, monthly: Math.round(simulate({ ...spec, pricing: id }, { duration: 8, rps: rpsKey, readRatio: useSim.getState().readRatio }).summary.meanCostPerHour * 730) };
      } catch {
        return { id, monthly: NaN };
      }
    });
  }, [nodes, edges, rpsKey]);

  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest('.metrics') && onClose();
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [onClose]);

  const rows = nodes
    .filter(isSystem)
    .filter((n) => n.data.kind !== 'client')
    .map((n) => ({ id: n.id, name: n.data.name, kind: n.data.kind, perH: stats[n.id]?.costPerHour ?? 0, inst: stats[n.id]?.scaling ? stats[n.id]!.scaling!.live + stats[n.id]!.scaling!.pending : (n.data.instances ?? 1) }))
    .sort((a, b) => b.perH - a.perH);
  const total = rows.reduce((s, r) => s + r.perH, 0);
  // where requests fail: each component's own failures (what it drops, not what its callees did),
  // with the reason the board gives it
  const edgesFrom = new Set(edges.map((e) => e.source));
  const failing = nodes
    .filter(isSystem)
    .filter((n) => n.data.kind !== 'client' && (stats[n.id]?.dropRps ?? 0) > 0.5)
    .map((n) => {
      const st = stats[n.id]!;
      const why = explain(n.data, st, nodeView(n.data, st, true, edgesFrom.has(n.id)))?.text ?? 'failing';
      return { id: n.id, name: n.data.name, kind: n.data.kind, rps: st.dropRps, why: why.split(/(?<=[.:])\s/)[0].replace(/[.:]$/, '') };
    })
    .sort((a, b) => b.rps - a.rps)
    .slice(0, 5);
  const failingTotal = failing.reduce((s, f) => s + f.rps, 0);
  const perMillion = g.rps > 0.5 ? (total / (g.rps * 3600)) * 1e6 : null;
  const budgetMin = (1 - target) * 30 * 24 * 60;
  const burn = g.errorRate / (1 - target);
  const lasts = burn > 0 ? (30 * 24 * 60) / burn : Infinity;

  return (
    <div className="lens" ref={ref} onClick={(e) => e.stopPropagation()}>
      <div className="lens-sec">
        <div className="lens-h">cost</div>
        <div className="lens-big">
          {money(total * 730)}
          <small>/month</small>
        </div>
        <div className="lens-sub">
          {money(total)}/h · {perMillion !== null ? <>{money(perMillion)} per million requests</> : 'no traffic'} · {PRICING[pricing].label}
        </div>
        {perCloud.length > 1 && (
          <div className="lens-clouds">
            {perCloud.map((c) => (
              <button key={c.id} className={c.id === pricing ? 'on' : ''} onClick={() => useSim.getState().setSetting('pricing', c.id)} title={`${PRICING[c.id].label} — click to switch`}>
                <span>{PRICING[c.id].short}</span>
                <b>{isFinite(c.monthly) ? money(c.monthly) : '—'}</b>
              </button>
            ))}
          </div>
        )}
        <table className="lens-table">
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="lens-name">
                  <i style={{ background: KINDS[r.kind].color }} />
                  {r.name}
                  {KINDS[r.kind].scalable && r.inst > 1 && <em>×{r.inst}</em>}
                </td>
                <td className="lens-bar">
                  <i style={{ width: `${total > 0 ? (r.perH / total) * 100 : 0}%` }} />
                </td>
                <td className="lens-num">{money(r.perH * 730)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {failing.length > 0 && (
        <div className="lens-sec">
          <div className="lens-h">where requests fail</div>
          <table className="lens-table">
            <tbody>
              {failing.map((f) => (
                <tr key={f.id} title={f.why}>
                  <td className="lens-name lens-fail">
                    <i style={{ background: KINDS[f.kind].color }} />
                    {f.name}
                    <span className="lens-why">{f.why}</span>
                  </td>
                  <td className="lens-bar bad">
                    <i style={{ width: `${(f.rps / failingTotal) * 100}%` }} />
                  </td>
                  <td className="lens-num">{f.rps >= 100 ? f.rps.toFixed(0) : f.rps.toFixed(1)}/s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="lens-sec">
        <div className="lens-h">
          error budget
          <select value={target} onChange={(e) => setTarget(+e.target.value)}>
            {TARGETS.map((t) => (
              <option key={t} value={t}>
                {(t * 100).toFixed(t >= 0.9995 ? 2 : 1)}% / 30 d
              </option>
            ))}
          </select>
        </div>
        <div className={`lens-big ${burn > 1 ? 'bad' : ''}`}>
          {burn < 0.01 ? '0' : burn.toFixed(burn < 10 ? 1 : 0)}×<small>burn rate</small>
        </div>
        <div className="lens-sub">
          {budgetMin < 60 ? `${budgetMin.toFixed(1)} min` : `${(budgetMin / 60).toFixed(1)} h`} of full outage allowed per month.{' '}
          {burn > 1 ? (
            <>
              At {(g.errorRate * 100).toFixed(2)}% errors the whole month’s budget is gone in <b>{dur(lasts)}</b>.
            </>
          ) : g.rps > 0.5 ? (
            'Within budget at the current error rate.'
          ) : (
            'Start traffic to measure.'
          )}
        </div>
        {burn >= 14.4 && <div className="lens-alert">≥ 14.4× — a fast-burn page: 2% of the monthly budget in one hour.</div>}
      </div>
    </div>
  );
}
