import { lesson1 } from '../lessons/lesson1';
import { SCENARIOS } from './scenarios';
import type { Graph } from './build';

export interface Template {
  id: string;
  title: string;
  group: string;
  graph: Graph;
}

/** every architecture used in a lesson or comparison doubles as a starting template */
export const TEMPLATES: Template[] = [
  { id: 'starter', title: 'Starter: 1 server + DB', group: 'Basics', graph: lesson1.initial },
  ...SCENARIOS.flatMap((s) => [
    { id: `${s.id}:a`, title: s.a.title, group: s.title, graph: s.a.graph },
    { id: `${s.id}:b`, title: s.b.title, group: s.title, graph: s.b.graph },
  ]),
];

export const templateGroups = () => [...new Set(TEMPLATES.map((t) => t.group))];
