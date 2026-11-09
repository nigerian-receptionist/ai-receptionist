"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.uuidv7 = uuidv7;
const node_crypto_1 = require("node:crypto");
/**
 * Generates a UUIDv7 (RFC 9562): 48-bit unix timestamp in ms plus 74 random
 * bits. Time-ordered, so index-local like v7 requires (AGENTS.md 7.3).
 */
function uuidv7(nowMs = Date.now()) {
    const bytes = (0, node_crypto_1.randomBytes)(16);
    const timeHex = Math.floor(nowMs).toString(16).padStart(12, "0").slice(-12);
    for (let i = 0; i < 6; i += 1) {
        bytes[i] = parseInt(timeHex.slice(i * 2, i * 2 + 2), 16);
    }
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = Buffer.from(bytes).toString("hex");
    return (`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
        `${hex.slice(16, 20)}-${hex.slice(20)}`);
}
//# sourceMappingURL=uuidv7.js.map