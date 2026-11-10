import { z } from "zod";

const payloadSchema = z.object({
  id: z.string().uuid(),
});

export type CursorPayload = z.infer<typeof payloadSchema>;

/**
 * Opaque base64url cursor for keyset pagination over id DESC. Ids are UUIDv7,
 * so id order is creation order (newest first) and the sort is stable.
 *
 * Cursors are NOT tenant-bound (no HMAC): a cursor minted for tenant A is
 * only a row id, and every list query re-applies RLS, so replaying another
 * tenant's cursor under tenant B can only page B's own rows (at worst it
 * skips or repeats B's rows). Cross-tenant reads stay impossible.
 */
export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payloadSchema.parse(payload)), "utf8").toString("base64url");
}

/** Returns null for any malformed or tampered cursor (caller maps to 400). */
export function decodeCursor(cursor: string): CursorPayload | null {
  try {
    return payloadSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}
