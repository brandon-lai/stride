"use client";

import type { Frame, Landmark } from "./landmarks";
import { toFrame, largestPose } from "./landmarks";

/**
 * Main-thread side of the pose pipeline: own the camera, hand frames to the
 * worker, and turn results into Frames.
 *
 * §4's privacy line is a property of this file: the MediaStream is attached to
 * a local video element, frames become ImageBitmaps that go to a worker in the
 * same tab, and nothing is ever sent anywhere. There is no upload path in the
 * codebase to audit, which is the strongest form the promise can take.
 */

export type TrackerStatus =
  | { state: "idle" }
  | { state: "requesting" }
  | { state: "denied"; message: string }
  | { state: "loading" }
  | { state: "running"; delegate: "GPU" | "CPU" }
  | { state: "error"; message: string };

export type TrackerEvents = {
  onStatus?: (s: TrackerStatus) => void;
  onFrame?: (f: Frame | null, raw: Landmark[] | null) => void;
};

export class Tracker {
  private worker: Worker | null = null;
  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private raf = 0;
  private stopped = false;
  private lastSent = 0;

  /** §4 targets 30fps inference; the render loop runs at 60 regardless. */
  readonly inferenceHz = 30;

  status: TrackerStatus = { state: "idle" };

  constructor(private events: TrackerEvents = {}) {}

  private setStatus(s: TrackerStatus) {
    this.status = s;
    this.events.onStatus?.(s);
  }

  async start(video: HTMLVideoElement): Promise<void> {
    this.video = video;
    this.setStatus({ state: "requesting" });

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
        audio: false,
      });
    } catch (err) {
      // §6: "Camera permission denied: clear recovery instructions, plus a
      // keyboard fallback mode so the game is still playable and testable."
      this.setStatus({
        state: "denied",
        message: err instanceof Error ? err.message : "Camera unavailable",
      });
      return;
    }

    video.srcObject = this.stream;
    video.playsInline = true;
    video.muted = true;
    await video.play().catch(() => {});

    this.setStatus({ state: "loading" });
    this.worker = new Worker(new URL("./worker.ts", import.meta.url));
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "ready") this.setStatus({ state: "running", delegate: m.delegate });
      else if (m.type === "error") this.setStatus({ state: "error", message: m.message });
      else if (m.type === "pose") {
        const best = largestPose(m.landmarks ?? []);
        this.events.onFrame?.(toFrame(best ?? undefined, m.t / 1000), best);
      }
    };
    this.worker.postMessage({
      type: "init",
      wasmPath: "/mediapipe",
      modelPath: "/models/pose_landmarker_lite.task",
    });

    this.pump();
  }

  private pump = () => {
    if (this.stopped) return;
    this.raf = requestAnimationFrame(this.pump);
    const v = this.video;
    if (!v || !this.worker || v.readyState < 2) return;

    const now = performance.now();
    if (now - this.lastSent < 1000 / this.inferenceHz) return;
    this.lastSent = now;

    // createImageBitmap is async and cheap; the bitmap transfers to the worker
    // rather than copying, so the main thread never touches pixel data.
    createImageBitmap(v)
      .then((bitmap) => {
        if (this.stopped || !this.worker) { bitmap.close(); return; }
        this.worker.postMessage({ type: "frame", bitmap, t: now }, [bitmap]);
      })
      .catch(() => {});
  };

  stop() {
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    this.worker?.terminate();
    this.worker = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    this.setStatus({ state: "idle" });
  }
}
