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
    DATABASE_URL: zod_1.z.string().url(),
    VALKEY_URL: zod_1.z.string().url().default("redis://127.0.0.1:6379/0"),
});
function loadEnv(source = process.env) {
    return exports.envSchema.parse(source);
}
//# sourceMappingURL=env.js.map