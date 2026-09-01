"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Renderer } from "@/lib/render/scene";
import { Cues } from "@/lib/audio";
import { newRun, step, scoreOf } from "@/lib/game/engine";
import type { Action, RunState } from "@/lib/game/types";
import type { TrackGenerator } from "@/lib/game/patterns";
import styles from "./runner.module.css";

/**
 * §7 step 1: the playable game, on the keyboard. §6 is explicit that this is
 * not only an accessibility fallback -- "it is the fastest way to test game
 * feel independent of the tracker. Build it first."
 *
 * The gesture path feeds this same component through `externalActions`, so
 * both control schemes drive one game and neither can drift from the other.
 */

export type Controls = {
  /** Actions produced this frame by something other than the keyboard. */
  drain?: () => Action[];
  /** §3's 0.5-1.3 speed multiplier. Keyboard play holds it at 1. */
  cadence?: () => number;
  /** §6: the tracker lost the player; pause without ending the run. */
  paused?: () => boolean;
};

export default function Runner({
  seed,
  controls,
  onDead,
  hudNote,
}: {
  seed: number;
  controls?: Controls;
  onDead?: (score: number, distance: number, coins: number) => void;
  hudNote?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<(RunState & { gen: TrackGenerator }) | null>(null);
  const queued = useRef<Action[]>([]);
  const [hud, setHud] = useState({ distance: 0, coins: 0, lane: 1, speed: 0, paused: false });
  const [dead, setDead] = useState<null | { score: number; distance: number; coins: number }>(null);
  const [noGl, setNoGl] = useState(false);

  const press = useCallback((a: Action) => { queued.current.push(a); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key;
      let a: Action | null = null;
      if (k === "ArrowLeft" || k === "a" || k === "A") a = "left";
      else if (k === "ArrowRight" || k === "d" || k === "D") a = "right";
      else if (k === "ArrowUp" || k === "w" || k === "W" || k === " ") a = "jump";
      else if (k === "ArrowDown" || k === "s" || k === "S") a = "duck";
      if (!a) return;
      e.preventDefault();
      press(a);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press]);

  useEffect(() => {
    if (!canvasRef.current) return;
    let renderer: Renderer;
    try {
      renderer = new Renderer(canvasRef.current);
    } catch {
      // No WebGL context takes the whole page down otherwise.
      setNoGl(true);
      return;
    }
    const cues = new Cues();
    const state = newRun(seed);
    stateRef.current = state;

    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __run?: unknown }).__run = state;
    }

    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const FIXED = 1 / 120;

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const frame = Math.min(0.25, (now - last) / 1000);
      last = now;

      const isPaused = controls?.paused?.() ?? false;
      if (!isPaused && state.status === "running") {
        acc += frame;
        const actions = [...queued.current, ...(controls?.drain?.() ?? [])];
        queued.current.length = 0;
        const cadence = controls?.cadence?.() ?? 1;

        // Fixed timestep: the game must not behave differently at 30fps than at
        // 144fps, and §8 asks for sustained 60fps *with* inference running, so
        // frame time will vary.
        let first = true;
        while (acc >= FIXED) {
          step(state, { dt: FIXED, actions: first ? actions : [], cadenceMult: cadence });
          first = false;
          acc -= FIXED;
          for (const ev of state.events) {
            if (ev === "coin") cues.coin();
            else if (ev === "nearMiss") cues.nearMiss();
            else if (ev === "collision") cues.collision();
          }
          if (state.status !== "running") break;
        }
      }

      renderer.render(state);
      setHud({
        distance: state.distance,
        coins: state.coins,
        lane: state.player.lane,
        speed: state.speed,
        paused: isPaused,
      });
      if (state.status === "dead" && !dead) {
        const payload = { score: scoreOf(state), distance: state.distance, coins: state.coins };
        setDead(payload);
        onDead?.(payload.score, payload.distance, payload.coins);
      }
    };
    raf = requestAnimationFrame(loop);
    window.addEventListener("resize", renderer.resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", renderer.resize);
      cues.dispose();
      renderer.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  return (
    <div className={styles.root}>
      <canvas ref={canvasRef} className={styles.canvas} />

      {noGl && <div className={styles.overlay}><p>This needs WebGL.</p></div>}

      {/* §2: HUD text at minimum 48px equivalent at 1080p, high contrast. */}
      <div className={styles.hud}>
        <span className={styles.distance}>{Math.floor(hud.distance)}<span className={styles.unit}>m</span></span>
        <span className={styles.coins}>{hud.coins}</span>
      </div>

      {/* §2: lane position by shape and colour, never text. */}
      <div className={styles.lanes} aria-label={`Lane ${hud.lane + 1} of 3`}>
        {[0, 1, 2].map((l) => (
          <span key={l} className={`${styles.lanePip} ${hud.lane === l ? styles.lanePipOn : ""}`} />
        ))}
      </div>

      {hudNote && <p className={styles.note}>{hudNote}</p>}

      {hud.paused && (
        <div className={styles.overlay}>
          <p className={styles.big}>Step back into frame</p>
        </div>
      )}

      {dead && (
        <div className={styles.overlay}>
          <p className={styles.big}>{Math.floor(dead.distance)}m</p>
          <p className={styles.sub}>{dead.coins} coins · {dead.score} points</p>
          <button type="button" className={styles.again} onClick={() => location.reload()}>
            Run again
          </button>
        </div>
      )}
    </div>
  );
}
