import type { Lesson } from './types';

export const lesson1: Lesson = {
  id: 'scale-101',
  title: 'Scale 101: From One Box to Web Scale',
  subtitle: 'Keep the site up while traffic explodes.',
  stars: { three: 1.8, two: 2.5 },
  initial: {
    nodes: [
      { id: 'users-1', type: 'system', position: { x: 0, y: 180 }, data: { kind: 'client', name: 'users', tier: 'S', alive: true } },
      { id: 'api-1', type: 'system', position: { x: 380, y: 160 }, data: { kind: 'server', name: 'api-1', tier: 'S', alive: true, instances: 1, down: 0 } },
      { id: 'postgres-1', type: 'system', position: { x: 760, y: 160 }, data: { kind: 'db', name: 'postgres-1', tier: 'S', alive: true } },
    ],
    edges: [
      { id: 'e-users-api', source: 'users-1', target: 'api-1', type: 'flow' },
      { id: 'e-api-db', source: 'api-1', target: 'postgres-1', type: 'flow' },
    ],
  },
  steps: [
    {
      id: 'launch',
      title: 'Launch day',
      story:
        'Your app is live. Users hit a single API server, which talks to one Postgres database. ' +
        'Press ▶ Play and watch requests flow through the system.',
      objective: 'Serve 120 req/s with <1% errors and p99 < 300ms for 5s.',
      traffic: { from: 60, to: 120, rampSeconds: 3 },
      goal: { maxErrorRate: 0.01, maxP99: 300, holdSeconds: 5 },
      takeaway: 'One server and one database are a fine start: 120 req/s is half of what api-1 can take, so the queue never forms.',
    },
    {
      id: 'hn',
      title: 'Front page of Hacker News',
      story:
        'Someone posted you to Hacker News. Traffic is climbing to 700 req/s. ' +
        'One small API server handles about 250 req/s — watch what happens when it runs out of room.',
      objective: 'Handle 700 req/s with <1% errors and p99 < 300ms for 10s.',
      traffic: { from: 120, to: 700, rampSeconds: 8 },
      goal: { maxErrorRate: 0.01, maxP99: 300, holdSeconds: 10 },
      hintAfter: 6,
      hint:
        'Scale out: select api-1 and add instances with the + button. Notice nothing changes? Clients only know one address — ' +
        'drag a Load Balancer onto the board, wire Users → LB → api-1 and delete the old Users → api-1 edge (click it, press Backspace). ' +
        'Servers near 100% CPU get slow long before they drop requests, so leave headroom.',
      solution: {
        note: 'Load balancer in front, four API instances behind it',
        changes: [
          { op: 'add', component: { id: 'lb', kind: 'lb' } },
          { op: 'disconnect', from: 'users-1', to: 'api-1' },
          { op: 'connect', from: 'users-1', to: 'lb' },
          { op: 'connect', from: 'lb', to: 'api-1' },
          { op: 'set', id: 'api-1', fields: { instances: 4 } },
        ],
      },
      takeaway: 'Scaling out needs something to spread the load: instances only help behind a load balancer. Four instances at ~70% busy hold 700 req/s; at 100% they would already be slow.',
    },
    {
      id: 'viral',
      title: 'Going viral',
      story:
        'You hit the news. 2,000 req/s and still climbing. Adding servers is easy now — ' +
        'but every one of them talks to the same database. Finance also wants the bill under $2.50/hr.',
      objective: 'Handle 2,000 req/s, <1% errors, p99 < 300ms, cost ≤ $2.50/hr for 10s.',
      traffic: { from: 700, to: 2000, rampSeconds: 10 },
      goal: { maxErrorRate: 0.01, maxP99: 300, maxCost: 2.5, holdSeconds: 10 },
      hintAfter: 8,
      hint:
        'Check the database CPU — it is the new bottleneck. Put a Cache in front of it (api-1 → Cache → DB) to absorb most reads. ' +
        'Scaling the DB to size L also works… but look at what it does to the bill.',
      solution: {
        note: 'A cache in front of the database, eleven API instances',
        changes: [
          { op: 'add', component: { id: 'redis', kind: 'cache' } },
          { op: 'disconnect', from: 'api-1', to: 'postgres-1' },
          { op: 'connect', from: 'api-1', to: 'redis' },
          { op: 'connect', from: 'redis', to: 'postgres-1' },
          { op: 'set', id: 'api-1', fields: { instances: 11 } },
        ],
      },
      takeaway: 'Every API instance talks to the same database, so scaling the API moves the bottleneck there. A cache absorbs most reads for $0.15/h; a database four times the size would cost $1.20/h more.',
    },
    {
      id: 'chaos',
      title: 'Chaos Monday',
      story:
        'Monday morning: 2,400 req/s, a little more than last week. And servers die — it is not a question of if. ' +
        'In a few seconds one of your API instances is going down. Will the system stay within SLO without it?',
      objective: 'Survive an instance failure at 2,400 req/s: <1% errors, p99 < 300ms for 15s.',
      traffic: { from: 2000, to: 2400, rampSeconds: 2 },
      goal: { maxErrorRate: 0.01, maxP99: 300, holdSeconds: 15 },
      chaos: [{ at: 4, action: { type: 'kill', kind: 'server', pick: 'busiest' }, message: 'Instance failure!' }],
      hintAfter: 8,
      hint:
        'Run N+1: keep enough spare instances that losing one keeps the rest below ~80% CPU. ' +
        'Health checks already route around the dead instance — you just need room for its traffic.',
      solution: { note: 'Spare instances: N+1', changes: [{ op: 'set', id: 'api-1', fields: { instances: 14 } }] },
      takeaway: 'Instances die. Size for the load you have plus a spare: losing one of fourteen leaves the rest below 80% busy, and the health checks route around the dead one.',
    },
  ],
};
