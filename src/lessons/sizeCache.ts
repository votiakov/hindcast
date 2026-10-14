import type { Lesson } from './types';
import { graph, X } from '../scenarios/build';

/**
 * Size the cache: a cache's hit rate is not a setting, it is how much of the popular data its memory
 * holds. Under Zipf popularity doubling the memory buys a few points, not a few times — so measure.
 * After The System Design Primer's query-cache problem (Donne Martin, CC BY 4.0).
 */
export const sizeCache: Lesson = {
  id: 'size-cache',
  title: 'Size the Cache',
  subtitle: 'A hit rate is not a setting. It is how much of the hot data fits.',
  stars: { three: 4.5, two: 5.2 },
  readRatio: 0.95,
  outro: 'You sized the cache from the data it fronts, and saw how little a doubling buys once the hot keys already fit.',
  initial: graph(
    [
      ['users', 'client', X[0], 200],
      ['lb', 'lb', X[1], 200],
      ['api', 'server', X[2], 200, { instances: 32, name: 'search api' }],
      ['cache', 'cache', X[3], 200, { workingSetGb: 64, name: 'query cache' }],
      ['db', 'db', X[4], 200, { name: 'index' }],
    ],
    [['users', 'lb'], ['lb', 'api'], ['api', 'cache'], ['cache', 'db']],
  ),
  steps: [
    {
      id: 'fits',
      title: '64 GB of answers',
      story:
        'Every search result is cached by its query: 64 GB of answers, a few queries asked far more than the rest. ' +
        'A small cache holds 6.4 GB — the most popular tenth — and that alone answers about 87% of reads.',
      objective: 'Serve 3,000 req/s with <1% errors and p99 < 300ms for 5s.',
      traffic: { from: 1500, to: 3000, rampSeconds: 3 },
      goal: { maxErrorRate: 0.01, maxP99: 300, holdSeconds: 5 },
      takeaway: 'Popularity is skewed: a tenth of the data answers most of the reads. That is why a cache works at all.',
    },
    {
      id: 'growth',
      title: '7,000 searches a second',
      story:
        'Traffic more than doubles. Every miss and every write lands on the index, and it is already past its limit. ' +
        'You can grow the index — or grow the cache. Look at the cache’s hit rate as you change its size: S, M and L hold 6.4, 13 and 26 GB.',
      objective: 'Serve 7,000 req/s with <1% errors and p99 < 300ms for 10s.',
      traffic: { from: 3000, to: 7000, rampSeconds: 6 },
      goal: { maxErrorRate: 0.01, maxP99: 300, holdSeconds: 10 },
      hintAfter: 8,
      hint: 'Size the cache up and watch its hit rate: 87% → 90% → 94%. Four times the memory removes about half the misses — enough here.',
      solution: { note: 'A cache four times the size', changes: [{ op: 'set', id: 'cache', fields: { tier: 'L' } }] },
      takeaway: 'Four times the memory took the hit rate from 87% to 94%: the hot keys already fit, so each doubling only reaches a little further into the long tail. Price that against a bigger database before you buy it.',
    },
  ],
};
