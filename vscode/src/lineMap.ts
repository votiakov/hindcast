import { LineCounter, isMap, isScalar, isSeq, parseDocument, type Node } from 'yaml';

/**
 * From a spec issue to where it is in the file. Pure (no vscode), so it is unit-tested. Positions
 * are 0-based, as VS Code's.
 */

export type Path = (string | number)[];
export interface Span {
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
}
export interface Located {
  level: 'error' | 'warning';
  message: string;
  span: Span;
}

export interface SpecDoc {
  /** the parsed document (undefined when the YAML does not parse) */
  value: unknown;
  /** YAML syntax errors, already placed */
  syntax: Located[];
  /** the span of the deepest node on `path` that exists */
  locate(path: Path): Span;
}

export function parseSpecDoc(text: string): SpecDoc {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, prettyErrors: false });
  const pos = (offset: number) => {
    const p = lc.linePos(Math.max(0, Math.min(offset, text.length)));
    return { line: p.line - 1, character: p.col - 1 };
  };
  const lineEnd = (offset: number) => {
    const nl = text.indexOf('\n', offset);
    return nl < 0 ? text.length : nl;
  };
  // one line at most: a component written as a block map is marked on its first line
  const spanOf = (start: number, end: number): Span => {
    const a = pos(start);
    const b = pos(Math.max(start, Math.min(end, lineEnd(start))));
    return { line: a.line, character: a.character, endLine: b.line, endCharacter: b.character };
  };
  const syntax: Located[] = [...doc.errors, ...doc.warnings].map((e) => ({
    level: doc.errors.includes(e as never) ? 'error' : 'warning',
    message: e.message.split('\n')[0],
    span: spanOf(e.pos[0], e.pos[1]),
  }));
  const top: Span = { line: 0, character: 0, endLine: 0, endCharacter: lineEnd(0) };

  const locate = (path: Path): Span => {
    let node: Node | null = doc.contents as Node | null;
    let best: [number, number] | null = node?.range ? [node.range[0], node.range[1]] : null;
    for (const k of path) {
      if (isMap(node)) {
        const pair = node.items.find((p) => (isScalar(p.key) ? String(p.key.value) : String(p.key)) === String(k));
        if (!pair) break;
        const key = pair.key as Node | null;
        const val = pair.value as Node | null;
        // the value when it is on the key's line, else the key
        if (val?.range && isScalar(val)) best = [val.range[0], val.range[1]];
        else if (key?.range) best = [key.range[0], val?.range && isMap(val) && val.flow ? val.range[1] : key.range[1]];
        node = val;
      } else if (isSeq(node) && typeof k === 'number' && node.items[k]) {
        node = node.items[k] as Node;
        if (node.range) best = [node.range[0], node.range[1]];
      } else break;
    }
    return best ? spanOf(best[0], best[1]) : top;
  };

  let value: unknown;
  try {
    value = doc.errors.length ? undefined : doc.toJS();
  } catch {
    value = undefined;
  }
  return { value, syntax, locate };
}

const quoted = (s: string) => [...s.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

/**
 * Where an issue is when it came without a path (the native CLI's `validate --json` gives only the
 * message): read the component, field or connection back out of the message.
 */
export function pathFromMessage(message: string, value: unknown): Path {
  const doc = (value ?? {}) as { components?: { id?: unknown }[]; connections?: unknown[]; zones?: { id?: unknown }[] };
  const comps = Array.isArray(doc.components) ? doc.components : [];
  const comp = (id: string) => comps.findIndex((c) => c && c.id === id);
  const m = message.match(/^component (?:"([^"]+)"|#(\d+)): ([A-Za-z][\w.]*)?/);
  if (m) {
    const i = m[1] !== undefined ? comp(m[1]) : Number(m[2]) - 1;
    if (i < 0) return ['components'];
    const field = m[3] && !/^(Unrecognized|Invalid)$/.test(m[3]) ? m[3].split('.') : [];
    return ['components', i, ...field];
  }
  const z = message.match(/^zone "([^"]+)" lists unknown member "([^"]+)"/);
  if (z && Array.isArray(doc.zones)) {
    const zi = doc.zones.findIndex((x) => x && x.id === z[1]);
    const members = (doc.zones[zi] as { members?: unknown[] } | undefined)?.members;
    return zi < 0 ? ['zones'] : ['zones', zi, 'members', ...(Array.isArray(members) && members.includes(z[2]) ? [members.indexOf(z[2])] : [])];
  }
  if (/^connection/.test(message) || /is connected to itself$/.test(message)) {
    const conns = Array.isArray(doc.connections) ? doc.connections : [];
    const names = quoted(message);
    const ends = (c: unknown): string[] => (typeof c === 'string' ? c.split('->').map((x) => x.trim()) : Array.isArray(c) ? c.map(String) : c && typeof c === 'object' ? [String((c as { from?: unknown }).from), String((c as { to?: unknown }).to)] : []);
    const shown = message.match(/^connection (.+): write it as/)?.[1];
    const i = conns.findIndex((c) => (shown !== undefined ? JSON.stringify(c) === shown : names.some((n) => ends(c).includes(n))));
    return i < 0 ? ['connections'] : ['connections', i];
  }
  if (/^no traffic source/.test(message)) return ['components'];
  if (message.startsWith('duplicate component id')) {
    const id = quoted(message)[0];
    const i = comps.findIndex((c, n) => c && c.id === id && comps.findIndex((d) => d && d.id === id) !== n);
    return i < 0 ? ['components'] : ['components', i, 'id'];
  }
  // lint about one component: `lb "x" has nothing behind it`, `"x" receives no traffic`
  for (const id of quoted(message)) {
    const i = comp(id);
    if (i >= 0) return ['components', i];
  }
  return [];
}

/** issues (with or without a path) placed in the document */
export function placeIssues(doc: SpecDoc, issues: { level: 'error' | 'warning'; message: string; path?: Path }[]): Located[] {
  return issues.map((i) => ({ level: i.level, message: i.message, span: doc.locate(i.path ?? pathFromMessage(i.message, doc.value)) }));
}

/** a Hindcast spec by name (*.hindcast.yaml) or by shape: components with kinds, and connections */
export function looksLikeSpec(fileName: string, value: unknown): boolean {
  if (/\.hindcast\.(ya?ml|json)$/i.test(fileName)) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as { components?: unknown; connections?: unknown };
  return Array.isArray(v.components) && Array.isArray(v.connections) && v.components.some((c) => c && typeof c === 'object' && 'kind' in c);
}

/** the line a component is defined on, for jumping from the board to the file */
export function componentSpan(doc: SpecDoc, id: string): Span | null {
  const comps = (doc.value as { components?: { id?: unknown }[] } | undefined)?.components;
  const i = Array.isArray(comps) ? comps.findIndex((c) => c && c.id === id) : -1;
  return i < 0 ? null : doc.locate(['components', i, 'id']);
}
