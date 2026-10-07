import { graph, X } from '../scenarios/build';

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
