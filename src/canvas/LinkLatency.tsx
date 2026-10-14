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
  const edge = useSim((s) => s.boards[b].edges.find((e) => e.id === id));
  // one string, not a fresh array: a selector must return something stable between renders
  const key = useSim((s) => {
    const nodes = s.boards[b].nodes;
    const find = (nid?: string) => nodes.find((n) => n.id === nid)?.data as { kind?: string; side?: string } | undefined;
    const [a, z] = [find(edge?.source), find(edge?.target)];
    return `${a?.kind ?? ''}|${a?.side ?? ''}|${z?.kind ?? ''}|${z?.side ?? ''}`;
  });
  const [k0, s0, k1, s1] = key.split('|');
  const ends = [{ kind: k0, side: s0 || undefined }, { kind: k1, side: s1 || undefined }] as const;
  const replicated = ends[0]?.kind === 'db' && ends[1]?.kind === 'replica';
  const sync = data?.replication === 'sync';
  const severed = !!ends[0]?.side && !!ends[1]?.side && ends[0]?.side !== ends[1]?.side;
  const updateEdge = useSim((s) => s.updateEdge);
  return (
    <>
      {ms > 0 && !selected && <span className="edge-link" title="Network round trip on this link">+{ms}ms</span>}
      {calls > 1 && !selected && <span className="edge-link" title="Calls per request over this link, in parallel: the caller needs every one">×{calls}</span>}
      {carries && !selected && <span className="edge-link" title={`This link carries only ${carries}`}>{carries}</span>}
      {replicated && sync && !selected && <span className="edge-link" title="Synchronous replication: every write waits for this replica">sync</span>}
      {severed && <span className="edge-link cut" title="A network partition cuts this link: nothing gets through">✂ cut</span>}
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
          {replicated && (
            <select className="edge-link-select nodrag" value={sync ? 'sync' : 'async'} onChange={(e) => updateEdge(b, id, { replication: e.target.value === 'sync' ? 'sync' : undefined })} title="sync: every write waits for this replica — nothing lost on failover, writes stop while it is out of reach. async: the replica lags; a failover loses what it had not received">
              <option value="async">async replication</option>
              <option value="sync">sync replication</option>
            </select>
          )}
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
