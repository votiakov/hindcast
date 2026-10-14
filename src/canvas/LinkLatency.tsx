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

const CALLS = [1, 2, 3, 5, 10, 20, 50, 100];

/** link latency and calls-per-request badges (always) and pickers (when the edge is selected), shared by all themes */
export function LinkLatency({ id, selected }: { id: string; selected?: boolean }) {
  const b = useBoardId();
  const data = useSim((s) => s.boards[b].edges.find((e) => e.id === id)?.data);
  const ms = Number(data?.latencyMs ?? 0);
  const calls = Number(data?.calls ?? 1);
  const carries = data?.carries as 'reads' | 'writes' | undefined;
  const updateEdge = useSim((s) => s.updateEdge);
  return (
    <>
      {ms > 0 && !selected && <span className="edge-link" title="Network round trip on this link">+{ms}ms</span>}
      {calls > 1 && !selected && <span className="edge-link" title="Calls per request over this link, in parallel: the caller needs every one">×{calls}</span>}
      {carries && !selected && <span className="edge-link" title={`This link carries only ${carries}`}>{carries}</span>}
      {selected && (
        <>
          <select className="edge-link-select nodrag" value={ms} onChange={(e) => updateEdge(b, id, { latencyMs: +e.target.value || undefined })} title="Network round trip added to every call over this link">
            {LINK_PRESETS.some((p) => p.ms === ms) ? null : <option value={ms}>{ms} ms</option>}
            {LINK_PRESETS.map((p) => (
              <option key={p.ms} value={p.ms}>
                {p.label}
              </option>
            ))}
          </select>
          <select className="edge-link-select nodrag" value={carries ?? ''} onChange={(e) => updateEdge(b, id, { carries: (e.target.value || undefined) as 'reads' | 'writes' | undefined })} title="Which requests take this link: reads to a cache or replica, writes to a queue (CQRS)">
            <option value="">reads + writes</option>
            <option value="reads">reads only</option>
            <option value="writes">writes only</option>
          </select>
          <select className="edge-link-select nodrag" value={calls} onChange={(e) => updateEdge(b, id, { calls: +e.target.value > 1 ? +e.target.value : undefined })} title="Calls per request over this link, made in parallel: a tweet written to N timelines, N lookups per page">
            {CALLS.includes(calls) ? null : <option value={calls}>×{calls}</option>}
            {CALLS.map((n) => (
              <option key={n} value={n}>
                {n === 1 ? '1 call / request' : `×${n} calls / request`}
              </option>
            ))}
          </select>
        </>
      )}
    </>
  );
}
