/**
 * §4: "33 landmarks. Only about 10 landmarks are needed: shoulders, hips,
 * knees, ankles, nose."
 *
 * Indices are MediaPipe Pose's. Naming them here keeps the magic numbers in one
 * place and makes the gesture code readable.
 */
export const LM = {
  nose: 0,
  leftShoulder: 11,
  rightShoulder: 12,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
} as const;

export type Landmark = { x: number; y: number; visibility?: number };

/**
 * A pose frame in *our* convention, not MediaPipe's.
 *
 * MediaPipe returns normalised image coordinates with y increasing downward.
 * Every gesture in §3 is described in terms of things going up or down --
 * "hip midpoint Y rises above baseline", "shoulder Y dropping" -- so the sign
 * is flipped once here, at the boundary. Doing it anywhere else means every
 * threshold in the codebase has to be read twice to work out which way is up.
 */
export type Frame = {
  /** Seconds, monotonic. */
  t: number;
  /** Up-positive, normalised to image height. */
  hipY: number;
  shoulderY: number;
  leftKneeY: number;
  rightKneeY: number;
  /** Right-positive, normalised to image width. */
  hipX: number;
  /** Mean visibility of the landmarks we actually use (§6 low-confidence). */
  confidence: number;
};

const vis = (l: Landmark | undefined) => (l?.visibility ?? 1);

/** Convert a raw MediaPipe landmark array into a Frame. Returns null if the
 *  landmarks we depend on are missing. */
export function toFrame(landmarks: Landmark[] | undefined, t: number): Frame | null {
  if (!landmarks || landmarks.length < 29) return null;
  const g = (i: number) => landmarks[i];
  const need = [LM.leftShoulder, LM.rightShoulder, LM.leftHip, LM.rightHip, LM.leftKnee, LM.rightKnee];
  if (need.some((i) => !g(i))) return null;

  const mid = (a: number, b: number, k: "x" | "y") => (g(a)[k] + g(b)[k]) / 2;

  return {
    t,
    // y is flipped here and nowhere else.
    hipY: -mid(LM.leftHip, LM.rightHip, "y"),
    shoulderY: -mid(LM.leftShoulder, LM.rightShoulder, "y"),
    leftKneeY: -g(LM.leftKnee).y,
    rightKneeY: -g(LM.rightKnee).y,
    hipX: mid(LM.leftHip, LM.rightHip, "x"),
    confidence:
      need.reduce((s, i) => s + vis(g(i)), 0) / need.length,
  };
}

/** Pick the largest person in frame (§6: "track the largest bounding box,
 *  which is normally the closest person"). */
export function largestPose(poses: Landmark[][]): Landmark[] | null {
  if (!poses.length) return null;
  let best = poses[0];
  let bestArea = -1;
  for (const p of poses) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const l of p) {
      minX = Math.min(minX, l.x); maxX = Math.max(maxX, l.x);
      minY = Math.min(minY, l.y); maxY = Math.max(maxY, l.y);
    }
    const area = (maxX - minX) * (maxY - minY);
    if (area > bestArea) { bestArea = area; best = p; }
  }
  return best;
}
