import { z } from "zod";

const uuidSchema = z.string().uuid();

export type IdPrefix = "int" | "trn" | "agt";

const KNOWN_PREFIXES: readonly string[] = ["int", "trn", "agt"];

/** Formats a raw uuid as a public prefixed id (`int_<uuid>`). */
export function toPublicId(prefix: IdPrefix, uuid: string): string {
  return `${prefix}_${uuidSchema.parse(uuid)}`;
}

/**
 * Accepts a public prefixed id or a raw uuid and returns the raw uuid.
 * When `expectedPrefix` is given, a present prefix must match it.
 * Throws on invalid input; REST controllers map this to 400.
 */
export function toRawId(id: string, expectedPrefix?: IdPrefix): string {
  const trimmed = id.trim();
  const sep = trimmed.indexOf("_");
  if (sep > 0) {
    const prefix = trimmed.slice(0, sep);
    const rest = trimmed.slice(sep + 1);
    if (!KNOWN_PREFIXES.includes(prefix)) throw new Error(`Unknown id prefix in ${prefix}_…`);
    if (expectedPrefix !== undefined && prefix !== expectedPrefix) {
      throw new Error(`Expected an ${expectedPrefix}_… id`);
    }
    return uuidSchema.parse(rest);
  }
  return uuidSchema.parse(trimmed);
}
