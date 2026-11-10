import { describe, expect, it } from "vitest";

import { uuidv7 } from "../../src/common/uuidv7";

describe("uuidv7", () => {
  it("matches the v7 shape with version and variant bits", () => {
    const id = uuidv7();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("embeds the given timestamp", () => {
    const when = 1762732800000;
    const hex = uuidv7(when).replace(/-/g, "");
    expect(parseInt(hex.slice(0, 12), 16)).toBe(when);
  });

  it("generates unique ids", () => {
    expect(new Set([uuidv7(), uuidv7(), uuidv7()]).size).toBe(3);
  });
});
