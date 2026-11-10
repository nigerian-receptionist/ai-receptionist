import { describe, expect, it } from "vitest";

import { CARTESIA_EMOTIONS, TONE_TO_EMOTION, ToneTagStripper, type ToneName } from "./tone";

function stripAll(chunks: string[]): { text: string; stripper: ToneTagStripper } {
  const stripper = new ToneTagStripper();
  let text = "";
  for (const chunk of chunks) text += stripper.push(chunk);
  text += stripper.flush();
  return { text, stripper };
}

describe("TONE_TO_EMOTION allow-list", () => {
  it("maps the seven tones to Cartesia emotions (neutral omits)", () => {
    expect(TONE_TO_EMOTION).toEqual({
      neutral: null,
      warm: "content",
      empathetic: "sympathetic",
      upbeat: "happy",
      "calm-firm": "calm",
      apologetic: "apologetic",
      reverent: "peaceful",
    });
  });

  it("every mapped emotion is in the documented Cartesia emotion list", () => {
    for (const emotion of Object.values(TONE_TO_EMOTION)) {
      if (emotion !== null) expect(CARTESIA_EMOTIONS.has(emotion)).toBe(true);
    }
  });

  it("rejects disallowed emotions (angry, sarcastic, threatening, ...)", () => {
    const names = Object.keys(TONE_TO_EMOTION);
    for (const banned of ["angry", "sarcastic", "threatening", "sad", "furious", "flirtatious"]) {
      expect(names).not.toContain(banned);
    }
  });
});

describe("ToneTagStripper", () => {
  it("parses a head tag and strips it from the text", () => {
    const { text, stripper } = stripAll(["[tone: empathetic] I understand."]);
    expect(text).toBe("I understand.");
    expect(stripper.tone).toBe("empathetic");
    expect(stripper.tagInvalid).toBeNull();
  });

  it("handles a tag split across deltas", () => {
    const { text, stripper } = stripAll(["[tone", ": sympa", "thetic] Hello there."]);
    expect(text).toBe("Hello there.");
    expect(stripper.tone).toBe("empathetic");
  });

  it("handles a tag split delta-by-delta (single chars)", () => {
    const { text, stripper } = stripAll("[tone: warm] Hi.".split(""));
    expect(text).toBe("Hi.");
    expect(stripper.tone).toBe("warm");
  });

  it("defaults to neutral when the tag is missing", () => {
    const { text, stripper } = stripAll(["Hello there, ", "how can I help?"]);
    expect(text).toBe("Hello there, how can I help?");
    expect(stripper.tone).toBe("neutral");
    expect(stripper.tagInvalid).toBeNull();
  });

  it("streams non-tag text without waiting for the whole reply", () => {
    const stripper = new ToneTagStripper();
    // "Hello" cannot be a tag head, so it is emitted immediately.
    expect(stripper.push("Hello ")).toBe("Hello ");
    expect(stripper.push("there.")).toBe("there.");
    expect(stripper.flush()).toBe("");
    expect(stripper.tone).toBe("neutral");
  });

  it("maps a disallowed tone to neutral and flags it invalid", () => {
    const { text, stripper } = stripAll(["[tone: sarcastic] Oh really?"]);
    expect(text).toBe("Oh really?");
    expect(stripper.tone).toBe("neutral");
    expect(stripper.tagInvalid).toBe("unknown");
  });

  it("maps malformed head tags to neutral and flags them invalid", () => {
    for (const bad of ["[tone]", "[tone:]", "[tone sympathetic]", "[tone:]", "[tone:  ]"]) {
      const { text, stripper } = stripAll([`${bad} Hello.`]);
      expect(text).toBe("Hello.");
      expect(stripper.tone).toBe("neutral");
      expect(stripper.tagInvalid).toBe("malformed");
    }
  });

  it("strips a later tag mid-text and ignores it", () => {
    const { text, stripper } = stripAll(["[tone: warm] Hello. [tone: happy] How are you?"]);
    expect(text).toBe("Hello.  How are you?");
    expect(stripper.tone).toBe("warm");
  });

  it("strips a later tag split across deltas", () => {
    const { text, stripper } = stripAll(["Hello [tone", ": happy] there."]);
    expect(text).toBe("Hello  there.");
    expect(stripper.tone).toBe("neutral");
  });

  it("never emits bracket text that only looks like a tag at first", () => {
    const { text, stripper } = stripAll(["[Hello] is this thing on?"]);
    expect(text).toBe("[Hello] is this thing on?");
    expect(stripper.tone).toBe("neutral");
  });

  it("normalises case and spacing in the tag value", () => {
    const { stripper } = stripAll(["[tone: Calm Firm] Please listen."]);
    expect(stripper.tone).toBe("calm-firm");
    const upper = stripAll(["[TONE: UPBEAT] Great news!"]);
    expect(upper.stripper.tone).toBe("upbeat");
    expect(upper.text).toBe("Great news!");
  });

  it("an empty reply resolves to neutral", () => {
    const stripper = new ToneTagStripper();
    expect(stripper.flush()).toBe("");
    expect(stripper.tone).toBe("neutral");
  });

  it("a tag with nothing after it yields empty text", () => {
    const { text, stripper } = stripAll(["[tone: apologetic]"]);
    expect(text).toBe("");
    expect(stripper.tone).toBe("apologetic");
  });

  it("resolves the tone as soon as the head tag closes", () => {
    const stripper = new ToneTagStripper();
    expect(stripper.push("[tone: reverent] ")).toBe("");
    expect(stripper.tone).toBe("reverent");
    expect(stripper.push("Bless you.")).toBe("Bless you.");
    expect(stripper.flush()).toBe("");
  });

  it("tolerates the Cartesia value in the tag", () => {
    const pairs: Array<[string, ToneName]> = [
      ["content", "warm"],
      ["sympathetic", "empathetic"],
      ["happy", "upbeat"],
      ["calm", "calm-firm"],
      ["apologetic", "apologetic"],
      ["peaceful", "reverent"],
    ];
    for (const [emotion, tone] of pairs) {
      const { text, stripper } = stripAll([`[tone: ${emotion}] x.`]);
      expect(stripper.tone).toBe(tone);
      expect(stripper.tagInvalid).toBeNull();
      expect(text).toBe("x.");
    }
  });

  it("every allow-listed tone parses", () => {
    const tones: ToneName[] = ["neutral", "warm", "empathetic", "upbeat", "calm-firm", "apologetic", "reverent"];
    for (const tone of tones) {
      const { text, stripper } = stripAll([`[tone: ${tone}] x.`]);
      expect(stripper.tone).toBe(tone);
      expect(text).toBe("x.");
    }
  });
});
