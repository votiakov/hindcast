import type { Lesson } from './types';
import { graph, X } from '../scenarios/build';

/**
 * Thread pools and bulkheads: a server that holds a thread while it waits on a call lets one slow
 * dependency take every thread — and fail the requests that never touch it. A bulkhead gives each
 * dependency its own share; a timeout and a fallback keep the slow one's requests answered too.
 * After Michael Nygard, "Release It!" (stability patterns: bulkheads, timeouts, circuit breakers).
 */
export const bulkheads: Lesson = {
  id: 'bulkheads',
  title: 'One Slow Dependency: Bulkheads',
  subtitle: 'Payments slow down. Browsing never calls payments. Why does it fail?',
  stars: { three: 3.2, two: 3.8 },
  readRatio: 0.8,
  outro: 'Payments got a share of the threads and no more; their calls gave up after 300 ms and a fallback answered while the breaker was open. A slow provider became a degraded checkout instead of a dead shop.',
  initial: graph(
    [
      ['users', 'client', X[0], 230, { name: 'shoppers' }],
      ['lb', 'lb', X[1], 230],
      ['api', 'server', X[2], 230, { instances: 2, threads: 50, name: 'shop api' }],
      ['catalog', 'db', X[3], 110, { name: 'catalog' }],
      ['payments', 'external', X[3], 360, { name: 'payments', latencyMs: 120, limit: 5000 }],
    ],
    [['users', 'lb'], ['lb', 'api'], ['api', 'catalog'], ['api', 'payments']],
  ),
  steps: [
    {
      id: 'starved',
      title: 'Payments slow down',
      story:
        'Half the requests browse the catalog, half pay. The shop API is a thread-per-request server: 50 threads per instance, and a request holds its thread while it waits on its call. ' +
        'At second 8 the payment provider slows to 2 s a call. Watch what happens to browsing, which never calls payments.',
      objective: 'Keep errors under 50% while payments are slow: let payments fail, not the whole shop.',
      traffic: { from: 300, to: 300, rampSeconds: 1 },
      chaos: [{ at: 8, action: { type: 'inject-latency', id: 'payments', ms: 2000 }, message: '🐢 The payment provider slows down: +2 s on every call' }],
      goal: { maxErrorRate: 0.5, maxP99: 3000, holdSeconds: 10, startAfter: 12 },
      hintAfter: 12,
      hint: 'Every thread is waiting on payments, so catalog requests find none free. Open the shop API’s resilience settings and give it a bulkhead: 20 calls per instance may wait on one dependency, the rest are refused at once and keep their thread.',
      solution: { note: 'A bulkhead of 20 per dependency', changes: [{ op: 'set', id: 'api', fields: { bulkhead: 20 } }] },
      takeaway: 'A thread waiting on a slow call is a thread nothing else can use. A bulkhead caps how many may wait on any one dependency, so a slow one takes down only the requests that need it.',
    },
    {
      id: 'degrade',
      title: 'Keep checkout answering',
      story:
        'Browsing is back, but every payment still fails while the provider is slow. A checkout that says “we’ll confirm by email” beats one that spins and errors. ' +
        'Give the calls a deadline, and serve a fallback when they keep failing.',
      objective: 'Fail under 5% of requests while payments are slow (the breaker’s probes may blip).',
      traffic: { from: 300, to: 300, rampSeconds: 1 },
      chaos: [{ at: 8, action: { type: 'inject-latency', id: 'payments', ms: 2000 }, message: '🐢 The payment provider slows down: +2 s on every call' }],
      goal: { maxErrorRate: 0.15, maxTotalErrorRate: 0.05, maxP99: 1500, holdSeconds: 10, startAfter: 18 },
      hintAfter: 12,
      hint: 'On the shop API: a 300 ms timeout so a call gives up quickly, and a circuit breaker with a fallback — once most calls to payments fail, it stops calling and answers with the fallback.',
      solution: { note: 'A timeout, and a breaker with a fallback', changes: [{ op: 'set', id: 'api', fields: { timeoutMs: 300, breaker: true, fallback: true } }] },
      takeaway: 'Bulkheads contain a slow dependency; timeouts and a breaker with a fallback decide what its users see instead. Together a provider’s bad day is a degraded feature, not an outage.',
    },
  ],
};
