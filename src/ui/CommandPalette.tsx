import { useEffect, useMemo, useRef, useState } from 'react';
import { useSim, type Mode } from '../sim/store';
import { CATEGORIES, KINDS, isSystem, isUp } from '../sim/catalog';
import { TEMPLATES } from '../scenarios/templates';
import { LESSONS } from '../lessons';
import { SCENARIOS } from '../scenarios/scenarios';
import { listDesigns } from '../sim/designs';
import { saveCurrent } from './DesignMenu';
import { runAudit } from './AuditPanel';
import { currentSpecYaml } from '../spec/links';
import './palette-cmd.css';
import { GLOSSARY } from '../content/glossary';

interface Cmd {
  id: string;
  group: string;
  label: string;
  hint?: string;
  run: () => void;
}

/** subsequence fuzzy score: higher is better, -1 = no match */
function score(q: string, text: string): number {
  if (!q) return 0;
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct * 2 - t.length * 0.1 + (direct === 0 || t[direct - 1] === ' ' ? 200 : 0);
  let i = 0;
  let s = 0;
  let last = -1;
  for (const ch of q) {
    const j = t.indexOf(ch, last + 1);
    if (j < 0) return -1;
    s += j === last + 1 ? 8 : 1;
    last = j;
    i++;
  }
  return s - t.length * 0.05;
}

/** free spot to the right of the board's content */
function freeSpot() {
  const nodes = useSim.getState().boards.main.nodes.filter(isSystem);
  if (!nodes.length) return { x: 0, y: 0 };
  const maxX = Math.max(...nodes.map((n) => n.position.x));
  const ys = nodes.filter((n) => n.position.x === maxX).map((n) => n.position.y);
  return { x: maxX + 330, y: Math.min(...ys) };
}

function buildCommands(q: string): Cmd[] {
  const s = useSim.getState();
  const go = (m: Mode) => () => s.setMode(m);
  const cmds: Cmd[] = [];
  const sandbox = () => {
    if (useSim.getState().mode !== 'sandbox') useSim.getState().setMode('sandbox');
  };

  // a number sets the traffic
  const n = q.match(/^(?:traffic\s*)?(\d[\d_,.]*)\s*(k)?\s*(?:rps|req\/s)?$/i);
  if (n) {
    const rps = Math.round(parseFloat(n[1].replace(/[_,]/g, '')) * (n[2] ? 1000 : 1));
    if (rps >= 0 && rps <= 100000) cmds.push({ id: 'traffic', group: 'Traffic', label: `Set traffic to ${rps.toLocaleString('en-US')} req/s`, run: () => s.setTraffic(rps) });
  }

  cmds.push(
    { id: 'audit', group: 'Analyse', label: 'Run failure audit', hint: 'what breaks first, and what it costs', run: () => (sandbox(), useSim.getState().setAuditOpen(true), runAudit()) },
    { id: 'analysis', group: 'Analyse', label: 'Open analysis', hint: 'Monte Carlo, breaking point, cost optimizer', run: () => useSim.getState().setAnalysisOpen(true) },
    { id: 'present', group: 'View', label: s.present ? 'Exit present mode' : 'Present', hint: 'P — chrome-free, big numbers; ←/→ walks audit incidents', run: () => s.setPresent(!s.present) },
    { id: 'spec', group: 'Design', label: 'Edit as YAML (architecture as code)', run: () => (sandbox(), useSim.getState().setSpecOpen(true)) },
    { id: 'note', group: 'Design', label: 'Add a note', hint: 'N — free text on the board; double-click to edit', run: () => useSim.getState().addNote(useSim.getState().focus) },
    { id: 'section', group: 'Design', label: 'Group the selection as a section', hint: 'G — a labelled frame for reading; not a failure domain', run: () => useSim.getState().addSection(useSim.getState().focus) ?? useSim.getState().toast('info', 'Select the components to group first (shift-drag a box around them)') },
    { id: 'play', group: 'Simulation', label: s.running ? 'Pause' : 'Play', hint: 'Space', run: () => s.setRunning(!s.running) },
    { id: 'reset', group: 'Simulation', label: 'Reset simulation', run: () => s.reset() },
    { id: 'spike', group: 'Simulation', label: 'Traffic spike ×3', run: () => s.spike() },
    { id: 'heal', group: 'Simulation', label: 'Heal everything', run: () => s.chaosAll({ type: 'revive-all' }, '') },
    ...[1, 2, 4].map((x) => ({ id: `speed${x}`, group: 'Simulation', label: `Speed ${x}×`, run: () => s.setSpeed(x) })),
    { id: 'save', group: 'Design', label: 'Save design', hint: '⌘S', run: () => (sandbox(), saveCurrent()) },
    { id: 'undo', group: 'Design', label: 'Undo', hint: '⌘Z', run: () => s.undo(s.focus) },
    { id: 'redo', group: 'Design', label: 'Redo', hint: '⇧⌘Z', run: () => s.redo(s.focus) },
    { id: 'copy-spec', group: 'Design', label: 'Copy spec (YAML)', run: () => (navigator.clipboard?.writeText(currentSpecYaml()), s.toast('good', 'Spec copied')) },
    { id: 'blank', group: 'Design', label: 'New blank design', run: () => (sandbox(), useSim.getState().loadGraph('main', { nodes: [], edges: [] }, 'Untitled'), useSim.getState().setDesign(null, 'Untitled')) },
  );
  for (const m of ['home', 'lesson', 'sandbox', 'compare', 'studio'] as Mode[]) cmds.push({ id: `mode-${m}`, group: 'Go to', label: m === 'home' ? 'Live' : m[0].toUpperCase() + m.slice(1), run: go(m) });
  cmds.push({ id: 'terms', group: 'Go to', label: 'Glossary: all terms', hint: 'every term the app underlines, on one page of the docs', run: () => window.open('docs/terms.html', '_blank', 'noopener') });
  for (const c of CATEGORIES)
    for (const k of c.kinds) cmds.push({ id: `add-${k}`, group: 'Add component', label: `Add ${KINDS[k].label}`, hint: c.label, run: () => (sandbox(), useSim.getState().addNode('main', k, freeSpot())) });
  for (const d of listDesigns()) cmds.push({ id: `design-${d.id}`, group: 'Open design', label: d.name, run: () => (sandbox(), useSim.getState().loadGraph('main', d.graph, d.name), useSim.getState().setDesign(d.id, d.name)) });
  for (const t of TEMPLATES) cmds.push({ id: `tpl-${t.id}`, group: 'Template', label: t.title, hint: t.group, run: () => (sandbox(), useSim.getState().loadGraph('main', t.graph, t.title), useSim.getState().setDesign(null, t.title)) });
  for (const l of LESSONS) cmds.push({ id: `lesson-${l.id}`, group: 'Lesson', label: l.title, run: () => (useSim.getState().setMode('lesson'), useSim.getState().pickLesson(l.id)) });
  for (const [term, def] of Object.entries(GLOSSARY)) cmds.push({ id: `term-${term}`, group: 'Glossary', label: term, hint: def, run: () => s.toast('info', `${term}: ${def}`) });
  for (const sc of SCENARIOS) cmds.push({ id: `cmp-${sc.id}`, group: 'Compare', label: sc.title, run: () => (useSim.setState({ compare: { ...useSim.getState().compare, scenarioId: sc.id } }), useSim.getState().setMode('compare')) });
  cmds.push({ id: 'replicas', group: 'View', label: s.settings.replicaView === 'each' ? 'Show replicas grouped' : 'Show each replica', run: () => s.setSetting('replicaView', s.settings.replicaView === 'each' ? 'grouped' : 'each') });
  if (s.mode === 'sandbox')
    for (const nd of s.boards.main.nodes.filter(isSystem)) {
      if (nd.data.kind === 'client') continue;
      const name = nd.data.name;
      if (isUp(nd.data)) cmds.push({ id: `kill-${nd.id}`, group: 'Chaos', label: `Kill ${name}`, run: () => s.killNode('main', nd.id) });
      else cmds.push({ id: `revive-${nd.id}`, group: 'Chaos', label: `Revive ${name}`, run: () => s.reviveNode('main', nd.id) });
      cmds.push({ id: `slow-${nd.id}`, group: 'Chaos', label: `Slow down ${name} (+250 ms)`, run: () => s.apply('main', { type: 'inject-latency', id: nd.id, ms: 250 }) });
      cmds.push({ id: `err-${nd.id}`, group: 'Chaos', label: `${name} fails 20% of requests`, run: () => s.apply('main', { type: 'inject-errors', id: nd.id, rate: 0.2 }) });
      if (nd.data.kind === 'db' || nd.data.kind === 'kv') cmds.push({ id: `hot-${nd.id}`, group: 'Chaos', label: nd.data.hotKeyShare ? `Cool the hot key on ${name}` : `Hot key on ${name} (30% of traffic)`, run: () => s.apply('main', { type: 'hot-key', id: nd.id, share: nd.data.hotKeyShare ? 0 : 0.3 }) });
      if (nd.data.kind === 'cache' || nd.data.kind === 'cdn') cmds.push({ id: `flush-${nd.id}`, group: 'Chaos', label: `Flush ${name}`, run: () => s.apply('main', { type: 'flush-cache', id: nd.id }) });
    }
  cmds.push(
    { id: 'explain', group: 'View', label: `${s.settings.explain ? 'Hide' : 'Show'} explanations`, run: () => s.setSetting('explain', !s.settings.explain) },
    { id: 'particles', group: 'View', label: `${s.settings.particles ? 'Hide' : 'Show'} request particles`, run: () => s.setSetting('particles', !s.settings.particles) },
  );
  return cmds;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
        setQ('');
        setSel(0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (open) setTimeout(() => input.current?.focus(), 0);
  }, [open]);

  const results = useMemo(() => {
    if (!open) return [];
    const query = q.trim().toLowerCase();
    const all = buildCommands(query);
    if (!query) return all.filter((c) => ['Analyse', 'Simulation', 'Design', 'Go to'].includes(c.group)).slice(0, 14);
    return all
      .map((c) => ({ c, s: Math.max(score(query, c.label), score(query, `${c.group} ${c.label}`) - 50) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 14)
      .map((x) => x.c);
  }, [q, open]);

  useEffect(() => {
    list.current?.querySelector('.cp-item.on')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!open) return null;
  const run = (c: Cmd | undefined) => {
    if (!c) return;
    setOpen(false);
    c.run();
  };

  return (
    <div className="cp-backdrop" onMouseDown={() => setOpen(false)}>
      <div className="cp" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          className="cp-input"
          value={q}
          placeholder="Type a command, a component, or a number of req/s…"
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
            else if (e.key === 'ArrowDown') (e.preventDefault(), setSel((i) => Math.min(results.length - 1, i + 1)));
            else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((i) => Math.max(0, i - 1)));
            else if (e.key === 'Enter') run(results[sel]);
          }}
        />
        <div className="cp-list" ref={list}>
          {results.map((c, i) => (
            <button key={c.id} className={`cp-item ${i === sel ? 'on' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => run(c)}>
              <span className="cp-group">{c.group}</span>
              <span className="cp-label">{c.label}</span>
              {c.hint && <span className="cp-hint">{c.hint}</span>}
            </button>
          ))}
          {!results.length && <div className="cp-empty">No command matches “{q}”</div>}
        </div>
        <div className="cp-foot">
          <span>↑↓ choose</span>
          <span>↵ run</span>
          <span>esc close</span>
          <span>“1200” sets traffic</span>
        </div>
      </div>
    </div>
  );
}
