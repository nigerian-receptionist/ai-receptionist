"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.encodeCursor = encodeCursor;
exports.decodeCursor = decodeCursor;
const zod_1 = require("zod");
const payloadSchema = zod_1.z.object({
    id: zod_1.z.string().uuid(),
});
/**
 * Opaque base64url cursor for keyset pagination over id DESC. Ids are UUIDv7,
 * so id order is creation order (newest first) and the sort is stable.
 */
function encodeCursor(payload) {
    return Buffer.from(JSON.stringify(payloadSchema.parse(payload)), "utf8").toString("base64url");
}
/** Returns null for any malformed or tampered cursor (caller maps to 400). */
function decodeCursor(cursor) {
    try {
        return payloadSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=cursor.js.map