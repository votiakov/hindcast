import type { Lesson } from './types';
import { graph, X } from '../scenarios/build';

/**
 * Metastable failures: a short spike plus naive client retries keeps the system down long
 * after the spike is gone. Fixes: retry budgets, short (bounded) queues, circuit breakers,
 * load shedding at the edge. Then a database brownout to motivate breakers with fallbacks.
 */
export const retryStorm: Lesson = {
  id: 'retry-storm',
  title: 'Retry Storms: When the Fix Becomes the Outage',
  subtitle: 'Why systems stay down after the trigger is gone — and how seniors prevent it.',
  stars: { three: 2.6, two: 3.2 },
  readRatio: 0.8,
  outro: 'You turned a self-sustaining retry storm into a blip and kept serving through a database brownout.',
  initial: graph(
    [
      ['users', 'client', X[0], 200, { retries: 3, retryPolicy: 'immediate', timeoutMs: 1000 }],
      ['lb', 'lb', X[1], 200],
      ['api', 'server', X[2], 150, { instances: 4, queueS: 3 }],
      ['db', 'db', X[3], 200, { tier: 'L' }],
    ],
    [['users', 'lb'], ['lb', 'api'], ['api', 'db']],
  ),
  steps: [
    {
      id: 'calm',
      title: 'A normal Tuesday',
      story:
        'Clients retry failed calls up to 3 times, immediately, and give up after 1 second — sensible defaults you will find in most HTTP libraries. ' +
        'The API has 4 instances and a generous 3-second request queue. Everything is green.',
      objective: 'Serve 700 req/s with <1% errors and p99 < 500ms for 5s.',
      traffic: { from: 400, to: 700, rampSeconds: 3 },
      goal: { maxErrorRate: 0.01, maxP99: 500, holdSeconds: 5 },
    },
    {
      id: 'blip',
      title: 'The six-second blip',
      story:
        'A marketing push sends a 6-second burst of 1,600 req/s. Then traffic goes straight back to normal. ' +
        'Watch what happens after the burst — does the system recover on its own?',
      objective: 'Be back within SLO (<1% errors, p99 < 500ms) for 10s after the burst.',
      traffic: { keyframes: [{ at: 0, rps: 700 }, { at: 3, rps: 700 }, { at: 4, rps: 1600 }, { at: 9, rps: 1600 }, { at: 10, rps: 700 }] },
      goal: { maxErrorRate: 0.01, maxP99: 500, holdSeconds: 10, startAfter: 12 },
      hintAfter: 6,
      hint:
        'This is a metastable failure. The 3-second queue fills with requests whose clients already gave up after 1s, so every response is "late"; ' +
        'clients retry 3×, quadrupling the load, which keeps the queue full forever. Break the loop: select Users and switch retries to "retry budget 10%" ' +
        '(or turn on the breaker), and/or select api and shorten its queue to 0.25–0.5s so it sheds load instead of hoarding stale work.',
    },
    {
      id: 'brownout',
      title: 'Database brownout',
      story:
        'Your managed database is degraded: it runs at 5% of its capacity and won\'t be fixed for a while. ' +
        'You can\'t fix the database. Can you keep the product usable anyway?',
      objective: 'Keep errors under 5% for 20s while the database is degraded.',
      traffic: { from: 700, to: 700, rampSeconds: 0 },
      goal: { maxErrorRate: 0.05, maxP99: 2000, holdSeconds: 20, startAfter: 6 },
      chaos: [{ at: 3, action: { type: 'degrade', id: 'db', factor: 0.05 }, message: 'Database degraded to 5% capacity' }],
      hintAfter: 8,
      hint:
        'Try api → breaker + fallback first and watch it flap: open (fallback served) → probe → close → database overloaded again → open. ' +
        'Breakers buy time and protect, but they add no capacity. The fix that holds: put a Cache between api and db (api → cache → db) so most reads never touch the struggling database.',
    },
  ],
};
