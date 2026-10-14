import type { Lesson } from './types';
import { graph, X } from '../scenarios/build';

/**
 * Scale 201: from a few thousand to 40,000 req/s at 99% reads — the later stages of scaling a web
 * service: the edge takes the static reads, the fleet and the database are sized for what is left,
 * and the fleet follows the day instead of being sized for its peak.
 * Stages after The System Design Primer's "scaling to 10M users" (Donne Martin, CC BY 4.0).
 */
export const scale201: Lesson = {
  id: 'scale-201',
  title: 'Scale 201: To 40,000 req/s',
  subtitle: 'The edge, the write path, and the off-peak bill.',
  stars: { three: 3.6, two: 4.5 },
  readRatio: 0.99,
  outro: 'You moved the reads to the edge, sized the origin for what reaches it, and stopped paying for the peak at 4 a.m.',
  initial: graph(
    [
      ['users', 'client', X[0], 200],
      ['lb', 'lb', X[1], 200],
      ['api', 'server', X[2], 150, { instances: 8 }],
      ['cache', 'cache', X[3], 120],
      ['db', 'db', X[4], 200],
    ],
    [['users', 'lb'], ['lb', 'api'], ['api', 'cache'], ['cache', 'db']],
  ),
  steps: [
    {
      id: 'today',
      title: 'Where Scale 101 left off',
      story: 'A load balancer, eight API instances, a cache in front of the database. 1,500 req/s, 99% of them reads. All green.',
      objective: 'Serve 1,500 req/s with <1% errors and p99 < 300ms for 5s.',
      traffic: { from: 800, to: 1500, rampSeconds: 3 },
      goal: { maxErrorRate: 0.01, maxP99: 300, holdSeconds: 5 },
      takeaway: 'A cache in front of the database and a fleet behind a balancer carry a read-heavy service a long way.',
    },
    {
      id: 'static',
      title: 'Images, scripts, styles',
      story:
        'The new design ships with images and big bundles. Page views bring 10,000 req/s, and most of it is the same static bytes for everyone. ' +
        'Every one of them is going through your load balancer and your API.',
      objective: 'Serve 10,000 req/s with <1% errors and p99 < 300ms for 10s.',
      traffic: { from: 1500, to: 10000, rampSeconds: 6 },
      goal: { maxErrorRate: 0.01, maxP99: 300, holdSeconds: 10 },
      hintAfter: 8,
      hint: 'Put a CDN in front of the load balancer (users → CDN → lb). It answers the static reads at the edge; only misses and writes reach your origin.',
      solution: {
        note: 'A CDN in front of the load balancer',
        changes: [
          { op: 'add', component: { id: 'cdn', kind: 'cdn', hitRate: 0.9 } },
          { op: 'disconnect', from: 'users', to: 'lb' },
          { op: 'connect', from: 'users', to: 'cdn' },
          { op: 'connect', from: 'cdn', to: 'lb' },
        ],
      },
      takeaway: 'The cheapest request is the one that never reaches you: a $0.08/h CDN took nine in ten requests off the origin.',
    },
    {
      id: 'forty',
      title: '40,000 req/s',
      story:
        'A year later: 40,000 req/s. The CDN still takes nine reads in ten, but one in a hundred requests is a write, and every write and every miss lands on the origin — ' +
        'about 4,400 req/s for the API, and the database behind the cache gets every write plus the cache’s misses.',
      objective: 'Serve 40,000 req/s with <1% errors and p99 < 300ms for 10s.',
      traffic: { from: 10000, to: 40000, rampSeconds: 8 },
      goal: { maxErrorRate: 0.01, maxP99: 300, holdSeconds: 10 },
      hintAfter: 8,
      hint: 'Count what reaches each part: ~4,400 req/s for the API (18–20 instances), and for the database the writes plus cache misses — a size up gives it the room.',
      solution: {
        note: 'The fleet and the database sized for what gets past the edge',
        changes: [
          { op: 'set', id: 'api', fields: { instances: 20 } },
          { op: 'set', id: 'db', fields: { tier: 'M' } },
        ],
      },
      takeaway: 'Size each tier for what reaches it, not for the headline number: 40,000 at the edge became 4,400 at the API and a few hundred at the database.',
    },
    {
      id: 'night',
      title: 'The off-peak bill',
      story:
        'Traffic follows the day: the 40,000 peak lasts an hour, and most of the time it is a quarter of that. ' +
        'Twenty API instances cost the same at 4 a.m. as at noon. Finance wants the average bill under $2.90/h.',
      objective: 'Ride a day (40,000 → 10,000 req/s) within SLO, averaging under $2.90/h.',
      traffic: { keyframes: [{ at: 0, rps: 40000 }, { at: 6, rps: 40000 }, { at: 12, rps: 10000 }, { at: 60, rps: 10000 }] },
      goal: { maxErrorRate: 0.01, maxP99: 300, maxAvgCost: 2.9, holdSeconds: 50 },
      hintAfter: 10,
      hint: 'Autoscale the API (min 5, max 24, target 60%, short cooldown): it gives instances back when the peak is over.',
      solution: {
        note: 'An autoscaled API fleet',
        changes: [{ op: 'set', id: 'api', fields: { autoscale: { min: 5, max: 24, targetUtil: 0.6, warmupS: 10, cooldownS: 10 } } }],
      },
      takeaway: 'A fleet sized for the peak pays for the peak all day. Autoscaling follows the traffic, and the average bill follows it down.',
    },
  ],
};
