import { describe, expect, it } from "vitest";

import { SpeechGate, clampEndpointingSilenceMs } from "./speech-gate";

describe("SpeechGate", () => {
  it("opens a turn on confirmed speech and closes it on end", () => {
    const gate = new SpeechGate();
    expect(gate.isSpeaking).toBe(false);
    expect(gate.handle("real-start")).toEqual(["started"]);
    expect(gate.isSpeaking).toBe(true);
    expect(gate.handle("end")).toEqual(["ended"]);
    expect(gate.isSpeaking).toBe(false);
  });

  it("M10: a misfire with no open turn sends nothing", () => {
    const gate = new SpeechGate();
    expect(gate.handle("misfire")).toEqual([]);
    expect(gate.isSpeaking).toBe(false);
  });

  it("ignores a stray end with no open turn", () => {
    const gate = new SpeechGate();
    expect(gate.handle("end")).toEqual([]);
  });

  it("ignores a duplicate real-start while speaking", () => {
    const gate = new SpeechGate();
    expect(gate.handle("real-start")).toEqual(["started"]);
    expect(gate.handle("real-start")).toEqual([]);
    expect(gate.handle("end")).toEqual(["ended"]);
  });

  it("closes an open turn on misfire (unexpected VAD ordering)", () => {
    const gate = new SpeechGate();
    gate.handle("real-start");
    expect(gate.handle("misfire")).toEqual(["ended"]);
    expect(gate.isSpeaking).toBe(false);
  });

  it("supports consecutive turns", () => {
    const gate = new SpeechGate();
    gate.handle("real-start");
    gate.handle("end");
    expect(gate.handle("real-start")).toEqual(["started"]);
    expect(gate.handle("end")).toEqual(["ended"]);
  });
});

describe("clampEndpointingSilenceMs", () => {
  it("passes sane values through", () => {
    expect(clampEndpointingSilenceMs(600)).toBe(600);
    expect(clampEndpointingSilenceMs("600")).toBe(600);
  });

  it("falls back on NaN and non-numbers", () => {
    expect(clampEndpointingSilenceMs("abc")).toBe(600);
    expect(clampEndpointingSilenceMs(Number.NaN)).toBe(600);
    expect(clampEndpointingSilenceMs(undefined)).toBe(600);
    expect(clampEndpointingSilenceMs(Number.POSITIVE_INFINITY)).toBe(600);
  });

  it("clamps to 200..2000 ms", () => {
    expect(clampEndpointingSilenceMs(0)).toBe(200);
    expect(clampEndpointingSilenceMs(-50)).toBe(200);
    expect(clampEndpointingSilenceMs(10_000)).toBe(2000);
  });
});
