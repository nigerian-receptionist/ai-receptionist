import { z } from "zod";

const csv = z
  .string()
  .transform((value) => value.split(",").map((item) => item.trim()).filter(Boolean));

/** Every runtime setting, validated once at startup. Documented in .env.example. */
export const envSchema = z.object({
  APP_ENV: z.enum(["local", "dev", "staging", "prod"]).default("local"),
  PORT: z.coerce.number().int().positive().default(8000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DEFAULT_TIMEZONE: z.string().default("Africa/Lagos"),
  ALLOWED_ORIGINS: csv.default(["http://localhost:3000", "http://127.0.0.1:3000"]),
  /** Connects as the non-owner application role so row-level security applies. */
  DATABASE_URL: z.string().url(),
  /** Owner role; used only by migrations and seeding, never by the running app. */
  DATABASE_MIGRATION_URL: z.string().url().optional(),
  VALKEY_URL: z.string().url().default("redis://127.0.0.1:6379/0"),

  /** Local-only stand-in for real auth: this token maps to DEV_TENANT_ID. Refused outside local/dev. */
  DEV_ACCESS_TOKEN: z.string().min(24).optional(),
  DEV_TENANT_ID: z.string().uuid().optional(),

  CARTESIA_API_KEY: z.string().min(1),
  CARTESIA_VERSION: z.string().default("2025-04-16"),
  STT_MODEL: z.string().default("ink-2"),
  STT_LANGUAGE: z.string().default("en"),
  TTS_MODEL: z.string().default("sonic-3.6-2026-08-27"),
  /** Cartesia voice "seun" (Nigerian accent). See ADR 0007. */
  TTS_VOICE: z.string().default("63b389ff-8a8c-4013-a4d6-df3b893812df"),
  TTS_SAMPLE_RATE: z.coerce.number().int().default(24000),
  /**
   * TTS model revision for the block-cache key (AGENTS.md 5.7, M18). Cartesia
   * exposes no revision, so bump this whenever the TTS model changes.
   */
  TTS_MODEL_REVISION: z.string().min(1).default("unversioned"),

  MUSE_API_KEY: z.string().min(1),
  LLM_BASE_URL: z.string().url().default("https://api.meta.ai/v1"),
  LLM_MODEL: z.string().default("muse-spark-1.3-contributor"),
  LLM_REASONING_EFFORT: z.enum(["minimal", "low", "medium", "high"]).default("minimal"),
  LLM_MAX_COMPLETION_TOKENS: z.coerce.number().int().positive().default(400),
  /** Fire a throwaway prefix-matching chat completion while the notice plays. */
  LLM_WARMUP_ENABLED: z.stringbool().default(true),

  /** Play a pre-rendered opener (matched to the caller's words) while the LLM runs. */
  OPENER_ENABLED: z.stringbool().default(true),
  /** Extra STT keyterms (comma-separated bias phrases; never caller data). */
  STT_KEYTERMS: csv.default([]),

  /** End-of-turn silence the browser VAD waits for, in ms (AGENTS.md 10.3). */
  ENDPOINTING_SILENCE_MS: z.coerce.number().int().positive().default(600),

  /** F4 per-session cost caps (agent turns, turn audio, call length, byte rate, transcript). */
  VOICE_MAX_TURNS: z.coerce.number().int().positive().default(60),
  VOICE_MAX_TURN_AUDIO_S: z.coerce.number().int().positive().default(30),
  VOICE_MAX_SESSION_S: z.coerce.number().int().positive().default(900),
  VOICE_MAX_BYTES_PER_SEC: z.coerce.number().int().positive().default(64000),
  VOICE_MAX_TRANSCRIPT_CHARS: z.coerce.number().int().positive().default(2000),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}
