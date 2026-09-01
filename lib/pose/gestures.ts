import type { Frame } from "./landmarks";
import type { Calibration } from "./calibration";
import { OneEuro } from "./oneeuro";
import type { Action } from "@/lib/game/types";

/**
 * §3, and the part §10 calls the hardest thing in the project: "making gestures
 * fire reliably for a body the tracker has never seen, in a room with unknown
 * lighting, at an unknown distance."
 *
 * Two decisions make that tractable:
 *
 *  - **Every threshold is a fraction of calibrated torso length** (§3), so the
 *    same numbers work for a tall player close to the camera and a short one
 *    far from it. Nothing here is in pixels or normalised image units.
 *
 *  - **This is a pure function of a frame stream.** No camera, no DOM, no
 *    MediaPipe. That is what lets §8's success criteria -- a false-positive
 *    rate and a miss rate -- be measured against synthetic motion in a test
 *    rather than guessed at, which matters a great deal when the playtest the
 *    PRD asks for is not available.
 */

export type Tunables = {
  /** Hip rise above baseline that counts as a jump, in torso lengths. */
  jumpRise: number;
  /** Upward hip velocity required with it, in torso lengths per second. */
  jumpVelocity: number;
  /** Hip drop below baseline that counts as a crouch. */
  duckDrop: number;
  /** §3: crouch is gated on the shoulder dropping too, not just the hips. */
  duckShoulderDrop: number;
  /** §3: "require the pose to hold for about 150ms". */
  duckHoldMs: number;
  /** Lateral hip displacement that counts as a lane change. */
  laneDeadzone: number;
  /** §3: "a short arbitration window (about 120ms)". */
  arbitrationMs: number;
  /** §3: "300ms cooldown per gesture type". */
  cooldownMs: number;
  /** Knee lift above standing height that counts as a step. */
  kneeLift: number;
  /** §3: seconds below floor cadence before the run starts to stall. */
  stallAfterS: number;
  /** Steps per minute mapping to the 0.5x and 1.3x ends of §3's multiplier. */
  cadenceFloorSpm: number;
  cadenceFullSpm: number;
  /** §3: relative lane mapping re-centres on an EMA over about 3 seconds. */
  recenterTauS: number;
  /**
   * Fraction of the lane deadzone that counts as lateral *during* arbitration.
   *
   * §3's window is about 120ms, but a sideways hop takes nearer 300ms to
   * complete, and the vertical spike that arms the jump happens early in it. At
   * the moment the window closes the player is only part of the way across, so
   * judging them against the full deadzone classified real hops as plain jumps
   * -- and then the lane detector fired a few frames later, which is exactly
   * the double-fire §3 forbids. A plain jump drifts perhaps 0.1 torso
   * laterally, so this separates the two cleanly with room to spare.
   */
  arbitrationLaneFraction: number;
  /** §9 q1: absolute lane mapping instead, for the playtest the PRD wants. */
  laneMode: "relative" | "absolute";
};

export const DEFAULTS: Tunables = {
  jumpRise: 0.16,
  jumpVelocity: 0.55,
  duckDrop: 0.14,
  duckShoulderDrop: 0.1,
  duckHoldMs: 150,
  laneDeadzone: 0.42,
  arbitrationMs: 120,
  cooldownMs: 300,
  /*
   * §3 says "knee lift above hip baseline". Taken literally that is a
   * high-knee sprint, and §2 wants "a real workout without feeling like a
   * fitness app" while §9 q3 worries that a tired player's knee lift drops.
   * A threshold relative to *standing* knee height keeps the gesture
   * detectable as form degrades, which is the failure the PRD is already
   * anticipating. It stays tunable so a playtest can settle it.
   */
  kneeLift: 0.26,
  stallAfterS: 3,
  cadenceFloorSpm: 70,
  cadenceFullSpm: 155,
  recenterTauS: 3,
  arbitrationLaneFraction: 0.55,
  laneMode: "relative",
};

export type GestureDebug = {
  hipY: number;
  hipX: number;
  shoulderY: number;
  /** Hip height above baseline, in torso lengths. Positive is up. */
  riseTorso: number;
  /** Lateral offset from the working centre, in torso lengths. */
  lateralTorso: number;
  /** Shoulder-to-hip compression, in torso lengths. Positive means crouching. */
  compressionTorso: number;
  spm: number;
  cadenceMult: number;
  centerX: number;
  confidence: number;
  stalledFor: number;
  /** Set while a jump is waiting on §3's arbitration window. */
  arbitrating: boolean;
};

export class GestureDetector {
  private fHipY = new OneEuro(1.0, 0.03);
  private fHipX = new OneEuro(1.0, 0.03);
  private fShoulderY = new OneEuro(1.0, 0.03);
  /*
   * Knees are filtered far more loosely than the torso. A running cadence puts
   * the knee signal around 1-3Hz, and the torso's cutoff attenuated it below
   * the lift threshold entirely -- cadence read as zero however fast the
   * synthetic body ran. Jitter on a knee also matters less: cadence is a
   * counted rising edge, not a position.
   */
  private fKneeL = new OneEuro(3.0, 0.7);
  private fKneeR = new OneEuro(3.0, 0.7);

  private center: number;
  private lastFire: Record<string, number> = {};
  private duckSince: number | null = null;
  /** §3's arbitration: a jump is held briefly to see if it is a lateral hop. */
  private pendingJump: { at: number; startX: number; startCenter: number } | null = null;
  private stepTimes: number[] = [];
  private kneeUp = { left: false, right: false };
  private lastStepSide: "left" | "right" | null = null;
  private belowFloorSince: number | null = null;

  debug: GestureDebug = {
    hipY: 0, hipX: 0, shoulderY: 0, riseTorso: 0, lateralTorso: 0, compressionTorso: 0,
    spm: 0, cadenceMult: 1, centerX: 0, confidence: 0, stalledFor: 0, arbitrating: false,
  };

  constructor(readonly cal: Calibration, public tune: Tunables = { ...DEFAULTS }) {
    this.center = cal.centerX;
  }

  /** §3's multiplier, exposed separately because the engine consumes it every
   *  frame while gestures are discrete events. */
  cadenceMultiplier(): number {
    return this.debug.cadenceMult;
  }

  update(f: Frame): Action[] {
    const T = this.cal.torso;
    const hipY = this.fHipY.filter(f.hipY, f.t);
    const hipX = this.fHipX.filter(f.hipX, f.t);
    const shoulderY = this.fShoulderY.filter(f.shoulderY, f.t);
    const kneeL = this.fKneeL.filter(f.leftKneeY, f.t);
    const kneeR = this.fKneeR.filter(f.rightKneeY, f.t);

    const rise = (hipY - this.cal.hipY) / T;
    const compression = (this.cal.shoulderY - this.cal.hipY - (shoulderY - hipY)) / T;
    const shoulderDrop = (this.cal.shoulderY - shoulderY) / T;

    this.updateCadence(f.t, kneeL, kneeR, hipY, T);

    // §3 relative mode: "a lane change is a discrete event triggered by a
    // lateral impulse, then the reference center resets". The EMA is the decay
    // the PRD asks for, so slow drift follows the player instead of firing.
    if (this.tune.laneMode === "relative") {
      const dt = 1 / 30;
      const a = 1 - Math.exp(-dt / this.tune.recenterTauS);
      this.center += (hipX - this.center) * a;
    } else {
      this.center = this.cal.centerX;
    }
    const lateral = (hipX - this.center) / T;

    this.debug = {
      hipY, hipX, shoulderY, riseTorso: rise, lateralTorso: lateral,
      compressionTorso: compression, spm: this.debug.spm, cadenceMult: this.debug.cadenceMult,
      centerX: this.center, confidence: f.confidence,
      stalledFor: this.belowFloorSince === null ? 0 : f.t - this.belowFloorSince,
      arbitrating: this.pendingJump !== null,
    };

    const out: Action[] = [];

    // Resolve any jump waiting on the arbitration window first, so a hop
    // resolves before a new gesture can be armed.
    const resolved = this.resolveArbitration(f.t, hipX, T);
    if (resolved) out.push(resolved);

    // §3: jump is a hip rise *with upward velocity*. The velocity term is what
    // separates a hop from a slow stand-up out of a crouch.
    const upward = this.fHipY.velocity / T;
    if (
      !this.pendingJump &&
      rise > this.tune.jumpRise &&
      upward > this.tune.jumpVelocity &&
      this.ready("jump", f.t) &&
      this.ready("lane", f.t)
    ) {
      // Do not fire yet. §3: "sample both signals" across ~120ms, then decide.
      this.pendingJump = { at: f.t, startX: hipX, startCenter: this.center };
      this.duckSince = null;
    }

    // Lane change without a jump: a step across the deadzone.
    if (!this.pendingJump && Math.abs(lateral) > this.tune.laneDeadzone && this.ready("lane", f.t)) {
      const dir = lateral < 0 ? "left" : "right";
      this.fire("lane", f.t);
      // Relative mode: the new position becomes the reference immediately, so
      // standing where you landed is not a second lane change (§3).
      if (this.tune.laneMode === "relative") this.center = hipX;
      out.push(dir);
    }

    // §3: "Gate crouch detection on shoulder Y dropping too, not just hips, and
    // require the pose to hold for about 150ms." A deep knee lift while running
    // drops the hips without dropping the shoulders, which is the false
    // positive this gate exists to stop.
    const crouching =
      (-rise > this.tune.duckDrop || compression > this.tune.duckDrop) &&
      shoulderDrop > this.tune.duckShoulderDrop;
    if (crouching && !this.pendingJump) {
      if (this.duckSince === null) this.duckSince = f.t;
      else if ((f.t - this.duckSince) * 1000 >= this.tune.duckHoldMs && this.ready("duck", f.t)) {
        this.fire("duck", f.t);
        this.duckSince = null;
        out.push("duck");
      }
    } else if (!crouching) {
      this.duckSince = null;
    }

    return out;
  }

  /**
   * §3: "if X displacement exceeds the lane threshold, treat it as a lane
   * change with a jump animation. Otherwise it is a straight jump. Do not fire
   * both."
   *
   * The cost of this is real and worth naming: a jump cannot be emitted until
   * the window closes, so 120ms of §5's 150-250ms input-lag budget is spent
   * here by design.
   */
  private resolveArbitration(t: number, hipX: number, T: number): Action | null {
    const p = this.pendingJump;
    if (!p) return null;
    if ((t - p.at) * 1000 < this.tune.arbitrationMs) return null;
    this.pendingJump = null;

    /*
     * Measured against the working centre at the moment the jump armed, not
     * against the hip position at that moment.
     *
     * A sideways hop moves laterally *and* vertically at once, so by the time
     * the vertical signal crosses the jump threshold the player is already part
     * of the way across. Differencing from the arming position saw only the
     * remainder, judged it too small, and emitted a plain jump -- then the lane
     * detector fired separately a few frames later. That is precisely the
     * "do not fire both" §3 forbids.
     */
    const dx = (hipX - p.startCenter) / T;
    if (Math.abs(dx) > this.tune.laneDeadzone * this.tune.arbitrationLaneFraction) {
      this.fire("jump", t);
      this.fire("lane", t);
      if (this.tune.laneMode === "relative") this.center = hipX;
      return dx < 0 ? "jumpLeft" : "jumpRight";
    }
    this.fire("jump", t);
    return "jump";
  }

  /**
   * §3: cadence from "alternating knee lift above hip baseline... over a 2
   * second window". Alternation matters: counting every lift would let a player
   * bounce one knee and hold full speed.
   */
  private updateCadence(t: number, kneeL: number, kneeR: number, hipY: number, T: number) {
    void hipY;
    const threshold = this.cal.kneeY + this.tune.kneeLift * T;
    const check = (side: "left" | "right", y: number) => {
      const up = y > threshold;
      const was = this.kneeUp[side];
      this.kneeUp[side] = up;
      // A step is the rising edge, and only if it alternates.
      if (up && !was && this.lastStepSide !== side) {
        this.lastStepSide = side;
        this.stepTimes.push(t);
      }
    };
    check("left", kneeL);
    check("right", kneeR);

    while (this.stepTimes.length && t - this.stepTimes[0] > 2) this.stepTimes.shift();
    const spm = (this.stepTimes.length / 2) * 60;
    this.debug.spm = spm;

    const { cadenceFloorSpm, cadenceFullSpm, stallAfterS } = this.tune;
    if (spm < cadenceFloorSpm) {
      if (this.belowFloorSince === null) this.belowFloorSince = t;
    } else {
      this.belowFloorSince = null;
    }

    let mult: number;
    if (spm >= cadenceFloorSpm) {
      const k = Math.min(1, (spm - cadenceFloorSpm) / (cadenceFullSpm - cadenceFloorSpm));
      mult = 0.5 + k * 0.8;
    } else {
      // §3: "Dropping below a floor cadence for more than 3 seconds slows the
      // character and eventually stalls the run. This keeps the game playable
      // for someone who pauses to breathe without instantly killing them."
      const below = t - (this.belowFloorSince ?? t);
      mult = below <= stallAfterS ? 0.5 : Math.max(0, 0.5 * (1 - (below - stallAfterS) / 2));
    }
    this.debug.cadenceMult = mult;
  }

  private ready(kind: string, t: number): boolean {
    const last = this.lastFire[kind];
    return last === undefined || (t - last) * 1000 >= this.tune.cooldownMs;
  }

  private fire(kind: string, t: number) {
    this.lastFire[kind] = t;
  }
}
