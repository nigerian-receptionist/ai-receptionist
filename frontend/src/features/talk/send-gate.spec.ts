import { describe, expect, it } from "vitest";

import { MIC_BUFFERED_AMOUNT_LIMIT, shouldSendMicFrame } from "./send-gate";

describe("shouldSendMicFrame", () => {
  it("sends while the socket buffer is within the limit", () => {
    expect(shouldSendMicFrame(0)).toBe(true);
    expect(shouldSendMicFrame(MIC_BUFFERED_AMOUNT_LIMIT)).toBe(true);
  });

  it("drops frames once the buffer exceeds the limit", () => {
    expect(shouldSendMicFrame(MIC_BUFFERED_AMOUNT_LIMIT + 1)).toBe(false);
    expect(shouldSendMicFrame(10 * 1024 * 1024)).toBe(false);
  });

  it("honours a custom limit", () => {
    expect(shouldSendMicFrame(100, 64)).toBe(false);
    expect(shouldSendMicFrame(64, 64)).toBe(true);
  });
});
