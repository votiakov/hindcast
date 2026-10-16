import { memo, useEffect, useRef, useState } from 'react';
import { NodeToolbar, Position, type NodeProps } from '@xyflow/react';
import { Pencil, Trash2 } from 'lucide-react';
import type { SectionNode as SectionNodeT } from '../sim/catalog';
import { useSim } from '../sim/store';
import { useBoardId } from './BoardContext';

/**
 * A section: a dotted frame with a muted label around some components, for reading the design. It is
 * not a zone (no failure, no chip); it fits its members, and dragging it by the label or the edge
 * moves them. Double-click the label to rename.
 */
function SectionNodeImpl({ id, data, selected }: NodeProps<SectionNodeT>) {
  const b = useBoardId();
  const [editing, setEditing] = useState(!data.label);
  const [draft, setDraft] = useState(data.label);
  const input = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);
  useEffect(() => {
    if (!editing) return;
    setDraft(data.label);
    // the canvas takes focus back as the node mounts: give it to the label once it has settled
    const t = setTimeout(() => {
      input.current?.focus();
      input.current?.select();
    }, 30);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  const commit = () => {
    const s = useSim.getState();
    const next = (cancelled.current ? '' : draft.trim()) || data.label || `section ${s.boards[b].nodes.filter((n) => n.type === 'section').length}`;
    if (next !== data.label) s.renameSection(b, id, next);
    cancelled.current = false;
    setEditing(false);
  };
  return (
    <>
      <NodeToolbar isVisible={selected && !editing} position={Position.Top} align="start" className="node-toolbar">
        <div className="tb-group">
          <button className="tb-btn wide" onClick={() => setEditing(true)} title="Rename the section (or double-click its label)">
            <Pencil size={14} /> Rename
          </button>
          <button className="tb-btn wide" onClick={() => useSim.getState().removeNode(b, id)} title="Remove the section (keeps its components)">
            <Trash2 size={14} /> Ungroup
          </button>
        </div>
      </NodeToolbar>
      <div className={`section ${selected ? 'selected' : ''}`}>
        <i className="section-edge top" />
        <i className="section-edge right" />
        <i className="section-edge bottom" />
        <i className="section-edge left" />
        <div className="section-label" onDoubleClick={() => setEditing(true)} title="A section groups components for reading; it is not a failure domain. Drag to move them, double-click to rename">
          {editing ? (
            <input
              ref={input}
              className="section-input nodrag"
              value={draft}
              placeholder="name this section"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
                if (e.key === 'Escape') {
                  cancelled.current = true;
                  (e.target as HTMLInputElement).blur();
                }
                e.stopPropagation();
              }}
              size={Math.max(12, draft.length + 1)}
            />
          ) : (
            data.label
          )}
        </div>
      </div>
    </>
  );
}

export const SectionNode = memo(SectionNodeImpl);
