import { PRIMER_CREDIT, type Lesson } from './types';
import { graph, X } from '../scenarios/build';

/**
 * Shard the database: a bigger box carries you to the biggest box, and then writes have nowhere to
 * go but apart — each shard holds part of the keys. Then one key gets famous, and the shard that
 * holds it saturates while the rest idle: more shards cannot split one key.
 * After The System Design Primer's sharding section (Donne Martin, CC BY 4.0).
 */
export const sharding: Lesson = {
  id: 'sharding',
  title: 'Shard the Database',
  subtitle: 'Past the biggest box, data has to split. Then one key gets famous.',
  credit: PRIMER_CREDIT,
  stars: { three: 11.5, two: 13 },
  readRatio: 0.5,
  outro: 'You scaled the database up until there was no bigger box, then out across shards — and kept a famous key from taking down the shard that holds it.',
  initial: graph(
    [
      ['users', 'client', X[0], 200],
      ['lb', 'lb', X[1], 200],
      ['api', 'server', X[2], 200, { instances: 48 }],
      ['db', 'db', X[3] + 40, 200, { tier: 'M', name: 'posts db' }],
    ],
    [['users', 'lb'], ['lb', 'api'], ['api', 'db']],
  ),
  steps: [
    {
      id: 'one',
      title: 'One database',
      story: 'A social app: people post, like and read. Half the requests write. One size-M database takes all of it — 1,500 req/s.',
      objective: 'Serve 1,500 req/s with <1% errors and p99 < 300ms for 5s.',
      traffic: { from: 800, to: 1500, rampSeconds: 3 },
      goal: { maxErrorRate: 0.01, maxP99: 300, holdSeconds: 5 },
      takeaway: 'One database is the simplest thing that works: every row in one place, every query can join anything.',
    },
    {
      id: 'up',
      title: 'A bigger box',
      story: 'The app doubles. 3,500 req/s is past what a size-M database does.',
      objective: 'Serve 3,500 req/s with <1% errors and p99 < 300ms for 8s.',
      traffic: { from: 1500, to: 3500, rampSeconds: 4 },
      goal: { maxErrorRate: 0.01, maxP99: 300, holdSeconds: 8 },
      hintAfter: 8,
      hint: 'Scale up first: size the database to L (×4 the capacity of S). Nothing else changes.',
      solution: { note: 'A size-L database', changes: [{ op: 'set', id: 'db', fields: { tier: 'L' } }] },
      takeaway: 'Scaling up is the cheapest change in effort: same database, bigger machine. It also has a ceiling.',
    },
    {
      id: 'out',
      title: 'Past the biggest box',
      story:
        '9,000 req/s, half of them writes. L is the largest size there is. A read replica would take reads, but 4,500 writes a second still land on one primary — more than any one box takes.',
      objective: 'Serve 9,000 req/s with <1% errors and p99 < 300ms for 10s.',
      traffic: { from: 3500, to: 9000, rampSeconds: 6 },
      goal: { maxErrorRate: 0.01, maxP99: 300, holdSeconds: 10 },
      hintAfter: 8,
      hint: 'Shard it: split the posts by user id across 3 databases (select the database → shards 3). Each holds a third of the users, and takes a third of the writes.',
      solution: { note: 'Three shards', changes: [{ op: 'set', id: 'db', fields: { shards: 3 } }] },
      takeaway: 'Sharding splits the data, so it splits the writes — the one thing replicas and caches cannot do. The price: a query across users now asks every shard.',
    },
    {
      id: 'famous',
      title: 'Someone gets famous',
      story:
        'At 4 s a post goes viral: 30% of all traffic is about one post, and one post lives on one shard. That shard takes over half the load; the other two idle. ' +
        'Finance caps the bill at $12/h.',
      objective: 'Ride out the viral post at 9,000 req/s, under $12/h.',
      traffic: { from: 9000, to: 9000, rampSeconds: 0 },
      goal: { maxErrorRate: 0.01, maxP99: 300, maxCost: 12, holdSeconds: 10, startAfter: 5 },
      chaos: [{ at: 4, action: { type: 'hot-key', id: 'db', share: 0.3 }, message: 'A post went viral: 30% of traffic on one key' }],
      hintAfter: 8,
      hint: 'More shards cannot split one post — and each costs a size-L database. Put a cache in front of the database (api → cache → db): the viral post is read far more than written, and a cache answers it from memory.',
      solution: {
        note: 'A cache in front of the shards',
        changes: [
          { op: 'add', component: { id: 'cache', kind: 'cache' } },
          { op: 'disconnect', from: 'api', to: 'db' },
          { op: 'connect', from: 'api', to: 'cache' },
          { op: 'connect', from: 'cache', to: 'db' },
        ],
      },
      takeaway: 'A hot key is one key on one shard: re-sharding moves it, it does not split it. Cache it, or give that key a home of its own.',
    },
  ],
};
