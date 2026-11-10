import "dotenv/config";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { uuidv7 } from "../../src/common/uuidv7";
import { DbService } from "../../src/db/db.service";
import * as schema from "../../src/db/schema";
import { DrizzleInteractionStore } from "../../src/interactions/drizzle-store";

/**
 * Real Postgres via the app role, plus an owner pool for test cleanup.
 * Run `pnpm db:setup` before these tests.
 */
export function createTestDb(): {
  pool: Pool;
  owner: Pool;
  service: DbService;
  store: DrizzleInteractionStore;
} {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === "") throw new Error("DATABASE_URL is required for DB tests");
  const ownerUrl = process.env.DATABASE_MIGRATION_URL;
  if (ownerUrl === undefined || ownerUrl === "") {
    throw new Error("DATABASE_MIGRATION_URL is required for DB test cleanup");
  }
  const pool = new Pool({ connectionString: url });
  const owner = new Pool({ connectionString: ownerUrl });
  const service = new DbService(pool, drizzle(pool, { schema }));
  return { pool, owner, service, store: new DrizzleInteractionStore(service) };
}

export async function createTenantAgent(
  service: DbService,
  tenantId: string,
  name: string,
  status: "active" | "retired" | "draft" = "active",
): Promise<{ agentId: string }> {
  const agentId = uuidv7();
  await service.withTenant(tenantId, async (tx) => {
    await tx
      .insert(schema.agents)
      .values({ id: agentId, tenantId, name, personaPrompt: "test", status });
  });
  return { agentId: `agt_${agentId}` };
}

export async function createTenantWithAgent(
  service: DbService,
  name: string,
): Promise<{ tenantId: string; agentId: string }> {
  const tenantId = uuidv7();
  const agentId = await service.withTenant(tenantId, async (tx) => {
    await tx.insert(schema.tenants).values({ id: tenantId, tenantId, name, settings: {} });
    const id = uuidv7();
    await tx
      .insert(schema.agents)
      .values({ id, tenantId, name: `${name} agent`, personaPrompt: "test", status: "active" });
    return id;
  });
  return { tenantId, agentId };
}

/**
 * Removes every row for a tenant (FK order) via the OWNER role: the app role
 * has no DELETE grant (F9.3). RLS is FORCED, so the tenant is still set.
 * Test tenants are random uuids.
 */
export async function deleteTenantData(owner: Pool, tenantId: string): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    for (const table of ["turns", "interactions", "contacts", "agents", "tenants"]) {
      await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
