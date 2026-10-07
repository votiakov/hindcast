import { useEffect, useState } from 'react';
import { decodeCard, type CardData } from '../backtest/card';
import './card.css';

/**
 * A backtest result as a Studio card (still) or clip (the chart draws itself, then the verdict),
 * rendered at its true pixel size for posts and slides. Driven by scripts/record.mjs through
 * `window.studio`, like episodes.
 */

const SIZES: Record<string, [number, number]> = { '4:5': [1080, 1350], '1:1': [1080, 1080], '9:16': [1080, 1920], '16:9': [1920, 1080] };
const BEATS = { chart: [1, 7], stats: 7.6, accuracy: 9, finished: 10.5, done: 12.5 };

const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const money = (v: number) => `${v < 0 ? '−' : '+'}$${Math.abs(v) >= 100 ? Math.round(Math.abs(v)).toLocaleString('en-US') : Math.abs(v).toFixed(2)}`;
const day = (t: number) => new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const clock = (t: number) => new Date(t * 1000).toISOString().slice(11, 16);

function Chart({ c, w, h, p }: { c: CardData; w: number; h: number; p: number }) {
  const n = c.t.length;
  const L = 18;
  const R = 92;
  const T = 30;
  const B = 34;
  const vals = [...c.measured.filter((x): x is number => x !== null && x > 0), ...c.asBuilt, ...(c.strategy?.hi ?? []), c.slo.p99Ms * 1.5];
  const lo = Math.max(1, Math.min(...vals) * 0.7);
  const hi = Math.max(...vals) * 1.35;
  const x = (i: number) => L + ((w - L - R) * i) / Math.max(1, n - 1);
  const y = (v: number) => T + (h - T - B) * (1 - (Math.log(Math.max(lo, v)) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)));
  const upto = Math.max(1, Math.round(p * n));
  const line = (a: number[]) => a.slice(0, upto).map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const band = c.strategy ? `M${c.strategy.hi.slice(0, upto).map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('L')}L${c.strategy.lo.slice(0, upto).map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).reverse().join('L')}Z` : '';
  const ticks: number[] = [];
  for (let d = Math.floor(Math.log10(lo)); d <= Math.ceil(Math.log10(hi)); d++) for (const m of [1, 3]) if (m * 10 ** d >= lo && m * 10 ** d <= hi) ticks.push(m * 10 ** d);
  const bw = Math.max(2, ((w - L - R) / n) * 0.6);
  const worstI = c.strategy ? c.t.findIndex((t) => t >= c.strategy!.worst.t) : -1;
  const span = c.window.end - c.window.start;
  const marks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (n - 1)));
  return (
    <svg width={w} height={h} className="cd-chart">
      {ticks.map((v) => (
        <g key={v}>
          <line x1={L} x2={w - R} y1={y(v)} y2={y(v)} className="cd-grid" />
          <text x={w - R + 12} y={y(v) + 7} className="cd-tick">
            {ms(v)}
          </text>
        </g>
      ))}
      <line x1={L} x2={w - R} y1={y(c.slo.p99Ms)} y2={y(c.slo.p99Ms)} className="cd-slo" />
      <text x={L + 4} y={y(c.slo.p99Ms) - 8} className="cd-slolabel">
        SLO p99 {ms(c.slo.p99Ms)}
      </text>
      {c.measured.slice(0, upto).map((v, i) => (v === null ? null : <rect key={i} x={x(i) - bw / 2} y={y(v)} width={bw} height={Math.max(2, y(lo) - y(v))} className={v > c.slo.p99Ms ? 'cd-bar bad' : 'cd-bar'} />))}
      <path d={line(c.asBuilt)} className="cd-asbuilt" />
      {c.strategy && <path d={band} className="cd-band" />}
      {c.strategy && <path d={line(c.strategy.p50)} className="cd-strategy" />}
      {p < 1 && <line x1={x(upto - 1)} x2={x(upto - 1)} y1={T - 10} y2={h - B} className="cd-playhead" />}
      {c.strategy && worstI >= 0 && worstI < upto && c.strategy.worst.p99Ms > c.slo.p99Ms && (
        <g className="cd-worst">
          <rect x={Math.min(w - R - 260, x(worstI) + 14)} y={Math.max(T, y(c.strategy.worst.p99Ms) - 22)} width={250} height={40} />
          <text x={Math.min(w - R - 260, x(worstI) + 14) + 12} y={Math.max(T, y(c.strategy.worst.p99Ms) - 22) + 28}>
            {span > 2 * 86400 ? `${day(c.strategy.worst.t)} ` : ''}
            {clock(c.strategy.worst.t)} · {ms(c.strategy.worst.p99Ms)}
          </text>
        </g>
      )}
      {marks.map((i) => (
        <text key={i} x={x(i)} y={h - 8} textAnchor="middle" className="cd-tick">
          {span > 2 * 86400 ? day(c.t[i]) : clock(c.t[i])}
        </text>
      ))}
    </svg>
  );
}

export function BacktestCard({ c, aspect, t }: { c: CardData; aspect: string; t: number }) {
  const [W, H] = SIZES[aspect] ?? SIZES['4:5'];
  const wide = W > H;
  const p = Math.max(0, Math.min(1, (t - BEATS.chart[0]) / (BEATS.chart[1] - BEATS.chart[0])));
  const statsOn = t >= BEATS.stats;
  const accOn = t >= BEATS.accuracy;
  const k = Math.min(1, Math.max(0, (t - BEATS.stats) / 1.2));
  const s = c.strategy;
  const chartH = wide ? 520 : aspect === '9:16' ? 820 : aspect === '1:1' ? 430 : 600;
  return (
    <div className="cd" style={{ width: W, height: H }}>
      <header className="cd-head" style={{ opacity: Math.min(1, t * 2) }}>
        <div className="cd-kicker">Bottleneck · backtest on real traffic</div>
        <div className="cd-sys">
          {c.system}
          <span>
            {span(c.window)} · {replayed(c.window.end - c.window.start)} of real traffic replayed
          </span>
        </div>
      </header>
      <div className="cd-verdict" style={{ opacity: statsOn ? 1 : 0.0001, transform: `translateY(${statsOn ? 0 : 12}px)` }}>
        {s ? (
          <>
            <b>{s.name}</b> {s.headline}.
          </>
        ) : (
          'As built, replayed over its own history.'
        )}
      </div>
      <div className="cd-legend">
        <span>
          <i className="m" />
          measured p99
        </span>
        <span>
          <i className="a" />
          as built (model)
        </span>
        {s && (
          <span>
            <i className="s" />
            {s.name}, what would have happened
          </span>
        )}
      </div>
      <Chart c={c} w={W - 96} h={chartH} p={p} />
      {s && (
        <div className="cd-stats" style={{ opacity: statsOn ? 1 : 0.0001 }}>
          <div>
            <div className="k">per month</div>
            <div className={`v ${s.monthlyDelta < 0 ? 'pos' : s.monthlyDelta > 0 ? 'neg' : ''}`}>{money(s.monthlyDelta * k)}</div>
          </div>
          <div>
            <div className="k">minutes out of SLO</div>
            <div className={`v ${s.minutesDelta > 0.5 ? 'neg' : s.minutesDelta < -0.5 ? 'pos' : ''}`}>
              {s.minutesDelta > 0 ? '+' : s.minutesDelta < 0 ? '−' : ''}
              {Math.abs(Math.round(s.minutesDelta * k))}
            </div>
          </div>
          <div>
            <div className="k">failed requests</div>
            <div className={`v ${s.failedDelta > 0 ? 'neg' : s.failedDelta < 0 ? 'pos' : ''}`}>
              {s.failedDelta > 0 ? '+' : s.failedDelta < 0 ? '−' : ''}
              {Math.abs(Math.round(s.failedDelta * k)).toLocaleString('en-US')}
            </div>
          </div>
        </div>
      )}
      <footer className="cd-foot" style={{ opacity: accOn ? 1 : 0.0001 }}>
        {c.accuracy.length ? (
          <span>
            Model checked against what really happened:{' '}
            {c.accuracy.map((a, i) => (
              <b key={i} className={a.pass ? 'pos' : 'neg'}>
                {a.metric} {(a.error * 100).toFixed(0)}% off{i < c.accuracy.length - 1 ? ' · ' : ''}
              </b>
            ))}
          </span>
        ) : (
          <span>No accuracy record for this model yet.</span>
        )}
        <span className="cd-brand">reducecost.cloud</span>
      </footer>
    </div>
  );
}

function replayed(s: number) {
  if (s >= 2 * 86400) return `${Math.round(s / 86400)} days`;
  if (s >= 2 * 3600) return `${Math.round(s / 3600)} hours`;
  return `${Math.round(s / 60)} minutes`;
}

function span(w: { start: number; end: number }) {
  return `${day(w.start)}${w.end - w.start > 86400 ? ` – ${day(w.end)}` : ''}`;
}

/** render mode: `?render=1&card=1&cardData=…&aspect=4:5` (or `card=local` for the app's last card) */
export function CardStage() {
  const params = new URLSearchParams(location.search);
  const aspect = params.get('aspect') ?? '4:5';
  const [c] = useState<CardData | null>(() => {
    try {
      if (params.get('cardData')) return decodeCard(params.get('cardData')!);
      const s = localStorage.getItem('bottleneck.card');
      return s ? (JSON.parse(s) as CardData) : null;
    } catch {
      return null;
    }
  });
  const still = params.get('still') === '1';
  const [t, setT] = useState(still ? BEATS.done : 0);
  const [running, setRunning] = useState(params.get('play') === '1');
  useEffect(() => {
    (window as unknown as { studio: unknown }).studio = {
      start: () => setRunning(true),
      state: () => {
        const tt = (window as unknown as { __cardT: number }).__cardT ?? 0;
        return { t: tt, fired: (tt >= BEATS.chart[1] ? 1 : 0) + (tt >= BEATS.accuracy + 0.5 ? 1 : 0), finished: tt >= BEATS.finished, done: tt >= BEATS.done };
      },
    };
  }, []);
  useEffect(() => {
    (window as unknown as { __cardT: number }).__cardT = t;
  }, [t]);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setT((x) => x + 1 / 30), 1000 / 30);
    return () => clearInterval(id);
  }, [running]);
  if (!c) return <div style={{ padding: 40, fontFamily: 'monospace' }}>No backtest card to show — make one from the backtest screen.</div>;
  return <BacktestCard c={c} aspect={aspect} t={t} />;
}
