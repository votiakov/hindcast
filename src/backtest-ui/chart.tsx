import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Num } from '../backtest/dataset';
import type { Band } from '../backtest/backtest';

/**
 * Terminal-style chart panes: every pane shares one time axis (bucket index), the value scale sits
 * on the right, a crosshair runs through all panes, and each pane's legend shows the values under it.
 */

export interface Scale {
  i0: number;
  i1: number;
  width: number;
  /** plot width (without the right-hand value scale) */
  plotW: number;
  x: (i: number) => number;
  index: (px: number) => number;
}

export const AXIS_W = 58;

export function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(900);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((e) => setW(Math.max(320, Math.floor(e[0].contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** width and height of a box that its layout sizes (not its content) */
export function useSize<T extends HTMLElement>(): [React.RefObject<T>, number, number] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 900, h: 700 });
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((e) => setSize({ w: Math.max(320, Math.floor(e[0].contentRect.width)), h: Math.floor(e[0].contentRect.height) }));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, size.w, size.h];
}

export function makeScale(i0: number, i1: number, width: number): Scale {
  const plotW = width - AXIS_W;
  const span = Math.max(1, i1 - 1 - i0);
  return { i0, i1, width, plotW, x: (i) => ((i - i0) / span) * (plotW - 8) + 4, index: (px) => Math.max(i0, Math.min(i1 - 1, Math.round(i0 + ((px - 4) / (plotW - 8)) * span))) };
}

export interface YScale {
  y: (v: number) => number;
  ticks: number[];
  fmt: (v: number) => string;
}

export function yScale(lo: number, hi: number, h: number, opts: { log?: boolean; fmt: (v: number) => string; top?: number; bottom?: number }): YScale {
  const top = opts.top ?? 22;
  const bottom = opts.bottom ?? 6;
  const H = h - top - bottom;
  if (opts.log) {
    const a = Math.log(Math.max(1e-6, lo));
    const b = Math.log(Math.max(lo * 1.01, hi));
    const y = (v: number) => top + H * (1 - (Math.log(Math.max(lo, v)) - a) / (b - a));
    const ticks: number[] = [];
    for (let d = Math.floor(Math.log10(lo)); d <= Math.ceil(Math.log10(hi)); d++) for (const m of [1, 3]) {
      const v = m * 10 ** d;
      if (v >= lo && v <= hi) ticks.push(v);
    }
    return { y, ticks, fmt: opts.fmt };
  }
  const y = (v: number) => top + H * (1 - (v - lo) / (hi - lo || 1));
  const step = niceStep((hi - lo) / 3);
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(v);
  return { y, ticks, fmt: opts.fmt };
}

function niceStep(raw: number) {
  if (raw <= 0 || !isFinite(raw)) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}

export function path(s: Scale, y: (v: number) => number, vals: (Num | number)[]): string {
  let d = '';
  let pen = false;
  for (let i = s.i0; i < s.i1; i++) {
    const v = vals[i];
    if (v === null || v === undefined || !isFinite(v)) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${s.x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  }
  return d;
}

/** the area under a series down to the pane's floor, one closed shape per unbroken run */
export function areaPath(s: Scale, y: (v: number) => number, vals: (Num | number)[], floor: number): string {
  let d = '';
  let run: string[] = [];
  let first = 0;
  let last = 0;
  const close = () => {
    if (run.length) d += `M${first.toFixed(1)},${floor}L${run.join('L')}L${last.toFixed(1)},${floor}Z`;
    run = [];
  };
  for (let i = s.i0; i < s.i1; i++) {
    const v = vals[i];
    if (v === null || v === undefined || !isFinite(v)) {
      close();
      continue;
    }
    const x = s.x(i);
    if (!run.length) first = x;
    last = x;
    run.push(`${x.toFixed(1)},${y(v).toFixed(1)}`);
  }
  close();
  return d;
}

export function bandPath(s: Scale, y: (v: number) => number, b: Band): string {
  let up = '';
  let down = '';
  for (let i = s.i0; i < s.i1; i++) up += `${i === s.i0 ? 'M' : 'L'}${s.x(i).toFixed(1)},${y(b.hi[i]).toFixed(1)}`;
  for (let i = s.i1 - 1; i >= s.i0; i--) down += `L${s.x(i).toFixed(1)},${y(b.lo[i]).toFixed(1)}`;
  return up + down + 'Z';
}

export interface LegendItem {
  label: string;
  color: string;
  value?: string;
}

export function Pane({ s, h, ys, legend, children, hover, onHover, onPick, grid = true, gridLines }: { s: Scale; h: number; ys: YScale; legend: LegendItem[]; children: ReactNode; hover: number | null; onHover: (i: number | null) => void; onPick?: (i: number) => void; grid?: boolean; gridLines?: number[] }) {
  return (
    <div className="bt-pane" style={{ height: h }}>
      <div className="bt-legend">
        {legend.map((l) => (
          <span key={l.label}>
            <i style={{ background: l.color }} />
            {l.label}
            {l.value !== undefined && <b style={{ color: l.color }}>{l.value}</b>}
          </span>
        ))}
      </div>
      <svg
        width={s.width}
        height={h}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = e.clientX - r.left;
          onHover(px <= s.plotW ? s.index(px) : null);
        }}
        onMouseLeave={() => onHover(null)}
        onClick={(e) => {
          if (!onPick) return;
          const r = e.currentTarget.getBoundingClientRect();
          const px = e.clientX - r.left;
          if (px <= s.plotW) onPick(s.index(px));
        }}
      >
        {grid && (gridLines ?? []).map((i) => <line key={`v${i}`} x1={s.x(i)} x2={s.x(i)} y1={0} y2={h} className="bt-grid" />)}
        {grid && ys.ticks.map((v) => <line key={`h${v}`} x1={0} x2={s.plotW} y1={ys.y(v)} y2={ys.y(v)} className="bt-grid" />)}
        <g>{children}</g>
        <line x1={s.plotW} x2={s.plotW} y1={0} y2={h} className="bt-axisline" />
        {ys.ticks.map((v) => (
          <text key={`t${v}`} x={s.plotW + 6} y={ys.y(v) + 4} className="bt-tick">
            {ys.fmt(v)}
          </text>
        ))}
        {hover !== null && hover >= s.i0 && hover < s.i1 && <line x1={s.x(hover)} x2={s.x(hover)} y1={0} y2={h} className="bt-cross" />}
      </svg>
    </div>
  );
}

/** time labels along the bottom */
export function TimeAxis({ s, t, hover }: { s: Scale; t: number[]; hover: number | null }) {
  const span = (t[s.i1 - 1] ?? 0) - (t[s.i0] ?? 0);
  const n = Math.max(2, Math.floor(s.plotW / 110));
  const fmt = (sec: number) => {
    const d = new Date(sec * 1000);
    const hm = d.toISOString().slice(11, 16);
    return span > 2 * 86400 ? `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}${span < 6 * 86400 ? ` ${hm}` : ''}` : hm;
  };
  const marks = Array.from({ length: n }, (_, k) => Math.round(s.i0 + ((s.i1 - 1 - s.i0) * k) / (n - 1)));
  return (
    <svg width={s.width} height={22} className="bt-time">
      {marks.map((i, k) => (
        // the first and last labels hang inwards so they are never cut at the edges
        <text key={i} x={s.x(i)} y={15} textAnchor={k === 0 ? 'start' : k === marks.length - 1 ? 'end' : 'middle'}>
          {fmt(t[i])}
        </text>
      ))}
      {hover !== null && hover >= s.i0 && hover < s.i1 && (
        <g>
          <rect x={Math.max(0, Math.min(s.plotW - 104, s.x(hover) - 52))} y={1} width={104} height={19} className="bt-timetag" />
          <text x={Math.max(52, Math.min(s.plotW - 52, s.x(hover)))} y={15} textAnchor="middle" className="bt-timetag-text">
            {new Date(t[hover] * 1000).toISOString().slice(5, 16).replace('T', ' ')}
          </text>
        </g>
      )}
    </svg>
  );
}
