/** Small specs shared by the tests. */
export const shop = {
  name: 'Web shop',
  components: [
    { id: 'users', kind: 'client' },
    { id: 'lb', kind: 'lb' },
    { id: 'api', kind: 'server', instances: 4 },
    { id: 'db', kind: 'db', tier: 'M' },
  ],
  connections: [
    ['users', 'lb'],
    ['lb', 'api'],
    ['api', 'db'],
  ],
};

export const shopWithReplica = {
  ...shop,
  components: [...shop.components, { id: 'replica', kind: 'replica', tier: 'M' }],
  connections: [...shop.connections, ['db', 'replica']],
};

export const steady = (rps: number, duration = 30) => ({ duration, rps, readRatio: 0.8 });
