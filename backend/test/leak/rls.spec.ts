import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { uuidv7 } from "../../src/common/uuidv7";
import type { DbService } from "../../src/db/db.service";
import { agents, contacts, interactions, tenants, turns } from "../../src/db/schema";
import { createTestDb, deleteTenantData } from "../helpers/db";

interface Fixture {
  tenantId: string;
  agentId: string;
  contactId: string;
  interactionId: string;
  turnId: string;
}

const TABLES = ["tenants", "agents", "contacts", "interactions", "turns"] as const;

describe("RLS tenant isolation (real Postgres, app role, no mocks)", () => {
  let pool: Pool;
  let service: DbService;
  let a: Fixture;
  let b: Fixture;

  async function seed(name: string, phone: string): Promise<Fixture> {
    const tenantId = uuidv7();
    return service.withTenant(tenantId, async (tx) => {
      await tx.insert(tenants).values({ id: tenantId, tenantId, name, settings: {} });
      const agentId = uuidv7();
      await tx
        .insert(agents)
        .values({ id: agentId, tenantId, name: `${name} agent`, personaPrompt: "test" });
      const contactId = uuidv7();
      await tx
        .insert(contacts)
        .values({ id: contactId, tenantId, phoneE164: phone, phoneRaw: phone });
      const interactionId = uuidv7();
      await tx
        .insert(interactions)
        .values({ id: interactionId, tenantId, agentId, channel: "web_voice", direction: "inbound" });
      const turnId = uuidv7();
      await tx
        .insert(turns)
        .values({ id: turnId, tenantId, interactionId, seq: 1, speaker: "caller", text: "hi" });
      return { tenantId, agentId, contactId, interactionId, turnId };
    });
  }

  beforeAll(async () => {
    ({ pool, service } = createTestDb());
    a = await seed("Leak A Ltd", "+2347000000001");
    b = await seed("Leak B Ltd", "+2347000000002");
  });

  afterAll(async () => {
    await deleteTenantData(service, a.tenantId).catch(() => undefined);
    await deleteTenantData(service, b.tenantId).catch(() => undefined);
    await pool.end().catch(() => undefined);
  });

  it("tenant A reads only its own rows in every table", async () => {
    const rows = await service.withTenant(a.tenantId, async (tx) => ({
      tenants: await tx.select().from(tenants),
      agents: await tx.select().from(agents),
      contacts: await tx.select().from(contacts),
      interactions: await tx.select().from(interactions),
      turns: await tx.select().from(turns),
    }));
    for (const [table, list] of Object.entries(rows)) {
      expect(list.length, `${table} has rows`).toBeGreaterThan(0);
      for (const row of list) expect(row.tenantId, table).toBe(a.tenantId);
    }
    expect(rows.tenants.map((r) => r.id)).not.toContain(b.tenantId);
    expect(rows.agents.map((r) => r.id)).not.toContain(b.agentId);
    expect(rows.contacts.map((r) => r.id)).not.toContain(b.contactId);
    expect(rows.interactions.map((r) => r.id)).not.toContain(b.interactionId);
    expect(rows.turns.map((r) => r.id)).not.toContain(b.turnId);
  });

  /** Drizzle wraps the Postgres error; the RLS message lives on `cause`. */
  async function expectRlsViolation(act: Promise<unknown>, table: string): Promise<void> {
    const err = await act.then(
      () => null,
      (e: unknown) => e as { message?: string; cause?: { message?: string } },
    );
    expect(err, `${table} insert must fail`).not.toBeNull();
    expect(`${err?.message ?? ""} ${err?.cause?.message ?? ""}`, table).toMatch(
      /row-level security/,
    );
  }

  it("tenant A cannot insert rows for tenant B in any table", async () => {
    const other = b.tenantId;
    await expectRlsViolation(
      service.withTenant(a.tenantId, async (tx) => {
        await tx.insert(tenants).values({ id: uuidv7(), tenantId: other, name: "x", settings: {} });
      }),
      "tenants",
    );
    await expectRlsViolation(
      service.withTenant(a.tenantId, async (tx) => {
        await tx
          .insert(agents)
          .values({ id: uuidv7(), tenantId: other, name: "x", personaPrompt: "x" });
      }),
      "agents",
    );
    await expectRlsViolation(
      service.withTenant(a.tenantId, async (tx) => {
        await tx
          .insert(contacts)
          .values({ id: uuidv7(), tenantId: other, phoneE164: "+2347000000009" });
      }),
      "contacts",
    );
    await expectRlsViolation(
      service.withTenant(a.tenantId, async (tx) => {
        await tx
          .insert(interactions)
          .values({ id: uuidv7(), tenantId: other, agentId: a.agentId, channel: "x", direction: "y" });
      }),
      "interactions",
    );
    await expectRlsViolation(
      service.withTenant(a.tenantId, async (tx) => {
        await tx.insert(turns).values({
          id: uuidv7(),
          tenantId: other,
          interactionId: a.interactionId,
          seq: 99,
          speaker: "caller",
          text: "x",
        });
      }),
      "turns",
    );
  });

  it("tenant A cannot update tenant B rows in any table", async () => {
    const untouched = await service.withTenant(a.tenantId, async (tx) => ({
      tenants: await tx
        .update(tenants)
        .set({ name: "hacked" })
        .where(eq(tenants.id, b.tenantId))
        .returning({ id: tenants.id }),
      agents: await tx
        .update(agents)
        .set({ name: "hacked" })
        .where(eq(agents.id, b.agentId))
        .returning({ id: agents.id }),
      contacts: await tx
        .update(contacts)
        .set({ displayName: "hacked" })
        .where(eq(contacts.id, b.contactId))
        .returning({ id: contacts.id }),
      interactions: await tx
        .update(interactions)
        .set({ status: "hacked" })
        .where(eq(interactions.id, b.interactionId))
        .returning({ id: interactions.id }),
      turns: await tx
        .update(turns)
        .set({ text: "hacked" })
        .where(eq(turns.id, b.turnId))
        .returning({ id: turns.id }),
    }));
    for (const [table, list] of Object.entries(untouched)) {
      expect(list, `${table} update affects zero rows`).toHaveLength(0);
    }

    // B's data is unchanged.
    const check = await service.withTenant(b.tenantId, async (tx) => ({
      tenant: (await tx.select().from(tenants).where(eq(tenants.id, b.tenantId)).limit(1))[0],
      agent: (await tx.select().from(agents).where(eq(agents.id, b.agentId)).limit(1))[0],
      turn: (await tx.select().from(turns).where(eq(turns.id, b.turnId)).limit(1))[0],
    }));
    expect(check.tenant?.name).toBe("Leak B Ltd");
    expect(check.agent?.name).toBe("Leak B Ltd agent");
    expect(check.turn?.text).toBe("hi");
  });

  it("with no tenant set the app role sees zero rows in every table", async () => {
    for (const table of TABLES) {
      const result = await pool.query(`SELECT * FROM ${table}`);
      expect(result.rowCount, table).toBe(0);
    }
  });
});
