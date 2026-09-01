"use client";

import { useEffect, useRef, useState } from "react";
import { Tracker, type TrackerStatus } from "@/lib/pose/tracker";
import { calibrate, checkFraming, FRAMING_HELP, CALIBRATION_SECONDS } from "@/lib/pose/calibration";
import { GestureDetector, DEFAULTS } from "@/lib/pose/gestures";
import type { Frame } from "@/lib/pose/landmarks";
import type { Action } from "@/lib/game/types";
import styles from "./setup.module.css";

/**
 * §2's setup flow, in the order it specifies: framing, then a 5s still
 * calibration, then a tutorial that requires each gesture once, then play.
 *
 * §1's primary goal is "open a URL on a laptop, stand up, and be playing within
 * 60 seconds", so every step here is doing double duty: framing is also how the
 * player learns where to stand, calibration is also the 5 seconds they spend
 * reading the space requirement, and the tutorial is also a per-user threshold
 * check (§2's own words).
 */

type Step = "intro" | "framing" | "calibrating" | "tutorial" | "ready";

/**
 * §2 lists "four prompts in sequence (run, jump, duck, step left, step right)"
 * -- which is five things called four. Both readings cannot hold, so the list
 * wins over the count: skipping either direction would leave half the lane
 * gesture unverified, and §2 says the tutorial doubles as a threshold check.
 */
const TUTORIAL: { id: string; label: string; hint: string; done: (a: Action[]) => boolean }[] = [
  { id: "run", label: "Run in place", hint: "Lift your knees. Keep going until the bar fills.", done: () => false },
  { id: "jump", label: "Jump", hint: "Both feet off the floor.", done: (a) => a.includes("jump") || a.includes("jumpLeft") || a.includes("jumpRight") },
  { id: "duck", label: "Duck", hint: "Crouch or bend forward, and hold it for a moment.", done: (a) => a.includes("duck") },
  { id: "left", label: "Step left", hint: "One step to your left.", done: (a) => a.includes("left") || a.includes("jumpLeft") },
  { id: "right", label: "Step right", hint: "And back to your right.", done: (a) => a.includes("right") || a.includes("jumpRight") },
];

export default function Setup({
  onReady,
}: {
  onReady: (tracker: Tracker, detector: GestureDetector) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackerRef = useRef<Tracker | null>(null);
  const detRef = useRef<GestureDetector | null>(null);
  const capture = useRef<Frame[]>([]);
  const stepRef = useRef<Step>("intro");

  const [step, setStep] = useState<Step>("intro");
  const [status, setStatus] = useState<TrackerStatus>({ state: "idle" });
  const [framing, setFraming] = useState<{ ok: boolean; help: string }>({ ok: false, help: "Step into the frame" });
  const [progress, setProgress] = useState(0);
  const [tutorialAt, setTutorialAt] = useState(0);
  const [cadence, setCadence] = useState(0);

  useEffect(() => { stepRef.current = step; }, [step]);

  function begin() {
    setStep("framing");
    const t = new Tracker({
      onStatus: setStatus,
      onFrame: (f) => onFrame(f),
    });
    trackerRef.current = t;
    if (videoRef.current) void t.start(videoRef.current);
  }

  function onFrame(f: Frame | null) {
    const s = stepRef.current;
    const fr = checkFraming(f);
    setFraming({ ok: fr.ok, help: fr.reason ? FRAMING_HELP[fr.reason] : "Hold it there" });

    if (!f) return;

    if (s === "framing") {
      // Require the framing to hold, not just flicker green for one frame.
      setProgress((p) => {
        const next = fr.ok ? Math.min(1, p + 1 / 30) : 0;
        if (next >= 1) { setStep("calibrating"); capture.current = []; return 0; }
        return next;
      });
      return;
    }

    if (s === "calibrating") {
      if (!fr.ok) { capture.current = []; setProgress(0); return; }
      capture.current.push(f);
      const need = CALIBRATION_SECONDS * 30;
      setProgress(Math.min(1, capture.current.length / need));
      if (capture.current.length >= need) {
        const cal = calibrate(capture.current);
        if (cal) {
          detRef.current = new GestureDetector(cal, { ...DEFAULTS });
          setStep("tutorial");
          setProgress(0);
        } else {
          capture.current = [];
        }
      }
      return;
    }

    if (s === "tutorial") {
      const d = detRef.current;
      if (!d) return;
      const fired = d.update(f);
      setCadence(d.debug.spm);
      const task = TUTORIAL[tutorialAtRef.current];
      if (!task) return;
      if (task.id === "run") {
        // The run step is a cadence check rather than a gesture, so it needs a
        // sustained signal instead of a single event.
        setProgress((p) => {
          const next = d.debug.spm > DEFAULTS.cadenceFloorSpm ? Math.min(1, p + 1 / 45) : Math.max(0, p - 1 / 90);
          if (next >= 1) { advance(); return 0; }
          return next;
        });
        return;
      }
      if (task.done(fired)) advance();
    }
  }

  const tutorialAtRef = useRef(0);
  useEffect(() => { tutorialAtRef.current = tutorialAt; }, [tutorialAt]);

  function advance() {
    setTutorialAt((i) => {
      const next = i + 1;
      if (next >= TUTORIAL.length) setStep("ready");
      return next;
    });
    setProgress(0);
  }

  useEffect(() => {
    if (step !== "ready") return;
    const d = detRef.current;
    const t = trackerRef.current;
    if (!d || !t) return;
    // A beat on "Go" before handing over, so the player is upright and moving
    // rather than mid-step when the run starts.
    const id = setTimeout(() => onReady(t, d), 900);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  useEffect(() => () => trackerRef.current?.stop(), []);

  const task = TUTORIAL[tutorialAt];

  return (
    <div className={styles.root}>
      <div className={styles.stage}>
        <video ref={videoRef} className={styles.video} playsInline muted />
        {/* §2 step 2: "a body outline overlay... Green when framing is valid." */}
        {(step === "framing" || step === "calibrating") && (
          <svg className={styles.outline} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <rect x="30" y="8" width="40" height="84" rx="20"
              fill="none" strokeWidth="1.2" strokeDasharray="4 3"
              stroke={framing.ok ? "#4ade80" : "#ffb020"} />
          </svg>
        )}
      </div>

      <div className={styles.panel}>
        {step === "intro" && (
          <>
            <h1>Stride</h1>
            <p className={styles.lead}>An endless runner you play by running.</p>
            {/* §2 step 1: the space requirement, stated before asking for the camera. */}
            <ul className={styles.reqs}>
              <li>About <b>2m by 1m</b> of clear floor</li>
              <li>Stand <b>2 to 2.5m back</b> from the laptop</li>
              <li>Laptop on a table at <b>waist to chest height</b>, screen tilted back</li>
            </ul>
            {/* §2: "Recommend this in the setup flow with a small diagram." */}
            <svg className={styles.diagram} viewBox="0 0 200 86" aria-label="Laptop on a table at chest height, player 2 to 2.5 metres back">
              <line x1="8" y1="66" x2="192" y2="66" stroke="#2b3c60" strokeWidth="2" />
              <rect x="18" y="44" width="34" height="22" fill="#16203a" stroke="#2b3c60" strokeWidth="1.5" />
              <path d="M22 44 L30 26 L54 26 L46 44 Z" fill="#0e1524" stroke="#4dd2ff" strokeWidth="1.5" />
              <circle cx="150" cy="30" r="6" fill="none" stroke="#cbd6ea" strokeWidth="1.5" />
              <path d="M150 36 v16 M150 40 l-8 6 M150 40 l8 6 M150 52 l-6 14 M150 52 l6 14"
                stroke="#cbd6ea" strokeWidth="1.5" fill="none" strokeLinecap="round" />
              <path d="M58 72 H142" stroke="#6f7b93" strokeWidth="1" strokeDasharray="3 3" />
              <text x="100" y="83" fontSize="8" fill="#6f7b93" textAnchor="middle">2–2.5m</text>
            </svg>
            {/* §4: "all video stays on device, nothing is uploaded, no recording. Say
                this plainly on the permission screen. It is both true and the main
                objection people will have." */}
            <p className={styles.privacy}>
              The camera runs entirely in this tab. No video is uploaded, stored or recorded —
              there is no server to send it to.
            </p>
            <button type="button" className={styles.cta} onClick={begin}>Turn on the camera</button>
            <a className={styles.alt} href="/play/">Play on the keyboard instead</a>
          </>
        )}

        {step !== "intro" && status.state === "denied" && (
          <>
            <h1>Camera blocked</h1>
            <p className={styles.lead}>
              Allow camera access in your browser&rsquo;s address bar and reload. Nothing leaves
              this tab.
            </p>
            <a className={styles.cta} href="/play/">Play on the keyboard instead</a>
          </>
        )}

        {step === "framing" && status.state !== "denied" && (
          <>
            <h1>Get in frame</h1>
            <p className={styles.lead}>{framing.help}</p>
            <Bar value={progress} ok={framing.ok} />
          </>
        )}

        {step === "calibrating" && (
          <>
            <h1>Stand still</h1>
            <p className={styles.lead}>Arms at your sides for {CALIBRATION_SECONDS} seconds.</p>
            <Bar value={progress} ok />
          </>
        )}

        {step === "tutorial" && task && (
          <>
            <h1>{task.label}</h1>
            <p className={styles.lead}>{task.hint}</p>
            {task.id === "run" && <p className={styles.metric}>{Math.round(cadence)} steps/min</p>}
            <Bar value={task.id === "run" ? progress : 0} ok />
            <p className={styles.count}>{tutorialAt + 1} of {TUTORIAL.length}</p>
          </>
        )}

        {step === "ready" && (
          <>
            <h1>Go</h1>
            <p className={styles.lead}>Keep running.</p>
          </>
        )}
      </div>
    </div>
  );
}

function Bar({ value, ok }: { value: number; ok: boolean }) {
  return (
    <div className={styles.bar}>
      <div className={styles.barFill}
        style={{ width: `${Math.round(value * 100)}%`, background: ok ? "#4ade80" : "#ffb020" }} />
    </div>
  );
}
