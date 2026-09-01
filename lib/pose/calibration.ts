import type { Frame } from "./landmarks";

/**
 * §2 step 3: "a 5 second capture while the player stands still, arms at sides.
 * This records baseline hip height, shoulder height, torso length, and lateral
 * center. All gesture thresholds are derived from these, so they scale with how
 * far away the player stands."
 *
 * That last sentence is the whole reason this exists, and §3 repeats it: every
 * threshold is a fraction of torso length, so a tall player close to the camera
 * and a short player far from it produce the same gestures. A threshold in
 * normalised image units would work for exactly one person at one distance.
 */
export type Calibration = {
  hipY: number;
  shoulderY: number;
  /** Shoulder midpoint to hip midpoint. The unit everything is measured in. */
  torso: number;
  centerX: number;
  /** Standing knee height, so cadence knows what "lifted" means. */
  kneeY: number;
  /** How much the player wobbled while standing still. */
  noise: number;
  samples: number;
};

export const CALIBRATION_SECONDS = 5;

/** Below this, the capture is too noisy or too short to derive thresholds from. */
export const MIN_CALIBRATION_SAMPLES = 45;

export function calibrate(frames: Frame[]): Calibration | null {
  if (frames.length < MIN_CALIBRATION_SAMPLES) return null;
  const mean = (f: (x: Frame) => number) => frames.reduce((s, x) => s + f(x), 0) / frames.length;

  const hipY = mean((f) => f.hipY);
  const shoulderY = mean((f) => f.shoulderY);
  const torso = Math.abs(shoulderY - hipY);
  if (torso < 1e-4) return null;

  const centerX = mean((f) => f.hipX);
  const kneeY = mean((f) => (f.leftKneeY + f.rightKneeY) / 2);

  // Standing jitter, in torso units. A room with bad light produces a large
  // number here, and it is the honest input to "are the thresholds safe".
  const varY = mean((f) => (f.hipY - hipY) ** 2);
  const noise = Math.sqrt(varY) / torso;

  return { hipY, shoulderY, torso, centerX, kneeY, noise, samples: frames.length };
}

/**
 * §2 step 2, the framing check: "the player steps back until their full body
 * from head to knees fits inside the outline."
 *
 * Checked against the torso occupying a sensible share of the frame rather than
 * against absolute landmark positions, because "far enough back" is really a
 * statement about apparent size.
 */
export type Framing = { ok: boolean; reason: null | "too-close" | "too-far" | "off-center" | "no-person" };

export function checkFraming(frame: Frame | null): Framing {
  if (!frame) return { ok: false, reason: "no-person" };
  const torso = Math.abs(frame.shoulderY - frame.hipY);
  if (torso > 0.30) return { ok: false, reason: "too-close" };
  if (torso < 0.11) return { ok: false, reason: "too-far" };
  if (Math.abs(frame.hipX - 0.5) > 0.22) return { ok: false, reason: "off-center" };
  return { ok: true, reason: null };
}

export const FRAMING_HELP: Record<NonNullable<Framing["reason"]>, string> = {
  "no-person": "Step into the frame",
  "too-close": "Step back",
  "too-far": "Step closer",
  "off-center": "Move to the middle",
};
