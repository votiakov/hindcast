import type { Lesson } from './types';
import { graph, X } from '../scenarios/build';

/**
 * Timeouts and retries, read off single requests with the tracer: a wait in the database's queue
 * past the users' deadline, immediate retries that go back into the same full queue, and a queue
 * bound longer than anyone waits, so the database works on requests nobody is waiting for. The
 * engines do not pass deadlines down with calls, so the last fix is a bound that fits inside the
 * caller's timeout.
 */
export const deadlines: Lesson = {
  id: 'deadlines',
  title: 'Follow One Request: Timeouts and Retries',
  subtitle: 'A request fails after exactly one second. Trace it and find where the second went.',
  stars: { three: 1.4, two: 1.6 },
  // an orders API: nine in ten requests are writes, so a cache is not the way out
  readRatio: 0.1,
  outro: 'You read each failure off a single request: a wait in a queue past the deadline, retries that went back into the same full queue, and a database working on requests whose users had already left. Each fix came from what the trace showed.',
  initial: graph(
    [
      ['users', 'client', X[0], 200, { timeoutMs: 1000 }],
      ['lb', 'lb', X[1], 200],
      ['api', 'server', X[2], 200, { name: 'orders api', instances: 4 }],
      ['db', 'db', X[3], 200, { name: 'orders db', capacity: 300, queueS: 3 }],
    ],
    [['users', 'lb'], ['lb', 'api'], ['api', 'db']],
  ),
  steps: [
    {
      id: 'deadline',
      title: 'A request that times out',
      story:
        'An orders API in front of one database. Users give up on a request after 1 s. The database holds up to 3 s of work in its queue (the "queue" setting under resilience on its card). ' +
        'Traffic climbs to 420 req/s and the errors climb with it. Before you change anything, find out where a failed request spent its second: select orders db, press "trace", and read the path the board lights up.',
      objective: 'Serve 420 req/s with <1% errors and p99 < 300ms for 5s, under $1.60/h.',
      traffic: { from: 200, to: 420, rampSeconds: 4 },
      goal: { maxErrorRate: 0.01, maxP99: 300, maxCost: 1.6, holdSeconds: 5 },
      hintAfter: 6,
      ask: 'Trace a failed request: where did its second go?',
      hint:
        'The trace crosses the load balancer and the API in a few milliseconds, then spends almost all of its second in the queue in front of the database (the thick "queue" arrow into orders db) and ends "timeout (1 s)": the user gave up while the request was still waiting. ' +
        'The database takes 300 req/s and is sent 420, so its queue grows until every request waits longer than the user will. Give it the capacity: a Medium database takes 600 req/s. A cache does little here, because 9 in 10 requests are writes.',
      solution: { note: 'A Medium database: 600 req/s for the 420 sent', changes: [{ op: 'set', id: 'db', fields: { tier: 'M' } }] },
      takeaway: 'A timeout at the user is often a wait in a queue further down. The trace shows which queue; capacity above the arrival rate keeps it short.',
    },
    {
      id: 'retries',
      title: 'Retries make it worse',
      story:
        'The network path to the database now drops 3% of calls, so 3% of orders fail. Retrying fixes that: give users retries (resilience on their card). ' +
        'At second 8 the database stalls for 6 s at 20% of its capacity, then recovers. The goal is checked from second 16: the system has to come back on its own.',
      objective: 'Be back under 1% errors and p99 < 500ms for 10s after the stall, by second 36.',
      traffic: { from: 420, to: 420, rampSeconds: 0 },
      chaos: [
        { at: 0, action: { type: 'inject-errors', id: 'db', rate: 0.03 }, message: 'The network path to orders db drops 3% of calls' },
        { at: 8, action: { type: 'degrade', id: 'db', factor: 0.2 }, message: 'orders db stalls: 20% of its capacity' },
        { at: 14, action: { type: 'degrade', id: 'db', factor: 1 }, message: 'orders db is back to full capacity' },
      ],
      goal: { maxErrorRate: 0.01, maxP99: 500, holdSeconds: 10, startAfter: 16, deadline: 36 },
      hintAfter: 8,
      ask: 'Pause just after the stall and trace a request: how many calls does one failure turn into?',
      hint:
        'With immediate retries the stall does not end for the users. Pause (Space) within 6 s of the "orders db stalls" notice, select orders db and press "trace": the database refuses the first call ("overloaded"), then "retry 1" and "retry 2" go straight back in, wait behind everyone else\'s retries in the API\'s queue, and are refused the same way. ' +
        'Every failure becomes three requests, so after the database recovers the load is still more than the API and the database can take. Backoff does not change that: it waits 50–100 ms before each retry, but still sends it. Keep the retries and cap them: set the users\' retry policy to "budget 10%". ' +
        'Retries then stay within a tenth of the calls: enough for the 3% the network drops, too few to triple the load.',
      solution: { note: 'Two retries within a 10% retry budget', changes: [{ op: 'set', id: 'users', fields: { retries: 2, retryPolicy: 'budget' } }] },
      takeaway: 'An immediate retry lands in the queue that just refused the call. Retries fix rare, independent failures; when the failures come from load, a retry budget keeps them from multiplying it.',
    },
    {
      id: 'aligned',
      title: 'Timeouts that do not line up',
      story:
        'A sale brings 700 req/s, more than the 600 the database can take, and the budget does not stretch to a larger one. The users still wait 1 s; the database still queues up to 3 s of work. ' +
        'Trace a failed request through orders db and compare how long it waited with how long the user waited.',
      objective: 'Answer at least 70% of requests in time (errors < 30%) with p99 < 1s for 10s, under $1.60/h.',
      traffic: { from: 420, to: 700, rampSeconds: 4 },
      goal: { maxErrorRate: 0.3, maxP99: 1000, maxCost: 1.6, holdSeconds: 10, startAfter: 8 },
      hintAfter: 8,
      ask: 'Trace a request that timed out: when the user gives up, does the database know? What happens to the request it is holding?',
      hint:
        'The trace ends "timeout (1 s)" inside the database\'s queue: the user has left, but nothing tells the database. The request stays queued and is worked on when its turn comes, up to 3 s later, for nobody. ' +
        'The database is fully busy and almost none of its answers arrive in time. The simulation does not pass deadlines down with calls (no deadline propagation), so make the callee\'s bound fit inside the caller\'s timeout: ' +
        'set orders db\'s queue to 0.25 s. It then refuses at once what it cannot finish in time ("overloaded" in the trace) and spends its capacity on requests someone is still waiting for.',
      solution: { note: 'A 0.25 s queue on the database, inside the users\' 1 s timeout', changes: [{ op: 'set', id: 'db', fields: { queueS: 0.25 } }] },
      takeaway: 'A callee that queues longer than its caller waits does work nobody receives, and under overload its goodput falls to almost nothing. Keep each bound inside the one above it (queue plus work under the caller\'s timeout), or pass the deadline down with the call so the work is dropped once the caller gives up.',
    },
  ],
};
