import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";
import WebSocket from "ws";

import { CartesiaTtsSession, toCartesiaEmotion } from "./cartesia-tts";

class FakeTtsWs extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
  }

  serverMessage(payload: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(payload)));
  }

  sentJson(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

function makeSession(ws: FakeTtsWs, firstAudioTimeoutMs = 5000): CartesiaTtsSession {
  return new CartesiaTtsSession(ws as unknown as WebSocket, {
    model: "sonic-test",
    modelId: "tts_cartesia@test",
    sampleRate: 24000,
    firstAudioTimeoutMs,
  });
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("CartesiaTtsSession continuations", () => {
  it("pushes sentences with continue:true and ends with empty continue:false", async () => {
    const ws = new FakeTtsWs();
    const session = makeSession(ws);
    const reply = session.speakReply({ voiceId: "v", language: "en", contextId: "c1" });
    reply.push("Hello there.");
    reply.push(" How are you?");
    reply.finish();
    // Drain so the context cleans up.
    const gen = reply.events()[Symbol.asyncIterator]();
    const pending = gen.next();
    ws.serverMessage({ type: "done", context_id: "c1" });
    await pending;

    const sent = ws.sentJson();
    expect(sent).toHaveLength(3);
    expect(sent[0]).toMatchObject({ transcript: "Hello there.", continue: true, context_id: "c1" });
    expect(sent[1]).toMatchObject({ transcript: " How are you?", continue: true, context_id: "c1" });
    expect(sent[2]).toMatchObject({ transcript: "", continue: false, context_id: "c1" });
    // The concatenated transcript is valid (joining space preserved verbatim).
    expect((sent[0]?.["transcript"] as string) + (sent[1]?.["transcript"] as string)).toBe(
      "Hello there. How are you?",
    );
    await session.close();
  });

  it("keeps every field except transcript/continue identical within a context", async () => {
    const ws = new FakeTtsWs();
    const session = makeSession(ws);
    const reply = session.speakReply({
      voiceId: "v",
      language: "en",
      tone: "empathetic",
      speed: 1.1,
      contextId: "c2",
    });
    reply.push("One.");
    reply.push(" Two.");
    reply.finish();
    const gen = reply.events()[Symbol.asyncIterator]();
    const pending = gen.next();
    ws.serverMessage({ type: "done", context_id: "c2" });
    await pending;

    const sent = ws.sentJson();
    expect(sent).toHaveLength(3);
    const varying = new Set(["transcript", "continue"]);
    const keys = Object.keys(sent[0] ?? {}).filter((key) => !varying.has(key));
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(sent[1]?.[key]).toEqual(sent[0]?.[key]);
      expect(sent[2]?.[key]).toEqual(sent[0]?.[key]);
    }
    // Emotion for the whole reply context, and deliberate zero input buffer
    // (we already buffer client-side per sentence).
    expect(sent[0]?.["generation_config"]).toEqual({ emotion: "sympathetic", speed: 1.1 });
    for (const message of sent) expect(message["max_buffer_delay_ms"]).toBe(0);
    await session.close();
  });

  it("streams audio and timestamps in push order, then a single done", async () => {
    const ws = new FakeTtsWs();
    const session = makeSession(ws);
    const reply = session.speakReply({ voiceId: "v", language: "en", contextId: "c3" });
    reply.push("Hi there.");
    const gen = reply.events()[Symbol.asyncIterator]();
    const first = gen.next();
    ws.serverMessage({ type: "chunk", context_id: "wrong", data: "AA==" });
    ws.serverMessage({ type: "chunk", context_id: "c3", data: Buffer.alloc(48).toString("base64") });
    const audio = await first;
    expect(audio.done).toBe(false);
    if (!audio.done) {
      expect(audio.value.kind).toBe("audio");
      if (audio.value.kind === "audio") expect(audio.value.chunk.isFirst).toBe(true);
    }
    const second = gen.next();
    ws.serverMessage({
      type: "timestamps",
      context_id: "c3",
      word_timestamps: { words: ["Hi"], start: [0], end: [0.4] },
    });
    const stamped = await second;
    expect(stamped.done).toBe(false);
    if (!stamped.done) expect(stamped.value.kind).toBe("timestamps");
    reply.finish();
    const third = gen.next();
    ws.serverMessage({ type: "done", context_id: "c3" });
    const done = await third;
    expect(done.done).toBe(false);
    if (!done.done) expect(done.value.kind).toBe("done");
    await expect(gen.next()).resolves.toMatchObject({ done: true });
    await session.close();
  });

  it("drops queued audio when the reply is aborted (no stale leak)", async () => {
    const ws = new FakeTtsWs();
    const session = makeSession(ws);
    const controller = new AbortController();
    const reply = session.speakReply({
      voiceId: "v",
      language: "en",
      contextId: "c4",
      signal: controller.signal,
    });
    reply.push("hello");
    const gen = reply.events()[Symbol.asyncIterator]();
    const first = gen.next();
    ws.serverMessage({ type: "chunk", context_id: "c4", data: Buffer.alloc(100).toString("base64") });
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    // Vendor cancel went out; pushes after the abort are dropped locally.
    expect(ws.sentJson().at(-1)).toMatchObject({ context_id: "c4", cancel: true });
    reply.push("late sentence");
    reply.finish();
    expect(ws.sentJson().filter((m) => m["transcript"] === "late sentence")).toHaveLength(0);
    await session.close();
  });

  it("push after finish throws; finish is idempotent; empty finish throws", async () => {
    const ws = new FakeTtsWs();
    const session = makeSession(ws);
    const reply = session.speakReply({ voiceId: "v", language: "en", contextId: "c5" });
    reply.push("Hi.");
    reply.finish();
    reply.finish();
    expect(() => reply.push("Too late.")).toThrow("push after finish");
    expect(ws.sentJson().filter((m) => m["continue"] === false)).toHaveLength(1);
    const gen = reply.events()[Symbol.asyncIterator]();
    const pending = gen.next();
    ws.serverMessage({ type: "done", context_id: "c5" });
    await pending;

    const empty = session.speakReply({ voiceId: "v", language: "en", contextId: "c6" });
    expect(() => empty.finish()).toThrow("without input");
    // Abandoned without events(): close() must still settle cleanly.
    await session.close();
  });

  it("rejects a duplicate context id", async () => {
    const ws = new FakeTtsWs();
    const session = makeSession(ws);
    const controller = new AbortController();
    const first = session.speakReply({
      voiceId: "v",
      language: "en",
      contextId: "dup",
      signal: controller.signal,
    });
    first.push("a");
    const parked = first.events()[Symbol.asyncIterator]().next();
    await tick();
    expect(() => session.speakReply({ voiceId: "v", language: "en", contextId: "dup" })).toThrow(
      "duplicate tts context id",
    );
    controller.abort();
    await expect(parked).rejects.toMatchObject({ name: "AbortError" });
    await session.close();
  });

  it("times out when first audio never arrives", async () => {
    const ws = new FakeTtsWs();
    const session = makeSession(ws, 20);
    const reply = session.speakReply({ voiceId: "v", language: "en", contextId: "c7" });
    reply.push("Hello.");
    await expect(reply.events()[Symbol.asyncIterator]().next()).rejects.toThrow("first audio timed out");
    await session.close();
  });

  it("tolerates flush_done without a flush ever sent", async () => {
    const ws = new FakeTtsWs();
    const session = makeSession(ws);
    const reply = session.speakReply({ voiceId: "v", language: "en", contextId: "c8" });
    reply.push("Hi.");
    reply.finish();
    const gen = reply.events()[Symbol.asyncIterator]();
    const pending = gen.next();
    ws.serverMessage({ type: "flush_done", context_id: "c8", flush_done: true, flush_id: 1 });
    ws.serverMessage({ type: "chunk", context_id: "c8", data: Buffer.alloc(48).toString("base64") });
    const event = await pending;
    expect(event.done).toBe(false);
    if (!event.done) expect(event.value.kind).toBe("audio");
    await session.close();
  });
});

describe("toCartesiaEmotion", () => {
  it("maps session tones to Cartesia emotions, neutral omitted", () => {
    expect(toCartesiaEmotion("neutral")).toBeUndefined();
    expect(toCartesiaEmotion(undefined)).toBeUndefined();
    expect(toCartesiaEmotion("warm")).toBe("content");
    expect(toCartesiaEmotion("empathetic")).toBe("sympathetic");
    expect(toCartesiaEmotion("upbeat")).toBe("happy");
    expect(toCartesiaEmotion("calm-firm")).toBe("calm");
    expect(toCartesiaEmotion("apologetic")).toBe("apologetic");
    expect(toCartesiaEmotion("reverent")).toBe("peaceful");
  });

  it("never passes disallowed or unknown values to the vendor", () => {
    for (const banned of ["angry", "sarcastic", "threatening", "furious", "whatever"]) {
      expect(toCartesiaEmotion(banned)).toBeUndefined();
    }
  });
});
