import "dotenv/config";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { z } from "zod";

/**
 * Runs drizzle-kit migrations plus the hand-written roles/RLS migration as the
 * table owner. Idempotent: drizzle tracks applied files, and `roles_rls.sql`
 * uses IF NOT EXISTS / DROP IF EXISTS throughout.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) throw new Error("DATABASE_MIGRATION_URL is required for db:migrate");
  const parsed = z.string().url().safeParse(url);
  if (!parsed.success) throw new Error("DATABASE_MIGRATION_URL must be a valid URL for db:migrate");
  const client = new Client({ connectionString: parsed.data });
  await client.connect();
  try {
    const drizzleFolder = join(__dirname, "..", "..", "drizzle");
    await migrate(drizzle(client), { migrationsFolder: drizzleFolder });
    // The roles/RLS script applies atomically: a failure midway must not
    // leave grants and policies half-applied.
    await client.query("BEGIN");
    try {
      await client.query(readFileSync(join(drizzleFolder, "roles_rls.sql"), "utf8"));
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    console.log("db:migrate ok");
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
