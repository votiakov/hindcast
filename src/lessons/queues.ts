import type { Lesson } from './types';
import { graph, X } from '../scenarios/build';

/**
 * Queues: slow work done synchronously turns a spike into user errors; a queue turns it into a
 * backlog; a backlog that only grows is an outage that hasn't reached users yet.
 */
export const queues: Lesson = {
  id: 'queues',
  title: 'Queues: Turn a Spike into a Backlog',
  subtitle: 'Synchronous vs asynchronous work, and the backlog that never drains.',
  stars: { three: 0.75, two: 1 },
  readRatio: 0.8,
  outro: 'Your users stopped waiting on thumbnails, and the workers keep up with the day instead of falling behind it.',
  initial: graph(
    [
      ['users', 'client', X[0], 200],
      ['lb', 'lb', X[1], 200],
      ['api', 'server', X[2], 160, { instances: 2 }],
      ['thumbs', 'worker', X[3], 200, { name: 'thumbnails' }],
    ],
    [['users', 'lb'], ['lb', 'api'], ['api', 'thumbs']],
  ),
  steps: [
    {
      id: 'sync',
      title: 'Thumbnails, while you wait',
      story:
        'Every photo upload calls the thumbnail worker and waits for it: about 80 ms of image work per request. ' +
        'At 40 uploads a second nobody notices.',
      objective: 'Serve 40 uploads/s with <1% errors and p99 < 400ms for 5s.',
      traffic: { from: 20, to: 40, rampSeconds: 3 },
      goal: { maxErrorRate: 0.01, maxP99: 400, holdSeconds: 5 },
      takeaway: 'Synchronous work is simple and fine while it is fast and the load is far below the worker’s capacity: 40 jobs/s on a worker that does 100.',
    },
    {
      id: 'spike',
      title: 'The launch email',
      story:
        'Marketing emails a million people about the new albums. For twenty seconds, 300 uploads a second arrive. ' +
        'One thumbnail worker does about 100 a second — and every upload waits for it.',
      objective: 'Keep uploads fast through the spike: <1% errors and p99 < 400ms from 2s to 32s.',
      traffic: { keyframes: [{ at: 0, rps: 40 }, { at: 4, rps: 40 }, { at: 6, rps: 300 }, { at: 24, rps: 300 }, { at: 26, rps: 40 }, { at: 60, rps: 40 }] },
      goal: { maxErrorRate: 0.01, maxP99: 400, holdSeconds: 30, startAfter: 2, deadline: 32.5 },
      hintAfter: 6,
      ask: 'Does the user need the thumbnail before the upload is accepted? Where could the work wait while the spike passes?',
      hint:
        'Users don’t need the thumbnail before the upload succeeds. Put a Queue between api and the worker (api → queue → thumbnails): ' +
        'the API gets an instant acknowledgement and the worker drains the queue at its own pace. Adding workers would also work — at three times the cost, for a spike that lasts twenty seconds.',
      solution: {
        note: 'A queue between the API and the worker',
        changes: [
          { op: 'add', component: { id: 'jobs', kind: 'queue' } },
          { op: 'disconnect', from: 'api', to: 'thumbs' },
          { op: 'connect', from: 'api', to: 'jobs' },
          { op: 'connect', from: 'jobs', to: 'thumbs' },
        ],
      },
      takeaway: 'A queue turns a spike into a backlog instead of errors: users get an instant answer, the work happens a few seconds later, and you pay for the average load, not the peak.',
    },
    {
      id: 'backlog',
      title: 'The backlog that never drains',
      story:
        'The albums are a hit: uploads settle at 180 a second, all day. The queue keeps users happy — but look at it. ' +
        'One worker drains 100 jobs a second; 180 arrive. Thumbnails now show up minutes late, and later every minute.',
      objective: 'At 180 uploads/s, keep the queue’s backlog under 5s of work (and users fast) for 15s.',
      traffic: { from: 40, to: 180, rampSeconds: 5 },
      goal: { maxErrorRate: 0.01, maxP99: 400, maxLagS: 5, holdSeconds: 15, startAfter: 8 },
      hintAfter: 8,
      ask: 'Watch the queue: is the backlog shrinking or growing? Compare the jobs that arrive a second with the jobs done.',
      hint:
        'A queue absorbs bursts; it can’t make up for too little capacity. If jobs arrive faster than they are done, the backlog grows forever. ' +
        'Select thumbnails and add instances until it drains faster than it fills (behind a queue, workers need no load balancer).',
      solution: { note: 'Three thumbnail workers', changes: [{ op: 'set', id: 'thumbs', fields: { instances: 3 } }] },
      takeaway: 'Watch the backlog, not only the errors: a queue that grows is an outage that hasn’t reached users yet. Size consumers for the sustained rate; let the queue take only the bursts.',
    },
  ],
};
