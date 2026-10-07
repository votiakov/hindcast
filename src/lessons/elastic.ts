import type { Lesson } from './types';
import { graph, X } from '../scenarios/build';

/**
 * Cost vs reliability in an elastic system: right-sizing, autoscaling and its warm-up gap,
 * and the cold-cache stampede that hits the database after a cache restart.
 */
export const elastic: Lesson = {
  id: 'elastic',
  title: 'Elastic: Paying for Peak vs Surviving It',
  subtitle: 'Right-size, autoscale, and find out what a cold cache does to your database.',
  stars: { three: 1.9, two: 2.4 },
  readRatio: 0.85,
  outro: 'You stopped paying for peak all day, let the fleet follow demand, and sized the database for the day the cache restarts.',
  initial: graph(
    [
      ['users', 'client', X[0], 200],
      ['lb', 'lb', X[1], 200],
      ['api', 'server', X[2], 150, { instances: 10 }],
      ['redis', 'cache', X[3], 200, { hitRate: 0.9, warmupS: 20 }],
      ['db', 'db', X[4], 200],
    ],
    [['users', 'lb'], ['lb', 'api'], ['api', 'redis'], ['redis', 'db']],
  ),
  steps: [
    {
      id: 'right-size',
      title: 'Paying for peak, all day',
      story:
        'The API fleet was sized for last Black Friday: 10 instances. Today it serves 300 req/s and sits at 12% CPU. ' +
        'Finance noticed. Open the cost lens (click the metrics at the top) to see where the money goes.',
      objective: 'Cut the bill to ≤ $1.05/h and keep the SLO (<1% errors, p99 < 300ms) for 6s.',
      traffic: { from: 300, to: 300, rampSeconds: 0 },
      goal: { maxErrorRate: 0.01, maxP99: 300, maxCost: 1.05, holdSeconds: 6, startAfter: 2 },
      hintAfter: 8,
      hint: 'Select api and remove instances with − until the cost fits. Two instances already serve 300 req/s at 60% — the rest is idle money.',
    },
    {
      id: 'rush',
      title: 'The lunch rush',
      story:
        'At noon, traffic climbs 5× in a few seconds and stays there for a while. A fixed small fleet will melt; a fixed big fleet is what you just got rid of. ' +
        'Autoscaling adds instances when CPU passes a target — but new instances need time to boot before they serve.',
      objective: 'Be back within SLO within 20s of the rush (t = 30s) and stay there for 10s.',
      traffic: { keyframes: [{ at: 0, rps: 300 }, { at: 5, rps: 300 }, { at: 10, rps: 1500 }, { at: 80, rps: 1500 }] },
      goal: { maxErrorRate: 0.01, maxP99: 300, holdSeconds: 10, startAfter: 30 },
      hintAfter: 10,
      hint:
        'Select api → autoscale, max 12. Watch the booting instances (dashed): with a 30 s warm-up you eat 30 s of errors at the start of every rush. ' +
        'Pick a shorter warm-up (a Kubernetes pod on an existing node: 5–15 s) or keep a higher minimum to absorb the first seconds.',
    },
    {
      id: 'stampede',
      title: 'The cache restarts',
      story:
        'Redis gets restarted for a security patch at peak. It comes back empty — every request is a miss until it refills. ' +
        'The database normally sees 10% of the traffic. For the next few seconds it sees all of it.',
      objective: 'Ride out the restart: <1% errors and p99 < 500ms for 25s.',
      traffic: { from: 1500, to: 1500, rampSeconds: 0 },
      goal: { maxErrorRate: 0.01, maxP99: 500, holdSeconds: 25, startAfter: 2 },
      chaos: [{ at: 4, action: { type: 'flush-cache', id: 'redis' }, message: 'redis restarted — the cache is empty' }],
      hintAfter: 8,
      hint:
        'The database must survive the misses of a cold cache, not just the hits of a warm one. Size db up to M (2k req/s) — or add a read replica — ' +
        'then use Reset to replay the restart. Run the failure audit (shield icon in Sandbox) to find this class of problem before production does.',
    },
  ],
};
