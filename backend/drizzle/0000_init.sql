CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"persona_prompt" text NOT NULL,
	"voice_id" text,
	"language" text DEFAULT 'en-NG' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"phone_e164" text NOT NULL,
	"phone_raw" text,
	"display_name" text,
	"language" text DEFAULT 'en-NG' NOT NULL,
	"opt_out_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_tenant_phone_uniq" UNIQUE("tenant_id","phone_e164")
);
--> statement-breakpoint
CREATE TABLE "interactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"contact_id" uuid,
	"channel" text NOT NULL,
	"direction" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"end_reason" text,
	"recording_state" text DEFAULT 'not_started' NOT NULL,
	"notice_block_id" text,
	"notice_block_version" integer,
	"notice_block_hash" text,
	"notice_delivered_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"interaction_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"speaker" text NOT NULL,
	"text" text NOT NULL,
	"spoken_text" text,
	"language" text DEFAULT 'en-NG' NOT NULL,
	"interrupted" boolean DEFAULT false NOT NULL,
	"stt_model_id" text,
	"stt_confidence" double precision,
	"llm_model" text,
	"tts_model_id" text,
	"voice_id" text,
	"block_id" text,
	"block_version" integer,
	"block_hash" text,
	"timings_ms" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tokens" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "turns_interaction_seq_uniq" UNIQUE("interaction_id","seq")
);
--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_tenant_created_idx" ON "agents" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "contacts_tenant_created_idx" ON "contacts" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "interactions_tenant_created_idx" ON "interactions" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "interactions_agent_idx" ON "interactions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "tenants_tenant_created_idx" ON "tenants" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "turns_tenant_created_idx" ON "turns" USING btree ("tenant_id","created_at");