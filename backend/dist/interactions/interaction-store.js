"use strict";
/**
 * Contract between the voice gateway (writer) and the data layer (implementation).
 *
 * The data-layer implementation MUST:
 *   - run every call inside a transaction with `SET LOCAL app.tenant_id = <tenantId>` (RLS),
 *   - redact sensitive values (card numbers, BVN/NIN, NUBAN, OTP/PIN, phone numbers) from
 *     `text` and `spokenText` before writing (AGENTS.md 9.2 rule 10),
 *   - never log raw turn text.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.INTERACTION_STORE = void 0;
/** Nest injection token for InteractionStore. */
exports.INTERACTION_STORE = Symbol("INTERACTION_STORE");
//# sourceMappingURL=interaction-store.js.map