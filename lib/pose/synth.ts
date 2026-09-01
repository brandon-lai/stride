import type { Frame } from "./landmarks";
import type { Calibration } from "./calibration";

/**
 * Synthetic bodies, for testing the gesture layer without one.
 *
 * §8 states success criteria as rates -- "false positive rate below roughly 1
 * unintended gesture per 60 second run", "missed gesture rate below 5%" -- and
 * §7 says to settle them by playtesting three body types in two rooms. That
 * playtest is not available here, and no amount of care substitutes for it.
 *
 * What this *can* do is make those rates measurable at all. A detector that
 * fires on a synthetic run-in-place is broken for every real body too, and a
 * detector that misses a clean synthetic jump will miss a real one. So these
 * streams are a floor, not a substitute: passing them is necessary and nowhere
 * near sufficient, and the README says so.
 */

export const SYNTH_FPS = 30;

/** A plausible body in normalised image units, y already flipped up-positive. */
export const BODY = {
  torso: 0.2,
  hipY: -0.55,
  centerX: 0.5,
  /** Knees sit below the hips by this much when standing. */
  kneeBelowHip: 0.3,
};

export const SYNTH_CAL: Calibration = {
  hipY: BODY.hipY,
  shoulderY: BODY.hipY + BODY.torso,
  torso: BODY.torso,
  centerX: BODY.centerX,
  kneeY: BODY.hipY - BODY.kneeBelowHip,
  noise: 0.004,
  samples: 150,
};

type Opts = {
  /** Steps per minute while running in place. 0 stands still. */
  spm?: number;
  /** Deterministic jitter amplitude, in torso lengths. */
  jitter?: number;
  seed?: number;
};

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A stream of frames. `motion` may add displacement on top of the idle or
 * running body, which is how deliberate gestures are layered onto a run.
 */
export function stream(
  seconds: number,
  opts: Opts = {},
  motion: (t: number) => Partial<{ dHipY: number; dHipX: number; dShoulderY: number }> = () => ({})
): Frame[] {
  const { spm = 0, jitter = 0.004, seed = 7 } = opts;
  const r = rng(seed);
  const T = BODY.torso;
  const out: Frame[] = [];
  const n = Math.round(seconds * SYNTH_FPS);

  for (let i = 0; i < n; i++) {
    const t = i / SYNTH_FPS;
    const m = motion(t);

    // Running in place: knees alternate, and the hips and shoulders bob a
    // little with each step. The bob is the thing that makes a naive jump
    // detector fire, so it is deliberately present.
    // One sine cycle produces two steps, one per leg, so the cycle rate is half
    // the step rate. Using spm/60 here made a requested 160spm actually 320.
    const cycleHz = spm / 120;
    const phase = 2 * Math.PI * cycleHz * t;
    const lift = spm > 0 ? 0.36 * T : 0;
    const leftLift = spm > 0 ? Math.max(0, Math.sin(phase)) * lift : 0;
    const rightLift = spm > 0 ? Math.max(0, Math.sin(phase + Math.PI)) * lift : 0;
    const bob = spm > 0 ? Math.sin(phase * 2) * 0.035 * T : 0;

    const j = () => (r() - 0.5) * 2 * jitter * T;

    const hipY = BODY.hipY + bob + j() + (m.dHipY ?? 0);
    const shoulderY = BODY.hipY + T + bob * 0.7 + j() + (m.dShoulderY ?? 0);

    out.push({
      t,
      hipY,
      shoulderY,
      leftKneeY: BODY.hipY - BODY.kneeBelowHip + leftLift + j(),
      rightKneeY: BODY.hipY - BODY.kneeBelowHip + rightLift + j(),
      hipX: BODY.centerX + j() + (m.dHipX ?? 0),
      confidence: 0.95,
    });
  }
  return out;
}

/** A bell-shaped pulse of `amp`, centred at `at`, lasting `dur` seconds. */
export function pulse(t: number, at: number, dur: number, amp: number): number {
  const x = (t - at) / dur;
  if (x < 0 || x > 1) return 0;
  return Math.sin(x * Math.PI) * amp;
}

/** A displacement that ramps to `amp` over `dur` and stays there. */
export function shift(t: number, at: number, dur: number, amp: number): number {
  if (t < at) return 0;
  const x = Math.min(1, (t - at) / dur);
  return amp * (1 - Math.cos(x * Math.PI)) / 2;
}
