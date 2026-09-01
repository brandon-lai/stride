// Copies MediaPipe's wasm runtime out of node_modules into public/ at build time.
//
// §4 pins the tracker to "MediaPipe Pose Landmarker (Tasks Vision, web build)",
// and §1 forbids a server component -- so the runtime has to be a static asset
// rather than something fetched from a CDN at play time. Copying at build
// keeps 12MB of binary out of git while still shipping it with the site.
//
// The model itself IS committed (public/models), because downloading it during
// a build would make every deploy depend on a third-party host being up.
import { mkdirSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const from = path.join(ROOT, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const to = path.join(ROOT, "public", "mediapipe");

if (!existsSync(from)) {
  console.error("mediapipe wasm not found; is @mediapipe/tasks-vision installed?");
  process.exit(1);
}
mkdirSync(to, { recursive: true });

// SIMD build only. Every browser that can run this game at 30fps has wasm SIMD,
// and shipping the nosimd fallback doubles the payload for machines that would
// not hold §8's frame rate anyway. §6's keyboard fallback covers the rest.
const wanted = readdirSync(from).filter((f) => f.startsWith("vision_wasm_internal."));
for (const f of wanted) copyFileSync(path.join(from, f), path.join(to, f));
console.log(`mediapipe wasm: ${wanted.join(", ")}`);
