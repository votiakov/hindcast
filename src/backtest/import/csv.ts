/** RFC 4180 CSV (quoted fields, embedded commas/newlines, doubled quotes). Delimiter auto-detected. */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const firstLine = text.slice(0, text.indexOf('\n') >>> 0 || text.length);
  const d = delimiter ?? ([',', '\t', ';'].map((c) => [c, firstLine.split(c).length] as const).sort((a, b) => b[1] - a[1])[0][0]);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') (field += '"'), i++;
        else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === d) row.push(field), (field = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

/** rows → objects keyed by the header row */
export function csvObjects(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

/** epoch seconds from epoch s/ms/ns numbers or ISO-8601 strings */
export function parseTimestamp(v: unknown): number | null {
  if (typeof v === 'number') return v > 1e17 ? v / 1e9 : v > 1e12 ? v / 1000 : v;
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/^"|"$/g, '');
  if (!t) return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return parseTimestamp(parseFloat(t));
  // "2026-09-14 12:03:00 UTC" and similar
  const d = Date.parse(t.replace(' UTC', 'Z').replace(/^(\d{4}-\d\d-\d\d) (\d)/, '$1T$2'));
  return isNaN(d) ? null : d / 1000;
}
