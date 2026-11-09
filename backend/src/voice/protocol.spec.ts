import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("voice protocol copy", () => {
  it("is byte-identical to docs/contracts/voice-protocol.ts", () => {
    // Vitest runs with cwd set to backend/.
    const copy = readFileSync(join(process.cwd(), "src", "voice", "protocol.ts"));
    const source = readFileSync(join(process.cwd(), "..", "docs", "contracts", "voice-protocol.ts"));
    expect(copy.equals(source)).toBe(true);
  });
});
