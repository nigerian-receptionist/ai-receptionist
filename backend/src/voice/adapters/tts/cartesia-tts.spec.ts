import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";
import WebSocket from "ws";

import { CartesiaTtsSession } from "./cartesia-tts";

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
}

function makeSession(ws: FakeTtsWs): CartesiaTtsSession {
  return new CartesiaTtsSession(ws as unknown as WebSocket, {
    model: "sonic-test",
    modelId: "tts_cartesia@test",
    sampleRate: 24000,
    firstAudioTimeoutMs: 5000,
  });
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("CartesiaTtsSession", () => {
  it("drops queued audio when the context is aborted (no stale leak)", async () => {
    const ws = new FakeTtsWs();
    const session = makeSession(ws);
    const controller = new AbortController();
    const gen = session
      .speak("hello", {
        voiceId: "v",
        language: "en",
        contextId: "c1",
        signal: controller.signal,
      })[Symbol.asyncIterator]();
    const first = gen.next();
    ws.serverMessage({ type: "chunk", context_id: "c1", data: Buffer.alloc(100).toString("base64") });
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await session.close();
  });

  it("streams audio then done on the normal path", async () => {
    const ws = new FakeTtsWs();
    const session = makeSession(ws);
    const gen = session.speak("hi", { voiceId: "v", language: "en", contextId: "c2" })[Symbol.asyncIterator]();
    const first = gen.next();
    ws.serverMessage({ type: "chunk", context_id: "c1-wrong", data: "AA==" });
    ws.serverMessage({ type: "chunk", context_id: "c2", data: Buffer.alloc(48).toString("base64") });
    const audio = await first;
    expect(audio.done).toBe(false);
    if (!audio.done) expect(audio.value.kind).toBe("audio");
    const second = gen.next();
    ws.serverMessage({ type: "done", context_id: "c2" });
    const done = await second;
    expect(done.done).toBe(false);
    if (!done.done) expect(done.value.kind).toBe("done");
    await expect(gen.next()).resolves.toMatchObject({ done: true });
    await session.close();
  });

  it("rejects a duplicate context id", async () => {
    const ws = new FakeTtsWs();
    const session = makeSession(ws);
    const controller = new AbortController();
    const first = session
      .speak("a", {
        voiceId: "v",
        language: "en",
        contextId: "dup",
        signal: controller.signal,
      })[Symbol.asyncIterator]();
    const parked = first.next();
    await tick();
    const second = session.speak("b", { voiceId: "v", language: "en", contextId: "dup" })[Symbol.asyncIterator]();
    await expect(second.next()).rejects.toThrow("duplicate tts context id");
    controller.abort();
    await expect(parked).rejects.toMatchObject({ name: "AbortError" });
    await session.close();
  });
});
