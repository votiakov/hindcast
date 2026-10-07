import { parse as parseYaml } from 'yaml';
import { useSim } from '../sim/store';
import { importTerraform } from './terraform';
import { ArchitectureSpec } from './schema';
import { specToGraph } from './convert';

/**
 * Open a file the user picked or dropped: an architecture spec (YAML / JSON) or
 * `terraform show -json` output. Loads it into the sandbox as a new, unsaved design.
 */
export async function openFile(file: File): Promise<void> {
  const s = useSim.getState();
  try {
    const text = await file.text();
    const doc = /\.ya?ml$/i.test(file.name) ? parseYaml(text) : JSON.parse(text);
    const isTerraform = doc && typeof doc === 'object' && ('format_version' in doc || 'values' in doc || 'planned_values' in doc);
    const base = file.name.replace(/\.(ya?ml|json|tfstate)+$/i, '');
    let spec: ArchitectureSpec;
    if (isTerraform) {
      const r = importTerraform(doc, base);
      spec = r.spec;
      if (r.assumptions.length) s.toast('info', `Imported from Terraform — ${r.assumptions.length} assumption${r.assumptions.length > 1 ? 's' : ''} to review (see the spec)`);
    } else spec = ArchitectureSpec.parse(doc);
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
