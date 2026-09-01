/**
 * §5's tuning numbers, and the one relationship between them that is not
 * negotiable.
 *
 * §5: "Minimum reaction window per obstacle should be at least 700ms at max
 * speed", against a budget of "roughly 150 to 250ms of total input lag".
 *
 * That makes the speed cap a *consequence* of the obstacle spacing rather than
 * an independent knob: window = gap / speed, so capping speed at
 * MIN_GAP_M / MIN_REACTION_S is the only way the constraint holds by
 * construction. §5 also says the cap "is the key tuning number; find it by
 * playtest, not by theory" -- so the number below is a ceiling derived from the
 * PRD's own constraint, not a playtested value, and it is expected to come
 * down. What playtesting must not do is raise it without also widening the gap.
 */

/** Metres between consecutive obstacle events. A design choice. */
export const MIN_GAP_M = 17;

/** §5. Seconds of reaction the player is owed at any speed. */
export const MIN_REACTION_S = 0.7;

/** §5's cap, derived. Never raise this without raising MIN_GAP_M with it. */
export const MAX_SPEED = MIN_GAP_M / MIN_REACTION_S; // 24.28 m/s

/** Starting speed, and how far it takes to ramp to the cap. */
export const START_SPEED = 9;
export const RAMP_DISTANCE_M = 1400;

/**
 * §3: "a speed multiplier from 0.5x to 1.3x driven by steps per minute".
 * The multiplier scales the ramped base speed, but the cap applies to the
 * *result* -- otherwise a 1.3x sprint at full ramp would push the reaction
 * window to 0.54s and quietly break §5's floor.
 */
export const CADENCE_MULT_MIN = 0.5;
export const CADENCE_MULT_MAX = 1.3;

/**
 * Three lanes (§5), 2.6m apart.
 *
 * Wider than a real corridor on purpose. At 1.7m the three lanes occupied about
 * 5m of track, which perspective compressed into a sliver -- obstacles were a
 * few dozen pixels at the distance §5 needs them recognisable. Lane spacing is
 * a rendering decision here rather than a physical one, because the mapping
 * from a real side-step to a lane change is set by calibration (§3), not by
 * these metres.
 */
export const LANES = [-2.6, 0, 2.6] as const;
export const LANE_COUNT = 3;

/** How long a lane change takes to complete, in seconds. */
export const LANE_CHANGE_S = 0.18;

/**
 * §5 budgets "roughly 150 to 250ms of total input lag (camera exposure,
 * inference, filtering, arbitration)". That number is not only about obstacle
 * spacing -- it also sets how forgiving the *jump arc itself* has to be.
 *
 * The timing latitude for a jump is how long the player is above the barrier,
 * minus how long the barrier takes to cross. The first arc here (v=6.4, g=17
 * over an 0.85m barrier) gave 276ms of latitude, so a 250ms lag spike consumed
 * essentially all of it and a correctly-timed body jump would still clip. A
 * keyboard player would barely notice; a camera player would conclude the
 * tracker was broken, which §1 names as the thing to avoid ("failures feel like
 * the player's fault, not the tracker's").
 *
 * A lower barrier and a floatier arc give ~640ms, comfortably clear of the
 * budget. Floaty is also the right feel here: the player is physically jumping,
 * and the character should stay up about as long as they do.
 */
export const MAX_INPUT_LAG_S = 0.25;

export const JUMP_VELOCITY = 6.0;
export const GRAVITY = 12;
export const LOW_BARRIER_HEIGHT = 0.6;

/** §3: "ducking can afford a small hold". How long a duck lasts once fired. */
export const DUCK_S = 0.75;
export const OVERHEAD_CLEARANCE = 1.15;
export const DUCK_HEIGHT = 0.75;

/** Player collision box, roughly a standing adult. */
export const PLAYER_HALF_WIDTH = 0.5;
export const PLAYER_HEIGHT = 1.75;

/** How far ahead obstacles exist. Beyond this they are not yet spawned. */
export const SPAWN_AHEAD_M = 220;
export const DESPAWN_BEHIND_M = 12;

/**
 * Coin pickup is a band around the player's chest, not their whole body.
 *
 * Testing the full 0-1.75m standing box meant an arc coin at 1.6m was
 * collected while standing, which defeats §5's "coins in arcs... rewarding the
 * jump path" entirely -- the arc paid out without the jump. A chest-centred
 * reach is also just how a pickup volume should work: you collect what you run
 * through, not what is at your ankles.
 */
export const CHEST_HEIGHT = 1.05;
export const COIN_REACH = 0.55;

/** Score: metres are the unit, coins are a bonus (§2 score screen). */
export const COIN_POINTS = 10;
