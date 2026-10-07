import { useState } from 'react';
import type { CurvePoint } from '../sim/headless';

const W = 380;
const H = 118;
const PAD = { l: 6, r: 6, t: 8, b: 16 };

/**
 * Steady-state load curve: p99 (line) and errors (area) from light load to 2× the breaking point,
 * with the expected load and the breaking point marked. Hover for the numbers at any load.
 */
export function LoadCurve({ curve, now, limit, sloP99 }: { curve: CurvePoint[]; now: number; limit: number; sloP99: number }) {
  const [hover, setHover] = useState<number | null>(null);
  if (curve.length < 2) return null;
  const maxX = curve[curve.length - 1].rps;
  const yMax = Math.max(sloP99 * 3, Math.min(Math.max(...curve.map((p) => p.p99Ms)), sloP99 * 6));
  const x = (r: number) => PAD.l + (r / maxX) * (W - PAD.l - PAD.r);
  const yLat = (ms: number) => H - PAD.b - (Math.min(ms, yMax) / yMax) * (H - PAD.t - PAD.b);
  const yErr = (e: number) => H - PAD.b - Math.min(1, e) * (H - PAD.t - PAD.b);
  const pts = [{ rps: 0, p99Ms: curve[0].p99Ms, errorRate: 0 }, ...curve];
  const lat = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.rps).toFixed(1)},${yLat(p.p99Ms).toFixed(1)}`).join(' ');
  const err = `M${x(0)},${H - PAD.b} ${pts.map((p) => `L${x(p.rps).toFixed(1)},${yErr(p.errorRate).toFixed(1)}`).join(' ')} L${x(maxX)},${H - PAD.b} Z`;
  const near = (r: number) => curve.reduce((b, p) => (Math.abs(p.rps - r) < Math.abs(b.rps - r) ? p : b), curve[0]);
  const at = near(now);
  const best = curve.filter((p) => p.errorRate <= 0.01 && p.p99Ms <= sloP99).at(-1);
  const h = hover !== null ? curve[hover] : null;

  return (
    <div className="lc">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const rps = ((e.clientX - r.left) / r.width) * W;
          const target = ((rps - PAD.l) / (W - PAD.l - PAD.r)) * maxX;
          setHover(curve.indexOf(near(target)));
        }}
        onMouseLeave={() => setHover(null)}
      >
        <line x1={PAD.l} x2={W - PAD.r} y1={yLat(sloP99)} y2={yLat(sloP99)} className="lc-slo" />
        <text x={W - PAD.r} y={yLat(sloP99) - 3} className="lc-tag" textAnchor="end">
          p99 SLO {sloP99} ms
        </text>
        <path d={err} className="lc-err" />
        <path d={lat} className="lc-lat" />
        <line x1={x(now)} x2={x(now)} y1={PAD.t} y2={H - PAD.b} className="lc-now" />
        <text x={x(now) + 3} y={H - 4} className="lc-tag">
          now
        </text>
        {limit > 0 && limit < maxX && (
          <>
            <line x1={x(limit)} x2={x(limit)} y1={PAD.t} y2={H - PAD.b} className="lc-limit" />
            <text x={x(limit) + 3} y={H - 4} className="lc-tag bad">
              breaks
            </text>
          </>
        )}
        {h && <line x1={x(h.rps)} x2={x(h.rps)} y1={PAD.t} y2={H - PAD.b} className="lc-hover" />}
      </svg>
      <div className="lc-read">
        {h ? (
          <>
            <b>{h.rps.toLocaleString('en-US')} req/s</b> · p99 {h.p99Ms} ms · {(h.errorRate * 100).toFixed(1)}% errors · ${h.perMillion.toFixed(2)}/M req{h.bottleneck ? ` · ${h.bottleneck} saturated` : ''}
          </>
        ) : (
          <>
            ${at.perMillion.toFixed(2)} per million requests now{best && best.rps > at.rps ? <> · ${best.perMillion.toFixed(2)} at {best.rps.toLocaleString('en-US')} req/s, the most it serves within SLO</> : null}
          </>
        )}
      </div>
    </div>
  );
}
