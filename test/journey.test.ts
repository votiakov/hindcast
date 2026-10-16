import { beforeAll, describe, expect, it } from 'vitest';
import { loadEngine } from '../src/backtest/native';
import { simulateDes, type Journey, type TraceSpan } from '../src/sim/des/des';
import { boardMarks, failMark, hopTimes, journeyRows, journeyVerdict } from '../src/ui/journey';

beforeAll(loadEngine);

const span = (p: Partial<TraceSpan> & Pick<TraceSpan, 'id' | 'parent'>): TraceSpan => ({
  via: 'call',
  attempt: 0,
  sentMs: 0,
  arriveMs: 0,
  startMs: 0,
  servedMs: 0,
  endMs: 0,
  networkMs: 0,
  waitMs: 0,
  serviceMs: 0,
  outcome: 'ok',
  reason: null,
  origin: null,
  gaveUpMs: null,
  deadlineMs: null,
  ...p,
});

/** the approved sketch: the api's call waits 840 ms in the db's queue, its 1 s deadline passes, its retry is shed */
const sketch: Journey = {
  id: 1,
  atS: 7.4,
  read: true,
  ms: 1013.5,
  ok: false,
  failedAt: 'db',
  reason: 'overloaded',
  truncated: false,
  spans: [
    span({ id: 'users', parent: -1, endMs: 1013.5, outcome: 'failed', reason: 'overloaded', origin: 'db' }),
    span({ id: 'lb', parent: 0, sentMs: 0, arriveMs: 12, startMs: 12, servedMs: 12.4, endMs: 1013.5, networkMs: 12, serviceMs: 0.4, outcome: 'failed', reason: 'overloaded', origin: 'db' }),
    span({ id: 'api', parent: 1, sentMs: 12.4, arriveMs: 12.7, startMs: 12.7, servedMs: 15.4, endMs: 1013.5, networkMs: 0.3, serviceMs: 2.7, outcome: 'failed', reason: 'overloaded', origin: 'db' }),
    span({ id: 'db', parent: 2, sentMs: 15.4, arriveMs: 15.7, startMs: null, servedMs: null, endMs: null, networkMs: 0.3, outcome: 'timeout', gaveUpMs: 1015.4, deadlineMs: 1000 }),
    span({ id: 'db', parent: 2, via: 'retry', attempt: 1, sentMs: 1012.7, arriveMs: 1013, startMs: null, servedMs: null, endMs: 1013.5, networkMs: 0.3, outcome: 'failed', reason: 'overloaded', origin: 'db' }),
  ],
};
const text = (j: Journey) => journeyRows(j, (id) => id).map((r) => r.map((x) => x.t).join('').trimEnd());

describe('a journey, read out', () => {
  it('lays the path out as text, the retry under the hop that made it', () => {
    const rows = text(sketch);
    expect(rows).toHaveLength(2);
    const [first, second] = rows;
    expect(first).toBe('users ─12ms─▶ lb ─3ms─▶ api ══ 1000ms queue ══▶ db ✕ timeout (1 s)');
    expect(second).toBe('                        └─ retry 1 ─0.3ms─▶ db ✕ overloaded');
    // the branch starts under the hop that retried
    expect(second.indexOf('└')).toBe(first.indexOf('api'));
    expect(journeyVerdict(sketch, (id) => id)).toBe('read · failed after 1.01s · db: overloaded');
  });

  it('names components as the board does and tones each part', () => {
    const rows = journeyRows(sketch, (id) => (id === 'db' ? 'orders-db' : id), 'db');
    expect(rows[0].map((r) => r.t).join('')).toBe('users ─12ms─▶ lb ─3ms─▶ api ══ 1000ms queue ══▶ orders-db ✕ timeout (1 s)');
    expect(rows[0].filter((r) => r.c === 'focus').map((r) => r.t)).toEqual(['orders-db']);
    expect(rows[0].filter((r) => r.c === 'q').map((r) => r.t)).toEqual([' ══ 1000ms queue ══▶ ']);
    expect(rows[1].filter((r) => r.c === 'dim').map((r) => r.t.trim())).toEqual(['└─ retry 1']);
    expect(journeyVerdict(sketch, (id) => (id === 'db' ? 'orders-db' : id))).toBe('read · failed after 1.01s · orders-db: overloaded');
  });

  it('puts the wait a request had in the queue on the hop it was stuck at', () => {
    const t = hopTimes(sketch, sketch.spans[3]);
    expect(t.wait).toBeCloseTo(999.7, 5);
    expect(t.queued).toBe(true);
    expect(failMark(sketch, 3)).toBe('timeout (1 s)');
    expect(failMark(sketch, 4)).toBe('overloaded');
    // the hops that only passed the failure on are not marked
    expect([0, 1, 2].map((i) => failMark(sketch, i))).toEqual([null, null, null]);
  });

  it('lights the links it took, with each attempt, and marks where it failed', () => {
    const edges = [
      { id: 'e1', source: 'users', target: 'lb' },
      { id: 'e2', source: 'lb', target: 'api' },
      { id: 'e3', source: 'api', target: 'db' },
      { id: 'e4', source: 'api', target: 'cache' },
    ];
    const m = boardMarks(sketch, edges);
    expect(Object.keys(m.edges).sort()).toEqual(['e1', 'e2', 'e3']);
    expect(m.edges.e3.lines).toEqual([
      { t: '1000ms queue ✕', c: 'bad' },
      { t: 'retry 1 · 0.3ms ✕', c: 'bad' },
    ]);
    expect(m.nodes.db).toEqual({ state: 'timeout', note: 'timeout (1 s), then overloaded' });
    expect(m.nodes.api.state).toBe('on');
    expect(m.nodes.cache).toBeUndefined();
  });
});

describe('a journey from the engine', () => {
  it('reads out a run of a board whose database is down', async () => {
    await loadEngine();
    const spec = { components: [{ id: 'users', kind: 'client' }, { id: 'api', kind: 'server', retries: 1 }, { id: 'db', kind: 'db' }], connections: ['users -> api', 'api -> db'] };
    const r = simulateDes(spec, { duration: 6, rps: 20, events: [{ at: 0, action: { type: 'kill-id', id: 'db' } }] }, { trace: { fromS: 1 } });
    const t = r.trace!;
    const j = t.journeys[t.byNode.db.failed[0]];
    expect(j.failedAt).toBe('db');
    const [first, second] = text(j);
    expect(first).toMatch(/^users ─[\d.]+ms─▶ api ─[\d.]+ms─▶ db ✕ down$/);
    expect(second).toMatch(/└─ retry 1 ─[\d.]+ms─▶ db ✕ down$/);
  });
});

describe('the readout and the board agree', () => {
  it('marks a failure in the text exactly where the board marks it, and a queue where it lights one', async () => {
    await loadEngine();
    // a slow db behind a deadline and retries, and a dead replica: timeouts, sheds and retries
    const spec = {
      components: [
        { id: 'users', kind: 'client' },
        { id: 'api', kind: 'server', capacity: 1000, latencyMs: 2, timeoutMs: 500, retries: 2, routing: 'fanout' },
        { id: 'db', kind: 'server', capacity: 10, latencyMs: 100, queueS: 1 },
        { id: 'cache', kind: 'cache', hitRate: 0.5 },
        { id: 'store', kind: 'db' },
      ],
      connections: ['users -> api', 'api -> db', 'api -> cache', 'cache -> store'],
    };
    const r = simulateDes(spec, { duration: 12, rps: 40, events: [{ at: 0, action: { type: 'kill-id', id: 'store' } }] }, { trace: { fromS: 3, perNode: 12 } });
    const journeys = r.trace!.journeys;
    expect(journeys.length).toBeGreaterThan(10);
    let marks = 0;
    for (const j of journeys) {
      const text = journeyRows(j, (id) => id).map((row) => row.map((x) => x.t).join('')).join('\n');
      const expected = j.spans.map((_, i) => failMark(j, i)).filter((m): m is string => !!m);
      const shown = [...text.matchAll(/✕ ([^─═▶\n]+?)(?= ─| ══|\n|$)/g)].map((m) => m[1]);
      expect(shown.sort()).toEqual([...expected].sort());
      marks += expected.length;
      const queued = j.spans.filter((s) => s.parent >= 0 && hopTimes(j, s).queued && hopTimes(j, s).unreached === false).length;
      expect((text.match(/══▶/g) ?? []).length).toBe(queued);
    }
    expect(marks).toBeGreaterThan(5);
  });
});
