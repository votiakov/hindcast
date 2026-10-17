import type { Lesson } from './types';
import { graph, X } from '../scenarios/build';

/**
 * Failure domains: a whole availability zone goes dark. Everything in one zone fails together,
 * however many instances it has; surviving it takes capacity and data in a second zone.
 */
export const zones: Lesson = {
  id: 'zones',
  title: 'Zones: When a Whole Data Center Goes Dark',
  subtitle: 'Failure domains, a second zone, and a database that fails over.',
  stars: { three: 2.6, two: 3.2 },
  readRatio: 0.8,
  outro: 'You lost an availability zone and your users barely noticed: capacity and data were already waiting in the other one.',
  initial: graph(
    [
      ['users', 'client', X[0], 260],
      ['lb', 'lb', X[1], 260],
      ['api', 'server', X[2] + 10, 130, { instances: 6 }],
      ['db', 'db', X[3] + 20, 150, { failoverS: 3 }],
    ],
    [['users', 'lb'], ['lb', 'api'], ['api', 'db']],
    [
      ['zone-a', 'us-east-1a', X[2] - 20, 70, 620, 340],
      ['zone-b', 'us-east-1b', X[2] - 20, 440, 620, 340],
    ],
  ),
  steps: [
    {
      id: 'one-zone',
      title: 'Six instances, one zone',
      story:
        'The API runs six instances — plenty of redundancy, you were told. They all live in us-east-1a, next to the database. ' +
        'us-east-1b is empty.',
      objective: 'Serve 700 req/s with <1% errors and p99 < 300ms for 5s.',
      traffic: { from: 300, to: 700, rampSeconds: 3 },
      goal: { maxErrorRate: 0.01, maxP99: 300, holdSeconds: 5 },
      takeaway: 'Six instances survive any one of them dying. They are still one failure domain: a power, network or control-plane fault in the zone takes all six at once.',
    },
    {
      id: 'dark',
      title: 'us-east-1a goes dark',
      story:
        'At t = 5 s the whole zone fails: every component in it, at once. It happens to every cloud a few times a year. ' +
        'Some errors while traffic moves are unavoidable — but the product has to be back within ten seconds and stay up.',
      objective: 'Back within SLO (<1% errors, p99 < 300ms) by t = 15s and hold it to t = 30s.',
      traffic: { from: 700, to: 700, rampSeconds: 0 },
      goal: { maxErrorRate: 0.01, maxP99: 300, holdSeconds: 15, startAfter: 15, deadline: 30.5 },
      chaos: [{ at: 5, action: { type: 'fail-zone', id: 'zone-a' }, message: 'us-east-1a is down: every component in it' }],
      hintAfter: 6,
      ask: 'If everything in us-east-1a disappears, what is left to serve requests, and where does the data live?',
      hint:
        'Put capacity in us-east-1b: drag an API Server into the lower frame, connect lb → it and it → db, and give it enough instances to carry all the traffic alone. ' +
        'Then the data: connect a Read Replica from db and drag it into us-east-1b — when the primary dies, the replica is promoted (after 3 s here, to keep the lesson short; managed databases take 30–120 s).',
      solution: {
        note: 'An API pool and a database replica in us-east-1b',
        changes: [
          { op: 'add', component: { id: 'api-b', kind: 'server', instances: 6 }, zone: 'zone-b' },
          { op: 'connect', from: 'lb', to: 'api-b' },
          { op: 'connect', from: 'api-b', to: 'db' },
          { op: 'add', component: { id: 'replica-b', kind: 'replica' }, zone: 'zone-b' },
          { op: 'connect', from: 'db', to: 'replica-b' },
        ],
      },
      takeaway: 'Redundancy counts in failure domains, not instances: a second zone with enough capacity to carry everything alone, and data that can take over (a promoted replica). The failover is the outage you design for: 3 s in this lesson, 30–120 s on a managed database, writes failing all the while.',
    },
    {
      id: 'half',
      title: 'Paying for two of everything',
      story:
        'It worked — and finance noticed the bill doubled. Two zones with twelve instances is twice what a normal day needs. ' +
        'Can you keep surviving a zone failure for less?',
      objective: 'Survive the same zone failure on an average bill ≤ $1.85/h: back within SLO by 15s, hold to 30s.',
      traffic: { from: 700, to: 700, rampSeconds: 0 },
      goal: { maxErrorRate: 0.01, maxP99: 300, maxAvgCost: 1.85, holdSeconds: 15, startAfter: 15, deadline: 30.5 },
      chaos: [{ at: 5, action: { type: 'fail-zone', id: 'zone-a' }, message: 'us-east-1a is down: every component in it' }],
      hintAfter: 8,
      ask: 'Before the failure, how busy is each zone’s pool? Which one needs full capacity, and when?',
      hint:
        'Only the survivor needs full capacity, and only after the failure. Keep a smaller pool in each zone and let them autoscale: ' +
        'select api and api-b → autoscale (min 4, max 8, a short warm-up) so the survivor grows when its twin disappears. Too small a minimum and the survivor drowns before new instances boot.',
      solution: {
        note: 'Smaller pools in each zone that autoscale when the other one fails',
        changes: [
          { op: 'set', id: 'api', fields: { instances: 4, autoscale: { min: 4, max: 8, warmupS: 5 } } },
          { op: 'set', id: 'api-b', fields: { instances: 4, autoscale: { min: 4, max: 8, warmupS: 5 } } },
        ],
      },
      takeaway: 'You don’t need two of everything running all day: you need the survivor to grow fast enough. Smaller pools that autoscale with a short warm-up survive the zone for much less than a full standby.',
    },
  ],
};
