import { Document, isMap, isSeq } from 'yaml';

/**
 * Spec → YAML the way a person would write it: block style for structure, flow style for
 * connection pairs and small objects (`[lb, api]`, `{ min: 2, max: 8 }`).
 */
export function specToYaml(spec: unknown): string {
  const doc = new Document(spec);
  const root = doc.contents;
  if (isMap(root)) {
    const conns = root.get('connections', true);
    if (isSeq(conns)) for (const it of conns.items) if (isSeq(it) || isMap(it)) it.flow = true;
    const comps = root.get('components', true);
    if (isSeq(comps)) for (const c of comps.items) if (isMap(c)) for (const p of c.items) if (isMap(p.value)) p.value.flow = true;
    const zones = root.get('zones', true);
    if (isSeq(zones)) for (const z of zones.items) if (isMap(z)) for (const p of z.items) if (isSeq(p.value)) p.value.flow = true;
  }
  return doc.toString({ flowCollectionPadding: false, lineWidth: 0 });
}
