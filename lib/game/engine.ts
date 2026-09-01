import type { RunState, Tick, Action, Obstacle } from "./types";
import { TrackGenerator } from "./patterns";
import {
  MAX_SPEED, START_SPEED, RAMP_DISTANCE_M, LANES, LANE_COUNT, LANE_CHANGE_S,
  JUMP_VELOCITY, GRAVITY, LOW_BARRIER_HEIGHT, DUCK_S, OVERHEAD_CLEARANCE,
  DUCK_HEIGHT, PLAYER_HALF_WIDTH, PLAYER_HEIGHT, SPAWN_AHEAD_M, DESPAWN_BEHIND_M,
  COIN_POINTS, CADENCE_MULT_MIN, CADENCE_MULT_MAX, CHEST_HEIGHT, COIN_REACH,
} from "./constants";

/**
 * The whole game, as a pure step function.
 *
 * Nothing here knows about three.js, the DOM, or where the input came from --
 * §7 builds the keyboard game first precisely so game feel can be tuned
 * independently of the tracker, and that separation only holds if the rules
 * live somewhere the renderer cannot reach. It also makes §5's constraints
 * testable by stepping the engine rather than by playing it.
 */

export function newRun(seed: number): RunState & { gen: TrackGenerator } {
  const gen = new TrackGenerator(seed);
  gen.generateTo(SPAWN_AHEAD_M);
  return {
    status: "running",
    distance: 0,
    coins: 0,
    speed: START_SPEED,
    cadenceMult: 1,
    player: { lane: 1, x: LANES[1], y: 0, vy: 0, airborne: false, duckFor: 0 },
    obstacles: gen.obstacles,
    coinsOnTrack: gen.coins,
    killedBy: null,
    elapsed: 0,
    events: [],
    gen,
  };
}

/**
 * §3 / §5: the base speed ramps with distance, cadence scales it, and the cap
 * applies to the *result*. Capping the base instead would let a 1.3x sprint at
 * full ramp reach 31.5 m/s, which is a 0.54s reaction window -- under §5's
 * 700ms floor. The cap is the last thing applied for that reason.
 */
export function speedFor(distance: number, cadenceMult: number): number {
  const t = Math.min(1, distance / RAMP_DISTANCE_M);
  const base = START_SPEED + (MAX_SPEED - START_SPEED) * t;
  const mult = Math.min(CADENCE_MULT_MAX, Math.max(CADENCE_MULT_MIN, cadenceMult));
  return Math.min(MAX_SPEED, base * mult);
}

/** The reaction window a player actually gets between two obstacle events. */
export function reactionWindow(gapMetres: number, speed: number): number {
  return gapMetres / speed;
}

/**
 * How much slack the player has on the *timing* of a jump: seconds spent above
 * the barrier, minus the seconds the barrier takes to pass. Must stay well
 * clear of §5's input-lag budget or a correct input still clips.
 */
export function jumpLatitude(obstacleLength: number, speed: number): number {
  const above = (2 * Math.sqrt(JUMP_VELOCITY ** 2 - 2 * GRAVITY * LOW_BARRIER_HEIGHT)) / GRAVITY;
  return above - obstacleLength / speed;
}

/** The same slack for a duck, which is a held pose rather than an arc (§3). */
export function duckLatitude(obstacleLength: number, speed: number): number {
  return DUCK_S - obstacleLength / speed;
}

export function step(state: RunState & { gen: TrackGenerator }, tick: Tick): void {
  if (state.status !== "running") return;
  const { dt } = tick;
  const p = state.player;

  state.events.length = 0;
  state.elapsed += dt;
  state.cadenceMult = tick.cadenceMult;
  state.speed = speedFor(state.distance, tick.cadenceMult);
  state.distance += state.speed * dt;

  applyActions(state, tick.actions);

  // Vertical. A jump is instant and ballistic (§3: "Jumping is instant").
  if (p.airborne) {
    p.vy -= GRAVITY * dt;
    p.y += p.vy * dt;
    if (p.y <= 0) { p.y = 0; p.vy = 0; p.airborne = false; }
  }
  if (p.duckFor > 0) p.duckFor = Math.max(0, p.duckFor - dt);

  // Lateral: ease toward the target lane rather than snapping, so a lane change
  // has a travel time an obstacle can catch you inside of.
  const targetX = LANES[p.lane];
  const maxMove = (Math.abs(LANES[1] - LANES[0]) / LANE_CHANGE_S) * dt;
  p.x += Math.max(-maxMove, Math.min(maxMove, targetX - p.x));

  state.gen.generateTo(state.distance + SPAWN_AHEAD_M);
  collect(state);
  collide(state);
  prune(state);
}

function applyActions(state: RunState, actions: Action[]) {
  const p = state.player;
  for (const a of actions) {
    switch (a) {
      case "left":
      case "right":
        p.lane = clampLane(p.lane + (a === "left" ? -1 : 1));
        break;
      // §3: a sideways hop is one event, not two. The arbitration that decides
      // this lives in the gesture layer; the engine just honours the verdict --
      // "Do not fire both" has to be true of the input, not patched up here.
      case "jumpLeft":
      case "jumpRight":
        p.lane = clampLane(p.lane + (a === "jumpLeft" ? -1 : 1));
        if (!p.airborne) { p.airborne = true; p.vy = JUMP_VELOCITY; p.duckFor = 0; }
        break;
      case "jump":
        if (!p.airborne) { p.airborne = true; p.vy = JUMP_VELOCITY; p.duckFor = 0; }
        break;
      case "duck":
        // Ducking mid-air would let a player dodge an overhead barrier they had
        // already jumped over, which reads as a glitch rather than a skill.
        if (!p.airborne) p.duckFor = DUCK_S;
        break;
    }
  }
}

const clampLane = (l: number) => Math.max(0, Math.min(LANE_COUNT - 1, l));

/** Height of the player's head right now, which is what overhead bars test. */
function headHeight(state: RunState): number {
  const p = state.player;
  return (p.duckFor > 0 ? DUCK_HEIGHT : PLAYER_HEIGHT) + p.y;
}

function overlapsLane(state: RunState, o: Obstacle): boolean {
  // Compare against the player's actual x, not their target lane: a player
  // caught mid-change is in both lanes a little, and clipping the corner of a
  // block should hurt.
  return Math.abs(state.player.x - LANES[o.lane]) < PLAYER_HALF_WIDTH + 0.5;
}

function collide(state: RunState) {
  const z = state.distance;
  for (const o of state.obstacles) {
    if (z < o.z || z > o.z + o.length) continue;
    if (!overlapsLane(state, o)) continue;

    let hit = false;
    if (o.kind === "low") hit = state.player.y < LOW_BARRIER_HEIGHT;
    else if (o.kind === "overhead") hit = headHeight(state) > OVERHEAD_CLEARANCE;
    else hit = true; // block and train are only passed by not being there

    if (hit) {
      state.status = "dead";
      state.killedBy = o.kind;
      state.events.push("collision");
      return;
    }

    // Survived something you were inside of. §2 wants this cue specifically:
    // it tells the player the gesture landed *and* that it was close, which is
    // what makes them commit earlier next time.
    if (o.kind === "low" || o.kind === "overhead") state.events.push("nearMiss");
  }
}

function collect(state: RunState) {
  const z = state.distance;
  const p = state.player;
  for (const c of state.coinsOnTrack) {
    if (c.taken) continue;
    if (Math.abs(c.z - z) > 1.1) continue;
    if (Math.abs(p.x - LANES[c.lane]) > PLAYER_HALF_WIDTH + 0.35) continue;
    // A band around the chest, which rises with a jump. Using the full body
    // box put standing reach at 1.75m and handed the player every arc coin
    // without leaving the ground.
    if (Math.abs(c.y - (CHEST_HEIGHT + p.y)) > COIN_REACH) continue;
    c.taken = true;
    state.coins += 1;
    state.events.push("coin");
  }
}

function prune(state: RunState) {
  const cutoff = state.distance - DESPAWN_BEHIND_M;
  // Splice in place: the renderer holds a reference to these arrays.
  for (let i = state.obstacles.length - 1; i >= 0; i--) {
    if (state.obstacles[i].z + state.obstacles[i].length < cutoff) state.obstacles.splice(i, 1);
  }
  for (let i = state.coinsOnTrack.length - 1; i >= 0; i--) {
    if (state.coinsOnTrack[i].z < cutoff) state.coinsOnTrack.splice(i, 1);
  }
}

export function scoreOf(state: RunState): number {
  return Math.floor(state.distance) + state.coins * COIN_POINTS;
}
