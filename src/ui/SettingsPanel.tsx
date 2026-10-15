import { useEffect, useRef, useState } from 'react';
import { Settings as Gear } from 'lucide-react';
import { useSim, type Settings } from '../sim/store';
import { COMMITMENT_NOTE, PRICING, type Commitment, type PricingId } from '../sim/pricing';

type BoolKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

const SECTIONS: { title: string; items: { key: BoolKey; label: string; hint: string }[] }[] = [
  {
    title: 'Simulation',
    items: [
      { key: 'cost', label: 'Cost model', hint: 'Show $/h everywhere and enforce budget goals' },
      { key: 'autoFailover', label: 'Automatic DB failover', hint: 'Replicas get promoted when a primary dies' },
      { key: 'coldStarts', label: 'Serverless cold starts', hint: 'Extra latency while functions scale up' },
      { key: 'jitter', label: 'Traffic jitter', hint: 'Small random noise on top of the traffic curve' },
    ],
  },
  {
    title: 'Display',
    items: [
      { key: 'particles', label: 'Request particles', hint: 'Animated requests along connections' },
      { key: 'explain', label: 'Explanations', hint: 'Plain-English callouts on stressed components (Terminal and Reference themes)' },
      { key: 'alerts', label: 'Alert toasts', hint: 'Pop-ups for overloads, recoveries, failovers' },
    ],
  },
];

export function SettingsButton() {
  const [open, setOpen] = useState(false);
  const settings = useSim((s) => s.settings);
  const setSetting = useSim((s) => s.setSetting);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  return (
    <div className="settings" ref={ref}>
      <button className={`icon-btn ${open ? 'on' : ''}`} onClick={() => setOpen(!open)} title="Simulation settings">
        <Gear size={16} />
      </button>
      {open && (
        <div className="settings-pop panel">
          <div className="settings-sec">
            <div className="panel-title">Pricing</div>
            <div className="seg">
              {(Object.keys(PRICING) as PricingId[]).map((p) => (
                <button key={p} className={settings.pricing === p ? 'on' : ''} onClick={() => setSetting('pricing', p)} title={PRICING[p].label}>
                  {PRICING[p].short}
                </button>
              ))}
            </div>
            {settings.pricing !== 'illustrative' && (
              <>
                <div className="seg" style={{ marginTop: 6 }}>
                  {(['none', '1y', '3y'] as Commitment[]).map((c) => (
                    <button key={c} className={settings.commitment === c ? 'on' : ''} onClick={() => setSetting('commitment', c)} title={c === 'none' ? 'On-demand prices' : `${c === '1y' ? 'One' : 'Three'}-year commitment: ${COMMITMENT_NOTE[settings.pricing as Exclude<PricingId, 'illustrative'>]}`}>
                      {c === 'none' ? 'on-demand' : c === '1y' ? '1-year' : '3-year'}
                    </button>
                  ))}
                </div>
                <div className="toggle-hint" style={{ marginTop: 6 }}>
                  Real SKUs, {settings.commitment === 'none' ? 'on-demand' : `${settings.commitment === '1y' ? '1' : '3'}-year commitment (${COMMITMENT_NOTE[settings.pricing as Exclude<PricingId, 'illustrative'>]})`}, as of {PRICING[settings.pricing].asOf}. Sources and assumptions: docs/catalog.md.
                </div>
              </>
            )}
          </div>
          {SECTIONS.map((sec) => (
            <div key={sec.title} className="settings-sec">
              <div className="panel-title">{sec.title}</div>
              {sec.items.map((it) => (
                <label key={it.key} className="toggle-row">
                  <div>
                    <div className="toggle-label">{it.label}</div>
                    <div className="toggle-hint">{it.hint}</div>
                  </div>
                  <input type="checkbox" className="switch" checked={settings[it.key]} onChange={(e) => setSetting(it.key, e.target.checked)} />
                </label>
              ))}
            </div>
          ))}
          <div className="settings-sec">
            <div className="panel-title">SLO</div>
            <label className="slider-row">
              <span>Max error rate</span>
              <select className="tb-select" value={settings.sloErrorRate} onChange={(e) => setSetting('sloErrorRate', +e.target.value)}>
                {[0.0001, 0.001, 0.005, 0.01, 0.02, 0.05].map((v) => (
                  <option key={v} value={v}>
                    {+(v * 100).toFixed(2)}%
                  </option>
                ))}
              </select>
            </label>
            <label className="slider-row">
              <span>p99 latency</span>
              <input type="range" min={50} max={3000} step={50} value={settings.sloP99Ms} onChange={(e) => setSetting('sloP99Ms', +e.target.value)} />
              <span className="mono">{settings.sloP99Ms}ms</span>
            </label>
          </div>
          <div className="settings-sec">
            <div className="panel-title">Tuning</div>
            <label className="slider-row">
              <span>Request timeout</span>
              <input type="range" min={0.2} max={5} step={0.1} value={settings.timeoutS} onChange={(e) => setSetting('timeoutS', +e.target.value)} />
              <span className="mono">{settings.timeoutS.toFixed(1)}s</span>
            </label>
            <label className={`slider-row ${settings.autoFailover ? '' : 'disabled'}`}>
              <span>Failover time</span>
              <input type="range" min={1} max={30} step={1} disabled={!settings.autoFailover} value={settings.failoverS} onChange={(e) => setSetting('failoverS', +e.target.value)} />
              <span className="mono">{settings.failoverS}s</span>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
