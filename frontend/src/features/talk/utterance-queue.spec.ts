import { describe, expect, it } from "vitest";

import { MAX_QUEUED_UTTERANCES, UtteranceQueue } from "./utterance-queue";

describe("UtteranceQueue", () => {
  it("groups chunks per utterance in arrival order", () => {
    const queue = new UtteranceQueue<number>();
    queue.push("a", 1);
    queue.push("a", 2);
    queue.push("b", 3);
    expect(queue.size).toBe(2);
    expect(queue.shiftNext()).toEqual({ utteranceId: "a", chunks: [1, 2], ended: false });
    expect(queue.shiftNext()).toEqual({ utteranceId: "b", chunks: [3], ended: false });
    expect(queue.shiftNext()).toBeNull();
    expect(queue.isEmpty).toBe(true);
  });

  it("marks a waiting utterance ended", () => {
    const queue = new UtteranceQueue<number>();
    queue.push("a", 1);
    queue.markEnded("a");
    expect(queue.shiftNext()?.ended).toBe(true);
  });

  it("ignores markEnded for unknown ids", () => {
    const queue = new UtteranceQueue<number>();
    expect(() => queue.markEnded("ghost")).not.toThrow();
  });

  it("removes a cancelled utterance and keeps the rest", () => {
    const queue = new UtteranceQueue<number>();
    queue.push("a", 1);
    queue.push("b", 2);
    expect(queue.remove("a")).toEqual({ utteranceId: "a", chunks: [1], ended: false });
    expect(queue.remove("ghost")).toBeNull();
    expect(queue.shiftNext()?.utteranceId).toBe("b");
  });

  it("clear drops everything and returns the ids in order", () => {
    const queue = new UtteranceQueue<number>();
    queue.push("a", 1);
    queue.push("b", 2);
    expect(queue.clear()).toEqual(["a", "b"]);
    expect(queue.isEmpty).toBe(true);
  });

  it("evicts the oldest waiting utterance when full", () => {
    const queue = new UtteranceQueue<number>();
    for (let i = 0; i < MAX_QUEUED_UTTERANCES; i += 1) {
      expect(queue.push(`u-${i}`, i)).toBeNull();
    }
    expect(queue.push("overflow", 99)).toBe("u-0");
    expect(queue.size).toBe(MAX_QUEUED_UTTERANCES);
    expect(queue.shiftNext()?.utteranceId).toBe("u-1");
  });
});
