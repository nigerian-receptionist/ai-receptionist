/**
 * Copy voice-activity-detection runtime assets into public/vad/ so the /talk
 * page loads them same-origin with no CDN at runtime:
 *   - vad.worklet.bundle.min.js + silero_vad_v5.onnx from @ricky0123/vad-web
 *   - ort-wasm-simd-threaded.{mjs,wasm} from onnxruntime-web (threaded build;
 *     the page sets COOP/COEP headers so SharedArrayBuffer is available)
 *
 * Runs as a postinstall hook and can be re-run manually: `pnpm vad:assets`.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const requireFromHere = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "public", "vad");

function packageDir(name) {
  // Walk up from the resolved entry point: some packages do not export ./package.json.
  let dir = dirname(requireFromHere.resolve(name));
  for (let i = 0; i < 5; i += 1) {
    try {
      const manifest = requireFromHere(join(dir, "package.json"));
      if (manifest.name === name) return dir;
    } catch {
      // Keep walking up.
    }
    dir = dirname(dir);
  }
  throw new Error(`cannot locate package ${name}`);
}

const vadDist = join(packageDir("@ricky0123/vad-web"), "dist");
const ortDist = join(packageDir("onnxruntime-web"), "dist");
const files = [
  [join(vadDist, "vad.worklet.bundle.min.js"), "vad.worklet.bundle.min.js"],
  [join(vadDist, "silero_vad_v5.onnx"), "silero_vad_v5.onnx"],
  [join(ortDist, "ort-wasm-simd-threaded.mjs"), "ort-wasm-simd-threaded.mjs"],
  [join(ortDist, "ort-wasm-simd-threaded.wasm"), "ort-wasm-simd-threaded.wasm"],
];

mkdirSync(target, { recursive: true });
for (const [from, name] of files) {
  copyFileSync(from, join(target, name));
  console.log(`vad:assets ${name}`);
}
