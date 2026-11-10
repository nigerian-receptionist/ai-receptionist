import type { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { assertRlsEnforced, RLS_TENANT_TABLES } from "../../src/db/rls-check";
import { createTestDb } from "../helpers/db";

interface FakeRow {
  relname?: string;
  relrowsecurity?: boolean;
  relforcerowsecurity?: boolean;
  owner?: string;
  rolname?: string;
  rolsuper?: boolean;
  rolbypassrls?: boolean;
}

function fakePool(tables: FakeRow[], role: FakeRow): Pool {
  return {
    query: async (text: string) => ({ rows: text.includes("pg_class") ? tables : [role] }),
  } as unknown as Pool;
}

function goodTables(): FakeRow[] {
  return RLS_TENANT_TABLES.map((relname) => ({
    relname,
    relrowsecurity: true,
    relforcerowsecurity: true,
    owner: "owner",
  }));
}

const goodRole: FakeRow = { rolname: "app", rolsuper: false, rolbypassrls: false };

describe("assertRlsEnforced (M24)", () => {
  const { pool } = createTestDb();
  afterAll(async () => {
    await pool.end();
  });

  it("passes against the migrated app-role database", async () => {
    await expect(assertRlsEnforced(pool)).resolves.toBeUndefined();
  });

  it("passes for a compliant fake setup", async () => {
    await expect(assertRlsEnforced(fakePool(goodTables(), goodRole))).resolves.toBeUndefined();
  });

  it("refuses a table without FORCE", async () => {
    const tables = goodTables().map((row) =>
      row.relname === "turns" ? { ...row, relforcerowsecurity: false } : row,
    );
    await expect(assertRlsEnforced(fakePool(tables, goodRole))).rejects.toThrow(
      /turns.*FORCE row-level security/,
    );
  });

  it("refuses a missing table", async () => {
    const tables = goodTables().filter((row) => row.relname !== "turns");
    await expect(assertRlsEnforced(fakePool(tables, goodRole))).rejects.toThrow(/turns.*missing/);
  });

  it("refuses a superuser role", async () => {
    await expect(
      assertRlsEnforced(fakePool(goodTables(), { ...goodRole, rolsuper: true })),
    ).rejects.toThrow(/superuser/);
  });

  it("refuses a BYPASSRLS role", async () => {
    await expect(
      assertRlsEnforced(fakePool(goodTables(), { ...goodRole, rolbypassrls: true })),
    ).rejects.toThrow(/BYPASSRLS/);
  });

  it("refuses a table owner role", async () => {
    const tables = goodTables().map((row) => ({ ...row, owner: "app" }));
    await expect(assertRlsEnforced(fakePool(tables, goodRole))).rejects.toThrow(/owns public/);
  });
});
