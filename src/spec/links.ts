import { specToYaml } from './yaml';
import { decodePayload, graphToSpec, specToGraph } from './convert';
import { ArchitectureSpec, ScenarioSpec } from './schema';
import { simulate, toMermaid } from '../sim/headless';
import { registerScenario, type Scenario } from '../scenarios/scenarios';
import { useSim } from '../sim/store';

export interface ComparePayload {
  a: { title: string; spec: unknown };
  b: { title: string; spec: unknown };
  scenario?: unknown;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** Turn a link's scenario into a playable comparison, with a takeaway computed by the headless engine. */
function toScenario(p: ComparePayload): Scenario {
  const a = ArchitectureSpec.parse(p.a.spec);
  const b = ArchitectureSpec.parse(p.b.spec);
  const sc = ScenarioSpec.parse(p.scenario ?? {});
  const end = sc.duration;
  const timeline = sc.traffic?.length ? [...sc.traffic].sort((x, y) => x.at - y.at) : [{ at: 0, rps: sc.rps ?? 500 }];
  if (timeline[timeline.length - 1].at < end) timeline.push({ at: end, rps: timeline[timeline.length - 1].rps });
  const ra = simulate(a, sc).summary;
  const rb = simulate(b, sc).summary;
  const line = (s: typeof ra) => `SLO met ${pct(s.sloCompliance)} of the time · mean errors ${pct(s.meanErrorRate)} · peak p99 ${s.peakP99Ms}ms · $${s.meanCostPerHour.toFixed(2)}/h`;
  const winner = ra.sloCompliance === rb.sloCompliance ? (ra.meanCostPerHour <= rb.meanCostPerHour ? p.a.title : p.b.title) : ra.sloCompliance > rb.sloCompliance ? p.a.title : p.b.title;
  return {
    id: 'link-compare',
    title: sc.name ?? `${p.a.title} vs ${p.b.title}`,
    tagline: `Same traffic and failures against “${p.a.title}” and “${p.b.title}”.`,
    watch: 'Error rate, p99 and cost of each side as the scenario unfolds.',
    a: { title: p.a.title, graph: specToGraph(a) },
    b: { title: p.b.title, graph: specToGraph(b) },
    readRatio: sc.readRatio,
    timeline,
    events: (sc.events ?? []).map((e) => ({ at: e.at, message: e.note ?? e.action.type, a: e.action, b: e.action })),
    takeaway: { a: line(ra), b: line(rb), lesson: `${winner} comes out ahead under this scenario.` },
  };
}

/** Open an architecture (#spec=…) or a comparison (#compare=…) passed in the URL hash. */
export function openFromHash(hash: string): boolean {
  const m = hash.match(/^#(spec|compare)=(.+)$/);
  if (!m) return false;
  return openPayload(m[1] === 'spec' ? { spec: decodePayload(m[2]) } : { compare: decodePayload<ComparePayload>(m[2]) });
}

/** Open a spec in Sandbox, or two specs (+ optional scenario) in Compare. Used by links and the MCP live canvas. */
export function openPayload(p: { spec?: unknown; compare?: ComparePayload }): boolean {
  const s = useSim.getState();
  try {
    if (p.spec) {
      const spec = ArchitectureSpec.parse(p.spec);
      if (spec.pricing) s.setSetting('pricing', spec.pricing);
      s.setMode('sandbox');
      useSim.getState().loadGraph('main', specToGraph(spec), spec.name ?? 'Untitled');
      useSim.getState().setDesign(null, spec.name ?? 'Untitled');
      return true;
    }
    const c = p.compare!;
    if (c.scenario) {
      const sc = registerScenario(toScenario(c));
      useSim.setState({ compare: { ...s.compare, scenarioId: sc.id } });
      useSim.getState().setMode('compare');
    } else {
      s.setMode('compare');
      useSim.getState().pickScenario(null);
      useSim.getState().loadGraph('A', specToGraph(c.a.spec), c.a.title);
      useSim.getState().loadGraph('B', specToGraph(c.b.spec), c.b.title);
    }
    return true;
  } catch (e) {
    s.toast('bad', `Could not open link: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** Current main board as a YAML architecture spec. */
export function currentSpecYaml(): string {
  const { boards, settings } = useSim.getState();
  const { nodes, edges, title } = boards.main;
  const spec = graphToSpec(nodes, edges, title !== 'Main' ? title : undefined);
  return specToYaml(settings.pricing !== 'illustrative' ? { ...spec, pricing: settings.pricing } : spec);
}

/** Current main board as a Mermaid flowchart (shapes by kind, link latency and calls, zones as subgraphs). */
export function currentSpecMermaid(): string {
  const { nodes, edges, title } = useSim.getState().boards.main;
  return toMermaid(graphToSpec(nodes, edges, title !== 'Main' ? title : undefined));
}
