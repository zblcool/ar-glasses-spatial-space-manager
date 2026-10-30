/**
 * One-Euro filter (Casiez et al. 2012): a low-pass filter whose cutoff rises
 * with speed, so a slow hand is steady and a fast one doesn't lag.
 */
export class OneEuro {
  private x: number | null = null;
  private dx = 0;
  private t = 0;

  /**
   * @param minCutoff cutoff (Hz) at rest: lower = steadier, laggier
   * @param beta how fast the cutoff rises with speed (per unit/s)
   * @param dCutoff cutoff (Hz) for the speed estimate itself
   */
  constructor(
    private readonly minCutoff = 1,
    private readonly beta = 0,
    private readonly dCutoff = 1,
  ) {}

  /** Filter one sample taken at time t (seconds). */
  filter(value: number, t: number): number {
    if (this.x === null || t <= this.t) {
      if (this.x === null) this.x = value;
      this.t = t;
      return this.x;
    }
    const dt = t - this.t;
    this.t = t;
    const dx = (value - this.x) / dt;
    this.dx += alpha(dt, this.dCutoff) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += alpha(dt, cutoff) * (value - this.x);
    return this.x;
  }

  reset(): void {
    this.x = null;
    this.dx = 0;
  }
}

function alpha(dt: number, cutoff: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}
