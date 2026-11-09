"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveDevPrincipal = resolveDevPrincipal;
const node_crypto_1 = require("node:crypto");
/**
 * Local stand-in for OIDC: a single shared token mapped to one tenant.
 * Returns null (deny) outside local/dev, when unconfigured, or on mismatch.
 */
function resolveDevPrincipal(token, env) {
    if (env.APP_ENV !== "local" && env.APP_ENV !== "dev")
        return null;
    if (!token || !env.DEV_ACCESS_TOKEN || !env.DEV_TENANT_ID)
        return null;
    const given = Buffer.from(token);
    const expected = Buffer.from(env.DEV_ACCESS_TOKEN);
    if (given.length !== expected.length || !(0, node_crypto_1.timingSafeEqual)(given, expected))
        return null;
    return { tenantId: env.DEV_TENANT_ID };
}
//# sourceMappingURL=dev-auth.js.map