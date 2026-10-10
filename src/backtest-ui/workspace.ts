import { parse as parseYaml } from 'yaml';
import { useBacktest, type Workspace } from './store';
import { importBundle, type FileAccess } from '../backtest/import/manifest';
import { calibrate } from '../backtest/calibrate';
import { holdoutAccuracy } from '../backtest/accuracy';
import type { Dataset } from '../backtest/dataset';
import { reviveModel, type Model } from '../backtest/model';
import { useSim } from '../sim/store';
import { outageById, outageScenario } from '../backtest/outages';

/** Reference systems recorded under real load (see reference/README.md), served from /reference/. */
export const REFERENCES: { id: string; label: string }[] = [
  { id: 'hotrod', label: 'HotROD (reference)' },
  { id: 'shop', label: 'Astronomy Shop (reference)' },
];

/** the bundled list (reference/bundle.ts writes it); keeps the static one if unavailable */
export async function loadReferenceIndex() {
  try {
    const r = await fetch('reference/index.json');
    if (!r.ok) return;
    const list = (await r.json()) as { id: string; label: string }[];
    if (Array.isArray(list) && list.length) REFERENCES.splice(0, REFERENCES.length, ...list);
  } catch {
    /* static list */
  }
}

export interface WorkspaceFile {
  name: string;
  source: string;
  dataset: Dataset;
  model: Model;
  strategies: string[];
}

export async function loadReference(id: string) {
  const s = useBacktest.getState();
  s.setLoading(`Loading ${REFERENCES.find((r) => r.id === id)?.label ?? id}…`);
  try {
    const res = await fetch(`reference/${id}.json`);
    if (!res.ok) throw new Error(`reference "${id}" is not bundled (${res.status})`);
    const w = (await res.json()) as WorkspaceFile;
    s.setWorkspace({ id, name: w.name, source: w.source, dataset: w.dataset, model: reviveModel(w.model), strategies: w.strategies.map((yaml) => ({ yaml, visible: true })) });
  } catch (e) {
    useSim.getState().toast('bad', e instanceof Error ? e.message : String(e));
  } finally {
    s.setLoading(null);
  }
}

/**
 * A workspace bundle at a URL (`#backtest=<url>`): what an agent's verify_change wrote, served by
 * the MCP server on localhost, so a human sees the agent's evidence on this screen.
 */
export async function loadWorkspaceUrl(url: string) {
  const s = useBacktest.getState();
  s.setLoading('Loading the agent\'s backtest…');
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    const w = (await res.json()) as WorkspaceFile;
    if (!w.dataset || !w.model) throw new Error('not a Bottleneck workspace bundle');
    s.setWorkspace({ id: url, name: w.name, source: w.source, dataset: w.dataset, model: reviveModel(w.model), strategies: w.strategies.map((yaml) => ({ yaml, visible: true })) });
  } catch (e) {
    useSim.getState().toast('bad', `Could not open the agent's backtest: ${e instanceof Error ? e.message : String(e)} — is the MCP server that wrote it still running?`);
  } finally {
    s.setLoading(null);
  }
}

const isStrategy = (doc: unknown) => !!doc && typeof doc === 'object' && 'changes' in (doc as object) && 'name' in (doc as object);
const isManifest = (doc: unknown) => !!doc && typeof doc === 'object' && ('metrics' in (doc as object) || 'traces' in (doc as object) || 'billing' in (doc as object));

/**
 * Open dropped / picked files: an import manifest with the files it names, a dataset.json (+
 * model.json), a workspace bundle, or strategy YAML files added to the current workspace.
 */
export async function openWorkspaceFiles(files: File[]) {
  const st = useBacktest.getState();
  const toast = useSim.getState().toast;
  const texts = new Map<string, string>();
  for (const f of files) texts.set((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, await f.text());
  const docs = [...texts].map(([name, text]) => {
    try {
      return { name, doc: /\.ya?ml$/i.test(name) ? parseYaml(text) : /\.json$/i.test(name) ? JSON.parse(text) : null };
    } catch {
      return { name, doc: null };
    }
  });

  try {
    st.setLoading('Importing…');
    const bundle = docs.find((d) => d.doc && 'dataset' in d.doc && 'model' in d.doc);
    const manifest = docs.find((d) => isManifest(d.doc));
    const dataset = docs.find((d) => d.doc && 'services' in d.doc && 'stepS' in d.doc)?.doc as Dataset | undefined;
    const model = docs.find((d) => d.doc && 'services' in d.doc && 'endpoints' in d.doc && 'fittedOn' in d.doc)?.doc as Model | undefined;
    const strategies = docs.filter((d) => isStrategy(d.doc)).map((d) => texts.get(d.name)!);
    let w: Workspace | null = null;
    if (bundle) {
      const b = bundle.doc as WorkspaceFile;
      w = { id: bundle.name, name: b.name, source: b.source, dataset: b.dataset, model: reviveModel(b.model), strategies: b.strategies.map((yaml) => ({ yaml, visible: true })) };
    } else if (manifest) {
      // resolve the manifest's paths against the dropped files by suffix
      const fa: FileAccess = {
        read: (p) => {
          const key = [...texts.keys()].find((k) => k === p || k.endsWith('/' + p) || k.endsWith(p.split('/').pop()!));
          if (!key) throw new Error(`${p} was not among the dropped files`);
          return texts.get(key)!;
        },
        glob: (p) => {
          const re = new RegExp((p.split('/').pop() ?? p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
          return [...texts.keys()].filter((k) => re.test(k.split('/').pop()!));
        },
      };
      const { dataset: d } = importBundle(manifest.doc, fa);
      const m = calibrate(d);
      if (d.n >= 40) m.accuracy.push(holdoutAccuracy(d, { holdout: 0.3 }));
      w = { id: manifest.name, name: d.name, source: `imported ${manifest.name}`, dataset: d, model: m, strategies: [] };
    } else if (dataset) {
      const m = model ? reviveModel(model) : calibrate(dataset);
      w = { id: 'dropped', name: dataset.name, source: 'dropped dataset', dataset, model: m, strategies: [] };
    }
    if (w) {
      w.strategies.push(...strategies.map((yaml) => ({ yaml, visible: true })));
      st.setWorkspace(w);
      toast('good', `Opened ${w.name}: ${Object.keys(w.model.services).length} components, ${w.dataset.n} buckets`);
    } else if (strategies.length && st.workspace) {
      for (const y of strategies) st.addStrategy(y, false);
      toast('good', `Added ${strategies.length} strateg${strategies.length === 1 ? 'y' : 'ies'}`);
    } else toast('bad', 'Nothing to open: drop an import manifest with its files, a dataset.json, or strategy YAML files');
  } catch (e) {
    toast('bad', `Could not import: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  } finally {
    st.setLoading(null);
  }
}

/** replay a public outage against the open workspace's model (and its strategies) */
export function openOutage(id: string) {
  const st = useBacktest.getState();
  const base = st.workspace?.outage?.parent ?? st.workspace;
  const o = outageById(id);
  if (!base || !o) return;
  const r = outageScenario(base.model, o);
  st.setWorkspace({
    id: `${base.id}:outage:${id}`,
    name: base.name,
    source: o.title,
    dataset: r.dataset,
    model: base.model,
    strategies: base.strategies.map((x) => ({ ...x })),
    outage: { outage: o, faults: r.faults, roles: r.roles, warnings: r.warnings, baseRps: r.baseRps, parent: base },
  });
}

export function closeOutage() {
  const st = useBacktest.getState();
  const parent = st.workspace?.outage?.parent;
  if (parent) st.setWorkspace(parent);
}
