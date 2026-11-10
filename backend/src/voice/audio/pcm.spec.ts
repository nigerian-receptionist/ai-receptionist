import { describe, expect, it } from "vitest";

import { pcmDurationS, resamplePcmS16le } from "./pcm";

function samples(values: number[]): Buffer {
  const pcm = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => pcm.writeInt16LE(v, i * 2));
  return pcm;
}

function toSamples(pcm: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i < pcm.length; i += 2) out.push(pcm.readInt16LE(i));
  return out;
}

describe("resamplePcmS16le", () => {
  it("returns a copy at identical rates", () => {
    const input = samples([0, 1000, -1000]);
    const output = resamplePcmS16le(input, 16000, 16000);
    expect(output).not.toBe(input);
    expect(toSamples(output)).toEqual([0, 1000, -1000]);
  });

  it("returns empty for empty input", () => {
    expect(resamplePcmS16le(Buffer.alloc(0), 24000, 16000)).toHaveLength(0);
  });

  it("rejects odd-length input", () => {
    expect(() => resamplePcmS16le(Buffer.alloc(3), 16000, 16000)).toThrow("even-length");
  });

  it("rejects non-positive sample rates", () => {
    expect(() => resamplePcmS16le(samples([0]), 0, 16000)).toThrow("positive");
    expect(() => resamplePcmS16le(samples([0]), 16000, -1)).toThrow("positive");
  });

  it("downsamples 24 kHz to 16 kHz with endpoint values intact", () => {
    const output = resamplePcmS16le(samples([0, 3000, 6000]), 24000, 16000);
    expect(output.length % 2).toBe(0);
    const values = toSamples(output);
    expect(values[0]).toBe(0);
    expect(values[values.length - 1]).toBe(6000);
  });
});

describe("pcmDurationS", () => {
  it("computes seconds from bytes and rate", () => {
    expect(pcmDurationS(3200, 16000)).toBeCloseTo(0.1, 9);
  });
});
