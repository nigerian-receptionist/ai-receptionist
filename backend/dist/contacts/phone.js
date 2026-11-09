"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizePhoneToE164 = normalizePhoneToE164;
const libphonenumber_js_1 = require("libphonenumber-js");
/**
 * Normalises Nigerian national and international input (`0803…`, `803…`,
 * `+234…`) to E.164 using libphonenumber-js (default region NG). Throws a
 * generic error without the input on invalid numbers so raw numbers never
 * reach logs (AGENTS.md 9.2 rule 10).
 */
function normalizePhoneToE164(raw) {
    const phone = (0, libphonenumber_js_1.parsePhoneNumberFromString)(raw.trim(), "NG");
    if (phone === undefined || !phone.isValid())
        throw new Error("Invalid phone number");
    return phone.format("E.164");
}
//# sourceMappingURL=phone.js.map