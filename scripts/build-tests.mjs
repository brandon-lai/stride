// Bundles the pure logic so tests can import it from plain Node. The game
// rules and the gesture detectors are both pure functions living behind path
// aliases, which Node cannot resolve on its own.
import { build } from "esbuild";
import path from "node:path";
const ROOT = path.resolve(import.meta.dirname, "..");
await build({
  entryPoints: [path.join(ROOT, "tests", "entry.ts")],
  outfile: path.join(ROOT, "tests", ".bundle.mjs"),
  bundle: true, format: "esm", platform: "node", target: "node20",
  logLevel: "error", alias: { "@": ROOT },
});
