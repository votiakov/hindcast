/** Seeded PRNG (mulberry32) + the distributions the DES needs. Same seed → same run. */
export class Rng {
  private s: number;
  private spare: number | null = null;

  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }

  /** uniform [0, 1) */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** standard normal (Box–Muller, caches the second value) */
  normal(): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return v;
    }
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }

  /** exponential with the given mean */
  exp(mean: number): number {
    return -Math.log(1 - this.next()) * mean;
  }

  /** log-normal with the given mean and coefficient of variation — the classic long-tailed service time */
  lognormal(mean: number, cv: number): number {
    if (cv <= 0) return mean;
    const s2 = Math.log(1 + cv * cv);
    return Math.exp(Math.log(mean) - s2 / 2 + Math.sqrt(s2) * this.normal());
  }
}
