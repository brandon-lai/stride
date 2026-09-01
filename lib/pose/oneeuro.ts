/**
 * §4: "raw landmarks are noisy. Apply a One Euro filter per landmark before
 * deriving any gesture. Derive velocity from filtered positions, not raw."
 *
 * The One Euro filter is an adaptive low-pass: it filters hard when the signal
 * is slow (killing jitter while the player stands still) and barely at all when
 * the signal is fast (so a jump is not smoothed into nothing). That tradeoff is
 * exactly the one this project needs -- a fixed low-pass either lets the
 * standing jitter through as false gestures, or adds lag to the one signal
 * §5 has already budgeted only 250ms for.
 */
export class OneEuro {
  /**
   * The previous *raw* input and the previous *filtered* output are tracked
   * separately, and that distinction is load-bearing.
   *
   * Computing the derivative against the filtered value -- the first version
   * here -- measures the gap between the new input and a value that is
   * deliberately lagging it, which inflates the reported speed by roughly
   * (1-alpha)/alpha. At the cutoffs this project uses that is about a factor of
   * six: a four-second stand-up reported 0.78 torso lengths per second instead
   * of 0.13, sailed past the jump gate, and fired three jumps. §8 caps
   * unintended gestures at about one per sixty-second run; this alone would
   * have blown that budget on any slow movement.
   */
  private xRawPrev: number | null = null;
  private xHatPrev = 0;
  private dxPrev = 0;
  private tPrev = 0;

  constructor(
    /** Cutoff at zero speed. Lower filters standing jitter harder. */
    private minCutoff = 1.2,
    /** How much speed raises the cutoff. Higher tracks fast motion better. */
    private beta = 0.02,
    /** Cutoff for the derivative itself. */
    private dCutoff = 1.0
  ) {}

  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(x: number, tSeconds: number): number {
    if (this.xRawPrev === null || tSeconds <= this.tPrev) {
      this.xRawPrev = x;
      this.xHatPrev = x;
      this.tPrev = tSeconds;
      this.dxPrev = 0;
      return x;
    }
    const dt = tSeconds - this.tPrev;
    // Derivative from the raw signal; smoothing from the filtered one.
    const dx = (x - this.xRawPrev) / dt;
    const dxHat = this.dxPrev + OneEuro.alpha(this.dCutoff, dt) * (dx - this.dxPrev);
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const xHat = this.xHatPrev + OneEuro.alpha(cutoff, dt) * (x - this.xHatPrev);

    this.xRawPrev = x;
    this.xHatPrev = xHat;
    this.dxPrev = dxHat;
    this.tPrev = tSeconds;
    return xHat;
  }

  /** Velocity of the filtered signal, in units per second. */
  get velocity(): number {
    return this.dxPrev;
  }

  reset() {
    this.xRawPrev = null;
    this.xHatPrev = 0;
    this.dxPrev = 0;
    this.tPrev = 0;
  }
}
