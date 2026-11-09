"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.turns = exports.interactions = exports.contacts = exports.agents = exports.tenants = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
/**
 * Multi-tenant tables (AGENTS.md 8.1/8.2). Every table carries `tenant_id` and
 * an index on `(tenant_id, created_at)`. Row-level security is applied by the
 * hand-written migration in `drizzle/roles_rls.sql`, not by drizzle-kit.
 *
 * IDs are UUIDv7 generated in the application (see `src/common/uuidv7.ts`).
 * Public API ids prefix the raw uuid (`agt_`, `int_`, `trn_`); see
 * `src/interactions/ids.ts`.
 */
exports.tenants = (0, pg_core_1.pgTable)("tenants", {
    id: (0, pg_core_1.uuid)("id").primaryKey(),
    // Mirrors `id` so every tenant table has a uniform `tenant_id` column for
    // RLS policies. Always insert with tenantId === id.
    tenantId: (0, pg_core_1.uuid)("tenant_id").notNull(),
    name: (0, pg_core_1.text)("name").notNull(),
    settings: (0, pg_core_1.jsonb)("settings").$type().notNull().default({}),
    createdAt: (0, pg_core_1.timestamp)("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [(0, pg_core_1.index)("tenants_tenant_created_idx").on(t.tenantId, t.createdAt)]);
exports.agents = (0, pg_core_1.pgTable)("agents", {
    id: (0, pg_core_1.uuid)("id").primaryKey(),
    tenantId: (0, pg_core_1.uuid)("tenant_id").notNull(),
    name: (0, pg_core_1.text)("name").notNull(),
    personaPrompt: (0, pg_core_1.text)("persona_prompt").notNull(),
    voiceId: (0, pg_core_1.text)("voice_id"),
    language: (0, pg_core_1.text)("language").notNull().default("en-NG"),
    status: (0, pg_core_1.text)("status").notNull().default("active"),
    createdAt: (0, pg_core_1.timestamp)("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [(0, pg_core_1.index)("agents_tenant_created_idx").on(t.tenantId, t.createdAt)]);
exports.contacts = (0, pg_core_1.pgTable)("contacts", {
    id: (0, pg_core_1.uuid)("id").primaryKey(),
    tenantId: (0, pg_core_1.uuid)("tenant_id").notNull(),
    phoneE164: (0, pg_core_1.text)("phone_e164").notNull(),
    phoneRaw: (0, pg_core_1.text)("phone_raw"),
    displayName: (0, pg_core_1.text)("display_name"),
    language: (0, pg_core_1.text)("language").notNull().default("en-NG"),
    optOutAt: (0, pg_core_1.timestamp)("opt_out_at", { withTimezone: true }),
    createdAt: (0, pg_core_1.timestamp)("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
    (0, pg_core_1.index)("contacts_tenant_created_idx").on(t.tenantId, t.createdAt),
    (0, pg_core_1.unique)("contacts_tenant_phone_uniq").on(t.tenantId, t.phoneE164),
]);
exports.interactions = (0, pg_core_1.pgTable)("interactions", {
    id: (0, pg_core_1.uuid)("id").primaryKey(),
    tenantId: (0, pg_core_1.uuid)("tenant_id").notNull(),
    agentId: (0, pg_core_1.uuid)("agent_id")
        .notNull()
        .references(() => exports.agents.id),
    contactId: (0, pg_core_1.uuid)("contact_id").references(() => exports.contacts.id),
    channel: (0, pg_core_1.text)("channel").notNull(),
    direction: (0, pg_core_1.text)("direction").notNull(),
    status: (0, pg_core_1.text)("status").notNull().default("open"),
    endReason: (0, pg_core_1.text)("end_reason"),
    recordingState: (0, pg_core_1.text)("recording_state").notNull().default("not_started"),
    noticeBlockId: (0, pg_core_1.text)("notice_block_id"),
    noticeBlockVersion: (0, pg_core_1.integer)("notice_block_version"),
    noticeBlockHash: (0, pg_core_1.text)("notice_block_hash"),
    noticeDeliveredAt: (0, pg_core_1.timestamp)("notice_delivered_at", { withTimezone: true }),
    startedAt: (0, pg_core_1.timestamp)("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: (0, pg_core_1.timestamp)("ended_at", { withTimezone: true }),
    createdAt: (0, pg_core_1.timestamp)("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
    (0, pg_core_1.index)("interactions_tenant_created_idx").on(t.tenantId, t.createdAt),
    (0, pg_core_1.index)("interactions_agent_idx").on(t.agentId),
]);
exports.turns = (0, pg_core_1.pgTable)("turns", {
    id: (0, pg_core_1.uuid)("id").primaryKey(),
    tenantId: (0, pg_core_1.uuid)("tenant_id").notNull(),
    interactionId: (0, pg_core_1.uuid)("interaction_id")
        .notNull()
        .references(() => exports.interactions.id, { onDelete: "cascade" }),
    seq: (0, pg_core_1.integer)("seq").notNull(),
    speaker: (0, pg_core_1.text)("speaker").notNull(),
    text: (0, pg_core_1.text)("text").notNull(),
    spokenText: (0, pg_core_1.text)("spoken_text"),
    language: (0, pg_core_1.text)("language").notNull().default("en-NG"),
    interrupted: (0, pg_core_1.boolean)("interrupted").notNull().default(false),
    sttModelId: (0, pg_core_1.text)("stt_model_id"),
    sttConfidence: (0, pg_core_1.doublePrecision)("stt_confidence"),
    llmModel: (0, pg_core_1.text)("llm_model"),
    ttsModelId: (0, pg_core_1.text)("tts_model_id"),
    voiceId: (0, pg_core_1.text)("voice_id"),
    blockId: (0, pg_core_1.text)("block_id"),
    blockVersion: (0, pg_core_1.integer)("block_version"),
    blockHash: (0, pg_core_1.text)("block_hash"),
    timingsMs: (0, pg_core_1.jsonb)("timings_ms").$type().notNull().default({}),
    tokens: (0, pg_core_1.jsonb)("tokens").$type(),
    createdAt: (0, pg_core_1.timestamp)("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
    (0, pg_core_1.index)("turns_tenant_created_idx").on(t.tenantId, t.createdAt),
    (0, pg_core_1.unique)("turns_interaction_seq_uniq").on(t.interactionId, t.seq),
]);
//# sourceMappingURL=schema.js.map