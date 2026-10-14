import type { Lesson } from './types';
import { graph, X } from '../scenarios/build';

/**
 * Design Pastebin. The classic interview numbers (10M users, 10M pastes and 100M reads a month) work
 * out to 4 writes and 40 reads a second: trivial. What decides the design is what the averages hide —
 * the bill, the paste that goes viral, and the database that dies.
 * Problem inspired by The System Design Primer (Donne Martin, CC BY 4.0).
 */
export const pastebin: Lesson = {
  id: 'pastebin',
  title: 'Design Pastebin',
  subtitle: '40 req/s on average. The average is not what takes you down.',
  stars: { three: 1.3, two: 1.8 },
  readRatio: 0.9,
  outro: 'You built for the traffic you have, absorbed a viral paste at the edge, and kept reads serving through a database failure.',
  initial: graph(
    [
      ['users', 'client', X[0], 200],
      ['api', 'server', X[1], 200, { name: 'paste api' }],
      ['db', 'db', X[2], 200, { name: 'pastes' }],
    ],
    [['users', 'api'], ['api', 'db']],
  ),
  steps: [
    {
      id: 'launch',
      title: 'Launch: 40 req/s',
      story:
        '10 million users, 10 million new pastes and 100 million reads a month. Back of the envelope: a month is about 2.5 million seconds, ' +
        'so that is 4 writes and 40 reads a second. One small server and one database do that with room to spare.',
      objective: 'Serve 44 req/s (90% reads) with <1% errors, p99 < 300ms, for under $0.60/h, for 5s.',
      traffic: { from: 20, to: 44, rampSeconds: 3 },
      goal: { maxErrorRate: 0.01, maxP99: 300, maxCost: 0.6, holdSeconds: 5 },
      takeaway: 'Do the arithmetic before the architecture: 100 million reads a month is 40 a second. A fleet, shards and queues would only add a bill.',
    },
    {
      id: 'viral',
      title: 'A paste goes viral',
      story:
        'A leaked config file lands on the front page. For twenty seconds, 3,000 people a second open the same paste — 75 times the average. ' +
        'A paste never changes once written: every one of those reads could be answered without touching your server.',
      objective: 'Ride out 3,000 req/s for 20s: <1% errors, p99 < 300ms.',
      traffic: { keyframes: [{ at: 0, rps: 44 }, { at: 3, rps: 44 }, { at: 5, rps: 3000 }, { at: 25, rps: 3000 }, { at: 27, rps: 44 }] },
      goal: { maxErrorRate: 0.01, maxP99: 300, holdSeconds: 20, startAfter: 5, deadline: 26 },
      hintAfter: 8,
      hint:
        'Put a CDN in front (users → CDN → paste api): pastes are immutable, so the edge can serve almost every read. ' +
        'The misses and the writes still reach the API — give it a load balancer and a few instances for them.',
      solution: {
        note: 'A CDN at the edge, three API instances behind a load balancer for what it misses',
        changes: [
          { op: 'add', component: { id: 'cdn', kind: 'cdn', hitRate: 0.95 } },
          { op: 'add', component: { id: 'lb', kind: 'lb' } },
          { op: 'disconnect', from: 'users', to: 'api' },
          { op: 'connect', from: 'users', to: 'cdn' },
          { op: 'connect', from: 'cdn', to: 'lb' },
          { op: 'connect', from: 'lb', to: 'api' },
          { op: 'set', id: 'api', fields: { instances: 3 } },
        ],
      },
      takeaway: 'Immutable content belongs at the edge: a CDN answered 95% of the reads for $0.08/h. The writes and misses still need a small fleet behind it.',
    },
    {
      id: 'failover',
      title: 'The database dies',
      story:
        'At 3 a.m. the database host fails. Everything the CDN misses — and every new paste — goes to a database that is not there. ' +
        'You cannot stop it from failing. You can decide what happens next.',
      objective: 'Within 10s of the failure be back under 1% errors, and stay there for 10s.',
      traffic: { from: 300, to: 300, rampSeconds: 0 },
      goal: { maxErrorRate: 0.01, maxP99: 400, holdSeconds: 10, startAfter: 5, deadline: 25 },
      chaos: [{ at: 3, action: { type: 'kill-id', id: 'db' }, message: 'The database host failed' }],
      hintAfter: 8,
      hint:
        'Add a Read Replica behind the database (pastes → replica). While the primary is down the replica keeps serving reads; ' +
        'after a few seconds of election it is promoted and takes the writes too.',
      solution: {
        note: 'A read replica, promoted when the primary dies',
        changes: [
          { op: 'add', component: { id: 'replica', kind: 'replica' } },
          { op: 'connect', from: 'db', to: 'replica' },
        ],
      },
      takeaway: 'A replica turns a dead database into a few seconds of failed writes: reads keep working through the election, then the replica takes over. Without one, the outage lasts until someone wakes up.',
    },
  ],
};
