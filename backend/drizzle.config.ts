import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  // Only `generate` is used locally; it never connects. The URL below is a
  // placeholder so the config validates without real credentials in git.
  dbCredentials: {
    url: process.env.DATABASE_MIGRATION_URL ?? "postgresql://127.0.0.1:5433/dummy",
  },
});
