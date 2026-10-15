import { useEffect, useMemo, useRef, useState } from 'react';
import { parse, YAMLParseError } from 'yaml';
import { specToYaml } from '../spec/yaml';
import { FileCode2, X } from 'lucide-react';
import { useSim } from '../sim/store';
import { graphToSpec, mergeSpecIntoGraph } from '../spec/convert';
import { validateSpec, type Issue } from '../spec/validate';
import './specEditor.css';

const toYaml = () => {
  const { boards, settings } = useSim.getState();
  const m = boards.main;
  const spec = graphToSpec(m.nodes, m.edges, m.title);
  return specToYaml(settings.pricing !== 'illustrative' ? { ...spec, pricing: settings.pricing, ...(settings.commitment !== 'none' ? { commitment: settings.commitment } : {}) } : spec);
};

/**
 * The architecture as code, live: edit the YAML and the board follows (layout kept); change the
 * board and the YAML follows. Errors are shown in place and never touch the board.
 */
export function SpecEditor() {
  const nodes = useSim((s) => s.boards.main.nodes);
  const edges = useSim((s) => s.boards.main.edges);
  const title = useSim((s) => s.boards.main.title);
  const [text, setText] = useState(toYaml);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [parseErr, setParseErr] = useState<{ line: number | null; message: string } | null>(null);
  const editing = useRef(false);
  const lastApplied = useRef(text);
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  // board → text, unless the user is mid-edit
  const boardYaml = useMemo(toYaml, [nodes, edges, title]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (editing.current) return;
    if (boardYaml !== lastApplied.current) {
      setText(boardYaml);
      lastApplied.current = boardYaml;
      setParseErr(null);
      setIssues(validateSpec(parse(boardYaml)).issues);
    }
  }, [boardYaml]);
  useEffect(() => setIssues(validateSpec(parse(text)).issues), []); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = (src: string) => {
    let doc: unknown;
    try {
      doc = parse(src);
    } catch (e) {
      const line = e instanceof YAMLParseError ? (e.linePos?.[0].line ?? null) : null;
      setParseErr({ line, message: e instanceof Error ? e.message.split('\n')[0] : String(e) });
      return;
    }
    setParseErr(null);
    const v = validateSpec(doc);
    setIssues(v.issues);
    if (!v.ok || !v.spec) return;
    const s = useSim.getState();
    const merged = mergeSpecIntoGraph(v.spec, s.boards.main);
    lastApplied.current = src;
    s.setGraph('main', merged.nodes, merged.edges, v.spec.name);
  };

  const lines = text.split('\n').length;
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');

  return (
    <div className="spec panel">
      <div className="au-head">
        <FileCode2 size={16} />
        <div>
          <div className="au-h1">Architecture as code</div>
          <div className="au-h2">edit the YAML — the board follows, and back</div>
        </div>
        <button className="icon-btn small" onClick={() => useSim.getState().setSpecOpen(false)} title="Close">
          <X size={14} />
        </button>
      </div>
      <div className="spec-body">
        <div className="spec-gutter" ref={gutter} aria-hidden>
          {Array.from({ length: lines }, (_, i) => (
            <div key={i} className={parseErr?.line === i + 1 ? 'err' : ''}>
              {i + 1}
            </div>
          ))}
        </div>
        <textarea
          ref={area}
          className="spec-text"
          spellCheck={false}
          value={text}
          onFocus={() => (editing.current = true)}
          onBlur={() => {
            editing.current = false;
            // pick up board changes made while focused
            if (boardYaml !== lastApplied.current && !parseErr && !errors.length) setText(boardYaml);
          }}
          onScroll={(e) => gutter.current && (gutter.current.scrollTop = e.currentTarget.scrollTop)}
          onKeyDown={(e) => {
            if (e.key === 'Tab') {
              e.preventDefault();
              const el = e.currentTarget;
              const { selectionStart: a, selectionEnd: b } = el;
              const next = `${text.slice(0, a)}  ${text.slice(b)}`;
              setText(next);
              requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
            }
          }}
          onChange={(e) => {
            const v = e.target.value;
            setText(v);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => apply(v), 350);
          }}
        />
      </div>
      <div className="spec-status">
        {parseErr ? (
          <div className="spec-err">
            YAML{parseErr.line ? ` line ${parseErr.line}` : ''}: {parseErr.message}
          </div>
        ) : errors.length ? (
          errors.slice(0, 4).map((i, k) => (
            <div key={k} className="spec-err">
              {i.message}
            </div>
          ))
        ) : (
          <div className="spec-ok">✓ valid — the board is in sync</div>
        )}
        {!parseErr &&
          warnings.slice(0, 4).map((i, k) => (
            <div key={k} className="spec-warn">
              {i.message}
            </div>
          ))}
      </div>
    </div>
  );
}
