"use client";

import { useEffect, useRef, useState } from "react";
import { Tracker, type TrackerStatus } from "@/lib/pose/tracker";
import { GestureDetector, DEFAULTS, type Tunables, type GestureDebug } from "@/lib/pose/gestures";
import { calibrate, checkFraming, FRAMING_HELP, type Calibration } from "@/lib/pose/calibration";
import { stream, pulse, shift, SYNTH_CAL, BODY, SYNTH_FPS } from "@/lib/pose/synth";
import type { Frame, Landmark } from "@/lib/pose/landmarks";
import { LM } from "@/lib/pose/landmarks";
import type { Action } from "@/lib/game/types";
import styles from "./debug.module.css";

/**
 * §7 step 2, and the tool §10 says to spend the effort on: "A debug page:
 * camera feed, skeleton overlay, live readout of hip Y, hip X, cadence, and
 * each gesture's fire events. This page is the main tuning tool and should stay
 * in the codebase."
 *
 * It has a synthetic source as well as the camera. That is not a testing
 * shortcut -- it is what makes the page usable at a desk: you can watch a known
 * gesture go through the exact pipeline the camera feeds, change a threshold,
 * and see immediately whether the change would have fired. Tuning against a
 * camera alone means every experiment costs standing up.
 */

type Source = "camera" | "synthetic";

const SYNTH_SCRIPT: { at: number; label: string; motion: (t: number) => object }[] = [
  { at: 2, label: "jump", motion: (t) => ({ dHipY: pulse(t, 2, 0.42, 0.34 * BODY.torso) }) },
  { at: 5, label: "duck", motion: (t) => ({ dHipY: -pulse(t, 5, 0.7, 0.28 * BODY.torso), dShoulderY: -pulse(t, 5, 0.7, 0.42 * BODY.torso) }) },
  { at: 8, label: "step right", motion: (t) => ({ dHipX: shift(t, 8, 0.25, 0.62 * BODY.torso) - shift(t, 9.5, 0.25, 0.62 * BODY.torso) }) },
  { at: 12, label: "hop left", motion: (t) => ({ dHipY: pulse(t, 12, 0.42, 0.34 * BODY.torso), dHipX: -shift(t, 12, 0.3, 0.62 * BODY.torso) + shift(t, 13.5, 0.3, 0.62 * BODY.torso) }) },
];

function synthFrames(): Frame[] {
  return stream(16, { spm: 120 }, (t) => {
    const acc: { dHipY: number; dHipX: number; dShoulderY: number } = { dHipY: 0, dHipX: 0, dShoulderY: 0 };
    for (const s of SYNTH_SCRIPT) {
      const m = s.motion(t) as Partial<typeof acc>;
      acc.dHipY += m.dHipY ?? 0;
      acc.dHipX += m.dHipX ?? 0;
      acc.dShoulderY += m.dShoulderY ?? 0;
    }
    return acc;
  });
}

export default function Debug() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const detRef = useRef<GestureDetector | null>(null);
  const calRef = useRef<Calibration | null>(null);
  const capture = useRef<Frame[]>([]);

  const [source, setSource] = useState<Source>("synthetic");
  const [status, setStatus] = useState<TrackerStatus>({ state: "idle" });
  const [tune, setTune] = useState<Tunables>({ ...DEFAULTS });
  const [dbg, setDbg] = useState<GestureDebug | null>(null);
  const [fires, setFires] = useState<{ a: Action; t: number }[]>([]);
  const [cal, setCal] = useState<Calibration | null>(null);
  const [framing, setFraming] = useState<string>("");
  const [capturing, setCapturing] = useState(false);

  // Keep the live detector's tunables in step with the sliders without
  // rebuilding it, so filter state and cadence history survive an edit.
  useEffect(() => { if (detRef.current) detRef.current.tune = tune; }, [tune]);

  const handle = (f: Frame | null, raw: Landmark[] | null) => {
    drawOverlay(raw);
    if (!f) { setFraming("no person"); return; }
    const fr = checkFraming(f);
    setFraming(fr.ok ? "framing ok" : FRAMING_HELP[fr.reason!]);

    if (capturing) {
      capture.current.push(f);
      if (capture.current.length >= 5 * 30) {
        const c = calibrate(capture.current);
        setCapturing(false);
        if (c) { calRef.current = c; setCal(c); detRef.current = new GestureDetector(c, tune); }
      }
      return;
    }
    const d = detRef.current;
    if (!d) return;
    const out = d.update(f);
    setDbg({ ...d.debug });
    if (out.length) setFires((prev) => [...out.map((a) => ({ a, t: f.t })), ...prev].slice(0, 14));
  };

  function drawOverlay(raw: Landmark[] | null) {
    const c = overlayRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    if (!raw) return;
    const pairs: [number, number][] = [
      [LM.leftShoulder, LM.rightShoulder], [LM.leftHip, LM.rightHip],
      [LM.leftShoulder, LM.leftHip], [LM.rightShoulder, LM.rightHip],
      [LM.leftHip, LM.leftKnee], [LM.rightHip, LM.rightKnee],
      [LM.leftKnee, LM.leftAnkle], [LM.rightKnee, LM.rightAnkle],
    ];
    ctx.strokeStyle = "#4dd2ff";
    ctx.lineWidth = 3;
    for (const [a, b] of pairs) {
      const p = raw[a], q = raw[b];
      if (!p || !q) continue;
      ctx.beginPath();
      ctx.moveTo(p.x * c.width, p.y * c.height);
      ctx.lineTo(q.x * c.width, q.y * c.height);
      ctx.stroke();
    }
    ctx.fillStyle = "#ffb020";
    for (const i of Object.values(LM)) {
      const p = raw[i];
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(p.x * c.width, p.y * c.height, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Synthetic source: replay a scripted body through the real pipeline.
  useEffect(() => {
    if (source !== "synthetic") return;
    calRef.current = SYNTH_CAL;
    setCal(SYNTH_CAL);
    detRef.current = new GestureDetector(SYNTH_CAL, tune);
    setFires([]);
    const frames = synthFrames();
    let i = 0;
    const id = setInterval(() => {
      const f = frames[i % frames.length];
      i++;
      const d = detRef.current;
      if (!d) return;
      const shifted = { ...f, t: i / SYNTH_FPS };
      const out = d.update(shifted);
      setDbg({ ...d.debug });
      setFraming("synthetic");
      if (out.length) setFires((prev) => [...out.map((a) => ({ a, t: shifted.t })), ...prev].slice(0, 14));
    }, 1000 / SYNTH_FPS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  useEffect(() => {
    if (source !== "camera") return;
    const t = new Tracker({ onStatus: setStatus, onFrame: handle });
    if (videoRef.current) void t.start(videoRef.current);
    return () => t.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const num = (v: number, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : "—");

  return (
    <main className={styles.root}>
      <header className={styles.head}>
        <h1>pose debug</h1>
        <div className={styles.sources}>
          {(["synthetic", "camera"] as Source[]).map((s) => (
            <button key={s} type="button" onClick={() => setSource(s)}
              className={source === s ? styles.on : ""}>{s}</button>
          ))}
          <span className={styles.status}>
            {source === "camera" ? status.state : "scripted"} · {framing}
            {"delegate" in status ? ` · ${status.delegate}` : ""}
            {"message" in status && status.message ? ` · ${status.message}` : ""}
          </span>
        </div>
      </header>

      <div className={styles.grid}>
        <section className={styles.feed}>
          <video ref={videoRef} className={styles.video} playsInline muted />
          <canvas ref={overlayRef} width={640} height={480} className={styles.overlay} />
          {source === "camera" && status.state === "denied" && (
            <p className={styles.denied}>
              Camera denied. The game still runs on the keyboard — that is §6&rsquo;s fallback,
              and it is the fastest way to test game feel anyway.
            </p>
          )}
          {source === "camera" && status.state === "running" && !cal && (
            <button type="button" className={styles.calBtn}
              onClick={() => { capture.current = []; setCapturing(true); }}>
              {capturing ? `calibrating… ${capture.current.length}/150` : "calibrate (stand still 5s)"}
            </button>
          )}
        </section>

        {/* §7.2: "live readout of hip Y, hip X, cadence, and each gesture's fire events" */}
        <section className={styles.readouts}>
          <h2>signals</h2>
          <dl>
            <dt>hip Y</dt><dd>{num(dbg?.hipY ?? NaN)}</dd>
            <dt>hip X</dt><dd>{num(dbg?.hipX ?? NaN)}</dd>
            <dt>shoulder Y</dt><dd>{num(dbg?.shoulderY ?? NaN)}</dd>
            <dt>rise (torso)</dt><dd className={meter(dbg?.riseTorso, tune.jumpRise)}>{num(dbg?.riseTorso ?? NaN)}</dd>
            <dt>lateral (torso)</dt><dd className={meter(Math.abs(dbg?.lateralTorso ?? 0), tune.laneDeadzone)}>{num(dbg?.lateralTorso ?? NaN)}</dd>
            <dt>compression</dt><dd className={meter(dbg?.compressionTorso, tune.duckDrop)}>{num(dbg?.compressionTorso ?? NaN)}</dd>
            <dt>cadence spm</dt><dd>{num(dbg?.spm ?? NaN, 0)}</dd>
            <dt>speed mult</dt><dd>{num(dbg?.cadenceMult ?? NaN, 2)}</dd>
            <dt>stalled for</dt><dd>{num(dbg?.stalledFor ?? NaN, 1)}s</dd>
            <dt>confidence</dt><dd>{num(dbg?.confidence ?? NaN, 2)}</dd>
            <dt>arbitrating</dt><dd>{dbg?.arbitrating ? "yes" : "no"}</dd>
            <dt>torso</dt><dd>{num(cal?.torso ?? NaN)}</dd>
          </dl>
        </section>

        <section className={styles.fires}>
          <h2>fires</h2>
          <ul>
            {fires.length === 0 && <li className={styles.dim}>nothing yet</li>}
            {fires.map((f, i) => (
              <li key={`${f.t}-${i}`}><b>{f.a}</b> <span className={styles.dim}>{f.t.toFixed(2)}s</span></li>
            ))}
          </ul>
        </section>

        <section className={styles.tunables}>
          <h2>thresholds</h2>
          {([
            ["jumpRise", 0.05, 0.4, 0.01],
            ["jumpVelocity", 0.1, 2, 0.05],
            ["duckDrop", 0.05, 0.4, 0.01],
            ["duckShoulderDrop", 0.02, 0.3, 0.01],
            ["laneDeadzone", 0.1, 1, 0.02],
            ["kneeLift", 0.05, 0.6, 0.01],
            ["arbitrationMs", 40, 300, 10],
            ["cooldownMs", 100, 800, 25],
          ] as [keyof Tunables, number, number, number][]).map(([k, min, max, stepv]) => (
            <label key={k}>
              <span>{k}</span>
              <input type="range" min={min} max={max} step={stepv}
                value={tune[k] as number}
                onChange={(e) => setTune({ ...tune, [k]: Number(e.target.value) })} />
              <output>{tune[k] as number}</output>
            </label>
          ))}
          <label className={styles.mode}>
            <span>laneMode (§9 q1)</span>
            <select value={tune.laneMode}
              onChange={(e) => setTune({ ...tune, laneMode: e.target.value as Tunables["laneMode"] })}>
              <option value="relative">relative</option>
              <option value="absolute">absolute</option>
            </select>
          </label>
          <button type="button" onClick={() => setTune({ ...DEFAULTS })}>reset</button>
        </section>
      </div>
    </main>
  );
}

/** Colour a readout by how close it is to firing. */
function meter(v: number | undefined, threshold: number): string {
  if (v === undefined) return "";
  const r = Math.abs(v) / threshold;
  return r >= 1 ? styles.hot : r > 0.6 ? styles.warm : "";
}
