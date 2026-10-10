import { graph, X } from '../scenarios/build';
type Graph = ReturnType<typeof graph>;

/** The three states of the system on the home board. Node ids persist so fixes happen live. */
export const HOME_GRAPHS = [
  graph(
    [
      ['users', 'client', X[0], 200],
      ['api-1', 'server', X[1] + 50, 170],
      ['postgres', 'db', X[2] + 100, 200],
    ],
    [['users', 'api-1'], ['api-1', 'postgres']],
  ),
  graph(
    [
      ['users', 'client', X[0], 200],
      ['lb', 'lb', X[1], 200],
      ['api-1', 'server', X[2], 150, { instances: 4 }],
      ['postgres', 'db', X[3], 200],
    ],
    [['users', 'lb'], ['lb', 'api-1'], ['api-1', 'postgres']],
  ),
  graph(
    [
      ['users', 'client', X[0], 200],
      ['lb', 'lb', X[1], 200],
      ['api-1', 'server', X[2], 120, { instances: 10 }],
      ['redis', 'cache', X[3], 200],
      ['postgres', 'db', X[4], 200],
    ],
    [['users', 'lb'], ['lb', 'api-1'], ['api-1', 'redis'], ['redis', 'postgres']],
  ),
];

/** phones: the chain reads top to bottom instead of left to right */
export const narrowScreen = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 700px)').matches;

function vertical(g: Graph): Graph {
  return { ...g, nodes: g.nodes.map((n) => ({ ...n, position: { x: (n.position.y - 200) * 0.5, y: n.position.x * 0.78 } })) };
}

/** the i-th home graph, laid out for this screen */
export const homeGraph = (i: number): Graph => (narrowScreen() ? vertical(HOME_GRAPHS[i]) : HOME_GRAPHS[i]);
