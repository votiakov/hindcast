import { PRIMER_CREDIT, type Lesson } from './types';
import { graph, X } from '../scenarios/build';

/**
 * Event streams: one order, several services that each need it. A stream gives every subscriber every
 * message, at its own pace — and its partitions are the ceiling on how many consumers any one of them
 * can run. Adding instances past that does nothing.
 * After The System Design Primer's asynchronism section (Donne Martin, CC BY 4.0).
 */
export const events: Lesson = {
  id: 'events',
  title: 'Event Streams: Partitions Are Parallelism',
  subtitle: 'Every subscriber reads every order. How fast is up to the partitions.',
  credit: PRIMER_CREDIT,
  stars: { three: 3.2, two: 3.8 },
  readRatio: 0,
  outro: 'Every order reached both services, at their own pace, and Black Friday drained in seconds once the stream had the partitions to spread it.',
  initial: graph(
    [
      ['users', 'client', X[0], 240, { name: 'checkout' }],
      ['lb', 'lb', X[1], 240],
      ['api', 'server', X[2], 240, { instances: 4, name: 'orders api' }],
      ['orders', 'stream', X[3], 240, { partitions: 2, name: 'orders' }],
      ['email', 'worker', X[4], 100, { instances: 2, name: 'email' }],
      ['analytics', 'worker', X[4], 380, { instances: 2, name: 'analytics' }],
    ],
    [['users', 'lb'], ['lb', 'api'], ['api', 'orders'], ['orders', 'email'], ['orders', 'analytics']],
  ),
  steps: [
    {
      id: 'publish',
      title: 'One order, two services',
      story:
        'Every order is published once to the orders stream. Email sends the receipt; analytics counts the sale. Both need every order — a queue would hand each order to one of them. ' +
        '120 orders a second; each service runs two workers.',
      objective: 'Take 120 orders/s with <1% errors, both services under 10 s behind.',
      traffic: { from: 60, to: 120, rampSeconds: 3 },
      goal: { maxErrorRate: 0.01, maxP99: 500, maxLagS: 10, holdSeconds: 8 },
      takeaway: 'A stream is a log, not a work list: every subscriber reads all of it, each at its own pace, and the producer is answered as soon as the stream has the order.',
    },
    {
      id: 'black-friday',
      title: 'Black Friday',
      story:
        '600 orders a second. Checkout is fine — the stream takes them — but receipts and analytics fall further behind every second. ' +
        'Adding workers seems the obvious fix. Try it, and watch how much they drain.',
      objective: 'Take 600 orders/s with both services under 10 s behind.',
      traffic: { from: 120, to: 600, rampSeconds: 5 },
      goal: { maxErrorRate: 0.01, maxP99: 500, maxLagS: 10, holdSeconds: 10 },
      hintAfter: 10,
      ask: 'Add workers and watch: does every one of them get work? How many consumers can one partition feed?',
      hint: 'A subscriber runs at most one consumer per partition: with 2 partitions, the 3rd worker onwards sits idle. Give the stream 8 partitions, and each service 8 workers.',
      solution: {
        note: 'Eight partitions, eight workers per service',
        changes: [
          { op: 'set', id: 'orders', fields: { partitions: 8 } },
          { op: 'set', id: 'email', fields: { instances: 8 } },
          { op: 'set', id: 'analytics', fields: { instances: 8 } },
        ],
      },
      takeaway: 'Partitions are the unit of parallelism: a subscriber cannot run more consumers than the stream has partitions. Choose them for the peak you will need to drain, not for the average.',
    },
  ],
};
