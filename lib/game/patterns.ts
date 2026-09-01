import type { Obstacle, Coin, ObstacleKind } from "./types";
import { MIN_GAP_M, LANE_COUNT, LOW_BARRIER_HEIGHT } from "./constants";

/**
 * §4: "Obstacles are spawned from a seeded pattern generator, not fully random,
 * so difficulty is tunable and runs are comparable."
 *
 * Two properties this generator guarantees rather than hopes for, both tested:
 *
 *  1. **Spacing.** Consecutive obstacle events are at least MIN_GAP_M apart,
 *     measured from the *end* of the previous one. A train occupies a lane for
 *     several seconds (§5), so measuring from its start would put the next
 *     obstacle inside it.
 *
 *  2. **Survivability.** At most two of the three lanes are ever blocked at the
 *     same point on the track. A pattern the player cannot pass is not
 *     difficulty, it is a bug, and with a seeded generator it would be a bug
 *     that reproduces for everyone on the same seed.
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LENGTH: Record<ObstacleKind, number> = {
  low: 1.2,
  overhead: 1.2,
  block: 1.6,
  // §5: "train-style long obstacle occupying one lane for several seconds".
  // At the speed cap this is a little over a second of cover; it reads as long
  // because you cannot re-enter the lane behind it.
  train: 34,
};

/**
 * Difficulty is expressed as which patterns are *available*, not as tighter
 * spacing. Spacing has a floor set by §5 and squeezing it is the one thing
 * that is not allowed to make the game harder.
 */
function difficultyAt(z: number): number {
  if (z < 260) return 0;
  if (z < 700) return 1;
  if (z < 1500) return 2;
  return 3;
}

export class TrackGenerator {
  private rng: () => number;
  private cursorZ = 45; // a short run-up: enough to get moving, not a wait
  private nextId = 1;
  readonly obstacles: Obstacle[] = [];
  readonly coins: Coin[] = [];

  constructor(readonly seed: number) {
    this.rng = mulberry32(seed);
  }

  /** Extend the track deterministically until it reaches `z`. */
  generateTo(z: number) {
    while (this.cursorZ < z) this.emit();
  }

  private emit() {
    const z = this.cursorZ;
    const d = difficultyAt(z);
    const r = this.rng();

    // A pair blocks two lanes and forces one specific lane. Only at the top
    // difficulty, and never more than two -- see the survivability invariant.
    const wantPair = d >= 3 && r < 0.18;

    if (wantPair) {
      const free = Math.floor(this.rng() * LANE_COUNT);
      const lanes = [0, 1, 2].filter((l) => l !== free);
      for (const lane of lanes) {
        this.obstacles.push({ id: this.nextId++, kind: "block", lane, z, length: LENGTH.block });
      }
      this.cursorZ = z + LENGTH.block + this.gap();
      return;
    }

    const kind = this.pickKind(d, this.rng());
    const lane = Math.floor(this.rng() * LANE_COUNT);
    const length = LENGTH[kind];
    this.obstacles.push({ id: this.nextId++, kind, lane, z, length });

    // §5: "Coins in arcs along the lane, rewarding the jump path." An arc over
    // a low barrier pays for the jump the barrier already demanded, which is
    // what makes the reward feel like a reward rather than a pickup.
    if (kind === "low" && this.rng() < 0.75) this.arcOver(z, lane);
    else if (this.rng() < 0.3) this.groundRun(z + length + 6, lane);

    this.cursorZ = z + length + this.gap();
  }

  private pickKind(difficulty: number, r: number): ObstacleKind {
    // Early track is jump-and-duck only: lane changes are the hardest gesture
    // to perform and the easiest to misfire (§3's jump-vs-lateral-hop
    // arbitration), so they arrive once the player has found their footing.
    if (difficulty === 0) return r < 0.6 ? "low" : "overhead";
    if (difficulty === 1) return r < 0.4 ? "low" : r < 0.72 ? "overhead" : "block";
    if (difficulty === 2) return r < 0.32 ? "low" : r < 0.6 ? "overhead" : r < 0.88 ? "block" : "train";
    return r < 0.26 ? "low" : r < 0.5 ? "overhead" : r < 0.78 ? "block" : "train";
  }

  /** Extra metres beyond the floor, so the rhythm is not metronomic. */
  private gap(): number {
    return MIN_GAP_M + this.rng() * 11;
  }

  private arcOver(z: number, lane: number) {
    const n = 5;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      this.coins.push({
        id: this.nextId++,
        lane,
        z: z - 3 + t * 7,
        // The arc peaks above standing reach (chest 1.05m + 0.55m = 1.6m) and
        // inside jump reach (apex adds ~1.2m). That gap is what makes the arc
        // a reward for jumping rather than a decoration on the ground.
        y: LOW_BARRIER_HEIGHT + 0.85 + Math.sin(t * Math.PI) * 0.6,
        taken: false,
      });
    }
  }

  private groundRun(z: number, lane: number) {
    for (let i = 0; i < 4; i++) {
      this.coins.push({ id: this.nextId++, lane, z: z + i * 2.2, y: 0.9, taken: false });
    }
  }
}

/** Lanes fully blocked at a point on the track. Only block/train count: a low
 *  barrier is passable by jumping and an overhead by ducking. */
export function blockedLanesAt(obstacles: Obstacle[], z: number): Set<number> {
  const out = new Set<number>();
  for (const o of obstacles) {
    if (o.kind !== "block" && o.kind !== "train") continue;
    if (z >= o.z && z <= o.z + o.length) out.add(o.lane);
  }
  return out;
}
