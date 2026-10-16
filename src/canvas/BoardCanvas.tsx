import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Background, BackgroundVariant, MiniMap, NodeToolbar, Position, ReactFlow, useReactFlow, useStore, type NodeTypes, type EdgeTypes, type XYPosition } from '@xyflow/react';
import { SquareDashed } from 'lucide-react';
import { insertTarget, useSim, type BoardId } from '../sim/store';
import { KINDS, isSystem, isUp, type AppNode, type Kind, type SystemNodeData } from '../sim/catalog';
import { SystemNode, healthOf } from './SystemNode';
import { ZoneNode } from './ZoneNode';
import { FlowEdge } from './FlowEdge';
import { BoardContext } from './BoardContext';
import { RefMarkers } from '../theme/reference/RefEdge';
import { NoteNode } from './NoteNode';
import { SectionNode } from './SectionNode';
import { fitSections, membersOf } from '../sim/sections';
import { TraceStrip } from '../ui/TraceStrip';

export const DND_TYPE = 'application/x-bottleneck-kind';
export const ZONE_KIND = 'zone';

const TERMINAL_MAP_HEALTH = { idle: '#33475a', ok: '#6e8191', warm: '#e3c55a', hot: '#ef5b5b', down: '#22303c' } as const;

const nodeTypes: NodeTypes = { system: SystemNode, zone: ZoneNode, note: NoteNode, section: SectionNode };
const edgeTypes: EdgeTypes = { flow: FlowEdge };

/** palette click-to-add goes to the focused board; each canvas registers how to add at its centre */
export const adders: Partial<Record<BoardId, (kind: Kind | typeof ZONE_KIND) => void>> = {};

interface Props {
  id: BoardId;
  padding: { top: `${number}px`; left: `${number}px`; right: `${number}px`; bottom: `${number}px` };
  minimap?: boolean;
  /** false = presentation canvas: no dragging, selection, panning or zooming */
  interactive?: boolean;
  /** studio: base fit animation duration (ms) */
  fitDuration?: number;
  /** overlays rendered inside the flow (e.g. ViewportPortal annotations) */
  children?: React.ReactNode;
  /** a small pane (Compare): when the fit shrinks the cards past reading, they show less in bigger type */
  legible?: boolean;
}

/** below this zoom a card's 10–13 px text drops under 10 px on screen */
const LEGIBLE_ZOOM = 0.85;

export function BoardCanvas({ id, padding, minimap = true, interactive = true, fitDuration = 400, children, legible = false }: Props) {
  const stored = useSim((s) => s.boards[id].nodes);
  // sections are drawn around their members as they are now
  const nodes = useMemo(() => fitSections(stored), [stored]);
  const edges = useSim((s) => s.boards[id].edges);
  const version = useSim((s) => s.boards[id].version);
  const { onNodesChange, onEdgesChange, onConnect, addNode, addZone, moveNodes, setFocus } = useSim.getState();
  const { screenToFlowPosition, flowToScreenPosition, fitView } = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const zoneDrag = useRef<{ start: XYPosition; members: Record<string, XYPosition> } | null>(null);

  const camera = useSim((s) => (s.mode === 'studio' ? s.studio.camera[id] : null));
  // rounded so the cards re-render on a step of the zoom, not on every frame of a pinch
  const zoom = useStore((s) => Math.round(s.transform[2] * 100) / 100);
  const compact = legible && zoom < LEGIBLE_ZOOM;
  const mapAt = useMinimapSpot(id, wrapper, minimap);

  useEffect(() => {
    const t = setTimeout(() => fitView({ padding, duration: fitDuration, maxZoom: 1.1 }), 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, fitView, padding.right, padding.left, padding.top]);

  // scripted camera moves (studio episodes)
  useEffect(() => {
    if (!camera || camera.seq === 0) return;
    if (camera.nodes) fitView({ nodes: camera.nodes.map((n) => ({ id: n })), padding: 1.3, duration: 900, maxZoom: 1.5 });
    else fitView({ padding, duration: 900, maxZoom: 1.1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera?.seq]);

  const add = useCallback(
    (kind: Kind | typeof ZONE_KIND, p: XYPosition, from?: string) => {
      if (kind === ZONE_KIND) addZone(id, { x: p.x - 280, y: p.y - 190 });
      else addNode(id, kind, { x: p.x - 115, y: p.y - 60 }, from);
    },
    [id, addNode, addZone],
  );

  useEffect(() => {
    adders[id] = (kind) => {
      const r = wrapper.current!.getBoundingClientRect();
      const nodes = useSim.getState().boards[id].nodes.filter((n) => n.type === 'system');
      // next to the selected component (where a chain grows), else the middle of the view; then the
      // nearest spot nothing occupies, so a new card never lands on top of an existing one
      const sel = nodes.find((n) => n.selected);
      // a cache or CDN goes between the selected component and what it calls: below the link it cuts in on
      const via = sel && kind !== ZONE_KIND ? insertTarget(useSim.getState().boards[id].nodes, useSim.getState().boards[id].edges, sel.id, kind) : null;
      const callee = via && nodes.find((n) => n.id === via.target);
      const start = sel && callee ? { x: (sel.position.x + callee.position.x) / 2 + 115, y: Math.max(sel.position.y, callee.position.y) + 240 + 60 } : sel ? { x: sel.position.x + 330 + 115, y: sel.position.y + 60 } : screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      const taken = (q: XYPosition) => nodes.some((n) => Math.abs(n.position.x - (q.x - 115)) < 260 && Math.abs(n.position.y - (q.y - 60)) < 200);
      let p = start;
      for (let k = 0; k < 40 && taken(p); k++) {
        const ring = Math.floor(k / 8) + 1;
        const a = (k % 8) * (Math.PI / 4);
        p = { x: start.x + Math.round(Math.cos(a)) * 300 * ring, y: start.y + Math.round(Math.sin(a)) * 220 * ring };
      }
      // a click next to the selected component grows the chain: the new one is linked from it (⌘Z undoes both)
      add(kind, p, sel && kind !== 'client' && kind !== ZONE_KIND ? sel.id : undefined);
      // the board does not follow a card placed off screen by itself
      const tl = flowToScreenPosition({ x: p.x - 115, y: p.y - 60 });
      const br = flowToScreenPosition({ x: p.x + 115, y: p.y + 90 });
      if (tl.x < r.left || tl.y < r.top || br.x > r.right || br.y > r.bottom) setTimeout(() => fitView({ padding, duration: 300, maxZoom: 1.1 }), 30);
    };
    return () => {
      delete adders[id];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, add, screenToFlowPosition, flowToScreenPosition, fitView]);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const kind = e.dataTransfer.getData(DND_TYPE) as Kind | typeof ZONE_KIND;
      if (!kind || (kind !== ZONE_KIND && !KINDS[kind])) return;
      setFocus(id);
      add(kind, screenToFlowPosition({ x: e.clientX, y: e.clientY }));
    },
    [id, add, screenToFlowPosition, setFocus],
  );

  // dragging a zone carries the nodes inside it; a section, its members (those not already dragged along)
  const onNodeDragStart = useCallback(
    (_: unknown, node: AppNode) => {
      if (node.type === 'section') {
        const all = useSim.getState().boards[id].nodes;
        const ids = new Set(membersOf(all, node));
        const members: Record<string, XYPosition> = {};
        for (const n of all) if (ids.has(n.id) && !n.selected) members[n.id] = { ...n.position };
        zoneDrag.current = { start: { ...node.position }, members };
        return;
      }
      if (node.type !== 'zone') return;
      const w = node.width ?? node.measured?.width ?? 0;
      const h = node.height ?? node.measured?.height ?? 0;
      const members: Record<string, XYPosition> = {};
      for (const n of useSim.getState().boards[id].nodes) {
        if (!isSystem(n)) continue;
        const cx = n.position.x + (n.measured?.width ?? 230) / 2;
        const cy = n.position.y + (n.measured?.height ?? 150) / 2;
        if (cx >= node.position.x && cx <= node.position.x + w && cy >= node.position.y && cy <= node.position.y + h) members[n.id] = { ...n.position };
      }
      zoneDrag.current = { start: { ...node.position }, members };
    },
    [id],
  );
  const onNodeDrag = useCallback(
    (_: unknown, node: AppNode) => {
      const zd = zoneDrag.current;
      if ((node.type !== 'zone' && node.type !== 'section') || !zd) return;
      const dx = node.position.x - zd.start.x;
      const dy = node.position.y - zd.start.y;
      const next: Record<string, XYPosition> = {};
      for (const [nid, p] of Object.entries(zd.members)) next[nid] = { x: p.x + dx, y: p.y + dy };
      moveNodes(id, next);
    },
    [id, moveNodes],
  );

  return (
    <BoardContext.Provider value={id}>
      <RefMarkers />
      <div ref={wrapper} className={`board-canvas ${compact ? 'legible' : ''}`} style={compact ? ({ '--z': zoom } as React.CSSProperties) : undefined} onDragOver={(e) => e.preventDefault()} onDrop={onDrop} onPointerDown={() => setFocus(id)}>
        <ReactFlow<AppNode>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={(c) => onNodesChange(id, c)}
          onEdgesChange={(c) => onEdgesChange(id, c)}
          onConnect={(c) => onConnect(id, c)}
          onNodeDragStart={onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={() => (zoneDrag.current = null)}
          defaultEdgeOptions={{ type: 'flow' }}
          elevateNodesOnSelect={false}
          colorMode="dark"
          minZoom={0.15}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          deleteKeyCode={interactive ? ['Backspace', 'Delete'] : null}
          nodesDraggable={interactive}
          nodesConnectable={interactive}
          elementsSelectable={interactive}
          panOnDrag={interactive}
          zoomOnScroll={interactive}
          zoomOnPinch={interactive}
          zoomOnDoubleClick={interactive}
          preventScrolling={interactive}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.4} color="#1e293b" />
          {children}
          {minimap && <ReplicaToggle id={id} wrapper={wrapper} padding={padding} />}
          {interactive && <GroupBar id={id} />}
          {minimap && mapAt && (
            <MiniMap
              position={mapAt}
              pannable
              zoomable
              className="minimap"
              maskColor="rgba(2,6,23,0.7)"
              nodeColor={(n) => {
                if (n.type === 'zone') return 'rgba(56, 189, 248, 0.08)';
                if (n.type === 'note') return 'rgba(250, 204, 21, 0.25)';
                if (n.type === 'section') return 'transparent';
                const st = useSim.getState().boards[id].nodeStats[n.id];
                const d = (n as AppNode & { type: 'system' }).data;
                const h = healthOf(st?.util ?? 0, st?.dropRps ?? 0, st?.inRps ?? 1, isUp(d));
                return TERMINAL_MAP_HEALTH[h];
              }}
            />
          )}
        </ReactFlow>
        {interactive && <TraceStrip board={id} padding={padding} />}
      </div>
    </BoardContext.Provider>
  );
}

type Spot = 'bottom-right' | 'top-right';
const SPOTS: Spot[] = ['bottom-right', 'top-right'];
type Box = { left: number; right: number; top: number; bottom: number };
const hits = (a: Box, b: DOMRect) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);

/**
 * Where the minimap goes: a corner where it covers no card (bottom right, else top right), and nowhere
 * when both would cover one. A covered card is worse than a missing minimap. Each corner's place is
 * learnt the first time the map is drawn there, kept relative to the board's right edge and to the
 * edge it sits against, so it follows the board as panels open and the window resizes
 */
function useMinimapSpot(id: BoardId, wrapper: React.RefObject<HTMLDivElement | null>, on: boolean): Spot | null {
  const [spot, setSpot] = useState<Spot | null>('bottom-right');
  const seen = useRef<Partial<Record<Spot, { dr: number; w: number; h: number; d: number }>>>({});
  const nodes = useSim((s) => s.boards[id].nodes);
  const view = useStore((s) => s.transform.join(','));
  const [size, setSize] = useState(0);
  useEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize((x) => x + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, [wrapper]);
  useEffect(() => {
    if (!on) return;
    const raf = requestAnimationFrame(() => {
      const root = wrapper.current;
      if (!root) return;
      const r = root.getBoundingClientRect();
      const map = root.querySelector('.react-flow__minimap')?.getBoundingClientRect();
      if (map && spot) seen.current[spot] = { dr: r.right - map.right, w: map.width, h: map.height, d: spot === 'top-right' ? map.top - r.top : r.bottom - map.bottom };
      const box = (s: Spot): Box | null => {
        const m = seen.current[s];
        if (!m) return null;
        const right = r.right - m.dr;
        const top = s === 'top-right' ? r.top + m.d : r.bottom - m.d - m.h;
        return { left: right - m.w, right, top, bottom: top + m.h };
      };
      const cards = [...root.querySelectorAll('.react-flow__node-system, .react-flow__node-note')].map((n) => n.getBoundingClientRect());
      let next: Spot | null = null;
      for (const s of SPOTS) {
        const b = box(s);
        // a corner not yet seen is tried, and judged once the map is drawn there
        if (!b || !cards.some((c) => hits(b, c))) {
          next = s;
          break;
        }
      }
      if (next !== spot) setSpot(next);
    });
    return () => cancelAnimationFrame(raf);
  }, [on, nodes, view, spot, size, wrapper]);
  return spot;
}

/** two or more components selected (box-select, shift-click): group them as a section */
function GroupBar({ id }: { id: BoardId }) {
  const picked = useSim((s) => {
    const ids = s.boards[id].nodes.filter((n) => n.type === 'system' && n.selected).map((n) => n.id);
    return ids.length > 1 ? ids.join(' ') : '';
  });
  if (!picked) return null;
  const ids = picked.split(' ');
  return (
    <NodeToolbar nodeId={ids} isVisible position={Position.Top} align="start" offset={14} className="node-toolbar group-bar">
      <div className="tb-group">
        <button className="tb-btn wide" onClick={() => useSim.getState().addSection(id, ids)} title="Draw a labelled frame around these components, for reading the design (G). Not a failure domain: use a zone for that">
          <SquareDashed size={14} /> Group as section
        </button>
        <span className="tb-label">{ids.length} selected · G</span>
      </div>
    </NodeToolbar>
  );
}

/** grouped: a pip per instance; each: a row per instance with the traffic fanned out */
function ReplicaToggle({ id, wrapper, padding }: { id: BoardId; wrapper: React.RefObject<HTMLDivElement | null>; padding: Props['padding'] }) {
  const view = useSim((s) => s.settings.replicaView);
  const setSetting = useSim((s) => s.setSetting);
  const fleet = useSim((s) => s.boards[id].nodes.some((n) => n.type === 'system' && KINDS[(n.data as SystemNodeData).kind].scalable && ((n.data as SystemNodeData).instances ?? 1) > 1));
  const self = useRef<HTMLDivElement>(null);
  const at = useFreeSpot(id, wrapper, self, padding, fleet);
  if (!fleet) return null;
  return (
    <div
      ref={self}
      className="react-flow__panel replica-toggle"
      style={{ position: 'absolute', margin: 0, left: at?.left ?? '50%', top: at?.top ?? 10, transform: at ? undefined : 'translateX(-50%)', visibility: at ? 'visible' : 'hidden' }}
    >
      <span>replicas</span>
      <div className="seg">
        <button className={view === 'grouped' ? 'on' : ''} onClick={() => setSetting('replicaView', 'grouped')} title="One block per component, a pip per instance">
          grouped
        </button>
        <button className={view === 'each' ? 'on' : ''} onClick={() => setSetting('replicaView', 'each')} title="A row per instance, the traffic fanned out (up to 12)">
          each
        </button>
      </div>
    </div>
  );
}

/**
 * Where the replica toggle sits: on the board's top edge, centred, when that covers no card; else the
 * nearest place along that edge, then further down, that covers nothing (cards, notes, the minimap,
 * the trace strip, toolbars). It stays within the board's padding, which keeps clear of the palette, the
 * side panels and the control bar. Re-judged as the board pans, zooms, resizes and the cards grow
 */
function useFreeSpot(id: BoardId, wrapper: React.RefObject<HTMLDivElement | null>, self: React.RefObject<HTMLDivElement | null>, padding: Props['padding'], on: boolean): { left: number; top: number } | null {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const nodes = useSim((s) => s.boards[id].nodes);
  const view = useStore((s) => s.transform.join(','));
  useEffect(() => {
    if (!on) return;
    const place = () => {
      const root = wrapper.current;
      const me = self.current;
      if (!root || !me) return;
      const r = root.getBoundingClientRect();
      const w = me.offsetWidth || 180;
      const h = me.offsetHeight || 28;
      const gap = 4;
      const obstacles = [...root.querySelectorAll('.react-flow__node-system, .react-flow__node-note, .react-flow__minimap, .react-flow__panel:not(.replica-toggle), .node-toolbar, .trace-strip')].map((n) => n.getBoundingClientRect());
      const free = (left: number, top: number) => {
        const b = { left: r.left + left - gap, right: r.left + left + w + gap, top: r.top + top - gap, bottom: r.top + top + h + gap };
        return !obstacles.some((c) => c.width > 0 && hits(b, c));
      };
      const minX = Math.min(parseFloat(padding.left), Math.max(8, r.width / 2 - w / 2));
      const maxX = Math.max(minX, r.width - Math.min(parseFloat(padding.right), r.width / 2 - w / 2) - w);
      const maxY = Math.max(10, r.height - parseFloat(padding.bottom) - h);
      const centre = Math.round(Math.min(maxX, Math.max(minX, r.width / 2 - w / 2)));
      let next: { left: number; top: number } | null = null;
      for (let top = 8; top <= maxY && !next; top += 12) {
        for (let k = 0; ; k++) {
          const xs = k === 0 ? [centre] : [centre - k * 16, centre + k * 16].filter((x) => x >= minX && x <= maxX);
          if (k > 0 && !xs.length) break;
          const x = xs.find((x) => free(x, top));
          if (x !== undefined) {
            next = { left: x, top };
            break;
          }
        }
      }
      // nowhere free (zoomed in until the cards fill the board): the top edge, centred, as before
      next ??= { left: centre, top: 8 };
      setAt((cur) => (cur && cur.left === next.left && cur.top === next.top ? cur : next));
    };
    const raf = requestAnimationFrame(place);
    // the cards grow and shrink as the run goes (an explanation, the each-replica rows)
    const timer = setInterval(place, 400);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(timer);
    };
  }, [on, nodes, view, wrapper, self, padding.left, padding.right, padding.bottom]);
  return at;
}
