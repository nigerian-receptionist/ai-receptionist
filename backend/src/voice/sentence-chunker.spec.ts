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
  ["She likes apples e.g. green ones. Really.", ["She likes apples e.g. green ones.", "Really."]],
  ["J. K. Rowling writes books. Yes.", ["J. K. Rowling writes books.", "Yes."]],
  ["Acme Ltd. headquarters are here. Good.", ["Acme Ltd. headquarters are here.", "Good."]],
  ["Mr. Smith Sr. arrived today. Welcome.", ["Mr. Smith Sr. arrived today.", "Welcome."]],
  // M28: the first clause splits early (6+ words); later commas keep the 60-char rule.
  [
    "Your balance is twelve thousand naira, and your next payment is due soon, please confirm.",
    [
      "Your balance is twelve thousand naira,",
      "and your next payment is due soon, please confirm.",
    ],
  ],
  [
    "Hello there my good old friend, how are you today?",
    ["Hello there my good old friend,", "how are you today?"],
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

  it("defers a long-clause comma at buffer end until lookahead arrives", () => {
    const chunker = new SentenceChunker();
    expect(chunker.push("Please confirm that your payment of forty-five thousand naira is correct,")).toEqual([]);
    expect(chunker.push(" and then proceed. Thanks")).toEqual([
      "Please confirm that your payment of forty-five thousand naira is correct,",
      "and then proceed.",
    ]);
    expect(chunker.flush()).toEqual(["Thanks"]);
  });

  it("flushIfTerminal emits a terminal-complete tail without lookahead", () => {
    const chunker = new SentenceChunker();
    expect(chunker.push("Hello there.")).toEqual([]);
    expect(chunker.flushIfTerminal()).toEqual(["Hello there."]);
    expect(chunker.flush()).toEqual([]);
  });

  it("flushIfTerminal holds abbreviation, initial and mid-number tails", () => {
    for (const tail of ["Call Mr.", "For J.", "It costs 2."]) {
      const chunker = new SentenceChunker();
      expect(chunker.push(tail)).toEqual([]);
      expect(chunker.flushIfTerminal()).toEqual([]);
      expect(chunker.pending).toContain(tail.trim());
    }
  });

  it("flushIfTerminal ignores a non-terminal tail", () => {
    const chunker = new SentenceChunker();
    expect(chunker.push("Hello there")).toEqual([]);
    expect(chunker.flushIfTerminal()).toEqual([]);
  });

  it("never splits thousand,000 spread across deltas in a long clause", () => {
    const chunker = new SentenceChunker();
    expect(chunker.push("Please confirm that your current balance of forty-five thousand,")).toEqual([]);
    expect(chunker.push("000 naira is due today. Next")).toEqual([
      "Please confirm that your current balance of forty-five thousand,000 naira is due today.",
    ]);
    expect(chunker.flush()).toEqual(["Next"]);
  });
});
