import type { Lesson } from './types';
import { graph, X } from '../scenarios/build';

/**
 * Size a vector index: memory first (the HNSW graph has to fit), then recall (each halving of what a
 * query may miss doubles its work). The retrieval behind a RAG feature, on OpenSearch k-NN nodes.
 */
export const vectorSearch: Lesson = {
  id: 'vector-search',
  title: 'Size the Vector Index',
  subtitle: 'Retrieval for an AI feature: the graph must fit in memory, and recall is paid for per query.',
  stars: { three: 3.2, two: 4.2 },
  readRatio: 0.95,
  outro: 'You sized the index by memory before CPU, and bought the recall the answers need instead of the most there is.',
  initial: graph(
    [
      ['users', 'client', X[0], 200],
      ['lb', 'lb', X[1], 200],
      ['api', 'server', X[2], 200, { instances: 8, name: 'retrieval api' }],
      ['vectors', 'vector', X[3], 200, { tier: 'M', instances: 4, recall: 0.99, vectorsM: 10, name: 'embeddings (k-NN)' }],
    ],
    [['users', 'lb'], ['lb', 'api'], ['api', 'vectors']],
  ),
  steps: [
    {
      id: 'tuned',
      title: 'Ten million chunks',
      story:
        'The assistant retrieves context from ten million embedded chunks on four medium nodes, tuned for recall 0.99. ' +
        'Each node keeps 8 GB for the graph; the index needs about 35 GB.',
      objective: 'Serve 100 queries/s with <1% errors and p99 < 400ms for 5s.',
      traffic: { from: 50, to: 100, rampSeconds: 3 },
      goal: { maxErrorRate: 0.01, maxP99: 400, holdSeconds: 5 },
      takeaway: 'It works, at about 90 ms a query: 9% of the graph is off memory (1.8× the work) and recall 0.99 is five times the work of 0.95 — nine times in all. Four nodes top out near 260 queries/s.',
    },
    {
      id: 'memory',
      title: '300 queries/s',
      story:
        'The feature ships to everyone. Every lookup that misses memory reads the disk at ten times the cost — select the vector database when it turns red and read what it says. ' +
        'You could buy nodes for CPU — or for memory.',
      objective: 'Serve 300 queries/s with <1% errors and p99 < 400ms for 10s.',
      traffic: { from: 100, to: 300, rampSeconds: 4 },
      goal: { maxErrorRate: 0.01, maxP99: 400, holdSeconds: 10 },
      hintAfter: 8,
      hint: 'Add one node: five medium nodes keep 40 GB, and the whole 35 GB graph fits. Capacity more than doubles for a quarter more nodes.',
      solution: { note: 'A fifth node, so the graph fits in memory', changes: [{ op: 'set', id: 'vectors', fields: { instances: 5 } }] },
      takeaway: 'One node more put the graph in memory and more than doubled what the cluster serves. A vector index is sized by memory first; a little over the line costs far more than its share.',
    },
    {
      id: 'recall',
      title: 'A launch: 1,200 queries/s',
      story:
        'A launch quadruples retrieval. At recall 0.99 that takes about eight more nodes. ' +
        'The answers are reranked from the top 50 anyway, and an offline test showed recall 0.95 gives the same answers. Stay within $4.20/h.',
      objective: 'Serve 1,200 queries/s with <1% errors and p99 < 400ms for 10s, under $4.20/h.',
      traffic: { from: 300, to: 1200, rampSeconds: 5 },
      goal: { maxErrorRate: 0.01, maxP99: 400, holdSeconds: 10, maxCost: 4.2 },
      hintAfter: 8,
      hint: 'Select the vector database and set recall to 0.95: each query walks a fifth of the graph, and the same nodes serve five times as many.',
      solution: { note: 'Recall 0.95', changes: [{ op: 'set', id: 'vectors', fields: { recall: 0.95 } }] },
      takeaway: 'Recall 0.95 made each query a fifth of the work: the same five nodes served the launch. Measure the recall your answers need, and pay for that — not for the last point.',
    },
  ],
};
