import type { SystemNodeData } from './catalog';
import type { EdgeStats, GlobalStats, NodeStats } from './engine';

/**
 * Flight recorder: every run on a board is recorded (4 frames per simulated second, last 15 min),
 * so you can scrub back to the moment something broke and see the whole board as it was.
 */

export interface Frame {
  t: number;
  global: Omit<GlobalStats, 'history'>;
  nodeStats: Record<string, NodeStats>;
  edgeStats: Record<string, EdgeStats>;
  /** node data at that moment (alive, instances down, faults…) */
  data: Record<string, SystemNodeData>;
}

export interface Mark {
  t: number;
  tone: 'bad' | 'good' | 'info';
  text: string;
}

export const FRAME_EVERY_S = 0.25;
const MAX_FRAMES = 3600;

export class Recorder {
  frames: Frame[] = [];
  marks: Mark[] = [];
  private lastT = -Infinity;

  clear() {
    this.frames = [];
    this.marks = [];
    this.lastT = -Infinity;
  }

  /** returns true when a frame was taken */
  maybeRecord(t: number, make: () => Frame): boolean {
    if (t - this.lastT < FRAME_EVERY_S - 1e-9) return false;
    this.lastT = t;
    this.frames.push(make());
    if (this.frames.length > MAX_FRAMES) {
      const drop = this.frames.length - MAX_FRAMES;
      this.frames.splice(0, drop);
      const t0 = this.frames[0].t;
      this.marks = this.marks.filter((m) => m.t >= t0);
    }
    return true;
  }

  mark(m: Mark) {
    this.marks.push(m);
  }

  /** the global sparkline history as it looked at frame `i` */
  historyAt(i: number, len = 90): GlobalStats['history'] {
    return this.frames.slice(Math.max(0, i - len + 1), i + 1).map((f) => ({ rps: f.global.rps, err: f.global.errorRate, p99: f.global.p99, cost: f.global.cost }));
  }
}

/** strip per-node sparkline arrays — the recorder rebuilds them from frames */
export const lean = (ns: Record<string, NodeStats>): Record<string, NodeStats> => {
  const out: Record<string, NodeStats> = {};
  for (const k in ns) out[k] = { ...ns[k], history: [] };
  return out;
};
