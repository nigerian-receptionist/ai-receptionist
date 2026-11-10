import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// SWC keeps decorator metadata so Nest dependency injection works in tests.
export default defineConfig({
  plugins: [swc.vite()],
  test: { include: ["src/**/*.spec.ts", "test/unit/**/*.spec.ts"], environment: "node" },
});
