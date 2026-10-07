import { useEffect, useState } from 'react';
import { useSim } from '../sim/store';
import { isSystem } from '../sim/catalog';
import './shortcuts.css';

const KEYS: [string, string][] = [
  ['⌘K', 'command palette — anything, by name; a number sets traffic'],
  ['Space', 'play / pause'],
  ['⌘Z  ⇧⌘Z', 'undo / redo'],
  ['⌘S', 'save the design'],
  ['P', 'present mode (←/→ walks audit incidents, F fullscreen, Esc exits)'],
  ['← →', 'step through the recording while rewinding'],
  ['Del', 'delete the selected component or connection'],
  ['?', 'this sheet'],
];

function Keys() {
  return (
    <table className="sc-keys">
      <tbody>
        {KEYS.map(([k, v]) => (
          <tr key={k}>
            <td>
              <kbd>{k}</kbd>
            </td>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** `?` opens the keyboard sheet; an empty sandbox shows how to start. */
export function Shortcuts() {
  const [open, setOpen] = useState(false);
  const mode = useSim((s) => s.mode);
  const empty = useSim((s) => s.mode === 'sandbox' && !s.boards.main.nodes.some(isSystem));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest?.('input, select, textarea')) return;
      if (e.key === '?') setOpen((o) => !o);
      else if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (open)
    return (
      <div className="sc-backdrop" onMouseDown={() => setOpen(false)}>
        <div className="sc" onMouseDown={(e) => e.stopPropagation()}>
          <div className="sc-h">Keyboard</div>
          <Keys />
        </div>
      </div>
    );
  if (!empty || mode !== 'sandbox') return null;
  return (
    <div className="sc-empty">
      <div className="sc-h">An empty board</div>
      <p>
        Drag components in from the left and wire a caller's right handle to its callee's left handle, or start from a template in the design menu at the top. You can also drop an architecture spec
        (.yaml / .json) or <code>terraform show -json</code> output anywhere on the board.
      </p>
      <Keys />
    </div>
  );
}
