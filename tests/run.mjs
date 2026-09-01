// §5 and §3 as executable constraints.
//
// The PRD's numbers are not decoration: the 700ms reaction floor and the speed
// cap are a single relationship, and a change to either that breaks the other
// should fail here rather than in someone's living room.
import { execSync } from "node:child_process";
import path from "node:path";
execSync("node scripts/build-tests.mjs", { cwd: path.resolve(import.meta.dirname, "..") });
const G = await import("./.bundle.mjs");

let pass = 0;
const fails = [];
let group = "";
const describe = (n) => { group = n; console.log(`\n${n}`); };
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(`${group} / ${name}${detail ? ` -- ${detail}` : ""}`); console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}`); }
}

/**
 * Run the engine forward at a fixed timestep. The action callback gets the
 * state, not just the clock: speed ramps with distance, so timing an input
 * from the wall clock lands somewhere different every run -- which is what
 * made the first version of the jump and duck tests fail against a correct
 * engine.
 */
function simulate(state, seconds, actionsAt = () => [], cadence = 1, dt = 1 / 60) {
  for (let t = 0; t < seconds; t += dt) {
    G.step(state, { dt, actions: actionsAt(state, t), cadenceMult: cadence });
    if (state.status === "dead") break;
  }
  return state;
}

/** Fire once, when the player is `metres` short of `z`. */
function whenApproaching(z, metres, action) {
  let fired = false;
  return (s) => {
    if (!fired && s.distance >= z - metres) { fired = true; return [action]; }
    return [];
  };
}

describe("§5: the speed cap and the reaction floor are one relationship");
{
  ok("the cap is derived from the gap and the 700ms floor",
     Math.abs(G.MAX_SPEED - G.MIN_GAP_M / G.MIN_REACTION_S) < 1e-9,
     `${G.MAX_SPEED} vs ${G.MIN_GAP_M / G.MIN_REACTION_S}`);

  // The failure this guards: capping the *base* speed instead of the result,
  // so a 1.3x cadence sprint quietly exceeds the cap.
  ok("a 1.3x cadence sprint at full ramp never exceeds the cap",
     G.speedFor(1e6, 1.3) <= G.MAX_SPEED + 1e-9, String(G.speedFor(1e6, 1.3)));
  ok("cadence below the floor still moves the player", G.speedFor(0, 0.1) > 0);
  ok("cadence multiplier is clamped to §3's 0.5-1.3",
     G.speedFor(0, 99) === G.speedFor(0, 1.3) && G.speedFor(0, 0) === G.speedFor(0, 0.5));

  ok("the reaction window at the cap meets §5's floor",
     G.reactionWindow(G.MIN_GAP_M, G.MAX_SPEED) >= G.MIN_REACTION_S - 1e-9,
     `${G.reactionWindow(G.MIN_GAP_M, G.MAX_SPEED)}s`);
}

describe("§4/§5: the seeded track is spaced, survivable and reproducible");
{
  const gen = new G.TrackGenerator(1234);
  gen.generateTo(9000);
  const obs = [...gen.obstacles].sort((a, b) => a.z - b.z);
  ok("the generator produces a long track", obs.length > 200, String(obs.length));

  // Events at the same z are a deliberate pair; the gap rule applies between
  // distinct events, measured from the end of the previous one.
  const events = [];
  for (const o of obs) {
    const last = events[events.length - 1];
    if (last && Math.abs(last.z - o.z) < 1e-9) { last.end = Math.max(last.end, o.z + o.length); continue; }
    events.push({ z: o.z, end: o.z + o.length });
  }
  let worstGap = Infinity, worstAt = -1;
  for (let i = 1; i < events.length; i++) {
    const gap = events[i].z - events[i - 1].end;
    if (gap < worstGap) { worstGap = gap; worstAt = events[i].z; }
  }
  ok("every gap clears §5's minimum", worstGap >= G.MIN_GAP_M - 1e-9,
     `worst ${worstGap.toFixed(2)}m at z=${worstAt.toFixed(0)}`);
  ok("every gap gives 700ms even at the cap",
     G.reactionWindow(worstGap, G.MAX_SPEED) >= G.MIN_REACTION_S - 1e-9,
     `${G.reactionWindow(worstGap, G.MAX_SPEED).toFixed(3)}s`);

  // A track with all three lanes blocked is unpassable, and on a seeded
  // generator it is unpassable identically for everyone.
  let worstBlocked = 0;
  for (let z = 0; z < 9000; z += 0.5) {
    worstBlocked = Math.max(worstBlocked, G.blockedLanesAt(obs, z).size);
  }
  ok("at most two lanes are ever blocked at once", worstBlocked <= 2, `saw ${worstBlocked}`);

  const again = new G.TrackGenerator(1234);
  again.generateTo(9000);
  ok("the same seed reproduces the same track",
     JSON.stringify(again.obstacles) === JSON.stringify(gen.obstacles));
  const other = new G.TrackGenerator(9999);
  other.generateTo(9000);
  ok("a different seed gives a different track",
     JSON.stringify(other.obstacles) !== JSON.stringify(gen.obstacles));
}

describe("§5: the input-lag budget has to fit inside the gesture windows");
{
  // The obstacle is 1.4m long; the binding case is the slowest speed, where it
  // takes longest to cross.
  const jl = G.jumpLatitude(1.4, G.START_SPEED);
  const dl = G.duckLatitude(1.4, G.START_SPEED);
  ok("a jump has room for the whole lag budget, with margin",
     jl > G.MAX_INPUT_LAG_S * 2, `${(jl * 1000).toFixed(0)}ms vs ${G.MAX_INPUT_LAG_S * 1000}ms budget`);
  ok("a duck has room for the whole lag budget, with margin",
     dl > G.MAX_INPUT_LAG_S * 2, `${(dl * 1000).toFixed(0)}ms`);
  ok("the arc still clears at the speed cap", G.jumpLatitude(1.4, G.MAX_SPEED) > G.MAX_INPUT_LAG_S * 2);
}

describe("§5: obstacles do what their name says");
{
  const at = (kind, lane = 1, z = 140) => {
    const s = G.newRun(7);
    s.obstacles.length = 0;
    s.coinsOnTrack.length = 0;
    s.obstacles.push({ id: 1, kind, lane, z, length: kind === "train" ? 34 : 1.4 });
    // Freeze the generator so it cannot add anything else to the track.
    s.gen.generateTo = () => {};
    return s;
  };

  ok("running into a low barrier kills you", simulate(at("low"), 30).killedBy === "low");
  {
    const s = at("low");
    simulate(s, 30, whenApproaching(140, 4, "jump"));
    ok("jumping clears a low barrier", s.status === "running", String(s.killedBy));
  }
  ok("running into an overhead barrier kills you", simulate(at("overhead"), 30).killedBy === "overhead");
  {
    const s = at("overhead");
    simulate(s, 30, whenApproaching(140, 3, "duck"));
    ok("ducking clears an overhead barrier", s.status === "running", String(s.killedBy));
  }
  {
    const s = at("block");
    simulate(s, 30, whenApproaching(140, 30, "left"));
    ok("changing lane clears a block", s.status === "running", String(s.killedBy));
  }
  ok("jumping does not save you from a block",
     simulate(at("block"), 30, whenApproaching(140, 4, "jump")).killedBy === "block");
  ok("a train is not jumpable either",
     simulate(at("train"), 30, whenApproaching(140, 4, "jump")).killedBy === "train");
}

describe("§3: input arbitration");
{
  const fresh = () => { const s = G.newRun(3); s.gen.generateTo = () => {}; s.obstacles.length = 0; return s; };
  {
    // §3: "if X displacement exceeds the lane threshold, treat it as a lane
    // change with a jump animation... Do not fire both."
    const s = fresh();
    G.step(s, { dt: 1 / 60, actions: ["jumpLeft"], cadenceMult: 1 });
    ok("a sideways hop changes lane and jumps as one event",
       s.player.lane === 0 && s.player.airborne, `lane ${s.player.lane} air ${s.player.airborne}`);
  }
  {
    const s = fresh();
    G.step(s, { dt: 1 / 60, actions: ["left"], cadenceMult: 1 });
    G.step(s, { dt: 1 / 60, actions: ["left"], cadenceMult: 1 });
    ok("lane changes clamp at the edge of the track", s.player.lane === 0, String(s.player.lane));
  }
  {
    const s = fresh();
    G.step(s, { dt: 1 / 60, actions: ["jump"], cadenceMult: 1 });
    G.step(s, { dt: 1 / 60, actions: ["duck"], cadenceMult: 1 });
    ok("you cannot duck in mid-air", s.player.duckFor === 0);
  }
  {
    const s = fresh();
    G.step(s, { dt: 1 / 60, actions: ["jump"], cadenceMult: 1 });
    const vy = s.player.vy;
    G.step(s, { dt: 1 / 60, actions: ["jump"], cadenceMult: 1 });
    ok("a second jump in mid-air does nothing", s.player.vy < vy);
  }
}

describe("§5: coins reward the jump path");
{
  const withCoin = (y) => {
    const s = G.newRun(11);
    s.gen.generateTo = () => {};
    s.obstacles.length = 0;
    s.coinsOnTrack.length = 0;
    s.coinsOnTrack.push({ id: 1, lane: 1, z: 120, y, taken: false });
    return s;
  };

  // The arc sits above standing reach and inside jump reach. That gap is the
  // whole mechanic; without it the arc pays out for doing nothing.
  const arcY = G.CHEST_HEIGHT + G.COIN_REACH + 0.5;
  ok("an arc coin is out of reach on the ground", simulate(withCoin(arcY), 30).coins === 0);

  const jumped = simulate(withCoin(arcY), 30, whenApproaching(120, 4, "jump"));
  ok("jumping collects the arc coin", jumped.coins === 1, String(jumped.coins));

  const low = simulate(withCoin(0.9), 30);
  ok("a ground coin is collected by running through it", low.coins === 1, String(low.coins));

  const once = withCoin(0.9);
  simulate(once, 30);
  const after = once.coins;
  for (let i = 0; i < 5; i++) G.step(once, { dt: 1 / 60, actions: [], cadenceMult: 1 });
  ok("a coin is collected only once", once.coins === after && after === 1, `${after} then ${once.coins}`);
}

describe("the run ends, and the score is the distance");
{
  const s = G.newRun(42);
  simulate(s, 120);
  ok("an unattended run eventually dies", s.status === "dead");
  ok("score counts metres plus coins",
     G.scoreOf(s) === Math.floor(s.distance) + s.coins * G.COIN_POINTS);
  ok("no lives, no continues: death is terminal (§5)", (() => {
    const before = s.distance;
    G.step(s, { dt: 1 / 60, actions: ["jump"], cadenceMult: 1 });
    return s.distance === before;
  })());
}

describe("the game is actually playable (§2: 60-180s sessions)");
{
  /**
   * A deliberately simple policy: look a fixed distance ahead, react to what is
   * in the current lane, and pick a free lane when blocked. If a policy this
   * plain cannot survive, the patterns are unfair rather than difficult -- and
   * on a seeded generator they would be unfair identically for everyone.
   *
   * It also stands in for the playtest the PRD asks for and I cannot run: it
   * cannot tell me how the game *feels*, but it can tell me the track is
   * passable at every speed the ramp reaches.
   */
  function policy(s) {
    const here = s.distance;
    const lane = s.player.lane;
    const soon = s.obstacles
      .filter((o) => o.z + o.length > here && o.z - here < 34)
      .sort((a, b) => a.z - b.z);

    const inLane = soon.filter((o) => o.lane === lane);
    const next = inLane[0];
    if (!next) return [];

    const metresAway = next.z - here;
    const secondsAway = metresAway / s.speed;

    if (next.kind === "low") {
      // Jump so the arc is up on arrival: the rise takes about 0.2s.
      return secondsAway < 0.34 && !s.player.airborne ? ["jump"] : [];
    }
    if (next.kind === "overhead") {
      return secondsAway < 0.3 && s.player.duckFor <= 0 ? ["duck"] : [];
    }
    // Blocked: head for the nearest lane that clears *this* obstacle.
    if (metresAway > 24) return [];
    // Only obstacles overlapping the immediate threat count. Treating
    // everything within 34m as simultaneous made the policy believe all three
    // lanes were blocked whenever two distant obstacles happened to sit in the
    // other two, and it froze rather than moving.
    const threatEnd = next.z + next.length;
    const blocking = new Set(
      soon
        .filter((o) => (o.kind === "block" || o.kind === "train") && o.z <= threatEnd && o.z + o.length >= next.z)
        .map((o) => o.lane)
    );
    const free = [0, 1, 2].filter((l) => !blocking.has(l));
    if (!free.length) return [];
    // Step toward the nearest free lane: a paired block can leave the only open
    // lane two steps away.
    free.sort((a, b) => Math.abs(a - lane) - Math.abs(b - lane));
    const target = free[0];
    if (target === lane) return [];
    return [target < lane ? "left" : "right"];
  }

  const lasted = [];
  const deaths = [];
  let totalCoins = 0;
  const RUNS = 8;
  for (let seed = 1; seed <= RUNS; seed++) {
    const s = G.newRun(seed * 977);
    simulate(s, 200, policy);
    lasted.push(s.elapsed);
    totalCoins += s.coins;
    if (s.status === "dead") {
      deaths.push(`${s.killedBy}@${s.distance.toFixed(0)}m/${s.elapsed.toFixed(0)}s`);
    }
  }
  // §2: "Typical target session: 60 to 180 seconds per run." The floor is the
  // assertion worth making -- a game a competent policy survives *forever* is
  // not hard enough, so the interesting property is that nobody is killed early
  // by an unfair pattern, not that nobody is killed at all.
  ok("no seed kills a competent policy inside §2's 60s floor",
     lasted.every((t) => t >= 60), `shortest ${Math.min(...lasted).toFixed(0)}s; deaths: ${deaths.join(", ")}`);
  ok("runs do end, so the difficulty curve arrives (§2's 180s ceiling)",
     lasted.some((t) => t < 200), `longest ${Math.max(...lasted).toFixed(0)}s`);

  // The ramp is a pure function; testing it through a run only measures where
  // that run happened to die.
  ok("the ramp reaches the cap by its stated distance",
     Math.abs(G.speedFor(G.RAMP_DISTANCE_M, 1) - G.MAX_SPEED) < 1e-9,
     `${G.speedFor(G.RAMP_DISTANCE_M, 1).toFixed(2)}`);
  ok("coins are collectable while surviving", totalCoins > 0, String(totalCoins));
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log("\nFailures:"); fails.forEach((f) => console.log(" - " + f)); process.exit(1); }
