import { PRIMER_CREDIT, type Lesson } from './types';
import { graph, link, X } from '../scenarios/build';

/**
 * CAP, live. A network partition cuts the primary off from its replica; then the primary's region
 * dies. Asynchronous replication keeps writes working and loses the ones the replica never got;
 * synchronous replication loses nothing and stops writes while the partition lasts. A third
 * location, on the primary's side, gets both — which is why quorums come in threes.
 * After The System Design Primer's CAP and replication sections (Donne Martin, CC BY 4.0).
 */
const initial = link(
  graph(
    [
      ['users', 'client', X[0], 330],
      ['lb', 'lb', X[1], 330],
      ['api', 'server', X[2], 330, { instances: 4 }],
      ['db', 'db', X[3] + 40, 110, { name: 'primary', failoverS: 3 }],
      ['rep', 'replica', X[3] + 40, 560, { name: 'replica' }],
    ],
    [['users', 'lb'], ['lb', 'api'], ['api', 'db'], ['db', 'rep']],
    [
      ['east', 'us-east (primary)', X[3], 40, 330, 210],
      ['west', 'us-west', X[3], 490, 330, 210],
      ['central', 'us-central', X[4] + 40, 265, 330, 210],
    ],
  ),
  'db',
  'rep',
  { latencyMs: 70 },
);

export const cap: Lesson = {
  id: 'cap',
  title: 'CAP, Live',
  subtitle: 'When the network splits, you lose writes or you lose availability. Unless you have three.',
  credit: PRIMER_CREDIT,
  stars: { three: 3.6, two: 4.5 },
  readRatio: 0.8,
  outro: 'You saw both sides of CAP — writes lost, then writes refused — and ended with a quorum that keeps writing and loses nothing.',
  initial,
  steps: [
    {
      id: 'two-regions',
      title: 'Two regions',
      story:
        'The primary database runs in us-east; a replica in us-west, 70 ms away, receives every write a moment later (asynchronous replication). ' +
        'Reads can be served by either. 400 requests a second, one in five a write.',
      objective: 'Serve 400 req/s with <1% errors and p99 < 300ms for 5s.',
      traffic: { from: 200, to: 400, rampSeconds: 3 },
      goal: { maxErrorRate: 0.01, maxP99: 300, holdSeconds: 5 },
      takeaway: 'Asynchronous replication costs writes nothing: the primary answers at once and the replica catches up a link-delay later.',
    },
    {
      id: 'split',
      title: 'The network splits, then us-east goes dark',
      story:
        'At 3 s the link between the regions fails: both keep running, but the replica stops receiving writes. ' +
        'At 12 s us-east loses power. The replica is promoted 3 s later (a lesson-speed failover; managed databases take 30–120 s) — with everything it never received missing. Finance says: never lose an acknowledged write.',
      objective: 'Lose no acknowledged writes. Up to 25% errors are tolerated while it happens.',
      traffic: { from: 400, to: 400, rampSeconds: 0 },
      goal: { maxErrorRate: 0.25, maxP99: 1500, maxLostWrites: 0, holdSeconds: 25, startAfter: 2, deadline: 31 },
      chaos: [
        { at: 3, action: { type: 'partition', a: 'east', b: 'west' }, message: 'The link between us-east and us-west is down' },
        { at: 12, action: { type: 'fail-zone', id: 'east' }, message: 'us-east lost power' },
      ],
      hintAfter: 8,
      hint: 'Select the primary → replica link and make it synchronous: a write is only acknowledged once the replica has it.',
      solution: { note: 'Synchronous replication', changes: [{ op: 'connect', from: 'db', to: 'rep', latencyMs: 70, replication: 'sync' }] },
      takeaway:
        'Synchronous replication lost nothing — and for the nine seconds the regions could not talk, every write was refused. That is the choice CAP names: during a partition, consistency or availability.',
    },
    {
      id: 'quorum',
      title: 'Both, with a third',
      story:
        'Same night again. Product says refusing writes for nine seconds is an outage too: keep the failed share of requests over the whole incident under 3.5% — and still lose nothing.',
      objective: 'Lose no writes and keep the incident’s total error rate under 3.5%.',
      traffic: { from: 400, to: 400, rampSeconds: 0 },
      goal: { maxErrorRate: 0.25, maxP99: 1500, maxLostWrites: 0, maxTotalErrorRate: 0.035, holdSeconds: 25, startAfter: 2, deadline: 31 },
      chaos: [
        { at: 3, action: { type: 'partition', a: 'east', b: 'west' }, message: 'The link between us-east and us-west is down' },
        { at: 12, action: { type: 'fail-zone', id: 'east' }, message: 'us-east lost power' },
      ],
      hintAfter: 8,
      hint:
        'Add a replica in us-central, replicated synchronously, and make us-west asynchronous again. Writes wait only for us-central, which the partition does not cut off; when us-east dies, the up-to-date replica is promoted.',
      solution: {
        note: 'A synchronous replica in a third region, the far one asynchronous',
        changes: [
          { op: 'add', component: { id: 'rep2', kind: 'replica', name: 'replica (central)' }, zone: 'central' },
          { op: 'connect', from: 'db', to: 'rep2', latencyMs: 15, replication: 'sync' },
          { op: 'connect', from: 'db', to: 'rep', latencyMs: 70, replication: 'async' },
        ],
      },
      takeaway:
        'Writes waited for one nearby copy, not every copy: the partition cut off the far replica and nobody noticed, and the failover promoted the copy that had every write. Majority quorums (2 of 3) are this idea, generalised.',
    },
  ],
};
