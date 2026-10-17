import { graph } from '../scenarios/build';
import { narrowScreen, turned } from '../canvas/phoneLayout';
type Graph = ReturnType<typeof graph>;

/**
 * Columns further apart than the usual 330: a failing link's label ("2.1k req/s · 53% err") needs about
 * 150 px between two cards to sit clear of both. The five-card step has only healthy labels to fit, so it
 * stays tighter and its cards bigger
 */
const X = [0, 400, 800, 1200];
const X5 = [0, 370, 740, 1110, 1480];

/** The three states of the system on the home board. Node ids persist so fixes happen live. */
export const HOME_GRAPHS = [
  graph(
    [
      ['users', 'client', X[0], 200],
      ['api-1', 'server', X[1], 170],
      ['postgres', 'db', X[2], 200],
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
      ['users', 'client', X5[0], 200],
      ['lb', 'lb', X5[1], 200],
      ['api-1', 'server', X5[2], 120, { instances: 10 }],
      ['redis', 'cache', X5[3], 200],
      ['postgres', 'db', X5[4], 200],
    ],
    [['users', 'lb'], ['lb', 'api-1'], ['api-1', 'redis'], ['redis', 'postgres']],
  ),
];

export { narrowScreen };

/** phones: the chain reads top to bottom instead of left to right (a chain: no fan-out to spread) */
function vertical(g: Graph): Graph {
  return { ...g, nodes: g.nodes.map((n) => ({ ...n, position: turned(n.position, { across: 0.5, down: 0.65 }) })) };
}

/** the i-th home graph, laid out for this screen */
export const homeGraph = (i: number): Graph => (narrowScreen() ? vertical(HOME_GRAPHS[i]) : HOME_GRAPHS[i]);
