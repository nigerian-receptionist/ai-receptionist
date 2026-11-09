import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// Integration and leak tests need the Docker Postgres from docker-compose.yml.
export default defineConfig({
  plugins: [swc.vite()],
  test: {
    include: ["test/integration/**/*.spec.ts", "test/leak/**/*.spec.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
