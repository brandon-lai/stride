/// <reference lib="webworker" />
import { FilesetResolver, PoseLandmarker, type PoseLandmarkerResult } from "@mediapipe/tasks-vision";

/**
 * §4: "run inference in a Web Worker with OffscreenCanvas so pose detection
 * never blocks the render loop. Game loop runs at 60fps and consumes the most
 * recent pose result, which may be one or two frames stale. This is the right
 * tradeoff: rendering must not stutter."
 *
 * The worker owns the model and nothing else. It receives an ImageBitmap,
 * returns landmarks, and closes the bitmap -- frames are never queued, because
 * a backlog would turn staleness into unbounded latency, and §5 has already
 * spent most of its budget elsewhere.
 */

type InMsg =
  | { type: "init"; wasmPath: string; modelPath: string }
  | { type: "frame"; bitmap: ImageBitmap; t: number };

type OutMsg =
  | { type: "ready"; delegate: "GPU" | "CPU" }
  | { type: "error"; message: string }
  | { type: "pose"; t: number; landmarks: { x: number; y: number; visibility?: number }[][] };

let landmarker: PoseLandmarker | null = null;
let busy = false;

const post = (m: OutMsg) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const msg = e.data;

  if (msg.type === "init") {
    const fileset = await FilesetResolver.forVisionTasks(msg.wasmPath).catch((e) => e as Error);
    if (fileset instanceof Error) {
      post({ type: "error", message: fileset.message });
      return;
    }

    const build = (delegate: "GPU" | "CPU") =>
      PoseLandmarker.createFromOptions(fileset, {
        // §4: lite model, single pose. §6 handles multiple people by taking the
        // largest box, which needs only one result if the model is already
        // picking the most prominent subject.
        baseOptions: { modelAssetPath: msg.modelPath, delegate },
        runningMode: "VIDEO",
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });

    /*
     * §4 asks for the GPU delegate, and that is what is tried first. But a
     * machine without it fails hard with `INTERNAL: Service "kGpuService"` and
     * the game becomes unplayable rather than slow -- which §6's whole section
     * on handling tracker failure explicitly rather than letting it misbehave
     * argues against. CPU inference is slower and eats into §5's latency
     * budget, so which one is running is reported rather than hidden: it is a
     * number the debug page needs when thresholds are being tuned.
     */
    try {
      landmarker = await build("GPU");
      post({ type: "ready", delegate: "GPU" });
    } catch {
      try {
        landmarker = await build("CPU");
        post({ type: "ready", delegate: "CPU" });
      } catch (err) {
        post({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
    }
    return;
  }

  if (msg.type === "frame") {
    // Drop rather than queue. A queued frame is a frame that will be answered
    // late, and a late pose is worse than no pose in a game budgeting 250ms.
    if (!landmarker || busy) {
      msg.bitmap.close();
      return;
    }
    busy = true;
    try {
      const result: PoseLandmarkerResult = landmarker.detectForVideo(msg.bitmap, msg.t);
      post({
        type: "pose",
        t: msg.t,
        landmarks: (result.landmarks ?? []).map((p) =>
          p.map((l) => ({ x: l.x, y: l.y, visibility: l.visibility }))
        ),
      });
    } catch (err) {
      post({ type: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      msg.bitmap.close();
      busy = false;
    }
  }
};
