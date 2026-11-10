import { describe, expect, it } from "vitest";

import { decodePcmBase64 } from "./audio-player";

function toBase64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

describe("decodePcmBase64", () => {
  it("decodes little-endian s16 pairs including negatives", () => {
    // 0x0001, 0x00ff, 0xffff (-1), 0x8000 (-32768)
    const decoded = decodePcmBase64(toBase64([0x01, 0x00, 0xff, 0x00, 0xff, 0xff, 0x00, 0x80]));
    expect(Array.from(decoded)).toEqual([1, 255, -1, -32768]);
  });

  it("decodes an empty payload to an empty array", () => {
    expect(decodePcmBase64("").length).toBe(0);
  });

  it("rejects odd-length payloads instead of truncating", () => {
    expect(() => decodePcmBase64(toBase64([0x01, 0x02, 0x03]))).toThrow(/odd-length PCM/);
  });
});
