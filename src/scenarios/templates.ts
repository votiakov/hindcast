import { lesson1 } from '../lessons/lesson1';
import { events } from '../lessons/events';
import { crawler } from '../lessons/crawler';
import { sharding } from '../lessons/sharding';
import { cap } from '../lessons/cap';
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
  // boards from the lessons that show the newer building blocks
  { id: 'events', title: 'Orders as events: a stream, two subscribers', group: 'Patterns', graph: events.initial as Graph },
  { id: 'crawler', title: 'Web crawler: frontier, fleet, sharded index', group: 'Patterns', graph: crawler.initial as Graph },
  { id: 'sharding', title: 'One database, before sharding', group: 'Patterns', graph: sharding.initial as Graph },
  { id: 'cap', title: 'Primary and replica in two regions', group: 'Patterns', graph: cap.initial as Graph },
  ...SCENARIOS.flatMap((s) => [
    { id: `${s.id}:a`, title: s.a.title, group: s.title, graph: s.a.graph },
    { id: `${s.id}:b`, title: s.b.title, group: s.title, graph: s.b.graph },
  ]),
];

export const templateGroups = () => [...new Set(TEMPLATES.map((t) => t.group))];
