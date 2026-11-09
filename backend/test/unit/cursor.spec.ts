import { describe, expect, it } from "vitest";

import { decodeCursor, encodeCursor } from "../../src/common/cursor";

const PAYLOAD = { id: "0195f3a0-0000-7000-8000-000000000001" };

describe("cursor", () => {
  it("round-trips", () => {
    expect(decodeCursor(encodeCursor(PAYLOAD))).toEqual(PAYLOAD);
  });

  it("is url-safe base64", () => {
    expect(encodeCursor(PAYLOAD)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each(["!!!", "", "e30=", encodeCursor(PAYLOAD).slice(0, -2) + "xx"])(
    "rejects malformed cursor %s",
    (cursor) => {
      expect(decodeCursor(cursor)).toBeNull();
    },
  );
});
