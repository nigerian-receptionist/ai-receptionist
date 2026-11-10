/**
 * Tests for the shipped mic-capture worklet (`public/worklets/pcm-capture.js`).
 *
 * The worklet source is loaded as text and instantiated with stubbed
 * AudioWorklet globals, so these tests exercise the exact code the browser
 * runs: 20 ms / 320-sample framing, unity response in the voice band, and
 * stopband attenuation of high-frequency noise (M9 / AGENTS.md 5.5).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const WORKLET_SOURCE = readFileSync(
  join(process.cwd(), "public", "worklets", "pcm-capture.js"),
  "utf8",
);

interface StubPort {
  posted: Int16Array[];
  postMessage(buffer: ArrayBuffer): void;
}

interface WorkletInstance {
  process(inputs: Float32Array[][]): boolean;
  port: StubPort;
}

function loadWorklet(inputSampleRate: number): WorkletInstance {
  let registered: (new () => { port: StubPort; process(i: Float32Array[][]): boolean }) | null = null;
  class StubProcessor {
    port: StubPort = {
      posted: [],
      postMessage(buffer: ArrayBuffer): void {
        // Copy immediately: the worklet transfers the buffer.
        this.posted.push(new Int16Array(buffer.slice(0)));
      },
    };
  }
  const factory = new Function(
    "sampleRate",
    "AudioWorkletProcessor",
    "registerProcessor",
    `${WORKLET_SOURCE}\nreturn PcmCapture;`,
  ) as (
    sampleRate: number,
    base: typeof StubProcessor,
    register: (name: string, ctor: typeof StubProcessor) => void,
  ) => new () => WorkletInstance;
  const PcmCapture = factory(inputSampleRate, StubProcessor, (_name, ctor) => {
    registered = ctor as unknown as typeof registered;
  });
  if (!registered) throw new Error("worklet did not call registerProcessor");
  const Ctor = registered as unknown as new () => WorkletInstance;
  void PcmCapture;
  return new Ctor();
}

function tone(sampleRate: number, freqHz: number, seconds: number, amplitude: number): Float32Array {
  const count = Math.floor(sampleRate * seconds);
  const out = new Float32Array(count);
  for (let n = 0; n < count; n += 1) {
    out[n] = amplitude * Math.sin((2 * Math.PI * freqHz * n) / sampleRate);
  }
  return out;
}

/** Feed `input` through the worklet in 128-sample quanta; return all output. */
function runThrough(inputSampleRate: number, input: Float32Array): Int16Array[] {
  const worklet = loadWorklet(inputSampleRate);
  for (let offset = 0; offset < input.length; offset += 128) {
    worklet.process([[input.subarray(offset, offset + 128)]]);
  }
  return worklet.port.posted;
}

function rms(frames: Int16Array[], skipFrames: number): number {
  let sum = 0;
  let count = 0;
  for (const frame of frames.slice(skipFrames)) {
    for (const sample of frame) {
      sum += (sample / 32767) ** 2;
      count += 1;
    }
  }
  return Math.sqrt(sum / count);
}

describe("pcm-capture worklet", () => {
  it("emits 320-sample frames at 16 kHz", () => {
    const frames = runThrough(48000, tone(48000, 440, 0.5, 0.3));
    expect(frames.length).toBeGreaterThan(10);
    for (const frame of frames) expect(frame.length).toBe(320);
  });

  it("passes a 1 kHz tone with unity gain", () => {
    const frames = runThrough(48000, tone(48000, 1000, 1, 0.5));
    // Skip filter warmup, then compare against the ideal RMS (A/sqrt(2)).
    const measured = rms(frames, 3);
    const ideal = 0.5 / Math.SQRT2;
    expect(measured / ideal).toBeGreaterThan(0.93);
    expect(measured / ideal).toBeLessThan(1.07);
  });

  it("M9: strongly attenuates a 10 kHz tone (anti-alias filter)", () => {
    const passFrames = runThrough(48000, tone(48000, 1000, 1, 0.5));
    const stopFrames = runThrough(48000, tone(48000, 10000, 1, 0.5));
    const ratio = rms(stopFrames, 3) / rms(passFrames, 3);
    expect(ratio).toBeLessThan(0.02);
  });

  it("maps silence to zeros", () => {
    const frames = runThrough(48000, new Float32Array(48000));
    for (const frame of frames) {
      for (const sample of frame) expect(sample).toBe(0);
    }
  });

  it("designs the filter for the actual device rate (44.1 kHz)", () => {
    const frames = runThrough(44100, tone(44100, 1000, 1, 0.5));
    const measured = rms(frames, 3);
    const ideal = 0.5 / Math.SQRT2;
    expect(measured / ideal).toBeGreaterThan(0.9);
    expect(measured / ideal).toBeLessThan(1.1);
    const stopFrames = runThrough(44100, tone(44100, 10000, 1, 0.5));
    // At 44.1 kHz the 10 kHz tone still sits in the filter stopband.
    expect(rms(stopFrames, 3) / rms(frames, 3)).toBeLessThan(0.02);
  });
});
