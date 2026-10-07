import { graph, X, type Graph } from '../scenarios/build';
import { SCENARIOS, type Scenario, type ScenarioAction } from '../scenarios/scenarios';

/**
 * An episode is a scripted, self-playing clip for social posts / presentations.
 * Everything happens on a timeline: traffic keyframes plus "beats" that change the caption,
 * move the camera, break things or swap in a fixed architecture mid-run.
 */

export type StageBoard = 'main' | 'A' | 'B';

export type BeatAction = ScenarioAction | { type: 'graph'; graph: Graph; title?: string };

export interface Beat {
  at: number;
  caption?: string;
  do?: { board: StageBoard; action: BeatAction }[];
  /** zoom the camera to these nodes; null = show the whole board */
  focus?: { board: StageBoard; nodes: string[] | null };
}

export interface Episode {
  id: string;
  series: string;
  number?: number;
  /** big headline at the top of the frame */
  hook: string;
  layout: 'single' | 'compare';
  main?: Graph;
  a?: { title: string; graph: Graph };
  b?: { title: string; graph: Graph };
  readRatio: number;
  /** traffic keyframes (linear between points); last point ends the run */
  timeline: { at: number; rps: number }[];
  beats: Beat[];
  /** which numbers the metrics strip shows */
  metrics: ('rps' | 'errors' | 'p99' | 'cost')[];
  outro: { title: string; lines: string[]; cta?: string };
}

export const OUTRO_SECONDS = 5;
export const episodeDuration = (e: Episode) => e.timeline[e.timeline.length - 1].at;

export function episodeTraffic(e: Episode, t: number): number {
  const tl = e.timeline;
  if (t <= tl[0].at) return tl[0].rps;
  for (let i = 1; i < tl.length; i++) {
    if (t <= tl[i].at) return tl[i - 1].rps + ((tl[i].rps - tl[i - 1].rps) * (t - tl[i - 1].at)) / (tl[i].at - tl[i - 1].at);
  }
  return tl[tl.length - 1].rps;
}

export function episodeCaption(e: Episode, t: number): { text: string; at: number } | undefined {
  let c: { text: string; at: number } | undefined;
  for (const b of e.beats) if (b.caption !== undefined && t >= b.at) c = { text: b.caption, at: b.at };
  return c;
}

// ---------------------------------------------------------------------------------------------
// Series: "System design for the AI era"
// ---------------------------------------------------------------------------------------------

const AI_ERA = 'System design for the AI era';

const ep1Before = graph(
  [
    ['users', 'client', X[0], 200],
    ['api-1', 'server', X[1] + 40, 170],
    ['postgres', 'db', X[2] + 80, 200],
  ],
  [['users', 'api-1'], ['api-1', 'postgres']],
);

const ep1After = graph(
  [
    ['users', 'client', X[0], 200],
    ['lb', 'lb', X[1], 200],
    ['api-1', 'server', X[2], 150, { instances: 4 }],
    ['postgres', 'db', X[3], 200],
  ],
  [['users', 'lb'], ['lb', 'api-1'], ['api-1', 'postgres']],
);

const ep1: Episode = {
  id: 'ep1-localhost',
  series: AI_ERA,
  number: 1,
  hook: 'Works on localhost.\nDies in production.',
  layout: 'single',
  main: ep1Before,
  readRatio: 0.8,
  metrics: ['rps', 'errors', 'p99'],
  timeline: [
    { at: 0, rps: 3 },
    { at: 7.5, rps: 3 },
    { at: 8.5, rps: 80 },
    { at: 12, rps: 700 },
    { at: 38, rps: 700 },
  ],
  beats: [
    { at: 0, caption: 'AI wrote this app in 10 minutes.\nIt works perfectly.' },
    { at: 3.5, caption: 'On localhost it’s just you:\n3 requests per second.' },
    { at: 7.5, caption: 'Then you post it on Hacker News…' },
    { at: 11, caption: 'One server handles ~250 requests/second.\nYou’re getting 700.', focus: { board: 'main', nodes: ['api-1'] } },
    { at: 15, caption: 'First it slows down.\nRequests pile up in the queue…' },
    { at: 19, caption: '…then it starts dropping them.\nMost of your users now see errors.' },
    { at: 24, caption: 'The fix: a load balancer\n+ 4 server instances.', focus: { board: 'main', nodes: null }, do: [{ board: 'main', action: { type: 'graph', graph: ep1After } }] },
    { at: 29, caption: 'Traffic is spread out.\n0% errors. Fast again.' },
    { at: 33.5, caption: 'AI writes the code.\nYou decide how it survives production.' },
  ],
  outro: {
    title: 'System design isn’t a senior-only skill anymore.',
    lines: ['AI made writing code cheap.', 'Understanding how systems break is now the job — for juniors too.'],
    cta: 'Follow for Episode 2: the database is always the bottleneck',
  },
};

// ---------------------------------------------------------------------------------------------
// Comparison episodes, generated from the scenario library
// ---------------------------------------------------------------------------------------------

const COMPARE_HOOKS: Record<string, { hook: string; series?: string; metrics?: Episode['metrics'] }> = {
  'monolith-vs-micro': { hook: 'One database dies.\nHow much of your product dies with it?' },
  'single-vs-ha-db': { hook: 'Your primary database just died.\nOutage — or a 3-second blip?' },
  'sync-vs-async': { hook: 'Same traffic burst.\nOne architecture shrugs it off.' },
  'servers-vs-serverless': { hook: 'Serverless is cheap…\nuntil it isn’t.', series: 'Cloud cost, made visible', metrics: ['errors', 'p99', 'cost'] },
  'brute-vs-cache': { hook: 'Same traffic.\n60% cheaper. 15× faster.', series: 'Cloud cost, made visible', metrics: ['errors', 'p99', 'cost'] },
  'single-vs-multi-az': { hook: 'AWS just lost an availability zone.\nDid you?' },
  'retry-storm': { hook: 'Your retries just DDoSed\nyour own service.', metrics: ['errors', 'p99', 'cost'] },
  'ai-api-vs-gpu': { hook: 'Your AI feature went viral.\nHere\'s the bill.', series: 'Cloud cost, made visible', metrics: ['errors', 'p99', 'cost'] },
  'outage-after-the-fix': { hook: 'AWS fixed the bug in 2.5 hours.\nThe outage lasted 15.', series: 'Failure modes at scale', metrics: ['errors', 'p99'] },
  'retries-every-layer': { hook: 'Every layer retries 3 times.\nWhat could go wrong?', series: 'Failure modes at scale', metrics: ['errors', 'p99'] },
  'cells-vs-fleet': { hook: 'One poison request.\nHow many customers go down?', series: 'Failure modes at scale', metrics: ['errors', 'p99', 'cost'] },
  'queue-vs-shed': { hook: '“Never drop a request”\nis how you drop all of them.', series: 'Failure modes at scale', metrics: ['errors', 'p99'] },
  'tail-at-scale': { hook: 'Every shard is fast.\nYour users still wait.', series: 'Failure modes at scale', metrics: ['errors', 'p99'] },
  'llm-provider-outage': { hook: 'Your AI feature has a single point\nof failure you don\'t even run.', series: 'Failure modes at scale', metrics: ['errors', 'p99', 'cost'] },
  'node-vs-go': { hook: 'We rewrote it in Go.\nHow much did we save?', series: 'Cloud cost, made visible', metrics: ['errors', 'p99', 'cost'] },
};

function fromScenario(s: Scenario): Episode {
  const meta = COMPARE_HOOKS[s.id] ?? { hook: s.title };
  const beats: Beat[] = [];
  for (const k of s.timeline) if (k.caption) beats.push({ at: k.at, caption: k.caption });
  for (const ev of s.events) {
    const actions: Beat['do'] = [];
    if (ev.a) actions.push({ board: 'A', action: ev.a });
    if (ev.b) actions.push({ board: 'B', action: ev.b });
    beats.push({ at: ev.at, caption: ev.message, do: actions });
  }
  beats.sort((x, y) => x.at - y.at);
  if (!beats.length || beats[0].at > 0) beats.unshift({ at: 0, caption: s.tagline });
  return {
    id: `cmp-${s.id}`,
    series: meta.series ?? AI_ERA,
    hook: meta.hook,
    layout: 'compare',
    a: s.a,
    b: s.b,
    readRatio: s.readRatio,
    timeline: s.timeline,
    beats,
    metrics: meta.metrics ?? ['errors', 'p99', 'cost'],
    outro: { title: s.takeaway.lesson, lines: [`A — ${s.a.title}: ${s.takeaway.a}`, `B — ${s.b.title}: ${s.takeaway.b}`] },
  };
}

export const EPISODES: Episode[] = [ep1, ...SCENARIOS.map(fromScenario)];
export const episodeById = (id: string) => EPISODES.find((e) => e.id === id) ?? EPISODES[0];
