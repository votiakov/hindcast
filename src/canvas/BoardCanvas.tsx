import { useCallback, useEffect, useRef } from 'react';
import { Background, BackgroundVariant, MiniMap, ReactFlow, useReactFlow, type NodeTypes, type EdgeTypes, type XYPosition } from '@xyflow/react';
import { useSim, type BoardId } from '../sim/store';
import { KINDS, isSystem, isUp, type AppNode, type Kind } from '../sim/catalog';
import { SystemNode, HEALTH_COLOR, healthOf } from './SystemNode';
import { ZoneNode } from './ZoneNode';
import { FlowEdge } from './FlowEdge';
import { BoardContext } from './BoardContext';
import { RefMarkers } from '../theme/reference/RefEdge';

export const DND_TYPE = 'application/x-bottleneck-kind';
export const ZONE_KIND = 'zone';

/** muted status colours for the light themes' minimap */
const MAP_HEALTH = { idle: '#b5b5ad', ok: '#44443f', warm: '#d99a1e', hot: '#c4232b', down: '#d6d6cf' } as const;

const nodeTypes: NodeTypes = { system: SystemNode, zone: ZoneNode };
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
  const nodes = useSim((s) => s.boards[id].nodes);
  const edges = useSim((s) => s.boards[id].edges);
  const version = useSim((s) => s.boards[id].version);
  const { onNodesChange, onEdgesChange, onConnect, addNode, addZone, moveNodes, setFocus } = useSim.getState();
  const { screenToFlowPosition, fitView } = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const zoneDrag = useRef<{ start: XYPosition; members: Record<string, XYPosition> } | null>(null);

  const camera = useSim((s) => (s.mode === 'studio' ? s.studio.camera[id] : null));
  const theme = useSim((s) => s.settings.theme);

  useEffect(() => {
    const t = setTimeout(() => fitView({ padding, duration: fitDuration, maxZoom: 1.1 }), 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, fitView]);

  // scripted camera moves (studio episodes)
  useEffect(() => {
    if (!camera || camera.seq === 0) return;
    if (camera.nodes) fitView({ nodes: camera.nodes.map((n) => ({ id: n })), padding: 1.3, duration: 900, maxZoom: 1.5 });
    else fitView({ padding, duration: 900, maxZoom: 1.1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera?.seq]);

  const add = useCallback(
    (kind: Kind | typeof ZONE_KIND, p: XYPosition) => {
      if (kind === ZONE_KIND) addZone(id, { x: p.x - 280, y: p.y - 190 });
      else addNode(id, kind, { x: p.x - 115, y: p.y - 60 });
    },
    [id, addNode, addZone],
  );

  useEffect(() => {
    adders[id] = (kind) => {
      const r = wrapper.current!.getBoundingClientRect();
      const p = screenToFlowPosition({ x: r.left + r.width / 2 + (Math.random() - 0.5) * 80, y: r.top + r.height / 2 + (Math.random() - 0.5) * 80 });
      add(kind, p);
    };
    return () => {
      delete adders[id];
    };
  }, [id, add, screenToFlowPosition]);

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

  // dragging a zone carries the nodes inside it
  const onNodeDragStart = useCallback(
    (_: unknown, node: AppNode) => {
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
      if (node.type !== 'zone' || !zd) return;
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
 {theme === 'reference' && <RefMarkers />}
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
          {minimap && (
            <MiniMap
              pannable
              zoomable
              className="minimap"
              maskColor="rgba(2,6,23,0.7)"
              nodeColor={(n) => {
                if (n.type === 'zone') return 'rgba(56, 189, 248, 0.08)';
                const st = useSim.getState().boards[id].nodeStats[n.id];
                const d = (n as AppNode & { type: 'system' }).data;
                const h = healthOf(st?.util ?? 0, st?.dropRps ?? 0, st?.inRps ?? 1, isUp(d));
                return theme === 'neon' ? HEALTH_COLOR[h] : MAP_HEALTH[h];
              }}
            />
          )}
        </ReactFlow>
      </div>
    </BoardContext.Provider>
  );
}
