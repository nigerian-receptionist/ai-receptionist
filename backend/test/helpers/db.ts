import "dotenv/config";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { uuidv7 } from "../../src/common/uuidv7";
import { DbService } from "../../src/db/db.service";
import * as schema from "../../src/db/schema";
import { DrizzleInteractionStore } from "../../src/interactions/drizzle-store";

/** Real Postgres via the app role. Run `pnpm db:setup` before these tests. */
export function createTestDb(): {
  pool: Pool;
  service: DbService;
  store: DrizzleInteractionStore;
} {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === "") throw new Error("DATABASE_URL is required for DB tests");
  const pool = new Pool({ connectionString: url });
  const service = new DbService(pool, drizzle(pool, { schema }));
  return { pool, service, store: new DrizzleInteractionStore(service) };
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

/** Removes every row for a tenant (FK order). Test tenants are random uuids. */
export async function deleteTenantData(service: DbService, tenantId: string): Promise<void> {
  await service.withTenant(tenantId, async (tx) => {
    await tx.delete(schema.turns).where(eq(schema.turns.tenantId, tenantId));
    await tx.delete(schema.interactions).where(eq(schema.interactions.tenantId, tenantId));
    await tx.delete(schema.contacts).where(eq(schema.contacts.tenantId, tenantId));
    await tx.delete(schema.agents).where(eq(schema.agents.tenantId, tenantId));
    await tx.delete(schema.tenants).where(eq(schema.tenants.tenantId, tenantId));
  });
}
