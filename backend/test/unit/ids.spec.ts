import { describe, expect, it } from "vitest";

import { toPublicId, toRawId } from "../../src/interactions/ids";

const UUID = "0195f3a0-0000-7000-8000-000000000001";

describe("ids", () => {
  it.each([["int"], ["trn"], ["agt"]] as const)("round-trips %s prefix", (prefix) => {
    expect(toRawId(toPublicId(prefix, UUID), prefix)).toBe(UUID);
  });

  it("accepts a raw uuid", () => {
    expect(toRawId(UUID, "int")).toBe(UUID);
  });

  it("rejects unknown prefixes, mismatches and bad uuids", () => {
    expect(() => toRawId("foo_123")).toThrow();
    expect(() => toRawId(`agt_${UUID}`, "int")).toThrow();
    expect(() => toRawId("not-a-uuid")).toThrow();
  });
});
