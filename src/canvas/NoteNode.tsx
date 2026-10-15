import { memo, useEffect, useRef, useState } from 'react';
import { NodeResizer, type NodeProps } from '@xyflow/react';
import type { NoteNode as NoteNodeT } from '../sim/catalog';
import { useSim } from '../sim/store';
import { useBoardId } from './BoardContext';

/** A note on the board: free text explaining the design. Double-click to edit. */
function NoteNodeImpl({ id, data, selected }: NodeProps<NoteNodeT>) {
  const b = useBoardId();
  const [editing, setEditing] = useState(!data.text);
  const updateNote = useSim((s) => s.updateNote);
  const input = useRef<HTMLTextAreaElement>(null);
  // the canvas takes focus back as the node mounts: give it to the text once it has settled
  useEffect(() => {
    if (!editing) return;
    const t = setTimeout(() => input.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [editing]);
  return (
    <>
      <NodeResizer isVisible={selected} minWidth={140} minHeight={40} lineClassName="note-resize-line" handleClassName="note-resize-handle" />
      <div className={`note ${selected ? 'selected' : ''}`} onDoubleClick={() => setEditing(true)}>
        {editing ? (
          <textarea ref={input} className="note-input nodrag nowheel" value={data.text} placeholder="A note on this design…" onChange={(e) => updateNote(b, id, e.target.value)} onBlur={() => setEditing(false)} onKeyDown={(e) => e.key === 'Escape' && (e.target as HTMLTextAreaElement).blur()} />
        ) : (
          <div className="note-text">{data.text}</div>
        )}
      </div>
    </>
  );
}

export const NoteNode = memo(NoteNodeImpl);
