import type { Dataset, Num } from './dataset';
import type { Model } from './model';
import type { Fault } from './engine';
import { backtest, type BacktestResult } from './backtest';

/**
 * Famous public outages as replayable datasets: "would your design have survived it?"
 *
 * Each outage is its published timeline turned into what your system would have felt — traffic
 * relative to your normal load, and faults on roles (your primary database, your edge, every
 * autoscaled service…) at the times the postmortem gives. Roles resolve to services of your model;
 * replay it as built and with any strategy. Times and numbers cite the postmortems; how a
 * provider-side failure maps onto *your* components is the stated assumption of each step.
 */

export type Role =
  /** every service that receives user requests first */
  | 'edge'
  /** primary relational database(s) */
  | 'primary-db'
  /** managed key-value / NoSQL store (DynamoDB-like); falls back to primary-db */
  | 'managed-kv'
  /** every service that runs replicas (autoscalable compute) */
  | 'compute'
  /** every component */
  | 'all';

export interface OutageStep {
  /** minutes from the start of the replay window */
  from: number;
  to?: number;
  role: Role;
  effect: Omit<Fault, 'at' | 'until' | 'service' | 'note'>;
  /** what happened, from the postmortem */
  note: string;
}

export interface Outage {
  id: string;
  title: string;
  /** the event, one line */
  what: string;
  /** wall-clock start of the replay window (ISO, with offset) */
  start: string;
  minutes: number;
  stepS: number;
  /** traffic relative to your normal (p90) load, keyframes in minutes */
  traffic: { at: number; mult: number }[];
  steps: OutageStep[];
  /** the published timeline, for captions */
  timeline: { at: string; text: string }[];
  sources: { label: string; url: string }[];
  assumptions: string[];
}

export const OUTAGES: Outage[] = [
  {
    id: 'cloudflare-2019-07-02',
    title: 'Cloudflare, 2 July 2019 — a regex ate every CPU',
    what: 'A WAF rule with catastrophic regex backtracking was deployed globally; every edge machine went to 100% CPU and served 502s for 27 minutes.',
    start: '2019-07-02T13:30:00Z',
    minutes: 60,
    stepS: 30,
    traffic: [
      { at: 0, mult: 1 },
      { at: 60, mult: 1 },
    ],
    steps: [{ from: 12, to: 37, role: 'edge', effect: { capacity: 0.03 }, note: 'WAF rule deployed: each request now costs ~30× the CPU at the edge' }],
    timeline: [
      { at: '13:42', text: 'The rule deploys to the whole edge at once' },
      { at: '13:45', text: 'First alerts: synthetic WAF test failures, traffic dropping' },
      { at: '~14:00', text: '“We had lost 80% of our traffic” — WAF identified' },
      { at: '14:07', text: 'Global WAF kill switch executed' },
      { at: '14:09', text: 'Traffic and CPU back to normal' },
    ],
    sources: [{ label: 'Cloudflare: Details of the Cloudflare outage on July 2, 2019', url: 'https://blog.cloudflare.com/details-of-the-cloudflare-outage-on-july-2-2019/' }],
    assumptions: ['Your edge services take the role of Cloudflare’s WAF: their CPU cost per request rises ~30×, so capacity drops to ~3% for 25 minutes (deploy → kill switch).', 'Only CPU-bound edge capacity is cut; downstream services keep theirs.'],
  },
  {
    id: 'github-2018-10-21',
    title: 'GitHub, 21 October 2018 — 43 seconds, 24 hours',
    what: 'A 43-second network partition made the database orchestrator promote West-coast MySQL primaries; East-coast apps then wrote across the country for most of a day.',
    start: '2018-10-21T22:45:00Z',
    minutes: 360,
    stepS: 60,
    traffic: [
      { at: 0, mult: 0.8 },
      { at: 120, mult: 0.7 },
      { at: 360, mult: 0.6 },
    ],
    steps: [
      { from: 7, to: 7.75, role: 'primary-db', effect: { down: true }, note: '43 s partition between the US-East hub and data center' },
      { from: 7.75, role: 'primary-db', effect: { extraMs: 60 }, note: 'Primaries promoted in US West: every database call crosses the country (~60 ms)' },
      { from: 7.75, to: 26, role: 'primary-db', effect: { errorRate: 0.02 }, note: 'Writes rejected while topology settles' },
    ],
    timeline: [
      { at: '22:52', text: 'Optical equipment maintenance cuts US-East hub ↔ data center for 43 s' },
      { at: '22:52', text: 'Orchestrator promotes US-West database primaries' },
      { at: '23:07', text: 'Deploys locked; status yellow' },
      { at: '23:11', text: 'Status red; apps in US-East now write to US-West' },
      { at: '+24h', text: 'Back to green Oct 22 23:03 UTC after 5M webhook events were drained' },
    ],
    sources: [{ label: 'GitHub: October 21 post-incident analysis', url: 'https://github.blog/news-insights/company-news/oct21-post-incident-analysis/' }],
    assumptions: ['Your primary database plays GitHub’s MySQL primaries: 43 s unreachable, then ~60 ms extra on every call (US coast-to-coast round trip) for the rest of the window.', 'Requests that call the database several times pay the 60 ms each time.', 'The first six hours of the 24-hour incident are replayed, at 70–80% of your usual load (Sunday evening).'],
  },
  {
    id: 'slack-2021-01-04',
    title: 'Slack, 4 January 2021 — the Monday after the holidays',
    what: 'Cold client caches pulled data all at once on the first workday of the year; AWS Transit Gateways saturated, packets dropped, and autoscaling tried to add 1,200 servers while provisioning itself was failing.',
    start: '2021-01-04T05:30:00-08:00',
    minutes: 330,
    stepS: 60,
    traffic: [
      { at: 0, mult: 0.45 },
      { at: 60, mult: 0.8 },
      { at: 90, mult: 1.55 },
      { at: 165, mult: 1.35 },
      { at: 225, mult: 1.15 },
      { at: 330, mult: 1 },
    ],
    steps: [
      { from: 50, to: 90, role: 'all', effect: { errorRate: 0.005 }, note: 'Packet loss creeping up between services' },
      { from: 90, to: 310, role: 'all', effect: { errorRate: 0.015, extraMs: 40 }, note: 'Transit Gateway saturated: retransmits and dropped calls everywhere' },
      { from: 91, to: 165, role: 'compute', effect: { noScaleOut: true }, note: 'Provisioning fails: open-file limit and AWS quota hit while 1,200 servers were requested' },
      { from: 165, to: 225, role: 'compute', effect: { warmupFactor: 4 }, note: 'Provisioning recovers slowly' },
    ],
    timeline: [
      { at: '06:57', text: 'Only 99% of messages sending successfully' },
      { at: '07:00', text: 'Mini-peak plus degraded network saturates the web tier; Slack unavailable' },
      { at: '07:01–07:15', text: 'Autoscaling asks for 1,200 more web servers' },
      { at: '08:15', text: 'Provisioning service recovers' },
      { at: '09:15', text: 'Web tier has enough capacity; still degraded' },
      { at: '10:40', text: 'AWS raises Transit Gateway capacity; network normal' },
    ],
    sources: [{ label: 'Slack Engineering: Slack’s outage on January 4th 2021', url: 'https://slack.engineering/slacks-outage-on-january-4th-2021/' }],
    assumptions: ['Traffic: your morning ramp, then 1.55× your usual peak at 07:00 while cold caches refill (Slack gave no number; this is the assumption to tune).', 'Network loss is applied to every component: 1.5% of calls fail and 40 ms is added while the gateways are saturated.', 'Your autoscaled services cannot launch anything for 74 minutes, then launch 4× slower for an hour.'],
  },
  {
    id: 'aws-use1-2025-10-20',
    title: 'AWS us-east-1, 20 October 2025 — DynamoDB lost its DNS',
    what: 'A race in DynamoDB’s DNS automation emptied the regional endpoint record. Everything that depended on DynamoDB failed, including EC2’s own instance-launch system, which then took hours to recover.',
    start: '2025-10-19T23:30:00-07:00',
    minutes: 900,
    stepS: 60,
    traffic: [
      { at: 0, mult: 0.35 },
      { at: 300, mult: 0.4 },
      { at: 540, mult: 0.95 },
      { at: 720, mult: 1 },
      { at: 900, mult: 0.9 },
    ],
    steps: [
      { from: 18, to: 175, role: 'managed-kv', effect: { down: true }, note: 'DynamoDB endpoint does not resolve' },
      { from: 18, to: 358, role: 'compute', effect: { noScaleOut: true }, note: 'EC2 cannot launch instances (droplet leases expired, then congestive collapse)' },
      { from: 358, to: 860, role: 'compute', effect: { warmupFactor: 4 }, note: 'Launches resume; network configuration propagates slowly' },
      { from: 360, to: 486, role: 'edge', effect: { errorRate: 0.02 }, note: 'NLB health checks flap on instances without network config' },
      { from: 486, to: 759, role: 'edge', effect: { errorRate: 0.004 }, note: 'Health-check failover disabled; residual connection errors' },
    ],
    timeline: [
      { at: '23:48 PDT', text: 'DynamoDB endpoint stops resolving; EC2 launch leases start timing out' },
      { at: '00:38', text: 'DNS identified as the source' },
      { at: '02:25', text: 'DNS records restored' },
      { at: '04:14', text: 'EC2 work throttled, DWFM hosts restarted' },
      { at: '05:28', text: 'Instance launches possible again' },
      { at: '05:30–14:09', text: 'NLB connection errors from flapping health checks' },
      { at: '13:50', text: 'All EC2 launches normal' },
    ],
    sources: [{ label: 'AWS: Summary of the Amazon DynamoDB service disruption in us-east-1', url: 'https://aws.amazon.com/message/101925/' }],
    assumptions: ['Your managed key-value store (or your primary database, if you have none) is unreachable for 2 h 37 min — assumes it lives in us-east-1.', 'Your autoscaled services cannot add capacity until 05:28, then launch 4× slower until 13:50.', 'Your edge sees load-balancer connection errors: 2% until 09:36, then 0.4% until 14:09.'],
  },
];

/** services of a model that play a role */
export function servicesFor(model: Model, role: Role, overrides: Partial<Record<Role, string[]>> = {}): string[] {
  if (overrides[role]?.length) return overrides[role]!;
  const all = Object.values(model.services);
  const entry = new Set(Object.values(model.endpoints).map((e) => e.service));
  switch (role) {
    case 'edge':
      return all.filter((s) => entry.has(s.id)).map((s) => s.id);
    case 'primary-db':
      return all.filter((s) => s.kind === 'db').map((s) => s.id);
    case 'managed-kv': {
      const kv = all.filter((s) => s.kind === 'db' && /dynamo|mongo|cassandra|firestore|cosmos|kv/i.test(`${s.system ?? ''} ${s.id}`)).map((s) => s.id);
      return kv.length ? kv : servicesFor(model, 'primary-db', overrides);
    }
    case 'compute':
      return all.filter((s) => !s.hostedBy && (s.kind === 'server' || s.kind === 'lb')).map((s) => s.id);
    case 'all':
      return all.filter((s) => !s.hostedBy).map((s) => s.id);
  }
}

export interface OutageReplay {
  outage: Outage;
  dataset: Dataset;
  faults: Fault[];
  /** role → services it was applied to; empty roles are said out loud */
  roles: Record<string, string[]>;
  warnings: string[];
  /** the "normal load" the traffic multipliers apply to, req/s */
  baseRps: number;
}

/** the outage as a dataset + faults for a given model */
export function outageScenario(model: Model, outage: Outage, opts: { baseRps?: number; roles?: Partial<Record<Role, string[]>> } = {}): OutageReplay {
  const base = opts.baseRps ?? model.traffic?.p90 ?? 10;
  const n = Math.round((outage.minutes * 60) / outage.stepS);
  const start = Math.floor(Date.parse(outage.start) / 1000);
  const kf = [...outage.traffic].sort((a, b) => a.at - b.at);
  const mult = (min: number) => {
    if (min <= kf[0].at) return kf[0].mult;
    for (let k = 1; k < kf.length; k++) if (min <= kf[k].at) return kf[k - 1].mult + ((kf[k].mult - kf[k - 1].mult) * (min - kf[k - 1].at)) / (kf[k].at - kf[k - 1].at);
    return kf[kf.length - 1].mult;
  };
  const endpoints: Dataset['endpoints'] = {};
  for (const [id, e] of Object.entries(model.endpoints)) {
    const rps: Num[] = Array.from({ length: n }, (_, i) => base * e.share * mult((i * outage.stepS) / 60));
    endpoints[id] = { service: e.service, rps };
  }
  const faults: Fault[] = [];
  const roles: Record<string, string[]> = {};
  const warnings: string[] = [];
  for (const st of outage.steps) {
    const svcs = servicesFor(model, st.role, opts.roles);
    roles[st.role] = svcs;
    if (!svcs.length) warnings.push(`no service plays “${st.role}” in this model — “${st.note}” does not apply`);
    for (const s of svcs) faults.push({ ...st.effect, service: s, at: st.from * 60, ...(st.to !== undefined ? { until: st.to * 60 } : {}), note: `${st.note} (${s})` });
  }
  const dataset: Dataset = { version: 1, name: `${outage.title} · ${model.name}`, start, stepS: outage.stepS, n, services: {}, endpoints, sources: outage.sources.map((x) => x.url) };
  return { outage, dataset, faults, roles, warnings, baseRps: base };
}

export function replayOutage(model: Model, outage: Outage, strategies: unknown[] = [], opts: { baseRps?: number; roles?: Partial<Record<Role, string[]>>; draws?: number } = {}): { replay: OutageReplay; result: BacktestResult } {
  const replay = outageScenario(model, outage, opts);
  const result = backtest(model, replay.dataset, strategies, { draws: opts.draws ?? 10, faults: replay.faults, observed: false });
  return { replay, result };
}

export const outageById = (id: string) => OUTAGES.find((o) => o.id === id);
