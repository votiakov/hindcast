import { useState } from 'react';
import { Calculator, Play, X } from 'lucide-react';
import { useSim } from '../sim/store';
import './envelope.css';

/**
 * Back of the envelope, then onto the board: users and their habits in, request rates, storage and
 * bandwidth out — and one click runs the peak on the design you are drawing.
 * Presets use the traffic assumptions of The System Design Primer's problems (Donne Martin, CC BY 4.0).
 */

interface Inputs {
  dau: number;
  readsPerUser: number;
  writesPerUser: number;
  kbPerWrite: number;
  kbPerRead: number;
  peak: number;
  years: number;
}

const PRESETS: { id: string; label: string; v: Inputs }[] = [
  { id: 'pastebin', label: 'Pastebin', v: { dau: 1_000_000, readsPerUser: 3.3, writesPerUser: 0.33, kbPerWrite: 1.27, kbPerRead: 1.27, peak: 3, years: 3 } },
  { id: 'twitter', label: 'Twitter timeline', v: { dau: 100_000_000, readsPerUser: 83, writesPerUser: 5, kbPerWrite: 10, kbPerRead: 10, peak: 2, years: 3 } },
  { id: 'mint', label: 'Mint', v: { dau: 10_000_000, readsPerUser: 1.7, writesPerUser: 17, kbPerWrite: 0.05, kbPerRead: 5, peak: 3, years: 5 } },
  { id: 'crawler', label: 'Web crawler + search', v: { dau: 100_000_000, readsPerUser: 33, writesPerUser: 1.3, kbPerWrite: 500, kbPerRead: 2, peak: 2, years: 1 } },
];

const SECONDS_PER_DAY = 86_400;
const fmt = (x: number) => (x >= 1e6 ? `${(x / 1e6).toFixed(x >= 1e7 ? 0 : 1)}M` : x >= 1e4 ? `${Math.round(x / 1e3)}k` : x >= 100 ? Math.round(x).toLocaleString('en-US') : x >= 10 ? x.toFixed(1) : x.toFixed(2));
const bytes = (gb: number) => (gb >= 1e6 ? `${(gb / 1e6).toFixed(1)} PB` : gb >= 1e3 ? `${(gb / 1e3).toFixed(1)} TB` : gb >= 1 ? `${gb.toFixed(gb >= 100 ? 0 : 1)} GB` : `${(gb * 1e3).toFixed(0)} MB`);
const rate = (mbps: number) => (mbps >= 1000 ? `${(mbps / 1000).toFixed(1)} GB/s` : `${mbps.toFixed(mbps >= 10 ? 0 : 1)} MB/s`);

export function envelope(v: Inputs) {
  const reads = (v.dau * v.readsPerUser) / SECONDS_PER_DAY;
  const writes = (v.dau * v.writesPerUser) / SECONDS_PER_DAY;
  const avg = reads + writes;
  const perDayGb = (v.dau * v.writesPerUser * v.kbPerWrite) / 1e6;
  return {
    reads,
    writes,
    avg,
    peak: avg * v.peak,
    readRatio: avg > 0 ? reads / avg : 0.8,
    storeMonth: perDayGb * 30,
    storeTotal: perDayGb * 365 * v.years,
    egress: (reads * v.kbPerRead) / 1000,
    ingress: (writes * v.kbPerWrite) / 1000,
  };
}

export function EnvelopePanel() {
  const setOpen = useSim((s) => s.setEnvelopeOpen);
  const [v, setV] = useState<Inputs>(PRESETS[0].v);
  const r = envelope(v);
  const field = (k: keyof Inputs, label: string, step = 1) => (
    <label>
      <span>{label}</span>
      <input type="number" min={0} step={step} value={v[k]} onChange={(e) => setV({ ...v, [k]: Math.max(0, +e.target.value || 0) })} />
    </label>
  );
  const run = () => {
    const s = useSim.getState();
    s.setReadRatio(Math.round(r.readRatio * 100) / 100);
    s.setPattern('steady');
    s.setTraffic(Math.max(1, Math.round(r.peak)));
    s.setRunning(true);
    s.toast('info', `Running the peak: ${fmt(r.peak)} req/s, ${Math.round(r.readRatio * 100)}% reads.`);
  };

  return (
    <div className="env panel">
      <div className="au-head">
        <Calculator size={16} />
        <div>
          <div className="au-h1">Back of the envelope</div>
          <div className="au-h2">from users to req/s, storage and bandwidth — then run it</div>
        </div>
        <button className="icon-btn" onClick={() => setOpen(false)} title="Close">
          <X size={15} />
        </button>
      </div>
      <div className="env-presets">
        {PRESETS.map((p) => (
          <button key={p.id} className={JSON.stringify(p.v) === JSON.stringify(v) ? 'on' : ''} onClick={() => setV(p.v)}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="env-inputs">
        {field('dau', 'daily active users', 1000)}
        {field('readsPerUser', 'reads per user per day', 0.1)}
        {field('writesPerUser', 'writes per user per day', 0.1)}
        {field('kbPerWrite', 'KB stored per write', 0.1)}
        {field('kbPerRead', 'KB sent per read', 0.1)}
        {field('peak', 'peak ÷ average', 0.5)}
        {field('years', 'keep data for (years)', 1)}
      </div>
      <div className="env-out">
        <div className="env-row big">
          <span>average</span>
          <b>{fmt(r.avg)} req/s</b>
        </div>
        <div className="env-row big">
          <span>peak</span>
          <b>{fmt(r.peak)} req/s</b>
        </div>
        <div className="env-row">
          <span>reads / writes</span>
          <b>
            {fmt(r.reads)} / {fmt(r.writes)} per s · {Math.round(r.readRatio * 100)}% reads
          </b>
        </div>
        <div className="env-row">
          <span>new data</span>
          <b>
            {bytes(r.storeMonth)} a month · {bytes(r.storeTotal)} in {v.years} y
          </b>
        </div>
        <div className="env-row">
          <span>bandwidth out / in</span>
          <b>
            {rate(r.egress)} / {rate(r.ingress)}
          </b>
        </div>
        <p className="env-note">A day is 86,400 s and a month about 2.6 M: 1 req/s ≈ 2.6 M requests a month. Averages hide the peak — design for the peak, pay for the average.</p>
      </div>
      <div className="env-foot">
        <button className="btn primary" onClick={run}>
          <Play size={13} /> Run the peak on the board
        </button>
        <span className="env-credit">Presets after The System Design Primer (CC BY 4.0)</span>
      </div>
    </div>
  );
}
