import { timingSafeEqual } from "node:crypto";

import type { Env } from "../config/env";

export interface Principal {
  tenantId: string;
}

/**
 * Local stand-in for OIDC: a single shared token mapped to one tenant.
 * Returns null (deny) outside local/dev, when unconfigured, or on mismatch.
 */
export function resolveDevPrincipal(token: string | undefined | null, env: Env): Principal | null {
  if (env.APP_ENV !== "local" && env.APP_ENV !== "dev") return null;
  if (!token || !env.DEV_ACCESS_TOKEN || !env.DEV_TENANT_ID) return null;
  const given = Buffer.from(token);
  const expected = Buffer.from(env.DEV_ACCESS_TOKEN);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return { tenantId: env.DEV_TENANT_ID };
}
