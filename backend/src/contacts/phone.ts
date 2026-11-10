import { parsePhoneNumberFromString } from "libphonenumber-js";

import { InvalidPhoneError } from "../common/errors";

/**
 * Normalises Nigerian national and international input (`0803…`, `803…`,
 * `+234…`) to E.164 using libphonenumber-js (default region NG). Throws
 * InvalidPhoneError (400, no input in the message) on invalid numbers so raw
 * numbers never reach logs (AGENTS.md 9.2 rule 10).
 */
export function normalizePhoneToE164(raw: string): string {
  if (typeof raw !== "string") throw new InvalidPhoneError();
  const phone = parsePhoneNumberFromString(raw.trim(), "NG");
  if (phone === undefined || !phone.isValid()) throw new InvalidPhoneError();
  return phone.format("E.164");
}
