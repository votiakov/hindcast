import { useState } from 'react';
import { ChevronDown, PanelLeftClose, PanelLeftOpen, SquareDashed } from 'lucide-react';
import { CATEGORIES, KINDS, TIERS, type Kind } from '../sim/catalog';
import { KIND_ICONS } from '../canvas/icons';
import { DND_TYPE, ZONE_KIND, adders } from '../canvas/BoardCanvas';
import { useSim } from '../sim/store';

type Item = { kind: Kind | typeof ZONE_KIND; label: string; meta: string; color: string; Icon: typeof SquareDashed; description: string };

const fmtCap = (n: number) => (n >= 1000 ? `${n / 1000}k` : `${n}`);

function itemFor(k: Kind): Item {
  const s = KINDS[k];
  const meta =
    k === 'client' ? 'traffic source'
    : k === 'function' ? 'auto-scales · $0.60/1M req'
    : k === 'llmapi' ? `rate-limited · $${s.costPerRequest}/req`
    : k === 'external' ? 'not yours · rate-limited'
    : k === 'stream' ? `1k msg/s · $${s.costPerHour}/h per partition`
    : k === 'dns' ? 'cached · health-checked'
    : k === 'edge' ? 'runs before the origin · $0.30/1M req + CPU'
    : k === 'archive' ? '$0.004/GB-mo · ms to hours to read'
    : k === 'vector' ? `${fmtCap(s.capacity)}/s per node at recall 0.95`
    : k === 'search' ? `${fmtCap(s.capacity)}/s per node · $${s.costPerHour.toFixed(2)}/h`
    : k === 'kv' ? `on demand · $${(s.costPerRequest! * 1e6).toFixed(2)}/1M req`
    : `${fmtCap(s.capacity)}/s · $${(s.costPerHour * TIERS.S.cost).toFixed(2)}/h`;
  return { kind: k, label: s.label, meta, color: s.color, Icon: KIND_ICONS[k], description: s.description };
}

const GROUPS: { id: string; label: string; items: Item[] }[] = [
  ...CATEGORIES.map((c) => ({ id: c.id, label: c.label, items: c.kinds.map(itemFor) })),
  {
    id: 'layout',
    label: 'Failure domains',
    items: [{ kind: ZONE_KIND, label: 'Zone / AZ', meta: 'group & fail together', color: '#38bdf8', Icon: SquareDashed, description: 'Availability zone, region or VPC. Fail it to take down everything inside.' }],
  },
];

export function Palette({ compact }: { compact?: boolean }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [rail, setRail] = useState(!!compact);
  const isRail = rail;
  const add = (k: Item['kind']) => adders[useSim.getState().focus]?.(k);

  return (
    <div className={`palette panel ${isRail ? 'rail' : ''} ${compact ? 'in-compare' : ''}`}>
      <div className="palette-top">
        {!isRail && <div className="panel-title">Components</div>}
        <button className="icon-btn small" onClick={() => setRail(!isRail)} title={isRail ? 'Expand' : 'Collapse'}>
          {isRail ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
        </button>
      </div>
      <div className="palette-scroll">
        {GROUPS.map((g) => (
          <div key={g.id} className="palette-group">
            {isRail ? (
              <div className="rail-sep" title={g.label} />
            ) : (
              <button className="group-head" onClick={() => setCollapsed({ ...collapsed, [g.id]: !collapsed[g.id] })}>
                <span>{g.label}</span>
                <ChevronDown size={12} className={collapsed[g.id] ? 'rot' : ''} />
              </button>
            )}
            {!collapsed[g.id] &&
              g.items.map((it) => (
                <div
                  key={it.kind}
                  className="palette-item"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DND_TYPE, it.kind);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onClick={() => add(it.kind)}
                  title={`${it.label} — ${it.description}`}
                  style={{ ['--accent' as string]: it.color }}
                >
                  <div className="palette-icon">
                    <it.Icon size={16} />
                  </div>
                  {!isRail && (
                    <div className="palette-text">
                      <div className="palette-name">{it.label}</div>
                      <div className="palette-meta">{it.meta}</div>
                    </div>
                  )}
                </div>
              ))}
          </div>
        ))}
      </div>
      {!isRail && <div className="palette-tip">Drag onto a board or click. Connect handles right → left. Select a node to scale or break it.</div>}
    </div>
  );
}
