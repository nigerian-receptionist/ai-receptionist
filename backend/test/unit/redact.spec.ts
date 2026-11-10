import { describe, expect, it } from "vitest";

import { redact } from "../../src/privacy/redact";

const CASES: Array<{ name: string; input: string; expected: string }> = [
  {
    name: "valid card with spaces",
    input: "my card is 4539 1488 0343 6467",
    expected: "my card is [CARD]",
  },
  {
    name: "valid card contiguous",
    input: "4111111111111111",
    expected: "[CARD]",
  },
  {
    name: "16 digits failing Luhn are left alone",
    input: "4111111111111112",
    expected: "4111111111111112",
  },
  {
    name: "BVN 11 digits",
    input: "my BVN is 22123456789",
    expected: "my BVN is [BVN_OR_NIN]",
  },
  {
    name: "BVN grouped with spaces (STT style)",
    input: "my BVN is 2212 345 6789",
    expected: "my BVN is [BVN_OR_NIN]",
  },
  {
    name: "BVN grouped with dashes",
    input: "bvn 2212-345-6789",
    expected: "bvn [BVN_OR_NIN]",
  },
  {
    name: "NUBAN 10 digits",
    input: "account 1234567890",
    expected: "account [ACCOUNT]",
  },
  {
    name: "NUBAN grouped with spaces",
    input: "acct 0123 456 789",
    expected: "acct [ACCOUNT]",
  },
  {
    name: "NUBAN grouped with dashes",
    input: "account 0123-456-789",
    expected: "account [ACCOUNT]",
  },
  { name: "OTP phrase", input: "my OTP is 123456", expected: "my OTP is [OTP]" },
  {
    name: "OTP grouped with spaces",
    input: "the code is 123 456",
    expected: "the code is [OTP]",
  },
  {
    name: "OTP grouped with dashes",
    input: "OTP: 12-34-56",
    expected: "OTP: [OTP]",
  },
  { name: "code with colon", input: "code: 4421", expected: "code: [OTP]" },
  { name: "PIN", input: "PIN 1234", expected: "PIN [OTP]" },
  { name: "PIN grouped", input: "PIN 12 34", expected: "PIN [OTP]" },
  { name: "password digits", input: "password 567890", expected: "password [OTP]" },
  {
    name: "long run after code is not an OTP",
    input: "code 08031234567",
    expected: "code [PHONE]",
  },
  { name: "phone +234", input: "call +2348031234567", expected: "call [PHONE]" },
  {
    name: "phone +234 spaced",
    input: "call +234 803 123 4567",
    expected: "call [PHONE]",
  },
  { name: "phone local", input: "call 08031234567", expected: "call [PHONE]" },
  {
    name: "phone local spaced",
    input: "call 0803 123 4567",
    expected: "call [PHONE]",
  },
  {
    name: "email",
    input: "mail ada@example.com thanks",
    expected: "mail [EMAIL] thanks",
  },
  {
    name: "https URL",
    input: "visit https://example.com/pay now",
    expected: "visit [URL] now",
  },
  {
    name: "URL keeps trailing punctuation",
    input: "see https://example.com.",
    expected: "see [URL].",
  },
  {
    name: "www URL",
    input: "see www.example.com.ng/a for details",
    expected: "see [URL] for details",
  },
  {
    name: "combined",
    input: "BVN 22123456789 and card 4111111111111111",
    expected: "BVN [BVN_OR_NIN] and card [CARD]",
  },
  { name: "naira amount intact", input: "45,000 naira", expected: "45,000 naira" },
  { name: "time intact", input: "meeting at 14:30", expected: "meeting at 14:30" },
  { name: "date intact", input: "on 28/10", expected: "on 28/10" },
  { name: "last-four intact", input: "ending in 4421", expected: "ending in 4421" },
  {
    name: "short digit groups without a keyword are intact",
    input: "reference 123 456",
    expected: "reference 123 456",
  },
  { name: "plain text intact", input: "hello, how are you?", expected: "hello, how are you?" },
];

describe("redact", () => {
  for (const { name, input, expected } of CASES) {
    it(name, () => {
      expect(redact(input)).toBe(expected);
    });
  }
});
