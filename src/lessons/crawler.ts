import type { Lesson } from './types';
import { graph, link, X } from '../scenarios/build';

/**
 * Crawl the web: a frontier of URLs in a queue, crawlers that fetch each page from someone else's
 * servers, store it, and write every word into a reverse index. The crawl rate sets the crawler
 * fleet; the words per page set the index's write load; and the web itself is slow and flaky.
 * After The System Design Primer's web-crawler problem (Donne Martin, CC BY 4.0).
 */
const initial = link(
  graph(
    [
      ['scheduler', 'client', X[0], 200, { name: 'scheduler' }],
      ['frontier', 'queue', X[1], 200, { name: 'frontier' }],
      ['crawlers', 'worker', X[2], 200, { instances: 12, routing: 'fanout', name: 'crawlers' }],
      ['web', 'external', X[3] + 40, 40, { limit: 6000, latencyMs: 300, name: 'the web' }],
      ['pages', 'storage', X[3] + 40, 230, { name: 'pages' }],
      ['index', 'db', X[3] + 40, 420, { tier: 'L', shards: 2, name: 'reverse index' }],
    ],
    [['scheduler', 'frontier'], ['frontier', 'crawlers'], ['crawlers', 'web'], ['crawlers', 'pages'], ['crawlers', 'index']],
  ),
  'crawlers',
  'index',
  { calls: 4 },
);

export const crawler: Lesson = {
  id: 'crawler',
  title: 'Crawl the Web',
  subtitle: 'A frontier, a fleet, an index — and servers that are not yours.',
  stars: { three: 12, two: 14 },
  readRatio: 0,
  outro: 'You sized a crawl from its rate, sharded the index for the words every page writes, and made the crawlers patient with a web that fails.',
  initial,
  steps: [
    {
      id: 'crawl',
      title: '1,000 pages a second',
      story:
        'The scheduler puts 1,000 URLs a second on the frontier queue. Each crawler fetches the page from the web, stores it, and writes its words into the reverse index — ' +
        'four index updates a page, on two shards.',
      objective: 'Crawl 1,000 pages/s with <1% errors and the frontier under 10 s behind.',
      traffic: { from: 500, to: 1000, rampSeconds: 3 },
      goal: { maxErrorRate: 0.01, maxP99: 3000, maxLagS: 10, maxJobErrorRate: 0.01, holdSeconds: 8 },
      takeaway: 'A crawler is a pipeline: the frontier absorbs bursts, the fleet sets the pace, and every page becomes several writes downstream.',
    },
    {
      id: 'faster',
      title: 'Crawl the whole web in a month',
      story:
        'A month for a billion pages is about 400 pages a second on average — and twice that to recrawl what changes. Product wants 3,000 a second. ' +
        'The crawlers fall behind, and every page still writes four index entries.',
      objective: 'Crawl 3,000 pages/s with <1% errors and the frontier under 10 s behind.',
      traffic: { from: 1000, to: 3000, rampSeconds: 5 },
      goal: { maxErrorRate: 0.01, maxP99: 3000, maxLagS: 10, maxJobErrorRate: 0.01, holdSeconds: 10 },
      hintAfter: 10,
      hint: 'Count it through: 3,000 pages need 3,000 / 100 = 30+ crawlers (36 leaves headroom), and 12,000 index writes a second need more shards — 4 of size L.',
      solution: {
        note: 'A fleet and an index sized for the crawl',
        changes: [
          { op: 'set', id: 'crawlers', fields: { instances: 36 } },
          { op: 'set', id: 'index', fields: { shards: 4 } },
        ],
      },
      takeaway: 'Size each stage for what reaches it: pages for the crawlers, pages × words for the index. Writes that big only split by sharding.',
    },
    {
      id: 'flaky',
      title: 'The web is not yours',
      story: 'At 3 s, one fetch in eight starts failing — timeouts, resets, 503s from sites you do not run. Every failed fetch is a page lost from the crawl.',
      objective: 'Keep the crawl under 1% failed pages while the web flakes.',
      traffic: { from: 3000, to: 3000, rampSeconds: 0 },
      goal: { maxErrorRate: 0.01, maxP99: 3000, maxLagS: 10, maxJobErrorRate: 0.01, holdSeconds: 10, startAfter: 4 },
      chaos: [{ at: 3, action: { type: 'inject-errors', id: 'web', rate: 0.12 }, message: 'One fetch in eight fails: the web is flaky' }],
      hintAfter: 8,
      hint: 'Retry the fetch: give the crawlers 2 retries with backoff. A transient failure usually succeeds a moment later, and the web’s rate limit has room for the extra fetches.',
      solution: { note: 'Retries with backoff on the crawlers', changes: [{ op: 'set', id: 'crawlers', fields: { retries: 2, retryPolicy: 'backoff' } }] },
      takeaway: 'Someone else’s servers fail in ways you cannot fix. Retrying with backoff turns their transient failures into a little extra latency — a crawl can afford latency, not lost pages.',
    },
  ],
};
