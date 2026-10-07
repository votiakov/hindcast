import type { Lesson } from './types';
import { graph, X } from '../scenarios/build';

/** Language runtime as a cost lever: throughput per instance, latency, and when it stops mattering. */
export const runtimes: Lesson = {
  id: 'runtimes',
  title: 'Does the Language Matter? Runtime Economics',
  subtitle: 'Node vs Go vs Rust: throughput per instance, latency and the cloud bill.',
  stars: { three: 2.6, two: 3.6 },
  readRatio: 0.85,
  outro: 'You cut compute cost with a faster runtime — and saw that past a point, the database decides your bill, not the language.',
  initial: graph(
    [
      ['users', 'client', X[0], 200],
      ['lb', 'lb', X[1], 200],
      ['api', 'server', X[2], 140, { instances: 10, runtime: 'node' }],
      ['db', 'db', X[3], 200, { tier: 'L' }],
    ],
    [['users', 'lb'], ['lb', 'api'], ['api', 'db']],
  ),
  steps: [
    {
      id: 'baseline',
      title: 'Ten Node.js instances',
      story:
        'Your API runs on Node.js: 10 instances behind a load balancer handle 2,000 req/s. ' +
        'Select api to see its runtime — and the bill in the top bar.',
      objective: 'Serve 2,000 req/s with <1% errors and p99 < 300ms for 5s.',
      traffic: { from: 800, to: 2000, rampSeconds: 4 },
      goal: { maxErrorRate: 0.01, maxP99: 300, holdSeconds: 5 },
    },
    {
      id: 'cut',
      title: 'Cut the compute bill',
      story:
        'Your CTO asks: "If we rewrote the API in Go — or Rust — how much would we save?" The database stays as it is. Find out.',
      objective: 'Same traffic and SLO, total cost ≤ $2.55/h for 10s.',
      traffic: { from: 2000, to: 2000, rampSeconds: 0 },
      goal: { maxErrorRate: 0.01, maxP99: 300, maxCost: 2.55, holdSeconds: 10 },
      hintAfter: 6,
      hint:
        'Select api, change runtime to Go (≈2.5× throughput per instance for typical JSON APIs) or Rust (≈3.5×), then remove instances with − ' +
        'while the CPU bar stays below ~80%. Fewer instances = smaller bill. (Python goes the other way.)',
    },
    {
      id: 'triple',
      title: 'Black Friday: 3× traffic',
      story:
        'Traffic triples to 6,000 req/s. A fast runtime helps — but every request still reads from the same database. Budget: $4/h.',
      objective: 'Serve 6,000 req/s with <1% errors, p99 < 300ms, cost ≤ $4/h for 10s.',
      traffic: { from: 2000, to: 6000, rampSeconds: 8 },
      goal: { maxErrorRate: 0.01, maxP99: 300, maxCost: 4, holdSeconds: 10 },
      hintAfter: 8,
      hint:
        'The database is the wall now, and no language rewrite fixes it. Add a Cache between api and db (api → cache → db) to absorb most reads, ' +
        'then you may even downsize the database. Scale api instances to keep CPU < 80%.',
    },
  ],
};
