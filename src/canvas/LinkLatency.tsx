import { useSim } from '../sim/store';
import { useBoardId } from './BoardContext';

/** network round trip presets for a connection */
export const LINK_PRESETS: { ms: number; label: string }[] = [
  { ms: 0, label: 'same host' },
  { ms: 0.5, label: 'same data centre ~0.5 ms' },
  { ms: 1.5, label: 'cross-AZ ~1–2 ms' },
  { ms: 15, label: 'nearby region ~15 ms' },
  { ms: 70, label: 'cross-continent ~70 ms' },
  { ms: 150, label: 'intercontinental ~150 ms' },
];

/** link latency badge (always) and picker (when the edge is selected), shared by all themes */
export function LinkLatency({ id, selected }: { id: string; selected?: boolean }) {
  const b = useBoardId();
  const ms = useSim((s) => Number(s.boards[b].edges.find((e) => e.id === id)?.data?.latencyMs ?? 0));
  const updateEdge = useSim((s) => s.updateEdge);
  return (
    <>
      {ms > 0 && !selected && <span className="edge-link" title="Network round trip on this link">+{ms}ms</span>}
      {selected && (
        <select className="edge-link-select nodrag" value={ms} onChange={(e) => updateEdge(b, id, { latencyMs: +e.target.value || undefined })} title="Network round trip added to every call over this link">
          {LINK_PRESETS.some((p) => p.ms === ms) ? null : <option value={ms}>{ms} ms</option>}
          {LINK_PRESETS.map((p) => (
            <option key={p.ms} value={p.ms}>
              {p.label}
            </option>
          ))}
        </select>
      )}
    </>
  );
}
