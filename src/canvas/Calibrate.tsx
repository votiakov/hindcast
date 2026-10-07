import { useState } from 'react';
import { KINDS, RUNTIMES, TIERS, type SystemNodeData } from '../sim/catalog';

/**
 * Calibrate a component from production numbers: one instance served R req/s at C % CPU with a
 * median of L ms, and costs $/h. Writes the per-size-S overrides (capacity, latencyMs, costPerHour)
 * so that this instance size and runtime reproduce exactly what was measured.
 */
export function Calibrate({ d, apply }: { d: SystemNodeData; apply: (patch: Partial<SystemNodeData>) => void }) {
  const [rps, setRps] = useState('');
  const [cpu, setCpu] = useState('');
  const [p50, setP50] = useState('');
  const [price, setPrice] = useState('');
  const spec = KINDS[d.kind];
  const tier = spec.tiered ? TIERS[d.tier] : { capacity: 1, cost: 1 };
  const rt = d.runtime ? RUNTIMES[d.runtime] : { throughput: 1, latency: 1 };
  const r = parseFloat(rps);
  const c = parseFloat(cpu) / 100;
  const l = parseFloat(p50);
  const p = parseFloat(price);
  const patch: Partial<SystemNodeData> = {};
  if (r > 0 && c > 0 && c <= 1) patch.capacity = Math.round((r / c / (tier.capacity * rt.throughput)) * 10) / 10;
  if (l > 0) patch.latencyMs = Math.round((l / rt.latency) * 100) / 100;
  if (p >= 0 && price !== '') patch.costPerHour = Math.round((p / tier.cost) * 10000) / 10000;
  const n = Object.keys(patch).length;
  const field = (label: string, v: string, set: (x: string) => void, unit: string, ph: string) => (
    <label className="cal-f">
      <span>{label}</span>
      <input type="number" min={0} value={v} placeholder={ph} onChange={(e) => set(e.target.value)} />
      <em>{unit}</em>
    </label>
  );
  return (
    <div className="cal">
      <div className="cal-h">one instance in production…</div>
      <div className="cal-row">
        {field('served', rps, setRps, 'req/s', '180')}
        {field('at', cpu, setCpu, '% CPU', '60')}
        {field('p50', p50, setP50, 'ms', '22')}
        {field('costs', price, setPrice, '$/h', '0.17')}
      </div>
      <div className="cal-foot">
        {patch.capacity !== undefined && <span>→ {Math.round(r / c)} req/s per instance at 100%</span>}
        <button className="tb-chip wide" disabled={!n} onClick={() => apply(patch)}>
          apply
        </button>
        {(d.capacity !== undefined || d.latencyMs !== undefined || d.costPerHour !== undefined) && (
          <button className="tb-chip wide" onClick={() => apply({ capacity: undefined, latencyMs: undefined, costPerHour: undefined })} title="Back to catalogue defaults">
            reset
          </button>
        )}
      </div>
    </div>
  );
}
