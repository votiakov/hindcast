import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { stringify } from 'yaml';
import { strategyName, useBacktest } from './store';
import { Pane, TimeAxis, areaPath, makeScale, path, useWidth, yScale } from './chart';
import { closeOutage, openNodeLoss } from './workspace';
import { useSim } from '../sim/store';
import type { CapacityReview, ReviewChange } from '../backtest/review';

/**
 * The capacity review, one screen for a lead: the summary, headroom over the recorded traffic, a node
 * lost at the busiest moment, the limits that bind, what to commit to, and the fixes and savings that
 * passed — each opening as its full backtest on the replay screen. Everything shown is computed by the
 * engine (src/backtest/review.ts); this file only lays it out.
 */

const MEASURED = '#e6edf3';
const BUSIER = '#8193a3';

const int = (x: number) => Math.round(x).toLocaleString('en-US');
/** one decimal at most, as the engine's sentences write numbers (164.5, not 165) */
const num = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 1 });
const usd = (x: number) => `$${int(Math.abs(x))}`;
const signedUsd = (x: number) => (Math.abs(x) < 0.5 ? '$0' : `${x > 0 ? '+' : '−'}$${int(Math.abs(x))}`);
const signed = (x: number, f: (v: number) => string) => (Math.abs(x) < 0.05 ? '0' : `${x > 0 ? '+' : '−'}${f(Math.abs(x))}`);
/** "13 Oct 16:45" from an ISO time */
const when = (iso: string) => {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${iso.slice(11, 16)}`;
};

/** the engine's sentences keep their Markdown emphasis: **bold** and `code` */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('**') && p.endsWith('**') ? <b key={i}>{p.slice(2, -2)}</b> : p.startsWith('`') && p.endsWith('`') && p.length > 1 ? <code key={i}>{p.slice(1, -1)}</code> : <Fragment key={i}>{p}</Fragment>,
      )}
    </>
  );
}

function Section({ n, title, aside, children }: { n: number; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="rv-sec" aria-labelledby={`rv-${n}`}>
      <h3 id={`rv-${n}`}>
        <span className="rv-n">{n}</span>
        {title}
        {aside && <span className="rv-aside">{aside}</span>}
      </h3>
      {children}
    </section>
  );
}

/** a change from the review opened as its full backtest: added to the changes tested (or focused if it is there) */
function openChange(change: ReviewChange) {
  const st = useBacktest.getState();
  if (st.workspace?.outage) closeOutage();
  if (useBacktest.getState().load !== 1) useBacktest.getState().setLoad(1);
  const w = useBacktest.getState().workspace;
  if (!w) return;
  const name = change.name;
  const at = w.strategies.findIndex((s) => strategyName(s.yaml, '') === name);
  if (at >= 0) {
    const ok = w.strategies.filter((s) => !s.error);
    const k = ok.indexOf(w.strategies[at]);
    if (k >= 0) useBacktest.getState().setFocus(k);
  } else useBacktest.getState().addStrategy(stringify(change));
  useBacktest.getState().setTab('overview');
  useBacktest.getState().setScreen('replay');
  useSim.getState().toast('info', `“${name}” replayed over the history: the charts show it against the system as built`);
}

function Backtest({ change }: { change: ReviewChange }) {
  return (
    <button className="rv-link" onClick={() => openChange(change)} title="Open this change's full backtest on the replay screen">
      full backtest ↗
    </button>
  );
}

function Summary({ r }: { r: CapacityReview }) {
  return (
    <dl className="rv-summary">
      {r.summary.map((l) => {
        const level = l.label === 'Risk' ? (/^\*\*(High|Medium|Low)\./.exec(l.text)?.[1] ?? '').toLowerCase() : '';
        return (
          <div key={l.label} className={level ? `risk-${level}` : ''}>
            <dt>{l.label}</dt>
            <dd>
              <Inline text={l.text} />
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** headroom over the recorded traffic: the busiest moment against the limit, and the 1.5× and 2× days */
function HeadroomChart({ r }: { r: CapacityReview }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const rps = r.traffic.rps;
  const n = rps.length;
  const t = rps.map((_, i) => r.traffic.start + i * r.traffic.stepS);
  const s = makeScale(0, n, width);
  const peakAt = rps.reduce((best, v, i) => (v > rps[best] ? i : best), 0);
  const peak = rps[peakAt] ?? 0;
  const limit = r.headroom.atAnyLoad ? null : r.headroom.rps;
  // the busiest 2× day, and the limit unless it is far above that: then it is named at the top edge
  const offScale = limit !== null && limit > peak * 5;
  const H = 260;
  const ys = yScale(0, Math.max(peak * 2.15, offScale || limit === null ? 0 : limit * 1.12, 1), H, { fmt: (v) => num(v) });
  const scaled = (k: number) => rps.map((v) => v * k);
  const at = hover ?? peakAt;
  const gridLines = Array.from({ length: 6 }, (_, k) => Math.round(((n - 1) * k) / 5));
  const limitLabel = r.headroom.atAnyLoad ? 'out of SLO at any load' : r.headroom.limitedBy ? `limit within SLO ${num(r.headroom.rps)} req/s` : `more than ${num(r.headroom.rps)} req/s: nothing saturates in the range searched`;
  const peakLabel = `busiest ${num(r.traffic.peakRps)} req/s`;
  const ly = limit !== null ? ys.y(limit) : 0;
  const px = s.x(peakAt);
  const py = ys.y(peak);
  const pw = Math.ceil(peakLabel.length * 7.3) + 12;
  const lx = Math.min(s.plotW - pw - 4, Math.max(4, px - pw / 2));
  return (
    <div className="rv-chart" ref={ref}>
      <Pane
        s={s}
        h={H}
        ys={ys}
        hover={hover}
        onHover={setHover}
        gridLines={gridLines}
        legend={[
          { label: 'recorded req/s', color: MEASURED, value: num(rps[at] ?? 0) },
          ...r.busier.map((b) => ({ label: `${b.scale}× day`, color: BUSIER, value: num((rps[at] ?? 0) * b.scale) })),
          ...(limit !== null ? [{ label: 'limit within SLO', color: 'var(--bt-red)', value: num(limit) }] : []),
        ]}
      >
        {limit !== null && !offScale && (
          <>
            {/* the recorded traffic above the limit: where it would not have held */}
            <clipPath id="rv-over">
              <rect x={0} y={0} width={s.plotW} height={ly} />
            </clipPath>
            <path d={areaPath(s, ys.y, rps, H)} clipPath="url(#rv-over)" className="rv-over" />
          </>
        )}
        {r.busier.map((b, k) => (
          <path key={b.scale} d={path(s, ys.y, scaled(b.scale))} fill="none" stroke={BUSIER} strokeWidth={1} strokeDasharray={k === 0 ? '4 3' : '1 3'} opacity={0.9} />
        ))}
        <path d={areaPath(s, ys.y, rps, H)} className="bt-measured-area" />
        <path d={path(s, ys.y, rps)} fill="none" stroke={MEASURED} strokeWidth={1.4} />
        {limit !== null && !offScale && (
          <g>
            <line x1={0} x2={s.plotW} y1={ly} y2={ly} className="rv-limit" />
            <text x={s.plotW - 8} y={ly - 6} textAnchor="end" className="rv-limit-label">
              {limitLabel}
            </text>
          </g>
        )}
        {(offScale || limit === null) && (
          <text x={8} y={36} className="rv-limit-label">
            {offScale ? `↑ ${limitLabel} (above this scale)` : limitLabel}
          </text>
        )}
        <circle cx={px} cy={py} r={3.5} className="rv-peak" />
        <g className="rv-peaktag">
          <rect x={lx} y={Math.max(24, py - 30)} width={pw} height={18} />
          <text x={lx + 6} y={Math.max(24, py - 30) + 13}>
            {peakLabel}
          </text>
        </g>
      </Pane>
      <TimeAxis s={s} t={t} hover={hover} />
    </div>
  );
}

function Days({ r }: { r: CapacityReview }) {
  const rows = [{ label: 'the recorded day', scale: 1, ...r.today }, ...r.busier.map((b) => ({ label: `${b.scale}× its traffic`, ...b }))];
  return (
    <table className="rv-table rv-days">
      <thead>
        <tr>
          <th>replayed</th>
          <th className="num">busiest req/s</th>
          <th className="num">min out of SLO</th>
          <th className="num">failed requests</th>
          <th>SLO</th>
          <th>worst moment</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((d) => (
          <tr key={d.label}>
            <td>{d.label}</td>
            <td className="num">{num(r.traffic.peakRps * d.scale)}</td>
            <td className="num">{d.minutesOutOfSlo}</td>
            <td className="num">{int(d.failedRequests)}</td>
            <td className={d.holds ? 'pos' : 'neg'}>{d.holds ? 'holds' : 'breaks'}</td>
            <td className="rv-why">{d.worst}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Binding({ r }: { r: CapacityReview }) {
  const h = r.headroom;
  const st = r.stability;
  return (
    <div className="rv-facts">
      {h.atAnyLoad ? (
        <span>
          <i>limit</i> none to read: out of SLO at any load — {h.atAnyLoad}
        </span>
      ) : (
        <>
          <span>
            <i>within SLO up to</i> {num(h.rps)} req/s
          </span>
          {h.overPeak !== null && (
            <span>
              <i>against the busiest moment</i> {h.overPeak}×
            </span>
          )}
          <span>
            <i>binds first</i> {h.limitedBy ?? 'nothing in the range searched'}
            {h.limitedBy && (h.limitFromCpu ? <em> — read from CPU alone (no latency metric)</em> : !h.limitTrusted ? <em className="neg"> — the model does not explain it well: a guess</em> : null)}
          </span>
        </>
      )}
      {st.windows.length > 0 && (
        <span className={st.uncertain ? 'neg' : ''}>
          <i>each third of the history alone</i> {st.windows.map((w) => (w.atAnyLoad ? 'none' : w.limitedBy ? `${num(w.rps)} (${w.limitedBy})` : `> ${num(w.rps)}`)).join(' · ')} req/s{st.uncertain ? ' — uncertain' : ''}
        </span>
      )}
    </div>
  );
}

function NodeLoss({ r }: { r: CapacityReview }) {
  const nl = r.nodeLoss;
  if (!nl) return <p className="rv-dim">This model has no pod placement, so losing a node can't be replayed: Kubernetes histories carry it (kube_pod_info).</p>;
  const w = nl.worst;
  const fix = nl.fix;
  const sb = nl.ifCallersStayBroken;
  return (
    <>
      <table className="rv-table">
        <thead>
          <tr>
            <th>lost at the busiest moment</th>
            <th className="num">min out of SLO</th>
            <th className="num">failed requests</th>
            <th>left with no replica</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {w && (
            <tr>
              <td>
                {w.node} <span className="rv-dim">as built{nl.survives ? '' : ', the worst node'}</span>
              </td>
              <td className={`num ${nl.survives ? '' : 'neg'}`}>{w.minutesOutOfSlo > 0 ? `+${w.minutesOutOfSlo}` : '0'}</td>
              <td className={`num ${w.failedRequests > 0 && !nl.survives ? 'neg' : ''}`}>{w.failedRequests > 0 ? `+${int(w.failedRequests)}` : '0'}</td>
              <td className="rv-why">{w.down.length ? w.down.join(', ') : 'none'}</td>
              <td className="rv-act">
                <button className="rv-link" onClick={() => (useBacktest.getState().setScreen('replay'), openNodeLoss(w.node))} title="Replay this node's loss over the history on the replay screen">
                  replay it ↗
                </button>
              </td>
            </tr>
          )}
          {fix && (
            <tr>
              <td>
                {fix.worstAfter?.node ?? '—'} <span className="rv-dim">with the fix, the worst node</span>
              </td>
              <td className={`num ${fix.survives ? 'pos' : 'neg'}`}>{fix.worstAfter ? (fix.worstAfter.minutesOutOfSlo > 0 ? `+${fix.worstAfter.minutesOutOfSlo}` : '0') : '—'}</td>
              <td className="num rv-dim">—</td>
              <td className="rv-why">{fix.survives ? 'survives every node' : 'still fails a node'}</td>
              <td className="rv-act" />
            </tr>
          )}
        </tbody>
      </table>
      {nl.survives && <p>Stays within SLO when any one node is lost.</p>}
      {fix && (
        <div className="rv-fixline">
          <span>
            <i>the fix</i> {fix.change.changes.map((c) => `${String(c.service)}${c.replicas ? ` × ${c.replicas}` : ''}`).join(', ')}, spread evenly over the nodes
          </span>
          <span className="num">{Math.abs(fix.monthlyDelta) < 0.5 ? (r.nodePool && !r.nodePool.autoscaled ? 'no added cost: it fits on the nodes running' : 'no added cost') : `${signedUsd(fix.monthlyDelta)}/month`}</span>
          <Backtest change={fix.change} />
        </div>
      )}
      {nl.singlePointsOfFailure.length > 0 && (
        <p className="rv-dim">
          Single points of failure, every replica on one node: <span className="rv-list">{nl.singlePointsOfFailure.join(', ')}</span>
        </p>
      )}
      {sb ? (
        <div className="rv-assume">
          <span className="rv-tag">assumption</span>
          <div>
            <Inline text={sb.said} />
          </div>
        </div>
      ) : (
        <p className="rv-dim">Stuck callers: not computed — this model marks no call as gRPC, so no caller's connection is assumed to stay broken after the node's pods are back.</p>
      )}
    </>
  );
}

function Limits({ r }: { r: CapacityReview }) {
  const rows: { svc: string; what: string; at: string; note: string }[] = [
    ...r.throttled.map((t) => ({ svc: t.service, what: `CPU quota, ${t.cpuLimit} cores`, at: `throttles from ${Math.round(t.kneeShareOfLimit * 100)}% of it`, note: `${num(t.perReplicaRps)} req/s per replica` })),
    ...r.memoryNearLimit.map((m) =>
      m.leakMiBPer1000 !== undefined
        ? { svc: m.service, what: `memory ${int(m.limitMiB)} MiB, leaking`, at: `+${m.leakMiBPer1000} MiB per 1,000 requests`, note: `OOM-killed after ~${int(m.requestsToLimit ?? 0)} requests per container` }
        : { svc: m.service, what: `memory ${int(m.limitMiB)} MiB`, at: `peaked at ${int(m.peakMiB)} MiB (${Math.round(m.share * 100)}%)`, note: '' },
    ),
    ...(r.restartRisks ?? []).map((x) => ({ svc: x.service, what: 'one replica, called over gRPC', at: `by ${x.callers.join(', ')}`, note: 'a restart may leave callers’ channels broken' })),
  ];
  if (!rows.length) return <p className="rv-dim">No CPU quota throttles, no memory limit was approached and nothing leaks in this history.</p>;
  return (
    <table className="rv-table rv-limits">
      <tbody>
        {rows.map((x, i) => (
          <tr key={i}>
            <td>{x.svc}</td>
            <td>{x.what}</td>
            <td>
              {x.at}
              {x.note && <span className="rv-dim"> — {x.note}</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Commit({ r }: { r: CapacityReview }) {
  const c = r.commitment;
  const p = r.nodePool;
  return (
    <>
      {c ? (
        <>
          <p>
            The history never ran fewer than <b>{num(c.floor)} {c.unit}</b>, {usd(c.onDemandMonthly)}/month on demand: capacity that is always on. Commit to that floor, not the peak; what runs above it stays on demand.
          </p>
          <table className="rv-table">
            <thead>
              <tr>
                <th>commitment</th>
                <th className="num">saves / month</th>
                <th className="num">of on demand</th>
              </tr>
            </thead>
            <tbody>
              {c.options.map((o) => (
                <tr key={o.term}>
                  <td>{o.term}</td>
                  <td className="num pos">{usd(o.savesMonthly)}</td>
                  <td className="num">{Math.round((o.savesMonthly / c.onDemandMonthly) * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="rv-dim">{c.basis}</p>
        </>
      ) : (
        <p className="rv-dim">No commitment to read: {r.commitmentAbsent ?? 'nothing list-priced runs all the time'}.</p>
      )}
      {p && (
        <div className="rv-facts">
          <span>
            <i>node pool</i> {p.nodes} × {num(p.node.cpu)} cores, {p.node.memoryGb} GiB, {p.autoscaled ? 'autoscaled' : 'fixed'}
          </span>
          <span>
            <i>per node</i> {usd(p.monthlyPerNode)}/month
          </span>
          <span>
            <i>requests at the busiest moment fill</i> {Math.round(p.peakFill * 100)}%
          </span>
          {!p.autoscaled && p.wouldFit < p.nodes && (
            <span>
              <i>would fit on</i> {p.wouldFit} nodes with one to spare, about {usd((p.nodes - p.wouldFit) * p.monthlyPerNode)}/month less — check node loss before shrinking
            </span>
          )}
        </div>
      )}
    </>
  );
}

function Fixes({ r }: { r: CapacityReview }) {
  const pool = !!r.nodePool && !r.nodePool.autoscaled;
  const cost = (x: number) => (Math.abs(x) < 0.5 ? (pool ? '$0, fits on the nodes' : '$0') : signedUsd(x));
  const verdict = (v: string, c?: string) => (
    <span className={v === 'pass' ? 'pos' : v === 'fail' ? 'neg' : ''}>
      {v}
      {c ? <span className="rv-dim"> · {c} confidence</span> : null}
    </span>
  );
  if (!r.fixes.length && !r.savings.length) return <p className="rv-dim">No fix improved the recorded day and no saving passed its backtest.</p>;
  return (
    <table className="rv-table rv-fixes">
      <thead>
        <tr>
          <th>change</th>
          <th>verdict</th>
          <th className="num">min out of SLO</th>
          <th className="num">failed requests</th>
          <th className="num">$ / month</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {r.fixes.length > 0 && (
          <tr className="rv-group">
            <td colSpan={6}>fixes — less time out of SLO on the recorded day</td>
          </tr>
        )}
        {r.fixes.map((f) => (
          <tr key={f.name}>
            <td>{f.name}</td>
            <td>{verdict(f.verdict, f.confidence)}</td>
            <td className="num pos">{signed(f.minutesOutOfSloDelta, (v) => String(+v.toFixed(1)))}</td>
            <td className="num pos">{signed(f.failedRequestsDelta, int)}</td>
            <td className="num">{cost(f.monthlyDelta)}</td>
            <td className="rv-act">
              <Backtest change={f.change} />
            </td>
          </tr>
        ))}
        {r.savings.length > 0 && (
          <tr className="rv-group">
            <td colSpan={6}>savings — cost less with no time out of SLO added</td>
          </tr>
        )}
        {r.savings.map((x) => (
          <tr key={x.name}>
            <td>{x.name}</td>
            <td>{verdict(x.verdict, x.confidence)}</td>
            <td className="num">{signed(x.minutesOutOfSloDelta, (v) => String(+v.toFixed(1)))}</td>
            <td className="num">{signed(x.failedRequestsDelta, int)}</td>
            <td className="num pos">{signedUsd(x.monthlyDelta)}</td>
            <td className="rv-act">
              <Backtest change={x.change} />
            </td>
          </tr>
        ))}
        {r.combinedSavings && (
          <tr className="rv-total">
            <td>{r.combinedSavings.name}</td>
            <td>{verdict(r.combinedSavings.verdict, r.combinedSavings.confidence)}</td>
            <td className="num">{signed(r.combinedSavings.minutesOutOfSloDelta, (v) => String(+v.toFixed(1)))}</td>
            <td className="num">{signed(r.combinedSavings.failedRequestsDelta, int)}</td>
            <td className="num pos">{signedUsd(r.combinedSavings.monthlyDelta)}</td>
            <td className="rv-act">{r.combinedSavings.change && <Backtest change={r.combinedSavings.change} />}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

export function ReviewView() {
  const w = useBacktest((s) => s.workspace)!;
  const base = w.outage?.parent ?? w;
  const review = useBacktest((s) => s.review);
  const reviewing = useBacktest((s) => s.reviewing);
  const error = useBacktest((s) => s.reviewError);
  const load = useBacktest((s) => s.load);
  const [copied, setCopied] = useState(false);
  useEffect(() => useBacktest.getState().runReview(), [base.id]);
  const r = review?.id === base.id ? review.data : null;
  if (!r)
    return (
      <div className="rv">
        <div className="rv-wait">
          {error ? (
            <span className="neg">The review failed: {error}</span>
          ) : (
            <>
              reviewing {base.name} <span className="rv-dim">— {reviewing?.id === base.id ? reviewing.phase : 'starting'}…</span>
            </>
          )}
        </div>
      </div>
    );
  const copy = () => {
    void navigator.clipboard?.writeText(r.markdown).then(
      () => (setCopied(true), setTimeout(() => setCopied(false), 1600)),
      () => useSim.getState().toast('bad', 'The clipboard is not available here'),
    );
  };
  return (
    <div className="rv">
      <article className="rv-doc">
        <header className="rv-head">
          <div className="rv-title">
            <span className="rv-kicker">Capacity review</span>
            <h2>{r.system}</h2>
            <span className="rv-spacer" />
            <button className="bt-chip" onClick={copy} title="The same review as Markdown, as review_capacity writes it">
              {copied ? 'copied' : 'copy as Markdown'}
            </button>
          </div>
          <div className="rv-meta">
            <span>
              <i>history</i> {when(r.history.from)} – {when(r.history.to)} UTC
            </span>
            <span>
              <i>busiest moment</i> {num(r.traffic.peakRps)} req/s
            </span>
            <span>
              <i>SLO</i> p99 ≤ {r.slo.p99Ms} ms, errors ≤ {+(r.slo.errorRate * 100).toFixed(2)}%
            </span>
            <span>
              <i>as run</i> {usd(r.nodePool && !r.nodePool.autoscaled ? r.nodePool.nodes * r.nodePool.monthlyPerNode : r.today.monthly)}/month
            </span>
          </div>
          {r.calibrated && <div className="rv-note">{r.calibrated.said}</div>}
          {(w.outage || load !== 1) && <div className="rv-note">Reviewed on the recorded history as it was: the {w.outage ? 'outage' : `${load}× load`} on the replay screen does not apply here.</div>}
          {r.noTraffic && <div className="rv-note">No service has request metrics, so there is no traffic to replay: headroom, busier days and losing a node can't be read; cost still can.</div>}
        </header>

        <Section n={1} title="Summary">
          <Summary r={r} />
        </Section>

        {!r.noTraffic && (
          <Section n={2} title="Headroom" aside="the recorded traffic, and the same day at 1.5× and 2×">
            <HeadroomChart r={r} />
            <Binding r={r} />
            <Days r={r} />
          </Section>
        )}

        <div className="rv-pair">
          {!r.noTraffic && (
            <Section n={3} title="Losing a node at the busiest moment">
              <NodeLoss r={r} />
            </Section>
          )}
          <div>
            <Section n={4} title="What to commit to">
              <Commit r={r} />
            </Section>
            <Section n={5} title="Limits that bind">
              <Limits r={r} />
            </Section>
          </div>
        </div>

        <Section n={6} title="Fixes and savings that pass" aside="each backtested over the recorded history; the minutes and money are its difference from the system as built">
          <Fixes r={r} />
        </Section>

        <footer className="rv-foot">
          Every number is a replay of the recorded history through the calibrated model ({base.dataset.n} buckets of {base.dataset.stepS} s, 12 capacity draws each). The same review from a shell or an agent: <code>hindcast agent review_capacity</code>.
        </footer>
      </article>
    </div>
  );
}
