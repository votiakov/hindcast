import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Trash2 } from 'lucide-react';
import { useSim } from '../sim/store';
import { TEMPLATES, templateGroups } from '../scenarios/templates';
import { deleteDesign, listDesigns, saveDesign, type SavedDesign } from '../sim/designs';
import { currentSpecYaml } from '../spec/links';
import { encodePayload, graphToSpec } from '../spec/convert';
import { openFile } from '../spec/openFile';
import './designMenu.css';

const ago = (t: number) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'architecture';

export function saveCurrent(asCopy = false) {
  const s = useSim.getState();
  const m = s.boards.main;
  const name = asCopy ? `${m.title} copy` : m.title;
  const d = saveDesign(name, { nodes: m.nodes, edges: m.edges }, asCopy ? undefined : (s.designId ?? undefined));
  s.setDesign(d.id, d.name);
  s.toast('good', `Saved “${d.name}”`);
}

function download(name: string, text: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Sandbox document menu: the design's name is the title; file operations, saved designs and templates live behind it. */
export function DesignMenu() {
  const title = useSim((s) => s.boards.main.title);
  const designId = useSim((s) => s.designId);
  const [open, setOpen] = useState(false);
  const [designs, setDesigns] = useState<SavedDesign[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setDesigns(listDesigns());
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);

  const s = useSim.getState();
  const act = (fn: () => void) => () => {
    fn();
    setOpen(false);
  };

  return (
    <div className="dm" ref={ref}>
      <button className={`dm-title ${open ? 'on' : ''}`} onClick={() => setOpen(!open)} title="Design: save, open, export, templates">
        <span className="dm-name">{title}</span>
        {!designId && <span className="dm-unsaved">unsaved</span>}
        <ChevronDown size={14} />
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".yaml,.yml,.json,.tfstate,.csv,.tsv"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) openFile(f);
          e.target.value = '';
          setOpen(false);
        }}
      />
      {open && (
        <div className="dm-menu">
          <div className="dm-rename">
            <input value={title} onChange={(e) => s.setDesign(designId, e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setOpen(false)} aria-label="Design name" />
          </div>
          <div className="dm-actions">
            <button onClick={act(() => saveCurrent())}>
              Save <kbd>⌘S</kbd>
            </button>
            <button onClick={act(() => saveCurrent(true))}>Save a copy</button>
            <button
              onClick={act(() => {
                s.loadGraph('main', { nodes: [], edges: [] }, 'Untitled');
                s.setDesign(null, 'Untitled');
              })}
            >
              New blank
            </button>
            <button onClick={() => fileRef.current?.click()}>
              Open file… <span>spec, k8s, terraform, traffic csv</span>
            </button>
            <button onClick={act(() => download(`${slug(title)}.yaml`, currentSpecYaml(), 'text/yaml'))}>Download .yaml</button>
            <button
              onClick={act(() => {
                navigator.clipboard?.writeText(currentSpecYaml());
                s.toast('good', 'Spec copied (YAML) — paste it to your AI assistant or the CLI');
              })}
            >
              Copy spec
            </button>
            <button
              onClick={act(() => {
                const m = useSim.getState().boards.main;
                const url = `${location.origin}${location.pathname}#spec=${encodePayload({ ...graphToSpec(m.nodes, m.edges, m.title), pricing: useSim.getState().settings.pricing })}`;
                navigator.clipboard?.writeText(url);
                s.toast('good', 'Share link copied');
              })}
            >
              Copy share link
            </button>
            <button
              onClick={act(() => {
                const s2 = useSim.getState();
                const m = s2.boards.main;
                const url = `${location.origin}${location.pathname}?embed=1&rps=${s2.traffic}&theme=${s2.settings.theme}#spec=${encodePayload({ ...graphToSpec(m.nodes, m.edges, m.title), pricing: s2.settings.pricing })}`;
                navigator.clipboard?.writeText(`<iframe src="${url}" width="100%" height="460" style="border:0;border-radius:12px" title="${m.title.replace(/"/g, '')} — live architecture"></iframe>`);
                s.toast('good', 'Embed code copied — a live, running board for posts and docs');
              })}
            >
              Copy embed code
            </button>
          </div>

          {designs.length > 0 && (
            <div className="dm-section">
              <div className="dm-h">your designs</div>
              {designs.map((d) => (
                <div key={d.id} className={`dm-item ${d.id === designId ? 'cur' : ''}`}>
                  <button
                    className="dm-open"
                    onClick={act(() => {
                      useSim.getState().loadGraph('main', d.graph, d.name);
                      useSim.getState().setDesign(d.id, d.name);
                    })}
                  >
                    <span>{d.name}</span>
                    <em>
                      {d.graph.nodes.filter((n) => n.type === 'system').length} components · {ago(d.updatedAt)}
                    </em>
                  </button>
                  <button
                    className="dm-del"
                    title="Delete"
                    onClick={() => {
                      deleteDesign(d.id);
                      setDesigns(listDesigns());
                      if (d.id === designId) s.setDesign(null, title);
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="dm-section">
            <div className="dm-h">start from a template</div>
            {templateGroups().map((g) => (
              <div key={g} className="dm-group">
                <div className="dm-g">{g}</div>
                {TEMPLATES.filter((t) => t.group === g).map((t) => (
                  <button
                    key={t.id}
                    className="dm-tpl"
                    onClick={act(() => {
                      useSim.getState().loadGraph('main', t.graph, t.title);
                      useSim.getState().setDesign(null, t.title);
                    })}
                  >
                    {t.title}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
