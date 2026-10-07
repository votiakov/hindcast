/**
 * Log-bucketed latency histogram (HDR-style): ~2.5% relative precision from 0.05 ms to ~1000 s
 * in a fixed Uint32Array, so recording is O(1) and merging is a vector add.
 */
const MIN_MS = 0.05;
const GROWTH = 1.025;
const LOG_G = Math.log(GROWTH);
export const BUCKETS = Math.ceil(Math.log(1_000_000 / MIN_MS) / LOG_G) + 1;

export class Histogram {
  counts = new Uint32Array(BUCKETS);
  total = 0;
  sum = 0;
  max = 0;

  record(ms: number) {
    const v = Math.max(MIN_MS, ms);
    const i = Math.min(BUCKETS - 1, Math.floor(Math.log(v / MIN_MS) / LOG_G));
    this.counts[i]++;
    this.total++;
    this.sum += ms;
    if (ms > this.max) this.max = ms;
  }

  merge(o: Histogram) {
    for (let i = 0; i < BUCKETS; i++) this.counts[i] += o.counts[i];
    this.total += o.total;
    this.sum += o.sum;
    this.max = Math.max(this.max, o.max);
  }

  /** q in [0,1] → latency (upper edge of the bucket, i.e. a conservative estimate) */
  quantile(q: number): number {
    if (!this.total) return 0;
    const target = Math.ceil(q * this.total);
    let acc = 0;
    for (let i = 0; i < BUCKETS; i++) {
      acc += this.counts[i];
      if (acc >= target) return Math.min(this.max, MIN_MS * GROWTH ** (i + 1));
    }
    return this.max;
  }

  mean(): number {
    return this.total ? this.sum / this.total : 0;
  }

  reset() {
    this.counts.fill(0);
    this.total = 0;
    this.sum = 0;
    this.max = 0;
  }
}
