import type { Lesson } from './types';
import { graph, X } from '../scenarios/build';

/**
 * Serving an AI feature: provider rate limits (429s), failover between providers, semantic
 * caching, and the per-request bill vs. self-hosted GPUs with batching.
 */
export const aiServing: Lesson = {
  id: 'ai-serving',
  title: 'Shipping an AI Feature to Real Traffic',
  subtitle: 'Rate limits, fallbacks, caching and the GPU-vs-API bill.',
  stars: { three: 60, two: 100 },
  readRatio: 0.8,
  outro: 'Your AI feature survives viral traffic without a five-figure monthly API bill.',
  initial: graph(
    [
      ['users', 'client', X[0], 200],
      ['lb', 'lb', X[1], 200],
      ['api', 'server', X[2], 160, { instances: 2 }],
      ['openai', 'llmapi', X[3], 200, { limit: 50, name: 'llm-provider' }],
    ],
    [['users', 'lb'], ['lb', 'api'], ['api', 'openai']],
  ),
  steps: [
    {
      id: 'launch',
      title: 'Launch the assistant',
      story:
        'Your new AI assistant calls a hosted model API. Each request takes ~1.5s and costs about $0.002. ' +
        'Your plan allows 50 requests/second. Launch traffic is modest.',
      objective: 'Serve 20 req/s with <1% errors and p99 < 8s for 5s.',
      traffic: { from: 5, to: 20, rampSeconds: 3 },
      goal: { maxErrorRate: 0.01, maxP99: 8000, holdSeconds: 5 },
    },
    {
      id: 'viral',
      title: 'It went viral',
      story: 'A tech influencer shares your assistant. Traffic climbs to 120 req/s — more than double your provider rate limit.',
      objective: 'Serve 120 req/s with <1% errors and p99 < 8s for 10s.',
      traffic: { from: 20, to: 120, rampSeconds: 8 },
      goal: { maxErrorRate: 0.01, maxP99: 8000, holdSeconds: 10 },
      hintAfter: 6,
      hint:
        'Rate limits are a hard wall — 429s are 60% of LLM API errors in production. Options: put a Cache (as a semantic cache, ~30–40% hits for repeated questions) ' +
        'in front of the provider; add a self-hosted GPU Inference pool and set api routing to "failover" so overflow spills to the provider; ' +
        'or add a second provider. (Raising the rate limit works too — try it, then look at the bill.)',
    },
    {
      id: 'bill',
      title: 'Finance saw the bill',
      story:
        'At 120 req/s the provider costs ~$860 per hour — over $600k a month. Finance wants it under $100/hour, today, without breaking the product.',
      objective: 'Serve 120 req/s with <1% errors, p99 < 8s and cost ≤ $100/h for 10s.',
      traffic: { from: 120, to: 120, rampSeconds: 0 },
      goal: { maxErrorRate: 0.01, maxP99: 8000, maxCost: 100, holdSeconds: 10 },
      hintAfter: 8,
      hint:
        'Per-request pricing punishes sustained volume. Self-host an open model: GPU Inference instances cost ~$4/h each and serve ~6 req/s — ×4 with batching ' +
        '(select the node, enable batching). Keep the provider as a failover target for spikes (api → routing: failover, GPUs first) and keep the cache in front.',
    },
  ],
};
