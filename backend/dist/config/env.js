"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.envSchema = void 0;
exports.loadEnv = loadEnv;
const zod_1 = require("zod");
const csv = zod_1.z
    .string()
    .transform((value) => value.split(",").map((item) => item.trim()).filter(Boolean));
/** Every runtime setting, validated once at startup. Documented in .env.example. */
exports.envSchema = zod_1.z.object({
    APP_ENV: zod_1.z.enum(["local", "dev", "staging", "prod"]).default("local"),
    PORT: zod_1.z.coerce.number().int().positive().default(8000),
    LOG_LEVEL: zod_1.z.enum(["debug", "info", "warn", "error"]).default("info"),
    DEFAULT_TIMEZONE: zod_1.z.string().default("Africa/Lagos"),
    ALLOWED_ORIGINS: csv.default(["http://localhost:3000", "http://127.0.0.1:3000"]),
    /** Connects as the non-owner application role so row-level security applies. */
    DATABASE_URL: zod_1.z.string().url(),
    /** Owner role; used only by migrations and seeding, never by the running app. */
    DATABASE_MIGRATION_URL: zod_1.z.string().url().optional(),
    VALKEY_URL: zod_1.z.string().url().default("redis://127.0.0.1:6379/0"),
    /** Local-only stand-in for real auth: this token maps to DEV_TENANT_ID. Refused outside local/dev. */
    DEV_ACCESS_TOKEN: zod_1.z.string().min(24).optional(),
    DEV_TENANT_ID: zod_1.z.string().uuid().optional(),
    CARTESIA_API_KEY: zod_1.z.string().min(1),
    CARTESIA_VERSION: zod_1.z.string().default("2025-04-16"),
    STT_MODEL: zod_1.z.string().default("ink-whisper"),
    STT_LANGUAGE: zod_1.z.string().default("en"),
    TTS_MODEL: zod_1.z.string().default("sonic-2"),
    /** Cartesia voice "seun" (Nigerian accent). See ADR 0007. */
    TTS_VOICE: zod_1.z.string().default("63b389ff-8a8c-4013-a4d6-df3b893812df"),
    TTS_SAMPLE_RATE: zod_1.z.coerce.number().int().default(24000),
    MUSE_API_KEY: zod_1.z.string().min(1),
    LLM_BASE_URL: zod_1.z.string().url().default("https://api.meta.ai/v1"),
    LLM_MODEL: zod_1.z.string().default("muse-spark-1.3-contributor"),
    LLM_REASONING_EFFORT: zod_1.z.enum(["minimal", "low", "medium", "high"]).default("minimal"),
    LLM_MAX_COMPLETION_TOKENS: zod_1.z.coerce.number().int().positive().default(400),
    /** End-of-turn silence the browser VAD waits for, in ms (AGENTS.md 10.3). */
    ENDPOINTING_SILENCE_MS: zod_1.z.coerce.number().int().positive().default(600),
});
function loadEnv(source = process.env) {
    return exports.envSchema.parse(source);
}
//# sourceMappingURL=env.js.map