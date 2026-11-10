import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("voice protocol copy", () => {
  it("matches docs/contracts/voice-protocol.ts (ignoring line endings)", () => {
    // Vitest runs with cwd set to frontend/.
    const copy = readFileSync(join(process.cwd(), "src", "features", "talk", "protocol.ts"), "utf8");
    const source = readFileSync(
      join(process.cwd(), "..", "docs", "contracts", "voice-protocol.ts"),
      "utf8",
    );
    expect(copy.replace(/\r\n/g, "\n")).toBe(source.replace(/\r\n/g, "\n"));
  });
});
