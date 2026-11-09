-- Roles and row-level security (AGENTS.md 8.1, 9.4).
--
-- Hand-written, idempotent: safe to run on every deploy. Must run as the table
-- owner (DATABASE_MIGRATION_URL) AFTER the drizzle-kit migrations.
--
-- Production note: pre-create `ai_receptionist_app` with a vault password. This
-- script only sets the placeholder password when creating the role; it never
-- resets the password of an existing role.

-- 1. Application role: LOGIN, NOT superuser, NOT owner of the tables, no BYPASSRLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ai_receptionist_app') THEN
    CREATE ROLE ai_receptionist_app WITH LOGIN PASSWORD 'change-me-app-local-only';
  END IF;
END
$$;

ALTER ROLE ai_receptionist_app WITH
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS LOGIN;

-- 2. Least-privilege grants (all statements are idempotent).
DO $$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO ai_receptionist_app',
    current_database()
  );
END
$$;

GRANT USAGE ON SCHEMA public TO ai_receptionist_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ai_receptionist_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ai_receptionist_app;

DO $$
BEGIN
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public ' ||
    'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ai_receptionist_app',
    CURRENT_USER
  );
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public ' ||
    'GRANT USAGE, SELECT ON SEQUENCES TO ai_receptionist_app',
    CURRENT_USER
  );
END
$$;

-- 3. FORCE ROW LEVEL SECURITY on every tenant table. With no tenant set,
-- current_setting('app.tenant_id', true) returns NULL (or '' on a recycled pool
-- connection after SET LOCAL + COMMIT, a Postgres placeholder quirk), NULLIF
-- folds both to NULL, and `tenant_id = NULL` is never true, so the app role
-- sees zero rows.

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenants;
CREATE POLICY tenant_isolation ON tenants
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agents;
CREATE POLICY tenant_isolation ON agents
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON contacts;
CREATE POLICY tenant_isolation ON contacts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE interactions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON interactions;
CREATE POLICY tenant_isolation ON interactions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE turns FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON turns;
CREATE POLICY tenant_isolation ON turns
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
