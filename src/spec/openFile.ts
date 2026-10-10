import { parse as parseYaml, parseAllDocuments } from 'yaml';
import { importKubernetes, looksLikeKubernetes } from './kubernetes';
import { useSim } from '../sim/store';
import { importTerraform } from './terraform';
import type { ArchitectureSpec } from './schema';
import { validateSpec } from './validate';

const OPENS = 'Bottleneck opens an architecture spec (YAML or JSON), Kubernetes manifests, `terraform show -json` output, or a traffic CSV of time and requests per second.';
import { specToGraph } from './convert';
import { parseTrafficCsv } from './trafficCsv';

/**
 * Open a file the user picked or dropped: an architecture spec (YAML / JSON) or
 * `terraform show -json` output. Loads it into the sandbox as a new, unsaved design.
 */
export async function openFile(file: File): Promise<void> {
  const s = useSim.getState();
  try {
    const text = await file.text();
    if (/\.(csv|tsv|txt)$/i.test(file.name)) {
      // a traffic recording: replay it against whatever is on the board
      let t: ReturnType<typeof parseTrafficCsv>;
      try {
        t = parseTrafficCsv(text);
      } catch (e) {
        throw new Error(`it is not a traffic recording (${e instanceof Error ? e.message : String(e)}). ${OPENS}`);
      }
      if (s.mode !== 'sandbox') s.setMode('sandbox');
      const dur = t.traffic[t.traffic.length - 1].at;
      useSim.getState().play({ title: `${file.name}${t.compression > 1.01 ? ` (${Math.round(t.spanS / 60)} min compressed ${t.compression.toFixed(0)}×)` : ''}`, duration: dur, rps: 0, traffic: t.traffic, events: [] });
      useSim.getState().toast('good', `Replaying ${file.name}: peak ${Math.round(t.peak)} req/s${t.compression > 1.01 ? ` — time compressed ${t.compression.toFixed(0)}×, so warm-ups and cooldowns look ${t.compression.toFixed(0)}× slower than they are` : ''}`);
      return;
    }
    const yaml = /\.ya?ml$/i.test(file.name);
    const all = yaml ? parseAllDocuments(text).map((d) => d.toJS()).filter(Boolean) : [JSON.parse(text)];
    const doc = all.length === 1 ? all[0] : yaml ? parseYaml(text.split(/^---$/m)[0]) : all[0];
    const isTerraform = doc && typeof doc === 'object' && ('format_version' in doc || 'values' in doc || 'planned_values' in doc);
    const base = file.name.replace(/\.(ya?ml|json|tfstate)+$/i, '');
    let spec: ArchitectureSpec;
    if (looksLikeKubernetes(all)) {
      const r = importKubernetes(all, base);
      spec = r.spec;
      s.toast('info', `Imported ${r.mapped.length} Kubernetes objects — ${r.assumptions.length} assumption${r.assumptions.length === 1 ? '' : 's'} to review`);
    } else if (isTerraform) {
      const r = importTerraform(doc, base);
      spec = r.spec;
      if (r.assumptions.length) s.toast('info', `Imported from Terraform — ${r.assumptions.length} assumption${r.assumptions.length > 1 ? 's' : ''} to review (see the spec)`);
    } else {
      const v = validateSpec(doc);
      if (!v.ok || !v.spec) {
        const errors = v.issues.filter((i) => i.level === 'error');
        // not a spec at all: say what can be opened; a broken spec: say what is wrong with it
        if (!doc || typeof doc !== 'object' || !('components' in doc)) throw new Error(`it is not an architecture spec. ${OPENS}`);
        throw new Error(`${errors.slice(0, 2).map((i) => i.message).join('; ')}${errors.length > 2 ? ` (and ${errors.length - 2} more)` : ''}`);
      }
      spec = v.spec;
    }
    if (s.mode !== 'sandbox') s.setMode('sandbox');
    if (spec.pricing) useSim.getState().setSetting('pricing', spec.pricing);
    const name = spec.name ?? base;
    useSim.getState().loadGraph('main', specToGraph(spec), name);
    useSim.getState().setDesign(null, name);
    useSim.getState().toast('good', `Opened ${file.name}`);
  } catch (e) {
    s.toast('bad', `Could not open ${file.name}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }
}
