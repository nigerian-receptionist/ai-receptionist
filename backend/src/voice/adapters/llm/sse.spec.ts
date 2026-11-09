import { describe, expect, it } from "vitest";

import { SseParser } from "./sse";

describe("SseParser", () => {
  it("extracts data payloads and stops at [DONE]", () => {
    const parser = new SseParser();
    expect(parser.push('data: {"a":1}\n\ndata: {"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
    expect(parser.isDone).toBe(false);
    expect(parser.push("data: [DONE]\n")).toEqual([]);
    expect(parser.isDone).toBe(true);
    expect(parser.push('data: {"c":3}\n')).toEqual([]);
  });

  it("handles chunks split mid-line", () => {
    const parser = new SseParser();
    expect(parser.push('data: {"a"')).toEqual([]);
    expect(parser.push(':1}\n')).toEqual(['{"a":1}']);
  });

  it("ignores comments, event/id fields and empty data lines", () => {
    const parser = new SseParser();
    expect(parser.push(": ping\nevent: message\nid: 7\ndata:\n\ndata: {}\n")).toEqual(["{}"]);
  });

  it("handles CRLF line endings", () => {
    const parser = new SseParser();
    expect(parser.push('data: {"a":1}\r\n\r\ndata: [DONE]\r\n')).toEqual(['{"a":1}']);
    expect(parser.isDone).toBe(true);
  });
});
