import { PRIMER_CREDIT, type Lesson } from './types';
import { graph, X } from '../scenarios/build';

/**
 * Design Mint.com: a write-heavy system. Banks push transactions all day (about 2,000 a second, ten
 * writes for every read), and every read-heavy instinct — cache it, add replicas — buys nothing.
 * Problem inspired by The System Design Primer (Donne Martin, CC BY 4.0).
 */
export const mint: Lesson = {
  id: 'mint',
  title: 'Design Mint: Ten Writes for Every Read',
  subtitle: 'When the cache saves nothing, what does?',
  credit: PRIMER_CREDIT,
  stars: { three: 8, two: 10 },
  readRatio: 0.1,
  outro: 'You sized for writes, not reads, and turned the midnight bank sync into a backlog the workers clear instead of an outage.',
  initial: graph(
    [
      ['users', 'client', X[0], 200, { name: 'banks + users' }],
      ['lb', 'lb', X[1], 200],
      ['api', 'server', X[2], 200, { instances: 3, name: 'ingest api' }],
      ['db', 'db', X[3], 200, { name: 'transactions' }],
    ],
    [['users', 'lb'], ['lb', 'api'], ['api', 'db']],
  ),
  steps: [
    {
      id: 'ingest',
      title: 'Transactions arrive',
      story:
        'Banks push new transactions as they settle; users occasionally open the app to look. ' +
        'At 600 req/s, nine in ten of them are writes.',
      objective: 'Ingest 600 req/s (90% writes) with <1% errors and p99 < 300ms for 5s.',
      traffic: { from: 300, to: 600, rampSeconds: 3 },
      goal: { maxErrorRate: 0.01, maxP99: 300, holdSeconds: 5 },
      takeaway: 'Look at the mix before the volume: here 90% of requests change data. Every one of them has to reach the database.',
    },
    {
      id: 'month-end',
      title: 'Month-end',
      story:
        'Month-end: statements close and banks resend the month. 2,000 transactions a second. ' +
        'The database is the bottleneck — and a cache in front of it would answer almost nothing here: only reads can hit, and nine in ten requests are writes.',
      objective: 'Ingest 2,000 req/s with <1% errors and p99 < 300ms for 10s.',
      traffic: { from: 600, to: 2000, rampSeconds: 6 },
      goal: { maxErrorRate: 0.01, maxP99: 300, holdSeconds: 10 },
      hintAfter: 8,
      hint:
        'Try a Cache between the API and the database first, and watch the database stay red: writes go straight through it. ' +
        'What helps is capacity for writes: a larger database (size L) and enough API instances for 2,000 req/s.',
      solution: {
        note: 'A database sized for writes, and API instances for the volume',
        changes: [
          { op: 'set', id: 'db', fields: { tier: 'L' } },
          { op: 'set', id: 'api', fields: { instances: 10 } },
        ],
      },
      takeaway: 'Caches and read replicas scale reads. A write-heavy system scales by giving writes somewhere to go: a bigger primary, then shards, then queues.',
    },
    {
      id: 'midnight',
      title: 'The midnight sync',
      story:
        'At midnight every bank sends its daily batch at once: 8,000 transactions a second for twenty seconds. ' +
        'Nobody is waiting on these — they only need to be stored by morning. But right now they fail, and the banks retry tomorrow.',
      objective: 'Accept the burst with <1% errors, and have the backlog cleared to under 60s by the end.',
      traffic: { keyframes: [{ at: 0, rps: 1500 }, { at: 3, rps: 1500 }, { at: 4, rps: 8000 }, { at: 24, rps: 8000 }, { at: 25, rps: 1500 }] },
      goal: { maxErrorRate: 0.01, maxP99: 1000, maxLagS: 60, holdSeconds: 22, startAfter: 3, deadline: 40 },
      hintAfter: 8,
      hint:
        'Accept now, write later: put a Queue between the API and a pool of Workers that write to the database (ingest api → queue → workers → transactions). ' +
        'The API answers as soon as the batch is queued; the workers drain it at the pace the database can take.',
      solution: {
        note: 'A queue absorbs the batch; workers write it at the database’s pace',
        changes: [
          { op: 'add', component: { id: 'queue', kind: 'queue' } },
          { op: 'add', component: { id: 'writers', kind: 'worker', instances: 12, tier: 'M' } },
          { op: 'disconnect', from: 'api', to: 'db' },
          { op: 'connect', from: 'api', to: 'queue' },
          { op: 'connect', from: 'queue', to: 'writers' },
          { op: 'connect', from: 'writers', to: 'db' },
          { op: 'set', id: 'api', fields: { instances: 36 } },
        ],
      },
      takeaway: 'Work nobody waits for should not be done while they wait. A queue turns a burst into a backlog; the workers decide the pace, and the database only ever sees what it can take.',
    },
  ],
};
