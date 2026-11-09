import { describe, expect, it } from "vitest";

import { normaliseForSpeech } from "./normalise";

const CASES: [input: string, expected: string][] = [
  // Naira amounts (AGENTS.md 5.6)
  ["N45,000", "forty-five thousand naira"],
  ["NGN 45,000", "forty-five thousand naira"],
  ["₦45,000", "forty-five thousand naira"],
  ["N1.5m", "one point five million naira"],
  ["N2.3bn", "two point three billion naira"],
  ["N50k", "fifty thousand naira"],
  ["Your balance is N12,500.", "Your balance is twelve thousand five hundred naira."],
  // Phones as digit groups
  ["Call 0803 123 4567 today", "Call zero eight zero three, one two three, four five six seven today"],
  ["Call +234 803 123 4567 today", "Call plus two three four, eight zero three, one two three, four five six seven today"],
  ["Call 08031234567 today", "Call zero eight zero three, one two three, four five six seven today"],
  // Ending in
  ["ending in 4421", "ending in four, four, two, one"],
  // Times
  ["at 2:30pm", "at half past two in the afternoon"],
  ["at 14:30", "at two thirty p m"],
  ["at 9:00am", "at nine o'clock in the morning"],
  ["at 8:15pm", "at eight fifteen in the evening"],
  // Dates
  ["on 28/10", "on the twenty-eighth of October"],
  ["on Oct 28", "on the twenty-eighth of October"],
  ["on 28th Oct", "on the twenty-eighth of October"],
  ["on 28 October", "on the twenty-eighth of October"],
  // Acronyms
  ["your BVN is safe", "your B V N is safe"],
  // Markdown, emoji, bullets
  ["**Pay now** please", "Pay now please"],
  ["- one\n- two", "one\ntwo"],
  ["Hello 👋 there", "Hello there"],
  ["# Heading", "Heading"],
  // URLs and emails are never read aloud
  ["visit https://example.com/pay now", "visit now"],
  ["email me at ada@example.com soon", "email me at soon"],
  ["see [the portal](https://example.com) now", "see the portal now"],
  // Numbers with separators survive untouched for the chunker
  ["It costs N45,000 for 2.30 metres", "It costs forty-five thousand naira for 2.30 metres"],
];

describe("normaliseForSpeech", () => {
  it.each(CASES)("normalises %j", (input, expected) => {
    expect(normaliseForSpeech(input)).toBe(expected);
  });
});
