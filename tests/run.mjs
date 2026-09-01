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
  // The declared airtime has to match the arc it claims to describe, or the
  // spacing derived from it is spacing for a jump the game does not have.
  ok("the declared airtime matches the actual arc",
     Math.abs(G.JUMP_AIRTIME_S - (2 * G.JUMP_VELOCITY) / G.GRAVITY) < 1e-9,
     `${G.JUMP_AIRTIME_S} vs ${(2 * G.JUMP_VELOCITY) / G.GRAVITY}`);

  ok("spacing clears §5's reaction floor at the cap",
     G.MIN_GAP_M / G.MAX_SPEED >= G.MIN_REACTION_S - 1e-9,
     `${(G.MIN_GAP_M / G.MAX_SPEED).toFixed(3)}s`);

  /*
   * The constraint the playtest exposed: a player who jumps one obstacle must
   * be back on the ground before the next arrives. Without this the jump is a
   * trap at speed -- you clear a barrier, cannot jump again, and land inside
   * the following one.
   */
  ok("you always land before the next obstacle arrives",
     G.MIN_GAP_M / G.MAX_SPEED > G.JUMP_AIRTIME_S,
     `gap ${(G.MIN_GAP_M / G.MAX_SPEED).toFixed(3)}s vs airtime ${G.JUMP_AIRTIME_S}s`);

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
  // Scaled to the spacing rather than hard-coded: the floor is derived from the
  // speed cap, so a faster game legitimately fits fewer obstacles in 9km.
  const expected = 9000 / (G.MIN_GAP_M + 10);
  ok("the generator fills the track at the current spacing",
     obs.length > expected * 0.8, `${obs.length}, expected around ${expected.toFixed(0)}`);

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
  /*
   * There is deliberately no assertion that the policy eventually dies.
   *
   * It has perfect information and perfect reactions, so its survival measures
   * how forgiving the *track* is, not how hard the game is for a person -- and
   * tuning difficulty until a bot dies would be tuning against the wrong
   * opponent. §2's 60-180s target is a statement about humans. The fairness
   * floor above is the part a simulation can actually speak to.
   */

  // The ramp is a pure function; testing it through a run only measures where
  // that run happened to die.
  ok("the ramp reaches the cap by its stated distance",
     Math.abs(G.speedFor(G.RAMP_DISTANCE_M, 1) - G.MAX_SPEED) < 1e-9,
     `${G.speedFor(G.RAMP_DISTANCE_M, 1).toFixed(2)}`);
  ok("coins are collectable while surviving", totalCoins > 0, String(totalCoins));
}

describe("§8: the gesture layer, measured against synthetic bodies");
{
  const run = (frames, tune = {}) => {
    const d = new G.GestureDetector(G.SYNTH_CAL, { ...G.DEFAULTS, ...tune });
    const fired = [];
    for (const f of frames) for (const a of d.update(f)) fired.push({ a, t: f.t });
    return { fired, d };
  };

  // §8: "False positive rate below roughly 1 unintended gesture per 60 second
  // run." Standing still is the easy case; running in place is the real one,
  // because the hips bob and the knees rise, which is what a naive jump or
  // crouch detector fires on.
  {
    const { fired } = run(G.stream(60, { spm: 0 }));
    ok("standing still for 60s fires nothing", fired.length === 0,
       fired.map((f) => f.a).join(",") || "none");
  }
  {
    const { fired } = run(G.stream(60, { spm: 120 }));
    ok("running in place for 60s fires no unintended gesture (§8)",
       fired.length === 0, `${fired.length}: ${fired.slice(0, 6).map((f) => `${f.a}@${f.t.toFixed(1)}`).join(",")}`);
  }
  {
    // A heavy runner bobs far more than the default body. The thresholds have
    // to clear the worst case, not the average -- this is the test that stops
    // "make it more sensitive" from quietly becoming "fires while you run".
    const { fired } = run(G.stream(60, { spm: 140, bob: 0.075, jitter: 0.01 }));
    ok("a vigorous runner still fires nothing in 60s",
       fired.length === 0, `${fired.length}: ${fired.slice(0, 6).map((f) => f.a).join(",")}`);
  }

  /*
   * The gestures that were failing in play: ordinary effort, performed while
   * already running, rather than the deliberate full-amplitude movements the
   * first version of these tests used. Those passed at thresholds where a real
   * player's jump registered nothing.
   */
  {
    let hits = 0;
    for (let i = 0; i < 20; i++) {
      const frames = G.stream(4, { spm: 110, seed: 400 + i, jitter: 0.01 }, (t) => ({
        dHipY: G.pulse(t, 1.5, 0.42, 0.22 * G.BODY.torso),
      }));
      if (run(frames).fired.some((f) => f.a.startsWith("jump"))) hits++;
    }
    ok("a modest jump taken mid-run registers", hits >= 19, `${hits}/20`);
  }
  {
    let hits = 0;
    for (let i = 0; i < 20; i++) {
      const frames = G.stream(4, { spm: 110, seed: 500 + i, jitter: 0.01 }, (t) => ({
        dHipX: G.shift(t, 1.5, 0.28, (i % 2 ? 0.42 : -0.42) * G.BODY.torso),
      }));
      const f = run(frames).fired;
      if (f.some((x) => x.a === "left" || x.a === "right" || x.a.startsWith("jump"))) hits++;
    }
    ok("a modest side-step taken mid-run registers", hits >= 19, `${hits}/20`);
  }

  // §3's specific warning: "A deep knee lift while running can look like a
  // crouch. Gate crouch detection on shoulder Y dropping too, not just hips."
  {
    const frames = G.stream(6, { spm: 0 }, (t) => ({ dHipY: -G.pulse(t, 2, 0.6, 0.3 * G.BODY.torso) }));
    const { fired } = run(frames);
    ok("hips dropping without the shoulders is not a crouch (§3)",
       !fired.some((f) => f.a === "duck"), fired.map((f) => f.a).join(",") || "none");
  }
  {
    const frames = G.stream(6, { spm: 0 }, (t) => ({
      dHipY: -G.pulse(t, 2, 0.7, 0.28 * G.BODY.torso),
      dShoulderY: -G.pulse(t, 2, 0.7, 0.42 * G.BODY.torso),
    }));
    const { fired } = run(frames);
    ok("hips and shoulders dropping together is a crouch",
       fired.filter((f) => f.a === "duck").length === 1,
       fired.map((f) => f.a).join(",") || "none");
  }

  // §3: jump is a rise *with upward velocity*, which is what separates a hop
  // from standing up slowly out of a crouch.
  {
    const frames = G.stream(6, { spm: 0 }, (t) => ({ dHipY: G.pulse(t, 2, 0.42, 0.34 * G.BODY.torso) }));
    const { fired } = run(frames);
    ok("a hop fires exactly one jump",
       fired.length === 1 && fired[0].a === "jump", fired.map((f) => f.a).join(",") || "none");
  }
  {
    // Rising the same distance over four seconds is not a jump.
    const frames = G.stream(8, { spm: 0 }, (t) => ({ dHipY: G.shift(t, 1, 4, 0.34 * G.BODY.torso) }));
    const { fired } = run(frames);
    ok("standing up slowly is not a jump", !fired.some((f) => f.a === "jump"),
       fired.map((f) => f.a).join(",") || "none");
  }

  {
    const frames = G.stream(6, { spm: 0 }, (t) => ({ dHipX: G.shift(t, 2, 0.25, 0.6 * G.BODY.torso) }));
    const { fired } = run(frames);
    ok("a side step fires exactly one lane change",
       fired.length === 1 && fired[0].a === "right", fired.map((f) => f.a).join(",") || "none");
  }

  // §3: "A jump to the side is both a Y spike and an X shift... Do not fire
  // both." This is the arbitration the PRD calls out by name.
  {
    const frames = G.stream(6, { spm: 0 }, (t) => ({
      dHipY: G.pulse(t, 2, 0.42, 0.34 * G.BODY.torso),
      dHipX: G.shift(t, 2, 0.3, -0.62 * G.BODY.torso),
    }));
    const { fired } = run(frames);
    ok("a lateral hop fires one combined event, not two (§3)",
       fired.length === 1 && fired[0].a === "jumpLeft",
       fired.map((f) => f.a).join(",") || "none");
  }

  // §3: "300ms cooldown per gesture type to prevent double-fires from tracking
  // jitter."
  {
    const frames = G.stream(6, { spm: 0 }, (t) => ({
      dHipY: G.pulse(t, 2, 0.3, 0.34 * G.BODY.torso) + G.pulse(t, 2.15, 0.3, 0.34 * G.BODY.torso),
    }));
    const { fired } = run(frames);
    ok("two hops inside the cooldown fire once (§3)",
       fired.filter((f) => f.a === "jump").length === 1, String(fired.length));
  }

  // §8: "Missed gesture rate below 5% for deliberate, clearly performed inputs."
  {
    let attempts = 0, hits = 0;
    for (let i = 0; i < 20; i++) {
      const at = 1.5;
      const frames = G.stream(4, { spm: 0, seed: 100 + i, jitter: 0.008 }, (t) => ({
        dHipY: G.pulse(t, at, 0.42, 0.34 * G.BODY.torso),
      }));
      attempts++;
      if (run(frames).fired.some((f) => f.a === "jump")) hits++;
    }
    const missRate = 1 - hits / attempts;
    ok("deliberate jumps are missed under 5% of the time (§8)",
       missRate < 0.05, `${(missRate * 100).toFixed(0)}% missed (${hits}/${attempts})`);
  }
  {
    let hits = 0;
    for (let i = 0; i < 20; i++) {
      const frames = G.stream(4, { spm: 0, seed: 200 + i, jitter: 0.008 }, (t) => ({
        dHipX: G.shift(t, 1.5, 0.25, (i % 2 ? 0.62 : -0.62) * G.BODY.torso),
      }));
      if (run(frames).fired.some((f) => f.a === "left" || f.a === "right")) hits++;
    }
    ok("deliberate side steps are missed under 5% of the time (§8)",
       1 - hits / 20 < 0.05, `${hits}/20`);
  }
}

describe("§3: cadence drives speed, and pausing to breathe is survivable");
{
  const cadenceOf = (spm, seconds = 6) => {
    const d = new G.GestureDetector(G.SYNTH_CAL);
    for (const f of G.stream(seconds, { spm })) d.update(f);
    return d.cadenceMultiplier();
  };
  ok("a brisk cadence approaches §3's 1.3x ceiling", cadenceOf(160) > 1.2, String(cadenceOf(160)));
  ok("a slow jog sits near the middle", (() => { const m = cadenceOf(105); return m > 0.6 && m < 1.15; })(),
     String(cadenceOf(105)));
  ok("the multiplier never exceeds §3's range", cadenceOf(400) <= 1.3 + 1e-9, String(cadenceOf(400)));

  // §3: "Dropping below a floor cadence for more than 3 seconds slows the
  // character and eventually stalls the run. This keeps the game playable for
  // someone who pauses to breathe without instantly killing them."
  {
    const d = new G.GestureDetector(G.SYNTH_CAL);
    for (const f of G.stream(6, { spm: 140 })) d.update(f);
    const running = d.cadenceMultiplier();
    // Stop dead, keeping the clock going.
    const stopped = G.stream(2.5, { spm: 0 }).map((f) => ({ ...f, t: f.t + 6 }));
    for (const f of stopped) d.update(f);
    const grace = d.cadenceMultiplier();
    const longer = G.stream(4, { spm: 0 }).map((f) => ({ ...f, t: f.t + 8.5 }));
    for (const f of longer) d.update(f);
    const stalled = d.cadenceMultiplier();
    ok("pausing briefly does not stall the run (§3's 3s grace)",
       running > 1 && grace >= 0.5, `running ${running.toFixed(2)} -> grace ${grace.toFixed(2)}`);
    ok("pausing for long enough stalls it", stalled < grace, `${grace.toFixed(2)} -> ${stalled.toFixed(2)}`);
  }
}

describe("calibration scales thresholds to the body (§2, §3)");
{
  const frames = G.stream(5, { spm: 0 });
  const cal = G.calibrate(frames);
  ok("a 5s still capture calibrates", cal !== null);
  ok("torso length is recovered", Math.abs(cal.torso - G.BODY.torso) < 0.01, String(cal.torso));
  ok("lateral centre is recovered", Math.abs(cal.centerX - G.BODY.centerX) < 0.01, String(cal.centerX));
  ok("a too-short capture is refused", G.calibrate(frames.slice(0, 10)) === null);

  // The point of torso-relative thresholds: the same gesture on a body half the
  // apparent size must still fire. This is §3's "invariant to distance from
  // camera and body size", and it is the difference between a game that works
  // for one person and one that works for anyone.
  const small = frames.map((f) => ({
    ...f,
    hipY: f.hipY * 0.5, shoulderY: f.shoulderY * 0.5,
    leftKneeY: f.leftKneeY * 0.5, rightKneeY: f.rightKneeY * 0.5,
  }));
  const smallCal = G.calibrate(small);
  const d = new G.GestureDetector(smallCal);
  const hop = G.stream(4, { spm: 0 }, (t) => ({ dHipY: G.pulse(t, 1.5, 0.42, 0.34 * smallCal.torso) }))
    .map((f) => ({ ...f, hipY: f.hipY * 0.5 + (f.hipY * 0.5 - f.hipY * 0.5) }));
  // Rebuild the half-size stream properly: scale the body, then add the gesture.
  const hop2 = G.stream(4, { spm: 0 }).map((f, i) => {
    const t = i / G.SYNTH_FPS;
    return {
      ...f,
      hipY: f.hipY * 0.5 + G.pulse(t, 1.5, 0.42, 0.34 * smallCal.torso),
      shoulderY: f.shoulderY * 0.5,
      leftKneeY: f.leftKneeY * 0.5,
      rightKneeY: f.rightKneeY * 0.5,
    };
  });
  void hop;
  const fired = [];
  for (const f of hop2) for (const a of d.update(f)) fired.push(a);
  ok("the same gesture fires on a body half the apparent size (§3)",
     fired.includes("jump"), fired.join(",") || "none");
}

describe("§6: the tracker failing is handled, not ignored");
{
  ok("no landmarks means no frame", G.toFrame(undefined, 0) === null);
  ok("a partial skeleton means no frame", G.toFrame([{ x: 0.5, y: 0.5 }], 0) === null);
  {
    // §6: "track the largest bounding box, which is normally the closest person"
    const small = Array.from({ length: 29 }, (_, i) => ({ x: 0.1 + (i % 3) * 0.02, y: 0.1 + (i % 5) * 0.02 }));
    const big = Array.from({ length: 29 }, (_, i) => ({ x: 0.2 + (i % 3) * 0.2, y: 0.1 + (i % 5) * 0.15 }));
    ok("the largest person in frame wins", G.largestPose([small, big]) === big);
  }
  {
    const f = G.stream(1, { spm: 0 })[0];
    ok("framing rejects an empty frame", G.checkFraming(null).reason === "no-person");
    ok("framing accepts a well-placed body", G.checkFraming(f).ok, JSON.stringify(G.checkFraming(f)));
    ok("framing catches someone too close",
       G.checkFraming({ ...f, shoulderY: f.hipY + 0.4 }).reason === "too-close");
    ok("framing catches someone too far",
       G.checkFraming({ ...f, shoulderY: f.hipY + 0.05 }).reason === "too-far");
    ok("framing catches someone off to the side",
       G.checkFraming({ ...f, hipX: 0.9 }).reason === "off-center");
  }
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log("\nFailures:"); fails.forEach((f) => console.log(" - " + f)); process.exit(1); }
