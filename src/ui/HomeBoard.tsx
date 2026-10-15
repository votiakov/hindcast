import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ReactFlowProvider, ViewportPortal, useInternalNode } from '@xyflow/react';
import { BoardCanvas } from '../canvas/BoardCanvas';
import { useSim } from '../sim/store';
import { graphToSpec } from '../spec/convert';
import { openPayload } from '../spec/links';
import { explain, nodeView } from '../canvas/nodeModel';
import { isSystem } from '../sim/catalog';
import { optimizeInBrowser } from '../sim/des/browserPool';
import { HOME_GRAPHS, homeGraph, narrowScreen } from './homeGraphs';
import { runAudit } from './AuditPanel';

/**
 * The home page *is* a board: a live system that is about to fail. Short engineering callouts are
 * pinned to whichever component is in trouble, at the moment it matters, offering the next move.
 *
 * Cold open: the story plays by itself — overload, scale out, three times the traffic, the
 * database becomes the bottleneck, a cache — each move made after a short countdown that the
 * callout shows. A chapter strip says where the story is and jumps to any beat. The first click
 * or key on the board hands control to the visitor; every move still opens the mode that does the
 * job, pre-loaded.
 */

type Stage = 'ramp' | 'melting' | 'scaled' | 'tripled' | 'cached';

interface Action {
  label: string;
  run: () => void;
}

const money = (n: number) => `$${n.toFixed(2)}/h`;
const pct = (n: number) => `${(n * 100).toFixed(n > 0 && n < 0.1 ? 1 : 0)}%`;

const CHAPTERS: { stage: Stage; label: string }[] = [
  { stage: 'melting', label: 'overload' },
  { stage: 'scaled', label: 'scale out' },
  { stage: 'tripled', label: '3× traffic' },
  { stage: 'cached', label: 'a cache' },
];

/** seconds the story waits on each beat before making the next move itself */
const DWELL: Partial<Record<Stage, number>> = { melting: 7, scaled: 6, tripled: 7, cached: 14 };

interface CalloutProps {
  nodeId: string;
  title: string;
  lines: string[];
  actions: Action[];
  code?: string;
  tone?: 'bad' | 'good' | 'info';
  above?: boolean;
  /** "next: … in 4 s" while the story plays */
  next?: string | null;
}

function CalloutBody({ title, lines, actions, code, next }: CalloutProps) {
  return (
    <>
      <div className="callout-title">{title}</div>
      {lines.filter(Boolean).map((l) => (
        <p key={l}>{l}</p>
      ))}
      {code && <pre className="callout-code">{code}</pre>}
      {actions.length > 0 && (
        <div className="callout-actions">
          {actions.map((a, i) => (
            <button key={a.label} className={next && i === 0 ? 'next' : ''} onClick={a.run}>
              ▸ {a.label}
            </button>
          ))}
        </div>
      )}
      {next && <div className="callout-next">{next}</div>}
    </>
  );
}

const useSimNodes = () => useSim((s) => s.boards.main.nodes);

/** a callout anchored to a node, drawn in flow coordinates so it pans/zooms with the board */
function Callout(props: CalloutProps) {
  const { nodeId, tone = 'info', above = false } = props;
  const node = useInternalNode(nodeId);
  const xs = useSimNodes().map((n) => n.position.x);
  if (!node) return null;
  // phones: the callout docks at the bottom of the screen instead of hanging off the component
  if (narrowScreen())
    return createPortal(
      <div className={`callout docked tone-${tone}`}>
        <CalloutBody {...props} />
      </div>,
      document.body,
    );
  const w = node.measured.width ?? 230;
  const h = node.measured.height ?? 150;
  // a component on the right of the chain gets its callout hanging leftwards, so it stays on screen
  const rightmost = Math.max(...xs);
  const flip = node.internals.positionAbsolute.x >= rightmost - 1 && rightmost > 0;
  const x = node.internals.positionAbsolute.x + w * (flip ? 0.65 : 0.35);
  const y = above ? node.internals.positionAbsolute.y - 26 : node.internals.positionAbsolute.y + h + 26;
  return (
    <ViewportPortal>
      <div className={`callout tone-${tone} ${above ? 'above' : ''} ${flip ? 'flip' : ''}`} style={{ transform: `translate(${x}px, ${y}px)${flip ? ' translateX(-100%)' : ''}${above ? ' translateY(-100%)' : ''}` }}>
        <svg className="callout-leader" width="2" height="26" aria-hidden>
          <line x1="1" y1="0" x2="1" y2="26" />
        </svg>
        <CalloutBody {...props} />
      </div>
    </ViewportPortal>
  );
}

/** where the story is: the beats, which one is on, and who is driving */
function Chapters({ stage, auto, onJump, onPlay }: { stage: Stage; auto: boolean; onJump: (s: Stage) => void; onPlay: () => void }) {
  const at = stage === 'ramp' ? 0 : CHAPTERS.findIndex((c) => c.stage === stage);
  return (
    <div className="live-chapters" onPointerDown={(e) => e.stopPropagation()}>
      <button className={`lc-play ${auto ? 'on' : ''}`} onClick={onPlay} title={auto ? 'The story is playing; click anything on the board to take over' : 'Play the story from the start'}>
        {auto ? '▶ playing' : '↺ replay'}
      </button>
      {CHAPTERS.map((c, i) => (
        <button key={c.stage} className={`lc-step ${i === at ? 'on' : i < at ? 'done' : ''}`} onClick={() => onJump(c.stage)}>
          <span>{i + 1}</span> {c.label}
        </button>
      ))}
      {!auto && <span className="lc-you">you're driving</span>}
    </div>
  );
}

function Coach() {
  const [stage, setStage] = useState<Stage>('ramp');
  const [auto, setAuto] = useState(true);
  const [left, setLeft] = useState<number | null>(null);
  const [extra, setExtra] = useState<{ title: string; lines: string[]; actions: Action[]; code?: string } | null>(null);
  const stats = useSim((s) => s.boards.main.nodeStats);
  const nodes = useSim((s) => s.boards.main.nodes);
  const global = useSim((s) => s.boards.main.global);
  const traffic = useSim((s) => s.traffic);
  const S = useSim.getState;
  const autoRef = useRef(auto);
  autoRef.current = auto;

  // traffic climbs on arrival so the failure happens in front of the visitor
  useEffect(() => {
    if (stage !== 'ramp') return;
    const id = setInterval(() => {
      const t = S().traffic;
      if (t < 700) S().setTraffic(Math.min(700, Math.round(t * 1.25 + 20)));
    }, 400);
    return () => clearInterval(id);
  }, [stage, S]);

  // the visitor takes over with their first click or key on the board
  useEffect(() => {
    if (!auto) return;
    const stop = (e: Event) => {
      if ((e.target as HTMLElement)?.closest?.('.live-chapters')) return;
      setAuto(false);
    };
    window.addEventListener('pointerdown', stop, true);
    window.addEventListener('keydown', stop, true);
    window.addEventListener('wheel', stop, { capture: true, passive: true });
    return () => {
      window.removeEventListener('pointerdown', stop, true);
      window.removeEventListener('keydown', stop, true);
      window.removeEventListener('wheel', stop, true);
    };
  }, [auto]);

  const view = (id: string) => {
    const n = nodes.find((x) => x.id === id);
    if (!n || !isSystem(n)) return null;
    const st = stats[id];
    const v = nodeView(n.data, st, true, true);
    return { v, note: explain(n.data, st, v), st };
  };
  const api = view('api-1');
  const db = view('postgres');
  const dbHot = db?.v.health === 'hot' || (db?.st?.dropRps ?? 0) > 1;

  // stage transitions driven by what the simulation is actually doing
  useEffect(() => {
    if (stage === 'ramp' && api?.v.health === 'hot' && (api.st?.dropRps ?? 0) > 1) setStage('melting');
    if (stage === 'tripled' && dbHot) setExtra(null);
  }, [stage, api, dbHot]);

  const spec = () => graphToSpec(S().boards.main.nodes, S().boards.main.edges, 'This system');
  const swap = (i: number) => S().replaceGraph('main', homeGraph(i));

  // ---- the moves (shared by the story and the visitor)
  const scaleOut = () => {
    swap(1);
    S().setTraffic(700);
    setStage('scaled');
  };
  const triple = () => {
    if (!S().boards.main.nodes.some((n) => n.id === 'lb')) swap(1);
    S().setTraffic(2100);
    S().updateNode('main', 'api-1', { instances: 10 });
    setStage('tripled');
  };
  const cache = () => {
    swap(2);
    S().setTraffic(2100);
    setStage('cached');
  };
  const restart = () => {
    setExtra(null);
    S().setMode('home');
    setStage('ramp');
  };
  const jump = (s: Stage) => {
    setExtra(null);
    if (s === 'melting') {
      S().setMode('home');
      S().setTraffic(700);
      setStage('ramp');
    } else if (s === 'scaled') scaleOut();
    else if (s === 'tripled') triple();
    else if (s === 'cached') cache();
  };

  // ---- the story: on each beat, once the system shows what the beat is about, count down and move
  const ready = stage === 'melting' || (stage === 'scaled' && global.rps > 1 && global.errorRate < 0.01) || (stage === 'tripled' && dbHot) || stage === 'cached';
  useEffect(() => {
    if (!auto || !ready || extra) {
      setLeft(null);
      return;
    }
    let n = DWELL[stage] ?? 6;
    setLeft(n);
    const id = setInterval(() => {
      n -= 1;
      setLeft(n);
      if (n > 0 || !autoRef.current) return;
      clearInterval(id);
      if (stage === 'melting') scaleOut();
      else if (stage === 'scaled') triple();
      else if (stage === 'tripled') cache();
      else if (stage === 'cached') restart();
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, ready, stage, extra]);
  const next = (label: string) => (auto && left !== null ? `next: ${label} in ${left} s · click anywhere to take over` : null);

  const compareWith = (i: number, title: string, rps: number) =>
    openPayload({
      compare: {
        a: { title: 'As it is now', spec: spec() },
        b: { title, spec: graphToSpec(HOME_GRAPHS[i].nodes, HOME_GRAPHS[i].edges) },
        scenario: { name: `${rps.toLocaleString()} req/s`, duration: 30, rps, readRatio: 0.8 },
      },
    }) && S().setRunning(true);

  const toSandbox = () => S().keepBoardAs('sandbox');
  const auditIt = () => {
    toSandbox();
    S().setAuditOpen(true);
    void runAudit();
  };
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

  const strip = <Chapters stage={stage} auto={auto} onJump={jump} onPlay={() => (auto ? undefined : (setAuto(true), restart()))} />;

  if (extra) {
    return (
      <>
        {strip}
        <Callout nodeId="api-1" title={extra.title} lines={extra.lines} actions={[...extra.actions, { label: 'close', run: () => setExtra(null) }]} code={extra.code} />
      </>
    );
  }

  let callout: React.ReactNode = null;
  switch (stage) {
    case 'ramp':
      callout = <Callout nodeId="users" title="live system" lines={[`Users are arriving: ${traffic} req/s and climbing.`, 'One API server, one database. Watch the middle.']} actions={[]} />;
      break;
    case 'melting':
      callout = (
        <Callout
          nodeId="api-1"
          tone="bad"
          title={`api-1 · ${api?.v.health === 'hot' ? 'saturated' : 'recovering'}`}
          lines={[`${pct(global.errorRate)} of users get errors · p99 ${Math.round(global.p99)} ms`, api?.note?.text ?? '']}
          next={next('scale it out')}
          actions={[
            { label: 'scale it out', run: scaleOut },
            { label: 'compare the fix side by side', run: () => compareWith(1, 'Load balancer + 4 instances', 700) },
            { label: 'learn it step by step', run: () => lesson('scale-101') },
            { label: 'take over the board', run: toSandbox },
          ]}
        />
      );
      break;
    case 'scaled':
      callout = (
        <Callout
          nodeId="api-1"
          tone={global.errorRate < 0.01 ? 'good' : 'info'}
          title={global.errorRate < 0.01 ? 'healthy · 4 instances behind a load balancer' : 'scaling out…'}
          lines={[`${pct(global.errorRate)} errors · p99 ${Math.round(global.p99)} ms · ${money(global.cost)}`, global.errorRate < 0.01 ? 'Same traffic. Spread across four instances, each below 70% busy.' : 'Same traffic, four instances: the backlog built up while it was melting is draining, and the errors clear as it does.']}
          next={next('triple the traffic')}
          actions={[
            { label: 'triple the traffic', run: triple },
            { label: 'find the cheapest config for this load', run: cheapest },
            { label: 'what if one instance dies?', run: () => S().killNode('main', 'api-1') },
            { label: 'audit it: what breaks first, and what it costs', run: auditIt },
            { label: 'take over the board', run: toSandbox },
          ]}
        />
      );
      break;
    case 'tripled':
      callout = dbHot ? (
        <Callout
          nodeId="postgres"
          tone="bad"
          title="postgres · the new bottleneck"
          lines={['Autoscaling grew api-1 to 10 instances — and moved the problem to the database.', db?.note?.text ?? '']}
          next={next('put a cache in front of it')}
          actions={[
            { label: 'put a cache in front of it', run: cache },
            { label: 'compare: cache vs a bigger database', run: () => compare('brute-vs-cache') },
            { label: 'audit it: what breaks next?', run: auditIt },
            { label: 'take over the board', run: toSandbox },
          ]}
        />
      ) : (
        <Callout nodeId="api-1" title="2,100 req/s" lines={['Autoscaling adds instances. Watch where the pressure goes next.']} actions={[]} />
      );
      break;
    case 'cached':
      callout = (
        <Callout
          nodeId="redis"
          above
          tone="good"
          title="that's the loop"
          lines={[`Pressure → bottleneck → fix → cost. ${pct(global.errorRate)} errors at ${money(global.cost)}.`, 'Now your turn:']}
          next={auto && left !== null ? `the story starts over in ${left} s` : null}
          actions={[
            { label: 'learn it step by step: 7 lessons, 22 levels', run: () => lesson('scale-101') },
            { label: 'design your own system and break it', run: toSandbox },
            { label: 'check a change on your real system’s history', run: () => S().setMode('backtest') },
            { label: 'let your AI agent do it (MCP)', run: () => window.open('docs/agents.html', '_blank', 'noopener') },
            { label: 'render this as a video', run: () => (S().setMode('studio'), S().loadEpisode('ep1-localhost')) },
          ]}
        />
      );
      break;
  }
  return (
    <>
      {strip}
      {callout}
    </>
  );
}

export function HomeBoard() {
  return (
    <ReactFlowProvider>
      <BoardCanvas id="main" minimap={false} padding={narrowScreen() ? { top: '56px', left: '16px', right: '16px', bottom: `${Math.round(window.innerHeight * 0.42)}px` } : { top: '90px', left: '60px', right: '60px', bottom: '330px' }}>
        <Coach />
      </BoardCanvas>
    </ReactFlowProvider>
  );
}
