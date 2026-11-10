import { describe, expect, it } from "vitest";

import { MAX_TRACKED_UTTERANCES, UtteranceTracker } from "./utterance-tracker";

describe("UtteranceTracker", () => {
  it("plays an in-order utterance with no gaps", () => {
    const tracker = new UtteranceTracker();
    expect(tracker.check("a", 0)).toEqual({ verdict: "play", gap: null });
    expect(tracker.check("a", 1)).toEqual({ verdict: "play", gap: null });
    expect(tracker.check("a", 2)).toEqual({ verdict: "play", gap: null });
  });

  it("drops stale and duplicate seqs", () => {
    const tracker = new UtteranceTracker();
    tracker.check("a", 0);
    tracker.check("a", 1);
    expect(tracker.check("a", 1)).toEqual({ verdict: "drop-stale" });
    expect(tracker.check("a", 0)).toEqual({ verdict: "drop-stale" });
  });

  it("reports a forward gap but keeps playing (no re-request exists)", () => {
    const tracker = new UtteranceTracker();
    tracker.check("a", 0);
    expect(tracker.check("a", 3)).toEqual({
      verdict: "play",
      gap: { missingFrom: 1, missingTo: 2 },
    });
    // Resyncs: the next chunk continues from the accepted seq.
    expect(tracker.check("a", 4)).toEqual({ verdict: "play", gap: null });
  });

  it("accepts a first seq other than 0 as the baseline", () => {
    const tracker = new UtteranceTracker();
    expect(tracker.check("a", 5)).toEqual({ verdict: "play", gap: null });
    expect(tracker.check("a", 6)).toEqual({ verdict: "play", gap: null });
    expect(tracker.check("a", 5)).toEqual({ verdict: "drop-stale" });
  });

  it("tracks utterances independently", () => {
    const tracker = new UtteranceTracker();
    tracker.check("a", 0);
    tracker.check("a", 1);
    expect(tracker.check("b", 0)).toEqual({ verdict: "play", gap: null });
    expect(tracker.check("a", 2)).toEqual({ verdict: "play", gap: null });
  });

  it("B3: drops every late chunk for an interrupted utterance", () => {
    const tracker = new UtteranceTracker();
    tracker.check("a", 0);
    tracker.check("a", 1);
    tracker.markInterrupted("a");
    // In-flight stale chunks keep arriving; none may restart playback.
    expect(tracker.check("a", 2)).toEqual({ verdict: "drop-interrupted" });
    expect(tracker.check("a", 3)).toEqual({ verdict: "drop-interrupted" });
    expect(tracker.check("a", 1)).toEqual({ verdict: "drop-interrupted" });
    // A new utterance is unaffected.
    expect(tracker.check("b", 0)).toEqual({ verdict: "play", gap: null });
    expect(tracker.check("a", 4)).toEqual({ verdict: "drop-interrupted" });
  });

  it("drops late chunks after server cancel", () => {
    const tracker = new UtteranceTracker();
    tracker.check("a", 0);
    tracker.markCancelled("a");
    expect(tracker.check("a", 1)).toEqual({ verdict: "drop-closed" });
  });

  it("drops late duplicates after audio.end", () => {
    const tracker = new UtteranceTracker();
    tracker.check("a", 0);
    tracker.check("a", 1);
    tracker.markEnded("a");
    expect(tracker.check("a", 1)).toEqual({ verdict: "drop-closed" });
    expect(tracker.check("a", 2)).toEqual({ verdict: "drop-closed" });
  });

  it("reopens a closed block id when its seq restarts (hold replay)", () => {
    const tracker = new UtteranceTracker();
    tracker.check("hold", 0);
    tracker.check("hold", 1);
    tracker.markEnded("hold");
    expect(tracker.check("hold", 0)).toEqual({ verdict: "play", gap: null });
    expect(tracker.check("hold", 1)).toEqual({ verdict: "play", gap: null });
  });

  it("reopens an interrupted id only on a seq restart", () => {
    const tracker = new UtteranceTracker();
    tracker.check("hold", 0);
    tracker.check("hold", 1);
    tracker.markInterrupted("hold");
    tracker.markCancelled("hold");
    expect(tracker.check("hold", 2)).toEqual({ verdict: "drop-closed" });
    expect(tracker.check("hold", 0)).toEqual({ verdict: "play", gap: null });
  });

  it("tolerates end/cancel/interrupt for unknown ids", () => {
    const tracker = new UtteranceTracker();
    tracker.markEnded("ghost");
    tracker.markCancelled("ghost2");
    tracker.markInterrupted("ghost3");
    expect(tracker.check("ghost", 1)).toEqual({ verdict: "drop-closed" });
    expect(tracker.check("ghost", 0)).toEqual({ verdict: "play", gap: null });
    expect(tracker.check("ghost3", 0)).toEqual({ verdict: "drop-interrupted" });
  });

  it("bounds memory by evicting the stalest utterance", () => {
    const tracker = new UtteranceTracker();
    for (let i = 0; i < MAX_TRACKED_UTTERANCES + 10; i += 1) {
      tracker.check(`u-${i}`, 0);
    }
    expect(tracker.size).toBe(MAX_TRACKED_UTTERANCES);
  });
});
