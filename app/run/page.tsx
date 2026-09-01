"use client";

import { useCallback, useRef, useState } from "react";
import Setup from "@/components/Setup";
import Runner from "@/components/Runner";
import type { Tracker } from "@/lib/pose/tracker";
import type { GestureDetector } from "@/lib/pose/gestures";
import type { Action } from "@/lib/game/types";

/**
 * §7 step 4: "Bind gestures to game input. Both control paths active behind a
 * toggle."
 *
 * The binding is deliberately thin. Gestures are drained into the same action
 * queue the keyboard fills, and cadence is read straight off the detector --
 * the game does not know or care which produced them, which is what keeps §6's
 * keyboard fallback a real fallback rather than a second implementation that
 * drifts.
 */
export default function Run() {
  const [playing, setPlaying] = useState(false);
  const pending = useRef<Action[]>([]);
  const detRef = useRef<GestureDetector | null>(null);
  const trackerRef = useRef<Tracker | null>(null);
  const lostSince = useRef<number | null>(null);
  const [lost, setLost] = useState(false);

  const onReady = useCallback((tracker: Tracker, detector: GestureDetector) => {
    trackerRef.current = tracker;
    detRef.current = detector;
    // Re-point the tracker at the game now that setup is finished with it.
    (tracker as unknown as { events: { onFrame?: (f: unknown) => void } }).events.onFrame = (f) => {
      const frame = f as Parameters<GestureDetector["update"]>[0] | null;
      const now = performance.now() / 1000;
      if (!frame) {
        // §6: "No person detected: pause the game with a 'step back into frame'
        // overlay. Resume on re-acquisition. Do not end the run."
        if (lostSince.current === null) lostSince.current = now;
        if (now - lostSince.current > 0.4) setLost(true);
        return;
      }
      // §6: low confidence for over 2 seconds is also a pause, not a death.
      if (frame.confidence < 0.4) {
        if (lostSince.current === null) lostSince.current = now;
        if (now - lostSince.current > 2) setLost(true);
        return;
      }
      lostSince.current = null;
      setLost(false);
      for (const a of detector.update(frame)) pending.current.push(a);
    };
    setPlaying(true);
  }, []);

  if (!playing) return <Setup onReady={onReady} />;

  return (
    <Runner
      seed={Math.floor(Math.random() * 1e9)}
      hudNote="run to keep speed · jump · duck · step"
      controls={{
        drain: () => { const a = pending.current; pending.current = []; return a; },
        cadence: () => detRef.current?.cadenceMultiplier() ?? 1,
        paused: () => lost,
      }}
    />
  );
}
