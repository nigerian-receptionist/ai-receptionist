import { describe, expect, it } from "vitest";

import { normalizePhoneToE164 } from "../../src/contacts/phone";

describe("normalizePhoneToE164", () => {
  it.each([
    ["+2348031234567", "+2348031234567"],
    ["+234 803 123 4567", "+2348031234567"],
    ["08031234567", "+2348031234567"],
    ["0803 123 4567", "+2348031234567"],
    ["8031234567", "+2348031234567"],
  ])("normalises %s", (input, expected) => {
    expect(normalizePhoneToE164(input)).toBe(expected);
  });

  it.each(["123", "not a number", "", "0803"])("rejects %s", (input) => {
    expect(() => normalizePhoneToE164(input)).toThrow("Invalid phone number");
  });
});
