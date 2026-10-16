import { memo } from 'react';
import { type NodeProps } from '@xyflow/react';
import { type SystemNode as SystemNodeT } from '../sim/catalog';
import { useSim } from '../sim/store';
import { useBoardId } from './BoardContext';
import { RiskMark } from './RiskMark';
import { healthOf, nodeView, type Health } from './nodeModel';
import { RefNode } from '../theme/reference/RefNode';
import { CardControls } from './CardControls';
import { useTracer } from '../ui/tracer';

/** a component the traced request did not reach */
const OFF = { state: 'off', note: null } as const;

export { healthOf, type Health };

function SystemNodeImpl({ id, data, selected }: NodeProps<SystemNodeT>) {
  const b = useBoardId();
  const st = useSim((s) => s.boards[b].nodeStats[id]);
  const running = useSim((s) => s.running);
  const showCost = useSim((s) => s.settings.cost);
  const each = useSim((s) => s.settings.replicaView === 'each');
  const motion = useSim((s) => s.running && s.settings.particles);
  const hasOutgoing = useSim((s) => s.boards[b].edges.some((e) => e.source === id));
  // on Live the callout pinned to the troubled component is the explanation: a second copy inside
  // the card would only push the next moves off screen
  const explainOn = useSim((s) => s.settings.explain && s.mode !== 'home');
  const v = nodeView(data, st, running, hasOutgoing);
  const tr = useTracer((s) => (s.board === b && s.marks ? (s.marks.nodes[id] ?? OFF) : null));
  const focus = useTracer((s) => s.board === b && !!s.marks && s.node === id);
  return (
    <>
      <RiskMark id={id} />
      <RefNode data={data} st={st} v={v} selected={selected} showCost={showCost} running={running} motion={motion} each={each} explainOn={explainOn} trace={tr ? { ...tr, focus } : null} controls={selected ? <CardControls id={id} data={data} /> : null} />
    </>
  );
}

export const SystemNode = memo(SystemNodeImpl);
