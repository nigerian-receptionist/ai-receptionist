import type { Pool } from "pg";

/** Tenant tables that must carry forced row-level security. */
export const RLS_TENANT_TABLES = ["agents", "contacts", "interactions", "turns", "tenants"] as const;

interface RlsRow {
  relname: string;
  relrowsecurity: boolean;
  relforcerowsecurity: boolean;
  owner: string;
}

interface RoleRow {
  rolname: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
}

/**
 * M24: fail fast when the database role/table setup cannot enforce tenant
 * isolation. Every tenant table must exist with RLS enabled AND forced, and
 * the connected role must be neither a superuser, a table owner, nor
 * BYPASSRLS (AGENTS.md 8.1). Throws with every violation listed.
 */
export async function assertRlsEnforced(pool: Pool): Promise<void> {
  const tables = await pool.query<RlsRow>(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
            pg_get_userbyid(c.relowner) AS owner
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = ANY($1)`,
    [[...RLS_TENANT_TABLES]],
  );
  const problems: string[] = [];
  const byName = new Map(tables.rows.map((row) => [row.relname, row]));
  for (const name of RLS_TENANT_TABLES) {
    const row = byName.get(name);
    if (!row) {
      problems.push(`table public.${name} is missing`);
      continue;
    }
    if (!row.relrowsecurity) problems.push(`table public.${name} lacks row-level security`);
    if (!row.relforcerowsecurity) problems.push(`table public.${name} lacks FORCE row-level security`);
  }
  const roles = await pool.query<RoleRow>(
    "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  );
  const role = roles.rows[0];
  if (!role) {
    problems.push("cannot determine current_user");
  } else {
    if (role.rolsuper) problems.push(`role ${role.rolname} is a superuser`);
    if (role.rolbypassrls) problems.push(`role ${role.rolname} has BYPASSRLS`);
    for (const row of tables.rows) {
      if (row.owner === role.rolname) {
        problems.push(`role ${role.rolname} owns public.${row.relname} (owners bypass RLS unless forced)`);
      }
    }
  }
  if (problems.length > 0) throw new Error(`RLS safety check failed: ${problems.join("; ")}`);
}
