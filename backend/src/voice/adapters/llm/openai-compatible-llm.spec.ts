import { afterEach, describe, expect, it, vi } from "vitest";

import type { LlmEvent } from "../types";
import { OpenAiCompatibleLlm } from "./openai-compatible-llm";

function delta(text: string): string {
  return JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] });
}

function sseResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect(events: AsyncIterable<LlmEvent>): Promise<LlmEvent[]> {
  const out: LlmEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("OpenAiCompatibleLlm", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("streams deltas and usage from SSE", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse(
          `data: ${delta("Hello ")}\n\ndata: ${delta("there")}\n\ndata: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\ndata: [DONE]\n\n`,
        ),
      ),
    );
    const llm = new OpenAiCompatibleLlm({
      baseUrl: "https://llm.test/v1",
      apiKey: "test",
      model: "test-model",
      reasoningEffort: "minimal",
      maxCompletionTokens: 400,
    });
    const events = await collect(llm.streamChat([{ role: "user", content: "hi" }]));
    expect(events).toEqual([
      { kind: "delta", text: "Hello " },
      { kind: "delta", text: "there" },
      { kind: "usage", usage: { in: 10, out: 5, reasoning: null } },
    ]);
  });

  it("emits the tail payload without a trailing newline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse(`data: ${delta("tail")}`)),
    );
    const llm = new OpenAiCompatibleLlm({
      baseUrl: "https://llm.test/v1",
      apiKey: "test",
      model: "test-model",
      reasoningEffort: "minimal",
      maxCompletionTokens: 400,
    });
    const events = await collect(llm.streamChat([{ role: "user", content: "hi" }]));
    expect(events).toEqual([{ kind: "delta", text: "tail" }]);
  });

  it("counts malformed payloads via onSkippedPayload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse(`data: {"broken": tru\n\ndata: ${delta("ok")}\n\n`)),
    );
    const skipped: number[] = [];
    const llm = new OpenAiCompatibleLlm({
      baseUrl: "https://llm.test/v1",
      apiKey: "test",
      model: "test-model",
      reasoningEffort: "minimal",
      maxCompletionTokens: 400,
      onSkippedPayload: (count) => skipped.push(count),
    });
    const events = await collect(llm.streamChat([{ role: "user", content: "hi" }]));
    expect(events).toEqual([{ kind: "delta", text: "ok" }]);
    expect(skipped).toEqual([1]);
  });

  it("throws a terse error on HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 429 })));
    const llm = new OpenAiCompatibleLlm({
      baseUrl: "https://llm.test/v1",
      apiKey: "test",
      model: "test-model",
      reasoningEffort: "minimal",
      maxCompletionTokens: 400,
    });
    await expect(collect(llm.streamChat([{ role: "user", content: "hi" }]))).rejects.toThrow("llm http 429");
  });
});
