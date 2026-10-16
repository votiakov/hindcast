import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Background, BackgroundVariant, MiniMap, NodeToolbar, Panel, Position, ReactFlow, useReactFlow, type NodeTypes, type EdgeTypes, type XYPosition } from '@xyflow/react';
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
}

export function BoardCanvas({ id, padding, minimap = true, interactive = true, fitDuration = 400, children }: Props) {
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
      <div ref={wrapper} className="board-canvas" onDragOver={(e) => e.preventDefault()} onDrop={onDrop} onPointerDown={() => setFocus(id)}>
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
          {minimap && <ReplicaToggle id={id} />}
          {interactive && <GroupBar id={id} />}
          {minimap && (
            <MiniMap
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
function ReplicaToggle({ id }: { id: BoardId }) {
  const view = useSim((s) => s.settings.replicaView);
  const setSetting = useSim((s) => s.setSetting);
  const fleet = useSim((s) => s.boards[id].nodes.some((n) => n.type === 'system' && KINDS[(n.data as SystemNodeData).kind].scalable && ((n.data as SystemNodeData).instances ?? 1) > 1));
  if (!fleet) return null;
  return (
    <Panel position="top-center" className="replica-toggle">
      <span>replicas</span>
      <div className="seg">
        <button className={view === 'grouped' ? 'on' : ''} onClick={() => setSetting('replicaView', 'grouped')} title="One block per component, a pip per instance">
          grouped
        </button>
        <button className={view === 'each' ? 'on' : ''} onClick={() => setSetting('replicaView', 'each')} title="A row per instance, the traffic fanned out (up to 12)">
          each
        </button>
      </div>
    </Panel>
  );
}
