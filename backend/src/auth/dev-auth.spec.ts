import { describe, expect, it } from "vitest";

import { loadEnv } from "../config/env";
import { resolveDevPrincipal } from "./dev-auth";

const base = {
  DATABASE_URL: "postgresql://u:p@127.0.0.1:5433/db",
  CARTESIA_API_KEY: "test-cartesia",
  MUSE_API_KEY: "test-muse",
  DEV_ACCESS_TOKEN: "local-dev-token-0123456789abcdef",
  DEV_TENANT_ID: "0195f3a0-0000-7000-8000-000000000001",
};

describe("resolveDevPrincipal", () => {
  it("accepts the configured token locally", () => {
    expect(resolveDevPrincipal(base.DEV_ACCESS_TOKEN, loadEnv(base))).toEqual({
      tenantId: base.DEV_TENANT_ID,
    });
  });

  it("rejects a wrong or missing token", () => {
    const env = loadEnv(base);
    expect(resolveDevPrincipal("local-dev-token-0123456789abcdeX", env)).toBeNull();
    expect(resolveDevPrincipal(undefined, env)).toBeNull();
  });

  it("is disabled in staging and prod", () => {
    for (const APP_ENV of ["staging", "prod"]) {
      expect(resolveDevPrincipal(base.DEV_ACCESS_TOKEN, loadEnv({ ...base, APP_ENV }))).toBeNull();
    }
  });
});
