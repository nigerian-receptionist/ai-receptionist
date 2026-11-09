import { parsePhoneNumberFromString } from "libphonenumber-js";

/**
 * Normalises Nigerian national and international input (`0803…`, `803…`,
 * `+234…`) to E.164 using libphonenumber-js (default region NG). Throws a
 * generic error without the input on invalid numbers so raw numbers never
 * reach logs (AGENTS.md 9.2 rule 10).
 */
export function normalizePhoneToE164(raw: string): string {
  const phone = parsePhoneNumberFromString(raw.trim(), "NG");
  if (phone === undefined || !phone.isValid()) throw new Error("Invalid phone number");
  return phone.format("E.164");
}
