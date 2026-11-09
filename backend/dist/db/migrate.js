"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_postgres_1 = require("drizzle-orm/node-postgres");
const migrator_1 = require("drizzle-orm/node-postgres/migrator");
const pg_1 = require("pg");
/**
 * Runs drizzle-kit migrations plus the hand-written roles/RLS migration as the
 * table owner. Idempotent: drizzle tracks applied files, and `roles_rls.sql`
 * uses IF NOT EXISTS / DROP IF EXISTS throughout.
 */
async function main() {
    const url = process.env.DATABASE_MIGRATION_URL;
    if (!url)
        throw new Error("DATABASE_MIGRATION_URL is required for db:migrate");
    const client = new pg_1.Client({ connectionString: url });
    await client.connect();
    try {
        const drizzleFolder = (0, node_path_1.join)(__dirname, "..", "..", "drizzle");
        await (0, migrator_1.migrate)((0, node_postgres_1.drizzle)(client), { migrationsFolder: drizzleFolder });
        await client.query((0, node_fs_1.readFileSync)((0, node_path_1.join)(drizzleFolder, "roles_rls.sql"), "utf8"));
        console.log("db:migrate ok");
    }
    finally {
        await client.end();
    }
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=migrate.js.map