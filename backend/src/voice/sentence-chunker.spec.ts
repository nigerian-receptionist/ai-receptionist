import { describe, expect, it } from "vitest";

import { SentenceChunker, splitSentences } from "./sentence-chunker";

const CASES: [input: string, expected: string[]][] = [
  ["Hello. How are you?", ["Hello.", "How are you?"]],
  ["Really?! Yes!", ["Really?!", "Yes!"]],
  ["It costs N45,000 for 2.30 metres of cable.", ["It costs N45,000 for 2.30 metres of cable."]],
  ["Mr. Smith called Dr. Ada today.", ["Mr. Smith called Dr. Ada today."]],
  ["Pay 1.5m naira now. Thank you.", ["Pay 1.5m naira now.", "Thank you."]],
  ['She said "call me." Then she left.', ['She said "call me."', "Then she left."]],
  ["First line\nSecond line", ["First line", "Second line"]],
  ["No punctuation here", ["No punctuation here"]],
  [
    "Your balance is twelve thousand naira, and your next payment is due soon, please confirm.",
    [
      "Your balance is twelve thousand naira, and your next payment is due soon,",
      "please confirm.",
    ],
  ],
  [
    "This is a very long opening clause that keeps going past the limit, then it finally breaks here.",
    [
      "This is a very long opening clause that keeps going past the limit,",
      "then it finally breaks here.",
    ],
  ],
];

describe("splitSentences", () => {
  it.each(CASES)("splits %j", (input, expected) => {
    expect(splitSentences(input)).toEqual(expected);
  });
});

describe("SentenceChunker streaming", () => {
  it("emits complete sentences as deltas arrive and holds the tail", () => {
    const chunker = new SentenceChunker();
    expect(chunker.push("Hello. How")).toEqual(["Hello."]);
    expect(chunker.push(" are you")).toEqual([]);
    expect(chunker.push(" today? Fine")).toEqual(["How are you today?"]);
    expect(chunker.flush()).toEqual(["Fine"]);
  });

  it("never splits a number spread across deltas", () => {
    const chunker = new SentenceChunker();
    expect(chunker.push("It costs N45,")).toEqual([]);
    expect(chunker.push("000 ok. Next")).toEqual(["It costs N45,000 ok."]);
    expect(chunker.flush()).toEqual(["Next"]);
  });
});
