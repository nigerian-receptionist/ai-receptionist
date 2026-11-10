import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Multi-tenant tables (AGENTS.md 8.1/8.2). Every table carries `tenant_id` and
 * an index on `(tenant_id, created_at)`. Row-level security is applied by the
 * hand-written migration in `drizzle/roles_rls.sql`, not by drizzle-kit.
 *
 * IDs are UUIDv7 generated in the application (see `src/common/uuidv7.ts`).
 * Public API ids prefix the raw uuid (`agt_`, `int_`, `trn_`); see
 * `src/interactions/ids.ts`.
 */

export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey(),
    // Mirrors `id` so every tenant table has a uniform `tenant_id` column for
    // RLS policies. Always insert with tenantId === id.
    tenantId: uuid("tenant_id").notNull(),
    name: text("name").notNull(),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tenants_tenant_created_idx").on(t.tenantId, t.createdAt)],
);

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    name: text("name").notNull(),
    personaPrompt: text("persona_prompt").notNull(),
    voiceId: text("voice_id"),
    language: text("language").notNull().default("en-NG"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agents_tenant_created_idx").on(t.tenantId, t.createdAt)],
);

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    phoneE164: text("phone_e164").notNull(),
    phoneRaw: text("phone_raw"),
    displayName: text("display_name"),
    language: text("language").notNull().default("en-NG"),
    optOutAt: timestamp("opt_out_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("contacts_tenant_created_idx").on(t.tenantId, t.createdAt),
    unique("contacts_tenant_phone_uniq").on(t.tenantId, t.phoneE164),
  ],
);

export const interactions = pgTable(
  "interactions",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    contactId: uuid("contact_id").references(() => contacts.id),
    channel: text("channel").notNull(),
    direction: text("direction").notNull(),
    status: text("status").notNull().default("open"),
    endReason: text("end_reason"),
    recordingState: text("recording_state").notNull().default("not_started"),
    noticeBlockId: text("notice_block_id"),
    noticeBlockVersion: integer("notice_block_version"),
    noticeBlockHash: text("notice_block_hash"),
    noticeDeliveredAt: timestamp("notice_delivered_at", { withTimezone: true }),
    // Compliance flags (e.g. "notice_failed" when the disclosure/notice was
    // never confirmed). Set only via endInteraction; empty means no flags.
    complianceFlags: jsonb("compliance_flags").$type<string[]>().notNull().default([]),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("interactions_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("interactions_agent_idx").on(t.agentId),
  ],
);

export const turns = pgTable(
  "turns",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    interactionId: uuid("interaction_id")
      .notNull()
      .references(() => interactions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    speaker: text("speaker").notNull(),
    text: text("text").notNull(),
    spokenText: text("spoken_text"),
    language: text("language").notNull().default("en-NG"),
    interrupted: boolean("interrupted").notNull().default(false),
    sttModelId: text("stt_model_id"),
    sttConfidence: doublePrecision("stt_confidence"),
    llmModel: text("llm_model"),
    ttsModelId: text("tts_model_id"),
    voiceId: text("voice_id"),
    blockId: text("block_id"),
    blockVersion: integer("block_version"),
    blockHash: text("block_hash"),
    timingsMs: jsonb("timings_ms").$type<Record<string, number | null>>().notNull().default({}),
    tokens: jsonb("tokens").$type<{
      in: number | null;
      out: number | null;
      reasoning: number | null;
    } | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("turns_tenant_created_idx").on(t.tenantId, t.createdAt),
    unique("turns_interaction_seq_uniq").on(t.interactionId, t.seq),
  ],
);

export type TenantRow = typeof tenants.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type ContactRow = typeof contacts.$inferSelect;
export type InteractionRow = typeof interactions.$inferSelect;
export type TurnRow = typeof turns.$inferSelect;

export type NewTenant = typeof tenants.$inferInsert;
export type NewAgent = typeof agents.$inferInsert;
export type NewContact = typeof contacts.$inferInsert;
export type NewInteraction = typeof interactions.$inferInsert;
export type NewTurn = typeof turns.$inferInsert;
