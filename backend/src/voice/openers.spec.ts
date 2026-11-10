import { describe, expect, it } from "vitest";

import {
  OPENERS,
  OpenerSelector,
  classifyCallerTurn,
  openerMessages,
  type CallerCategory,
} from "./openers";

describe("classifyCallerTurn", () => {
  const table: Array<[string, CallerCategory]> = [
    // question / request
    ["What is my balance?", "question"],
    ["How much do I owe?", "question"],
    ["Can you check my loan?", "question"],
    ["I want to know my balance.", "question"],
    ["Please send me the receipt.", "question"],
    ["I need help with my account.", "question"],
    ["Hi, what is my balance?", "question"],
    ["When will my payment arrive?", "question"],
    ["Abeg, wetin be my balance?", "question"],
    ["Could you book me for Friday?", "question"],
    // problem / complaint / distress (escalation phrases land here, never cheerful)
    ["I have a problem with my account.", "problem"],
    ["This is wrong, I was overcharged.", "problem"],
    ["Your service is terrible.", "problem"],
    ["I can't log in.", "problem"],
    ["My card was stolen.", "problem"],
    ["I am thinking of killing myself.", "problem"],
    ["I will sue you and call my lawyer.", "problem"],
    ["My mother died last week.", "problem"],
    ["Hello, I have a problem.", "problem"],
    ["Wahala dey with my transfer.", "problem"],
    ["Sorry, I missed my payment.", "problem"],
    ["Nobody helped me at the branch.", "problem"],
    // yes / no / confirmation
    ["Yes.", "confirmation"],
    ["Yes, that's right.", "confirmation"],
    ["No.", "confirmation"],
    ["Nope.", "confirmation"],
    ["Correct.", "confirmation"],
    ["Okay.", "confirmation"],
    ["Sure.", "confirmation"],
    ["Hi, yes.", "confirmation"],
    ["Confirmed.", "confirmation"],
    // greeting / thanks / small-talk (no opener)
    ["Hi.", "greeting"],
    ["Hello.", "greeting"],
    ["Good morning.", "greeting"],
    ["Good afternoon.", "greeting"],
    ["Thanks.", "greeting"],
    ["Thank you.", "greeting"],
    ["How are you?", "greeting"],
    ["Hello, how are you?", "greeting"],
    ["Bye.", "greeting"],
    ["How far?", "greeting"],
    // other (no opener)
    ["My name is Adaeze.", "other"],
    ["0803 123 4567.", "other"],
    ["I see.", "other"],
    ["E kaabo.", "other"],
    ["", "other"],
  ];

  for (const [text, category] of table) {
    it(`classifies ${JSON.stringify(text)} as ${category}`, () => {
      expect(classifyCallerTurn(text)).toBe(category);
    });
  }

  it("prefers the substance over a leading greeting", () => {
    expect(classifyCallerTurn("Good morning, my card was stolen.")).toBe("problem");
    expect(classifyCallerTurn("Hello, can you hear me?")).toBe("question");
  });
});

describe("OPENERS", () => {
  it("has two options per opener category with matching tones", () => {
    expect(OPENERS.question).toHaveLength(2);
    expect(OPENERS.problem).toHaveLength(2);
    expect(OPENERS.confirmation).toHaveLength(2);
    for (const option of OPENERS.question) expect(option.tone).toBe("neutral");
    for (const option of OPENERS.problem) expect(option.tone).toBe("empathetic");
    for (const option of OPENERS.confirmation) expect(option.tone).toBe("warm");
  });

  it("uses opener_* block ids with non-empty templates", () => {
    const ids = new Set<string>();
    for (const options of Object.values(OPENERS)) {
      for (const option of options) {
        expect(option.block.id.startsWith("opener_")).toBe(true);
        expect(option.block.template.trim()).not.toBe("");
        ids.add(option.block.id);
      }
    }
    expect(ids.size).toBe(6);
  });
});

describe("OpenerSelector", () => {
  it("returns null for greeting and other", () => {
    const selector = new OpenerSelector();
    expect(selector.choose("greeting")).toBeNull();
    expect(selector.choose("other")).toBeNull();
  });

  it("rotates within a category and never repeats the last one", () => {
    const selector = new OpenerSelector();
    const picks: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const option = selector.choose("question");
      expect(option).not.toBeNull();
      picks.push(option?.block.id ?? "");
    }
    expect(picks).toEqual([
      "opener_question_1",
      "opener_question_2",
      "opener_question_1",
      "opener_question_2",
      "opener_question_1",
      "opener_question_2",
    ]);
    for (let i = 1; i < picks.length; i += 1) expect(picks[i]).not.toBe(picks[i - 1]);
  });

  it("keeps an independent cursor per category", () => {
    const selector = new OpenerSelector();
    expect(selector.choose("question")?.block.id).toBe("opener_question_1");
    expect(selector.choose("problem")?.block.id).toBe("opener_problem_1");
    expect(selector.choose("question")?.block.id).toBe("opener_question_2");
    expect(selector.choose("problem")?.block.id).toBe("opener_problem_2");
  });
});

describe("openerMessages", () => {
  it("quotes the opener and tells the LLM to continue without re-acknowledging", () => {
    const messages = openerMessages("Let me check.");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "assistant", content: "Let me check." });
    expect(messages[1]?.role).toBe("system");
    const note = messages[1]?.content ?? "";
    expect(note).toContain("Let me check.");
    expect(note).toContain("Continue naturally");
    expect(note).toMatch(/do not open with another acknowledgement/i);
  });
});
