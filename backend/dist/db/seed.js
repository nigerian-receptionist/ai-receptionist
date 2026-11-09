"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SEED_AGENT_ID = exports.SEED_TENANT_ID = void 0;
require("dotenv/config");
const pg_1 = require("pg");
/** Fixed seed ids so `db:seed` is idempotent. Tenant matches DEV_TENANT_ID. */
exports.SEED_TENANT_ID = "0195f3a0-0000-7000-8000-000000000001";
exports.SEED_AGENT_ID = "0195f3a0-0000-7000-8000-000000000002";
const SEED_PERSONA_PROMPT = "You are Ada, a polite receptionist for Demo Microfinance Ltd, a fictional " +
    "microfinance bank in Lagos. Greet callers warmly, speak clearly in Nigerian " +
    "English, keep replies short, and never ask for card numbers, PINs, OTPs, BVN or NIN.";
/**
 * Seeds one fake tenant and agent. Idempotent (upserts on fixed ids).
 * Runs as the owner but still sets app.tenant_id because RLS is FORCED.
 */
async function main() {
    const url = process.env.DATABASE_MIGRATION_URL;
    if (!url)
        throw new Error("DATABASE_MIGRATION_URL is required for db:seed");
    const tenantId = process.env.DEV_TENANT_ID ?? exports.SEED_TENANT_ID;
    const client = new pg_1.Client({ connectionString: url });
    await client.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        await client.query(`INSERT INTO tenants (id, tenant_id, name, settings)
       VALUES ($1, $1, 'Demo Microfinance Ltd', '{}'::jsonb)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`, [tenantId]);
        await client.query(`INSERT INTO agents (id, tenant_id, name, persona_prompt, voice_id, language, status)
       VALUES ($1, $2, 'Ada \u2013 reminders', $3, NULL, 'en-NG', 'active')
       ON CONFLICT (id) DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id,
         name = EXCLUDED.name,
         persona_prompt = EXCLUDED.persona_prompt,
         language = EXCLUDED.language,
         status = EXCLUDED.status,
         updated_at = now()`, [exports.SEED_AGENT_ID, tenantId, SEED_PERSONA_PROMPT]);
        await client.query("COMMIT");
        console.log("db:seed ok");
    }
    catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
    }
    finally {
        await client.end();
    }
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=seed.js.map