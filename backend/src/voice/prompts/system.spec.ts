import { describe, expect, it } from "vitest";

import { buildSystemPrompt, VOICE_SYSTEM_PROMPT_VERSION } from "./system";

/** The section 9 hard rules a live call needs must survive prompt edits. */
const REQUIRED_RULES = [
  "never a human",
  "robot or a human",
  "Never imitate or claim to be a real named person",
  "Confirm identity before sharing any personal or financial detail",
  "wrong person, share nothing",
  "says stop, do not call me",
  "end the call at once",
  "sounds like a minor",
  "objects to recording",
  "mentions self-harm",
  "reports abuse",
  "human handover",
  "do not counsel, diagnose, or give legal, medical or financial advice",
  "Never ask for or repeat card numbers, PINs, OTPs",
  "Offer to send links or addresses by WhatsApp or SMS",
];

describe("voice system prompt", () => {
  it("is at version 2 with the persona appended", () => {
    expect(VOICE_SYSTEM_PROMPT_VERSION).toBe(2);
    expect(buildSystemPrompt("Be cheerful.")).toContain("Agent persona:\nBe cheerful.");
    expect(buildSystemPrompt("  ")).not.toContain("Agent persona:");
  });

  for (const rule of REQUIRED_RULES) {
    it(`covers: ${rule.slice(0, 48)}`, () => {
      expect(buildSystemPrompt("")).toContain(rule);
    });
  }
});
