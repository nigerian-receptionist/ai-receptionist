import { describe, expect, it } from "vitest";

import { applySpeakPolicy } from "./speak-policy";

const CASES: Array<{ name: string; input: string; safe: string; tripped: boolean }> = [
  {
    name: "card echo becomes a safe phrase",
    input: "Your card 4111 1111 1111 1111 is noted.",
    safe: "Your card your card number is noted.",
    tripped: true,
  },
  {
    name: "grouped BVN echo becomes a safe phrase",
    input: "So your BVN is 2212 345 6789, correct?",
    safe: "So your BVN is your B V N, correct?",
    tripped: true,
  },
  {
    name: "account number echo becomes a safe phrase",
    input: "I see account 0123 456 789 here.",
    safe: "I see account your account number here.",
    tripped: true,
  },
  {
    name: "OTP echo becomes a safe phrase",
    input: "The code 123 456 will expire soon.",
    safe: "The code that code will expire soon.",
    tripped: true,
  },
  {
    name: "phone echo becomes a safe phrase",
    input: "I will call 0803 123 4567 back.",
    safe: "I will call your phone number back.",
    tripped: true,
  },
  {
    name: "email echo becomes a safe phrase",
    input: "I sent it to ada@example.com just now.",
    safe: "I sent it to your email address just now.",
    tripped: true,
  },
  {
    name: "URL echo becomes a safe phrase",
    input: "Open https://example.com/pay to continue.",
    safe: "Open that link to continue.",
    tripped: true,
  },
  {
    name: "clean sentence passes through",
    input: "Your balance is twelve thousand naira.",
    safe: "Your balance is twelve thousand naira.",
    tripped: false,
  },
  {
    name: "last-four reference passes through",
    input: "The card ending in 4421 is active.",
    safe: "The card ending in 4421 is active.",
    tripped: false,
  },
];

describe("applySpeakPolicy", () => {
  for (const { name, input, safe, tripped } of CASES) {
    it(name, () => {
      expect(applySpeakPolicy(input)).toMatchObject({ safe, tripped });
    });
  }

  it("reports which kinds tripped without the values", () => {
    const result = applySpeakPolicy("Card 4111111111111111 and code 4421.");
    expect(result.tripped).toBe(true);
    expect(result.kinds).toEqual(["card", "otp"]);
    expect(result.safe).not.toContain("4111");
    expect(result.safe).not.toContain("4421");
  });
});
