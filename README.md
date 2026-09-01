# Stride

**A browser endless runner played with your body instead of a keyboard. The
laptop webcam tracks you, and running in place, jumping, crouching and
side-stepping drive the character.**

Built from `PRD_motion_runner.md`.

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # 65 tests: game rules, gesture detectors, calibration
npm run build      # static export — no server, per §1
```

Routes: `/` landing · `/run` camera play (setup → calibration → tutorial → game)
· `/play` keyboard · `/debug` the pose tuning page

---

## What is verified, and what is not

This is the honest part, and it is short.

**Not verified: any real body, in any real room.** §7 step 5 says "Playtest with
at least three body types and two room setups." That did not happen — there was
no camera and no person. So the following are all *unsettled*:

- §8's false-positive and miss rates against real bodies.
- §5's speed cap, which the PRD explicitly says to "find by playtest, not by
  theory". The number shipped is a ceiling derived from the PRD's own reaction
  floor, not a playtested value, and it is expected to come **down**.
- §8's "sustained 60fps with pose inference on a mid-range laptop".
- §8's "setup to first gameplay under 60 seconds for a new player".
- §9's questions 1 and 3, which the PRD says need a playtest.

**Verified:** the game rules, the gesture detectors against synthetic bodies,
and the whole camera pipeline end to end headless — the worker loads, the model
loads, inference runs on the GPU delegate, and §6's "no person detected" path
fires correctly against a fake camera containing no person.

Synthetic bodies are a **floor, not a substitute**. A detector that fires on a
synthetic run-in-place is broken for every real body too, and one that misses a
clean synthetic jump will miss a real one. Passing them is necessary and nowhere
near sufficient.

---

## Open questions

**1. Absolute or relative lane mapping → relative, and both are switchable.**
§9 says this "needs a playtest, not a decision on paper", so shipping a verdict
would be pretending. What shipped is §3's own v1 recommendation — relative, with
the reference centre re-estimated on a ~3s exponential moving average — and §3's
other instruction honoured: "instrument both so it can be swapped." `laneMode`
is a dropdown on `/debug`, live, mid-session. The playtest is one click, not a
rebuild.

**2. Is running required for speed, or just flavour → required, forgivingly.**
§1's secondary goal is "one session is a real workout without feeling like a
fitness app". If running is flavour, it is not a workout, and the whole premise
collapses into a webcam gesture demo. So cadence drives §3's 0.5–1.3x
multiplier. What keeps it from being a fitness app is the grace: §3's floor
cadence has to be missed for three full seconds before the character even
begins to slow, so stopping to breathe costs speed rather than the run.

**3. Does fatigue break the tracker → partly addressed, not solved.**
One change was made for it. §3 specifies cadence as "knee lift above hip
baseline", which taken literally is a high-knee sprint; the threshold here is
relative to *standing* knee height instead, so the gesture survives the form
degrading — which is the failure §9 is anticipating. Full adaptive thresholds
are **not** built, because adapting requires knowing what real fatigue looks
like in the signal, and that is playtest data nobody has yet. The debug page
records the numbers that would tell you.

**4. How much floor space → assume 2m × 1m, which is what makes answer 1 work.**
This question and the lane-mapping one are the same question. Relative mapping
needs only enough room for a single side-step, because the reference re-centres;
absolute mapping needs the player to physically occupy thirds of the space. The
setup flow states the requirement before asking for the camera, so nobody
discovers it after granting permission.

**5. Fast-follows → not built, but one is nearly free.** The obstacle generator
is already seeded and deterministic (§4), so "daily seeded run for comparable
scores" is a date-derived seed and a share string. Seated mode and local
two-player are genuinely new work.

---

## Decisions the PRD left open

**§5's speed cap is derived, not chosen.** The reaction window is gap ÷ speed,
so capping speed at `MIN_GAP_M / MIN_REACTION_S` is the only way §5's 700ms
floor holds by construction rather than by luck. The cap applies to the *result*
of the cadence multiplier — capping the base instead would let a 1.3x sprint at
full ramp reach 31.5 m/s and a 0.54s window.

**§5's band table leaves a gap and §2 miscounts its own list.** Where the PRD
contradicts itself, the reading that serves the product wins and the reason is
in the code: §2 calls the tutorial "four prompts" and then lists five, and the
list wins, because skipping either lane direction leaves half the gesture
unverified when §2 says the tutorial doubles as a threshold check.

**The jump arc is floatier than a keyboard runner needs.** §5 budgets 150–250ms
of input lag. The first arc left 276ms of *timing* latitude — the time you are
above the barrier, minus the time the barrier takes to cross — so a single lag
spike consumed all of it and a correctly-timed body jump still clipped. §1 wants
failures to feel like the player's fault, not the tracker's. The arc now gives
~640ms.

**GPU delegate first, CPU fallback second.** §4 asks for GPU. Without a
fallback, a machine that lacks it fails with `INTERNAL: Service "kGpuService"`
and the game is unplayable rather than slow — which is precisely the silent
misbehaviour §6 exists to prevent. Which delegate is live is reported on
`/debug`, because CPU inference spends more of §5's latency budget.

**Everything about the tracker is a pure function of a frame stream.** No
camera, no DOM, no MediaPipe in the gesture layer. That is what made §8's
criteria measurable at all without a playtest, and it is why the keyboard path
(§6, "build it first") and the camera path drive one identical game rather than
two implementations that drift.

## Bugs worth knowing about

All found by testing or rendering; none by the type checker.

- **The One Euro filter computed its derivative against the previous *filtered*
  value** rather than the raw one. The filter lags on purpose, so this inflated
  reported speed about sixfold: a four-second stand-up read as 0.78 torso/s
  instead of 0.13, cleared the jump gate and fired three jumps. On its own that
  blows §8's false-positive budget on any slow movement.
- **A sideways hop fired both a jump and a lane change**, which §3 forbids by
  name. Arbitration measured lateral travel from the hip position at the instant
  the jump armed, but the vertical spike happens early in a hop, so it saw only
  the remainder and judged it too small.
- **Cadence read zero at every speed** — the knee signal at 1–3Hz was being
  filtered with the torso's cutoff, which attenuated it below the lift threshold.
- **Coin pickup used the player's whole standing body box**, so arc coins were
  collected without jumping, defeating §5's "rewarding the jump path".
- **The camera looked nearly horizontally**, compressing the track into a sliver
  with 40% of the screen empty — unreadable at the 2.5m §2 designs for.

## Tooling

`scripts/probe.mjs` gained two flags this build, both reusable:
`GL=1` (SwiftShader — headless Chrome has no WebGL, so no 3D app can be verified
without it) and `CAM=1` (fake camera device, which makes a `getUserMedia` flow
and its failure paths reachable headless).
