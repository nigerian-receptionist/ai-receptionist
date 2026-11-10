import { z } from "zod";

import { InvalidIdError } from "../common/errors";

const uuidSchema = z.string().uuid();

export type IdPrefix = "int" | "trn" | "agt" | "con";

const KNOWN_PREFIXES: readonly string[] = ["int", "trn", "agt", "con"];

/** Formats a raw uuid as a public prefixed id (`int_<uuid>`). */
export function toPublicId(prefix: IdPrefix, uuid: string): string {
  return `${prefix}_${uuidSchema.parse(uuid)}`;
}

/**
 * Accepts a public prefixed id or a raw uuid and returns the raw uuid.
 * When `expectedPrefix` is given, a present prefix must match it.
 * Throws InvalidIdError on invalid input (mapped to 400 invalid-id).
 */
export function toRawId(id: string, expectedPrefix?: IdPrefix): string {
  const parseUuid = (value: string, resource: string): string => {
    const parsed = uuidSchema.safeParse(value);
    if (!parsed.success) throw new InvalidIdError(resource);
    return parsed.data;
  };
  const trimmed = (id ?? "").trim();
  const sep = trimmed.indexOf("_");
  if (sep > 0) {
    const prefix = trimmed.slice(0, sep);
    const rest = trimmed.slice(sep + 1);
    if (!KNOWN_PREFIXES.includes(prefix)) throw new InvalidIdError("id");
    if (expectedPrefix !== undefined && prefix !== expectedPrefix) {
      throw new InvalidIdError(`${expectedPrefix}_… id`);
    }
    return parseUuid(rest, expectedPrefix ?? "id");
  }
  return parseUuid(trimmed, expectedPrefix ?? "id");
}
