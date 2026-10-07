import { useEffect, useRef, useState } from 'react';
import { ReactFlowProvider, ViewportPortal, useInternalNode } from '@xyflow/react';
import { BoardCanvas } from '../canvas/BoardCanvas';
import { useSim } from '../sim/store';
import { graphToSpec } from '../spec/convert';
import { openPayload } from '../spec/links';
import { explain, nodeView } from '../canvas/nodeModel';
import { isSystem } from '../sim/catalog';
import { optimizeInBrowser } from '../sim/des/browserPool';
import { HOME_GRAPHS } from './homeGraphs';

/**
 * The home page *is* a board: a live system that is about to fail. Short engineering callouts are
 * pinned to whichever component is in trouble, at the moment it matters, offering the next move.
 * Every move happens on this board or opens the mode that does the job, pre-loaded.
 */

type Stage = 'ramp' | 'melting' | 'scaled' | 'tripled' | 'cached';

interface Action {
  label: string;
  run: () => void;
}

const money = (n: number) => `$${n.toFixed(2)}/h`;
const pct = (n: number) => `${(n * 100).toFixed(n > 0 && n < 0.1 ? 1 : 0)}%`;

/** a callout anchored to a node, drawn in flow coordinates so it pans/zooms with the board */
function Callout({ nodeId, title, lines, actions, code, tone = 'info', above = false }: { nodeId: string; title: string; lines: string[]; actions: Action[]; code?: string; tone?: 'bad' | 'good' | 'info'; above?: boolean }) {
  const node = useInternalNode(nodeId);
  if (!node) return null;
  const w = node.measured.width ?? 230;
  const h = node.measured.height ?? 150;
  const x = node.internals.positionAbsolute.x + w * 0.35;
  const y = above ? node.internals.positionAbsolute.y - 26 : node.internals.positionAbsolute.y + h + 26;
  return (
    <ViewportPortal>
      <div className={`callout tone-${tone} ${above ? 'above' : ''}`} style={{ transform: `translate(${x}px, ${y}px)${above ? ' translateY(-100%)' : ''}` }}>
        <svg className="callout-leader" width="2" height="26" aria-hidden>
          <line x1="1" y1="0" x2="1" y2="26" />
        </svg>
        <div className="callout-title">{title}</div>
        {lines.map((l) => (
          <p key={l}>{l}</p>
        ))}
        {code && <pre className="callout-code">{code}</pre>}
        {actions.length > 0 && (
          <div className="callout-actions">
            {actions.map((a) => (
              <button key={a.label} onClick={a.run}>
                ▸ {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </ViewportPortal>
  );
}

function Coach() {
  const [stage, setStage] = useState<Stage>('ramp');
  const [extra, setExtra] = useState<{ title: string; lines: string[]; actions: Action[]; code?: string } | null>(null);
  const healthyFor = useRef(0);
  const stats = useSim((s) => s.boards.main.nodeStats);
  const nodes = useSim((s) => s.boards.main.nodes);
  const global = useSim((s) => s.boards.main.global);
  const traffic = useSim((s) => s.traffic);
  const S = useSim.getState;

  // traffic climbs on arrival so the failure happens in front of the visitor
  useEffect(() => {
    if (stage !== 'ramp') return;
    const id = setInterval(() => {
      const t = S().traffic;
      if (t < 700) S().setTraffic(Math.min(700, Math.round(t * 1.25 + 20)));
    }, 400);
    return () => clearInterval(id);
  }, [stage, S]);

  const view = (id: string) => {
    const n = nodes.find((x) => x.id === id);
    if (!n || !isSystem(n)) return null;
    const st = stats[id];
    const v = nodeView(n.data, st, true, true);
    return { v, note: explain(n.data, st, v), st };
  };
  const api = view('api-1');
  const db = view('postgres');

  // stage transitions driven by what the simulation is actually doing
  useEffect(() => {
    if (stage === 'ramp' && api?.v.health === 'hot' && (api.st?.dropRps ?? 0) > 1) setStage('melting');
    const healthy = global.rps > 1 && global.errorRate < 0.01;
    healthyFor.current = healthy ? healthyFor.current + 1 : 0;
    if (stage === 'tripled' && db?.v.health === 'hot') setExtra(null);
  }, [stage, api, db, global]);

  const spec = () => graphToSpec(S().boards.main.nodes, S().boards.main.edges, 'This system');
  const swap = (i: number) => S().replaceGraph('main', HOME_GRAPHS[i]);

  const compareWith = (i: number, title: string, rps: number) =>
    openPayload({
      compare: {
        a: { title: 'As it is now', spec: spec() },
        b: { title, spec: graphToSpec(HOME_GRAPHS[i].nodes, HOME_GRAPHS[i].edges) },
        scenario: { name: `${rps.toLocaleString()} req/s`, duration: 30, rps, readRatio: 0.8 },
      },
    }) && S().setRunning(true);

  const toSandbox = () => S().keepBoardAs('sandbox');
  const lesson = (id: string) => {
    S().setMode('lesson');
    S().pickLesson(id);
  };
  const compare = (id: string) => {
    S().setMode('compare');
    S().pickScenario(id);
    S().setRunning(true);
  };

  const cheapest = async () => {
    setExtra({ title: 'searching…', lines: ['Sizing every component for the current load at p99 < 300 ms.'], actions: [] });
    const r = await optimizeInBrowser(spec(), { duration: 30, rps: S().traffic, readRatio: 0.8 }, false);
    const changes = r.changes.map((c) => (c.op === 'set' ? `${c.id}: ${Object.entries(c.fields).map(([k, v]) => `${k} ${v}`).join(', ')}` : '')).filter(Boolean);
    setExtra({
      title: r.feasible ? 'cheapest config that holds the SLO' : 'sizing alone cannot hold the SLO',
      lines: [
        `${money(r.before.costPerHour)} → ${money(r.after.costPerHour)} · ${r.monthlySavings >= 0 ? `saves $${r.monthlySavings.toLocaleString()}` : `costs $${(-r.monthlySavings).toLocaleString()} more`} a month`,
        ...(changes.length ? changes : ['already the cheapest sizing']),
        ...(r.verification ? [`verified in ${r.verification.runs} per-request runs: SLO held in ${pct(r.verification.pSloMet)}`] : []),
      ],
      actions: changes.length
        ? [
            {
              label: 'apply it',
              run: () => {
                for (const c of r.changes) if (c.op === 'set') S().updateNode('main', c.id, c.fields);
                setExtra(null);
              },
            },
          ]
        : [],
    });
  };

  if (extra) {
    return <Callout nodeId="api-1" title={extra.title} lines={extra.lines} actions={[...extra.actions, { label: 'close', run: () => setExtra(null) }]} code={extra.code} />;
  }

  switch (stage) {
    case 'ramp':
      return <Callout nodeId="users" title="live system" lines={[`Users are arriving: ${traffic} req/s and climbing.`, 'One API server, one database. Watch the middle.']} actions={[]} />;
    case 'melting':
      return (
        <Callout
          nodeId="api-1"
          tone="bad"
          title={`api-1 · ${api?.v.health === 'hot' ? 'saturated' : 'recovering'}`}
          lines={[api?.note?.text ?? '', `${pct(global.errorRate)} of users get errors · p99 ${Math.round(global.p99)} ms`]}
          actions={[
            {
              label: 'scale it out',
              run: () => {
                swap(1);
                setStage('scaled');
              },
            },
            { label: 'compare the fix side by side', run: () => compareWith(1, 'Load balancer + 4 instances', 700) },
            { label: 'learn it step by step', run: () => lesson('scale-101') },
            { label: 'take over the board', run: toSandbox },
          ]}
        />
      );
    case 'scaled':
      return (
        <Callout
          nodeId="api-1"
          tone={global.errorRate < 0.01 ? 'good' : 'info'}
          title={global.errorRate < 0.01 ? 'healthy · 4 instances behind a load balancer' : 'scaling out…'}
          lines={[`${pct(global.errorRate)} errors · p99 ${Math.round(global.p99)} ms · ${money(global.cost)}`, 'Same traffic. Spread across four instances, each below 70% busy.']}
          actions={[
            {
              label: 'triple the traffic',
              run: () => {
                S().setTraffic(2100);
                S().updateNode('main', 'api-1', { instances: 10 });
                setStage('tripled');
              },
            },
            { label: 'find the cheapest config for this load', run: cheapest },
            { label: 'what if one instance dies?', run: () => S().killNode('main', 'api-1') },
            { label: 'take over the board', run: toSandbox },
          ]}
        />
      );
    case 'tripled':
      return db?.v.health === 'hot' || (db?.st?.dropRps ?? 0) > 1 ? (
        <Callout
          nodeId="postgres"
          tone="bad"
          title="postgres · the new bottleneck"
          lines={['Autoscaling grew api-1 to 10 instances — and moved the problem to the database.', db?.note?.text ?? '']}
          actions={[
            {
              label: 'put a cache in front of it',
              run: () => {
                swap(2);
                setStage('cached');
              },
            },
            { label: 'compare: cache vs a bigger database', run: () => compare('brute-vs-cache') },
            { label: 'take over the board', run: toSandbox },
          ]}
        />
      ) : (
        <Callout nodeId="api-1" title="2,100 req/s" lines={['Autoscaling adds instances. Watch where the pressure goes next.']} actions={[]} />
      );
    case 'cached':
      return (
        <Callout
          nodeId="redis"
          above
          tone="good"
          title="that's the loop"
          lines={[`Pressure → bottleneck → fix → cost. ${pct(global.errorRate)} errors at ${money(global.cost)}.`, 'Now do it with your own system:']}
          code={'npm run sim -- import-terraform state.json --out mine.yaml\nnpm run sim -- analyze mine.yaml --rps 1500\n# or ask Claude: "here\'s our Terraform — what breaks first?"'}
          actions={[
            { label: 'take over this board', run: toSandbox },
            { label: 'compare architectures', run: () => compare('retry-storm') },
            { label: 'all lessons', run: () => lesson('retry-storm') },
            {
              label: 'render this as a video',
              run: () => {
                S().setMode('studio');
                S().loadEpisode('ep1-localhost');
              },
            },
            {
              label: 'start over',
              run: () => {
                S().setMode('home');
                setStage('ramp');
              },
            },
          ]}
        />
      );
  }
}

export function HomeBoard() {
  return (
    <ReactFlowProvider>
      <BoardCanvas id="main" minimap={false} padding={{ top: '60px', left: '60px', right: '60px', bottom: '260px' }}>
        <Coach />
      </BoardCanvas>
    </ReactFlowProvider>
  );
}
